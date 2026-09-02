import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { BanRecord } from "../../shared/ports";
import { banKey, entryFor, isFresh, NEGATIVE_TTL_MS, readHot, writeHot } from "./hot-list";
import { banSlice } from "./index";
import { createBanStore, isActive } from "./store";
import { sweepExpiredBans } from "./sweep";
import { ensureBanSchema } from "./test-support";

function record(roomId: string, userId: string, expiresAt = 0): BanRecord {
  return { roomId, userId, reason: "testing", expiresAt, bannedBy: "moderator", createdAt: Date.now() };
}

beforeAll(() => ensureBanSchema(env));

describe("ban store (D1 source of truth)", () => {
  it("round-trips a permanent ban and lifts it again", async () => {
    const store = createBanStore(env);
    await store.ban(record("store-a", "u1"));

    const found = await store.isBanned("store-a", "u1");
    expect(found).toMatchObject({ roomId: "store-a", userId: "u1", expiresAt: 0, reason: "testing" });

    await store.unban("store-a", "u1");
    expect(await store.isBanned("store-a", "u1")).toBeNull();
  });

  it("hides a ban whose expires_at has passed", async () => {
    const store = createBanStore(env);
    await store.ban(record("store-b", "u1", Date.now() - 1_000));
    await store.ban(record("store-b", "u2", Date.now() + 60_000));

    expect(await store.isBanned("store-b", "u1")).toBeNull();
    expect(await store.isBanned("store-b", "u2")).not.toBeNull();
    expect((await store.list("store-b")).map((b) => b.userId)).toEqual(["u2"]);
  });

  it("re-banning extends instead of colliding on the primary key", async () => {
    const store = createBanStore(env);
    await store.ban(record("store-c", "u1", Date.now() - 1_000));
    await store.ban({ ...record("store-c", "u1", Date.now() + 60_000), reason: "second" });

    const found = await store.isBanned("store-c", "u1");
    expect(found?.reason).toBe("second");
  });

  it("treats expires_at = 0 as permanent", () => {
    const now = Date.now();
    expect(isActive(record("r", "u", 0), now)).toBe(true);
    expect(isActive(record("r", "u", now + 1_000), now)).toBe(true);
    expect(isActive(record("r", "u", now - 1_000), now)).toBe(false);
  });
});

describe("ban hot list (KV)", () => {
  it("caches a negative answer for a short window only", () => {
    const now = 1_000_000;
    const entry = entryFor(null, now);
    expect(entry.r).toBeUndefined();
    expect(entry.f).toBe(now + NEGATIVE_TTL_MS);
    expect(isFresh(entry, now + NEGATIVE_TTL_MS - 1)).toBe(true);
    expect(isFresh(entry, now + NEGATIVE_TTL_MS)).toBe(false);
  });

  it("never claims freshness past the moment a timed ban lapses", () => {
    const now = 1_000_000;
    const entry = entryFor(record("r", "u", now + 5_000), now);
    expect(entry.f).toBe(now + 5_000);
  });

  it("stores and reads back an entry under the documented key", async () => {
    const now = Date.now();
    await writeHot(env, "hot-a", "u1", entryFor(record("hot-a", "u1", now + 120_000), now), now);
    expect(await env.CHAT_KV.get(banKey("hot-a", "u1"))).not.toBeNull();

    const read = await readHot(env, "hot-a", "u1");
    expect(read?.r?.userId).toBe("u1");
  });

  it("reports a corrupt entry as a miss rather than as a verdict", async () => {
    await env.CHAT_KV.put(banKey("hot-b", "u1"), "not json", { expirationTtl: 60 });
    expect(await readHot(env, "hot-b", "u1")).toBeNull();
  });
});

describe("ban-sweep", () => {
  it("reclaims expired rows, keeps live ones and drops their KV entries", async () => {
    const store = createBanStore(env);
    const now = Date.now();
    const expired = { ...record("sweep-a", "gone", now - 1_000), expiresAt: now - 1_000 };
    await store.ban(expired);
    await store.ban(record("sweep-a", "stays", now + 60_000));
    await store.ban(record("sweep-a", "forever", 0));
    // Simulate the verdict the edge cached while the ban was still live.
    await writeHot(env, "sweep-a", "gone", { r: expired, f: now + 60_000 }, now);

    const result = await sweepExpiredBans(env, now);
    expect(result.removed).toBeGreaterThanOrEqual(1);

    const rows = await env.CHAT_DB.prepare("SELECT user_id FROM bans WHERE room_id = ?")
      .bind("sweep-a")
      .all<{ user_id: string }>();
    expect(rows.results.map((r) => r.user_id).sort()).toEqual(["forever", "stays"]);
    expect(await env.CHAT_KV.get(banKey("sweep-a", "gone"))).toBeNull();
  });

  it("stays quiet when there is nothing to reclaim", async () => {
    await expect(sweepExpiredBans(env, 1)).resolves.toEqual({ rooms: 0, removed: 0 });
  });
});

describe("slice wiring", () => {
  it("registers ban-sweep on every cron trigger", async () => {
    const job = banSlice.scheduled?.find((j) => j.name === "ban-sweep");
    expect(job?.cron).toBe("*");

    const now = Date.now();
    await createBanStore(env).ban(record("sweep-b", "gone", now - 1_000));
    const ctx = createExecutionContext();
    await job!.run({ scheduledTime: now, cron: "* * * * *", noRetry: () => {} }, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(await createBanStore(env).isBanned("sweep-b", "gone")).toBeNull();
    const rows = await env.CHAT_DB.prepare("SELECT user_id FROM bans WHERE room_id = ?")
      .bind("sweep-b")
      .all<{ user_id: string }>();
    expect(rows.results).toEqual([]);
  });
});
