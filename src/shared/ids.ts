/**
 * Identifier helpers shared by every slice.
 *
 * Message ids are lexicographically sortable so that a shard can order its
 * in-memory buffer without carrying a separate sort key.
 */

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Monotonic-ish, sortable id: <base36 timestamp><random suffix>. */
export function newMessageId(now: number = Date.now()): string {
  const ts = now.toString(36).padStart(9, "0");
  return `${ts}${randomSuffix(10)}`;
}

export function newConnectionId(): string {
  return randomSuffix(20);
}

export function randomSuffix(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return out;
}

/** Timestamp encoded in a message id, in ms. */
export function messageIdTimestamp(id: string): number {
  return Number.parseInt(id.slice(0, 9), 36);
}

/** Durable Object name for a room coordinator. */
export function coordinatorName(roomId: string): string {
  return `room:${roomId}`;
}

/** Durable Object name for one shard of a room. */
export function shardName(roomId: string, shardIndex: number): string {
  return `room:${roomId}:shard:${shardIndex}`;
}
