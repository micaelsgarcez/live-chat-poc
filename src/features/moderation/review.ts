/**
 * The asynchronous half: heuristics that are too expensive for the hot path.
 *
 * The gate answers one question ("does this contain a banned word?") in a few
 * microseconds. Here we are off the socket path and inside a queue consumer, so
 * we can afford to score a message across several weak signals and act on the
 * sum — the shape of spam that no single wordlist entry describes.
 */
import type { RoomConfig } from "../../shared/room-config";
import type { ModerationMatcher } from "./matcher";
import { normalize } from "./normalize";

/** Total score at which a message is removed retroactively. */
export const REVIEW_BLOCK_SCORE = 4;

/**
 * Soft signal lists. `RoomConfig` is a frozen contract and has no field for
 * them, so they are defaults the caller can override per deployment; the hard
 * lists still come from `config.moderation`.
 */
export interface ReviewLists {
  /** Phrases that only add score — never enough on their own. */
  suspiciousTerms: readonly string[];
  /** Link shorteners and the like: opaque destinations in a live chat. */
  suspiciousLinkHosts: readonly string[];
}

export const DEFAULT_REVIEW_LISTS: ReviewLists = {
  suspiciousTerms: [
    "free crypto",
    "free nitro",
    "click here",
    "claim your prize",
    "giveaway winner",
    "verify your wallet",
    "seed phrase",
    "earn money fast",
    "work from home",
    "promo code",
    "dm me",
  ],
  suspiciousLinkHosts: ["bit.ly", "tinyurl.com", "cutt.ly", "is.gd", "t.me", "shorturl.at"],
};

export interface ReviewVerdict {
  score: number;
  reasons: string[];
  blocked: boolean;
}

const LINK = /\b(?:https?:\/\/|www\.)\S+/gi;
const WORD = /[\p{L}\p{N}]+/gu;

export function reviewBody(
  body: string,
  config: RoomConfig,
  matcher: ModerationMatcher,
  lists: ReviewLists = DEFAULT_REVIEW_LISTS,
): ReviewVerdict {
  const reasons: string[] = [];
  let score = 0;
  const add = (points: number, reason: string): void => {
    score += points;
    reasons.push(reason);
  };

  const folded = normalize(body).text;
  const words = body.match(WORD) ?? [];
  const links = body.match(LINK) ?? [];

  // A hard-list hit here means the gate let it through (masking on, or the
  // wordlist grew after the message was accepted) — that alone is enough.
  const hits = matcher.scan(body).length;
  if (hits > 0) add(Math.min(hits, 2) * REVIEW_BLOCK_SCORE, `blocked terms (${hits})`);

  for (const term of lists.suspiciousTerms) {
    if (folded.includes(normalize(term).text)) add(2, `suspicious phrase "${term}"`);
  }

  if (links.length > config.spam.maxLinks) {
    add(2, `${links.length} links`);
  }
  for (const link of links) {
    const host = link.toLowerCase().replace(/^https?:\/\//, "").split("/")[0] ?? "";
    if (lists.suspiciousLinkHosts.some((bad) => host === bad || host.endsWith(`.${bad}`))) {
      add(3, `link shortener ${host}`);
      break;
    }
  }
  // Density matters more than the raw count: two links in three words is an ad,
  // two links in a paragraph is a conversation.
  if (links.length >= 2 && words.length > 0 && links.length / words.length > 0.4) {
    add(1, "link density");
  }

  if (body.length >= config.spam.minLengthForHeuristics) {
    const letters = body.match(/\p{L}/gu) ?? [];
    const upper = body.match(/\p{Lu}/gu) ?? [];
    if (letters.length > 0 && upper.length / letters.length > config.spam.maxCapsRatio) {
      add(2, "shouting");
    }
  }

  if (longestRun(body) >= 8) add(1, "character flooding");

  if (words.length >= 5) {
    const unique = new Set(words.map((w) => w.toLowerCase())).size;
    if (unique / words.length < 0.4) add(2, "repeated words");
  }

  const mentions = (body.match(/@\S+/g) ?? []).length;
  if (mentions > config.spam.maxMentions) add(2, `${mentions} mentions`);

  if (body.length > config.maxMessageLength * 0.8) add(1, "wall of text");

  return { score, reasons, blocked: score >= REVIEW_BLOCK_SCORE };
}

function longestRun(body: string): number {
  let best = 0;
  let run = 0;
  let previous = "";
  for (const char of body) {
    run = char === previous ? run + 1 : 1;
    previous = char;
    if (run > best) best = run;
  }
  return best;
}
