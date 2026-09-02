import { SELF } from "cloudflare:test";
import { expect } from "vitest";
import type { ServerMessage } from "../../src/shared/protocol";

/**
 * WebSocket test client that buffers every frame from the moment the socket is
 * accepted, so a test can await `hello` even though the server sends it during
 * the upgrade.
 */
export class TestClient {
  readonly received: ServerMessage[] = [];
  private waiters: Array<{
    predicate: (m: ServerMessage) => boolean;
    resolve: (m: ServerMessage) => void;
  }> = [];

  constructor(readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const parsed = JSON.parse(event.data as string) as ServerMessage;
      // A batch is a transport detail, not something a test should assert on:
      // it is unwrapped here so `waitFor("msg")` reads the same whether or not
      // the room happens to be coalescing.
      if (parsed.t === "batch") {
        this.ingest(parsed);
        for (const inner of parsed.events) this.ingest(inner);
        return;
      }
      this.ingest(parsed);
    });
  }

  private ingest(message: ServerMessage): void {
    this.received.push(message);
    this.waiters = this.waiters.filter((waiter) => {
      if (!waiter.predicate(message)) return true;
      waiter.resolve(message);
      return false;
    });
  }

  /** Mints a local dev JWT via the frozen `POST /api/dev/token` route. */
  static async token(userId: string, roles: string[] = []): Promise<string> {
    const res = await SELF.fetch("https://example.com/api/dev/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, roles }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    return body.token;
  }

  /** Connects as `userId`, minting a token for it. */
  static async connectAs(
    room: string,
    userId: string,
    roles: string[] = [],
  ): Promise<TestClient> {
    return TestClient.connect(room, await TestClient.token(userId, roles));
  }

  static async connect(
    room: string,
    token: string,
    init: RequestInit = {},
  ): Promise<TestClient> {
    const res = await SELF.fetch(`https://example.com/ws/${room}?token=${token}`, {
      ...init,
      headers: { Upgrade: "websocket", ...(init.headers ?? {}) },
    });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    const client = new TestClient(ws);
    ws.accept();
    return client;
  }

  waitFor<T extends ServerMessage["t"]>(
    t: T,
    timeoutMs = 5000,
  ): Promise<Extract<ServerMessage, { t: T }>> {
    const found = this.received.find((m) => m.t === t);
    if (found) return Promise.resolve(found as Extract<ServerMessage, { t: T }>);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for "${t}"`)), timeoutMs);
      this.waiters.push({
        predicate: (m) => m.t === t,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m as Extract<ServerMessage, { t: T }>);
        },
      });
    });
  }

  all<T extends ServerMessage["t"]>(t: T): Array<Extract<ServerMessage, { t: T }>> {
    return this.received.filter((m) => m.t === t) as Array<Extract<ServerMessage, { t: T }>>;
  }

  send(payload: unknown): void {
    this.ws.send(JSON.stringify(payload));
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}
