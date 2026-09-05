import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { newMessageId } from "../../shared/ids";
import type { ChatMessage } from "../../shared/protocol";
import { DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT } from "./history";
import { resetPersistenceSchema } from "./testing";

const ROOM = "history-room";
const T0 = 1_700_000_000_000;

interface HistoryResponse {
  messages: ChatMessage[];
  nextBefore: string | null;
}

/** Seeds `count` messages one millisecond apart, oldest first. */
async function seed(
  count: number,
  options: {
    roomId?: string;
    deletedEvery?: number;
    startIndex?: number;
    shardIndex?: number;
  } = {},
): Promise<void> {
  const roomId = options.roomId ?? ROOM;
  const start = options.startIndex ?? 0;
  const insert = env.CHAT_DB.prepare(
    `INSERT OR REPLACE INTO messages (id, room_id, user_id, name, body, ts, shard_index, masked, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const statements = Array.from({ length: count }, (_, offset) => {
    const i = start + offset;
    const deleted = options.deletedEvery && i % options.deletedEvery === 0;
    return insert.bind(
      `m${String(i).padStart(4, "0")}`,
      roomId,
      `u${i % 3}`,
      `User ${i % 3}`,
      `body ${i}`,
      T0 + i,
      options.shardIndex ?? 0,
      i % 5 === 0 ? 1 : 0,
      deleted ? T0 + 10_000 : null,
    );
  });
  await env.CHAT_DB.batch(statements);
}

async function history(query = "", roomId = ROOM): Promise<HistoryResponse> {
  const res = await SELF.fetch(`https://example.com/api/rooms/${roomId}/messages${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as HistoryResponse;
}

describe("history routes", () => {
  beforeEach(async () => {
    await resetPersistenceSchema(env.CHAT_DB);
  });

  it("returns the newest messages first in the protocol's shape", async () => {
    await seed(3);
    const page = await history();

    expect(page.messages.map((m) => m.id)).toEqual(["m0002", "m0001", "m0000"]);
    expect(page.messages[2]).toEqual({
      id: "m0000",
      roomId: ROOM,
      userId: "u0",
      name: "User 0",
      body: "body 0",
      ts: T0,
      masked: true,
    });
    // Not masked stays absent rather than `false`, matching live `msg` frames.
    expect(page.messages[0]!.masked).toBeUndefined();
    expect(page.nextBefore).toBeNull();
  });

  it("defaults to 50 and caps at 200", async () => {
    await seed(210);

    expect((await history()).messages).toHaveLength(DEFAULT_HISTORY_LIMIT);
    expect((await history("?limit=5")).messages).toHaveLength(5);
    expect((await history("?limit=1000")).messages).toHaveLength(MAX_HISTORY_LIMIT);
    // Junk falls back to the default instead of failing the request.
    expect((await history("?limit=abc")).messages).toHaveLength(DEFAULT_HISTORY_LIMIT);
    expect((await history("?limit=0")).messages).toHaveLength(DEFAULT_HISTORY_LIMIT);
  });

  it("pages backwards with the returned cursor without repeating a row", async () => {
    await seed(12);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 4; page++) {
      const body: HistoryResponse = await history(
        `?limit=5${cursor ? `&before=${cursor}` : ""}`,
      );
      seen.push(...body.messages.map((m) => m.id));
      cursor = body.nextBefore;
      if (!cursor) break;
    }

    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);
    expect(seen[0]).toBe("m0011");
    expect(seen[11]).toBe("m0000");
    expect(cursor).toBeNull();
  });

  it("accepts a raw timestamp as the cursor", async () => {
    await seed(5);
    const page = await history(`?before=${T0 + 2}`);
    expect(page.messages.map((m) => m.id)).toEqual(["m0001", "m0000"]);
  });

  it("still pages from an id whose row is gone", async () => {
    await seed(5);

    // The anchor row was trimmed, but a real message id carries its timestamp.
    const page = await history(`?before=${newMessageId(T0 + 3)}`);
    expect(page.messages.map((m) => m.id)).toEqual(["m0002", "m0001", "m0000"]);
  });

  it("hides soft-deleted messages", async () => {
    await seed(10, { deletedEvery: 2 });
    const page = await history();

    expect(page.messages.map((m) => m.id)).toEqual([
      "m0009",
      "m0007",
      "m0005",
      "m0003",
      "m0001",
    ]);
  });

  it("scopes history to one room", async () => {
    await seed(3);
    await seed(2, { roomId: "other-room", startIndex: 100 });

    expect((await history()).messages).toHaveLength(3);
    expect((await history("", "other-room")).messages.map((m) => m.id)).toEqual([
      "m0101",
      "m0100",
    ]);
  });

  it("filters history by subroom when requested", async () => {
    await seed(3, { shardIndex: 0 });
    await seed(2, { shardIndex: 1, startIndex: 100 });

    expect((await history("?sub=1")).messages.map((m) => m.id)).toEqual(["m0101", "m0100"]);
    expect((await history()).messages).toHaveLength(5);

    const invalid = await SELF.fetch(`https://example.com/api/rooms/${ROOM}/messages?sub=-1`);
    expect(invalid.status).toBe(400);
  });

  it("fetches a single message and 404s on unknown or deleted ones", async () => {
    await seed(3, { deletedEvery: 2 });

    const found = await SELF.fetch(`https://example.com/api/rooms/${ROOM}/messages/m0001`);
    expect(found.status).toBe(200);
    await expect(found.json()).resolves.toMatchObject({
      message: { id: "m0001", roomId: ROOM, body: "body 1" },
    });

    const deleted = await SELF.fetch(`https://example.com/api/rooms/${ROOM}/messages/m0002`);
    expect(deleted.status).toBe(404);

    const missing = await SELF.fetch(`https://example.com/api/rooms/${ROOM}/messages/nope`);
    expect(missing.status).toBe(404);
  });
});
