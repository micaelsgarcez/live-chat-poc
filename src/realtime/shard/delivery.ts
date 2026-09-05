/**
 * How one fanout becomes the bytes each socket receives.
 *
 * A room with 300k viewers cannot deliver every message to everyone: 1.000
 * msg/s times 300k sockets is 300 million frames a second, and nobody reads
 * 1.000 messages a second anyway. Above `fanout.maxPerViewerPerSecond` the
 * shard samples — but sampling naively would cost one `JSON.stringify` per
 * socket, which is exactly the per-connection cost the whole design exists to
 * avoid.
 *
 * So the plan is built once per fanout and shared:
 *
 *   - every chat event gets a **priority rank**, shuffled per fanout;
 *   - a socket with budget `k` keeps the `k` best-ranked chat events;
 *   - the frame lists what it kept **in the original order**, so a delete never
 *     overtakes the message it deletes;
 *   - `payloadFor(k)` is therefore a pure function of `k`, memoised, so the
 *     shard encodes at most `chat.length + 1` strings no matter how many
 *     sockets it holds.
 *
 * Re-shuffling every fanout is what keeps it fair: no message is systematically
 * the one that gets dropped, and no two viewers see quite the same stream —
 * which is what a sampled chat looks like everywhere it is done well.
 */
import { encode, type ServerBatch, type ServerChat, type ServerEvent } from "../../shared/protocol";

/** A socket's delivery allowance. Refills continuously, bursts up to one second. */
export interface ViewerBudget {
  tokens: number;
  updatedAt: number;
}

export function newViewerBudget(cap: number, now: number): ViewerBudget {
  return { tokens: cap, updatedAt: now };
}

/**
 * Spends up to `want` tokens and returns how many were granted. `cap` doubles
 * as the refill rate (per second) and the burst ceiling, so a viewer that has
 * been quiet for a second can receive a full second's worth at once and no more.
 */
export function spendBudget(
  budget: ViewerBudget,
  cap: number,
  want: number,
  now: number,
): number {
  const elapsed = Math.max(0, now - budget.updatedAt);
  budget.tokens = Math.min(cap, budget.tokens + (elapsed * cap) / 1000);
  budget.updatedAt = now;
  const granted = Math.min(want, Math.floor(budget.tokens));
  budget.tokens -= granted;
  return granted;
}

export interface DeliveryPlan {
  /** Chat events in this fanout; the only kind that is ever sampled. */
  readonly chatCount: number;
  /** True when every socket receives everything, i.e. no budget can bite. */
  readonly uniform: boolean;
  /**
   * Who wrote the chat events in this window.
   *
   * Lets the shard skip the "did this socket get sampled out of its own
   * message" question for the overwhelming majority of sockets, which wrote
   * nothing. In a room of thousands, a 100 ms window has a handful of authors —
   * asking per socket is work proportional to the room instead of to the window.
   */
  readonly authors: ReadonlySet<string>;
  /** Encoded frame for a socket allowed `k` of the chat events. */
  payloadFor(k: number): string;
  /** Chat events authored by `userId` that a budget of `k` would have dropped. */
  missingOwn(userId: string, k: number): ServerChat[];
}

function isChat(event: ServerEvent): event is ServerChat {
  return event.t === "msg";
}

/**
 * `rng` is injectable so a test can pin the shuffle; production passes
 * `Math.random`, and the shuffle only has to be unbiased, not unguessable.
 */
export function planDelivery(
  events: ServerEvent[],
  options: { privilegedRoles?: readonly string[] } = {},
  rng: () => number = Math.random,
): DeliveryPlan {
  const privilegedRoles = new Set(options.privilegedRoles ?? []);
  const chatIndices: number[] = [];
  const protectedIndices = new Set<number>();
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (!isChat(event)) continue;
    if (event.m.roomWide || event.m.roles?.some((role) => privilegedRoles.has(role))) {
      protectedIndices.add(i);
    } else {
      chatIndices.push(i);
    }
  }
  const chatCount = chatIndices.length;

  // rank[position in chatIndices] -> priority, 0 being the first to survive.
  const order = chatIndices.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const rank = new Array<number>(chatCount);
  for (let priority = 0; priority < order.length; priority++) {
    rank[order[priority]!] = priority;
  }

  const memo = new Array<string | undefined>(chatCount + 1);
  const authors = new Set<string>();
  for (const index of chatIndices) authors.add((events[index] as ServerChat).m.userId);

  return {
    chatCount,
    uniform: chatCount === 0,
    authors,

    payloadFor(k: number): string {
      const budget = Math.max(0, Math.min(chatCount, k));
      const cached = memo[budget];
      if (cached !== undefined) return cached;

      const kept: ServerEvent[] = [];
      let seen = 0;
      for (let index = 0; index < events.length; index++) {
        const event = events[index]!;
        if (isChat(event)) {
          if (protectedIndices.has(index)) kept.push(event);
          else {
            if (rank[seen]! < budget) kept.push(event);
            seen++;
          }
        } else {
          kept.push(event);
        }
      }
      const dropped = chatCount - budget;

      // One event and nothing withheld is the overwhelmingly common case — a
      // single message in an unbatched room — and it stays on the wire exactly
      // as it always has, so an older client never meets a frame it cannot read.
      let payload: string;
      if (kept.length === 1 && dropped === 0) {
        payload = encode(kept[0]!);
      } else {
        const batch: ServerBatch = { t: "batch", events: kept };
        if (dropped > 0) batch.dropped = dropped;
        payload = encode(batch);
      }
      memo[budget] = payload;
      return payload;
    },

    missingOwn(userId: string, k: number): ServerChat[] {
      const budget = Math.max(0, Math.min(chatCount, k));
      if (budget >= chatCount) return [];
      const missing: ServerChat[] = [];
      let seen = 0;
      for (let index = 0; index < events.length; index++) {
        const event = events[index]!;
        if (!isChat(event)) continue;
        if (protectedIndices.has(index)) continue;
        if (rank[seen]! >= budget && event.m.userId === userId) missing.push(event);
        seen++;
      }
      return missing;
    },
  };
}
