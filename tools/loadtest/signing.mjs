/**
 * Credentials the generator makes for itself.
 *
 * Two things are signed locally rather than fetched, for the same reason: at
 * 5.000 new connections a second, anything that costs an HTTP round trip per
 * client is a second load test running alongside the first one, and you can no
 * longer tell which of the two you are measuring.
 *
 *   - **JWTs.** `POST /api/dev/token` would be 300k requests inside the ramp.
 *     The claims here mirror `mintDevToken` exactly (`src/features/auth`), so a
 *     token signed here is indistinguishable from one the route would mint.
 *   - **The rate-limit bypass.** One HMAC per run, reused on every handshake
 *     until it ages out of the window; see `src/features/rate-limit/bypass.ts`.
 *
 * Node's own crypto is enough for both, so this adds no dependency.
 */
import { createHmac } from "node:crypto";

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

/**
 * An HS256 JWT with the same claims `mintDevToken` produces. `iat`/`exp` are
 * seconds, as the spec and the verifier both expect.
 */
export function signJwt({ secret, userId, name, roles = [], issuer, audience, ttlSeconds = 7200 }) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      name: name ?? userId,
      roles,
      sub: userId,
      iss: issuer,
      aud: audience,
      iat: now,
      exp: now + ttlSeconds,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

export const LOADTEST_BYPASS_HEADER = "x-loadtest-auth";

/**
 * `<timestamp>.<hmac>`, matching `signBypass` on the Worker side. The Worker
 * only accepts it for five minutes, so a long run re-signs — cheap, and it
 * means a header scraped from a run is useless shortly after.
 */
export function signBypassHeader(secret, timestamp = Date.now()) {
  const mac = createHmac("sha256", secret).update(String(timestamp)).digest("hex");
  return `${timestamp}.${mac}`;
}

/** Re-signs when the current header is more than half-way through the window. */
export function makeBypassSigner(secret) {
  if (!secret) return () => null;
  let issuedAt = 0;
  let header = null;
  return () => {
    const now = Date.now();
    if (!header || now - issuedAt > 120_000) {
      issuedAt = now;
      header = signBypassHeader(secret, now);
    }
    return header;
  };
}
