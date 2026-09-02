import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../env";
import { fetchCloudflareAnalytics, isCloudflareConfigured } from "./cloudflare";

/** An env with the two account settings explicitly absent. */
function unconfigured(): Env {
  return { ...env, CF_API_TOKEN: undefined, CF_ACCOUNT_ID: undefined } as unknown as Env;
}

/** An env that looks configured, so the HTTP path is the one under test. */
function configured(): Env {
  return {
    ...env,
    CF_API_TOKEN: "test-token",
    CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    // A cache that never hits, so each test exercises the fetch it means to.
    CHAT_KV: { get: async () => null, put: async () => undefined },
  } as unknown as Env;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cloudflare analytics", () => {
  it("reports itself unconfigured instead of failing", async () => {
    expect(isCloudflareConfigured(unconfigured())).toBe(false);
    const result = await fetchCloudflareAnalytics(unconfigured());
    expect(result.available).toBe(false);
    if (result.available === false) {
      expect(result.reason).toContain("CF_API_TOKEN");
    }
  });

  it("never calls the API when there is nothing to authenticate with", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    await fetchCloudflareAnalytics(unconfigured());
    expect(spy).not.toHaveBeenCalled();
  });

  it("turns a rejected token into a sentence about the token's scope", async () => {
    vi.stubGlobal("fetch", async () => new Response("no", { status: 403 }));
    const result = await fetchCloudflareAnalytics(configured());
    expect(result.available).toBe(false);
    if (result.available === false) {
      expect(result.reason).toContain("403");
      expect(result.reason).toContain("account_analytics:read");
    }
  });

  it("survives an unreachable API rather than throwing into the route", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("connect ECONNREFUSED");
    });
    const result = await fetchCloudflareAnalytics(configured());
    expect(result.available).toBe(false);
    if (result.available === false) {
      expect(result.reason).toContain("ECONNREFUSED");
    }
  });

  it("sums the buckets and keeps the worst quantile in the window", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({
        data: {
          viewer: {
            accounts: [
              {
                workersInvocationsAdaptive: [
                  { sum: { requests: 10, errors: 1, subrequests: 2 }, quantiles: { cpuTimeP50: 3, cpuTimeP99: 40 } },
                  { sum: { requests: 5, errors: 0, subrequests: 1 }, quantiles: { cpuTimeP50: 9, cpuTimeP99: 12 } },
                ],
                durableObjectsInvocationsAdaptiveGroups: [
                  { sum: { requests: 7, errors: 0, responseBodySize: 1024 }, quantiles: { wallTimeP50: 2, wallTimeP99: 30 } },
                ],
                durableObjectsPeriodicGroups: [
                  { sum: { activeTime: 2_000_000, storageReadUnits: 4, storageWriteUnits: 2, storageDeletes: 1 } },
                ],
              },
            ],
          },
        },
      }),
    );

    const result = await fetchCloudflareAnalytics(configured());
    expect(result.available).toBe(true);
    if (result.available !== true) return;
    expect(result.worker.requests).toBe(15);
    expect(result.worker.errors).toBe(1);
    // Averaging percentiles would hide the spike that is the reason to look.
    expect(result.worker.cpuTimeP99).toBe(40);
    expect(result.durableObjects.responseBodyBytes).toBe(1024);
    // `activeTime` arrives in microseconds.
    expect(result.durableObjects.activeTimeSeconds).toBeCloseTo(2);
  });

  it("explains an empty account instead of pretending it has zero traffic", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({ data: { viewer: { accounts: [] } }, errors: [{ message: "no access" }] }),
    );
    const result = await fetchCloudflareAnalytics(configured());
    expect(result.available).toBe(false);
    if (result.available === false) expect(result.reason).toContain("no access");
  });
});
