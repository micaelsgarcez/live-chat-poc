import { describe, expect, it } from "vitest";
import { RecentMessages } from "./recent-messages";
import { REPLY_EXCERPT_LENGTH, type ChatMessage } from "../../shared/protocol";

const message = (id: string, body = "hello"): ChatMessage => ({
  id,
  roomId: "r",
  userId: `u-${id}`,
  name: `User ${id}`,
  body,
  ts: 1,
});

describe("recent message window", () => {
  it("resolves a reply to something it has seen", () => {
    const recent = new RecentMessages();
    recent.remember(message("m1", "the parent"));
    expect(recent.resolve("m1")).toEqual({
      id: "m1",
      userId: "u-m1",
      name: "User m1",
      body: "the parent",
    });
  });

  it("resolves nothing for an unknown or missing id", () => {
    const recent = new RecentMessages();
    expect(recent.resolve("nope")).toBeUndefined();
    expect(recent.resolve(undefined)).toBeUndefined();
  });

  it("truncates the excerpt so a reply cannot inflate the frame", () => {
    const recent = new RecentMessages();
    recent.remember(message("m1", "x".repeat(500)));
    expect(recent.resolve("m1")?.body).toHaveLength(REPLY_EXCERPT_LENGTH);
  });

  it("drops the oldest entries once the window is full", () => {
    const recent = new RecentMessages(3);
    for (const id of ["a", "b", "c", "d"]) recent.remember(message(id));
    expect(recent.size).toBe(3);
    expect(recent.resolve("a")).toBeUndefined();
    expect(recent.resolve("d")).toBeDefined();
  });

  it("forgets a message a moderator deleted", () => {
    const recent = new RecentMessages();
    recent.remember(message("m1"));
    recent.forget(["m1"]);
    expect(recent.resolve("m1")).toBeUndefined();
  });

  it("keeps the first copy when the same message is fanned out twice", () => {
    const recent = new RecentMessages();
    recent.remember(message("m1", "original"));
    recent.remember({ ...message("m1", "tampered"), name: "Someone else" });
    expect(recent.resolve("m1")?.body).toBe("original");
  });
});
