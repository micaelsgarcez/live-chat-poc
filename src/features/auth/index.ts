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
 *
 * FROZEN ROUTE: `POST /api/dev/token` mints a local HS256 token and answers
 * `{ token, identity }`. The demo client, the load generator and several slice
 * tests depend on that exact shape.
 */
import { SignJWT, jwtVerify } from "jose";
import type { Env } from "../../env";
import { bearerToken, json, problem, readJson, type RouteDef } from "../../shared/http";
import type { Identity } from "../../shared/identity";
import type { AuthResult } from "../../shared/ports";
import type { Slice } from "../../shared/slice";

const CLOCK_TOLERANCE_SECONDS = 30;

function hs256Key(env: Env): Uint8Array | null {
  const secret = env.JWT_HS256_SECRET;
  return secret ? new TextEncoder().encode(secret) : null;
}

function identityFromClaims(claims: Record<string, unknown>): AuthResult {
  const userId = typeof claims.sub === "string" ? claims.sub : null;
  if (!userId) return { ok: false, reason: "token has no subject" };
  const rawRoles = claims.roles;
  const roles = Array.isArray(rawRoles) ? rawRoles.filter((r): r is string => typeof r === "string") : [];
  const name =
    (typeof claims.name === "string" && claims.name) ||
    (typeof claims.preferred_username === "string" && claims.preferred_username) ||
    userId;
  return {
    ok: true,
    identity: {
      userId,
      name,
      roles,
      expiresAt: typeof claims.exp === "number" ? claims.exp : 0,
    },
  };
}

export async function authenticate(req: Request, env: Env): Promise<AuthResult> {
  const token = bearerToken(req);
  if (!token) return { ok: false, reason: "missing token" };

  const key = hs256Key(env);
  if (!key) return { ok: false, reason: "auth is not configured" };

  try {
    const { payload } = await jwtVerify(token, key, {
      issuer: env.JWT_ISSUER || undefined,
      audience: env.JWT_AUDIENCE || undefined,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    });
    return identityFromClaims(payload as Record<string, unknown>);
  } catch (error) {
    return { ok: false, reason: `invalid token: ${String(error)}` };
  }
}

export async function authorizeModerator(req: Request, env: Env): Promise<Identity | null> {
  const key = req.headers.get("x-moderator-key");
  if (key && env.MODERATOR_API_KEY && key === env.MODERATOR_API_KEY) {
    return { userId: "moderator", name: "moderator", roles: ["moderator"], expiresAt: 0 };
  }
  const auth = await authenticate(req, env);
  if (auth.ok && auth.identity?.roles.some((role) => role === "moderator" || role === "admin")) {
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
  const roles = input.roles ?? [];
  const name = input.name ?? input.userId;
  const expiresAt = Math.floor(Date.now() / 1000) + (input.ttlSeconds ?? 3600);
  const token = await new SignJWT({ name, roles })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(input.userId)
    .setIssuer(env.JWT_ISSUER)
    .setAudience(env.JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(key);
  return { token, identity: { userId: input.userId, name, roles, expiresAt } };
}

const routes: RouteDef[] = [
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
      const userId = body?.userId?.trim();
      if (!userId) return problem(400, "malformed", "userId is required");
      const minted = await mintDevToken(env, {
        userId,
        name: body?.name,
        roles: body?.roles,
        ttlSeconds: body?.ttlSeconds,
      });
      if (!minted) return problem(500, "internal", "JWT_HS256_SECRET is not configured");
      return json(minted);
    },
  },
];

export const authSlice: Slice = { name: "auth", routes };
