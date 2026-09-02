/**
 * The always-on structural gate: it runs before every slice rule and rejects
 * things no downstream gate should have to think about.
 */
import { RejectCode } from "../../shared/errors";
import { allow, reject, type MessageGate } from "../../shared/pipeline";

export const baseGuardGate: MessageGate = {
  name: "base-guard",
  check(ctx, input) {
    if (ctx.config.closed && !ctx.privileged) {
      return reject(RejectCode.ROOM_CLOSED, "the room is closed");
    }
    if (ctx.state.mutedUntil > ctx.now) {
      return reject(
        RejectCode.MUTED,
        "you are temporarily muted",
        ctx.state.mutedUntil - ctx.now,
      );
    }
    const body = input.body.trim();
    if (body.length === 0) return reject(RejectCode.EMPTY, "message is empty");
    if (body.length > ctx.config.maxMessageLength) {
      return reject(
        RejectCode.TOO_LONG,
        `message exceeds ${ctx.config.maxMessageLength} characters`,
      );
    }
    return allow(body);
  },
};
