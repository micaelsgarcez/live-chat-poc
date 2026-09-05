/**
 * Fan-in over the shards that are actually holding the room.
 *
 * The audit ring lives in each shard rather than in a central buffer, so the
 * cost of observing is paid by the reader — one console — instead of by the
 * hot path that every message crosses. That is the same trade the rest of the
 * system makes (see `PLAN.md`): never pay per message for something only a few
 * people ever look at.
 *
 * The consequence is that this module is the expensive one: it costs one RPC
 * per registered shard per poll. At demo scale that is nothing; at sixty shards
 * the poll interval is what has to give, not the design.
 */
import type { Env } from "../../env";
import { fnv1a32 } from "../../shared/hash";
import { coordinatorName, shardName } from "../../shared/ids";
import { createLogger, type LogLevel } from "../../shared/logger";
import type { RoomStats } from "../../shared/ports";
import type { FanoutConfig } from "../../shared/room-config";
import {
  decodeAuditCursor,
  encodeAuditCursor,
  mergeAuditEvents,
  type AuditEvent,
  type ShardObservabilityReport,
} from "./audit";
import { evaluateHealth, type HealthVerdict, type ShardHealthInput } from "./health";

/**
 * Ceiling on one poll's payload. A shard's ring holds 250, so a room with sixty
 * shards could otherwise answer a single poll with fifteen thousand events —
 * and a reader that fell behind would ask for exactly that. The newest survive
 * and the rest are counted as dropped, which the console already renders as a
 * visible gap rather than a silent one.
 */
export const MAX_EVENTS_PER_SNAPSHOT = 400;

/** A shard that did not answer still has to appear, or the console lies. */
export interface ShardView extends ShardHealthInput {
  configVersion: number;
  lastFlushCount: number;
  uptimeMs: number;
  auditSize: number;
  error?: string;
}

export interface RoomSnapshot {
  roomId: string;
  scope: FanoutConfig["scope"];
  now: number;
  /** Null when the coordinator itself could not be reached. */
  stats: RoomStats | null;
  shards: ShardView[];
  health: HealthVerdict;
  events: AuditEvent[];
  cursor: string;
  /** Events lost to a hibernated ring since the caller's last cursor. */
  dropped: number;
  /** Whether user ids in `events` are real or pseudonymous. */
  revealed: boolean;
  totals: {
    connections: number;
    accepted: number;
    rejected: number;
    buffered: number;
    /** What the coordinator believes, which lags the shards by a presence tick. */
    coordinatorConnections: number;
    messagesPublished: number;
    shardsRegistered: number;
    shardsReachable: number;
  };
}

export interface CollectOptions {
  /** Opaque cursor from the previous snapshot; empty means "the whole ring". */
  since?: string | null;
  /** True only for a moderator: real user ids instead of pseudonyms. */
  reveal: boolean;
  /** Latency the browser measured on its own socket, passed through. */
  pingMs?: number | null;
  now?: number;
}

/**
 * Stable pseudonym. Stable matters: the point of the audit column is watching
 * one user hit the rate limit five times in a row, which a random id per row
 * would destroy — while still not naming anyone to a non-moderator.
 */
export function pseudonym(userId: string): string {
  // The low bits are the well-mixed ones in FNV-1a; taking the leading hex
  // digits would give sequential ids like `user-1`/`user-2` a shared prefix and
  // quietly leak that they are neighbours.
  return `user_${fnv1a32(userId).toString(16).padStart(8, "0").slice(-6)}`;
}

function anonymize(event: AuditEvent): AuditEvent {
  const masked: AuditEvent = { ...event, userId: pseudonym(event.userId) };
  delete masked.name;
  return masked;
}

export async function collectRoom(
  env: Env,
  roomId: string,
  options: CollectOptions,
): Promise<RoomSnapshot> {
  const log = createLogger("observability", (env.LOG_LEVEL as LogLevel) ?? "info");
  const now = options.now ?? Date.now();
  const cursors = decodeAuditCursor(options.since);

  let stats: RoomStats | null = null;
  let scope: FanoutConfig["scope"] = "room";
  try {
    const coordinator = env.ROOM_COORDINATOR.get(
      env.ROOM_COORDINATOR.idFromName(coordinatorName(roomId)),
    );
    const config = await coordinator.init(roomId);
    scope = config.fanout.scope;
    stats = await coordinator.getStats();
  } catch (error) {
    // A console that throws when the room is broken is useless exactly when it
    // matters, so an unreachable coordinator becomes a red light, not a 500.
    log.warn("coordinator unreachable", { room: roomId, error: String(error) });
  }

  // Only registered shards are asked. A shard that handed its slot back has no
  // sockets and no buffer, and waking it up to say so would cost GB-seconds.
  const indexes = stats?.registeredShards ?? [];
  const reports = await Promise.all(
    indexes.map((shardIndex) => readShard(env, roomId, shardIndex, cursors.get(shardIndex) ?? 0)),
  );

  const shards: ShardView[] = [];
  const eventGroups: AuditEvent[][] = [];
  const nextCursors = new Map<number, number>(cursors);
  let dropped = 0;

  for (const { shardIndex, report, error } of reports) {
    if (!report) {
      shards.push({
        shardIndex,
        reachable: false,
        connections: 0,
        acceptedCount: 0,
        rejectedCount: 0,
        recentAccepted: 0,
        recentRejected: 0,
        recentWindowMs: 0,
        bufferedMessages: 0,
        lastFlushAt: 0,
        configVersion: 0,
        lastFlushCount: 0,
        uptimeMs: 0,
        auditSize: 0,
        error,
      });
      continue;
    }
    shards.push({
      shardIndex,
      reachable: true,
      connections: report.connections,
      acceptedCount: report.acceptedCount,
      rejectedCount: report.rejectedCount,
      recentAccepted: report.recentAccepted,
      recentRejected: report.recentRejected,
      recentWindowMs: report.recentWindowMs,
      bufferedMessages: report.bufferedMessages,
      lastFlushAt: report.lastFlushAt,
      configVersion: report.configVersion,
      lastFlushCount: report.lastFlushCount,
      uptimeMs: report.uptimeMs,
      auditSize: report.audit.events.length,
    });
    eventGroups.push(options.reveal ? report.audit.events : report.audit.events.map(anonymize));
    nextCursors.set(shardIndex, report.audit.cursor);
    dropped += report.audit.dropped;
  }

  shards.sort((a, b) => a.shardIndex - b.shardIndex);

  const health = evaluateHealth({
    now,
    coordinatorReachable: stats !== null,
    registeredShards: indexes,
    shards,
    pingMs: options.pingMs ?? null,
  });

  const merged = mergeAuditEvents(eventGroups);
  const events = merged.slice(-MAX_EVENTS_PER_SNAPSHOT);
  dropped += merged.length - events.length;

  return {
    roomId,
    scope,
    now,
    stats,
    shards,
    health,
    events,
    cursor: encodeAuditCursor(nextCursors),
    dropped,
    revealed: options.reveal,
    totals: {
      // The shards are asked directly, so their sum is live; the coordinator's
      // own count only moves on a presence tick and would show a socket that
      // just connected as absent for a couple of seconds.
      connections:
        shards.some((shard) => shard.reachable)
          ? sum(shards, (shard) => shard.connections)
          : (stats?.connections ?? 0),
      accepted: sum(shards, (shard) => shard.acceptedCount),
      rejected: sum(shards, (shard) => shard.rejectedCount),
      buffered: sum(shards, (shard) => shard.bufferedMessages),
      coordinatorConnections: stats?.connections ?? 0,
      messagesPublished: stats?.messagesPublished ?? 0,
      shardsRegistered: indexes.length,
      shardsReachable: shards.filter((shard) => shard.reachable).length,
    },
  };
}

async function readShard(
  env: Env,
  roomId: string,
  shardIndex: number,
  since: number,
): Promise<{ shardIndex: number; report: ShardObservabilityReport | null; error?: string }> {
  try {
    const stub = env.CHAT_SHARD.get(env.CHAT_SHARD.idFromName(shardName(roomId, shardIndex)));
    return { shardIndex, report: await stub.getObservability(since) };
  } catch (error) {
    // One mute shard must not blank the other fifty-nine.
    return { shardIndex, report: null, error: String(error) };
  }
}

function sum<T>(items: readonly T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0);
}
