import { describe, expect, it } from "vitest";
import { decidePresence } from "./presence";

const NOW = 1_700_000_000_000;

describe("presence reporting", () => {
  it("always reports the first count", () => {
    expect(decidePresence(3, null, NOW, 30_000)).toEqual({ report: true });
  });

  it("stays silent while the count does not move", () => {
    const last = { count: 3, at: NOW };
    expect(decidePresence(3, last, NOW + 2_000, 30_000)).toEqual({ report: false });
  });

  it("reports as soon as the count moves", () => {
    const last = { count: 3, at: NOW };
    expect(decidePresence(4, last, NOW + 2_000, 30_000)).toEqual({ report: true });
  });

  it("refreshes the coordinator on the heartbeat once its copy would go stale", () => {
    const last = { count: 3, at: NOW };
    expect(decidePresence(3, last, NOW + 30_000, 30_000)).toEqual({ report: true });
  });
});
