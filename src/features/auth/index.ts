/**
 * SLICE: auth — edge-only authentication.
 *
 * The whole point of doing this at the edge is that the Durable Object never
 * pays for it: by the time a socket reaches a shard the identity is already
 * resolved and the shard just trusts the connect metadata.
 *
 * PUBLIC SURFACE (frozen — imported by `connect`, `room`, tests and tooling):
 *   authSlice          : Slice
 *   authenticate       : (req, env) => Promise<AuthResult>
 *   authorizeModerator : (req, env) => Promise<Identity | null>
 *   mintDevToken       : (env, input) => Promise<{ token, identity } | null>
 *
 * FROZEN ROUTE: `POST /api/dev/token` mints a local HS256 token and answers
 * `{ token, identity }`. The demo client, the load generator and several slice
 * tests depend on that exact shape.
 *
 * ALSO ROUTED: `GET /api/me` answers `{ identity }` for the presented token, so
 * a client can resolve who it is without opening a socket first.
 *
 * `JWT_ALG` picks the verification mode: HS256 against `JWT_HS256_SECRET`, or
 * RS256/ES256 against the key set at `JWKS_URL` (see `./jwks.ts`).
 */
import { SignJWT, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Env } from "../../env";
import { RejectCode } from "../../shared/errors";
import { bearerToken, json, problem, readJson, type RouteDef } from "../../shared/http";
import { hasRole, type Identity } from "../../shared/identity";
import type { AuthResult } from "../../shared/ports";
import type { Slice } from "../../shared/slice";
import { identityFromClaims, normalizeUserId } from "./claims";
import { remoteJwksResolver } from "./jwks";
import { classifyVerifyError, type AuthFailureReason } from "./reasons";

/** Covers the clock drift between an issuer and the edge; also applies to `nbf`. */
const CLOCK_TOLERANCE_SECONDS = 30;

const MODERATOR_ROLES = ["moderator", "admin"] as const;

const DEV_TOKEN_DEFAULT_TTL_SECONDS = 3600;
const DEV_TOKEN_MAX_TTL_SECONDS = 24 * 3600;

/**
 * HS256 verifies against a shared secret and never needs the network; RS256 and
 * ES256 verify against the issuer's published key set. Anything else is a
 * misconfiguration rather than a token we should try to verify.
 */
type Verifier =
  | { alg: "HS256"; key: Uint8Array }
  | { alg: "RS256" | "ES256"; getKey: JWTVerifyGetKey };

function hs256Key(env: Env): Uint8Array | null {
  const secret = env.JWT_HS256_SECRET;
  return secret ? new TextEncoder().encode(secret) : null;
}

function resolveVerifier(env: Env): Verifier | null {
  const alg = (env.JWT_ALG || "HS256").trim().toUpperCase();

  if (alg === "HS256") {
    const key = hs256Key(env);
    return key ? { alg: "HS256", key } : null;
  }

  if (alg === "RS256" || alg === "ES256") {
    const raw = env.JWKS_URL?.trim();
    if (!raw) return null;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    return { alg, getKey: remoteJwksResolver(url) };
  }

  return null;
}

const fail = (reason: AuthFailureReason): AuthResult => ({ ok: false, reason });

export async function authenticate(req: Request, env: Env): Promise<AuthResult> {
  const token = bearerToken(req);
  // Presenting nothing is not a separate outcome for the caller — it gets the
  // same 401 — and folding it in keeps the reason vocabulary closed.
  if (!token) return fail("malformed");

  const verifier = resolveVerifier(env);
  if (!verifier) return fail("not_configured");

  try {
    const { payload } = await jwtVerify(
      token,
      verifier.alg === "HS256" ? verifier.key : verifier.getKey,
      {
        // Pinning the algorithm is what stops an "alg" downgrade: without it a
        // JWKS deployment would also accept an HS256 token signed with the
        // public key it publishes.
        algorithms: [verifier.alg],
        issuer: env.JWT_ISSUER || undefined,
        audience: env.JWT_AUDIENCE || undefined,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        // A token with no `exp` would never expire; refuse it outright.
        requiredClaims: ["sub", "exp"],
      },
    );
    return identityFromClaims(payload as Record<string, unknown>);
  } catch (error) {
    return fail(classifyVerifyError(error));
  }
}

/**
 * Comparing the shared key with `===` leaks its prefix through timing, and this
 * one key is the whole moderator authorisation story when no JWT is presented.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i]! ^ right[i]!;
  return diff === 0;
}

export async function authorizeModerator(req: Request, env: Env): Promise<Identity | null> {
  const presented = req.headers.get("x-moderator-key");
  if (presented && env.MODERATOR_API_KEY && timingSafeEqual(presented, env.MODERATOR_API_KEY)) {
    return { userId: "moderator", name: "moderator", roles: ["moderator"], expiresAt: 0 };
  }
  const auth = await authenticate(req, env);
  if (auth.ok && auth.identity && hasRole(auth.identity, MODERATOR_ROLES)) {
    return auth.identity;
  }
  return null;
}

export async function mintDevToken(
  env: Env,
  input: { userId: string; name?: string; roles?: string[]; ttlSeconds?: number },
): Promise<{ token: string; identity: Identity } | null> {
  const key = hs256Key(env);
  if (!key) return null;
  const userId = normalizeUserId(input.userId);
  if (!userId) return null;

  const ttl = Math.min(
    Math.max(1, Math.floor(input.ttlSeconds ?? DEV_TOKEN_DEFAULT_TTL_SECONDS)),
    DEV_TOKEN_MAX_TTL_SECONDS,
  );
  const expiresAt = Math.floor(Date.now() / 1000) + ttl;
  const claims = {
    name: input.name ?? userId,
    roles: Array.isArray(input.roles) ? input.roles : [],
  };

  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuer(env.JWT_ISSUER)
    .setAudience(env.JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(key);

  // Derive the returned identity from the claims rather than from the input, so
  // callers see exactly what `authenticate` will produce for this token — the
  // demo client would otherwise display a name the server never uses.
  const mapped = identityFromClaims({ ...claims, sub: userId, exp: expiresAt });
  if (!mapped.ok || !mapped.identity) return null;
  return { token, identity: mapped.identity };
}

const routes: RouteDef[] = [
  {
    method: "GET",
    path: "/api/me",
    async handler(req, env) {
      const auth = await authenticate(req, env);
      if (!auth.ok || !auth.identity) {
        return problem(401, RejectCode.UNAUTHENTICATED, auth.reason ?? "invalid credentials");
      }
      return json({ identity: auth.identity });
    },
  },
  {
    method: "POST",
    path: "/api/dev/token",
    async handler(req, env) {
      if (env.ENVIRONMENT === "production") {
        return problem(404, "not_found", "dev tokens are disabled in production");
      }
      const body = await readJson<{
        userId?: string;
        name?: string;
        roles?: string[];
        ttlSeconds?: number;
      }>(req);
      const userId = normalizeUserId(body?.userId);
      if (!userId) return problem(400, RejectCode.MALFORMED, "userId is required");
      const minted = await mintDevToken(env, {
        userId,
        name: body?.name,
        roles: body?.roles,
        ttlSeconds: body?.ttlSeconds,
      });
      if (!minted) return problem(500, RejectCode.INTERNAL, "JWT_HS256_SECRET is not configured");
      return json(minted);
    },
  },
];

export const authSlice: Slice = { name: "auth", routes };
