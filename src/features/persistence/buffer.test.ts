import { describe, expect, it, vi } from "vitest";
import type { Env } from "../../env";
import type { PersistBatch, PersistReaction } from "../../shared/ports";
import type { ChatMessage } from "../../shared/protocol";
import { defaultRoomConfig, type PersistenceConfig } from "../../shared/room-config";
import { createMessageBuffer } from "./buffer";

function config(patch: Partial<PersistenceConfig> = {}): PersistenceConfig {
  return { ...defaultRoomConfig("buffer-room").persistence, ...patch };
}

/** Minimal Env: the buffer only ever touches the queue binding and LOG_LEVEL. */
function bufferEnv(
  send: (batch: PersistBatch) => Promise<void>,
  logLevel = "error",
): Env {
  return { LOG_LEVEL: logLevel, PERSIST_QUEUE: { send } } as unknown as Env;
}

function recordingEnv(): { env: Env; sent: PersistBatch[] } {
  const sent: PersistBatch[] = [];
  return {
    sent,
    env: bufferEnv(async (batch) => {
      sent.push(batch);
    }),
  };
}

function message(id: string, ts = 1_000): ChatMessage {
  return { id, roomId: "buffer-room", userId: "u1", name: "u1", body: `body-${id}`, ts };
}

function reaction(messageId: string, ts = 1_000): PersistReaction {
  return { roomId: "buffer-room", messageId, userId: "u2", emoji: "🔥", ts };
}

describe("message buffer", () => {
  it("asks for a flush once batchSize is reached", () => {
    const { env } = recordingEnv();
    const buffer = createMessageBuffer(env, "buffer-room", 0, config({ batchSize: 3 }));
    const now = Date.now();

    expect(buffer.shouldFlush(now)).toBe(false);
    buffer.add(message("a"));
    buffer.add(message("b"));
    expect(buffer.shouldFlush(now)).toBe(false);

    buffer.addReaction(reaction("a"));
    expect(buffer.size()).toBe(3);
    expect(buffer.shouldFlush(now)).toBe(true);
  });

  it("asks for a flush once flushIntervalMs has elapsed", () => {
    const { env } = recordingEnv();
    const start = Date.now();
    const buffer = createMessageBuffer(
      env,
      "buffer-room",
      0,
      config({ batchSize: 100, flushIntervalMs: 2_000 }),
    );
    buffer.add(message("a"));

    expect(buffer.shouldFlush(start + 1_999)).toBe(false);
    expect(buffer.shouldFlush(start + 2_000)).toBe(true);
  });

  it("never asks for a flush while empty", () => {
    const { env } = recordingEnv();
    const buffer = createMessageBuffer(env, "buffer-room", 0, config({ flushIntervalMs: 0 }));
    expect(buffer.shouldFlush(Date.now() + 60_000)).toBe(false);
  });

  it("ships one batch carrying both messages and reactions", async () => {
    const { env, sent } = recordingEnv();
    const buffer = createMessageBuffer(env, "buffer-room", 3, config());
    buffer.add(message("a"));
    buffer.add(message("b"));
    buffer.addReaction(reaction("a"));

    expect(await buffer.flush()).toBe(3);
    expect(buffer.size()).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.shardIndex).toBe(3);
    expect(sent[0]!.messages.map((m) => m.id)).toEqual(["a", "b"]);
    expect(sent[0]!.reactions).toHaveLength(1);

    // Nothing buffered means nothing sent.
    expect(await buffer.flush()).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it("drops the newest item and warns once the buffer is full", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const buffer = createMessageBuffer(
        bufferEnv(async () => {}, "warn"),
        "buffer-room",
        0,
        config({ maxBufferedMessages: 2 }),
      );

      expect(buffer.add(message("a"))).toBe(true);
      expect(buffer.add(message("b"))).toBe(true);
      expect(buffer.add(message("c"))).toBe(false);
      expect(buffer.addReaction(reaction("a"))).toBe(false);

      expect(buffer.size()).toBe(2);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[1]![0])).toContain('"dropped":2');
    } finally {
      warn.mockRestore();
    }
  });

  it("returns the items to the buffer when the queue send fails", async () => {
    let fail = true;
    const sent: PersistBatch[] = [];
    const env = bufferEnv(async (batch) => {
      if (fail) throw new Error("queue unavailable");
      sent.push(batch);
    });
    const buffer = createMessageBuffer(env, "buffer-room", 0, config());
    buffer.add(message("a"));
    buffer.addReaction(reaction("a"));

    expect(await buffer.flush()).toBe(0);
    expect(buffer.size()).toBe(2);

    // A later message must not jump ahead of the requeued ones.
    buffer.add(message("b"));
    fail = false;
    expect(await buffer.flush()).toBe(3);
    expect(sent[0]!.messages.map((m) => m.id)).toEqual(["a", "b"]);
    expect(buffer.size()).toBe(0);
  });

  it("collapses concurrent flushes into a single send", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const sent: PersistBatch[] = [];
    const env = bufferEnv(async (batch) => {
      sent.push(batch);
      await gate;
    });
    const buffer = createMessageBuffer(env, "buffer-room", 0, config());
    buffer.add(message("a"));
    buffer.add(message("b"));

    const first = buffer.flush();
    const second = buffer.flush();
    release();

    expect(await first).toBe(2);
    expect(await second).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.messages).toHaveLength(2);
  });

  it("keeps items added during a flush for the next batch", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const sent: PersistBatch[] = [];
    const env = bufferEnv(async (batch) => {
      sent.push(batch);
      await gate;
    });
    const buffer = createMessageBuffer(env, "buffer-room", 0, config());
    buffer.add(message("a"));

    const flushing = buffer.flush();
    buffer.add(message("b"));
    release();
    expect(await flushing).toBe(1);

    expect(await buffer.flush()).toBe(1);
    expect(sent.map((batch) => batch.messages.map((m) => m.id))).toEqual([["a"], ["b"]]);
  });

  it("accepts everything and sends nothing when disabled", async () => {
    const { env, sent } = recordingEnv();
    const buffer = createMessageBuffer(
      env,
      "buffer-room",
      0,
      config({ enabled: false, maxBufferedMessages: 1 }),
    );

    expect(buffer.add(message("a"))).toBe(true);
    expect(buffer.add(message("b"))).toBe(true);
    expect(buffer.addReaction(reaction("a"))).toBe(true);
    expect(buffer.size()).toBe(0);
    expect(buffer.shouldFlush(Date.now() + 60_000)).toBe(false);
    expect(await buffer.flush()).toBe(0);
    expect(sent).toHaveLength(0);
  });
});
