/**
 * SLICE: room — room lifecycle and configuration over HTTP.
 *
 * Everything here talks to the coordinator Durable Object, which owns the
 * authoritative `RoomConfig`.
 */
import type { Env } from "../../env";
import { coordinatorName } from "../../shared/ids";
import { json, problem, readJson, type RouteDef } from "../../shared/http";
import type { RoomConfigPatch } from "../../shared/room-config";
import type { Slice } from "../../shared/slice";
import { authorizeModerator } from "../auth";

export function coordinatorStub(env: Env, roomId: string) {
  const id = env.ROOM_COORDINATOR.idFromName(coordinatorName(roomId));
  return env.ROOM_COORDINATOR.get(id);
}

const routes: RouteDef[] = [
  {
    method: "GET",
    path: "/api/rooms/:roomId/config",
    async handler(_req, env, _ctx, { params }) {
      const roomId = params.roomId!;
      const config = await coordinatorStub(env, roomId).init(roomId);
      return json({ config });
    },
  },
  {
    method: "PATCH",
    path: "/api/rooms/:roomId/config",
    async handler(req, env, _ctx, { params }) {
      const moderator = await authorizeModerator(req, env);
      if (!moderator) return problem(403, "forbidden", "moderator credentials required");
      const patch = await readJson<RoomConfigPatch>(req);
      if (!patch) return problem(400, "malformed", "invalid JSON body");
      if (
        patch.maxSocketsPerShard !== undefined &&
        (!Number.isInteger(patch.maxSocketsPerShard) || patch.maxSocketsPerShard < 1)
      ) {
        return problem(400, "malformed", "maxSocketsPerShard must be an integer of at least 1");
      }
      const roomId = params.roomId!;
      const stub = coordinatorStub(env, roomId);
      await stub.init(roomId);
      const config = await stub.updateConfig(patch);
      return json({ config });
    },
  },
  {
    method: "GET",
    path: "/api/rooms/:roomId/stats",
    async handler(_req, env, _ctx, { params }) {
      const roomId = params.roomId!;
      const stub = coordinatorStub(env, roomId);
      await stub.init(roomId);
      return json({ stats: await stub.getStats() });
    },
  },
];

export const roomSlice: Slice = { name: "room", routes };
