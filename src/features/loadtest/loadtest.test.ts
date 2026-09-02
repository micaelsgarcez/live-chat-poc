import { SELF, createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../env";
import { loadTestSlice } from "./index";
import { LOADTEST_PRESETS, findPreset } from "./presets";
import { applyProgress, clearRun, newRun, readRun, type LoadTestRun } from "./run";

const ROOM = "loadtest-slice";
const MODERATOR = {
  "x-moderator-key": env.MODERATOR_API_KEY!,
  "content-type": "application/json",
};

function url(room = ROOM): string {
  return `https://example.com/api/rooms/${room}/loadtest`;
}

async function body<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

beforeEach(async () => {
  await clearRun(env, ROOM);
});

describe("presets", () => {
  it("is a ladder that only ever grows", () => {
    const sizes = LOADTEST_PRESETS.map((p) => p.connections);
    expect([...sizes].sort((a, b) => a - b)).toEqual(sizes);
  });

  it("tops out at the 300k / 50k window the plan is written against", () => {
    const max = findPreset("max");
    expect(max?.connections).toBe(300_000);
    expect(max?.talkers).toBe(50_000);
  });

  it("gives every preset the same shape, so two runs are comparable", () => {
    for (const preset of LOADTEST_PRESETS) {
      expect(preset.rampSeconds).toBe(60);
      expect(preset.holdSeconds).toBe(30);
      expect(preset.talkers).toBeLessThanOrEqual(preset.connections);
    }
  });

  it("provisions enough shards for the sockets it plans to open", () => {
    for (const preset of LOADTEST_PRESETS) {
      expect(preset.shards * 5_000).toBeGreaterThanOrEqual(preset.connections);
    }
  });
});

describe("run record", () => {
  it("clamps talkers to the number of sockets instead of failing the run", () => {
    const run = newRun({
      roomId: ROOM,
      runId: "r1",
      preset: "custom",
      targetConnections: 100,
      targetTalkers: 5_000,
      rampSeconds: 60,
      holdSeconds: 30,
      bypass: false,
      now: 1_000,
    });
    expect(run.targetTalkers).toBe(100);
  });

  it("ignores nonsense in a progress report rather than storing it", () => {
    const run = newRun({
      roomId: ROOM,
      runId: "r1",
      preset: "smoke",
      targetConnections: 1_000,
      targetTalkers: 200,
      rampSeconds: 60,
      holdSeconds: 30,
      bypass: false,
      now: 1_000,
    });
    const next = applyProgress(
      run,
      { phase: "nope", progress: { open: 40, sent: -3, acked: Number.NaN } },
      2_000,
    );
    expect(next.phase).toBe("ramp");
    expect(next.progress.open).toBe(40);
    expect(next.progress.sent).toBe(0);
    expect(next.progress.acked).toBe(0);
    expect(next.updatedAt).toBe(2_000);
  });
});

describe("routes", () => {
  it("says nothing is running, and still lists the ladder", async () => {
    const res = await SELF.fetch(url());
    expect(res.status).toBe(200);
    const payload = await body<{ run: null; presets: unknown[] }>(res);
    expect(payload.run).toBeNull();
    expect(payload.presets).toHaveLength(LOADTEST_PRESETS.length);
  });

  it("refuses to announce a run without moderator credentials", async () => {
    const res = await SELF.fetch(url(), { method: "POST", body: "{}" });
    expect(res.status).toBe(403);
    expect(await readRun(env, ROOM)).toBeNull();
  });

  it("announces a preset run and then reads it back publicly", async () => {
    const started = await SELF.fetch(url(), {
      method: "POST",
      headers: MODERATOR,
      body: JSON.stringify({ preset: "smoke" }),
    });
    expect(started.status).toBe(200);
    const run = (await body<{ run: LoadTestRun }>(started)).run;
    expect(run.targetConnections).toBe(1_000);
    expect(run.phase).toBe("ramp");

    const seen = await body<{ run: LoadTestRun }>(await SELF.fetch(url()));
    expect(seen.run.runId).toBe(run.runId);
  });

  it("rejects a preset that does not exist, naming the ones that do", async () => {
    const res = await SELF.fetch(url(), {
      method: "POST",
      headers: MODERATOR,
      body: JSON.stringify({ preset: "gigantic" }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("smoke");
  });

  it("records progress and the phase the generator says it is in", async () => {
    await SELF.fetch(url(), {
      method: "POST",
      headers: MODERATOR,
      body: JSON.stringify({ preset: "smoke" }),
    });
    const res = await SELF.fetch(url(), {
      method: "PATCH",
      headers: MODERATOR,
      body: JSON.stringify({ phase: "hold", progress: { open: 950, sent: 120 } }),
    });
    expect(res.status).toBe(200);
    const run = (await body<{ run: LoadTestRun }>(res)).run;
    expect(run.phase).toBe("hold");
    expect(run.progress.open).toBe(950);
  });

  it("answers a late progress report with 404 instead of resurrecting the run", async () => {
    const res = await SELF.fetch(url(), {
      method: "PATCH",
      headers: MODERATOR,
      body: JSON.stringify({ phase: "done" }),
    });
    expect(res.status).toBe(404);
  });

  it("ends a run, which is what takes the banner off the public page", async () => {
    await SELF.fetch(url(), {
      method: "POST",
      headers: MODERATOR,
      body: JSON.stringify({ preset: "smoke" }),
    });
    const res = await SELF.fetch(url(), { method: "DELETE", headers: MODERATOR });
    expect(res.status).toBe(200);
    expect(await readRun(env, ROOM)).toBeNull();
  });

  it("reports the bypass as unarmed on a deployment that has no secret", async () => {
    // Called against an explicit env instead of through SELF: whoever runs a
    // load test puts a real key in `.dev.vars`, and reading "unarmed" off the
    // ambient environment would fail for a reason unrelated to the code.
    const route = loadTestSlice.routes?.find(
      (r) => r.method === "GET" && r.path === "/api/rooms/:roomId/loadtest",
    );
    if (!route) throw new Error("loadtest slice has no GET route");
    const ctx = createExecutionContext();
    const res = await route.handler(
      new Request(url()),
      { ...env, LOADTEST_BYPASS_KEY: undefined } as Env,
      ctx,
      { params: { roomId: ROOM } },
    );
    await waitOnExecutionContext(ctx);
    expect((await body<{ bypassArmed: boolean }>(res)).bypassArmed).toBe(false);
  });
});
