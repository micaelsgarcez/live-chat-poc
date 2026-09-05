import { describe, expect, it } from "vitest";
import type { ChatMessage, ServerBatch, ServerEvent, ServerMessage } from "../../shared/protocol";
import { newViewerBudget, planDelivery, spendBudget } from "./delivery";

function chat(id: string, userId = "u1"): ServerEvent {
  const m: ChatMessage = {
    id,
    roomId: "r",
    userId,
    name: userId,
    body: `body ${id}`,
    ts: 1,
  };
  return { t: "msg", m };
}

/**
 * A deterministic shuffle that leaves the order untouched: Fisher-Yates swaps
 * element `i` with `floor(rng() * (i + 1))`, so an rng just under 1 always
 * picks `i` itself. (An rng of 0 would rotate, not preserve.)
 */
const identityRng = () => 0.999999;

function decode(payload: string): ServerMessage {
  return JSON.parse(payload) as ServerMessage;
}

function bodiesOf(payload: string): string[] {
  const frame = decode(payload);
  const events = frame.t === "batch" ? frame.events : [frame as ServerEvent];
  return events.filter((e) => e.t === "msg").map((e) => (e as { m: ChatMessage }).m.id);
}

describe("planDelivery", () => {
  it("keeps a lone event on the wire exactly as it was, with no batch wrapper", () => {
    const plan = planDelivery([chat("a")], {}, identityRng);
    const frame = decode(plan.payloadFor(1));
    expect(frame.t).toBe("msg");
  });

  it("wraps more than one event in a single batch frame", () => {
    const plan = planDelivery([chat("a"), chat("b")], {}, identityRng);
    const frame = decode(plan.payloadFor(2)) as ServerBatch;
    expect(frame.t).toBe("batch");
    expect(frame.events).toHaveLength(2);
    expect(frame.dropped).toBeUndefined();
  });

  it("reports what a budget withheld, so a client can say it is sampled", () => {
    const plan = planDelivery([chat("a"), chat("b"), chat("c")], {}, identityRng);
    const frame = decode(plan.payloadFor(1)) as ServerBatch;
    expect(frame.dropped).toBe(2);
    expect(bodiesOf(plan.payloadFor(1))).toHaveLength(1);
  });

  it("never samples anything that is not a chat message", () => {
    const events: ServerEvent[] = [
      chat("a"),
      { t: "delete", ids: ["x"] },
      chat("b"),
      { t: "presence", count: 7 },
    ];
    const frame = decode(planDelivery(events, {}, identityRng).payloadFor(0)) as ServerBatch;
    expect(frame.events.map((e) => e.t)).toEqual(["delete", "presence"]);
    expect(frame.dropped).toBe(2);
  });

  it("delivers what it kept in the original order, so a delete cannot overtake its message", () => {
    const events: ServerEvent[] = [chat("a"), { t: "delete", ids: ["a"] }, chat("b")];
    const frame = decode(planDelivery(events, {}, identityRng).payloadFor(2)) as ServerBatch;
    expect(frame.events.map((e) => e.t)).toEqual(["msg", "delete", "msg"]);
  });

  it("returns the same string for the same budget, so a shard encodes once per k", () => {
    const plan = planDelivery([chat("a"), chat("b"), chat("c")], {}, identityRng);
    expect(plan.payloadFor(2)).toBe(plan.payloadFor(2));
  });

  it("clamps a budget larger than the batch instead of inventing messages", () => {
    const plan = planDelivery([chat("a")], {}, identityRng);
    expect(bodiesOf(plan.payloadFor(99))).toEqual(["a"]);
  });

  it("gives different viewers different samples, which is what keeps it fair", () => {
    const events = Array.from({ length: 20 }, (_, i) => chat(String(i)));
    const plan = planDelivery(events); // real shuffle
    const first = new Set(bodiesOf(plan.payloadFor(5)));
    // The prefix of a shuffled ranking is, with overwhelming probability, not
    // simply the first five in arrival order.
    expect(first.size).toBe(5);
    expect([...first].sort()).not.toEqual(["0", "1", "2", "3", "4"]);
  });

  it("names the sender's own messages that a budget dropped", () => {
    const events = [chat("a", "alice"), chat("b", "bob"), chat("c", "alice")];
    const plan = planDelivery(events, {}, identityRng);
    const missing = plan.missingOwn("alice", 1).map((e) => e.m.id);
    expect(missing).toEqual(["c"]);
    expect(plan.missingOwn("alice", 3)).toEqual([]);
  });

  it("never samples privileged or room-wide messages", () => {
    const moderator = chat("mod", "moderator");
    if (moderator.t === "msg") moderator.m.roles = ["moderator"];
    const announced = chat("wide", "system");
    if (announced.t === "msg") announced.m.roomWide = true;
    const plan = planDelivery(
      [chat("common"), moderator, announced],
      { privilegedRoles: ["moderator"] },
      identityRng,
    );

    expect(bodiesOf(plan.payloadFor(0))).toEqual(["mod", "wide"]);
    expect((decode(plan.payloadFor(0)) as ServerBatch).dropped).toBe(1);
  });
});

describe("spendBudget", () => {
  it("grants up to the cap and then refuses", () => {
    const budget = newViewerBudget(5, 1_000);
    expect(spendBudget(budget, 5, 3, 1_000)).toBe(3);
    expect(spendBudget(budget, 5, 5, 1_000)).toBe(2);
    expect(spendBudget(budget, 5, 5, 1_000)).toBe(0);
  });

  it("refills at the cap per second", () => {
    const budget = newViewerBudget(10, 1_000);
    expect(spendBudget(budget, 10, 10, 1_000)).toBe(10);
    expect(spendBudget(budget, 10, 10, 1_500)).toBe(5);
  });

  it("never lets an idle viewer bank more than one second of messages", () => {
    const budget = newViewerBudget(10, 0);
    expect(spendBudget(budget, 10, 100, 60_000)).toBe(10);
  });
});
