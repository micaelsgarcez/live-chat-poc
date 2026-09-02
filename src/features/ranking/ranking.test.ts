import { createExecutionContext, env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { MINUTE } from "../../shared/time";
import type { RankingSnapshot } from "../../shared/ports";
import {
  RANKING_WINDOW_MS,
  rankingKey,
  rankingSlice,
  readRanking,
  refreshRoomRanking,
} from "./index";
import { MESSAGE_POINTS, REACTION_POINTS } from "./query";

/**
 * The test runner starts D1 empty (migrations are a wrangler step, not a vitest
 * one), so the tables this slice reads are created here. Kept in sync with
 * `migrations/0001_init.sql` — only the tables ranking touches.
 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS messages (
     id TEXT PRIMARY KEY, room_id TEXT NOT NULL, user_id TEXT NOT NULL,
     name TEXT NOT NULL, body TEXT NOT NULL, ts INTEGER NOT NULL,
     shard_index INTEGER NOT NULL DEFAULT 0, masked INTEGER NOT NULL DEFAULT 0,
     deleted_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS reactions (
     message_id TEXT NOT NULL, room_id TEXT NOT NULL, user_id TEXT NOT NULL,
     emoji TEXT NOT NULL, ts INTEGER NOT NULL,
     PRIMARY KEY (message_id, user_id, emoji))`,
  `CREATE TABLE IF NOT EXISTS ranking_snapshots (
     room_id TEXT NOT NULL, generated_at INTEGER NOT NULL, window_ms INTEGER NOT NULL,
     payload_json TEXT NOT NULL, PRIMARY KEY (room_id, generated_at))`,
];

interface SeedMessage {
  id: string;
  roomId: string;
  userId: string;
  name?: string;
  ts?: number;
  deletedAt?: number;
  /** Reactions received by this message, as `[reactingUserId, tsOffsetMs]`. */
  reactions?: Array<[string, number?]>;
}

async function seed(messages: SeedMessage[]): Promise<void> {
  const now = Date.now();
  for (const msg of messages) {
    const ts = msg.ts ?? now - MINUTE;
    await env.CHAT_DB.prepare(
      `INSERT OR REPLACE INTO messages (id, room_id, user_id, name, body, ts, deleted_at)
       VALUES (?, ?, ?, ?, 'hi', ?, ?)`,
    )
      .bind(msg.id, msg.roomId, msg.userId, msg.name ?? msg.userId, ts, msg.deletedAt ?? null)
      .run();
    for (const [reactor, offset] of msg.reactions ?? []) {
      await env.CHAT_DB.prepare(
        `INSERT OR REPLACE INTO reactions (message_id, room_id, user_id, emoji, ts)
         VALUES (?, ?, ?, '🔥', ?)`,
      )
        .bind(msg.id, msg.roomId, reactor, ts + (offset ?? 0))
        .run();
    }
  }
}

function scheduledRun(overrideEnv = env) {
  const job = rankingSlice.scheduled!.find((j) => j.name === "ranking-refresh")!;
  const controller = {
    scheduledTime: Date.now(),
    cron: "* * * * *",
    noRetry() {},
  } as ScheduledController;
  return job.run(controller, overrideEnv, createExecutionContext());
}

beforeAll(async () => {
  for (const ddl of SCHEMA) await env.CHAT_DB.prepare(ddl).run();
});

describe("refreshRoomRanking", () => {
  it("ranks by messages sent plus reactions received, ties broken by userId", async () => {
    await seed([
      { id: "m1", roomId: "r1", userId: "alice", name: "Alice" },
      { id: "m2", roomId: "r1", userId: "alice", name: "Alice" },
      { id: "m3", roomId: "r1", userId: "bob", reactions: [["alice"], ["carol"]] },
      { id: "m4", roomId: "r1", userId: "dave" },
      { id: "m5", roomId: "r1", userId: "carol" },
    ]);

    const snapshot = await refreshRoomRanking(env, "r1");

    expect(snapshot.roomId).toBe("r1");
    expect(snapshot.windowMs).toBe(RANKING_WINDOW_MS);
    expect(snapshot.top.map((e) => e.userId)).toEqual(["bob", "alice", "carol", "dave"]);
    expect(snapshot.top[0]).toMatchObject({
      userId: "bob",
      messages: 1,
      reactions: 2,
      score: MESSAGE_POINTS + 2 * REACTION_POINTS,
    });
    expect(snapshot.top[1]).toMatchObject({ userId: "alice", name: "Alice", score: 2 });
    // carol and dave both scored 1 — the stable tiebreak puts carol first.
    expect(snapshot.top[2]!.userId).toBe("carol");
  });

  it("ignores messages and reactions older than the window", async () => {
    const old = Date.now() - RANKING_WINDOW_MS - MINUTE;
    await seed([
      { id: "o1", roomId: "r2", userId: "alice", ts: old },
      { id: "o2", roomId: "r2", userId: "alice", ts: old, reactions: [["bob"]] },
      { id: "n1", roomId: "r2", userId: "bob" },
    ]);

    const snapshot = await refreshRoomRanking(env, "r2");

    expect(snapshot.top).toHaveLength(1);
    expect(snapshot.top[0]).toMatchObject({ userId: "bob", messages: 1, reactions: 0 });
  });

  it("does not count deleted messages, nor the reactions they received", async () => {
    await seed([
      { id: "d1", roomId: "r3", userId: "alice", deletedAt: Date.now(), reactions: [["bob"]] },
      { id: "d2", roomId: "r3", userId: "alice" },
      { id: "d3", roomId: "r3", userId: "bob" },
    ]);

    const snapshot = await refreshRoomRanking(env, "r3");

    expect(snapshot.top).toEqual([
      { userId: "alice", name: "alice", messages: 1, reactions: 0, score: 1 },
      { userId: "bob", name: "bob", messages: 1, reactions: 0, score: 1 },
    ]);
  });

  it("publishes to KV and keeps only the newest snapshots in D1", async () => {
    await seed([{ id: "k1", roomId: "r4", userId: "alice" }]);

    const snapshot = await refreshRoomRanking(env, "r4");

    expect(await readRanking(env, "r4")).toEqual(snapshot);
    const raw = await env.CHAT_KV.get(rankingKey("r4"));
    expect(JSON.parse(raw!) as RankingSnapshot).toEqual(snapshot);

    const rows = await env.CHAT_DB.prepare(
      "SELECT window_ms, payload_json FROM ranking_snapshots WHERE room_id = ?",
    )
      .bind("r4")
      .all<{ window_ms: number; payload_json: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]!.window_ms).toBe(RANKING_WINDOW_MS);
    expect(JSON.parse(rows.results[0]!.payload_json)).toEqual(snapshot.top);
  });

  it("prunes the snapshot history down to the retention limit", async () => {
    await seed([{ id: "p1", roomId: "r5", userId: "alice" }]);
    // Backfill more history than we keep; the next refresh must trim it.
    for (let i = 0; i < 15; i++) {
      await env.CHAT_DB.prepare(
        `INSERT INTO ranking_snapshots (room_id, generated_at, window_ms, payload_json)
         VALUES ('r5', ?, ?, '[]')`,
      )
        .bind(1_000 + i, RANKING_WINDOW_MS)
        .run();
    }

    await refreshRoomRanking(env, "r5");

    const rows = await env.CHAT_DB.prepare(
      "SELECT COUNT(*) AS n FROM ranking_snapshots WHERE room_id = 'r5'",
    ).all<{ n: number }>();
    expect(rows.results[0]!.n).toBe(10);
  });
});

describe("readRanking", () => {
  it("returns null until a refresh has landed", async () => {
    expect(await readRanking(env, "never-refreshed")).toBeNull();
  });
});

describe("GET /api/rooms/:roomId/ranking", () => {
  it("answers 404 before the first refresh and 200 afterwards", async () => {
    await seed([{ id: "h1", roomId: "r6", userId: "alice", reactions: [["bob"]] }]);

    const missing = await SELF.fetch("https://example.com/api/rooms/r6/ranking");
    expect(missing.status).toBe(404);

    await refreshRoomRanking(env, "r6");

    const found = await SELF.fetch("https://example.com/api/rooms/r6/ranking");
    expect(found.status).toBe(200);
    const body = (await found.json()) as { ranking: RankingSnapshot };
    expect(body.ranking.top[0]).toMatchObject({ userId: "alice", messages: 1, reactions: 1 });
  });

  it("recomputes on demand with ?refresh=1", async () => {
    await seed([{ id: "f1", roomId: "r7", userId: "alice" }]);

    const res = await SELF.fetch("https://example.com/api/rooms/r7/ranking?refresh=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ranking: RankingSnapshot };
    expect(body.ranking.top).toHaveLength(1);
    // The forced recompute published the snapshot, so plain reads work now.
    expect((await readRanking(env, "r7"))?.top).toEqual(body.ranking.top);
  });
});

describe("ranking-refresh cron job", () => {
  it("refreshes every active room", async () => {
    await seed([
      { id: "c1", roomId: "cron-a", userId: "alice" },
      { id: "c2", roomId: "cron-b", userId: "bob", reactions: [["alice"]] },
      { id: "c3", roomId: "cron-c", userId: "carol" },
    ]);

    await scheduledRun();

    expect((await readRanking(env, "cron-a"))?.top[0]?.userId).toBe("alice");
    expect((await readRanking(env, "cron-b"))?.top[0]).toMatchObject({
      userId: "bob",
      reactions: 1,
    });
    expect((await readRanking(env, "cron-c"))?.top[0]?.userId).toBe("carol");
  });

  it("keeps going when one room fails", async () => {
    await seed([
      { id: "c4", roomId: "cron-x", userId: "alice" },
      { id: "c5", roomId: "cron-y", userId: "bob" },
      { id: "c6", roomId: "cron-z", userId: "carol" },
    ]);

    // Fail only `cron-y`'s aggregate query: the other two must still land.
    const failing = new Proxy(env.CHAT_DB, {
      get(target, prop, receiver) {
        if (prop !== "prepare") return Reflect.get(target, prop, receiver);
        return (sql: string) => {
          const statement = target.prepare(sql);
          return new Proxy(statement, {
            get(stmtTarget, stmtProp, stmtReceiver) {
              if (stmtProp !== "bind") return Reflect.get(stmtTarget, stmtProp, stmtReceiver);
              return (...args: unknown[]) => {
                if (args.includes("cron-y")) throw new Error("simulated D1 failure");
                return stmtTarget.bind(...args);
              };
            },
          });
        };
      },
    }) as D1Database;

    await expect(scheduledRun({ ...env, CHAT_DB: failing })).resolves.toBeUndefined();

    expect(await readRanking(env, "cron-x")).not.toBeNull();
    expect(await readRanking(env, "cron-y")).toBeNull();
    expect(await readRanking(env, "cron-z")).not.toBeNull();
  });
});
