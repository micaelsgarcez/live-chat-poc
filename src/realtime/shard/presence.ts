/**
 * Presence throttling.
 *
 * A shard that fans the same number out to every socket on every alarm tick is
 * paying for nothing: the clients already show it. The count therefore only
 * reaches the sockets when it actually moved, while the coordinator is also
 * refreshed on a slow heartbeat so its room total cannot silently go stale
 * after a shard stops changing.
 */

export interface PresenceSnapshot {
  count: number;
  at: number;
}

export interface PresenceDecision {
  /** Push the count to the coordinator. */
  report: boolean;
  /** Fan a `presence` event out to this shard's sockets. */
  fanout: boolean;
}

export function decidePresence(
  count: number,
  last: PresenceSnapshot | null,
  now: number,
  maxSilenceMs: number,
): PresenceDecision {
  if (!last) return { report: true, fanout: true };
  const changed = last.count !== count;
  return { report: changed || now - last.at >= maxSilenceMs, fanout: changed };
}
