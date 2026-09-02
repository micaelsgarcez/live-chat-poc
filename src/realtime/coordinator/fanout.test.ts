import { describe, expect, it } from "vitest";
import { callInBatches } from "./fanout";

describe("callInBatches", () => {
  it("splits the calls so one invocation cannot blow the subrequest budget", async () => {
    const indexes = Array.from({ length: 70 }, (_, i) => i);
    let inFlight = 0;
    let peak = 0;

    const outcome = await callInBatches(
      indexes,
      async (index) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        inFlight--;
        return index;
      },
      32,
    );

    expect(peak).toBeLessThanOrEqual(32);
    expect(outcome.ok).toHaveLength(70);
    expect(outcome.failed).toHaveLength(0);
  });

  it("keeps the healthy calls when one rejects", async () => {
    const outcome = await callInBatches([0, 1, 2], async (index) => {
      if (index === 1) throw new Error("down");
      return index * 10;
    });

    expect(outcome.ok.map((entry) => entry.value)).toEqual([0, 20]);
    expect(outcome.failed.map((entry) => entry.index)).toEqual([1]);
  });

  it("does nothing for an empty target list", async () => {
    const outcome = await callInBatches([], async () => 1);
    expect(outcome).toEqual({ ok: [], failed: [] });
  });
});
