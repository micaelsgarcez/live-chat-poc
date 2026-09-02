import { describe, expect, it } from "vitest";
import { createLogger } from "../../shared/logger";
import { buildMatcher } from "./matcher";
import { reviewBody, REVIEW_BLOCK_SCORE } from "./review";
import { testConfig } from "./test-support";

const log = createLogger("test", "error");
const config = testConfig("r1");
const matcher = buildMatcher(config.moderation, log);

describe("async review heuristics", () => {
  it("leaves ordinary chatter alone", () => {
    const verdict = reviewBody("nice play, that was a great round", config, matcher);
    expect(verdict.score).toBe(0);
    expect(verdict.blocked).toBe(false);
  });

  it("blocks on the sum of weak signals rather than any single one", () => {
    const verdict = reviewBody(
      "FREE CRYPTO CLICK HERE http://bit.ly/a http://bit.ly/b http://bit.ly/c",
      config,
      matcher,
    );
    expect(verdict.score).toBeGreaterThanOrEqual(REVIEW_BLOCK_SCORE);
    expect(verdict.blocked).toBe(true);
    expect(verdict.reasons.length).toBeGreaterThan(1);
  });

  it("scores a hard-list hit high enough on its own", () => {
    const hard = testConfig("r1", { blockedTerms: ["scamword"] });
    const verdict = reviewBody("scamword", hard, buildMatcher(hard.moderation, log));
    expect(verdict.blocked).toBe(true);
  });

  it("notices repetition and flooding without blocking on them alone", () => {
    const flood = reviewBody("aaaaaaaaaaaa", config, matcher);
    expect(flood.reasons).toContain("character flooding");
    expect(flood.blocked).toBe(false);

    const repeated = reviewBody("buy buy buy buy buy buy", config, matcher);
    expect(repeated.reasons).toContain("repeated words");
  });

  it("uses the room's own spam thresholds", () => {
    const strict = testConfig("r1");
    strict.spam = { ...strict.spam, maxLinks: 0 };
    const verdict = reviewBody("see https://example.com/thing", strict, matcher);
    expect(verdict.reasons.some((r) => r.includes("links"))).toBe(true);
  });
});
