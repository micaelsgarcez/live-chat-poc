/**
 * Worker bindings.
 *
 * Type-only imports of the Durable Object classes give us end-to-end RPC types
 * (`env.CHAT_SHARD.get(id).fanout(...)`) without creating a runtime cycle.
 */
import type { RoomCoordinator } from "./realtime/coordinator";
import type { ChatShard } from "./realtime/shard";
import type { ModerationJob, PersistBatch } from "./shared/ports";

/**
 * Cloudflare's native Rate Limiting binding. Declared structurally because it
 * is only wired up in staging/production — locally the rate-limit slice falls
 * back to its own KV-backed counter.
 */
export interface RateLimiterBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  /* --- static assets (demo client) --- */
  ASSETS: Fetcher;

  /* --- durable objects --- */
  ROOM_COORDINATOR: DurableObjectNamespace<RoomCoordinator>;
  CHAT_SHARD: DurableObjectNamespace<ChatShard>;

  /* --- storage --- */
  CHAT_KV: KVNamespace;
  CHAT_DB: D1Database;

  /* --- queues --- */
  PERSIST_QUEUE: Queue<PersistBatch>;
  MODERATION_QUEUE: Queue<ModerationJob>;

  /* --- optional bindings --- */
  EDGE_RATE_LIMITER?: RateLimiterBinding;

  /* --- vars (wrangler.jsonc) --- */
  ENVIRONMENT: string;
  JWT_ISSUER: string;
  JWT_AUDIENCE: string;
  JWT_ALG: string;
  JWKS_URL: string;
  DEFAULT_SHARD_COUNT: string;
  MAX_SOCKETS_PER_SHARD: string;
  LOG_LEVEL: string;

  /* --- secrets (.dev.vars locally, `wrangler secret put` in prod) --- */
  JWT_HS256_SECRET?: string;
  MODERATOR_API_KEY?: string;
}

export function intVar(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
