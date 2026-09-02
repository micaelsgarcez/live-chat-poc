/**
 * Edge Worker: the only public entry point.
 *
 * It owns cheap work only — routing, auth, ban lookups, shard placement — so
 * Durable Object CPU (the expensive part of the bill) is spent on fanout and
 * nothing else.
 */
import type { Env } from "./env";
import { queueConsumers, routes, scheduledJobs } from "./features/registry";
import { CORS_HEADERS, json, problem, Router, withCors } from "./shared/http";
import { createLogger, type LogLevel } from "./shared/logger";

export { RoomCoordinator } from "./realtime/coordinator";
export { ChatShard } from "./realtime/shard";

const router = new Router().addAll(routes);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === "/health") {
      return json({ ok: true, environment: env.ENVIRONMENT, time: Date.now() });
    }

    const log = createLogger("worker", (env.LOG_LEVEL as LogLevel) ?? "info");

    try {
      const handled = await router.handle(request, env, ctx);
      if (handled) {
        // A 101 response carries a WebSocket and must be returned untouched.
        return handled.status === 101 ? handled : withCors(handled);
      }
    } catch (error) {
      log.error("unhandled route error", { path: url.pathname, error: String(error) });
      return withCors(problem(500, "internal", "unexpected error"));
    }

    if (url.pathname.startsWith("/api/")) {
      return withCors(problem(404, "not_found", `no route for ${url.pathname}`));
    }

    return env.ASSETS.fetch(request);
  },

  async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> {
    const log = createLogger("queue", (env.LOG_LEVEL as LogLevel) ?? "info");
    const consumers = queueConsumers.filter((consumer) => consumer.queue === batch.queue);
    if (consumers.length === 0) {
      log.warn("no consumer registered", { queue: batch.queue, size: batch.messages.length });
      batch.ackAll();
      return;
    }
    for (const consumer of consumers) {
      await consumer.handle(batch, env, ctx);
    }
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const log = createLogger("cron", (env.LOG_LEVEL as LogLevel) ?? "info");
    for (const job of scheduledJobs) {
      if (job.cron !== "*" && job.cron !== controller.cron) continue;
      try {
        await job.run(controller, env, ctx);
      } catch (error) {
        log.error("scheduled job failed", { job: job.name, error: String(error) });
      }
    }
  },
} satisfies ExportedHandler<Env>;
