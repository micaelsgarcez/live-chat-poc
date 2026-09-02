import { SELF, createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../../env";
import type { Identity } from "../../shared/identity";
import { authSlice, mintDevToken } from "./index";

function route(method: string, path: string) {
  const found = authSlice.routes?.find((r) => r.method === method && r.path === path);
  if (!found) throw new Error(`auth slice has no ${method} ${path}`);
  return found;
}

/** Exercises a route against an env this deployment does not have, e.g. production. */
async function callRoute(
  method: string,
  path: string,
  request: Request,
  overrides: Partial<Env> = {},
): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await route(method, path).handler(request, { ...env, ...overrides }, ctx, {
    params: {},
  });
  await waitOnExecutionContext(ctx);
  return response;
}

describe("POST /api/dev/token", () => {
  it("mints a token and the identity that token resolves to", async () => {
    const res = await SELF.fetch("https://example.com/api/dev/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "ana", name: "Ana", roles: ["Moderator"] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; identity: Identity };
    expect(typeof body.token).toBe("string");
    expect(body.identity).toMatchObject({ userId: "ana", name: "Ana", roles: ["moderator"] });
    expect(body.identity.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("rejects a request with no userId", async () => {
    const res = await SELF.fetch("https://example.com/api/dev/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "nobody" }),
    });
    expect(res.status).toBe(400);
  });

  it("is not reachable in production", async () => {
    const req = new Request("https://example.com/api/dev/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "ana" }),
    });
    const res = await callRoute("POST", "/api/dev/token", req, { ENVIRONMENT: "production" });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "not_found" } });
  });
});

describe("mintDevToken", () => {
  it("returns null when no HS256 secret is configured", async () => {
    const bare: Env = { ...env, JWT_HS256_SECRET: undefined };
    expect(await mintDevToken(bare, { userId: "ana" })).toBeNull();
  });

  it("clamps an absurd ttl", async () => {
    const minted = await mintDevToken(env, { userId: "ana", ttlSeconds: 10 ** 9 });
    const ttl = minted!.identity.expiresAt - Math.floor(Date.now() / 1000);
    expect(ttl).toBeLessThanOrEqual(24 * 3600);
  });
});

describe("GET /api/me", () => {
  it("returns the identity behind the presented token", async () => {
    const minted = await mintDevToken(env, { userId: "ana", name: "Ana", roles: ["vip"] });
    const res = await SELF.fetch("https://example.com/api/me", {
      headers: { authorization: `Bearer ${minted!.token}` },
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ identity: minted!.identity });
  });

  it("answers 401 without a token", async () => {
    const res = await SELF.fetch("https://example.com/api/me");
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "unauthenticated" } });
  });

  it("answers 401 for a token that does not verify", async () => {
    const res = await SELF.fetch("https://example.com/api/me", {
      headers: { authorization: "Bearer not.a.jwt" },
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /ws/:roomId — the edge refuses an unauthenticated upgrade", () => {
  it("answers 401 without a token", async () => {
    const res = await SELF.fetch("https://example.com/ws/room-auth", {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(401);
    expect(res.webSocket).toBeNull();
  });

  it("answers 401 for an expired-looking garbage token", async () => {
    const res = await SELF.fetch("https://example.com/ws/room-auth?token=not.a.jwt", {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(401);
  });

  it("answers 101 for a valid token", async () => {
    const minted = await mintDevToken(env, { userId: "ana", name: "Ana" });
    const res = await SELF.fetch(`https://example.com/ws/room-auth?token=${minted!.token}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(101);
    expect(res.webSocket).not.toBeNull();
    res.webSocket!.accept();
    res.webSocket!.close();
  });
});
