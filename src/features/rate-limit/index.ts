/**
 * SLICE: rate-limit — coarse at the edge, fine-grained inside the shard.
 *
 * OWNER CONTRACT:
 *   rateLimitSlice     : Slice (gate = per-user token bucket, skipForPrivileged)
 *   checkEdgeRateLimit : (env, key) => Promise<ConnectGuardResult>
 *
 * Two limits with two different jobs: the edge one stops a connect flood before
 * it reaches a Durable Object, the token bucket bounds what an accepted socket
 * may then send. Internals (`token-bucket.ts`, `edge-limiter.ts`) stay private
 * to the slice; only the three names above are imported from outside.
 */
import type { Slice } from "../../shared/slice";
import { rateLimitGate } from "./gate";

export { checkEdgeRateLimit } from "./edge-limiter";
export { rateLimitGate };

export const rateLimitSlice: Slice = { name: "rate-limit", gate: rateLimitGate };
