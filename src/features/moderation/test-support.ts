/**
 * Test-only helpers for this slice. Kept out of `index.ts` so the public surface
 * stays exactly what the registry and the other slices import.
 */
import type { ModerationJob } from "../../shared/ports";
import { defaultRoomConfig, type ModerationConfig, type RoomConfig } from "../../shared/room-config";
import { newUserGateState, type GateContext } from "../../shared/pipeline";
import schema from "../../../migrations/0001_init.sql?raw";

/** The pool gives each test file an empty D1; apply the real migration to it. */
export async function applyLocalSchema(db: D1Database): Promise<void> {
  const statements = schema
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  for (const statement of statements) await db.prepare(statement).run();
}

export function testConfig(
  roomId: string,
  moderation: Partial<ModerationConfig> = {},
): RoomConfig {
  const config = defaultRoomConfig(roomId, 1);
  config.moderation = { ...config.moderation, ...moderation };
  return config;
}

export function testContext(config: RoomConfig, roles: string[] = []): GateContext {
  const now = Date.now();
  return {
    now,
    clock: { now: () => now },
    roomId: config.roomId,
    shardIndex: 0,
    identity: { userId: "u1", name: "u1", roles, expiresAt: 0 },
    config,
    state: newUserGateState("u1", now),
    privileged: roles.some((role) => config.privilegedRoles.includes(role)),
  };
}

export interface FakeBatch {
  batch: MessageBatch<ModerationJob>;
  acked: string[];
  retried: string[];
}

/** A `MessageBatch` the consumer can be driven with directly: the pool cannot
 *  deliver a real queue message to a consumer inside a test. */
export function fakeBatch(queue: string, bodies: unknown[]): FakeBatch {
  const acked: string[] = [];
  const retried: string[] = [];
  const messages = bodies.map((body, index) => {
    const id = `msg-${index}`;
    return {
      id,
      timestamp: new Date(),
      body: body as ModerationJob,
      attempts: 1,
      ack: () => void acked.push(id),
      retry: () => void retried.push(id),
    } satisfies Message<ModerationJob>;
  });
  return {
    acked,
    retried,
    batch: {
      queue,
      messages,
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      ackAll: () => messages.forEach((m) => m.ack()),
      retryAll: () => messages.forEach((m) => m.retry()),
    },
  };
}
