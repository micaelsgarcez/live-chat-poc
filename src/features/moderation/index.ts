/**
 * SLICE: moderation — synchronous wordlist gate + asynchronous queue review.
 *
 * OWNER CONTRACT:
 *   moderationSlice   : Slice (gate + `chat-moderation` consumer + mod routes)
 *   enqueueModeration : (env, jobs: ModerationJob[]) => Promise<void>
 *   moderationGate    : MessageGate
 *
 * Two halves, on purpose. The gate is cheap and runs before the broadcast, so
 * anything it catches is never seen by anyone. The queue consumer is allowed to
 * be expensive because it runs after the fact, and pays for that with a
 * retroactive `delete` event fanned out by the coordinator.
 */
import type { Slice } from "../../shared/slice";
import { moderationGate } from "./gate";
import { moderationConsumer } from "./consumer";
import { moderationRoutes } from "./routes";

export { moderationGate };
export { enqueueModeration } from "./queue";

export const moderationSlice: Slice = {
  name: "moderation",
  gate: moderationGate,
  routes: moderationRoutes,
  queueConsumers: [moderationConsumer],
};
