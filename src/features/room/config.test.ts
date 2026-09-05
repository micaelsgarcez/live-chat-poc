import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const headers = {
  "content-type": "application/json",
  "x-moderator-key": env.MODERATOR_API_KEY!,
};

describe("room config", () => {
  it("accepts a positive integer socket ceiling", async () => {
    const response = await SELF.fetch("https://example.com/api/rooms/config-ceiling/config", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ maxSocketsPerShard: 2_000 }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      config: { maxSocketsPerShard: 2_000 },
    });
  });

  it.each([0, -1, 1.5])("rejects an invalid socket ceiling (%s)", async (value) => {
    const response = await SELF.fetch(`https://example.com/api/rooms/config-invalid-${value}/config`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ maxSocketsPerShard: value }),
    });
    expect(response.status).toBe(400);
  });
});
