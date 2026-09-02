/**
 * The load generator's way past the edge connection limit — and nothing else's.
 *
 * A load test opens tens of thousands of sockets from a handful of source IPs,
 * which is precisely the shape `EDGE_CONNECTIONS_PER_MINUTE` exists to stop.
 * Rather than weaken the limiter for everyone, a run presents a signed header
 * and only that run skips it: the people in the public room keep the limit they
 * are supposed to have, and the numbers from a run are never quietly a
 * different product's numbers.
 *
 * Three properties, in order of how much they matter:
 *
 *   1. **Off unless armed.** No `LOADTEST_BYPASS_KEY` configured means the
 *      bypass does not exist — not "is disabled", does not exist. The demo is
 *      public and so is this repository, so the safe state has to be the state
 *      you get by doing nothing.
 *   2. **Not replayable.** The signature covers a timestamp and is only
 *      accepted inside a short window, so a header captured from a run cannot
 *      be reused later.
 *   3. **Visible.** `bypassArmed` lets the observability panel say, on screen,
 *      that a bypass is configured — because a number obtained with the
 *      limiter switched off must never be mistaken for a normal one.
 *
 * `src/env.ts` is a frozen contract, so the secret is read through a local
 * structural type, exactly as `observability/cloudflare.ts` reads its token.
 */
import type { Env } from "../../env";

/** Set with `wrangler secret put LOADTEST_BYPASS_KEY` for the duration of a run. */
export interface LoadTestBypassVars {
  LOADTEST_BYPASS_KEY?: string;
}

export const LOADTEST_BYPASS_HEADER = "x-loadtest-auth";

/**
 * How far a signature's timestamp may be from ours. Generous enough for an
 * unsynchronised laptop clock, short enough that a leaked header is stale
 * before it is useful.
 */
export const LOADTEST_BYPASS_WINDOW_MS = 5 * 60_000;

function secretOf(env: Env): string | null {
  const secret = (env as Env & LoadTestBypassVars).LOADTEST_BYPASS_KEY;
  return typeof secret === "string" && secret.length > 0 ? secret : null;
}

/** True when a bypass secret is configured at all. Safe to expose publicly. */
export function bypassArmed(env: Env): boolean {
  return secretOf(env) !== null;
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `HMAC-SHA256(secret, timestamp)`, hex. Exported so the generator can sign. */
export async function signBypass(secret: string, timestamp: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(timestamp)));
  return toHex(mac);
}

/** Constant-time over the compared bytes; length is not a secret here. */
function equals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Does this request carry a valid, fresh bypass signature?
 *
 * Returns false for every failure mode — unarmed, absent, malformed, expired,
 * wrong — so a caller can never accidentally treat "could not check" as "yes".
 */
export async function hasLoadTestBypass(req: Request, env: Env): Promise<boolean> {
  const secret = secretOf(env);
  if (!secret) return false;

  const presented = req.headers.get(LOADTEST_BYPASS_HEADER);
  if (!presented) return false;

  const separator = presented.indexOf(".");
  if (separator <= 0) return false;
  const timestamp = Number.parseInt(presented.slice(0, separator), 10);
  const signature = presented.slice(separator + 1);
  if (!Number.isFinite(timestamp) || signature.length === 0) return false;

  if (Math.abs(Date.now() - timestamp) > LOADTEST_BYPASS_WINDOW_MS) return false;

  return equals(signature, await signBypass(secret, timestamp));
}
