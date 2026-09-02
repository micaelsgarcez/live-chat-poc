import { describe, expect, it, vi } from "vitest";
import { TestClient } from "../../../tests/helpers/client";
import { RejectCode } from "../../shared/errors";
import { defaultRoomConfig } from "../../shared/room-config";

const { capacity } = defaultRoomConfig("x").rateLimit;

/** Flood a socket; the shard answers every frame in order. */
function sendBurst(client: TestClient, count: number): void {
  for (let i = 0; i < count; i++) client.send({ t: "send", cid: `c${i}`, body: `msg ${i}` });
}

describe("rate limit through a real shard", () => {
  it("acks up to capacity and rejects the overflow with a retry hint", async () => {
    const client = await TestClient.connectAs("rl-room", "flooder");
    await client.waitFor("hello");

    sendBurst(client, capacity + 1);
    const rejected = await client.waitFor("rejected");

    expect(rejected.code).toBe(RejectCode.RATE_LIMITED);
    expect(rejected.cid).toBe(`c${capacity}`);
    expect(rejected.retryAfterMs).toBeGreaterThan(0);
    expect(rejected.retryAfterMs).toBeLessThanOrEqual(1_000);
    expect(client.all("ack")).toHaveLength(capacity);

    client.close();
  });

  it("does not limit a moderator", async () => {
    const mod = await TestClient.connectAs("rl-room", "mod-user", ["moderator"]);
    await mod.waitFor("hello");

    const total = capacity + 3;
    sendBurst(mod, total);

    await vi.waitFor(() => expect(mod.all("ack")).toHaveLength(total));
    expect(mod.all("rejected")).toHaveLength(0);

    mod.close();
  });
});
