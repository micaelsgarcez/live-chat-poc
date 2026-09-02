#!/usr/bin/env node
/**
 * Seeds a local room with history and reactions.
 *
 * It deliberately goes through the public surface — dev tokens over HTTP and
 * real WebSockets — instead of writing to D1 directly: the point is to exercise
 * the same path a browser takes (pipeline, coordinator fanout, shard buffer,
 * persistence queue) so history and ranking end up holding data that could
 * actually have happened.
 *
 * Usage: node tools/seed/seed.mjs --help
 */
import { WebSocket } from "ws";

const DEFAULTS = {
  url: "http://127.0.0.1:8787",
  room: "demo",
  users: 5,
  messages: 40,
  reactions: 60,
  /** Global pacing; the default room allows ~1 msg/s/user with a burst of 5. */
  delay: 120,
};

const HELP = `live-chat local seeder

  node tools/seed/seed.mjs [options]

Options
  --url <url>        dev server origin        (default ${DEFAULTS.url})
  --room <id>        room to populate         (default ${DEFAULTS.room})
  --users <n>        distinct chatters        (default ${DEFAULTS.users})
  --messages <n>     messages to post total   (default ${DEFAULTS.messages})
  --reactions <n>    reactions to post total  (default ${DEFAULTS.reactions})
  --delay <ms>       pause between messages   (default ${DEFAULTS.delay})
  -h, --help         show this help

Example
  npm run dev                                   # in another terminal
  node tools/seed/seed.mjs --room demo --users 8 --messages 120
`;

const WORDS = [
  "hello", "the", "stream", "is", "live", "again", "nice", "play", "that", "was",
  "wild", "who", "is", "winning", "chat", "moving", "fast", "today", "good",
  "morning", "from", "lisbon", "let", "us", "go", "clip", "it", "unreal", "save",
  "this", "one", "workers", "durable", "objects", "scale", "well", "queue",
  "flush", "ranking", "update",
];
const EMOJIS = ["👍", "❤️", "😂", "🔥", "🎉"];

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sentence() {
  const length = 4 + Math.floor(Math.random() * 8);
  const words = Array.from({ length }, () => pick(WORDS));
  return `${words.join(" ")} #${Math.random().toString(36).slice(2, 7)}`;
}

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") return { help: true, options };
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    const key = (eq === -1 ? arg.slice(2) : arg.slice(2, eq)).replace(/-/g, "");
    const raw = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    switch (key) {
      case "url":
      case "room":
        options[key] = String(raw);
        break;
      case "users":
      case "messages":
      case "reactions":
      case "delay": {
        const value = Number(raw);
        if (!Number.isFinite(value) || value < 0) {
          throw new Error(`--${key} expects a non-negative number, got "${raw}"`);
        }
        options[key] = value;
        break;
      }
      default:
        throw new Error(`unknown option --${key}`);
    }
  }
  if (options.users < 1) throw new Error("--users must be at least 1");
  return { help: false, options };
}

function wsBase(httpUrl) {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.origin;
}

async function mintToken(base, userId, name) {
  const res = await fetch(`${base}/api/dev/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId, name, roles: [], ttlSeconds: 7200 }),
  });
  if (!res.ok) throw new Error(`POST /api/dev/token -> ${res.status}`);
  const body = await res.json();
  if (!body?.token) throw new Error("token response had no token");
  return body.token;
}

function connect(base, room, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `${base}/ws/${encodeURIComponent(room)}?token=${encodeURIComponent(token)}`,
    );
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("timed out waiting for the socket to open"));
    }, 10_000);
    ws.on("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

const stats = {
  users: 0,
  sent: 0,
  acked: 0,
  rejected: 0,
  retried: 0,
  reactions: 0,
  rejectedByCode: new Map(),
  messageIds: [],
};

/**
 * One chatter. Tracks its own acks so the seeder can hand real message ids to
 * the reaction phase, and retries once when a gate asks it to slow down.
 */
class Seeder {
  constructor(index, ws) {
    this.index = index;
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.on("message", (data) => this.onFrame(data.toString()));
  }

  onFrame(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.t === "ack") {
      const waiter = this.pending.get(msg.cid);
      if (waiter) {
        this.pending.delete(msg.cid);
        waiter.resolve({ ok: true, id: msg.id });
      }
    } else if (msg.t === "rejected") {
      const waiter = this.pending.get(msg.cid);
      if (waiter) {
        this.pending.delete(msg.cid);
        waiter.resolve({ ok: false, code: msg.code, retryAfterMs: msg.retryAfterMs ?? 0 });
      }
    }
  }

  send(body) {
    this.seq++;
    const cid = `seed-${this.index}-${this.seq}`;
    return new Promise((resolve) => {
      this.pending.set(cid, { resolve });
      this.ws.send(JSON.stringify({ t: "send", cid, body }));
      // Never hang the whole seed on a message the server silently dropped.
      setTimeout(() => {
        if (this.pending.delete(cid)) resolve({ ok: false, code: "timeout", retryAfterMs: 0 });
      }, 8_000);
    });
  }

  react(messageId, emoji) {
    this.seq++;
    this.ws.send(
      JSON.stringify({ t: "react", cid: `seed-r-${this.index}-${this.seq}`, messageId, emoji }),
    );
  }
}

async function post(seeder, body) {
  stats.sent++;
  let outcome = await seeder.send(body);
  if (!outcome.ok && outcome.retryAfterMs > 0) {
    // Slow-mode and rate-limit both answer with a retry hint; honour it once so
    // a tuned-down room still ends up with the history that was asked for.
    stats.retried++;
    await sleep(Math.min(outcome.retryAfterMs + 50, 5_000));
    outcome = await seeder.send(body);
  }
  if (outcome.ok) {
    stats.acked++;
    stats.messageIds.push(outcome.id);
  } else {
    stats.rejected++;
    stats.rejectedByCode.set(outcome.code, (stats.rejectedByCode.get(outcome.code) ?? 0) + 1);
  }
  return outcome;
}

async function readJson(url) {
  try {
    const res = await fetch(url);
    const data = await res.json().catch(() => null);
    return { status: res.status, ok: res.ok, data };
  } catch (error) {
    return { status: 0, ok: false, data: null, error: String(error) };
  }
}

async function run(options) {
  const base = options.url.replace(/\/$/, "");
  const sockets = wsBase(base);

  const seeders = [];
  for (let i = 0; i < options.users; i++) {
    const userId = `seed-user-${i + 1}`;
    const token = await mintToken(base, userId, `Seeder ${i + 1}`);
    const ws = await connect(sockets, options.room, token);
    seeders.push(new Seeder(i, ws));
    stats.users++;
  }
  process.stdout.write(`connected ${stats.users} seeders to "${options.room}"\n`);

  for (let i = 0; i < options.messages; i++) {
    const seeder = seeders[i % seeders.length];
    await post(seeder, sentence());
    if (options.delay > 0) await sleep(options.delay);
    if ((i + 1) % 25 === 0) process.stdout.write(`  ${i + 1}/${options.messages} messages\n`);
  }

  // Reactions come last so they always land on messages that exist, and they
  // are skewed towards the first ids so the ranking has a clear winner.
  for (let i = 0; i < options.reactions && stats.messageIds.length > 0; i++) {
    const skew = Math.floor(Math.random() ** 2 * stats.messageIds.length);
    const messageId = stats.messageIds[skew];
    seeders[i % seeders.length].react(messageId, pick(EMOJIS));
    stats.reactions++;
    if (options.delay > 0) await sleep(Math.min(options.delay, 30));
  }

  // Give the shard alarm a chance to flush its buffer into the persist queue.
  await sleep(2_500);

  const ranking = await readJson(`${base}/api/rooms/${encodeURIComponent(options.room)}/ranking`);
  const roomStats = await readJson(`${base}/api/rooms/${encodeURIComponent(options.room)}/stats`);

  for (const seeder of seeders) seeder.ws.close(1000, "seed finished");

  const codes = [...stats.rejectedByCode.entries()].map(([code, n]) => `${code}=${n}`);
  process.stdout.write(
    [
      "",
      "=== seed summary ===",
      `  room            ${options.room}`,
      `  users           ${stats.users}`,
      `  messages        ${stats.sent} sent, ${stats.acked} acked, ${stats.rejected} rejected, ${stats.retried} retried`,
      `  rejections      ${codes.length ? codes.join(", ") : "none"}`,
      `  reactions       ${stats.reactions}`,
      `  room stats      ${roomStats.ok ? JSON.stringify(roomStats.data?.stats ?? roomStats.data) : `unavailable (${roomStats.status})`}`,
      `  ranking         ${
        ranking.ok
          ? `${(ranking.data?.ranking?.top ?? ranking.data?.top ?? []).length} entries`
          : `unavailable (${ranking.status})`
      }`,
      "",
    ].join("\n"),
  );
  setTimeout(() => process.exit(0), 100).unref();
}

let parsed;
try {
  parsed = parseArgs(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${String(error.message ?? error)}\n\n${HELP}`);
  process.exit(2);
}

if (parsed.help) {
  process.stdout.write(HELP);
} else {
  run(parsed.options).catch((error) => {
    process.stderr.write(`seed failed: ${String(error)}\n`);
    process.stderr.write("is `npm run dev` running on the target url?\n");
    process.exit(1);
  });
}
