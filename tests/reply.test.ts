import { SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { TestClient } from "./helpers/client";
import { getShardCount, selectShardIndex } from "../src/features/routing";
import { shardName } from "../src/shared/ids";
import { env } from "cloudflare:test";
import type { ChatShard } from "../src/realtime/shard";

const ROOM = "reply-room";

async function shardFor(userId: string) {
  const count = await getShardCount(env, ROOM);
  const index = selectShardIndex(`${ROOM}:${userId}`, count);
  return env.CHAT_SHARD.get(env.CHAT_SHARD.idFromName(shardName(ROOM, index)));
}

describe("replies", () => {
  it("resolves the parent from the shard, not from what the client claims", async () => {
    const alice = await TestClient.connectAs(ROOM, "alice");
    const bob = await TestClient.connectAs(ROOM, "bob");
    await Promise.all([alice.waitFor("hello"), bob.waitFor("hello")]);

    alice.send({ t: "send", cid: "p1", body: "qual o horario da live?" });
    const parent = await alice.waitFor("ack");
    await bob.waitFor("msg");

    bob.send({
      t: "send",
      cid: "r1",
      body: "@alice as 21h",
      replyTo: parent.id,
      // A forged excerpt must be ignored: only the id crosses the wire.
      replyBody: "something alice never said",
    });

    const echoed = await vi.waitFor(async () => {
      const found = alice.all("msg").find((m) => m.m.body === "@alice as 21h");
      expect(found).toBeDefined();
      return found!;
    });

    expect(echoed.m.replyTo).toEqual({
      id: parent.id,
      userId: "alice",
      name: "alice",
      body: "qual o horario da live?",
    });

    alice.close();
    bob.close();
  }, 20_000);

  it("carries the reply into history, quoting the parent as it stands", async () => {
    const user = await TestClient.connectAs(ROOM, "carol");
    await user.waitFor("hello");

    user.send({ t: "send", cid: "h1", body: "mensagem original" });
    const parent = await user.waitFor("ack");
    user.send({ t: "send", cid: "h2", body: "respondendo", replyTo: parent.id });
    await user.waitFor("ack");

    const shard = await shardFor("carol");
    await shard.flushNow();

    await vi.waitFor(
      async () => {
        const res = await SELF.fetch(`https://example.com/api/rooms/${ROOM}/messages?limit=20`);
        const body = (await res.json()) as {
          messages: Array<{ body: string; replyTo?: { name: string; body: string } }>;
        };
        const reply = body.messages.find((m) => m.body === "respondendo");
        expect(reply?.replyTo).toMatchObject({ name: "carol", body: "mensagem original" });
      },
      { timeout: 10_000, interval: 250 },
    );

    user.close();
  }, 25_000);

  it("drops the reference when the parent is unknown", async () => {
    const user = await TestClient.connectAs(ROOM, "dave");
    await user.waitFor("hello");

    user.send({ t: "send", cid: "x1", body: "resposta orfa", replyTo: "does-not-exist" });
    const echoed = await vi.waitFor(async () => {
      const found = user.all("msg").find((m) => m.m.body === "resposta orfa");
      expect(found).toBeDefined();
      return found!;
    });
    expect(echoed.m.replyTo).toBeUndefined();

    user.close();
  }, 20_000);
});
