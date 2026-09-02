/**
 * Shard registry with heartbeats and failure isolation.
 *
 * Fanout costs one subrequest per shard, so calling a shard that is gone (or
 * wedged) is pure waste repeated on every single message. The registry keeps
 * just enough state to answer one question cheaply: which shards are worth
 * calling right now?
 *
 * Pure and storage-free on purpose — the Durable Object owns persistence, this
 * owns the rules, and the rules stay unit-testable without a DO.
 */

export interface ShardRecord {
  index: number;
  /** Last time the shard proved it was alive (register / presence / publish). */
  lastSeenAt: number;
  /** Reset by any successful call; a run of failures is what marks a shard. */
  consecutiveFailures: number;
  /**
   * Suspect shards are skipped by fanout until they register again. A shard
   * that comes back re-registers on its next connection, which is the only
   * signal that proves it can serve calls rather than merely emit them.
   */
  suspect: boolean;
  /** Last presence count reported by the shard. */
  connections: number;
}

/** Consecutive failed calls before a shard stops being called. */
export const MAX_CONSECUTIVE_FAILURES = 3;

/** No signal for this long and the shard is presumed dead. */
export const SHARD_HEARTBEAT_TTL_MS = 60_000;

export class ShardRegistry {
  private readonly records = new Map<number, ShardRecord>();

  constructor(records: readonly ShardRecord[] = []) {
    for (const record of records) this.records.set(record.index, { ...record });
  }

  /**
   * Registration is the one signal that clears suspicion: it means the shard
   * booted (or rebooted) and asked us for config, not just that it is warm.
   */
  register(index: number, now: number): void {
    const existing = this.records.get(index);
    if (existing) {
      existing.lastSeenAt = now;
      existing.consecutiveFailures = 0;
      existing.suspect = false;
      return;
    }
    this.records.set(index, {
      index,
      lastSeenAt: now,
      consecutiveFailures: 0,
      suspect: false,
      connections: 0,
    });
  }

  /** Heartbeat only: keeps a shard from expiring, never clears suspicion. */
  touch(index: number, now: number, connections?: number): boolean {
    const record = this.records.get(index);
    if (!record) return false;
    record.lastSeenAt = now;
    if (connections !== undefined) record.connections = connections;
    return true;
  }

  unregister(index: number): boolean {
    return this.records.delete(index);
  }

  has(index: number): boolean {
    return this.records.has(index);
  }

  markSuccess(index: number): void {
    const record = this.records.get(index);
    if (record) record.consecutiveFailures = 0;
  }

  /** Returns true when this failure is the one that isolates the shard. */
  markFailure(index: number, maxFailures: number = MAX_CONSECUTIVE_FAILURES): boolean {
    const record = this.records.get(index);
    if (!record || record.suspect) return false;
    record.consecutiveFailures++;
    if (record.consecutiveFailures < maxFailures) return false;
    record.suspect = true;
    return true;
  }

  isSuspect(index: number): boolean {
    return this.records.get(index)?.suspect ?? false;
  }

  /** Shards worth spending a subrequest on, in a stable order. */
  deliverable(): number[] {
    const out: number[] = [];
    for (const record of this.records.values()) if (!record.suspect) out.push(record.index);
    return out.sort((a, b) => a - b);
  }

  /** Every registered shard, suspect ones included. */
  all(): number[] {
    return [...this.records.keys()].sort((a, b) => a - b);
  }

  /** Drops shards with no signal since `deadline`; returns what was dropped. */
  expire(deadline: number): number[] {
    const dropped: number[] = [];
    for (const record of [...this.records.values()]) {
      if (record.lastSeenAt <= deadline) {
        this.records.delete(record.index);
        dropped.push(record.index);
      }
    }
    return dropped.sort((a, b) => a - b);
  }

  /** Aggregated presence across every registered shard. */
  connections(): number {
    let total = 0;
    for (const record of this.records.values()) total += record.connections;
    return total;
  }

  get size(): number {
    return this.records.size;
  }

  snapshot(): ShardRecord[] {
    return this.all().map((index) => ({ ...this.records.get(index)! }));
  }
}

/** Tolerates the plain `number[]` shape an older coordinator may have stored. */
export function decodeShardRecords(stored: unknown, now: number): ShardRecord[] {
  if (!Array.isArray(stored)) return [];
  return stored.map((entry) =>
    typeof entry === "number"
      ? { index: entry, lastSeenAt: now, consecutiveFailures: 0, suspect: false, connections: 0 }
      : (entry as ShardRecord),
  );
}
