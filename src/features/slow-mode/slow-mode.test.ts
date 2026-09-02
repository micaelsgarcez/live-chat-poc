import { describe, expect, it } from "vitest";
import { RejectCode } from "../../shared/errors";
import {
  newUserGateState,
  runPipeline,
  type GateContext,
  type GateDecision,
  type UserGateState,
} from "../../shared/pipeline";
import { defaultRoomConfig, type RoomConfig } from "../../shared/room-config";
import { fixedClock } from "../../shared/time";
import { slowModeGate } from "./index";

const T0 = 1_700_000_000_000;

function configWith(slowModeMs: number): RoomConfig {
  return { ...defaultRoomConfig("slow-room"), slowModeMs };
}

function ctxAt(
  now: number,
  state: UserGateState,
  config: RoomConfig,
  privileged = false,
): GateContext {
  return {
    now,
    clock: fixedClock(now),
    roomId: config.roomId,
    shardIndex: 0,
    identity: {
      userId: state.userId,
      name: state.userId,
      roles: privileged ? ["moderator"] : [],
      expiresAt: 0,
    },
    config,
    state,
    privileged,
  };
}

function check(ctx: GateContext, body = "hello"): Promise<GateDecision> {
  return Promise.resolve(slowModeGate.check(ctx, { cid: "c1", body }));
}

describe("slow-mode gate", () => {
  it("is off when slowModeMs is 0", async () => {
    const state = newUserGateState("u", T0);
    state.lastAcceptedAt = T0;
    const decision = await check(ctxAt(T0 + 1, state, configWith(0)));
    expect(decision.kind).toBe("allow");
  });

  it("always allows the first message of a connection", async () => {
    const state = newUserGateState("u", T0);
    const decision = await check(ctxAt(T0, state, configWith(5_000)));
    expect(decision.kind).toBe("allow");
  });

  it("rejects inside the interval with the exact remaining wait", async () => {
    const state = newUserGateState("u", T0);
    state.lastAcceptedAt = T0;
    const decision = await check(ctxAt(T0 + 1_500, state, configWith(5_000)));
    expect(decision).toMatchObject({
      kind: "reject",
      code: RejectCode.SLOW_MODE,
      retryAfterMs: 3_500,
    });
  });

  it("allows again once the interval has elapsed exactly", async () => {
    const state = newUserGateState("u", T0);
    state.lastAcceptedAt = T0;
    expect((await check(ctxAt(T0 + 4_999, state, configWith(5_000)))).kind).toBe("reject");
    expect((await check(ctxAt(T0 + 5_000, state, configWith(5_000)))).kind).toBe("allow");
  });

  it("measures from the last accepted send, not the last rejected one", async () => {
    const config = configWith(5_000);
    const state = newUserGateState("u", T0);
    state.lastAcceptedAt = T0;

    // A send at T0+1000 is rejected; the shard still records it as "seen".
    const rejected = await check(ctxAt(T0 + 1_000, state, config));
    expect(rejected.kind).toBe("reject");
    state.lastSeenAt = T0 + 1_000;

    // The rejected attempt must not have pushed the next slot to T0+6000.
    const decision = await check(ctxAt(T0 + 5_000, state, config));
    expect(decision.kind).toBe("allow");
  });

  it("never fires for a privileged sender", async () => {
    const config = configWith(60_000);
    const state = newUserGateState("mod", T0);
    state.lastAcceptedAt = T0;
    const outcome = await runPipeline([slowModeGate], ctxAt(T0 + 1, state, config, true), {
      cid: "c1",
      body: "hello",
    });
    expect(outcome.decision.kind).toBe("allow");
  });

  it("clamps the wait to the interval when the clock goes backwards", async () => {
    const state = newUserGateState("u", T0);
    state.lastAcceptedAt = T0 + 10_000;
    const decision = await check(ctxAt(T0, state, configWith(5_000)));
    expect(decision).toMatchObject({ kind: "reject", retryAfterMs: 5_000 });
  });
});
