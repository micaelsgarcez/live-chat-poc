/**
 * SLICE: persistence — shard-side batching + `chat-persist` consumer writing D1.
 *
 * OWNER CONTRACT:
 *   persistenceSlice    : Slice (`chat-persist` consumer + history routes)
 *   createMessageBuffer : (env, roomId, shardIndex, cfg) => MessageBuffer
 */
import type { Slice } from "../../shared/slice";
import { persistQueueConsumer } from "./consumer";
import { historyRoutes } from "./history";

export { createMessageBuffer } from "./buffer";

export const persistenceSlice: Slice = {
  name: "persistence",
  routes: historyRoutes,
  queueConsumers: [persistQueueConsumer],
};
