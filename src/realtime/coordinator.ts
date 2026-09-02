/**
 * RoomCoordinator — one Durable Object per room.
 *
 * It never holds client sockets. Its job is to be the single place that knows
 * (a) the authoritative room configuration and (b) which shards currently exist,
 * so a message accepted by one shard reaches all of them with exactly one call
 * per shard instead of one per client.
 */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { intVar } from "../env";
import { shardName } from "../shared/ids";
import { createLogger, type LogLevel } from "../shared/logger";
import type {
  BanInput,
  CoordinatorApi,
  PublishInput,
  PublishResult,
  RoomStats,
} from "../shared/ports";
import type { ServerEvent } from "../shared/protocol";
import { toPublicConfig } from "../shared/room-config";
import {
  defaultRoomConfig,
  mergeRoomConfig,
  type RoomConfig,
  type RoomConfigPatch,
} from "../shared/room-config";
import { setShardCount } from "../features/routing";

const KEY_CONFIG = "config";
const KEY_SHARDS = "shards";
const KEY_COUNTERS = "counters";

interface Counters {
  messagesPublished: number;
  connections: number;
}

export class RoomCoordinator extends DurableObject<Env> implements CoordinatorApi {
  private config: RoomConfig | null = null;
  private shards = new Set<number>();
  private counters: Counters = { messagesPublished: 0, connections: 0 };
  private presence = new Map<number, number>();
  private loaded = false;
  private readonly log = createLogger("coordinator", (this.env.LOG_LEVEL as LogLevel) ?? "info");

  private async load(roomId?: string): Promise<RoomConfig> {
    if (!this.loaded) {
      const stored = await this.ctx.storage.get<RoomConfig>(KEY_CONFIG);
      const shards = await this.ctx.storage.get<number[]>(KEY_SHARDS);
      const counters = await this.ctx.storage.get<Counters>(KEY_COUNTERS);
      this.config = stored ?? null;
      this.shards = new Set(shards ?? []);
      this.counters = counters ?? { messagesPublished: 0, connections: 0 };
      this.loaded = true;
    }
    if (!this.config) {
      if (!roomId) throw new Error("coordinator used before init()");
      this.config = defaultRoomConfig(roomId, intVar(this.env.DEFAULT_SHARD_COUNT, 4));
      this.config.maxSocketsPerShard = intVar(this.env.MAX_SOCKETS_PER_SHARD, 5000);
      await this.ctx.storage.put(KEY_CONFIG, this.config);
      await setShardCount(this.env, this.config.roomId, this.config.shardCount);
    }
    return this.config;
  }

  async init(roomId: string): Promise<RoomConfig> {
    return this.load(roomId);
  }

  async getConfig(): Promise<RoomConfig> {
    return this.load();
  }

  async updateConfig(patch: RoomConfigPatch): Promise<RoomConfig> {
    const current = await this.load();
    const next = mergeRoomConfig(current, patch);
    this.config = next;
    await this.ctx.storage.put(KEY_CONFIG, next);
    if (patch.shardCount && patch.shardCount !== current.shardCount) {
      await setShardCount(this.env, next.roomId, next.shardCount);
    }
    await this.fanout([{ t: "config", config: toPublicConfig(next) }]);
    await this.pushConfigToShards(next);
    return next;
  }

  async registerShard(roomId: string, shardIndex: number): Promise<RoomConfig> {
    const config = await this.load(roomId);
    if (!this.shards.has(shardIndex)) {
      this.shards.add(shardIndex);
      await this.ctx.storage.put(KEY_SHARDS, [...this.shards]);
    }
    return config;
  }

  async unregisterShard(shardIndex: number): Promise<void> {
    if (this.shards.delete(shardIndex)) {
      this.presence.delete(shardIndex);
      await this.ctx.storage.put(KEY_SHARDS, [...this.shards]);
    }
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    await this.load(input.message.roomId);
    this.counters.messagesPublished++;
    const result = await this.fanout([{ t: "msg", m: input.message }]);
    if (this.counters.messagesPublished % 50 === 0) {
      await this.ctx.storage.put(KEY_COUNTERS, this.counters);
    }
    return result;
  }

  async broadcast(events: ServerEvent[]): Promise<PublishResult> {
    await this.load();
    return this.fanout(events);
  }

  async banUser(input: BanInput): Promise<void> {
    await this.load(input.roomId);
    await this.forEachShard(async (stub) => {
      await stub.kickUsers([input.userId], input.reason);
    });
  }

  async unbanUser(_roomId: string, _userId: string): Promise<void> {
    await this.load(_roomId);
  }

  async deleteMessages(messageIds: string[], reason: string): Promise<void> {
    if (messageIds.length === 0) return;
    await this.load();
    await this.fanout([{ t: "delete", ids: messageIds, reason }]);
  }

  async reportPresence(shardIndex: number, count: number): Promise<void> {
    this.presence.set(shardIndex, count);
    this.counters.connections = [...this.presence.values()].reduce((a, b) => a + b, 0);
  }

  async getStats(): Promise<RoomStats> {
    const config = await this.load();
    return {
      roomId: config.roomId,
      shardCount: config.shardCount,
      registeredShards: [...this.shards].sort((a, b) => a - b),
      connections: this.counters.connections,
      messagesPublished: this.counters.messagesPublished,
      configVersion: config.version,
      updatedAt: Date.now(),
    };
  }

  /* ---------------------------------------------------------------- */

  private shardStub(roomId: string, index: number) {
    return this.env.CHAT_SHARD.get(this.env.CHAT_SHARD.idFromName(shardName(roomId, index)));
  }

  private async forEachShard(
    fn: (stub: ReturnType<RoomCoordinator["shardStub"]>, index: number) => Promise<unknown>,
  ): Promise<{ ok: number; failed: number[] }> {
    const config = await this.load();
    const indexes = [...this.shards];
    const settled = await Promise.allSettled(
      indexes.map((index) => fn(this.shardStub(config.roomId, index), index)),
    );
    const failed: number[] = [];
    let ok = 0;
    settled.forEach((outcome, i) => {
      if (outcome.status === "fulfilled") ok++;
      else {
        failed.push(indexes[i]!);
        this.log.warn("shard call failed", { shard: indexes[i], error: String(outcome.reason) });
      }
    });
    return { ok, failed };
  }

  private async fanout(events: ServerEvent[]): Promise<PublishResult> {
    const { ok, failed } = await this.forEachShard((stub) => stub.fanout(events));
    return { delivered: ok, failedShards: failed };
  }

  private async pushConfigToShards(config: RoomConfig): Promise<void> {
    await this.forEachShard((stub) => stub.applyConfig(config));
  }
}
