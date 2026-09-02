/** Stable, client-visible rejection codes. Never renumber; only append. */
export const RejectCode = {
  UNAUTHENTICATED: "unauthenticated",
  FORBIDDEN: "forbidden",
  BANNED: "banned",
  MUTED: "muted",
  ROOM_CLOSED: "room_closed",
  ROOM_FULL: "room_full",
  RATE_LIMITED: "rate_limited",
  SLOW_MODE: "slow_mode",
  SPAM: "spam",
  BLOCKED_CONTENT: "blocked_content",
  TOO_LONG: "too_long",
  EMPTY: "empty",
  MALFORMED: "malformed",
  INTERNAL: "internal",
} as const;

export type RejectCode = (typeof RejectCode)[keyof typeof RejectCode];

export class AppError extends Error {
  constructor(
    readonly code: RejectCode,
    message: string,
    readonly status = 400,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "AppError";
  }
}
