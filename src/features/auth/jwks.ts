/**
 * Remote JSON Web Key Set, cached in isolate memory.
 *
 * A Worker isolate serves many requests, so the resolver — and the key set it
 * holds — is built once per JWKS URL and reused. Rebuilding it per request
 * would mean an outbound fetch on every connect, which is exactly the cost the
 * edge is supposed to avoid.
 *
 * Internal to the auth slice — other slices import `./index.ts` only.
 */
import { createRemoteJWKSet, errors, type JWTVerifyGetKey, type RemoteJWKSet } from "jose";

const FETCH_TIMEOUT_MS = 5_000;
/** jose refetches on an unknown `kid` at most this often on its own. */
const COOLDOWN_MS = 30_000;
/** Refresh the whole set this often even when every `kid` still resolves. */
const CACHE_MAX_AGE_MS = 10 * 60_000;
/**
 * Our own forced-reload floor. Shorter than `COOLDOWN_MS` so a real key
 * rotation is picked up in seconds rather than in half a minute, but still a
 * hard cap: without it a stream of tokens carrying forged `kid`s would turn
 * every 401 into an outbound JWKS request.
 */
const FORCED_RELOAD_MIN_INTERVAL_MS = 5_000;

interface CachedJwks {
  readonly resolve: RemoteJWKSet;
  forcedReloadAt: number;
}

/** Keyed by URL; the key space is configuration-derived, so it stays tiny. */
const cache = new Map<string, CachedJwks>();

/**
 * The key set could not be fetched or parsed. Distinct from "no key matched"
 * because it says the server cannot authenticate anyone right now, not that
 * this particular token is bad.
 */
export class JwksUnavailableError extends Error {
  constructor(cause: unknown) {
    super("json web key set is unavailable", { cause });
    this.name = "JwksUnavailableError";
  }
}

function cachedJwks(url: URL): CachedJwks {
  const existing = cache.get(url.href);
  if (existing) return existing;
  const entry: CachedJwks = {
    resolve: createRemoteJWKSet(url, {
      timeoutDuration: FETCH_TIMEOUT_MS,
      cooldownDuration: COOLDOWN_MS,
      cacheMaxAge: CACHE_MAX_AGE_MS,
    }),
    forcedReloadAt: 0,
  };
  cache.set(url.href, entry);
  return entry;
}

/**
 * Only key *selection* failures are the token's fault; a timeout, a non-200 or
 * unparseable JSON is our outage and must not be reported as a bad signature.
 */
function asVerifyError(error: unknown): unknown {
  if (error instanceof errors.JWKSNoMatchingKey) return error;
  if (error instanceof errors.JWKSMultipleMatchingKeys) return error;
  return new JwksUnavailableError(error);
}

/** Key resolver for `jwtVerify`, backed by the isolate-cached key set. */
export function remoteJwksResolver(url: URL): JWTVerifyGetKey {
  const entry = cachedJwks(url);
  return async (header, token) => {
    try {
      return await entry.resolve(header, token);
    } catch (error) {
      if (!(error instanceof errors.JWKSNoMatchingKey)) throw asVerifyError(error);

      // Unknown `kid`: either the issuer rotated its keys or the token is
      // forged. jose will not refetch while its own cooldown holds, so force
      // one reload — throttled, so forged `kid`s cannot amplify into traffic.
      const now = Date.now();
      if (now - entry.forcedReloadAt < FORCED_RELOAD_MIN_INTERVAL_MS) throw error;
      entry.forcedReloadAt = now;
      try {
        await entry.resolve.reload();
        return await entry.resolve(header, token);
      } catch (retryError) {
        throw asVerifyError(retryError);
      }
    }
  };
}

/** Test seam: drops the isolate cache so a case can start from a cold fetch. */
export function resetJwksCache(): void {
  cache.clear();
}
