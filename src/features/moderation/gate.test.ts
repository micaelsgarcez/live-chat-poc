import { describe, expect, it, beforeEach } from "vitest";
import { RejectCode } from "../../shared/errors";
import type { GateDecision } from "../../shared/pipeline";
import { moderationGate } from "./gate";
import { resetMatcherCache } from "./matcher";
import { MASK } from "./normalize";
import { testConfig, testContext } from "./test-support";

/** Also asserts the gate stays synchronous: no I/O is allowed on the hot path. */
function check(
  config: ReturnType<typeof testConfig>,
  body: string,
  roles: string[] = [],
): GateDecision {
  const decision = moderationGate.check(testContext(config, roles), { cid: "c1", body });
  if (decision instanceof Promise) throw new Error("the moderation gate must not be async");
  return decision;
}

describe("moderation gate", () => {
  beforeEach(() => resetMatcherCache());

  it("allows everything when no list is configured", () => {
    expect(check(testConfig("r1"), "anything at all")).toEqual({ kind: "allow" });
  });

  it("blocks a literal term", () => {
    const decision = check(testConfig("r1", { blockedTerms: ["badword"] }), "this is a badword");
    expect(decision).toMatchObject({ kind: "reject", code: RejectCode.BLOCKED_CONTENT });
  });

  it("blocks obfuscated spellings of a literal term", () => {
    const config = testConfig("r1", { blockedTerms: ["badword"] });
    for (const body of ["B4DW0RD", "baddword", "bâdword", "baaadwooord", "b4dw0rd!!!"]) {
      expect(check(config, body).kind, body).toBe("reject");
    }
  });

  it("does not block an unrelated message", () => {
    const config = testConfig("r1", { blockedTerms: ["badword"] });
    expect(check(config, "a perfectly good word").kind).toBe("allow");
  });

  it("masks instead of blocking when configured", () => {
    const config = testConfig("r1", { blockedTerms: ["badword"], maskInsteadOfBlock: true });
    expect(check(config, "say b4dword loudly")).toEqual({ kind: "allow", body: `say ${MASK} loudly` });
  });

  it("applies configured regex patterns", () => {
    const config = testConfig("r1", { blockedPatterns: ["\\bwin \\d+ bitcoin\\b"] });
    expect(check(config, "win 5 bitcoin now").kind).toBe("reject");
    expect(check(config, "bitcoin is a topic").kind).toBe("allow");
  });

  it("ignores an invalid pattern instead of throwing", () => {
    const config = testConfig("r1", { blockedPatterns: ["([unclosed", "\\bscam\\b"] });
    expect(() => check(config, "hello")).not.toThrow();
    expect(check(config, "hello").kind).toBe("allow");
    // The valid sibling pattern still applies.
    expect(check(config, "what a scam").kind).toBe("reject");
  });

  it("scans privileged senders too", () => {
    const config = testConfig("r1", { blockedTerms: ["badword"] });
    expect(moderationGate.skipForPrivileged).toBe(false);
    expect(check(config, "badword", ["moderator"]).kind).toBe("reject");
  });

  it("recompiles only when the wordlist version changes", () => {
    const first = testConfig("cache-room", { blockedTerms: ["alpha"] });
    expect(check(first, "alpha").kind).toBe("reject");

    // Same version, different terms: the memoised matcher is intentionally kept.
    const stale = testConfig("cache-room", { blockedTerms: ["beta"] });
    expect(check(stale, "beta").kind).toBe("allow");

    const bumped = testConfig("cache-room", { blockedTerms: ["beta"], wordlistVersion: 2 });
    expect(check(bumped, "beta").kind).toBe("reject");
  });

  it("counts a block as a strike so repeat offenders escalate", () => {
    const config = testConfig("r1", { blockedTerms: ["badword"] });
    const ctx = testContext(config);
    moderationGate.check(ctx, { cid: "c1", body: "badword" });
    moderationGate.check(ctx, { cid: "c2", body: "badword" });
    expect(ctx.state.strikes).toBe(2);
  });
});
