/**
 * The record of a load test that is happening right now.
 *
 * It lives in KV with a TTL rather than in the coordinator, for one reason: a
 * generator that crashes mid-run must not leave a banner on the public site
 * saying a test is in progress forever. The record expires on its own shortly
 * after the run was due to end, so the failure mode of every bug in this file
 * is "the banner disappears", never "the banner is stuck".
 *
 * It is also, deliberately, the generator's *claim* — what the load generator
 * believes it opened and sent. The server's own view comes from the
 * observability slice, and showing the two side by side is the point: when they
 * diverge, the divergence is the finding.
 */
import type { Env } from "../../env";

export type LoadTestPhase = "ramp" | "hold" | "drain" | "done";

/** What the generator believes it did. Never authoritative — see the note above. */
export interface LoadTestProgress {
  open: number;
  failed: number;
  sent: number;
  acked: number;
  rejected: number;
  delivered: number;
}

export interface LoadTestRun {
  runId: string;
  roomId: string;
  preset: string;
  targetConnections: number;
  targetTalkers: number;
  rampSeconds: number;
  holdSeconds: number;
  phase: LoadTestPhase;
  startedAt: number;
  updatedAt: number;
  progress: LoadTestProgress;
  /** True when the run is allowed past the edge connection limit. */
  bypass: boolean;
  /** Free text the generator can put on screen, e.g. what saturated first. */
  note?: string;
}

const EMPTY_PROGRESS: LoadTestProgress = {
  open: 0,
  failed: 0,
  sent: 0,
  acked: 0,
  rejected: 0,
  delivered: 0,
};

function key(roomId: string): string {
  return `loadtest:${roomId}`;
}

/**
 * KV refuses anything under 60s. Above that the record outlives the run by two
 * minutes, which is enough for the last progress report and the report itself
 * to land, and short enough that a dead generator stops advertising quickly.
 */
function ttlFor(run: LoadTestRun): number {
  const planned = run.rampSeconds + run.holdSeconds + 120;
  return Math.min(3600, Math.max(60, Math.round(planned)));
}

export async function readRun(env: Env, roomId: string): Promise<LoadTestRun | null> {
  const raw = await env.CHAT_KV.get(key(roomId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LoadTestRun;
  } catch {
    return null;
  }
}

export async function writeRun(env: Env, run: LoadTestRun): Promise<void> {
  await env.CHAT_KV.put(key(run.roomId), JSON.stringify(run), { expirationTtl: ttlFor(run) });
}

export async function clearRun(env: Env, roomId: string): Promise<void> {
  await env.CHAT_KV.delete(key(roomId));
}

function positiveInt(value: unknown, fallback: number, max: number): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.floor(n));
}

export interface StartRunInput {
  roomId: string;
  runId: string;
  preset: string;
  targetConnections: number;
  targetTalkers: number;
  rampSeconds: number;
  holdSeconds: number;
  bypass: boolean;
  now: number;
}

export function newRun(input: StartRunInput): LoadTestRun {
  const connections = positiveInt(input.targetConnections, 1, 1_000_000);
  return {
    runId: input.runId,
    roomId: input.roomId,
    preset: input.preset,
    targetConnections: connections,
    // A run cannot have more talkers than sockets; clamping here rather than
    // rejecting keeps a typo from aborting a run that is already ramping.
    targetTalkers: Math.min(connections, positiveInt(input.targetTalkers, 0, 1_000_000)),
    rampSeconds: positiveInt(input.rampSeconds, 60, 3600),
    holdSeconds: positiveInt(input.holdSeconds, 30, 3600),
    phase: "ramp",
    startedAt: input.now,
    updatedAt: input.now,
    progress: { ...EMPTY_PROGRESS },
    bypass: input.bypass,
  };
}

const PHASES: readonly LoadTestPhase[] = ["ramp", "hold", "drain", "done"];

export interface ProgressInput {
  phase?: unknown;
  progress?: Partial<LoadTestProgress>;
  note?: unknown;
}

export function applyProgress(run: LoadTestRun, input: ProgressInput, now: number): LoadTestRun {
  const phase = PHASES.includes(input.phase as LoadTestPhase)
    ? (input.phase as LoadTestPhase)
    : run.phase;
  const reported = input.progress ?? {};
  const next: LoadTestProgress = { ...run.progress };
  for (const field of Object.keys(EMPTY_PROGRESS) as Array<keyof LoadTestProgress>) {
    const value = reported[field];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      next[field] = Math.floor(value);
    }
  }
  return {
    ...run,
    phase,
    progress: next,
    updatedAt: now,
    note: typeof input.note === "string" ? input.note.slice(0, 240) : run.note,
  };
}
