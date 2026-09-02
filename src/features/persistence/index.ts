/**
 * SLICE: persistence — shard-side batching + `chat-persist` consumer writing D1.
 *
 * OWNER CONTRACT:
 *   persistenceSlice    : Slice (`chat-persist` consumer + history routes)
 *   createMessageBuffer : (env, roomId, shardIndex, cfg) => MessageBuffer
 *
 * STUB.
 */
import type { Env } from "../../env";
import type { Slice } from "../../shared/slice";
import type { MessageBuffer } from "../../shared/ports";
import type { PersistenceConfig } from "../../shared/room-config";

export function createMessageBuffer(
  _env: Env,
  _roomId: string,
  _shardIndex: number,
  _config: PersistenceConfig,
): MessageBuffer {
  return {
    add: () => true,
    addReaction: () => true,
    size: () => 0,
    shouldFlush: () => false,
    flush: async () => 0,
  };
}

export const persistenceSlice: Slice = { name: "persistence" };
