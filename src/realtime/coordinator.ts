/**
 * RoomCoordinator — one Durable Object per room.
 *
 * It never holds client sockets. Its job is to be the single place that knows
 * (a) the authoritative room configuration and (b) which shards currently exist,
 * so a message accepted by one shard reaches all of them with exactly one call
 * per shard instead of one per client.
 *
 * Everything here is shaped by that one call per shard being the room's unit of
 * cost: calls go out in bounded batches, a shard that keeps failing stops being
 * called, a shard that stops sending heartbeats is dropped, and state is
 * persisted on the alarm rather than on every message.
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
  ShardApi,
} from "../shared/ports";
import type { ServerEvent } from "../shared/protocol";
import { toPublicConfig } from "../shared/room-config";
import {
  defaultRoomConfig,
  mergeRoomConfig,
  normalizeRoomConfig,
  type FanoutConfig,
  type RoomConfig,
  type RoomConfigPatch,
} from "../shared/room-config";
import { setShardCount } from "../features/routing";
import { refreshRoomRanking } from "../features/ranking";
import { callInBatches, FANOUT_BATCH_SIZE, type BatchOutcome } from "./coordinator/fanout";
import {
  decodeShardRecords,
  ShardRegistry,
  SHARD_HEARTBEAT_TTL_MS,
  type ShardRecord,
} from "./coordinator/registry";
import { MAX_SHARD_COUNT, planShardCount } from "./coordinator/scale";

const KEY_CONFIG = "config";
const KEY_SHARDS = "shards";
const KEY_COUNTERS = "counters";
const KEY_BANS = "bans";

/**
 * Alarm cadence. Fine enough to give ranking the 10–30s refresh window the
 * 1-minute cron cannot deliver (see PLAN.md §4), coarse enough that an idle
 * room costs almost nothing.
 */
export const ALARM_INTERVAL_MS = 15_000;

/** Persist the message counter every N publishes instead of on every message. */
const COUNTER_PERSIST_EVERY = 50;

/** How many delete ids to remember so a retried delete does not re-fan out. */
const RECENT_DELETE_MEMORY = 1_000;

/** Upper bound on `fanout.batchWindowMs`; past this a viewer feels the lag. */
const MAX_BATCH_WINDOW_MS = 1_000;

/**
 * Hard cap on a pending coalescing window. A flush that wedges must lose
 * messages rather than grow the isolate's heap until it is evicted — and losing
 * the oldest is the right end to lose from in a live chat.
 */
const MAX_PENDING_FANOUT = 5_000;

interface Counters {
  messagesPublished: number;
  connections: number;
}

interface BanState {
  reason: string;
  /** Epoch ms; 0 means permanent. */
  expiresAt: number;
  bannedBy: string;
}

/** The slice of `ShardApi` the coordinator ever calls. */
type ShardTarget = Pick<ShardApi, "fanout" | "applyConfig" | "kickUsers">;

/**
 * `RoomConfig` arrives from an unvalidated moderator PATCH, so the two fanout
 * knobs are bounded here rather than trusted: a typo in a window must not park
 * every message in the room for an hour.
 */
function clampFanout(fanout: FanoutConfig): FanoutConfig {
  const window = Number.isFinite(fanout.batchWindowMs) ? fanout.batchWindowMs : 0;
  const cap = Number.isFinite(fanout.maxPerViewerPerSecond) ? fanout.maxPerViewerPerSecond : 0;
  return {
    scope: fanout.scope === "subroom" ? "subroom" : "room",
    batchWindowMs: Math.min(MAX_BATCH_WINDOW_MS, Math.max(0, Math.floor(window))),
    maxPerViewerPerSecond: Math.max(0, Math.floor(cap)),
    alwaysDeliverOwn: fanout.alwaysDeliverOwn !== false,
  };
}

function batchWindowOf(config: RoomConfig): number {
  return clampFanout(config.fanout).batchWindowMs;
}

export class RoomCoordinator extends DurableObject<Env> implements CoordinatorApi {
  private config: RoomConfig | null = null;
  private registry = new ShardRegistry();
  private counters: Counters = { messagesPublished: 0, connections: 0 };
  private bans = new Map<string, BanState>();
  /** Insertion-ordered, bounded: makes `deleteMessages` idempotent on retry. */
  private readonly recentDeletes = new Set<string>();
  /** Mirrors the stored alarm so the hot path never reads storage to check it. */
  private alarmAt: number | null = null;
  /** Last room-wide presence pushed to the clients; -1 means never. */
  private lastPresenceBroadcast = -1;
  /** Messages accepted since the last coalesced flush. Empty when batching is off. */
  private pendingFanout: ServerEvent[] = [];
  private flushScheduled = false;
  /** Messages dropped because a flush could not keep up — reported by `getStats`. */
  private coalesceOverflow = 0;
  private dirty = false;
  private readonly log = createLogger("coordinator", (this.env.LOG_LEVEL as LogLevel) ?? "info");

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Counters and aggregated presence have to survive an eviction, so they are
    // read back before any RPC is allowed to observe (and then overwrite) them.
    ctx.blockConcurrencyWhile(async () => {
      const [config, shards, counters, bans, alarm] = await Promise.all([
        ctx.storage.get<RoomConfig>(KEY_CONFIG),
        ctx.storage.get<unknown>(KEY_SHARDS),
        ctx.storage.get<Counters>(KEY_COUNTERS),
        ctx.storage.get<Array<[string, BanState]>>(KEY_BANS),
        ctx.storage.getAlarm(),
      ]);
      // A room that predates a config field reads back without it; filling it
      // in here means adding a field never breaks a room that already exists.
      this.config = config ? normalizeRoomConfig(config) : null;
      this.registry = new ShardRegistry(decodeShardRecords(shards, Date.now()));
      this.counters = counters ?? { messagesPublished: 0, connections: 0 };
      this.bans = new Map(bans ?? []);
      this.alarmAt = alarm;
    });
  }

  /* ---------------------------------------------------------------- */
  /* configuration                                                     */
  /* ---------------------------------------------------------------- */

  async init(roomId: string): Promise<RoomConfig> {
    const config = await this.load(roomId);
    await this.ensureAlarm();
    return config;
  }

  async getConfig(): Promise<RoomConfig> {
    return this.load();
  }

  async updateConfig(patch: RoomConfigPatch): Promise<RoomConfig> {
    const current = await this.load();
    return this.applyConfigChange(mergeRoomConfig(current, patch), current.shardCount);
  }

  async registerShard(roomId: string, shardIndex: number): Promise<RoomConfig> {
    let config = await this.load(roomId);
    // Registering is also how a shard we isolated earns its way back in.
    this.registry.register(shardIndex, Date.now());
    await this.persistShards();
    if (shardIndex >= config.shardCount) {
      const adoptedCount = Math.min(shardIndex + 1, MAX_SHARD_COUNT);
      if (adoptedCount > config.shardCount) {
        this.log.info("adopting shard opened by edge probing", {
          roomId,
          shard: shardIndex,
          from: config.shardCount,
          to: adoptedCount,
        });
        config = await this.applyConfigChange(
          mergeRoomConfig(config, { shardCount: adoptedCount }),
          config.shardCount,
        );
      }
    }
    await this.ensureAlarm();
    return config;
  }

  async unregisterShard(shardIndex: number): Promise<void> {
    if (!this.registry.unregister(shardIndex)) return;
    this.counters.connections = this.registry.connections();
    await this.persistShards();
  }

  /* ---------------------------------------------------------------- */
  /* fanout                                                            */
  /* ---------------------------------------------------------------- */

  async publish(input: PublishInput): Promise<PublishResult> {
    const config = await this.load(input.message.roomId);
    this.counters.messagesPublished++;
    this.dirty = true;
    // A shard that publishes is demonstrably alive, so it keeps its heartbeat.
    this.registry.touch(input.originShardIndex, Date.now());

    const window = batchWindowOf(config);
    let result: PublishResult;
    if (window > 0) {
      // Deliberately not awaited: the caller is a shard that has not acked its
      // sender yet, so waiting out the coalescing window here would charge the
      // *sender* for a saving made on behalf of the viewers.
      this.queueForFanout({ t: "msg", m: input.message }, window);
      result = { delivered: 0, failedShards: [] };
    } else {
      result = await this.fanout([{ t: "msg", m: input.message }]);
    }

    if (this.counters.messagesPublished % COUNTER_PERSIST_EVERY === 0) {
      await this.ctx.storage.put(KEY_COUNTERS, this.counters);
    }
    await this.ensureAlarm();
    return result;
  }

  /**
   * Holds a message until the window closes, then fans the whole window out in
   * one RPC per shard. 1.000 msg/s across 60 shards is 60.000 calls per second
   * unbatched and 600 at a 100 ms window — the same delivery, two orders of
   * magnitude less Durable Object billing.
   */
  private queueForFanout(event: ServerEvent, windowMs: number): void {
    if (this.pendingFanout.length >= MAX_PENDING_FANOUT) {
      this.pendingFanout.shift();
      this.coalesceOverflow++;
      this.log.warn("coalescing window overflowed, dropping oldest", {
        dropped: this.coalesceOverflow,
      });
    }
    this.pendingFanout.push(event);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    // `waitUntil` keeps the object alive across the timer; the RPC that opened
    // the window has already returned by the time this resolves.
    this.ctx.waitUntil(
      new Promise<void>((resolve) => setTimeout(resolve, windowMs)).then(() => this.flushFanout()),
    );
  }

  private async flushFanout(): Promise<void> {
    this.flushScheduled = false;
    const batch = this.pendingFanout;
    this.pendingFanout = [];
    if (batch.length === 0) return;
    try {
      await this.fanout(batch);
    } catch (error) {
      this.log.error("coalesced fanout failed", { error: String(error), events: batch.length });
    }
  }

  async broadcast(events: ServerEvent[]): Promise<PublishResult> {
    if (events.length === 0) return { delivered: 0, failedShards: [] };
    await this.load();
    return this.fanout(events);
  }

  async banUser(input: BanInput): Promise<void> {
    await this.load(input.roomId);
    this.bans.set(input.userId, {
      reason: input.reason,
      expiresAt: input.expiresAt ?? 0,
      bannedBy: input.bannedBy,
    });
    await this.ctx.storage.put(KEY_BANS, [...this.bans]);
    // Idempotent by construction: kicking a user with no sockets left closes
    // nothing, and a repeat ban still catches sockets opened in between.
    await this.callShards((stub) => stub.kickUsers([input.userId], input.reason));
  }

  async unbanUser(roomId: string, userId: string): Promise<void> {
    await this.load(roomId);
    if (!this.bans.delete(userId)) return;
    await this.ctx.storage.put(KEY_BANS, [...this.bans]);
  }

  async deleteMessages(messageIds: string[], reason: string): Promise<void> {
    if (messageIds.length === 0) return;
    await this.load();
    // Async moderation retries its batches, and a delete already fanned out is
    // pure cost: every shard would re-send it to every socket.
    const fresh = messageIds.filter((id) => !this.recentDeletes.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) this.recentDeletes.add(id);
    this.trimRecentDeletes();
    await this.fanout([{ t: "delete", ids: fresh, reason }]);
  }

  async reportPresence(shardIndex: number, count: number): Promise<void> {
    const now = Date.now();
    if (!this.registry.touch(shardIndex, now, count)) {
      // A shard talking to us is alive; this is how one that outlived a
      // coordinator eviction gets back into the fanout set without reconnects.
      this.registry.register(shardIndex, now);
      this.registry.touch(shardIndex, now, count);
    }
    this.counters.connections = this.registry.connections();
    this.dirty = true;
    await this.ensureAlarm();
  }

  async getStats(): Promise<RoomStats> {
    const config = await this.load();
    const registeredShards = this.registry.all();
    const connections = this.registry.connections();
    return {
      roomId: config.roomId,
      shardCount: config.shardCount,
      registeredShards,
      connections,
      averageSubRoomOccupancy: registeredShards.length > 0 ? connections / registeredShards.length : 0,
      messagesPublished: this.counters.messagesPublished,
      configVersion: config.version,
      updatedAt: Date.now(),
    };
  }

  /* ---------------------------------------------------------------- */
  /* alarm                                                             */
  /* ---------------------------------------------------------------- */

  override async alarm(): Promise<void> {
    this.alarmAt = null;
    const now = Date.now();
    try {
      const expired = this.registry.expire(now - SHARD_HEARTBEAT_TTL_MS);
      if (expired.length > 0) {
        this.dirty = true;
        this.log.info("expired silent shards", { shards: expired });
      }
      this.counters.connections = this.registry.connections();
      await this.publishPresence();
      await this.maybeScale();
      if (this.dirty) await this.persistState();
      await this.refreshRanking();
    } catch (error) {
      this.log.error("coordinator alarm failed", { error: String(error) });
    } finally {
      // An empty room stops ticking; `registerShard` starts it again.
      if (this.registry.size > 0) await this.scheduleAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
  }

  /**
   * The room total, not a shard's slice of it, is the number a viewer wants —
   * so the coordinator is the only publisher of `presence`. Published from the
   * alarm rather than from `reportPresence` so a shard is never blocked waiting
   * on a fanout that reaches back into itself.
   */
  private async publishPresence(): Promise<void> {
    const count = this.counters.connections;
    if (count === this.lastPresenceBroadcast) return;
    this.lastPresenceBroadcast = count;
    await this.fanout([{ t: "presence", count }]);
  }

  /** Ranking is a nice-to-have refresh; it must never cost us the alarm. */
  private async refreshRanking(): Promise<void> {
    const roomId = this.config?.roomId;
    if (!roomId) return;
    try {
      await this.callRanking(roomId);
    } catch (error) {
      this.log.warn("ranking refresh failed", { roomId, error: String(error) });
    }
  }

  /** Single call seam into another slice, so its blast radius stays one line. */
  private callRanking(roomId: string): Promise<unknown> {
    return refreshRoomRanking(this.env, roomId);
  }

  private async maybeScale(): Promise<void> {
    const config = this.config;
    if (!config) return;
    const next = planShardCount({
      shardCount: config.shardCount,
      connections: this.counters.connections,
      maxSocketsPerShard: config.maxSocketsPerShard,
    });
    if (next <= config.shardCount) return;
    this.log.info("growing shard count", {
      roomId: config.roomId,
      from: config.shardCount,
      to: next,
      connections: this.counters.connections,
    });
    await this.applyConfigChange(mergeRoomConfig(config, { shardCount: next }), config.shardCount);
  }

  /* ---------------------------------------------------------------- */
  /* internals                                                         */
  /* ---------------------------------------------------------------- */

  private async load(roomId?: string): Promise<RoomConfig> {
    if (this.config) return this.config;
    if (!roomId) throw new Error("coordinator used before init()");
    const config = defaultRoomConfig(roomId, intVar(this.env.DEFAULT_SHARD_COUNT, 4));
    config.maxSocketsPerShard = intVar(this.env.MAX_SOCKETS_PER_SHARD, 5000);
    this.config = config;
    await this.ctx.storage.put(KEY_CONFIG, config);
    await setShardCount(this.env, config.roomId, config.shardCount);
    return config;
  }

  /**
   * The one place a config change is committed: persist, publish the placement
   * count the edge reads, replicate to the shards, then tell the clients — in
   * that order, so nobody ever sees a version the shards do not have yet.
   */
  private async applyConfigChange(
    next: RoomConfig,
    previousShardCount: number,
  ): Promise<RoomConfig> {
    next.fanout = clampFanout(next.fanout);
    this.config = next;
    await this.ctx.storage.put(KEY_CONFIG, next);
    if (next.shardCount !== previousShardCount) {
      await setShardCount(this.env, next.roomId, next.shardCount);
    }
    await this.callShards((stub) => stub.applyConfig(next));
    await this.fanout([{ t: "config", config: toPublicConfig(next) }]);
    return next;
  }

  private shardStub(roomId: string, index: number): ShardTarget {
    return this.env.CHAT_SHARD.get(this.env.CHAT_SHARD.idFromName(shardName(roomId, index)));
  }

  private async callShards<T>(
    call: (stub: ShardTarget, index: number) => Promise<T>,
  ): Promise<BatchOutcome<T>> {
    const config = await this.load();
    const targets = this.registry.deliverable();
    const outcome = await callInBatches(
      targets,
      (index) => call(this.shardStub(config.roomId, index), index),
      FANOUT_BATCH_SIZE,
    );
    this.accountFor(outcome);
    return outcome;
  }

  private async fanout(events: ServerEvent[]): Promise<PublishResult> {
    if (this.pendingFanout.length > 0) {
      // A delete, a config or a presence change must never overtake a message
      // that is still sitting in the coalescing window ahead of it.
      const queued = this.pendingFanout;
      this.pendingFanout = [];
      events = [...queued, ...events];
    }
    const outcome = await this.callShards((stub) => stub.fanout(events));
    // `delivered` is socket-level: what the shards actually wrote to clients.
    const delivered = outcome.ok.reduce((total, entry) => total + (entry.value ?? 0), 0);
    return { delivered, failedShards: outcome.failed.map((entry) => entry.index) };
  }

  /** Turns call results into heartbeat/suspicion state for the registry. */
  private accountFor<T>(outcome: BatchOutcome<T>): void {
    for (const entry of outcome.ok) this.registry.markSuccess(entry.index);
    for (const entry of outcome.failed) {
      const isolated = this.registry.markFailure(entry.index);
      this.dirty = true;
      this.log.warn(isolated ? "isolating failing shard" : "shard call failed", {
        shard: entry.index,
        error: String(entry.reason),
      });
    }
  }

  private trimRecentDeletes(): void {
    while (this.recentDeletes.size > RECENT_DELETE_MEMORY) {
      const oldest = this.recentDeletes.values().next().value;
      if (oldest === undefined) return;
      this.recentDeletes.delete(oldest);
    }
  }

  private async persistShards(): Promise<void> {
    await this.ctx.storage.put<ShardRecord[]>(KEY_SHARDS, this.registry.snapshot());
  }

  private async persistState(): Promise<void> {
    await this.ctx.storage.put({
      [KEY_SHARDS]: this.registry.snapshot(),
      [KEY_COUNTERS]: this.counters,
    });
    this.dirty = false;
  }

  private async ensureAlarm(): Promise<void> {
    const now = Date.now();
    if (this.alarmAt !== null && this.alarmAt > now) return;
    await this.scheduleAlarm(now + ALARM_INTERVAL_MS);
  }

  private async scheduleAlarm(at: number): Promise<void> {
    this.alarmAt = at;
    await this.ctx.storage.setAlarm(at);
  }
}
