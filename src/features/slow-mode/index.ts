/**
 * SLICE: slow-mode — room-level interval enforced per user inside the shard.
 *
 * OWNER CONTRACT:
 *   slowModeSlice : Slice (gate, skipForPrivileged)
 *
 * STUB.
 */
import type { Slice } from "../../shared/slice";
import { allow, type MessageGate } from "../../shared/pipeline";

export const slowModeGate: MessageGate = {
  name: "slow-mode",
  skipForPrivileged: true,
  check: () => allow(),
};

export const slowModeSlice: Slice = { name: "slow-mode", gate: slowModeGate };
