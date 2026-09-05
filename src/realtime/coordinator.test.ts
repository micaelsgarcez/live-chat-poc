import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getShardCount } from "../features/routing";
import { coordinatorName, newMessageId } from "../shared/ids";
import type { ChatMessage, ServerEvent } from "../shared/protocol";
import type { RoomConfig } from "../shared/room-config";
import type { RoomCoordinator } from "./coordinator";
import type { ShardRegistry } from "./coordinator/registry";

/**
 * The coordinator's whole job is *which* shards it calls, so the tests replace
 * the shard stub with a fleet of fakes: a real `ChatShard` cannot be made to
 * fail on demand, and the failure path is the interesting one.
 */
interface FakeShard {
  fanout(events: ServerEvent[]): Promise<number>;
  applyConfig(config: RoomConfig): Promise<void>;
  kickUsers(userIds: string[], reason: string): Promise<number>;
}

interface ShardCall {
  index: number;
  kind: "fanout" | "applyConfig" | "kickUsers";
  events?: ServerEvent[];
  config?: RoomConfig;
  userIds?: string[];
}

/** Private seams the tests drive; all of them exist in production code. */
type Internals = {
  shardStub(roomId: string, index: number): FakeShard;
  callRanking(roomId: string): Promise<unknown>;
  registry: ShardRegistry;
};

class ShardFleet {
  readonly calls: ShardCall[] = [];
  readonly failing = new Set<number>();
  socketsPerFanout = 3;

  stub(index: number): FakeShard {
    return {
      fanout: async (events) => {
        this.calls.push({ index, kind: "fanout", events });
        this.throwIfFailing(index);
        return this.socketsPerFanout;
      },
      applyConfig: async (config) => {
        this.calls.push({ index, kind: "applyConfig", config });
        this.throwIfFailing(index);
      },
      kickUsers: async (userIds) => {
        this.calls.push({ index, kind: "kickUsers", userIds });
        this.throwIfFailing(index);
        return userIds.length;
      },
    };
  }

  of(index: number, kind: ShardCall["kind"]): ShardCall[] {
    return this.calls.filter((call) => call.index === index && call.kind === kind);
  }

  private throwIfFailing(index: number): void {
    if (this.failing.has(index)) throw new Error(`shard ${index} unreachable`);
  }
}

function coordinatorFor(roomId: string) {
  return env.ROOM_COORDINATOR.get(env.ROOM_COORDINATOR.idFromName(coordinatorName(roomId)));
}

/** Runs `body` against the real Durable Object with a fake shard fleet wired in. */
async function withCoordinator(
  roomId: string,
  body: (coordinator: RoomCoordinator, fleet: ShardFleet, internals: Internals) => Promise<void>,
): Promise<void> {
  const fleet = new ShardFleet();
  await runInDurableObject(coordinatorFor(roomId), async (instance: RoomCoordinator) => {
    const internals = instance as unknown as Internals;
    internals.shardStub = (_roomId, index) => fleet.stub(index);
    await body(instance, fleet, internals);
  });
}

function message(roomId: string, body: string): ChatMessage {
  const ts = Date.now();
  return { id: newMessageId(ts), roomId, userId: "u1", name: "u1", body, ts };
}

describe("RoomCoordinator", () => {
  it("publishes to every registered shard with one call each", async () => {
    await withCoordinator("pub-room", async (coordinator, fleet) => {
      for (const index of [0, 1, 2]) await coordinator.registerShard("pub-room", index);

      const result = await coordinator.publish({
        message: message("pub-room", "hi"),
        originShardIndex: 1,
      });

      expect(fleet.of(0, "fanout")).toHaveLength(1);
      expect(fleet.of(1, "fanout")).toHaveLength(1);
      expect(fleet.of(2, "fanout")).toHaveLength(1);
      expect(fleet.of(0, "fanout")[0]!.events?.[0]).toMatchObject({ t: "msg" });
      expect(result.failedShards).toEqual([]);
      expect(result.delivered).toBe(3 * fleet.socketsPerFanout);
    });
  });

  it("isolates a shard that keeps failing and takes it back on re-registration", async () => {
    await withCoordinator("isolate-room", async (coordinator, fleet) => {
      for (const index of [0, 1]) await coordinator.registerShard("isolate-room", index);
      fleet.failing.add(1);

      for (let i = 0; i < 3; i++) {
        const result = await coordinator.publish({
          message: message("isolate-room", `m${i}`),
          originShardIndex: 0,
        });
        expect(result.failedShards).toEqual([1]);
      }
      expect(fleet.of(1, "fanout")).toHaveLength(3);

      // Fourth publish: the shard is suspect, so it does not cost a call at all.
      const isolated = await coordinator.publish({
        message: message("isolate-room", "m3"),
        originShardIndex: 0,
      });
      expect(isolated.failedShards).toEqual([]);
      expect(fleet.of(1, "fanout")).toHaveLength(3);
      expect(fleet.of(0, "fanout")).toHaveLength(4);

      // Re-registering is the only way back in, and it must actually work.
      fleet.failing.delete(1);
      await coordinator.registerShard("isolate-room", 1);
      await coordinator.publish({
        message: message("isolate-room", "m4"),
        originShardIndex: 0,
      });
      expect(fleet.of(1, "fanout")).toHaveLength(4);
    });
  });

  it("bumps the config version, replicates it and tells the clients", async () => {
    await withCoordinator("config-room", async (coordinator, fleet) => {
      const initial = await coordinator.registerShard("config-room", 0);
      await coordinator.registerShard("config-room", 1);

      const next = await coordinator.updateConfig({ slowModeMs: 4_000 });

      expect(next.version).toBe(initial.version + 1);
      expect(next.slowModeMs).toBe(4_000);
      for (const index of [0, 1]) {
        expect(fleet.of(index, "applyConfig")[0]?.config).toMatchObject({
          version: next.version,
          slowModeMs: 4_000,
        });
      }
      const configEvents = fleet
        .of(0, "fanout")
        .flatMap((call) => call.events ?? [])
        .filter((event) => event.t === "config");
      expect(configEvents).toHaveLength(1);

      // A shard joining after the change is handed the current version.
      const late = await coordinator.registerShard("config-room", 2);
      expect(late.version).toBe(next.version);
      expect(late.slowModeMs).toBe(4_000);
    });
  });

  it("reports registered shards and aggregated presence in the stats", async () => {
    await withCoordinator("stats-room", async (coordinator) => {
      await coordinator.registerShard("stats-room", 0);
      await coordinator.registerShard("stats-room", 3);
      await coordinator.reportPresence(0, 12);
      await coordinator.reportPresence(3, 30);
      await coordinator.publish({ message: message("stats-room", "x"), originShardIndex: 0 });

      const stats = await coordinator.getStats();
      expect(stats.roomId).toBe("stats-room");
      expect(stats.registeredShards).toEqual([0, 3]);
      expect(stats.connections).toBe(42);
      expect(stats.averageSubRoomOccupancy).toBe(21);
      expect(stats.messagesPublished).toBe(1);
      expect(stats.configVersion).toBeGreaterThan(0);
    });
  });

  it("expires a shard that stopped sending heartbeats", async () => {
    await withCoordinator("expiry-room", async (coordinator, fleet, internals) => {
      await coordinator.registerShard("expiry-room", 0);
      await coordinator.registerShard("expiry-room", 1);
      await coordinator.reportPresence(0, 5);
      await coordinator.reportPresence(1, 5);

      // Shard 1 went dark two minutes ago; shard 0 is still checking in.
      internals.registry.touch(1, Date.now() - 120_000);
      await coordinator.alarm();

      const stats = await coordinator.getStats();
      expect(stats.registeredShards).toEqual([0]);
      expect(stats.connections).toBe(5);

      fleet.calls.length = 0;
      await coordinator.publish({ message: message("expiry-room", "y"), originShardIndex: 0 });
      expect(fleet.of(1, "fanout")).toHaveLength(0);
    });
  });

  it("grows the shard count and publishes it to KV for the edge to read", async () => {
    await withCoordinator("scale-room", async (coordinator, fleet) => {
      const initial = await coordinator.registerShard("scale-room", 0);
      expect(await getShardCount(env, "scale-room")).toBe(initial.shardCount);

      // Well past 70% of `maxSocketsPerShard` averaged over the current shards.
      await coordinator.reportPresence(0, initial.shardCount * initial.maxSocketsPerShard);
      await coordinator.alarm();

      const config = await coordinator.getConfig();
      expect(config.shardCount).toBeGreaterThan(initial.shardCount);
      expect(config.version).toBe(initial.version + 1);
      expect(await getShardCount(env, "scale-room")).toBe(config.shardCount);
      expect(fleet.of(0, "applyConfig")[0]?.config).toMatchObject({
        shardCount: config.shardCount,
      });

      // Losing the connections must not remap anyone by shrinking back.
      await coordinator.reportPresence(0, 0);
      await coordinator.alarm();
      expect((await coordinator.getConfig()).shardCount).toBe(config.shardCount);
    });
  });

  it("adopts a shard opened past the published placement count", async () => {
    await withCoordinator("probe-growth-room", async (coordinator, fleet) => {
      const initial = await coordinator.init("probe-growth-room");
      const openedIndex = initial.shardCount;

      const adopted = await coordinator.registerShard("probe-growth-room", openedIndex);

      expect(adopted.shardCount).toBe(openedIndex + 1);
      expect(await getShardCount(env, "probe-growth-room")).toBe(openedIndex + 1);
      expect(fleet.of(openedIndex, "applyConfig")[0]?.config?.shardCount).toBe(openedIndex + 1);
    });
  });

  it("keeps privileged publishes room-wide while subrooms are enabled", async () => {
    await withCoordinator("privileged-room", async (coordinator, fleet) => {
      await coordinator.registerShard("privileged-room", 0);
      await coordinator.registerShard("privileged-room", 1);
      await coordinator.updateConfig({ fanout: { scope: "subroom" } as RoomConfig["fanout"] });
      fleet.calls.length = 0;
      const privileged = { ...message("privileged-room", "announcement"), roles: ["moderator"] };

      await coordinator.publish({ message: privileged, originShardIndex: 0 });

      expect(fleet.of(0, "fanout")[0]?.events?.[0]).toMatchObject({ t: "msg", m: privileged });
      expect(fleet.of(1, "fanout")[0]?.events?.[0]).toMatchObject({ t: "msg", m: privileged });
    });
  });

  it("normalizes an invalid fanout scope to room", async () => {
    await withCoordinator("invalid-scope-room", async (coordinator) => {
      await coordinator.init("invalid-scope-room");
      const config = await coordinator.updateConfig({
        fanout: { scope: "somewhere-else" } as unknown as RoomConfig["fanout"],
      });
      expect(config.fanout.scope).toBe("room");
    });
  });

  it("finishes the alarm even when the ranking refresh throws", async () => {
    await withCoordinator("ranking-room", async (coordinator, _fleet, internals) => {
      await coordinator.registerShard("ranking-room", 0);
      await coordinator.reportPresence(0, 9);
      internals.callRanking = () => Promise.reject(new Error("ranking exploded"));

      await expect(coordinator.alarm()).resolves.toBeUndefined();

      // The rest of the tick still happened: state persisted, alarm re-armed.
      const stats = await coordinator.getStats();
      expect(stats.connections).toBe(9);
      await runInDurableObject(coordinatorFor("ranking-room"), async (_i, state) => {
        expect(await state.storage.getAlarm()).not.toBeNull();
        expect(await state.storage.get("counters")).toMatchObject({ connections: 9 });
      });
    });
  });

  it("kicks a banned user on every shard and stays idempotent", async () => {
    await withCoordinator("ban-room", async (coordinator, fleet) => {
      for (const index of [0, 1]) await coordinator.registerShard("ban-room", index);

      const ban = { userId: "troll", roomId: "ban-room", reason: "spam", bannedBy: "mod" };
      await coordinator.banUser(ban);
      await coordinator.banUser(ban);

      // Kicking twice is harmless, and it must still catch a socket the user
      // opened between the two calls.
      for (const index of [0, 1]) {
        expect(fleet.of(index, "kickUsers")).toHaveLength(2);
        expect(fleet.of(index, "kickUsers")[0]?.userIds).toEqual(["troll"]);
      }
      await coordinator.unbanUser("ban-room", "troll");
    });
  });

  it("fans a retroactive delete out once, not once per retry", async () => {
    await withCoordinator("delete-room", async (coordinator, fleet) => {
      await coordinator.registerShard("delete-room", 0);
      fleet.calls.length = 0;

      await coordinator.deleteMessages(["m-1", "m-2"], "moderation");
      await coordinator.deleteMessages(["m-1", "m-2"], "moderation");
      expect(fleet.of(0, "fanout")).toHaveLength(1);
      expect(fleet.of(0, "fanout")[0]!.events?.[0]).toMatchObject({
        t: "delete",
        ids: ["m-1", "m-2"],
      });

      await coordinator.deleteMessages(["m-2", "m-3"], "moderation");
      expect(fleet.of(0, "fanout")).toHaveLength(2);
      expect(fleet.of(0, "fanout")[1]!.events?.[0]).toMatchObject({ ids: ["m-3"] });
    });
  });

  it("keeps counters and presence across a restart of the object", async () => {
    await withCoordinator("durable-room", async (coordinator) => {
      await coordinator.registerShard("durable-room", 0);
      await coordinator.reportPresence(0, 17);
      await coordinator.publish({ message: message("durable-room", "z"), originShardIndex: 0 });
      await coordinator.alarm();
    });

    // `runInDurableObject` re-enters the same object; state comes from storage
    // for anything the alarm persisted.
    await runInDurableObject(coordinatorFor("durable-room"), async (_i, state) => {
      expect(await state.storage.get("counters")).toMatchObject({
        messagesPublished: 1,
        connections: 17,
      });
      const shards = await state.storage.get<Array<{ index: number; connections: number }>>(
        "shards",
      );
      expect(shards).toEqual([expect.objectContaining({ index: 0, connections: 17 })]);
    });
  });
});
