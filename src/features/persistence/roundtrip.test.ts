import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../env";
import type { PersistBatch } from "../../shared/ports";
import type { ChatMessage } from "../../shared/protocol";
import { defaultRoomConfig } from "../../shared/room-config";
import { createMessageBuffer } from "./buffer";
import { persistQueueConsumer } from "./consumer";
import { resetPersistenceSchema } from "./testing";

const ROOM = "roundtrip-room";

/**
 * The whole slice on one path — buffer → `PersistBatch` → consumer → history —
 * with the queue hop stubbed so the assertion does not race the delivery.
 */
describe("buffer to history round trip", () => {
  beforeEach(async () => {
    await resetPersistenceSchema(env.CHAT_DB);
  });

  it("makes flushed messages and reactions readable over HTTP", async () => {
    const sent: PersistBatch[] = [];
    const bufferEnv = {
      LOG_LEVEL: "error",
      PERSIST_QUEUE: {
        send: async (batch: PersistBatch) => {
          sent.push(batch);
        },
      },
    } as unknown as Env;

    const config = { ...defaultRoomConfig(ROOM).persistence, batchSize: 2 };
    const buffer = createMessageBuffer(bufferEnv, ROOM, 1, config);

    const messages: ChatMessage[] = [
      { id: "r1", roomId: ROOM, userId: "u1", name: "One", body: "first", ts: 1_000 },
      { id: "r2", roomId: ROOM, userId: "u2", name: "Two", body: "second", ts: 2_000 },
    ];
    for (const message of messages) expect(buffer.add(message)).toBe(true);
    buffer.addReaction({ roomId: ROOM, messageId: "r1", userId: "u2", emoji: "🔥", ts: 2_100 });

    expect(buffer.shouldFlush(Date.now())).toBe(true);
    expect(await buffer.flush()).toBe(3);
    expect(sent).toHaveLength(1);

    await persistQueueConsumer.handle(
      {
        queue: "chat-persist",
        messages: [
          {
            id: "q1",
            timestamp: new Date(0),
            body: sent[0]!,
            attempts: 1,
            ack: () => {},
            retry: () => {},
          },
        ],
        metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
        ackAll: () => {},
        retryAll: () => {},
      },
      env,
      {} as ExecutionContext,
    );

    const res = await SELF.fetch(`https://example.com/api/rooms/${ROOM}/messages`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: ChatMessage[] };
    expect(body.messages).toEqual([messages[1], messages[0]]);

    const reactions = await env.CHAT_DB.prepare(
      "SELECT message_id, emoji FROM reactions WHERE room_id = ?",
    )
      .bind(ROOM)
      .all<{ message_id: string; emoji: string }>();
    expect(reactions.results).toEqual([{ message_id: "r1", emoji: "🔥" }]);
  });
});
