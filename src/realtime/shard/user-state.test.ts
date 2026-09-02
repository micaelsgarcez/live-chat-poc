import { describe, expect, it } from "vitest";
import { newUserGateState } from "../../shared/pipeline";
import {
  hasPersistableState,
  isExpiredSnapshot,
  restoreUserState,
  snapshotUserState,
  userStateKey,
  type PersistedUserState,
} from "./user-state";

const NOW = 1_700_000_000_000;

describe("user state snapshots", () => {
  it("has nothing to persist for a user who only connected", () => {
    expect(hasPersistableState(newUserGateState("u1", NOW))).toBe(false);
  });

  it("persists a user carrying a mute, strikes or a drained bucket", () => {
    const muted = newUserGateState("u1", NOW);
    muted.mutedUntil = NOW + 1_000;
    expect(hasPersistableState(muted)).toBe(true);

    const struck = newUserGateState("u2", NOW);
    struck.strikes = 1;
    expect(hasPersistableState(struck)).toBe(true);

    const drained = newUserGateState("u3", NOW);
    drained.bucket = { tokens: 2, updatedAt: NOW };
    expect(hasPersistableState(drained)).toBe(true);
  });

  it("round-trips the fields a reconnect must not reset", () => {
    const state = newUserGateState("u1", NOW);
    state.mutedUntil = NOW + 30_000;
    state.strikes = 2;
    state.lastAcceptedAt = NOW - 500;
    state.acceptedCount = 7;
    state.bucket = { tokens: 1.5, updatedAt: NOW - 250 };

    const restored = restoreUserState("u1", snapshotUserState(state, NOW), NOW + 60_000);
    expect(restored.mutedUntil).toBe(state.mutedUntil);
    expect(restored.strikes).toBe(2);
    expect(restored.lastAcceptedAt).toBe(state.lastAcceptedAt);
    expect(restored.acceptedCount).toBe(7);
    // The bucket comes back at its recorded level and age, so the rate-limit
    // gate refills exactly what the elapsed time earned — no free burst.
    expect(restored.bucket).toEqual({ tokens: 1.5, updatedAt: NOW - 250 });
    // Per-second windows are deliberately dropped rather than persisted.
    expect(restored.recentSendsAt).toEqual([]);
    expect(restored.recentFingerprints).toEqual([]);
  });

  it("leaves an unseeded bucket unseeded", () => {
    const restored = restoreUserState("u1", snapshotUserState(newUserGateState("u1", NOW), NOW), NOW);
    expect(Number.isNaN(restored.bucket.tokens)).toBe(true);
  });

  it("expires only snapshots past the TTL that are no longer muted", () => {
    const base: PersistedUserState = {
      mutedUntil: 0,
      strikes: 0,
      lastAcceptedAt: 0,
      acceptedCount: 0,
      tokens: 0,
      bucketUpdatedAt: NOW,
      updatedAt: NOW - 60_000,
    };
    expect(isExpiredSnapshot(base, NOW, 30_000)).toBe(true);
    expect(isExpiredSnapshot(base, NOW, 120_000)).toBe(false);
    expect(isExpiredSnapshot({ ...base, mutedUntil: NOW + 1 }, NOW, 30_000)).toBe(false);
  });

  it("namespaces storage keys", () => {
    expect(userStateKey("alice")).toBe("u:alice");
  });
});
