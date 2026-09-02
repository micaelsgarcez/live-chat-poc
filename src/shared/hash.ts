/** Deterministic, dependency-free hashing used for shard placement and dedupe. */

export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Stable bucket in [0, buckets) for a key. */
export function bucketOf(key: string, buckets: number): number {
  if (buckets <= 1) return 0;
  return fnv1a32(key) % buckets;
}

/** Cheap content fingerprint used by the spam slice for duplicate detection. */
export function contentFingerprint(body: string): string {
  const normalized = body.toLowerCase().replace(/\s+/g, " ").trim();
  return fnv1a32(normalized).toString(36);
}
