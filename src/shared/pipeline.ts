/**
 * The inbound message pipeline.
 *
 * Every rule a slice contributes is a `MessageGate`. The shard composes them in
 * a fixed order (see `src/features/registry.ts`) and runs them in sequence for
 * each inbound `send`. The first non-`allow` decision wins and nothing is
 * broadcast or persisted.
 *
 * Gates are pure with respect to everything except `ctx.state`, which is the
 * shard's per-user scratch space. That keeps them cheap (no I/O, no round
 * trips) and unit-testable without a Durable Object.
 */
import type { Identity } from "./identity";
import type { RoomConfig } from "./room-config";
import type { RejectCode } from "./errors";
import type { Clock } from "./time";

/** Per-user, per-shard mutable state shared by the gates. */
export interface UserGateState {
  userId: string;
  connectedAt: number;
  /** Timestamp of the last message accepted by the whole pipeline. */
  lastAcceptedAt: number;
  /** Timestamp of the last inbound `send`, accepted or not. */
  lastSeenAt: number;
  /** rate-limit slice: token bucket. */
  bucket: { tokens: number; updatedAt: number };
  /** spam slice: recent content fingerprints, newest last. */
  recentFingerprints: Array<{ fp: string; at: number }>;
  /** spam slice: timestamps of recent inbound sends, newest last. */
  recentSendsAt: number[];
  /** spam / moderation slices: escalating strike counter. */
  strikes: number;
  /** Epoch ms until which the user may not send. 0 = not muted. */
  mutedUntil: number;
  /** Total messages accepted this connection (used by ranking + stats). */
  acceptedCount: number;
}

export function newUserGateState(userId: string, now: number): UserGateState {
  return {
    userId,
    connectedAt: now,
    lastAcceptedAt: 0,
    lastSeenAt: 0,
    bucket: { tokens: Number.NaN, updatedAt: now },
    recentFingerprints: [],
    recentSendsAt: [],
    strikes: 0,
    mutedUntil: 0,
    acceptedCount: 0,
  };
}

export interface GateContext {
  now: number;
  clock: Clock;
  roomId: string;
  shardIndex: number;
  identity: Identity;
  config: RoomConfig;
  state: UserGateState;
  /** True when the identity holds one of `config.privilegedRoles`. */
  privileged: boolean;
}

export interface GateInput {
  cid: string;
  /** Body as rewritten by any preceding gate. */
  body: string;
}

export type GateDecision =
  | { kind: "allow"; body?: string }
  | { kind: "reject"; code: RejectCode; reason: string; retryAfterMs?: number }
  /** Accepted from the sender's point of view but never broadcast. */
  | { kind: "shadow"; reason: string };

export const allow = (body?: string): GateDecision =>
  body === undefined ? { kind: "allow" } : { kind: "allow", body };

export const reject = (
  code: RejectCode,
  reason: string,
  retryAfterMs?: number,
): GateDecision => ({ kind: "reject", code, reason, retryAfterMs });

export const shadow = (reason: string): GateDecision => ({ kind: "shadow", reason });

export interface MessageGate {
  readonly name: string;
  /**
   * Gates that only apply to unprivileged senders set this to true; the shard
   * skips them for moderators/admins.
   */
  readonly skipForPrivileged?: boolean;
  check(ctx: GateContext, input: GateInput): GateDecision | Promise<GateDecision>;
}

export interface PipelineOutcome {
  decision: GateDecision;
  /** Name of the gate that produced a non-allow decision. */
  gate?: string;
  /** Final body after any rewrites. */
  body: string;
}

/** Run gates in order; first non-allow wins. */
export async function runPipeline(
  gates: readonly MessageGate[],
  ctx: GateContext,
  input: GateInput,
): Promise<PipelineOutcome> {
  let body = input.body;
  for (const gate of gates) {
    if (gate.skipForPrivileged && ctx.privileged) continue;
    const decision = await gate.check(ctx, { cid: input.cid, body });
    if (decision.kind !== "allow") {
      return { decision, gate: gate.name, body };
    }
    if (decision.body !== undefined) body = decision.body;
  }
  return { decision: { kind: "allow" }, body };
}
