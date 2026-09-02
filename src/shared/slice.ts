/**
 * Vertical slice composition contract.
 *
 * A slice is a self-contained folder under `src/features/<name>/` that owns its
 * HTTP routes, its pipeline gate, its queue consumers, its cron jobs and its
 * tests. `src/features/registry.ts` is the only place that knows all of them.
 */
import type { Env } from "../env";
import type { RouteDef } from "./http";
import type { MessageGate } from "./pipeline";

export interface QueueConsumerDef<T = unknown> {
  /** Must match a queue name in wrangler.jsonc. */
  queue: string;
  handle(batch: MessageBatch<T>, env: Env, ctx: ExecutionContext): Promise<void>;
}

export interface ScheduledJobDef {
  name: string;
  /** Cron expression this job reacts to; "*" runs on every trigger. */
  cron: string;
  run(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void>;
}

export interface Slice {
  name: string;
  routes?: readonly RouteDef[];
  /** Contributed to the shard's inbound pipeline, in registry order. */
  gate?: MessageGate;
  queueConsumers?: readonly QueueConsumerDef<any>[];
  scheduled?: readonly ScheduledJobDef[];
}
