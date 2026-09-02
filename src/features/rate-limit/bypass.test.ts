import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../../env";
import {
  bypassArmed,
  hasLoadTestBypass,
  signBypass,
  LOADTEST_BYPASS_HEADER,
  LOADTEST_BYPASS_WINDOW_MS,
} from "./bypass";

const SECRET = "a-load-test-secret";

function armed(): Env {
  return { ...env, LOADTEST_BYPASS_KEY: SECRET } as Env;
}

async function request(header?: string): Promise<Request> {
  return new Request("https://example.com/ws/demo", {
    headers: header ? { [LOADTEST_BYPASS_HEADER]: header } : {},
  });
}

async function signedHeader(timestamp: number, secret = SECRET): Promise<string> {
  return `${timestamp}.${await signBypass(secret, timestamp)}`;
}

describe("load test bypass", () => {
  it("does not exist until a secret is configured", async () => {
    expect(bypassArmed(env)).toBe(false);
    // Even a signature that would otherwise be perfect is refused.
    expect(await hasLoadTestBypass(await request(await signedHeader(Date.now())), env)).toBe(false);
  });

  it("reports itself as armed once the secret is there", () => {
    expect(bypassArmed(armed())).toBe(true);
  });

  it("accepts a fresh signature", async () => {
    const req = await request(await signedHeader(Date.now()));
    expect(await hasLoadTestBypass(req, armed())).toBe(true);
  });

  it("refuses a signature from outside the replay window", async () => {
    const stale = Date.now() - LOADTEST_BYPASS_WINDOW_MS - 1_000;
    expect(await hasLoadTestBypass(await request(await signedHeader(stale)), armed())).toBe(false);
  });

  it("refuses a signature made with a different secret", async () => {
    const forged = await signedHeader(Date.now(), "not-the-secret");
    expect(await hasLoadTestBypass(await request(forged), armed())).toBe(false);
  });

  it("refuses a header that is missing, empty or malformed", async () => {
    const e = armed();
    expect(await hasLoadTestBypass(await request(), e)).toBe(false);
    expect(await hasLoadTestBypass(await request(""), e)).toBe(false);
    expect(await hasLoadTestBypass(await request("no-separator"), e)).toBe(false);
    expect(await hasLoadTestBypass(await request(".abc"), e)).toBe(false);
    expect(await hasLoadTestBypass(await request("notanumber.abc"), e)).toBe(false);
    expect(await hasLoadTestBypass(await request(`${Date.now()}.`), e)).toBe(false);
  });

  it("refuses a valid timestamp carrying someone else's signature length", async () => {
    const now = Date.now();
    expect(await hasLoadTestBypass(await request(`${now}.deadbeef`), armed())).toBe(false);
  });
});
