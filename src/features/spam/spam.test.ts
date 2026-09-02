import { describe, expect, it } from "vitest";
import { RejectCode } from "../../shared/errors";
import {
  newUserGateState,
  runPipeline,
  type GateContext,
  type GateDecision,
  type UserGateState,
} from "../../shared/pipeline";
import {
  defaultRoomConfig,
  type RoomConfig,
  type SpamConfig,
} from "../../shared/room-config";
import { fixedClock } from "../../shared/time";
import { spamGate } from "./index";

const T0 = 1_700_000_000_000;

function configWith(spam: Partial<SpamConfig> = {}): RoomConfig {
  const base = defaultRoomConfig("spam-room");
  return { ...base, spam: { ...base.spam, ...spam } };
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

/** One inbound send through the gate alone. */
function send(
  state: UserGateState,
  config: RoomConfig,
  now: number,
  body: string,
): Promise<GateDecision> {
  return Promise.resolve(spamGate.check(ctxAt(now, state, config), { cid: "c", body }));
}

describe("spam gate — normal traffic", () => {
  it("never rejects ordinary chat", async () => {
    const config = configWith();
    const state = newUserGateState("u", T0);
    const bodies = [
      "hello everyone",
      "how is it going?",
      "that goal was unreal",
      "OK!",
      "haha :D",
      "I think the second half will be better",
      "who is playing next week?",
      "see you tomorrow @friend",
    ];
    for (const [i, body] of bodies.entries()) {
      const decision = await send(state, config, T0 + i * 2_000, body);
      expect(decision, body).toMatchObject({ kind: "allow" });
    }
    expect(state.strikes).toBe(0);
    expect(state.mutedUntil).toBe(0);
  });
});

describe("spam gate — duplicates", () => {
  it("allows up to maxDuplicates copies and rejects the next one", async () => {
    const config = configWith();
    const state = newUserGateState("u", T0);
    for (let i = 0; i < config.spam.maxDuplicates; i++) {
      expect(await send(state, config, T0 + i * 100, "buy my thing")).toMatchObject({
        kind: "allow",
      });
    }
    expect(await send(state, config, T0 + 400, "buy my thing")).toMatchObject({
      kind: "reject",
      code: RejectCode.SPAM,
    });
  });

  it("normalises case and whitespace before comparing", async () => {
    const config = configWith({ maxDuplicates: 1 });
    const state = newUserGateState("u", T0);
    expect(await send(state, config, T0, "Same Thing")).toMatchObject({ kind: "allow" });
    expect(await send(state, config, T0 + 10, "  same   thing ")).toMatchObject({
      kind: "reject",
      code: RejectCode.SPAM,
    });
  });

  it("forgets copies that fell out of the duplicate window", async () => {
    const config = configWith({ maxDuplicates: 1, duplicateWindowMs: 1_000 });
    const state = newUserGateState("u", T0);
    expect(await send(state, config, T0, "again")).toMatchObject({ kind: "allow" });
    expect(await send(state, config, T0 + 1_001, "again")).toMatchObject({ kind: "allow" });
    expect(state.recentFingerprints).toHaveLength(1);
  });
});

describe("spam gate — burst", () => {
  it("rejects once more than burstThreshold sends land in the window", async () => {
    const config = configWith();
    const state = newUserGateState("u", T0);
    for (let i = 0; i < config.spam.burstThreshold; i++) {
      expect(await send(state, config, T0 + i, `message ${i}`)).toMatchObject({ kind: "allow" });
    }
    expect(await send(state, config, T0 + 100, "one too many")).toMatchObject({
      kind: "reject",
      code: RejectCode.SPAM,
    });
  });

  it("accepts the same volume spread over a longer period", async () => {
    const config = configWith();
    const state = newUserGateState("u", T0);
    for (let i = 0; i < 20; i++) {
      expect(await send(state, config, T0 + i * 1_000, `message ${i}`)).toMatchObject({
        kind: "allow",
      });
    }
  });
});

describe("spam gate — links, mentions and caps", () => {
  it("rejects more links than maxLinks and allows the limit", async () => {
    const config = configWith();
    const state = newUserGateState("u", T0);
    expect(await send(state, config, T0, "look at https://a.example and www.b.io")).toMatchObject({
      kind: "allow",
    });
    expect(
      await send(state, config, T0 + 10, "https://a.example www.b.io and c.com too"),
    ).toMatchObject({ kind: "reject", code: RejectCode.SPAM });
  });

  it("counts a single url once, scheme and host together", async () => {
    const config = configWith({ maxLinks: 1 });
    const state = newUserGateState("u", T0);
    expect(await send(state, config, T0, "join https://example.com/room now")).toMatchObject({
      kind: "allow",
    });
  });

  it("does not read ordinary sentence punctuation as a link", async () => {
    const config = configWith({ maxLinks: 0 });
    const state = newUserGateState("u", T0);
    expect(await send(state, config, T0, "wait.what just happened there")).toMatchObject({
      kind: "allow",
    });
  });

  it("rejects more mentions than maxMentions and allows the limit", async () => {
    const config = configWith();
    const state = newUserGateState("u", T0);
    expect(await send(state, config, T0, "@a @b @c @d @e are you there")).toMatchObject({
      kind: "allow",
    });
    expect(await send(state, config, T0 + 10, "@a @b @c @d @e @f look here")).toMatchObject({
      kind: "reject",
      code: RejectCode.SPAM,
    });
  });

  it("rejects shouting only once the message is long enough", async () => {
    const config = configWith();
    const state = newUserGateState("u", T0);
    expect(await send(state, config, T0, "STOP IT")).toMatchObject({ kind: "allow" });
    expect(await send(state, config, T0 + 10, "EVERYONE STOP DOING THAT")).toMatchObject({
      kind: "reject",
      code: RejectCode.SPAM,
    });
  });

  it("ignores characters that have no case when measuring caps", async () => {
    const config = configWith();
    const state = newUserGateState("u", T0);
    expect(await send(state, config, T0, "score is 3-1 !!! 12345 67890")).toMatchObject({
      kind: "allow",
    });
  });
});

describe("spam gate — strikes", () => {
  it("mutes after strikesBeforeMute rejections and resets the counter", async () => {
    const config = configWith();
    const state = newUserGateState("u", T0);
    const spammy = (i: number) => `a.com b.com c.com deal ${i}`;

    for (let i = 0; i < config.spam.strikesBeforeMute - 1; i++) {
      const decision = await send(state, config, T0 + i, spammy(i));
      expect(decision).toMatchObject({ kind: "reject", code: RejectCode.SPAM });
      expect(state.strikes).toBe(i + 1);
      expect(state.mutedUntil).toBe(0);
    }

    const last = T0 + config.spam.strikesBeforeMute;
    const decision = await send(state, config, last, spammy(99));
    expect(decision).toMatchObject({
      kind: "reject",
      code: RejectCode.SPAM,
      retryAfterMs: config.spam.muteMs,
    });
    expect(state.mutedUntil).toBe(last + config.spam.muteMs);
    expect(state.strikes).toBe(0);
  });

  it("never shortens a mute that is already longer", async () => {
    const config = configWith({ strikesBeforeMute: 1, muteMs: 1_000 });
    const state = newUserGateState("u", T0);
    state.mutedUntil = T0 + 600_000;
    await send(state, config, T0, "a.com b.com c.com");
    expect(state.mutedUntil).toBe(T0 + 600_000);
  });
});

describe("spam gate — window hygiene", () => {
  it("prunes the send window down to the configured burst window", async () => {
    const config = configWith();
    const state = newUserGateState("u", T0);
    for (let i = 0; i < 5; i++) await send(state, config, T0 + i * 100, `m${i}`);
    expect(state.recentSendsAt).toHaveLength(5);

    await send(state, config, T0 + config.spam.burstWindowMs + 1_000, "much later");
    expect(state.recentSendsAt).toEqual([T0 + config.spam.burstWindowMs + 1_000]);
  });

  it("caps both windows even when the configured windows are huge", async () => {
    const config = configWith({
      burstWindowMs: 60 * 60_000,
      burstThreshold: 100_000,
      duplicateWindowMs: 60 * 60_000,
      maxDuplicates: 100_000,
    });
    const state = newUserGateState("u", T0);
    for (let i = 0; i < 300; i++) await send(state, config, T0 + i, `message ${i}`);
    expect(state.recentSendsAt.length).toBeLessThanOrEqual(64);
    expect(state.recentFingerprints.length).toBeLessThanOrEqual(32);
  });

  it("counts rejected sends too, so repeating a blocked message keeps failing", async () => {
    const config = configWith({ maxDuplicates: 1, maxLinks: 0 });
    const state = newUserGateState("u", T0);
    expect(await send(state, config, T0, "visit a.com")).toMatchObject({ kind: "reject" });
    const repeat = await send(state, config, T0 + 10, "visit a.com");
    expect(repeat).toMatchObject({ kind: "reject", code: RejectCode.SPAM });
    expect(state.strikes).toBe(2);
  });
});

describe("spam gate — privileged senders", () => {
  it("is skipped entirely for a moderator", async () => {
    const config = configWith();
    const state = newUserGateState("mod", T0);
    for (let i = 0; i < 30; i++) {
      const outcome = await runPipeline([spamGate], ctxAt(T0 + i, state, config, true), {
        cid: "c",
        body: "SPAM SPAM a.com b.com c.com @a @b @c @d @e @f",
      });
      expect(outcome.decision.kind).toBe("allow");
    }
    expect(state.recentSendsAt).toHaveLength(0);
    expect(state.strikes).toBe(0);
  });
});
