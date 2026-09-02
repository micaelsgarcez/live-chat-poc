/**
 * Claim -> Identity mapping.
 *
 * Split out from verification because it is pure: everything here runs on an
 * already-verified payload, so it is testable without keys, clocks or network.
 *
 * Internal to the auth slice — other slices import `./index.ts` only.
 */
import type { AuthResult } from "../../shared/ports";

/** Auth0-style namespaced claim; `roles` and `realm_access.roles` cover the rest. */
const NAMESPACED_ROLES_CLAIM = "https://livechat/roles";

/** `name` is echoed in every broadcast frame, so it is bounded once, here. */
const MAX_NAME_LENGTH = 64;
/** `userId` becomes a KV key fragment and the shard placement key. */
const MAX_USER_ID_LENGTH = 128;
const MAX_ROLES = 32;
const MAX_ROLE_LENGTH = 48;

/**
 * Control characters plus the invisibles that survive a JSON round-trip. Left
 * in a display name they let a sender forge line breaks in the transcript or
 * make the name disappear in a client that renders it verbatim.
 */
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g;

/** Trims, strips unsafe characters and caps the length. Empty result -> fallback. */
export function sanitizeName(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const cleaned = raw.replace(UNSAFE_CHARS, " ").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, MAX_NAME_LENGTH).trim() || fallback;
}

/** Returns "" when the value cannot be used as a subject. */
export function normalizeUserId(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const cleaned = raw.replace(UNSAFE_CHARS, "").trim();
  return cleaned.length > 0 && cleaned.length <= MAX_USER_ID_LENGTH ? cleaned : "";
}

function pushRole(raw: string, out: string[]): void {
  const role = raw.replace(UNSAFE_CHARS, "").trim().toLowerCase();
  if (!role || role.length > MAX_ROLE_LENGTH) return;
  if (out.length >= MAX_ROLES || out.includes(role)) return;
  out.push(role);
}

/** Providers ship roles as an array or as a delimited string; accept both. */
function collectRoles(source: unknown, out: string[]): void {
  if (typeof source === "string") {
    for (const part of source.split(/[\s,]+/)) pushRole(part, out);
    return;
  }
  if (!Array.isArray(source)) return;
  for (const entry of source) {
    if (typeof entry === "string") pushRole(entry, out);
  }
}

/**
 * Merges the three role claim shapes into one lowercase, deduplicated list.
 * Lowercasing matters: `RoomConfig.privilegedRoles` is lowercase, and a gate
 * comparing "Moderator" against "moderator" would silently under-privilege.
 */
export function normalizeRoles(claims: Record<string, unknown>): string[] {
  const roles: string[] = [];
  collectRoles(claims.roles, roles);
  const realmAccess = claims.realm_access;
  if (typeof realmAccess === "object" && realmAccess !== null) {
    collectRoles((realmAccess as Record<string, unknown>).roles, roles);
  }
  collectRoles(claims[NAMESPACED_ROLES_CLAIM], roles);
  return roles;
}

/** Maps a verified payload onto an `Identity`, or fails with a closed reason. */
export function identityFromClaims(claims: Record<string, unknown>): AuthResult {
  const userId = normalizeUserId(claims.sub);
  if (!userId) return { ok: false, reason: "malformed" };
  return {
    ok: true,
    identity: {
      userId,
      name: sanitizeName(claims.name, "") || sanitizeName(claims.preferred_username, "") || userId,
      roles: normalizeRoles(claims),
      expiresAt: typeof claims.exp === "number" ? claims.exp : 0,
    },
  };
}
