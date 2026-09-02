#!/usr/bin/env node
/**
 * Local load generator for the live chat.
 *
 * Opens N WebSockets against a running `wrangler dev`, has a subset of them
 * talk at a fixed *total* rate and measures what the room does under that
 * pressure. Node only (`ws` is already a devDependency) — nothing here runs
 * inside the Worker.
 *
 * Two latencies matter and they are different numbers:
 *   ack      — sender -> shard -> sender: how fast the inbound pipeline decides.
 *   delivery — sender -> shard -> coordinator -> every shard -> receiver: the
 *              end-to-end fanout, which is what a viewer actually feels.
 * Delivery is measured by embedding the send timestamp in the message body, so
 * every receiving client can compute it without extra bookkeeping.
 *
 * Usage: node tools/loadtest/run.mjs --help
 */
import { WebSocket } from "ws";

const DEFAULTS = {
  url: "ws://127.0.0.1:8787",
  room: "loadtest",
  clients: 20,
  rate: 10,
  duration: 30,
  ramp: 5,
  talkers: 0, // 0 = every client talks
  json: false,
};

const SEND_TICK_MS = 25;
/** Reservoir cap per latency series; a 50 msg/s run must not eat the heap. */
const MAX_SAMPLES = 50_000;

const HELP = `live-chat load generator

  node tools/loadtest/run.mjs [options]

Options
  --url <url>        WebSocket origin of the dev server   (default ${DEFAULTS.url})
  --room <id>        room to join                          (default ${DEFAULTS.room})
  --clients <n>      how many sockets to open              (default ${DEFAULTS.clients})
  --rate <n>         total messages per second, all talkers combined
                                                           (default ${DEFAULTS.rate})
  --duration <s>     how long to keep sending              (default ${DEFAULTS.duration})
  --ramp <s>         seconds to reach full clients + rate  (default ${DEFAULTS.ramp})
  --talkers <n>      how many clients send (rest only listen)
                                                           (default: all clients)
  --json             print the report as JSON instead of text
  -h, --help         show this help

Examples
  # smoke test: 10 sockets, 5 msg/s for 15s
  node tools/loadtest/run.mjs --clients 10 --rate 5 --duration 15

  # the 10-50 msg/s peak from PLAN.md, 200 viewers and 20 talkers
  node tools/loadtest/run.mjs --clients 200 --talkers 20 --rate 50 --duration 60 --ramp 10
`;

/* ------------------------------------------------------------------ */
/* arguments                                                           */
/* ------------------------------------------------------------------ */

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
      case "clients":
      case "rate":
      case "duration":
      case "ramp":
      case "talkers": {
        const value = Number(raw);
        if (!Number.isFinite(value) || value < 0) {
          throw new Error(`--${key} expects a non-negative number, got "${raw}"`);
        }
        options[key] = value;
        break;
      }
      case "json":
        if (eq !== -1) {
          options.json = raw !== "false";
        } else if (raw === "true" || raw === "false") {
          options.json = raw === "true";
        } else {
          // Bare `--json`: the next argv entry belongs to the next flag.
          options.json = true;
          if (raw !== undefined) i--;
        }
        break;
      default:
        throw new Error(`unknown option --${key}`);
    }
  }
  if (options.clients < 1) throw new Error("--clients must be at least 1");
  if (options.talkers === 0 || options.talkers > options.clients) {
    options.talkers = options.clients;
  }
  return { help: false, options };
}

function httpBase(wsUrl) {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return url.origin;
}

/* ------------------------------------------------------------------ */
/* metrics                                                             */
/* ------------------------------------------------------------------ */

class Samples {
  constructor(limit = MAX_SAMPLES) {
    this.limit = limit;
    this.values = [];
    this.count = 0;
  }

  add(value) {
    this.count++;
    if (this.values.length < this.limit) {
      this.values.push(value);
      return;
    }
    // Reservoir sampling: percentiles stay representative at a bounded cost.
    const slot = Math.floor(Math.random() * this.count);
    if (slot < this.limit) this.values[slot] = value;
  }

  summary() {
    if (this.values.length === 0) return { count: 0 };
    const sorted = [...this.values].sort((a, b) => a - b);
    const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    const sum = sorted.reduce((a, b) => a + b, 0);
    return {
      count: this.count,
      sampled: sorted.length,
      min: sorted[0],
      p50: at(0.5),
      p95: at(0.95),
      p99: at(0.99),
      max: sorted[sorted.length - 1],
      mean: Math.round((sum / sorted.length) * 100) / 100,
    };
  }
}

const metrics = {
  startedAt: 0,
  connectionsOpened: 0,
  connectionsFailed: 0,
  connectionsClosed: 0,
  helloReceived: 0,
  sent: 0,
  acked: 0,
  rejected: 0,
  rejectedByCode: new Map(),
  delivered: 0,
  presenceMax: 0,
  tokenFailures: 0,
  ackLatency: new Samples(),
  deliveryLatency: new Samples(),
  connectLatency: new Samples(),
  /** One bucket per elapsed second: what the room did while it was running. */
  timeline: [],
};

function bucket() {
  const second = Math.floor((Date.now() - metrics.startedAt) / 1000);
  let slot = metrics.timeline[second];
  if (!slot) {
    slot = { second, sent: 0, acked: 0, delivered: 0, rejected: 0, connections: 0 };
    metrics.timeline[second] = slot;
  }
  return slot;
}

/* ------------------------------------------------------------------ */
/* clients                                                             */
/* ------------------------------------------------------------------ */

const clients = [];
let stopping = false;

async function mintToken(base, userId, name) {
  const res = await fetch(`${base}/api/dev/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId, name, roles: [], ttlSeconds: 7200 }),
  });
  if (!res.ok) throw new Error(`token ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const body = await res.json();
  if (!body?.token) throw new Error("token response had no token");
  return body.token;
}

function spawnClient(index, options, base) {
  const userId = `lt-${index}`;
  const client = {
    index,
    userId,
    ws: null,
    open: false,
    talker: index < options.talkers,
    seq: 0,
    /** cid -> send timestamp, for the ack latency of in-flight messages. */
    inflight: new Map(),
  };
  clients.push(client);

  const startedAt = Date.now();
  mintToken(base, userId, `load-${index}`)
    .then((token) => {
      if (stopping) return;
      const target = `${options.url.replace(/\/$/, "")}/ws/${encodeURIComponent(options.room)}?token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(target);
      client.ws = ws;

      ws.on("open", () => {
        client.open = true;
        metrics.connectionsOpened++;
        metrics.connectLatency.add(Date.now() - startedAt);
      });

      ws.on("message", (data) => onFrame(client, data.toString()));

      ws.on("error", () => {
        // `close` always follows; count the failure only if we never opened.
        if (!client.open) metrics.connectionsFailed++;
      });

      ws.on("close", () => {
        if (client.open) metrics.connectionsClosed++;
        client.open = false;
      });
    })
    .catch(() => {
      metrics.tokenFailures++;
      metrics.connectionsFailed++;
    });
}

function onFrame(client, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  const now = Date.now();
  switch (msg.t) {
    case "hello":
      metrics.helloReceived++;
      break;
    case "ack": {
      const sentAt = client.inflight.get(msg.cid);
      if (sentAt !== undefined) {
        client.inflight.delete(msg.cid);
        metrics.ackLatency.add(now - sentAt);
      }
      metrics.acked++;
      bucket().acked++;
      break;
    }
    case "rejected": {
      client.inflight.delete(msg.cid);
      metrics.rejected++;
      bucket().rejected++;
      metrics.rejectedByCode.set(msg.code, (metrics.rejectedByCode.get(msg.code) ?? 0) + 1);
      break;
    }
    case "msg": {
      metrics.delivered++;
      bucket().delivered++;
      const stamp = /@(\d+)\|/.exec(msg.m?.body ?? "");
      if (stamp) metrics.deliveryLatency.add(now - Number(stamp[1]));
      break;
    }
    case "presence":
      metrics.presenceMax = Math.max(metrics.presenceMax, msg.count ?? 0);
      break;
    default:
      break;
  }
}

function sendOne(client) {
  if (!client.open || client.ws?.readyState !== WebSocket.OPEN) return false;
  client.seq++;
  const cid = `${client.index}-${client.seq}`;
  const now = Date.now();
  // The timestamp travels in the body so *receivers* can measure fanout; the
  // sequence keeps every body unique, which the spam gate cares about.
  const body = `loadtest ${client.index}#${client.seq} @${now}| lorem ipsum`;
  client.inflight.set(cid, now);
  try {
    client.ws.send(JSON.stringify({ t: "send", cid, body }));
  } catch {
    return false;
  }
  metrics.sent++;
  bucket().sent++;
  return true;
}

/* ------------------------------------------------------------------ */
/* report                                                              */
/* ------------------------------------------------------------------ */

function pad(text, width) {
  return String(text).padEnd(width);
}

function latencyLine(label, summary) {
  if (!summary.count) return `  ${pad(label, 16)} no samples`;
  return `  ${pad(label, 16)} p50 ${pad(`${summary.p50}ms`, 8)} p95 ${pad(`${summary.p95}ms`, 8)} p99 ${pad(`${summary.p99}ms`, 8)} max ${pad(`${summary.max}ms`, 8)} n=${summary.count}`;
}

function buildReport(options, partial) {
  const elapsedMs = Math.max(1, Date.now() - metrics.startedAt);
  const seconds = elapsedMs / 1000;
  const connected = clients.filter((c) => c.open).length;
  return {
    partial,
    target: { url: options.url, room: options.room },
    plan: {
      clients: options.clients,
      talkers: options.talkers,
      rate: options.rate,
      duration: options.duration,
      ramp: options.ramp,
    },
    elapsedSeconds: Math.round(seconds * 100) / 100,
    connections: {
      requested: options.clients,
      spawned: clients.length,
      // Sockets that neither opened nor errored: the server is still handshaking.
      connecting: Math.max(0, clients.length - metrics.connectionsOpened - metrics.connectionsFailed),
      opened: metrics.connectionsOpened,
      failed: metrics.connectionsFailed,
      closed: metrics.connectionsClosed,
      openNow: connected,
      hello: metrics.helloReceived,
      tokenFailures: metrics.tokenFailures,
      presenceMax: metrics.presenceMax,
    },
    messages: {
      sent: metrics.sent,
      acked: metrics.acked,
      rejected: metrics.rejected,
      inflight: clients.reduce((total, c) => total + c.inflight.size, 0),
      deliveredFrames: metrics.delivered,
      rejectedByCode: Object.fromEntries(metrics.rejectedByCode),
    },
    throughput: {
      sentPerSecond: Math.round((metrics.sent / seconds) * 100) / 100,
      ackedPerSecond: Math.round((metrics.acked / seconds) * 100) / 100,
      deliveredFramesPerSecond: Math.round((metrics.delivered / seconds) * 100) / 100,
    },
    latency: {
      connectMs: metrics.connectLatency.summary(),
      ackMs: metrics.ackLatency.summary(),
      deliveryMs: metrics.deliveryLatency.summary(),
    },
    timeline: metrics.timeline.filter(Boolean),
  };
}

function printReport(report) {
  const lines = [];
  lines.push("");
  lines.push(`=== live-chat load test ${report.partial ? "(partial — interrupted)" : "report"} ===`);
  lines.push(`  ${pad("target", 16)} ${report.target.url}  room=${report.target.room}`);
  lines.push(
    `  ${pad("plan", 16)} ${report.plan.clients} clients / ${report.plan.talkers} talkers / ${report.plan.rate} msg/s / ${report.plan.duration}s (ramp ${report.plan.ramp}s)`,
  );
  lines.push(`  ${pad("elapsed", 16)} ${report.elapsedSeconds}s`);
  lines.push("");
  lines.push(
    `  ${pad("connections", 16)} ${report.connections.opened}/${report.connections.requested} opened, ${report.connections.failed} failed, ${report.connections.connecting} still handshaking, ${report.connections.openNow} open at the end (peak presence ${report.connections.presenceMax})`,
  );
  lines.push(
    `  ${pad("messages", 16)} ${report.messages.sent} sent, ${report.messages.acked} acked, ${report.messages.rejected} rejected, ${report.messages.inflight} unanswered`,
  );
  lines.push(`  ${pad("fanout frames", 16)} ${report.messages.deliveredFrames} received by all clients`);
  const codes = Object.entries(report.messages.rejectedByCode);
  lines.push(
    `  ${pad("rejections", 16)} ${codes.length ? codes.map(([code, n]) => `${code}=${n}`).join(", ") : "none"}`,
  );
  lines.push("");
  lines.push(
    `  ${pad("throughput", 16)} sent ${report.throughput.sentPerSecond}/s, acked ${report.throughput.ackedPerSecond}/s, delivered ${report.throughput.deliveredFramesPerSecond} frames/s`,
  );
  lines.push(latencyLine("connect", report.latency.connectMs));
  lines.push(latencyLine("ack", report.latency.ackMs));
  lines.push(latencyLine("delivery e2e", report.latency.deliveryMs));
  lines.push("");
  lines.push(
    `  ${pad("second", 8)}${pad("sockets", 9)}${pad("sent", 8)}${pad("acked", 8)}${pad("rejected", 10)}${pad("frames", 8)}`,
  );
  for (const slot of report.timeline) {
    lines.push(
      `  ${pad(slot.second, 8)}${pad(slot.connections, 9)}${pad(slot.sent, 8)}${pad(slot.acked, 8)}${pad(slot.rejected, 10)}${pad(slot.delivered, 8)}`,
    );
  }
  lines.push("");
  process.stdout.write(`${lines.join("\n")}\n`);
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

function finish(options, partial) {
  if (stopping) return;
  stopping = true;
  for (const client of clients) {
    try {
      client.ws?.close(1000, "load test finished");
    } catch {
      /* already gone */
    }
  }
  const report = buildReport(options, partial);
  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else printReport(report);
  // Sockets are closing in the background; nothing left to wait for.
  setTimeout(() => process.exit(0), 100).unref();
}

async function run(options) {
  const base = httpBase(options.url);
  metrics.startedAt = Date.now();

  const rampMs = options.ramp * 1000;
  const spacing = options.clients > 1 ? rampMs / options.clients : 0;
  for (let i = 0; i < options.clients; i++) {
    setTimeout(() => {
      if (!stopping) spawnClient(i, options, base);
    }, Math.round(i * spacing)).unref();
  }

  /**
   * Messages are scheduled against the integral of the (ramping) rate instead
   * of a fixed interval, so a slow tick never silently lowers the load.
   */
  const targetSentBy = (elapsedMs) => {
    const t = elapsedMs / 1000;
    if (rampMs > 0 && t < options.ramp) return (options.rate * t * t) / (2 * options.ramp);
    return options.rate * (t - options.ramp / 2);
  };

  let cursor = 0;
  const ticker = setInterval(() => {
    if (stopping) return;
    const elapsed = Date.now() - metrics.startedAt;
    bucket().connections = clients.filter((c) => c.open).length;
    const talkers = clients.filter((c) => c.talker && c.open);
    if (talkers.length === 0) return;
    let due = Math.max(0, Math.floor(targetSentBy(elapsed)) - metrics.sent);
    // Cap per tick so a stalled server cannot produce a thundering catch-up.
    due = Math.min(due, Math.max(1, Math.ceil(options.rate * (SEND_TICK_MS / 1000) * 4)));
    for (let i = 0; i < due; i++) {
      const client = talkers[cursor++ % talkers.length];
      sendOne(client);
    }
  }, SEND_TICK_MS);
  ticker.unref?.();

  setTimeout(() => {
    clearInterval(ticker);
    // A short drain window lets the last acks and fanout frames land.
    setTimeout(() => finish(options, false), 750);
  }, options.duration * 1000 + rampMs);

  process.on("SIGINT", () => {
    clearInterval(ticker);
    finish(options, true);
  });
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
    process.stderr.write(`load test failed: ${String(error)}\n`);
    process.exit(1);
  });
}
