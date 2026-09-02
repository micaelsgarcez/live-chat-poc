import { env } from "cloudflare:test";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../../env";
import { authenticate, authorizeModerator } from "./index";
import { resetJwksCache } from "./jwks";

const nowSeconds = () => Math.floor(Date.now() / 1000);

function hs256Secret(secret = env.JWT_HS256_SECRET!): Uint8Array {
  return new TextEncoder().encode(secret);
}

interface TokenOptions {
  subject?: string | null;
  issuer?: string;
  audience?: string;
  expiresAt?: number | null;
  notBefore?: number;
  claims?: Record<string, unknown>;
  secret?: Uint8Array;
}

async function hs256Token(options: TokenOptions = {}): Promise<string> {
  let jwt = new SignJWT(options.claims ?? {})
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(options.issuer ?? env.JWT_ISSUER)
    .setAudience(options.audience ?? env.JWT_AUDIENCE)
    .setIssuedAt(nowSeconds());
  if (options.subject !== null) jwt = jwt.setSubject(options.subject ?? "u-1");
  if (options.expiresAt !== null) jwt = jwt.setExpirationTime(options.expiresAt ?? nowSeconds() + 600);
  if (options.notBefore !== undefined) jwt = jwt.setNotBefore(options.notBefore);
  return jwt.sign(options.secret ?? hs256Secret());
}

function withToken(token: string | null, headers: Record<string, string> = {}): Request {
  return new Request("https://example.com/api/me", {
    headers: token === null ? headers : { authorization: `Bearer ${token}`, ...headers },
  });
}

describe("authenticate — HS256", () => {
  it("accepts a well-formed token", async () => {
    const result = await authenticate(withToken(await hs256Token({ claims: { name: "Ana" } })), env);
    expect(result.ok).toBe(true);
    expect(result.identity).toMatchObject({ userId: "u-1", name: "Ana", roles: [] });
  });

  it("reports an expired token", async () => {
    const token = await hs256Token({ expiresAt: nowSeconds() - 120 });
    expect(await authenticate(withToken(token), env)).toEqual({ ok: false, reason: "expired" });
  });

  it("tolerates 30s of clock drift on exp", async () => {
    const token = await hs256Token({ expiresAt: nowSeconds() - 10 });
    expect((await authenticate(withToken(token), env)).ok).toBe(true);
  });

  it("reports a token signed with the wrong secret", async () => {
    const token = await hs256Token({ secret: hs256Secret("not-the-secret") });
    expect(await authenticate(withToken(token), env)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("reports the wrong audience", async () => {
    const token = await hs256Token({ audience: "some-other-app" });
    expect(await authenticate(withToken(token), env)).toEqual({ ok: false, reason: "wrong_audience" });
  });

  it("reports the wrong issuer", async () => {
    const token = await hs256Token({ issuer: "https://evil.test" });
    expect(await authenticate(withToken(token), env)).toEqual({ ok: false, reason: "wrong_issuer" });
  });

  it("rejects a request with no token at all", async () => {
    expect(await authenticate(withToken(null), env)).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a token that is not a JWT", async () => {
    expect(await authenticate(withToken("not.a.jwt"), env)).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a token that is not valid yet", async () => {
    const token = await hs256Token({ notBefore: nowSeconds() + 300 });
    expect(await authenticate(withToken(token), env)).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a token with no subject", async () => {
    const token = await hs256Token({ subject: null });
    expect(await authenticate(withToken(token), env)).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a token that never expires", async () => {
    const token = await hs256Token({ expiresAt: null });
    expect(await authenticate(withToken(token), env)).toEqual({ ok: false, reason: "malformed" });
  });

  it("accepts the token from the `token` query parameter, as the WebSocket path does", async () => {
    const token = await hs256Token();
    const req = new Request(`https://example.com/ws/room-1?token=${token}`);
    expect((await authenticate(req, env)).ok).toBe(true);
  });
});

describe("authenticate — role extraction", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["the plain `roles` claim", { roles: ["Moderator", "moderator", "VIP"] }],
    ["the Keycloak `realm_access.roles` claim", { realm_access: { roles: ["MODERATOR", "vip"] } }],
    ["the namespaced claim", { "https://livechat/roles": ["moderator", "Vip"] }],
  ];

  for (const [label, claims] of cases) {
    it(`normalises roles from ${label}`, async () => {
      const result = await authenticate(withToken(await hs256Token({ claims })), env);
      expect(result.identity?.roles).toEqual(["moderator", "vip"]);
    });
  }
});

describe("authenticate — configuration", () => {
  it("reports `not_configured` when no HS256 secret is set", async () => {
    const bare: Env = { ...env, JWT_HS256_SECRET: undefined };
    const result = await authenticate(withToken(await hs256Token()), bare);
    expect(result).toEqual({ ok: false, reason: "not_configured" });
  });

  it("reports `not_configured` for an algorithm we do not verify", async () => {
    const odd: Env = { ...env, JWT_ALG: "PS512" };
    const result = await authenticate(withToken(await hs256Token()), odd);
    expect(result).toEqual({ ok: false, reason: "not_configured" });
  });

  it("reports `not_configured` when RS256 is selected without a JWKS URL", async () => {
    const noJwks: Env = { ...env, JWT_ALG: "RS256", JWKS_URL: "" };
    const result = await authenticate(withToken(await hs256Token()), noJwks);
    expect(result).toEqual({ ok: false, reason: "not_configured" });
  });
});

/* ------------------------------------------------------------------ */
/* RS256 / ES256 against a remote key set                              */
/* ------------------------------------------------------------------ */

type JwksBody = { keys: JWK[] } | "error";

/**
 * jose resolves `fetch` from the global scope at call time, so swapping it here
 * serves the key set without any network — the suite has to run offline.
 */
function serveJwks(origin: string, body: () => JwksBody): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(origin)) return original(input as RequestInfo, init);
    const served = body();
    if (served === "error") return new Response("upstream is down", { status: 500 });
    return new Response(JSON.stringify(served), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

async function keyPairAndJwk(alg: "RS256" | "ES256", kid: string) {
  const { publicKey, privateKey } = await generateKeyPair(alg, { extractable: true });
  const jwk = await exportJWK(publicKey);
  return { privateKey, jwk: { ...jwk, kid, alg, use: "sig" } as JWK };
}

async function signedWith(
  privateKey: CryptoKey,
  alg: "RS256" | "ES256",
  kid: string,
  claims: Record<string, unknown> = {},
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg, kid })
    .setSubject("u-remote")
    .setIssuer(env.JWT_ISSUER)
    .setAudience(env.JWT_AUDIENCE)
    .setIssuedAt(nowSeconds())
    .setExpirationTime(nowSeconds() + 600)
    .sign(privateKey);
}

describe("authenticate — remote JWKS", () => {
  const restores: Array<() => void> = [];

  afterEach(() => {
    while (restores.length) restores.pop()!();
    resetJwksCache();
  });

  function jwksEnv(alg: "RS256" | "ES256", origin: string): Env {
    return { ...env, JWT_ALG: alg, JWKS_URL: `${origin}/.well-known/jwks.json` };
  }

  for (const alg of ["RS256", "ES256"] as const) {
    it(`verifies an ${alg} token against the published key set`, async () => {
      const origin = `https://idp-${alg.toLowerCase()}.test`;
      const { privateKey, jwk } = await keyPairAndJwk(alg, "k1");
      restores.push(serveJwks(origin, () => ({ keys: [jwk] })));

      const token = await signedWith(privateKey, alg, "k1", { name: "Remote", roles: ["VIP"] });
      const result = await authenticate(withToken(token), jwksEnv(alg, origin));
      expect(result.ok).toBe(true);
      expect(result.identity).toMatchObject({ userId: "u-remote", name: "Remote", roles: ["vip"] });
    });
  }

  it("fetches the key set once and reuses it across requests", async () => {
    const origin = "https://idp-cached.test";
    const { privateKey, jwk } = await keyPairAndJwk("RS256", "k1");
    let fetches = 0;
    restores.push(
      serveJwks(origin, () => {
        fetches++;
        return { keys: [jwk] };
      }),
    );

    const target = jwksEnv("RS256", origin);
    for (let i = 0; i < 3; i++) {
      const token = await signedWith(privateKey, "RS256", "k1");
      expect((await authenticate(withToken(token), target)).ok).toBe(true);
    }
    expect(fetches).toBe(1);
  });

  it("recovers when the issuer rotates its signing key", async () => {
    const origin = "https://idp-rotating.test";
    const first = await keyPairAndJwk("RS256", "k1");
    const second = await keyPairAndJwk("RS256", "k2");
    let published = [first.jwk];
    restores.push(serveJwks(origin, () => ({ keys: published })));

    const target = jwksEnv("RS256", origin);
    const before = await signedWith(first.privateKey, "RS256", "k1");
    expect((await authenticate(withToken(before), target)).ok).toBe(true);

    // The cached set is still inside jose's cooldown, so only our forced reload
    // can pick the new key up.
    published = [second.jwk];
    const after = await signedWith(second.privateKey, "RS256", "k2");
    expect((await authenticate(withToken(after), target)).ok).toBe(true);
  });

  it("reports `bad_signature` for a `kid` the issuer never published", async () => {
    const origin = "https://idp-unknown-kid.test";
    const published = await keyPairAndJwk("RS256", "k1");
    const forged = await keyPairAndJwk("RS256", "k-forged");
    restores.push(serveJwks(origin, () => ({ keys: [published.jwk] })));

    const token = await signedWith(forged.privateKey, "RS256", "k-forged");
    const result = await authenticate(withToken(token), jwksEnv("RS256", origin));
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("reports `not_configured` when the key set cannot be fetched", async () => {
    const origin = "https://idp-down.test";
    const { privateKey } = await keyPairAndJwk("RS256", "k1");
    restores.push(serveJwks(origin, () => "error"));

    const token = await signedWith(privateKey, "RS256", "k1");
    const result = await authenticate(withToken(token), jwksEnv("RS256", origin));
    expect(result).toEqual({ ok: false, reason: "not_configured" });
  });

  it("refuses an HS256 token when the deployment verifies RS256", async () => {
    const origin = "https://idp-downgrade.test";
    const { jwk } = await keyPairAndJwk("RS256", "k1");
    restores.push(serveJwks(origin, () => ({ keys: [jwk] })));

    const token = await hs256Token();
    expect((await authenticate(withToken(token), jwksEnv("RS256", origin))).ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* moderator authorisation                                             */
/* ------------------------------------------------------------------ */

describe("authorizeModerator", () => {
  it("accepts the shared moderator key", async () => {
    const req = withToken(null, { "x-moderator-key": env.MODERATOR_API_KEY! });
    expect(await authorizeModerator(req, env)).toEqual({
      userId: "moderator",
      name: "moderator",
      roles: ["moderator"],
      expiresAt: 0,
    });
  });

  it("rejects a wrong shared key instead of falling back to it", async () => {
    const req = withToken(null, { "x-moderator-key": "wrong-key" });
    expect(await authorizeModerator(req, env)).toBeNull();
  });

  it("accepts a JWT carrying the moderator role", async () => {
    const token = await hs256Token({ claims: { roles: ["Moderator"] } });
    const identity = await authorizeModerator(withToken(token), env);
    expect(identity).toMatchObject({ userId: "u-1", roles: ["moderator"] });
  });

  it("accepts an admin role sent through `realm_access`", async () => {
    const token = await hs256Token({ claims: { realm_access: { roles: ["ADMIN"] } } });
    expect(await authorizeModerator(withToken(token), env)).toMatchObject({ roles: ["admin"] });
  });

  it("rejects an authenticated user with no moderator role", async () => {
    const token = await hs256Token({ claims: { roles: ["vip"] } });
    expect(await authorizeModerator(withToken(token), env)).toBeNull();
  });

  it("rejects an anonymous request", async () => {
    expect(await authorizeModerator(withToken(null), env)).toBeNull();
  });
});
