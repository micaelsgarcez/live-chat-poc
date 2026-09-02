/**
 * SLICE: loadtest — what the public site shows while a load test is running.
 *
 * EXPORTED SURFACE (imported by the registry and the demo console):
 *   loadTestSlice     : Slice
 *   LOADTEST_PRESETS  : readonly LoadTestPreset[]
 *   findPreset        : (name) => LoadTestPreset | null
 *   readRun           : (env, roomId) => Promise<LoadTestRun | null>
 *   LoadTestRun / LoadTestPreset / LoadTestPhase / LoadTestProgress
 *
 * ROUTES:
 *   GET    /api/rooms/:roomId/loadtest   the live run plus the preset ladder.
 *                                        Open to anyone: it is what puts the
 *                                        numbers on the public page, and it
 *                                        carries no identity of any kind.
 *   POST   /api/rooms/:roomId/loadtest   announce a run (moderator).
 *   PATCH  /api/rooms/:roomId/loadtest   report progress (moderator).
 *   DELETE /api/rooms/:roomId/loadtest   end a run (moderator).
 *
 * Why a run is announced at all: without a declared target, a live counter has
 * no denominator. "42.000 conexões" is a number; "42.000 de 50.000, em rampa"
 * is a story, and the story is the reason the panel is public.
 */
import type { Env } from "../../env";
import { json, problem, readJson, type RouteDef } from "../../shared/http";
import { newConnectionId } from "../../shared/ids";
import type { Slice } from "../../shared/slice";
import { authorizeModerator } from "../auth";
import { bypassArmed } from "../rate-limit";
import { LOADTEST_PRESETS, findPreset, type LoadTestPreset } from "./presets";
import {
  applyProgress,
  clearRun,
  newRun,
  readRun,
  writeRun,
  type LoadTestPhase,
  type LoadTestProgress,
  type LoadTestRun,
  type ProgressInput,
} from "./run";

export { LOADTEST_PRESETS, findPreset, readRun };
export type { LoadTestPreset, LoadTestPhase, LoadTestProgress, LoadTestRun };

interface StartBody {
  preset?: string;
  connections?: number;
  talkers?: number;
  rampSeconds?: number;
  holdSeconds?: number;
}

const routes: RouteDef[] = [
  {
    method: "GET",
    path: "/api/rooms/:roomId/loadtest",
    async handler(_req, env: Env, _ctx, { params }) {
      const run = await readRun(env, params.roomId!);
      // `bypassArmed` is reported whether or not a run is happening: a limiter
      // that can be skipped is worth knowing about at any time.
      return json({ run, presets: LOADTEST_PRESETS, bypassArmed: bypassArmed(env) });
    },
  },
  {
    method: "POST",
    path: "/api/rooms/:roomId/loadtest",
    async handler(req, env: Env, _ctx, { params }) {
      const moderator = await authorizeModerator(req, env);
      if (!moderator) return problem(403, "forbidden", "moderator credentials required");
      const body = (await readJson<StartBody>(req)) ?? {};
      const preset = body.preset ? findPreset(body.preset) : null;
      if (body.preset && !preset) {
        return problem(
          400,
          "unknown_preset",
          `no such preset: ${body.preset} (have ${LOADTEST_PRESETS.map((p) => p.name).join(", ")})`,
        );
      }
      const run = newRun({
        roomId: params.roomId!,
        runId: newConnectionId(),
        preset: preset?.name ?? "custom",
        targetConnections: body.connections ?? preset?.connections ?? 0,
        targetTalkers: body.talkers ?? preset?.talkers ?? 0,
        rampSeconds: body.rampSeconds ?? preset?.rampSeconds ?? 60,
        holdSeconds: body.holdSeconds ?? preset?.holdSeconds ?? 30,
        bypass: bypassArmed(env),
        now: Date.now(),
      });
      await writeRun(env, run);
      return json({ run });
    },
  },
  {
    method: "PATCH",
    path: "/api/rooms/:roomId/loadtest",
    async handler(req, env: Env, _ctx, { params }) {
      const moderator = await authorizeModerator(req, env);
      if (!moderator) return problem(403, "forbidden", "moderator credentials required");
      const current = await readRun(env, params.roomId!);
      // The record expires on its own, so a late report after a run timed out
      // is normal, not an error worth failing a generator over.
      if (!current) return problem(404, "no_run", "no load test is running in this room");
      const body = (await readJson<ProgressInput>(req)) ?? {};
      const next = applyProgress(current, body, Date.now());
      await writeRun(env, next);
      return json({ run: next });
    },
  },
  {
    method: "DELETE",
    path: "/api/rooms/:roomId/loadtest",
    async handler(req, env: Env, _ctx, { params }) {
      const moderator = await authorizeModerator(req, env);
      if (!moderator) return problem(403, "forbidden", "moderator credentials required");
      await clearRun(env, params.roomId!);
      return json({ run: null });
    },
  },
];

export const loadTestSlice: Slice = { name: "loadtest", routes };
