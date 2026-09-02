/**
 * Presence reporting.
 *
 * A shard only knows how many sockets *it* holds, and that is not the number a
 * viewer wants to see — the room total is. So the shard reports its count to
 * the coordinator, which owns the sum and is the single publisher of the
 * `presence` event. Reporting is throttled: it goes out when the count actually
 * moved, plus a slow heartbeat so the coordinator's copy cannot silently go
 * stale after a shard stops changing.
 */

export interface PresenceSnapshot {
  count: number;
  at: number;
}

export interface PresenceDecision {
  /** Push the count to the coordinator. */
  report: boolean;
}

export function decidePresence(
  count: number,
  last: PresenceSnapshot | null,
  now: number,
  maxSilenceMs: number,
): PresenceDecision {
  if (!last) return { report: true };
  const changed = last.count !== count;
  return { report: changed || now - last.at >= maxSilenceMs };
}
