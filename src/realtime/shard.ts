/**
 * ChatShard — one Durable Object per slice of a room's connections.
 *
 * A single Durable Object cannot hold 300k WebSockets, so the room is split
 * across N shards. Each shard:
 *   1. accepts already-authenticated sockets using the hibernation API,
 *   2. runs the inbound pipeline (rate limit, slow mode, spam, moderation),
 *   3. hands accepted messages to the coordinator exactly once,
 *   4. fans events out locally to its own sockets — the part that is free.
 */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { coordinatorName } from "../shared/ids";
import { newMessageId } from "../shared/ids";
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
  type ChatMessage,
  type ServerEvent,
  type ServerMessage,
} from "../shared/protocol";
import { toPublicConfig, type RoomConfig } from "../shared/room-config";
import { gates } from "../features/registry";
import { createMessageBuffer } from "../features/persistence";
import { enqueueModeration } from "../features/moderation";

/** Serialisable per-socket state; survives hibernation. */
interface SocketAttachment extends ConnectMetadata {}

const ALARM_INTERVAL_MS = 2_000;

export class ChatShard extends DurableObject<Env> implements ShardApi {
  private config: RoomConfig | null = null;
  private roomId = "";
  private shardIndex = 0;
  private buffer: MessageBuffer | null = null;
  private readonly userState = new Map<string, UserGateState>();
  private acceptedCount = 0;
  private rejectedCount = 0;
  private registered = false;
  private readonly log = createLogger("shard", (this.env.LOG_LEVEL as LogLevel) ?? "info");

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Hibernating sockets answer pings without waking the isolate.
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(
        JSON.stringify({ t: "ping" }),
        JSON.stringify({ t: "pong", ts: 0 }),
      ),
    );
  }

  /* ---------------------------------------------------------------- */
  /* connection lifecycle                                              */
  /* ---------------------------------------------------------------- */

  override async fetch(request: Request): Promise<Response> {
    const meta = decodeConnectMetadata(request.headers.get(CONNECT_METADATA_HEADER));
    if (!meta) return new Response("missing connect metadata", { status: 400 });
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    const config = await this.ensureConfig(meta.roomId, meta.shardIndex);

    const sockets = this.ctx.getWebSockets();
    if (sockets.length >= config.maxSocketsPerShard) {
      return new Response("shard full", { status: 503 });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [meta.identity.userId]);
    server.serializeAttachment(meta satisfies SocketAttachment);

    this.userState.set(
      meta.identity.userId,
      this.userState.get(meta.identity.userId) ?? newUserGateState(meta.identity.userId, Date.now()),
    );

    this.send(server, {
      t: "hello",
      v: 1,
      userId: meta.identity.userId,
      name: meta.identity.name,
      roles: meta.identity.roles,
      roomId: meta.roomId,
      shardIndex: meta.shardIndex,
      connectionId: meta.connectionId,
      serverTime: Date.now(),
      config: toPublicConfig(config),
    });

    await this.scheduleAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const meta = ws.deserializeAttachment() as SocketAttachment | null;
    if (!meta) return;
    const config = await this.ensureConfig(meta.roomId, meta.shardIndex);
    const parsed = parseClientMessage(typeof raw === "string" ? raw : null);
    if (!parsed) return;

    if (parsed.t === "ping") {
      this.send(ws, { t: "pong", ts: Date.now() });
      return;
    }
    if (parsed.t === "react") {
      // Reactions are counted by the persistence/ranking slices; the shard just
      // relays them so every client sees the same number.
      await this.coordinator().broadcast([
        { t: "reaction", messageId: parsed.messageId, emoji: parsed.emoji, count: 1 },
      ]);
      return;
    }

    const now = Date.now();
    const state =
      this.userState.get(meta.identity.userId) ??
      newUserGateState(meta.identity.userId, meta.connectedAt);
    this.userState.set(meta.identity.userId, state);
    state.lastSeenAt = now;

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

    const outcome = await runPipeline(gates, ctx, { cid: parsed.cid, body: parsed.body });

    if (outcome.decision.kind === "reject") {
      this.rejectedCount++;
      this.send(ws, {
        t: "rejected",
        cid: parsed.cid,
        code: outcome.decision.code,
        reason: outcome.decision.reason,
        retryAfterMs: outcome.decision.retryAfterMs,
      });
      return;
    }

    const message: ChatMessage = {
      id: newMessageId(now),
      roomId: meta.roomId,
      userId: meta.identity.userId,
      name: meta.identity.name,
      body: outcome.body,
      ts: now,
      roles: meta.identity.roles.length ? meta.identity.roles : undefined,
    };

    state.lastAcceptedAt = now;
    state.acceptedCount++;
    this.acceptedCount++;
    this.send(ws, { t: "ack", cid: parsed.cid, id: message.id, ts: now });

    if (outcome.decision.kind === "shadow") return;

    this.bufferOf(config).add(message);
    await this.coordinator().publish({ message, originShardIndex: meta.shardIndex });

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
        ]),
      );
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    const meta = ws.deserializeAttachment() as SocketAttachment | null;
    if (meta) {
      const stillConnected = this.ctx
        .getWebSockets(meta.identity.userId)
        .filter((socket) => socket !== ws).length;
      if (stillConnected === 0) this.userState.delete(meta.identity.userId);
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  /* ---------------------------------------------------------------- */
  /* RPC surface (called by the coordinator)                           */
  /* ---------------------------------------------------------------- */

  async fanout(events: ServerEvent[]): Promise<number> {
    const sockets = this.ctx.getWebSockets();
    const payloads = events.map(encode);
    let delivered = 0;
    for (const socket of sockets) {
      for (const payload of payloads) {
        try {
          socket.send(payload);
          delivered++;
        } catch {
          /* socket is gone; close handler will clean up */
        }
      }
    }
    return delivered;
  }

  async applyConfig(config: RoomConfig): Promise<void> {
    if (this.config && config.version < this.config.version) return;
    this.config = config;
    this.roomId = config.roomId;
    this.buffer = null;
    await this.ctx.storage.put("config", config);
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
    }
    return closed;
  }

  async muteUsers(userIds: string[], untilMs: number, reason: string): Promise<number> {
    let muted = 0;
    for (const userId of userIds) {
      const state = this.userState.get(userId);
      if (state) {
        state.mutedUntil = Math.max(state.mutedUntil, untilMs);
        muted++;
      }
      for (const socket of this.ctx.getWebSockets(userId)) {
        try {
          socket.send(encode({ t: "sys", code: "muted", reason }));
        } catch {
          /* ignore */
        }
      }
    }
    return muted;
  }

  async deleteMessages(messageIds: string[], reason: string): Promise<void> {
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
    return this.buffer ? this.buffer.flush() : 0;
  }

  /* ---------------------------------------------------------------- */

  override async alarm(): Promise<void> {
    const sockets = this.ctx.getWebSockets();
    if (this.buffer) await this.buffer.flush();
    if (this.roomId) {
      try {
        await this.coordinator().reportPresence(this.shardIndex, sockets.length);
        await this.fanout([{ t: "presence", count: sockets.length }]);
      } catch (error) {
        this.log.warn("presence report failed", { error: String(error) });
      }
    }
    if (sockets.length > 0 || (this.buffer?.size() ?? 0) > 0) await this.scheduleAlarm();
  }

  private async scheduleAlarm(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
  }

  private coordinator() {
    return this.env.ROOM_COORDINATOR.get(
      this.env.ROOM_COORDINATOR.idFromName(coordinatorName(this.roomId)),
    );
  }

  private bufferOf(config: RoomConfig): MessageBuffer {
    this.buffer ??= createMessageBuffer(
      this.env,
      config.roomId,
      this.shardIndex,
      config.persistence,
    );
    return this.buffer;
  }

  private async ensureConfig(roomId: string, shardIndex: number): Promise<RoomConfig> {
    this.roomId = roomId;
    this.shardIndex = shardIndex;
    if (!this.config) {
      this.config = (await this.ctx.storage.get<RoomConfig>("config")) ?? null;
    }
    if (!this.registered || !this.config) {
      const config = await this.coordinator().registerShard(roomId, shardIndex);
      this.config = config;
      this.registered = true;
      await this.ctx.storage.put("config", config);
    }
    return this.config!;
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    try {
      ws.send(encode(message));
    } catch {
      /* socket closed mid-send */
    }
  }
}
