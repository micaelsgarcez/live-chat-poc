/**
 * ChatShard — one Durable Object per slice of a room's connections.
 *
 * A single Durable Object cannot hold 300k WebSockets, so the room is split
 * across N shards. Each shard:
 *   1. accepts already-authenticated sockets using the hibernation API,
 *   2. runs the inbound pipeline (rate limit, slow mode, spam, moderation),
 *   3. hands accepted messages to the coordinator exactly once,
 *   4. fans events out locally to its own sockets — the part that is free.
 *
 * Three constraints shape everything below:
 *
 *   - **Hibernation.** The isolate is evicted whenever the shard goes quiet;
 *     the sockets survive, the in-memory maps do not. Anything a user could
 *     *gain* from that reset is mirrored into `ctx.storage`
 *     (see `shard/user-state.ts` for exactly what, and what is dropped).
 *   - **GB-seconds.** An alarm is the one thing that can keep a shard billable
 *     while nobody is talking, so one is scheduled only when there is pending
 *     work — buffered messages, unpersisted user state, sockets whose presence
 *     is worth refreshing — and the last tick deliberately leaves no successor.
 *   - **Blast radius.** An unhandled throw in a Durable Object tears down the
 *     isolate and every socket on it, so every entry point here is total: it
 *     logs and degrades instead of propagating.
 */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { intVar } from "../env";
import { RejectCode } from "../shared/errors";
import { coordinatorName, newMessageId } from "../shared/ids";
import {
  CONNECT_METADATA_HEADER,
  decodeConnectMetadata,
  hasRole,
  type ConnectMetadata,
} from "../shared/identity";
import { createLogger, type LogLevel } from "../shared/logger";
import {
  newUserGateState,
  runPipeline,
  type GateContext,
  type UserGateState,
} from "../shared/pipeline";
import type { MessageBuffer, ShardApi, ShardStats } from "../shared/ports";
import {
  encode,
  parseClientMessage,
  PROTOCOL_VERSION,
  type ChatMessage,
  type ClientReact,
  type ClientSend,
  type ServerEvent,
  type ServerMessage,
} from "../shared/protocol";
import { defaultRoomConfig, toPublicConfig, type RoomConfig } from "../shared/room-config";
import { gates } from "../features/registry";
import { createMessageBuffer } from "../features/persistence";
import { enqueueModeration } from "../features/moderation";
import { decidePresence, type PresenceSnapshot } from "./shard/presence";
import { RecentMessages } from "./shard/recent-messages";
import {
  hasPersistableState,
  isExpiredSnapshot,
  restoreUserState,
  snapshotUserState,
  userStateKey,
  USER_STATE_PREFIX,
  type PersistedUserState,
} from "./shard/user-state";

/** Serialisable per-socket state; survives hibernation. */
interface SocketAttachment extends ConnectMetadata {}

interface ShardMeta {
  roomId: string;
  shardIndex: number;
  /** Whether the coordinator still lists this shard. */
  registered: boolean;
}

interface ShardCounters {
  accepted: number;
  rejected: number;
}

const KEY_META = "meta";
const KEY_CONFIG = "config";
const KEY_COUNTERS = "counters";

/** Tick used while something is pending (a flush, an unregister, dirty state). */
const ACTIVE_ALARM_MS = 2_000;
/** Heartbeat while sockets are open but nothing is pending. */
const IDLE_ALARM_MS = 30_000;
/** Never chain two alarms closer than this, whatever the deadlines say. */
const MIN_ALARM_MS = 250;
/** How long the coordinator's copy of our presence may go unrefreshed. */
const PRESENCE_MAX_SILENCE_MS = 30_000;
/** Dirty user state is written in batches, not per message. */
const USER_STATE_FLUSH_MS = 10_000;
/** Storage puts/deletes accept at most 128 keys per call. */
const STORAGE_BATCH = 128;
const USER_STATE_TTL_MS = 10 * 60_000;
const USER_STATE_PRUNE_INTERVAL_MS = 60_000;
const USER_STATE_SCAN_LIMIT = 2_000;
/** Cap on retained snapshots; the oldest disconnected users lose theirs first. */
const MAX_PERSISTED_USERS = 5_000;
/** Give up on handing the slot back rather than keep an empty shard awake. */
const MAX_UNREGISTER_ATTEMPTS = 5;

export class ChatShard extends DurableObject<Env> implements ShardApi {
  private config: RoomConfig | null = null;
  private roomId = "";
  private shardIndex = 0;
  private buffer: MessageBuffer | null = null;
  private readonly userState = new Map<string, UserGateState>();
  /** Window used to resolve a reply without I/O; see `recent-messages.ts`. */
  private readonly recent = new RecentMessages();
  /** Users whose state changed since the last storage write. */
  private readonly dirtyUsers = new Set<string>();
  private acceptedCount = 0;
  private rejectedCount = 0;
  private countersDirty = false;
  private registered = false;
  /** Mirrors the scheduled alarm so the hot path never reads storage for it. */
  private alarmAt: number | null = null;
  private nextUserFlushAt = 0;
  private nextPruneAt = 0;
  private unregisterAttempts = 0;
  private lastPresence: PresenceSnapshot | null = null;
  private readonly log = createLogger("shard", (this.env.LOG_LEVEL as LogLevel) ?? "info");

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Hibernating sockets answer pings without waking the isolate at all.
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(
        JSON.stringify({ t: "ping" }),
        JSON.stringify({ t: "pong", ts: 0 }),
      ),
    );
    // Everything below (`fetch`, `alarm`, RPC) assumes the identity, config and
    // counters left behind by the previous isolate are already loaded.
    void this.ctx
      .blockConcurrencyWhile(() => this.restore())
      .catch((error: unknown) => this.log.error("restore blocked", { error: String(error) }));
  }

  /* ---------------------------------------------------------------- */
  /* connection lifecycle                                              */
  /* ---------------------------------------------------------------- */

  override async fetch(request: Request): Promise<Response> {
    try {
      const meta = decodeConnectMetadata(request.headers.get(CONNECT_METADATA_HEADER));
      if (!meta) return new Response("missing connect metadata", { status: 400 });
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }

      const config = await this.ensureConfig(meta.roomId, meta.shardIndex);

      // Backpressure: the edge hashes blindly, so the shard is the only place
      // that knows it is full. Refusing here makes the client retry rather than
      // degrading every socket already on this isolate.
      if (this.ctx.getWebSockets().length >= config.maxSocketsPerShard) {
        this.log.warn("shard full", { room: meta.roomId, shard: meta.shardIndex });
        return new Response("shard full", { status: 503 });
      }

      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.ctx.acceptWebSocket(server, [meta.identity.userId]);
      server.serializeAttachment(meta satisfies SocketAttachment);

      this.send(server, {
        t: "hello",
        v: PROTOCOL_VERSION,
        userId: meta.identity.userId,
        name: meta.identity.name,
        roles: meta.identity.roles,
        roomId: meta.roomId,
        shardIndex: meta.shardIndex,
        connectionId: meta.connectionId,
        serverTime: Date.now(),
        config: toPublicConfig(config),
      });

      await this.scheduleNextAlarm();
      return new Response(null, { status: 101, webSocket: client });
    } catch (error) {
      this.log.error("upgrade failed", { error: String(error) });
      return new Response("shard unavailable", { status: 503 });
    }
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    try {
      await this.handleFrame(ws, raw);
    } catch (error) {
      // Losing one frame is survivable; letting it escape kills every socket.
      this.log.error("frame handling failed", { error: String(error), room: this.roomId });
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    try {
      const meta = ws.deserializeAttachment() as SocketAttachment | null;
      if (meta) {
        const userId = meta.identity.userId;
        const others = this.ctx.getWebSockets(userId).filter((socket) => socket !== ws);
        if (others.length === 0) {
          // Persist before dropping: reconnecting must not reset the bucket or
          // shake off a mute, and the edge sends this user back to this shard.
          await this.persistUsers([userId]);
          this.userState.delete(userId);
          this.dirtyUsers.delete(userId);
        }
      }
      if (this.ctx.getWebSockets().every((socket) => socket === ws)) {
        // Last socket: come back soon to flush and hand the slot back.
        await this.setAlarmAt(Date.now() + ACTIVE_ALARM_MS);
      } else {
        await this.scheduleNextAlarm();
      }
    } catch (error) {
      this.log.warn("close handling failed", { error: String(error) });
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  /* ---------------------------------------------------------------- */
  /* inbound frames                                                    */
  /* ---------------------------------------------------------------- */

  private async handleFrame(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const meta = ws.deserializeAttachment() as SocketAttachment | null;
    if (!meta) {
      // A socket with no attachment can never be served; nothing to salvage.
      ws.close(1011, "unknown connection");
      return;
    }

    const config = await this.ensureConfig(meta.roomId, meta.shardIndex);
    const parsed = parseClientMessage(typeof raw === "string" ? raw : null);
    if (!parsed) {
      // Garbage in is not a reason to drop a connection — tell the client and
      // keep the socket, otherwise one bad frame costs it a reconnect.
      this.send(ws, { t: "sys", code: "malformed", reason: "unparseable frame" });
      return;
    }

    switch (parsed.t) {
      case "ping":
        this.send(ws, { t: "pong", ts: parsed.ts ?? Date.now() });
        return;
      case "react":
        await this.handleReaction(ws, meta, config, parsed);
        return;
      case "send":
        await this.handleSend(ws, meta, config, parsed);
        return;
    }
  }

  private async handleSend(
    ws: WebSocket,
    meta: SocketAttachment,
    config: RoomConfig,
    parsed: ClientSend,
  ): Promise<void> {
    const now = Date.now();
    const state = await this.userStateFor(meta, now);
    state.lastSeenAt = now;
    this.markUserDirty(meta.identity.userId, now);

    const ctx: GateContext = {
      now,
      clock: { now: () => now },
      roomId: meta.roomId,
      shardIndex: meta.shardIndex,
      identity: meta.identity,
      config,
      state,
      privileged: hasRole(meta.identity, config.privilegedRoles),
    };

    let body: string;
    let shadowed = false;
    try {
      const outcome = await runPipeline(gates, ctx, { cid: parsed.cid, body: parsed.body });
      if (outcome.decision.kind === "reject") {
        this.rejectFrame(
          ws,
          parsed.cid,
          outcome.decision.code,
          outcome.decision.reason,
          outcome.decision.retryAfterMs,
        );
        return;
      }
      shadowed = outcome.decision.kind === "shadow";
      body = outcome.body;
    } catch (error) {
      // A gate that throws must not look like an accepted message.
      this.log.error("pipeline failed", { error: String(error), room: meta.roomId });
      this.rejectFrame(ws, parsed.cid, RejectCode.INTERNAL, "could not process the message");
      return;
    }

    const message: ChatMessage = {
      id: newMessageId(now),
      roomId: meta.roomId,
      userId: meta.identity.userId,
      name: meta.identity.name,
      body,
      ts: now,
      roles: meta.identity.roles.length ? meta.identity.roles : undefined,
    };
    // Resolved from what this shard saw, never from what the client claimed.
    const replyTo = this.recent.resolve(parsed.replyTo);
    if (replyTo) message.replyTo = replyTo;

    // Shadowed messages are accepted for the sender and go no further: no
    // broadcast, no persistence, no moderation job.
    if (!shadowed) {
      try {
        await this.coordinator().publish({ message, originShardIndex: meta.shardIndex });
      } catch (error) {
        this.log.error("publish failed", { error: String(error), room: meta.roomId });
        this.rejectFrame(ws, parsed.cid, RejectCode.INTERNAL, "could not deliver the message");
        return;
      }
    }

    state.lastAcceptedAt = now;
    state.acceptedCount++;
    this.acceptedCount++;
    this.countersDirty = true;
    this.markUserDirty(meta.identity.userId, now);
    this.send(ws, { t: "ack", cid: parsed.cid, id: message.id, ts: now });
    if (shadowed) return;

    this.bufferMessage(config, message, now);

    if (config.moderation.asyncEnabled && Math.random() < config.moderation.asyncSampleRate) {
      this.ctx.waitUntil(
        enqueueModeration(this.env, [
          {
            roomId: message.roomId,
            messageId: message.id,
            userId: message.userId,
            body: message.body,
            ts: message.ts,
          },
        ]).catch((error: unknown) =>
          this.log.warn("moderation enqueue failed", { error: String(error) }),
        ),
      );
    }

    await this.setAlarmAt(Date.now() + ACTIVE_ALARM_MS);
  }

  /**
   * Reactions carry no body to moderate and no message to acknowledge, so they
   * skip the pipeline entirely and never produce an `ack`: they only ride the
   * persistence batch (ranking counts them) and get relayed so every client
   * converges on the same number.
   */
  private async handleReaction(
    ws: WebSocket,
    meta: SocketAttachment,
    config: RoomConfig,
    parsed: ClientReact,
  ): Promise<void> {
    const privileged = hasRole(meta.identity, config.privilegedRoles);
    if (config.closed && !privileged) {
      this.rejectFrame(ws, parsed.cid, RejectCode.ROOM_CLOSED, "the room is closed");
      return;
    }
    // Only warm state is consulted: a reaction is not worth a storage read on
    // the way in, and a mute that matters is re-learned on the next `send`.
    const state = this.userState.get(meta.identity.userId);
    const now = Date.now();
    if (!privileged && state && state.mutedUntil > now) {
      this.rejectFrame(
        ws,
        parsed.cid,
        RejectCode.MUTED,
        "you are temporarily muted",
        state.mutedUntil - now,
      );
      return;
    }

    try {
      this.bufferOf(config).addReaction({
        roomId: meta.roomId,
        messageId: parsed.messageId,
        userId: meta.identity.userId,
        emoji: parsed.emoji,
        ts: now,
      });
    } catch (error) {
      this.log.warn("reaction buffering failed", { error: String(error) });
    }

    try {
      await this.coordinator().broadcast([
        { t: "reaction", messageId: parsed.messageId, emoji: parsed.emoji, count: 1 },
      ]);
    } catch (error) {
      this.log.error("reaction broadcast failed", { error: String(error) });
      this.rejectFrame(ws, parsed.cid, RejectCode.INTERNAL, "could not deliver the reaction");
      return;
    }

    await this.setAlarmAt(Date.now() + ACTIVE_ALARM_MS);
  }

  /* ---------------------------------------------------------------- */
  /* RPC surface (called by the coordinator)                           */
  /* ---------------------------------------------------------------- */

  /** Returns how many sockets received the whole batch. */
  async fanout(events: ServerEvent[]): Promise<number> {
    if (events.length === 0) return 0;
    for (const event of events) {
      if (event.t === "msg") this.recent.remember(event.m);
      else if (event.t === "delete") this.recent.forget(event.ids);
    }
    let payloads: string[];
    try {
      payloads = events.map(encode);
    } catch (error) {
      this.log.error("unencodable event", { error: String(error) });
      return 0;
    }

    let delivered = 0;
    for (const socket of this.ctx.getWebSockets()) {
      let ok = true;
      for (const payload of payloads) {
        try {
          socket.send(payload);
        } catch {
          // A dead socket must not cost the rest of the shard its delivery;
          // the close handler cleans it up.
          ok = false;
        }
      }
      if (ok) delivered++;
    }
    return delivered;
  }

  async applyConfig(config: RoomConfig): Promise<void> {
    try {
      await this.adoptConfig(config);
    } catch (error) {
      this.log.error("applyConfig failed", { error: String(error) });
    }
  }

  async kickUsers(userIds: string[], reason: string): Promise<number> {
    let closed = 0;
    for (const userId of userIds) {
      for (const socket of this.ctx.getWebSockets(userId)) {
        try {
          socket.send(encode({ t: "sys", code: "banned", reason }));
          socket.close(4403, reason);
          closed++;
        } catch {
          /* already gone */
        }
      }
      this.userState.delete(userId);
      this.dirtyUsers.delete(userId);
      // A kicked user keeps no penalty state: the ban itself now gates them.
      try {
        await this.ctx.storage.delete(userStateKey(userId));
      } catch (error) {
        this.log.warn("dropping user state failed", { error: String(error), userId });
      }
    }
    return closed;
  }

  async muteUsers(userIds: string[], untilMs: number, reason: string): Promise<number> {
    let muted = 0;
    const now = Date.now();
    for (const userId of userIds) {
      try {
        const connected = this.ctx.getWebSockets(userId);
        const state = await this.loadUserState(userId, now);
        state.mutedUntil = Math.max(state.mutedUntil, untilMs);
        // A mute has to survive hibernation and a reconnect, so it is written
        // through immediately instead of waiting for the next batch.
        await this.ctx.storage.put(userStateKey(userId), snapshotUserState(state, now));
        if (connected.length > 0) this.userState.set(userId, state);
        muted++;
        for (const socket of connected) {
          try {
            socket.send(encode({ t: "sys", code: "muted", reason }));
          } catch {
            /* socket is gone */
          }
        }
      } catch (error) {
        this.log.warn("mute failed", { error: String(error), userId });
      }
    }
    return muted;
  }

  async deleteMessages(messageIds: string[], reason: string): Promise<void> {
    if (messageIds.length === 0) return;
    await this.fanout([{ t: "delete", ids: messageIds, reason }]);
  }

  async getStats(): Promise<ShardStats> {
    return {
      roomId: this.roomId,
      shardIndex: this.shardIndex,
      connections: this.ctx.getWebSockets().length,
      bufferedMessages: this.buffer?.size() ?? 0,
      configVersion: this.config?.version ?? 0,
      acceptedCount: this.acceptedCount,
      rejectedCount: this.rejectedCount,
    };
  }

  async flushNow(): Promise<number> {
    return this.flushBuffer();
  }

  /* ---------------------------------------------------------------- */
  /* alarm                                                             */
  /* ---------------------------------------------------------------- */

  override async alarm(): Promise<void> {
    this.alarmAt = null;
    try {
      await this.tick();
    } catch (error) {
      this.log.error("alarm failed", { error: String(error), room: this.roomId });
    }
    // Rescheduling happens even after a failed tick: otherwise one bad flush
    // would strand the buffer and the registration forever.
    try {
      await this.scheduleNextAlarm();
    } catch (error) {
      this.log.error("alarm rescheduling failed", { error: String(error) });
    }
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    const connections = this.ctx.getWebSockets().length;

    await this.flushBuffer();
    if (this.dirtyUsers.size > 0 && now >= this.nextUserFlushAt) {
      await this.persistUsers([...this.dirtyUsers]);
    }
    await this.persistCounters();
    await this.refreshPresence(connections, now);
    await this.pruneUserState(now);

    // Nothing left to hold: hand the slot back so the coordinator stops
    // fanning out to a shard with no sockets.
    if (connections === 0 && (this.buffer?.size() ?? 0) === 0) {
      await this.releaseRegistration();
    }
  }

  private async refreshPresence(count: number, now: number): Promise<void> {
    if (!this.roomId) return;
    const decision = decidePresence(count, this.lastPresence, now, PRESENCE_MAX_SILENCE_MS);
    if (!decision.report) return;
    try {
      // Only the coordinator publishes `presence`: this shard's socket count is
      // a fraction of the room and would be the wrong number to show anyone.
      await this.coordinator().reportPresence(this.shardIndex, count);
      this.lastPresence = { count, at: now };
    } catch (error) {
      this.log.warn("presence report failed", { error: String(error), shard: this.shardIndex });
    }
  }

  /**
   * The alarm exists to serve pending work, so it is scheduled from deadlines
   * rather than on a fixed cadence: when there is nothing to flush, nothing to
   * persist and no socket to report, no successor is scheduled and the shard
   * stops costing anything.
   */
  private async scheduleNextAlarm(): Promise<void> {
    const now = Date.now();
    const connections = this.ctx.getWebSockets().length;
    const buffered = this.buffer?.size() ?? 0;
    const deadlines: number[] = [];

    if (buffered > 0) {
      deadlines.push(now + Math.max(MIN_ALARM_MS, this.config?.persistence.flushIntervalMs ?? ACTIVE_ALARM_MS));
    }
    if (this.dirtyUsers.size > 0) deadlines.push(this.nextUserFlushAt);
    if (this.countersDirty) deadlines.push(now + ACTIVE_ALARM_MS);
    if (connections > 0) deadlines.push(now + IDLE_ALARM_MS);
    if (connections === 0 && this.registered) deadlines.push(now + ACTIVE_ALARM_MS);
    if (deadlines.length === 0) return;

    await this.setAlarmAt(Math.max(now + MIN_ALARM_MS, Math.min(...deadlines)));
  }

  private async setAlarmAt(at: number): Promise<void> {
    if (this.alarmAt !== null && this.alarmAt <= at) return;
    await this.ctx.storage.setAlarm(at);
    this.alarmAt = at;
  }

  /* ---------------------------------------------------------------- */
  /* state, config and registration                                    */
  /* ---------------------------------------------------------------- */

  private async restore(): Promise<void> {
    try {
      const stored = await this.ctx.storage.get<unknown>([KEY_META, KEY_CONFIG, KEY_COUNTERS]);
      const meta = stored.get(KEY_META) as ShardMeta | undefined;
      if (meta) {
        this.roomId = meta.roomId;
        this.shardIndex = meta.shardIndex;
        this.registered = meta.registered;
      }
      this.config = (stored.get(KEY_CONFIG) as RoomConfig | undefined) ?? null;
      const counters = stored.get(KEY_COUNTERS) as ShardCounters | undefined;
      if (counters) {
        this.acceptedCount = counters.accepted;
        this.rejectedCount = counters.rejected;
      }
      this.alarmAt = await this.ctx.storage.getAlarm();
    } catch (error) {
      // A shard that cannot read its own storage still has to serve sockets.
      this.log.error("restore failed", { error: String(error) });
    }
  }

  private async ensureConfig(roomId: string, shardIndex: number): Promise<RoomConfig> {
    this.roomId = roomId;
    this.shardIndex = shardIndex;
    if (this.config && this.registered) return this.config;

    try {
      // Registering is idempotent and returns the authoritative config, so it
      // doubles as the "first connection on this shard" hook.
      const config = await this.coordinator().registerShard(roomId, shardIndex);
      this.registered = true;
      await this.persistMeta();
      return this.adoptConfig(config);
    } catch (error) {
      this.log.error("shard registration failed", { error: String(error), room: roomId });
      // Degrade to defaults rather than refusing every socket on the shard.
      if (!this.config) {
        const fallback = defaultRoomConfig(roomId, intVar(this.env.DEFAULT_SHARD_COUNT, 4));
        fallback.maxSocketsPerShard = intVar(this.env.MAX_SOCKETS_PER_SHARD, 5000);
        this.config = fallback;
      }
      return this.config;
    }
  }

  /** Applies a config unless it is older than the one already held. */
  private async adoptConfig(next: RoomConfig): Promise<RoomConfig> {
    const current = this.config;
    if (current && next.version < current.version) return current;

    const persistenceChanged =
      !current || JSON.stringify(current.persistence) !== JSON.stringify(next.persistence);
    this.config = next;
    this.roomId = next.roomId || this.roomId;
    if (persistenceChanged && this.buffer) {
      // Rebuilding the buffer must not silently drop what it already holds.
      await this.flushBuffer();
      this.buffer = null;
    }
    await this.ctx.storage.put(KEY_CONFIG, next);
    return next;
  }

  private async releaseRegistration(): Promise<void> {
    if (!this.registered) return;
    try {
      await this.coordinator().unregisterShard(this.shardIndex);
      this.registered = false;
      this.unregisterAttempts = 0;
      // The coordinator forgot our presence with the registration; make sure
      // the next one is reported rather than throttled away as "unchanged".
      this.lastPresence = null;
      await this.persistMeta();
    } catch (error) {
      this.unregisterAttempts++;
      this.log.warn("unregister failed", {
        error: String(error),
        shard: this.shardIndex,
        attempt: this.unregisterAttempts,
      });
      // Retrying forever would keep an empty shard billable. After a few tries
      // we stop: the coordinator tolerates a shard that no longer answers, and
      // the next connection re-registers this one anyway.
      if (this.unregisterAttempts >= MAX_UNREGISTER_ATTEMPTS) {
        this.registered = false;
        this.unregisterAttempts = 0;
        await this.persistMeta().catch(() => undefined);
      }
    }
  }

  private async persistMeta(): Promise<void> {
    await this.ctx.storage.put(KEY_META, {
      roomId: this.roomId,
      shardIndex: this.shardIndex,
      registered: this.registered,
    } satisfies ShardMeta);
  }

  private async persistCounters(): Promise<void> {
    if (!this.countersDirty) return;
    try {
      await this.ctx.storage.put(KEY_COUNTERS, {
        accepted: this.acceptedCount,
        rejected: this.rejectedCount,
      } satisfies ShardCounters);
      this.countersDirty = false;
    } catch (error) {
      this.log.warn("counter persistence failed", { error: String(error) });
    }
  }

  private userIdOf(socket: WebSocket): string | null {
    const meta = socket.deserializeAttachment() as SocketAttachment | null;
    return meta?.identity.userId ?? null;
  }

  private async userStateFor(meta: SocketAttachment, now: number): Promise<UserGateState> {
    const existing = this.userState.get(meta.identity.userId);
    if (existing) return existing;
    const state = await this.loadUserState(meta.identity.userId, now, meta.connectedAt);
    this.userState.set(meta.identity.userId, state);
    return state;
  }

  /** Rehydrates a user from storage, or starts them fresh. Never throws. */
  private async loadUserState(
    userId: string,
    now: number,
    connectedAt = now,
  ): Promise<UserGateState> {
    const cached = this.userState.get(userId);
    if (cached) return cached;
    try {
      const snapshot = await this.ctx.storage.get<PersistedUserState>(userStateKey(userId));
      if (snapshot) return restoreUserState(userId, snapshot, now);
    } catch (error) {
      this.log.warn("user state rehydration failed", { error: String(error), userId });
    }
    return newUserGateState(userId, connectedAt || now);
  }

  private markUserDirty(userId: string, now: number): void {
    this.dirtyUsers.add(userId);
    if (this.nextUserFlushAt === 0) this.nextUserFlushAt = now + USER_STATE_FLUSH_MS;
  }

  private async persistUsers(userIds: readonly string[]): Promise<void> {
    const now = Date.now();
    const entries: Array<[string, PersistedUserState]> = [];
    for (const userId of userIds) {
      const state = this.userState.get(userId);
      if (!state || !hasPersistableState(state)) {
        this.dirtyUsers.delete(userId);
        continue;
      }
      entries.push([userStateKey(userId), snapshotUserState(state, now)]);
    }

    try {
      for (let i = 0; i < entries.length; i += STORAGE_BATCH) {
        await this.ctx.storage.put(Object.fromEntries(entries.slice(i, i + STORAGE_BATCH)));
      }
      for (const userId of userIds) this.dirtyUsers.delete(userId);
      if (this.dirtyUsers.size === 0) this.nextUserFlushAt = 0;
      else this.nextUserFlushAt = now + USER_STATE_FLUSH_MS;
    } catch (error) {
      // Leave them dirty; the next tick retries.
      this.log.warn("user state persistence failed", { error: String(error) });
    }
  }

  /**
   * Snapshots are the only thing the shard keeps forever, so they are pruned:
   * expired ones go first, then the oldest ones once the cap is reached. A
   * connected user is never pruned — their penalties are still live.
   */
  private async pruneUserState(now: number): Promise<void> {
    if (now < this.nextPruneAt) return;
    this.nextPruneAt = now + USER_STATE_PRUNE_INTERVAL_MS;
    try {
      const stored = await this.ctx.storage.list<PersistedUserState>({
        prefix: USER_STATE_PREFIX,
        limit: USER_STATE_SCAN_LIMIT,
      });
      if (stored.size === 0) return;

      const connected = new Set<string>();
      for (const socket of this.ctx.getWebSockets()) {
        const userId = this.userIdOf(socket);
        if (userId) connected.add(userId);
      }

      const survivors: Array<{ key: string; updatedAt: number }> = [];
      const doomed: string[] = [];
      for (const [key, snapshot] of stored) {
        if (connected.has(key.slice(USER_STATE_PREFIX.length))) continue;
        if (isExpiredSnapshot(snapshot, now, USER_STATE_TTL_MS)) doomed.push(key);
        else survivors.push({ key, updatedAt: snapshot.updatedAt });
      }
      if (survivors.length > MAX_PERSISTED_USERS) {
        survivors.sort((a, b) => a.updatedAt - b.updatedAt);
        for (const victim of survivors.slice(0, survivors.length - MAX_PERSISTED_USERS)) {
          doomed.push(victim.key);
        }
      }

      for (let i = 0; i < doomed.length; i += STORAGE_BATCH) {
        await this.ctx.storage.delete(doomed.slice(i, i + STORAGE_BATCH));
      }
      if (doomed.length > 0) this.log.debug("pruned user state", { count: doomed.length });
    } catch (error) {
      this.log.warn("user state pruning failed", { error: String(error) });
    }
  }

  /* ---------------------------------------------------------------- */
  /* buffer + socket helpers                                           */
  /* ---------------------------------------------------------------- */

  private coordinator() {
    return this.env.ROOM_COORDINATOR.get(
      this.env.ROOM_COORDINATOR.idFromName(coordinatorName(this.roomId)),
    );
  }

  private bufferOf(config: RoomConfig): MessageBuffer {
    this.buffer ??= createMessageBuffer(this.env, config.roomId, this.shardIndex, config.persistence);
    return this.buffer;
  }

  private bufferMessage(config: RoomConfig, message: ChatMessage, now: number): void {
    try {
      const buffer = this.bufferOf(config);
      if (!buffer.add(message)) {
        // The message is already broadcast; only durability is lost.
        this.log.warn("persistence buffer full", { room: message.roomId, id: message.id });
        return;
      }
      if (buffer.shouldFlush(now)) this.ctx.waitUntil(this.flushBuffer());
    } catch (error) {
      this.log.warn("buffering failed", { error: String(error), id: message.id });
    }
  }

  private async flushBuffer(): Promise<number> {
    if (!this.buffer) return 0;
    try {
      return await this.buffer.flush();
    } catch (error) {
      this.log.error("buffer flush failed", { error: String(error), room: this.roomId });
      return 0;
    }
  }

  private rejectFrame(
    ws: WebSocket,
    cid: string,
    code: RejectCode,
    reason: string,
    retryAfterMs?: number,
  ): void {
    this.rejectedCount++;
    this.countersDirty = true;
    this.send(ws, { t: "rejected", cid, code, reason, retryAfterMs });
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    try {
      ws.send(encode(message));
    } catch {
      /* socket closed mid-send */
    }
  }
}
