/**
 * Composition root.
 *
 * The only module that imports every slice. Adding a slice means adding one
 * import and one entry here — nothing else in the codebase changes.
 */
import type { MessageGate } from "../shared/pipeline";
import type { QueueConsumerDef, ScheduledJobDef, Slice } from "../shared/slice";
import type { RouteDef } from "../shared/http";

import { authSlice } from "./auth";
import { banSlice } from "./ban";
import { connectSlice } from "./connect";
import { moderationSlice, moderationGate } from "./moderation";
import { observabilitySlice } from "./observability";
import { persistenceSlice } from "./persistence";
import { rankingSlice } from "./ranking";
import { rateLimitSlice, rateLimitGate } from "./rate-limit";
import { roomSlice } from "./room";
import { baseGuardGate } from "./room/gate";
import { routingSlice } from "./routing";
import { slowModeSlice, slowModeGate } from "./slow-mode";
import { spamSlice, spamGate } from "./spam";

export const slices: readonly Slice[] = [
  authSlice,
  banSlice,
  roomSlice,
  routingSlice,
  connectSlice,
  rateLimitSlice,
  slowModeSlice,
  spamSlice,
  moderationSlice,
  persistenceSlice,
  rankingSlice,
  observabilitySlice,
];

/**
 * Inbound pipeline order. Cheapest and most protective first: structural
 * guards, then per-user throughput limits, then content heuristics.
 */
export const gates: readonly MessageGate[] = [
  baseGuardGate,
  rateLimitGate,
  slowModeGate,
  spamGate,
  moderationGate,
];

export const routes: readonly RouteDef[] = slices.flatMap((slice) => slice.routes ?? []);

export const queueConsumers: readonly QueueConsumerDef<any>[] = slices.flatMap(
  (slice) => slice.queueConsumers ?? [],
);

export const scheduledJobs: readonly ScheduledJobDef[] = slices.flatMap(
  (slice) => slice.scheduled ?? [],
);
