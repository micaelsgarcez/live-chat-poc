/**
 * SLICE: persistence — shard-side batching + `chat-persist` consumer writing D1.
 *
 * OWNER CONTRACT:
 *   persistenceSlice    : Slice (`chat-persist` consumer + history routes)
 *   createMessageBuffer : (env, roomId, shardIndex, cfg) => MessageBuffer
 *   listRoomMessages    : (env, roomId, limit, cursor) => Promise<HistoryPage>
 */
import type { Slice } from "../../shared/slice";
import { persistQueueConsumer } from "./consumer";
import { historyRoutes } from "./history";

export { createMessageBuffer } from "./buffer";
export { listRoomMessages, type HistoryPage } from "./history";

export const persistenceSlice: Slice = {
  name: "persistence",
  routes: historyRoutes,
  queueConsumers: [persistQueueConsumer],
};
