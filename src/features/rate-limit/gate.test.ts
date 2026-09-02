import { describe, expect, it } from "vitest";
import { RejectCode } from "../../shared/errors";
import type { Identity } from "../../shared/identity";
import {
  newUserGateState,
  runPipeline,
  type GateContext,
  type UserGateState,
} from "../../shared/pipeline";
import { defaultRoomConfig } from "../../shared/room-config";
import { rateLimitGate } from "./gate";

const T0 = 1_700_000_000_000;

function contextAt(now: number, state: UserGateState, privileged = false): GateContext {
  const identity: Identity = {
    userId: state.userId,
    name: state.userId,
    roles: privileged ? ["moderator"] : [],
    expiresAt: 0,
  };
  return {
    now,
    clock: { now: () => now },
    roomId: "room-1",
    shardIndex: 0,
    identity,
    config: defaultRoomConfig("room-1"),
    state,
    privileged,
  };
}

const input = { cid: "c1", body: "hello" };

describe("rateLimitGate", () => {
  it("allows a burst up to capacity and rejects the next message", () => {
    const state = newUserGateState("u1", T0);
    const capacity = defaultRoomConfig("room-1").rateLimit.capacity;

    for (let i = 0; i < capacity; i++) {
      expect(rateLimitGate.check(contextAt(T0, state), input)).toEqual({ kind: "allow" });
    }

    const decision = rateLimitGate.check(contextAt(T0, state), input);
    expect(decision).toMatchObject({
      kind: "reject",
      code: RejectCode.RATE_LIMITED,
      retryAfterMs: 1000,
    });
  });

  it("lets the user through again once a token has accrued", () => {
    const state = newUserGateState("u1", T0);
    const capacity = defaultRoomConfig("room-1").rateLimit.capacity;
    for (let i = 0; i < capacity; i++) rateLimitGate.check(contextAt(T0, state), input);

    expect(rateLimitGate.check(contextAt(T0 + 999, state), input)).toMatchObject({
      kind: "reject",
    });
    expect(rateLimitGate.check(contextAt(T0 + 1_000, state), input)).toEqual({ kind: "allow" });
  });

  it("stays synchronous — the hot path must not allocate a promise", () => {
    const state = newUserGateState("u1", T0);
    expect(rateLimitGate.check(contextAt(T0, state), input)).not.toBeInstanceOf(Promise);
  });

  it("never limits a privileged sender", async () => {
    const state = newUserGateState("mod", T0);
    for (let i = 0; i < 50; i++) {
      const outcome = await runPipeline([rateLimitGate], contextAt(T0, state, true), input);
      expect(outcome.decision.kind).toBe("allow");
    }
    expect(Number.isNaN(state.bucket.tokens)).toBe(true);
  });

  it("keeps one bucket per user", async () => {
    const noisy = newUserGateState("noisy", T0);
    const quiet = newUserGateState("quiet", T0);
    const capacity = defaultRoomConfig("room-1").rateLimit.capacity;

    for (let i = 0; i <= capacity; i++) await runPipeline([rateLimitGate], contextAt(T0, noisy), input);

    const outcome = await runPipeline([rateLimitGate], contextAt(T0, quiet), input);
    expect(outcome.decision.kind).toBe("allow");
  });
});
