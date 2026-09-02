/**
 * A bounded window of the messages this shard has seen fanned out.
 *
 * A reply has to name its parent's author and body, and neither can come from
 * the client: that would let anyone forge "so-and-so said this". Reading the
 * parent from D1 is off the table too — the pipeline is not allowed to do I/O.
 *
 * Every shard receives every accepted message through `fanout`, so each one can
 * keep the same short window in memory and resolve a reply for free.
 *
 * Memory alone was not enough: an evicted isolate loses the window, and a reply
 * a few seconds later would quietly lose its quote. So the first miss rebuilds
 * the window from D1 — one query per isolate, on the reply path only, never on
 * the path a plain message takes.
 */
import { REPLY_EXCERPT_LENGTH, type ChatMessage, type ReplyRef } from "../../shared/protocol";

export const RECENT_MESSAGE_WINDOW = 300;

export class RecentMessages {
  private readonly seen = new Map<string, ReplyRef>();

  constructor(private readonly limit: number = RECENT_MESSAGE_WINDOW) {}

  remember(message: ChatMessage): void {
    if (this.seen.has(message.id)) return;
    this.seen.set(message.id, {
      id: message.id,
      userId: message.userId,
      name: message.name,
      body: message.body.slice(0, REPLY_EXCERPT_LENGTH),
    });
    // Map iterates in insertion order, so the first key is the oldest.
    while (this.seen.size > this.limit) {
      const oldest = this.seen.keys().next();
      if (oldest.done) break;
      this.seen.delete(oldest.value);
    }
  }

  resolve(messageId: string | undefined): ReplyRef | undefined {
    if (!messageId) return undefined;
    return this.seen.get(messageId);
  }

  /** True once `hydrate` has run (or is running) for this instance. */
  get hydrated(): boolean {
    return this.warming !== null;
  }

  private warming: Promise<void> | null = null;

  /**
   * Fills the window from the room's stored history. Concurrent misses share
   * one query, and a failure is swallowed: a missing quote is not worth losing
   * the message over.
   */
  hydrate(load: () => Promise<Iterable<ChatMessage>>): Promise<void> {
    this.warming ??= load()
      .then((messages) => {
        // Oldest first, so the newest survive the window cap.
        for (const message of [...messages].reverse()) this.remember(message);
      })
      .catch(() => undefined);
    return this.warming;
  }

  forget(messageIds: readonly string[]): void {
    for (const id of messageIds) this.seen.delete(id);
  }

  get size(): number {
    return this.seen.size;
  }
}
