/**
 * SLICE: spam — inline heuristics (duplicates, burst, links, mentions, caps).
 *
 * OWNER CONTRACT:
 *   spamSlice : Slice (gate, skipForPrivileged)
 *
 * STUB.
 */
import type { Slice } from "../../shared/slice";
import { allow, type MessageGate } from "../../shared/pipeline";

export const spamGate: MessageGate = {
  name: "spam",
  skipForPrivileged: true,
  check: () => allow(),
};

export const spamSlice: Slice = { name: "spam", gate: spamGate };
