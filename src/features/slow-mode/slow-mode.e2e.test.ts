import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { TestClient } from "../../../tests/helpers/client";
import { RejectCode } from "../../shared/errors";

/** Turns slow mode on through the moderator route the room slice exposes. */
async function setSlowMode(roomId: string, slowModeMs: number): Promise<void> {
  const token = await TestClient.token("mod-1", ["moderator"]);
  const res = await SELF.fetch(`https://example.com/api/rooms/${roomId}/config`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ slowModeMs }),
  });
  expect(res.status).toBe(200);
}

describe("slow-mode over a live socket", () => {
  it("rejects the second message and tells the client how long to wait", async () => {
    const room = "slow-mode-e2e";
    await setSlowMode(room, 60_000);

    const client = await TestClient.connectAs(room, "slow-user");
    const hello = await client.waitFor("hello");
    expect(hello.config.slowModeMs).toBe(60_000);

    client.send({ t: "send", cid: "c1", body: "first one" });
    await client.waitFor("ack");

    client.send({ t: "send", cid: "c2", body: "second one" });
    const rejected = await client.waitFor("rejected");
    expect(rejected.cid).toBe("c2");
    expect(rejected.code).toBe(RejectCode.SLOW_MODE);
    expect(rejected.retryAfterMs).toBeGreaterThan(0);
    expect(rejected.retryAfterMs).toBeLessThanOrEqual(60_000);

    client.close();
  });
});
