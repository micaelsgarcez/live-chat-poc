import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("worker skeleton", () => {
  it("answers /health", async () => {
    const res = await SELF.fetch("https://example.com/health");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true });
  });

  it("exposes every binding the slices rely on", () => {
    expect(env.CHAT_KV).toBeDefined();
    expect(env.CHAT_DB).toBeDefined();
    expect(env.ROOM_COORDINATOR).toBeDefined();
    expect(env.CHAT_SHARD).toBeDefined();
    expect(env.PERSIST_QUEUE).toBeDefined();
    expect(env.MODERATION_QUEUE).toBeDefined();
  });
});
