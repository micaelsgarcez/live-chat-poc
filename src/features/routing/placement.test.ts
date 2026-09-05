import { describe, expect, it } from "vitest";
import { placementCandidates, selectShardIndex } from "./index";

describe("placementCandidates", () => {
  it("probes three consecutive existing shards and then the next shard", () => {
    const key = "room:user";
    const first = selectShardIndex(key, 5);
    expect(placementCandidates(key, 5)).toEqual([
      first,
      (first + 1) % 5,
      (first + 2) % 5,
      5,
    ]);
  });

  it("does not repeat candidates when the room has fewer shards than probes", () => {
    expect(placementCandidates("room:user", 1)).toEqual([0, 1]);
  });

  it("honours a custom probe limit", () => {
    const key = "room:user";
    expect(placementCandidates(key, 4, 1)).toEqual([selectShardIndex(key, 4), 4]);
  });
});
