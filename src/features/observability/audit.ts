/**
 * The audit trail of a shard.
 *
 * Every decision the inbound pipeline takes is interesting exactly once, to
 * whoever happens to be watching, and worthless a minute later — so it is kept
 * in a fixed-size ring in the shard's memory and never written anywhere. That
 * is a deliberate trade: persisting it would put a write on the hot path of the
 * one thing the room does most (rejecting), and `wrangler.jsonc`/`migrations`
 * are frozen contracts anyway. A shard that hibernates loses its ring, and the
 * reader is told so (`dropped`) instead of being shown a silent gap.
 *
 * Sequence numbers are per shard and monotonic, so a reader polls with one
 * cursor per shard and gets a delta rather than the whole window every second.
 */

export type AuditKind =
  /** A gate refused the message; nothing was broadcast or persisted. */
  | "reject"
  /** Accepted for the sender, delivered to nobody. */
  | "shadow"
  | "connect"
  | "disconnect"
  /** A moderator (or the async consumer) acted on this shard. */
  | "mute"
  | "kick"
  | "delete";

export interface AuditEvent {
  seq: number;
  shardIndex: number;
  ts: number;
  kind: AuditKind;
  /** Replaced by a stable pseudonym for readers who are not moderators. */
  userId: string;
  name?: string;
  /** Which gate decided, for `reject` and `shadow`. */
  gate?: string;
  /** `RejectCode` for `reject`. */
  code?: string;
  reason?: string;
  /** How many items the action covered (message ids, sockets closed). */
  count?: number;
}

/** What a caller supplies; the ring owns `seq`, `shardIndex` and the clock. */
export type AuditInput = Omit<AuditEvent, "seq" | "shardIndex" | "ts"> & { ts?: number };

/** Roughly a minute of a busy shard, and a few hundred bytes of isolate memory. */
export const AUDIT_RING_CAPACITY = 250;

export interface AuditSlice {
  events: AuditEvent[];
  /** Highest sequence in this shard; the caller's next `since`. */
  cursor: number;
  /** Events that fell out of the ring before this reader came back. */
  dropped: number;
}

/**
 * A circular buffer rather than an array with `shift()`: under a load test the
 * record path runs thousands of times a second and must not move 250 elements
 * each time.
 */
export class AuditRing {
  private readonly slots: (AuditEvent | undefined)[];
  private head = 0;
  private count = 0;
  private nextSeq = 1;

  constructor(private readonly capacity: number = AUDIT_RING_CAPACITY) {
    this.slots = new Array<AuditEvent | undefined>(Math.max(1, capacity));
  }

  record(shardIndex: number, input: AuditInput): AuditEvent {
    const event: AuditEvent = {
      ...input,
      seq: this.nextSeq++,
      shardIndex,
      ts: input.ts ?? Date.now(),
    };
    const size = this.slots.length;
    this.slots[(this.head + this.count) % size] = event;
    if (this.count < size) this.count++;
    else this.head = (this.head + 1) % size;
    return event;
  }

  /** Everything newer than `since`, oldest first. `since = 0` means "all". */
  since(since: number): AuditSlice {
    const size = this.slots.length;
    const events: AuditEvent[] = [];
    let oldest = 0;
    for (let i = 0; i < this.count; i++) {
      const event = this.slots[(this.head + i) % size];
      if (!event) continue;
      if (i === 0) oldest = event.seq;
      if (event.seq > since) events.push(event);
    }
    // A reader whose cursor is older than the whole ring missed the gap in
    // between; saying how much beats pretending the window is continuous.
    const dropped = since > 0 && oldest > since + 1 ? oldest - since - 1 : 0;
    return { events, cursor: this.nextSeq - 1, dropped };
  }

  get size(): number {
    return this.count;
  }

  get cursor(): number {
    return this.nextSeq - 1;
  }
}

/* ------------------------------------------------------------------ */
/* multi-shard cursor                                                  */
/* ------------------------------------------------------------------ */

/**
 * `"0:120,3:88"` — one sequence per shard, in the query string. Shards are
 * independent writers, so a single global sequence would need a coordinator
 * round trip per event; this keeps the delta exact with no shared counter.
 */
export function encodeAuditCursor(cursors: ReadonlyMap<number, number>): string {
  return [...cursors.entries()]
    .filter(([, seq]) => seq > 0)
    .sort((a, b) => a[0] - b[0])
    .map(([shard, seq]) => `${shard}:${seq}`)
    .join(",");
}

export function decodeAuditCursor(raw: string | null | undefined): Map<number, number> {
  const cursors = new Map<number, number>();
  if (!raw) return cursors;
  for (const part of raw.split(",")) {
    const [shard, seq] = part.split(":");
    const shardIndex = Number.parseInt(shard ?? "", 10);
    const sequence = Number.parseInt(seq ?? "", 10);
    if (!Number.isFinite(shardIndex) || !Number.isFinite(sequence)) continue;
    if (shardIndex < 0 || sequence < 0) continue;
    cursors.set(shardIndex, sequence);
  }
  return cursors;
}

/**
 * Merge what several shards reported into one timeline. Shard clocks are the
 * same Cloudflare clock, so `ts` orders them well enough; `seq` only breaks
 * ties within a shard.
 */
export function mergeAuditEvents(slices: readonly AuditEvent[][]): AuditEvent[] {
  return slices
    .flat()
    .sort((a, b) => a.ts - b.ts || a.shardIndex - b.shardIndex || a.seq - b.seq);
}

/* ------------------------------------------------------------------ */
/* what a shard answers                                                */
/* ------------------------------------------------------------------ */

/**
 * One shard's view of itself. Deliberately a superset of `ShardStats`: the
 * console needs the buffer's *movement*, not just its depth, to tell a healthy
 * flush from a stalled one, and `uptimeMs` is how hibernation becomes visible
 * (it resets every time the isolate is evicted and rebuilt).
 */
export interface ShardObservabilityReport {
  shardIndex: number;
  roomId: string;
  registered: boolean;
  connections: number;
  acceptedCount: number;
  rejectedCount: number;
  bufferedMessages: number;
  configVersion: number;
  /** 0 until this isolate has flushed at least once. */
  lastFlushAt: number;
  lastFlushCount: number;
  /** Since this isolate woke up, not since the shard existed. */
  uptimeMs: number;
  /** Inbound decisions inside `recentWindowMs` — what "now" means for health. */
  recentAccepted: number;
  recentRejected: number;
  recentWindowMs: number;
  audit: AuditSlice;
}
