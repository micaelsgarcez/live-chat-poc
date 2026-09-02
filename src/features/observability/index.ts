/**
 * SLICE: observability — what the room is doing, while it does it.
 *
 * EXPORTED SURFACE (imported by the registry, the shard and the demo console):
 *   observabilitySlice     : Slice
 *   AuditRing              : per-shard ring of pipeline decisions
 *   AuditEvent / AuditKind / AuditInput / AuditSlice
 *   ShardObservabilityReport : what `ChatShard.getObservability` answers
 *   AUDIT_RING_CAPACITY    : number
 *   collectRoom            : (env, roomId, options) => Promise<RoomSnapshot>
 *   evaluateHealth         : pure verdict over a snapshot
 *   pseudonym              : stable, non-reversible display id
 *
 * ROUTES:
 *   GET /api/rooms/:roomId/observability?since=<cursor>&pingMs=<n>
 *       The live panel and the audit feed in one payload — one fan-in over the
 *       shards serves both, because they need the same round trip.
 *       Open to anyone; user ids are pseudonymous unless the caller proves it
 *       is a moderator, so the demo works without a token and never leaks who
 *       got rate-limited to a room full of strangers.
 *   GET /api/rooms/:roomId/observability/cloudflare
 *       Account-level analytics, feature-detected and cached for a minute.
 */
import type { Env } from "../../env";
import { json, problem, type RouteDef } from "../../shared/http";
import type { Slice } from "../../shared/slice";
import { authorizeModerator } from "../auth";
import { collectRoom } from "./collector";
import { fetchCloudflareAnalytics } from "./cloudflare";

export {
  AuditRing,
  AUDIT_RING_CAPACITY,
  decodeAuditCursor,
  encodeAuditCursor,
  mergeAuditEvents,
  type AuditEvent,
  type AuditInput,
  type AuditKind,
  type AuditSlice,
  type ShardObservabilityReport,
} from "./audit";
export {
  collectRoom,
  MAX_EVENTS_PER_SNAPSHOT,
  pseudonym,
  type RoomSnapshot,
  type ShardView,
} from "./collector";
export {
  evaluateHealth,
  FLUSH_STALL_MS,
  PING_WARN_MS,
  REJECT_RATE_WARN,
  type HealthCheck,
  type HealthLevel,
  type HealthVerdict,
} from "./health";
export {
  fetchCloudflareAnalytics,
  isCloudflareConfigured,
  type CloudflareAnalytics,
  type CloudflareResult,
} from "./cloudflare";

/** Guards against a typo in the query string turning into a silly RPC storm. */
const MAX_PING_MS = 60_000;

function pingFrom(url: URL): number | null {
  const raw = Number.parseFloat(url.searchParams.get("pingMs") ?? "");
  if (!Number.isFinite(raw) || raw < 0 || raw > MAX_PING_MS) return null;
  return raw;
}

const routes: RouteDef[] = [
  {
    method: "GET",
    path: "/api/rooms/:roomId/observability",
    async handler(req: Request, env: Env, _ctx, { params }) {
      const roomId = params.roomId!;
      const url = new URL(req.url);
      // Not a gate: failing to prove moderation only costs you the real names.
      const moderator = await authorizeModerator(req, env);
      const snapshot = await collectRoom(env, roomId, {
        since: url.searchParams.get("since"),
        reveal: moderator !== null,
        pingMs: pingFrom(url),
      });
      return json({ snapshot });
    },
  },
  {
    method: "GET",
    path: "/api/rooms/:roomId/observability/cloudflare",
    async handler(_req: Request, env: Env) {
      try {
        return json({ cloudflare: await fetchCloudflareAnalytics(env) });
      } catch (error) {
        return problem(502, "upstream", `analytics failed: ${String(error)}`);
      }
    },
  },
];

export const observabilitySlice: Slice = { name: "observability", routes };
