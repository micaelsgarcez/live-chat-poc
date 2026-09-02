/**
 * SLICE: rate-limit — coarse at the edge, fine-grained inside the shard.
 *
 * OWNER CONTRACT:
 *   rateLimitSlice     : Slice (gate = per-user token bucket, skipForPrivileged)
 *   checkEdgeRateLimit : (env, key) => Promise<ConnectGuardResult>
 *
 * STUB — replace with the token bucket + edge limiter.
 */
import type { Env } from "../../env";
import type { Slice } from "../../shared/slice";
import type { ConnectGuardResult } from "../../shared/ports";
import { allow, type MessageGate } from "../../shared/pipeline";

export async function checkEdgeRateLimit(_env: Env, _key: string): Promise<ConnectGuardResult> {
  return { allowed: true };
}

export const rateLimitGate: MessageGate = {
  name: "rate-limit",
  skipForPrivileged: true,
  check: () => allow(),
};

export const rateLimitSlice: Slice = { name: "rate-limit", gate: rateLimitGate };
