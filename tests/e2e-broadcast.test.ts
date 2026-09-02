import { describe, expect, it } from "vitest";
import { TestClient } from "./helpers/client";

describe("end-to-end broadcast", () => {
  it("delivers a message from one connection to every connection in the room", async () => {
    const a = await TestClient.connect("e2e-room", "aaaaaaaa-user-one");
    const b = await TestClient.connect("e2e-room", "bbbbbbbb-user-two");

    await Promise.all([a.waitFor("hello"), b.waitFor("hello")]);

    a.send({ t: "send", cid: "c1", body: "hello world" });

    const [ack, delivered] = await Promise.all([a.waitFor("ack"), b.waitFor("msg")]);
    expect(ack.cid).toBe("c1");
    expect(delivered.m.body).toBe("hello world");
    expect(delivered.m.id).toBe(ack.id);
  });
});
