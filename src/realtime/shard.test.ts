import {
  env,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { TestClient } from "../../tests/helpers/client";
import { selectShardIndex } from "../features/routing";
import { RejectCode } from "../shared/errors";
import {
  CONNECT_METADATA_HEADER,
  encodeConnectMetadata,
  type ConnectMetadata,
} from "../shared/identity";
import { coordinatorName, shardName } from "../shared/ids";
import type { UserGateState } from "../shared/pipeline";
import type { MessageBuffer } from "../shared/ports";
import { defaultRoomConfig, type RoomConfig } from "../shared/room-config";
import type { ChatShard } from "./shard";

/** Matches DEFAULT_SHARD_COUNT in wrangler.jsonc. */
const SHARD_COUNT = 4;

function shardOf(roomId: string, userId: string): number {
  return selectShardIndex(`${roomId}:${userId}`, SHARD_COUNT);
}

function shardStub(roomId: string, shardIndex: number) {
  return env.CHAT_SHARD.get(env.CHAT_SHARD.idFromName(shardName(roomId, shardIndex)));
}

function coordinatorStub(roomId: string) {
  return env.ROOM_COORDINATOR.get(env.ROOM_COORDINATOR.idFromName(coordinatorName(roomId)));
}

/** Two user ids the edge places on the same shard, or on two different ones. */
function pickUsers(roomId: string, sameShard: boolean): [string, string] {
  const first = "user-0";
  const target = shardOf(roomId, first);
  for (let i = 1; i < 500; i++) {
    const candidate = `user-${i}`;
    if ((shardOf(roomId, candidate) === target) === sameShard) return [first, candidate];
  }
  throw new Error(`no ${sameShard ? "same" : "other"}-shard candidate for ${roomId}`);
}

function upgradeRequest(roomId: string, shardIndex: number, userId: string): Request {
  const meta: ConnectMetadata = {
    identity: { userId, name: userId, roles: [], expiresAt: 0 },
    roomId,
    shardIndex,
    connectionId: `conn-${userId}`,
    connectedAt: Date.now(),
  };
  return new Request("https://shard.test/", {
    headers: {
      upgrade: "websocket",
      [CONNECT_METADATA_HEADER]: encodeConnectMetadata(meta),
    },
  });
}

/**
 * The shard keeps its moving parts private on purpose; the few tests that need
 * to inject a failure reach in through this narrow view instead of widening the
 * public surface other slices depend on.
 */
interface ShardInternals {
  config: RoomConfig | null;
  buffer: MessageBuffer | null;
  userState: Map<string, UserGateState>;
  coordinator: () => {
    publish(input: unknown): Promise<unknown>;
    broadcast(events: unknown): Promise<unknown>;
  };
}

function internals(instance: ChatShard): ShardInternals {
  return instance as unknown as ShardInternals;
}

async function until(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("condition was never met");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const settle = (ms = 50): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("ChatShard delivery", () => {
  it("delivers a message to another client on the same shard", async () => {
    const room = "shard-same";
    const [sender, receiver] = pickUsers(room, true);
    const a = await TestClient.connectAs(room, sender);
    const b = await TestClient.connectAs(room, receiver);
    const [helloA, helloB] = await Promise.all([a.waitFor("hello"), b.waitFor("hello")]);
    expect(helloA.shardIndex).toBe(helloB.shardIndex);

    a.send({ t: "send", cid: "c1", body: "same shard" });
    const [ack, delivered] = await Promise.all([a.waitFor("ack"), b.waitFor("msg")]);
    expect(delivered.m.body).toBe("same shard");
    expect(delivered.m.id).toBe(ack.id);
  });

  it("delivers a message to a client on another shard", async () => {
    const room = "shard-cross";
    const [sender, receiver] = pickUsers(room, false);
    const a = await TestClient.connectAs(room, sender);
    const b = await TestClient.connectAs(room, receiver);
    const [helloA, helloB] = await Promise.all([a.waitFor("hello"), b.waitFor("hello")]);
    expect(helloA.shardIndex).not.toBe(helloB.shardIndex);

    a.send({ t: "send", cid: "c1", body: "across shards" });
    const [ack, delivered] = await Promise.all([a.waitFor("ack"), b.waitFor("msg")]);
    expect(delivered.m.body).toBe("across shards");
    expect(delivered.m.id).toBe(ack.id);
  });

  it("keeps fanning out to the surviving sockets when one is gone", async () => {
    const room = "shard-fanout";
    const [alive, doomed] = pickUsers(room, true);
    const a = await TestClient.connectAs(room, alive);
    const b = await TestClient.connectAs(room, doomed);
    await Promise.all([a.waitFor("hello"), b.waitFor("hello")]);

    b.close();
    const stub = shardStub(room, shardOf(room, alive));
    await expect(stub.fanout([{ t: "sys", code: "still-here" }])).resolves.toBeGreaterThan(0);
    await until(() => a.all("sys").some((m) => m.code === "still-here"));
  });
});

describe("ChatShard client frames", () => {
  it("answers ping with pong, both hibernating and awake", async () => {
    const room = "shard-ping";
    const client = await TestClient.connectAs(room, "ping-user");
    await client.waitFor("hello");

    // Exactly the auto-response pair: answered without waking the isolate.
    client.send({ t: "ping" });
    expect((await client.waitFor("pong")).ts).toBe(0);

    // Carrying a `ts` no longer matches the pair, so the isolate answers.
    client.send({ t: "ping", ts: 4242 });
    await until(() => client.all("pong").length === 2);
    expect(client.all("pong")[1]!.ts).toBe(4242);
  });

  it("survives a malformed frame and keeps serving the socket", async () => {
    const room = "shard-malformed";
    const client = await TestClient.connectAs(room, "sloppy-user");
    await client.waitFor("hello");

    client.ws.send("}{ not json");
    client.send({ t: "nonsense" });
    await until(() => client.all("sys").filter((m) => m.code === "malformed").length === 2);

    client.send({ t: "send", cid: "after", body: "still alive" });
    expect((await client.waitFor("ack")).cid).toBe("after");
  });

  it("relays a reaction without an ack and without touching the pipeline", async () => {
    const room = "shard-reaction";
    const [sender, receiver] = pickUsers(room, true);
    const a = await TestClient.connectAs(room, sender);
    const b = await TestClient.connectAs(room, receiver);
    await Promise.all([a.waitFor("hello"), b.waitFor("hello")]);

    a.send({ t: "react", cid: "r1", messageId: "m-1", emoji: "🔥" });
    const relayed = await b.waitFor("reaction");
    expect(relayed.messageId).toBe("m-1");
    expect(relayed.emoji).toBe("🔥");

    await settle();
    expect(a.all("ack")).toHaveLength(0);
    expect(a.all("rejected")).toHaveLength(0);
    const stats = await shardStub(room, shardOf(room, sender)).getStats();
    expect(stats.acceptedCount).toBe(0);
  });

  it("rejects with INTERNAL when the coordinator cannot take the message", async () => {
    const room = "shard-publish-fail";
    const user = "unlucky-user";
    const client = await TestClient.connectAs(room, user);
    await client.waitFor("hello");

    await runInDurableObject(shardStub(room, shardOf(room, user)), (instance: ChatShard) => {
      internals(instance).coordinator = () => ({
        publish: () => Promise.reject(new Error("coordinator is down")),
        broadcast: () => Promise.reject(new Error("coordinator is down")),
      });
    });

    client.send({ t: "send", cid: "boom", body: "never lands" });
    const rejected = await client.waitFor("rejected");
    expect(rejected.cid).toBe("boom");
    expect(rejected.code).toBe(RejectCode.INTERNAL);
  });
});

describe("ChatShard RPC surface", () => {
  it("closes the sockets of a kicked user", async () => {
    const room = "shard-kick";
    const user = "kicked-user";
    const client = await TestClient.connectAs(room, user);
    await client.waitFor("hello");
    const closed = new Promise<void>((resolve) =>
      client.ws.addEventListener("close", () => resolve()),
    );

    const stub = shardStub(room, shardOf(room, user));
    await expect(stub.kickUsers([user], "banned for testing")).resolves.toBe(1);

    expect((await client.waitFor("sys")).code).toBe("banned");
    await closed;
    await until(async () => (await stub.getStats()).connections === 0);
  });

  it("ignores an older config version and applies a newer one", async () => {
    const room = "shard-config";
    const stub = shardStub(room, 0);
    const base = defaultRoomConfig(room);

    await stub.applyConfig({ ...base, version: 5, slowModeMs: 500 });
    await stub.applyConfig({ ...base, version: 3, slowModeMs: 999 });

    let stats = await stub.getStats();
    expect(stats.configVersion).toBe(5);
    await runInDurableObject(stub, (instance: ChatShard) => {
      expect(internals(instance).config?.slowModeMs).toBe(500);
    });

    await stub.applyConfig({ ...base, version: 7, slowModeMs: 250 });
    stats = await stub.getStats();
    expect(stats.configVersion).toBe(7);
    await runInDurableObject(stub, (instance: ChatShard) => {
      expect(internals(instance).config?.slowModeMs).toBe(250);
    });
  });

  it("reports connections and counters in getStats", async () => {
    const room = "shard-stats";
    const user = "stats-user";
    const client = await TestClient.connectAs(room, user);
    await client.waitFor("hello");
    const stub = shardStub(room, shardOf(room, user));

    let stats = await stub.getStats();
    expect(stats.roomId).toBe(room);
    expect(stats.shardIndex).toBe(shardOf(room, user));
    expect(stats.connections).toBe(1);

    client.send({ t: "send", cid: "ok", body: "counted" });
    await client.waitFor("ack");
    client.send({ t: "send", cid: "bad", body: "   " });
    expect((await client.waitFor("rejected")).code).toBe(RejectCode.EMPTY);

    stats = await stub.getStats();
    expect(stats.acceptedCount).toBe(1);
    expect(stats.rejectedCount).toBe(1);
    expect(stats.bufferedMessages).toBe(0);
  });

  it("drains the persistence buffer on flushNow and swallows a failing flush", async () => {
    const stub = shardStub("shard-flush", 0);
    await runInDurableObject(stub, async (instance: ChatShard) => {
      let pending = 3;
      internals(instance).buffer = {
        add: () => true,
        addReaction: () => true,
        size: () => pending,
        shouldFlush: () => false,
        flush: async () => {
          const flushed = pending;
          pending = 0;
          return flushed;
        },
      };

      expect((await instance.getStats()).bufferedMessages).toBe(3);
      await expect(instance.flushNow()).resolves.toBe(3);
      expect((await instance.getStats()).bufferedMessages).toBe(0);

      internals(instance).buffer = {
        add: () => true,
        addReaction: () => true,
        size: () => 1,
        shouldFlush: () => false,
        flush: () => Promise.reject(new Error("queue is wedged")),
      };
      await expect(instance.flushNow()).resolves.toBe(0);
    });
  });
});

describe("ChatShard backpressure and lifecycle", () => {
  it("answers 503 once the shard is full", async () => {
    const room = "shard-full";
    const stub = shardStub(room, 0);
    // A high version so the config the coordinator hands back on register loses.
    await stub.applyConfig({ ...defaultRoomConfig(room), version: 99, maxSocketsPerShard: 1 });

    const first = await stub.fetch(upgradeRequest(room, 0, "first-user"));
    expect(first.status).toBe(101);
    first.webSocket!.accept();

    const second = await stub.fetch(upgradeRequest(room, 0, "second-user"));
    expect(second.status).toBe(503);
    expect(second.webSocket).toBeNull();

    first.webSocket!.close();
  });

  it("registers on the first connection and hands the slot back when empty", async () => {
    const room = "shard-lifecycle";
    const user = "lifecycle-user";
    const index = shardOf(room, user);
    const client = await TestClient.connectAs(room, user);
    await client.waitFor("hello");

    const coordinator = coordinatorStub(room);
    expect((await coordinator.getStats()).registeredShards).toContain(index);

    client.close();
    const stub = shardStub(room, index);
    await until(async () => (await stub.getStats()).connections === 0);
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);

    expect((await coordinator.getStats()).registeredShards).not.toContain(index);
  });
});

describe("ChatShard hibernation", () => {
  it("rebuilds counters and per-user penalties after the isolate is evicted", async () => {
    const room = "shard-hibernation";
    const user = "hibernating-user";
    const client = await TestClient.connectAs(room, user);
    await client.waitFor("hello");
    const stub = shardStub(room, shardOf(room, user));

    client.send({ t: "send", cid: "before", body: "before hibernation" });
    await client.waitFor("ack");
    // The alarm is what persists the counters; run it before pulling the rug.
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
    await stub.muteUsers([user], Date.now() + 60_000, "cooling off");

    await evictDurableObject(stub);

    // A fresh isolate: in-memory state is empty, storage is not.
    await runInDurableObject(stub, (instance: ChatShard) => {
      expect(internals(instance).userState.size).toBe(0);
    });
    expect((await stub.getStats()).acceptedCount).toBe(1);

    // The socket survived hibernation and the mute survived with it.
    client.send({ t: "send", cid: "after", body: "after hibernation" });
    const rejected = await client.waitFor("rejected");
    expect(rejected.cid).toBe("after");
    expect(rejected.code).toBe(RejectCode.MUTED);
  });
});
