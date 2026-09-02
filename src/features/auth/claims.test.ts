import { describe, expect, it } from "vitest";
import { identityFromClaims, normalizeRoles, normalizeUserId, sanitizeName } from "./claims";

/** Written as codes so the literals below stay readable in a diff. */
const NUL = String.fromCharCode(0x00);
const LF = String.fromCharCode(0x0a);
const DEL = String.fromCharCode(0x7f);
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
const LINE_SEPARATOR = String.fromCharCode(0x2028);

describe("sanitizeName", () => {
  it("strips control characters and collapses the whitespace they leave", () => {
    expect(sanitizeName(`ev${NUL}il${LF}name${DEL}`, "fallback")).toBe("ev il name");
  });

  it("strips the invisibles that survive a JSON round-trip", () => {
    expect(sanitizeName(`a${ZERO_WIDTH_SPACE}b${LINE_SEPARATOR}c`, "fallback")).toBe("a b c");
  });

  it("caps the length so a name cannot bloat every broadcast frame", () => {
    expect(sanitizeName("x".repeat(200), "fallback")).toHaveLength(64);
  });

  it("falls back when nothing usable is left", () => {
    expect(sanitizeName(`${NUL}${NUL}`, "fallback")).toBe("fallback");
    expect(sanitizeName("   ", "fallback")).toBe("fallback");
    expect(sanitizeName(42, "fallback")).toBe("fallback");
  });
});

describe("normalizeUserId", () => {
  it("accepts a plain subject", () => {
    expect(normalizeUserId("  user-1 ")).toBe("user-1");
  });

  it("rejects an empty or oversized subject", () => {
    expect(normalizeUserId(NUL)).toBe("");
    expect(normalizeUserId("")).toBe("");
    expect(normalizeUserId(null)).toBe("");
    expect(normalizeUserId("u".repeat(129))).toBe("");
  });
});

describe("normalizeRoles", () => {
  it("reads the plain `roles` claim", () => {
    expect(normalizeRoles({ roles: ["Moderator", "VIP"] })).toEqual(["moderator", "vip"]);
  });

  it("reads the Keycloak `realm_access.roles` claim", () => {
    expect(normalizeRoles({ realm_access: { roles: ["Admin"] } })).toEqual(["admin"]);
  });

  it("reads the namespaced `https://livechat/roles` claim", () => {
    expect(normalizeRoles({ "https://livechat/roles": ["Host"] })).toEqual(["host"]);
  });

  it("merges the three shapes and deduplicates across them", () => {
    const roles = normalizeRoles({
      roles: ["moderator"],
      realm_access: { roles: ["MODERATOR", "admin"] },
      "https://livechat/roles": ["admin", "vip"],
    });
    expect(roles).toEqual(["moderator", "admin", "vip"]);
  });

  it("accepts a delimited string, which some providers send instead of an array", () => {
    expect(normalizeRoles({ roles: "moderator vip,host" })).toEqual(["moderator", "vip", "host"]);
  });

  it("ignores entries that are not usable role names", () => {
    expect(normalizeRoles({ roles: [1, null, "", "  ", "ok"] })).toEqual(["ok"]);
    expect(normalizeRoles({ roles: ["x".repeat(49)] })).toEqual([]);
    expect(normalizeRoles({ realm_access: "not-an-object" })).toEqual([]);
  });

  it("caps how many roles a token can inject", () => {
    const many = Array.from({ length: 100 }, (_, i) => `role-${i}`);
    expect(normalizeRoles({ roles: many })).toHaveLength(32);
  });
});

describe("identityFromClaims", () => {
  it("maps sub, name, roles and exp", () => {
    const result = identityFromClaims({
      sub: "u-1",
      name: "Ana",
      roles: ["Moderator"],
      exp: 1893456000,
    });
    expect(result).toEqual({
      ok: true,
      identity: { userId: "u-1", name: "Ana", roles: ["moderator"], expiresAt: 1893456000 },
    });
  });

  it("falls back from name to preferred_username to the subject", () => {
    expect(identityFromClaims({ sub: "u-1", preferred_username: "ana" }).identity?.name).toBe("ana");
    expect(identityFromClaims({ sub: "u-1", name: "  " }).identity?.name).toBe("u-1");
    expect(identityFromClaims({ sub: "u-1" }).identity?.name).toBe("u-1");
  });

  it("rejects a payload with no usable subject", () => {
    expect(identityFromClaims({ name: "Ana" })).toEqual({ ok: false, reason: "malformed" });
  });
});
