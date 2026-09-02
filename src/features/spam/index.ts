/**
 * SLICE: spam — inline heuristics (duplicates, burst, links, mentions, caps).
 *
 * OWNER CONTRACT:
 *   spamSlice : Slice (gate, skipForPrivileged)
 *
 * Everything here is decided from `ctx.config.spam` and `ctx.state`: no I/O, no
 * round trip to the coordinator. That is the whole reason spam lives next to
 * the rate limiter inside the shard — the message is already in memory, so an
 * extra check costs a few microseconds of CPU instead of a network hop.
 *
 * The two sliding windows (`recentFingerprints`, `recentSendsAt`) live in shard
 * memory for every connected user, so they are pruned on each send and hard
 * capped: a user who never stops typing must not be able to grow them without
 * bound.
 */
import { RejectCode } from "../../shared/errors";
import { contentFingerprint } from "../../shared/hash";
import {
  allow,
  reject,
  type GateContext,
  type GateDecision,
  type MessageGate,
  type UserGateState,
} from "../../shared/pipeline";
import type { SpamConfig } from "../../shared/room-config";
import type { Slice } from "../../shared/slice";
import { capsRatio, countLinks, countMentions } from "./heuristics";

/**
 * Hard caps on the per-user windows. They only bite when the configured window
 * is long enough to hold more than this many sends; the thresholds themselves
 * are always far below, so trimming the oldest entries cannot hide a burst.
 */
const MAX_TRACKED_SENDS = 64;
const MAX_TRACKED_FINGERPRINTS = 32;

/** Append `now`, drop what fell out of the burst window, return the window size. */
function recordSend(state: UserGateState, now: number, config: SpamConfig): number {
  const cutoff = config.burstWindowMs > 0 ? now - config.burstWindowMs : Number.NEGATIVE_INFINITY;
  const kept = state.recentSendsAt.filter((at) => at > cutoff);
  kept.push(now);
  state.recentSendsAt =
    kept.length > MAX_TRACKED_SENDS ? kept.slice(kept.length - MAX_TRACKED_SENDS) : kept;
  return state.recentSendsAt.length;
}

/**
 * Append this message's fingerprint, drop what fell out of the duplicate window
 * and return how many copies of it the window now holds (the current one
 * included). Rejected sends are recorded too: repeating a blocked message is
 * exactly the behaviour this window exists to catch.
 */
function recordFingerprint(
  state: UserGateState,
  fp: string,
  now: number,
  config: SpamConfig,
): number {
  const cutoff =
    config.duplicateWindowMs > 0 ? now - config.duplicateWindowMs : Number.NEGATIVE_INFINITY;
  const kept = state.recentFingerprints.filter((entry) => entry.at > cutoff);
  kept.push({ fp, at: now });
  state.recentFingerprints =
    kept.length > MAX_TRACKED_FINGERPRINTS
      ? kept.slice(kept.length - MAX_TRACKED_FINGERPRINTS)
      : kept;
  let count = 0;
  for (const entry of state.recentFingerprints) if (entry.fp === fp) count++;
  return count;
}

/** First heuristic the message trips, or null when it looks like normal chat. */
function findViolation(
  body: string,
  config: SpamConfig,
  sendsInWindow: number,
  duplicates: number,
): string | null {
  const burstOn = config.burstWindowMs > 0 && config.burstThreshold >= 0;
  if (burstOn && sendsInWindow > config.burstThreshold) {
    return "sending too fast";
  }
  const duplicatesOn = config.duplicateWindowMs > 0 && config.maxDuplicates >= 0;
  if (duplicatesOn && duplicates > config.maxDuplicates) {
    return "the same message was just sent";
  }
  if (config.maxLinks >= 0 && countLinks(body) > config.maxLinks) {
    return `too many links (max ${config.maxLinks})`;
  }
  if (config.maxMentions >= 0 && countMentions(body) > config.maxMentions) {
    return `too many mentions (max ${config.maxMentions})`;
  }
  // Length floor for caps only: "OK!" in capitals is normal chat, whereas three
  // links in a short message is spam no matter how short the message is.
  if (body.length >= config.minLengthForHeuristics && capsRatio(body) > config.maxCapsRatio) {
    return "too much shouting";
  }
  return null;
}

/**
 * Count the rejection and mute the user once the strikes add up. The mute is
 * enforced by the base guard on the *next* send; this one still gets a normal
 * rejection, carrying the mute as its `retryAfterMs`.
 */
function strike(ctx: GateContext, reason: string): GateDecision {
  const config = ctx.config.spam;
  const state = ctx.state;
  state.strikes++;

  if (config.strikesBeforeMute > 0 && state.strikes >= config.strikesBeforeMute) {
    state.strikes = 0;
    // Never shorten a mute a moderator already set.
    state.mutedUntil = Math.max(state.mutedUntil, ctx.now + config.muteMs);
    return reject(
      RejectCode.SPAM,
      `${reason} — muted for ${Math.round(config.muteMs / 1000)}s`,
      state.mutedUntil - ctx.now,
    );
  }

  return reject(RejectCode.SPAM, reason);
}

export const spamGate: MessageGate = {
  name: "spam",
  skipForPrivileged: true,
  check(ctx, input): GateDecision {
    const config = ctx.config.spam;
    const sendsInWindow = recordSend(ctx.state, ctx.now, config);
    const duplicates = recordFingerprint(
      ctx.state,
      contentFingerprint(input.body),
      ctx.now,
      config,
    );

    const violation = findViolation(input.body, config, sendsInWindow, duplicates);
    return violation === null ? allow() : strike(ctx, violation);
  },
};

export const spamSlice: Slice = { name: "spam", gate: spamGate };
