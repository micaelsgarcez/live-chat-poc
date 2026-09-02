/**
 * SLICE: moderation — synchronous wordlist gate + asynchronous queue review.
 *
 * OWNER CONTRACT:
 *   moderationSlice   : Slice (gate + `chat-moderation` consumer + mod routes)
 *   enqueueModeration : (env, jobs: ModerationJob[]) => Promise<void>
 *
 * STUB.
 */
import type { Env } from "../../env";
import type { Slice } from "../../shared/slice";
import type { ModerationJob } from "../../shared/ports";
import { allow, type MessageGate } from "../../shared/pipeline";

export async function enqueueModeration(_env: Env, _jobs: ModerationJob[]): Promise<void> {}

export const moderationGate: MessageGate = {
  name: "moderation-sync",
  skipForPrivileged: false,
  check: () => allow(),
};

export const moderationSlice: Slice = { name: "moderation", gate: moderationGate };
