/**
 * SLICE: auth — edge-only authentication.
 *
 * OWNER CONTRACT (do not change these signatures):
 *   authSlice           : Slice
 *   authenticate        : (req, env) => Promise<AuthResult>
 *   authorizeModerator  : (req, env) => Promise<Identity | null>
 *
 * STUB — replace with real JWT verification (HS256 secret + RS256/JWKS).
 */
import type { Env } from "../../env";
import type { Slice } from "../../shared/slice";
import type { AuthResult } from "../../shared/ports";
import type { Identity } from "../../shared/identity";
import { bearerToken } from "../../shared/http";

export async function authenticate(req: Request, env: Env): Promise<AuthResult> {
  const token = bearerToken(req);
  if (!token) return { ok: false, reason: "missing token" };
  return {
    ok: true,
    identity: {
      userId: `dev-${token.slice(0, 8)}`,
      name: `dev-${token.slice(0, 8)}`,
      roles: [],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    },
  };
}

export async function authorizeModerator(req: Request, env: Env): Promise<Identity | null> {
  const key = req.headers.get("x-moderator-key");
  if (key && env.MODERATOR_API_KEY && key === env.MODERATOR_API_KEY) {
    return { userId: "moderator", name: "moderator", roles: ["moderator"], expiresAt: 0 };
  }
  return null;
}

export const authSlice: Slice = { name: "auth", routes: [] };
