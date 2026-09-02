/**
 * The synchronous half of moderation: it runs inside the shard, before the
 * message is handed to the coordinator, so blocked content is never broadcast
 * and never persisted. No I/O — everything it needs is in `ctx.config`.
 */
import { RejectCode } from "../../shared/errors";
import { createLogger } from "../../shared/logger";
import { allow, reject, type MessageGate } from "../../shared/pipeline";
import { getMatcher } from "./matcher";
import { maskSpans } from "./normalize";

// Gates get no `Env`, so the level cannot come from `LOG_LEVEL`; warnings about
// a broken config are worth surfacing regardless.
const log = createLogger("moderation-gate", "warn");

export const moderationGate: MessageGate = {
  name: "moderation-sync",
  // Deliberately not skipped for moderators: a compromised moderator account is
  // exactly the one whose messages nobody else can stop in time.
  skipForPrivileged: false,

  check(ctx, input) {
    const config = ctx.config.moderation;
    if (config.blockedTerms.length === 0 && config.blockedPatterns.length === 0) {
      return allow();
    }

    const spans = getMatcher(ctx.roomId, config, log).scan(input.body);
    if (spans.length === 0) return allow();

    if (config.maskInsteadOfBlock) {
      const masked = maskSpans(input.body, spans);
      return masked === input.body ? allow() : allow(masked);
    }

    // Shared with the spam slice: repeat offenders escalate towards a mute.
    ctx.state.strikes++;
    return reject(RejectCode.BLOCKED_CONTENT, "message contains blocked content");
  },
};
