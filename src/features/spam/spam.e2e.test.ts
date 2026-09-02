import { describe, expect, it } from "vitest";
import { TestClient } from "../../../tests/helpers/client";
import { RejectCode } from "../../shared/errors";
import { defaultRoomConfig } from "../../shared/room-config";

describe("spam over a live socket", () => {
  it("rejects the copy that exceeds maxDuplicates", async () => {
    const { maxDuplicates } = defaultRoomConfig("spam-e2e").spam;
    const client = await TestClient.connectAs("spam-e2e", "dup-user");
    await client.waitFor("hello");

    for (let i = 0; i < maxDuplicates; i++) {
      client.send({ t: "send", cid: `ok-${i}`, body: "same message" });
    }
    client.send({ t: "send", cid: "dup", body: "same message" });

    const rejected = await client.waitFor("rejected");
    expect(rejected.cid).toBe("dup");
    expect(rejected.code).toBe(RejectCode.SPAM);
    expect(client.all("ack")).toHaveLength(maxDuplicates);

    client.close();
  });
});
