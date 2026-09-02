/**
 * The fine-grained half of the slice: one token bucket per user, in shard
 * memory. It sits second in the pipeline, right after the structural guard, so
 * a flooder is dropped before any content heuristic pays for them.
 */
import { RejectCode } from "../../shared/errors";
import { allow, reject, type MessageGate } from "../../shared/pipeline";
import { tryConsume } from "./token-bucket";

export const rateLimitGate: MessageGate = {
  name: "rate-limit",
  skipForPrivileged: true,
  // Deliberately synchronous: this runs for every inbound frame of every socket
  // on the shard, and an unnecessary promise per message is not free at 300k.
  check(ctx) {
    const result = tryConsume(ctx.state.bucket, ctx.config.rateLimit, ctx.now);
    if (result.ok) return allow();
    return reject(
      RejectCode.RATE_LIMITED,
      "you are sending messages too quickly",
      result.retryAfterMs,
    );
  },
};
