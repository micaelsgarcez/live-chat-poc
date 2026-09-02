/**
 * SLICE: slow-mode — room-level interval enforced per user inside the shard.
 *
 * OWNER CONTRACT:
 *   slowModeSlice : Slice (gate, skipForPrivileged)
 *
 * The interval is measured from the last message the *whole* pipeline accepted
 * (`state.lastAcceptedAt`), never from the last attempt. A send that another
 * gate rejected must not push the next allowed slot further away, otherwise a
 * user who trips the spam gate would be punished twice for the same message.
 *
 * The state lives in shard memory and the edge hashes a user to a stable shard,
 * so reconnecting does not reset the interval unless the user also moves shard.
 */
import { RejectCode } from "../../shared/errors";
import { allow, reject, type MessageGate } from "../../shared/pipeline";
import type { Slice } from "../../shared/slice";

export const slowModeGate: MessageGate = {
  name: "slow-mode",
  skipForPrivileged: true,
  check(ctx) {
    const intervalMs = ctx.config.slowModeMs;
    if (intervalMs <= 0) return allow();

    // No accepted message yet on this shard: the first one is always free.
    const last = ctx.state.lastAcceptedAt;
    if (last <= 0) return allow();

    const elapsed = ctx.now - last;
    if (elapsed >= intervalMs) return allow();

    // Clamp: a clock that went backwards must not promise a wait longer than
    // the configured interval, and never report "retry in 0ms".
    const retryAfterMs = Math.min(intervalMs, Math.max(1, intervalMs - elapsed));
    return reject(
      RejectCode.SLOW_MODE,
      `slow mode is on: one message every ${Math.round(intervalMs / 1000)}s`,
      retryAfterMs,
    );
  },
};

export const slowModeSlice: Slice = { name: "slow-mode", gate: slowModeGate };
