/**
 * The verdict: is the chat actually working right now?
 *
 * A grid of numbers does not answer that question — someone looking at a demo
 * needs one light, and then the reason it is not green. So the rules live here,
 * pure and named, and every failing rule is reported by name instead of being
 * folded into a score nobody can reverse-engineer.
 *
 * Everything is derived from what the room can observe about itself. Nothing
 * here calls Cloudflare: an account-level API that lags minutes cannot tell you
 * whether the room is healthy *now*.
 */

export type HealthLevel = "ok" | "warn" | "down";

export interface HealthCheck {
  id: string;
  label: string;
  level: HealthLevel;
  detail: string;
}

export interface HealthVerdict {
  level: HealthLevel;
  checks: HealthCheck[];
}

/** Above this share of inbound sends being refused, something is wrong. */
export const REJECT_RATE_WARN = 0.25;
/** Buffered messages this old mean the flush path stopped moving. */
export const FLUSH_STALL_MS = 15_000;
/** Round trip a viewer would call sluggish. */
export const PING_WARN_MS = 500;

export interface ShardHealthInput {
  shardIndex: number;
  reachable: boolean;
  connections: number;
  acceptedCount: number;
  rejectedCount: number;
  /** Inbound decisions in the recent window; lifetime counters describe history. */
  recentAccepted: number;
  recentRejected: number;
  recentWindowMs: number;
  bufferedMessages: number;
  /** 0 when this shard has never flushed. */
  lastFlushAt: number;
}

export interface HealthInput {
  now: number;
  coordinatorReachable: boolean;
  registeredShards: readonly number[];
  shards: readonly ShardHealthInput[];
  /** Round-trip measured by the browser on its own socket, when it has one. */
  pingMs?: number | null;
}

const WORST: Record<HealthLevel, number> = { ok: 0, warn: 1, down: 2 };

function worst(levels: readonly HealthLevel[]): HealthLevel {
  return levels.reduce((acc, level) => (WORST[level] > WORST[acc] ? level : acc), "ok");
}

export function evaluateHealth(input: HealthInput): HealthVerdict {
  const checks: HealthCheck[] = [];

  checks.push(
    input.coordinatorReachable
      ? { id: "coordinator", label: "Coordinator", level: "ok", detail: "respondendo" }
      : {
          id: "coordinator",
          label: "Coordinator",
          level: "down",
          detail: "não respondeu — a sala não tem cérebro",
        },
  );

  const silent = input.shards.filter((shard) => !shard.reachable);
  if (input.registeredShards.length === 0) {
    checks.push({
      id: "shards",
      label: "Shards",
      level: "down",
      detail: "nenhum shard registrado na sala",
    });
  } else if (silent.length === input.shards.length && input.shards.length > 0) {
    checks.push({
      id: "shards",
      label: "Shards",
      level: "down",
      detail: `nenhum dos ${input.shards.length} shards respondeu`,
    });
  } else if (silent.length > 0) {
    checks.push({
      id: "shards",
      label: "Shards",
      level: "warn",
      detail: `${silent.length} de ${input.shards.length} mudos (#${silent
        .map((shard) => shard.shardIndex)
        .join(", #")})`,
    });
  } else {
    checks.push({
      id: "shards",
      label: "Shards",
      level: "ok",
      detail: `${input.shards.length} respondendo`,
    });
  }

  /*
   * The window, not the lifetime counters. A verdict answers "is it working
   * now"; a cumulative ratio would keep the light amber long after a bad
   * minute ended, and a light that stays amber is a light nobody reads.
   */
  const accepted = input.shards.reduce((sum, shard) => sum + shard.recentAccepted, 0);
  const rejected = input.shards.reduce((sum, shard) => sum + shard.recentRejected, 0);
  const inbound = accepted + rejected;
  const rate = inbound === 0 ? 0 : rejected / inbound;
  const seconds = Math.round(
    Math.max(0, ...input.shards.map((shard) => shard.recentWindowMs)) / 1000,
  );
  checks.push({
    id: "reject-rate",
    label: "Taxa de rejeição",
    // No traffic is not a failure — an idle room is a healthy room.
    level: inbound === 0 || rate <= REJECT_RATE_WARN ? "ok" : "warn",
    detail:
      inbound === 0
        ? `sem tráfego nos últimos ${seconds || 20}s`
        : `${(rate * 100).toFixed(1)}% (${rejected} de ${inbound}) nos últimos ${seconds}s`,
  });

  // A shard with nothing buffered has nothing to be late about, so only the
  // ones actually holding messages can stall.
  const stalled = input.shards.filter(
    (shard) =>
      shard.bufferedMessages > 0 &&
      shard.lastFlushAt > 0 &&
      input.now - shard.lastFlushAt > FLUSH_STALL_MS,
  );
  const buffered = input.shards.reduce((sum, shard) => sum + shard.bufferedMessages, 0);
  checks.push({
    id: "persistence",
    label: "Fila de persistência",
    level: stalled.length > 0 ? "warn" : "ok",
    detail:
      stalled.length > 0
        ? `${stalled.length} shard(s) com buffer parado há mais de ${FLUSH_STALL_MS / 1000}s`
        : `${buffered} mensagem(ns) aguardando flush`,
  });

  if (typeof input.pingMs === "number") {
    checks.push({
      id: "latency",
      label: "Latência do socket",
      level: input.pingMs > PING_WARN_MS ? "warn" : "ok",
      detail: `${Math.round(input.pingMs)} ms`,
    });
  }

  return { level: worst(checks.map((check) => check.level)), checks };
}
