#!/usr/bin/env node
/**
 * Load generator for the live chat.
 *
 * Opens N WebSockets against a deployment, has a subset of them talk, and
 * reports what the room did — with a verdict, not just a table.
 *
 * The run has four phases and they are not decoration:
 *
 *   ramp   60s of opening sockets and raising the send rate to full.
 *   hold   30s at full load. **This is the only window the verdict judges**;
 *          a transient tells you nothing about a system's steady state.
 *   drain  every socket closed at once. A live ending is a mass disconnect,
 *          and it is the cheapest way to find state that never gets cleaned up.
 *   done   report, verdict, cost.
 *
 * Two latencies matter and they are different numbers:
 *   ack      sender -> shard -> sender: how fast the inbound pipeline decides.
 *   delivery sender -> shard -> coordinator -> every shard -> receiver: the
 *            end-to-end fanout, which is what a viewer actually feels.
 *
 * Nothing here runs inside the Worker. `ws` is already a devDependency and the
 * JWTs are signed locally, so a run costs no extra requests to set itself up.
 *
 * Usage: node tools/loadtest/run.mjs --help
 */
import { WebSocket } from "ws";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { signJwt, makeBypassSigner, LOADTEST_BYPASS_HEADER } from "./signing.mjs";
import { estimateCost, readAccountUsage, usageDelta } from "./cost.mjs";
import { evaluate, diagnoseSaturation, SLO } from "./verdict.mjs";
import { messageFor, nameFor } from "./voice.mjs";

/**
 * Mirrors `src/features/loadtest/presets.ts`. The server's copy is
 * authoritative and fetched when reachable; this exists so `--help` and a dry
 * run work with nothing deployed.
 */
const FALLBACK_PRESETS = [
  { name: "smoke", connections: 1_000, talkers: 200, shards: 1, machines: 1, rampSeconds: 60, holdSeconds: 30 },
  { name: "small", connections: 10_000, talkers: 2_000, shards: 2, machines: 1, rampSeconds: 60, holdSeconds: 30 },
  { name: "medium", connections: 50_000, talkers: 10_000, shards: 10, machines: 5, rampSeconds: 60, holdSeconds: 30 },
  { name: "large", connections: 100_000, talkers: 20_000, shards: 20, machines: 10, rampSeconds: 60, holdSeconds: 30 },
  { name: "xlarge", connections: 200_000, talkers: 35_000, shards: 40, machines: 20, rampSeconds: 60, holdSeconds: 30 },
  { name: "max", connections: 300_000, talkers: 50_000, shards: 60, machines: 30, rampSeconds: 60, holdSeconds: 30 },
];

const DEFAULTS = {
  url: "ws://127.0.0.1:8787",
  room: "loadtest",
  preset: "",
  clients: 20,
  rate: 0,
  perTalkerRate: 0.1,
  duration: 30,
  ramp: 5,
  talkers: 0,
  node: 0,
  nodes: 1,
  announce: true,
  drainTimeout: 30,
  json: false,
  out: "",
  jwtSecret: "",
  moderatorKey: "",
  bypassKey: "",
  issuer: "https://auth.local.test",
  audience: "live-chat",
};

const SEND_TICK_MS = 25;
const PROGRESS_TICK_MS = 1000;
/**
 * How often to ask the room for its per-shard socket counts.
 *
 * Much rarer than the progress tick, and not a detail: `/observability` fans in
 * over *every* shard, so at 60 shards a one-second poll is 60 extra Durable
 * Object calls a second — a second load test running alongside the first one.
 * `/stats` only touches the coordinator, so that one can stay at 1s.
 */
const SHARD_POLL_EVERY = 5;
/** Reservoir cap per latency series; a long run must not eat the heap. */
const MAX_SAMPLES = 50_000;
/** Own-message ids tracked per client, for the "nothing acked was lost" check. */
const MAX_TRACKED_OWN = 200;

const HELP = `live-chat load generator

  node tools/loadtest/run.mjs [options]

Target
  --url <url>          WebSocket origin                      (default ${DEFAULTS.url})
  --room <id>          room to join                          (default ${DEFAULTS.room})

Shape — pick a preset, or set the numbers yourself
  --preset <name>      ${FALLBACK_PRESETS.map((p) => p.name).join(" | ")}
  --clients <n>        sockets to open                       (default ${DEFAULTS.clients})
  --talkers <n>        how many of them send                 (default: all)
  --rate <n>           total messages per second, all talkers combined
  --per-talker-rate <n>  msg/s each talker sends, when --rate is not given
                                                             (default ${DEFAULTS.perTalkerRate})
  --ramp <s>           seconds to reach full load            (default ${DEFAULTS.ramp})
  --duration <s>       seconds to hold at full load          (default ${DEFAULTS.duration})

Splitting one preset across machines
  --nodes <n>          how many generators share this preset (default 1)
  --node <i>           which one this is, 0-based            (default 0)

Credentials — all optional, all read from the environment when omitted
  --jwt-secret <s>     HS256 secret; signs tokens locally instead of calling
                       /api/dev/token once per client        (env JWT_HS256_SECRET)
  --moderator-key <s>  announces the run so the public page can show it
                                                             (env MODERATOR_API_KEY)
  --bypass-key <s>     skips the edge connection limit for this run
                                                             (env LOADTEST_BYPASS_KEY)
  --issuer / --audience  JWT claims, must match the deployment

Output
  --json               print the report as JSON
  --out <file>         also write the JSON report to a file
  --no-announce        do not tell the room a test is running
  -h, --help           this text

Examples
  # smallest step: does the room work at all?
  node tools/loadtest/run.mjs --preset smoke --url wss://live-chat.example.workers.dev

  # this machine's share of a 50k run split across five machines
  node tools/loadtest/run.mjs --preset medium --nodes 5 --node 2

  # ad-hoc, local
  node tools/loadtest/run.mjs --clients 25 --talkers 8 --rate 12 --duration 20
`;

/* ------------------------------------------------------------------ */
/* arguments                                                           */
/* ------------------------------------------------------------------ */

const NUMERIC = new Set([
  "clients",
  "rate",
  "pertalkerrate",
  "duration",
  "ramp",
  "talkers",
  "node",
  "nodes",
  "draintimeout",
]);
const STRING = new Set([
  "url",
  "room",
  "preset",
  "out",
  "jwtsecret",
  "moderatorkey",
  "bypasskey",
  "issuer",
  "audience",
]);
const CAMEL = {
  pertalkerrate: "perTalkerRate",
  draintimeout: "drainTimeout",
  jwtsecret: "jwtSecret",
  moderatorkey: "moderatorKey",
  bypasskey: "bypassKey",
};

function parseArgs(argv) {
  // Tracked so auto-discovery can fill in what the operator left alone without
  // ever overriding something they typed.
  const options = { ...DEFAULTS, _explicit: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") return { help: true, options };
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    const rawKey = (eq === -1 ? arg.slice(2) : arg.slice(2, eq)).replace(/-/g, "").toLowerCase();
    const raw = eq === -1 ? argv[i + 1] : arg.slice(eq + 1);

    if (rawKey === "noannounce") {
      options.announce = false;
      continue;
    }
    if (rawKey === "json") {
      if (eq !== -1) options.json = raw !== "false";
      else if (raw === "true" || raw === "false") {
        options.json = raw === "true";
        i++;
      } else options.json = true;
      continue;
    }

    const key = CAMEL[rawKey] ?? rawKey;
    if (NUMERIC.has(rawKey)) {
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`--${rawKey} expects a non-negative number, got "${raw}"`);
      }
      options[key] = value;
      if (eq === -1) i++;
    } else if (STRING.has(rawKey)) {
      options[key] = String(raw ?? "");
      options._explicit.add(key);
      if (eq === -1) i++;
    } else {
      throw new Error(`unknown option --${rawKey}`);
    }
  }
  return { help: false, options };
}

/** Falls back to `.dev.vars`, so a local run needs no flags and no exports. */
function readDevVars() {
  try {
    const vars = {};
    for (const line of readFileSync(".dev.vars", "utf8").split("\n")) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/.exec(line);
      if (match) vars[match[1]] = match[2];
    }
    return vars;
  } catch {
    return {};
  }
}

function httpBase(wsUrl) {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return url.origin;
}

/** This machine's slice of a preset, so `--nodes 5` splits it five ways. */
function shareOf(total, node, nodes) {
  if (nodes <= 1) return total;
  const base = Math.floor(total / nodes);
  return base + (node < total % nodes ? 1 : 0);
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
  phase: "ramp",
  phaseChangedAt: {},
  connectionsOpened: 0,
  connectionsFailed: 0,
  connectionsClosed: 0,
  helloReceived: 0,
  sent: 0,
  acked: 0,
  rejected: 0,
  rejectedByCode: new Map(),
  delivered: 0,
  batchFrames: 0,
  sampledOut: 0,
  ownDelivered: 0,
  ownPending: 0,
  presenceMax: 0,
  errorCodes: {},
  /** Latencies, split so the hold window can be judged on its own. */
  ackLatency: new Samples(),
  deliveryLatency: new Samples(),
  connectLatency: new Samples(),
  holdAck: new Samples(),
  holdDelivery: new Samples(),
  holdOpened: 0,
  holdFailed: 0,
  holdRequested: 0,
  holdAcked: 0,
  holdOwnDelivered: 0,
  openAtHoldEnd: 0,
  maxShardSockets: 0,
  maxSocketsPerShard: 0,
  shardCount: 0,
  batchWindowMs: 0,
  drainSeconds: null,
  presenceAfterDrain: null,
  timeline: [],
};

function inHold() {
  return metrics.phase === "hold";
}

function bucket() {
  const second = Math.floor((Date.now() - metrics.startedAt) / 1000);
  let slot = metrics.timeline[second];
  if (!slot) {
    slot = {
      second,
      phase: metrics.phase,
      sent: 0,
      acked: 0,
      delivered: 0,
      rejected: 0,
      dropped: 0,
      connections: 0,
    };
    metrics.timeline[second] = slot;
  }
  return slot;
}

/* ------------------------------------------------------------------ */
/* clients                                                             */
/* ------------------------------------------------------------------ */

const clients = [];
let stopping = false;
let bypassSigner = () => null;

/**
 * How far behind the generator's own event loop is running.
 *
 * This is the instrument measuring itself, and it is not optional. Every
 * latency in this report is timed with `Date.now()` inside this process, so a
 * backed-up event loop inflates *all* of them equally — and the result looks
 * exactly like a slow server. The giveaway is delivery latency coming out at or
 * below ack latency, which cannot happen when the room is the bottleneck.
 *
 * One Node process parsing 10k+ messages a second will do this. Without the
 * number below there is no way to tell that reading from a real result, and a
 * load test that cannot tell its own lag from the server's is worse than none.
 */
const loopDelay = monitorEventLoopDelay({ resolution: 10 });

function spawnClient(index, options, context) {
  const userId = `lt-${options.node}-${index}`;
  const client = {
    index,
    userId,
    ws: null,
    open: false,
    talker: index < options.talkers,
    seq: 0,
    /** cid -> send timestamp, for the ack latency of in-flight messages. */
    inflight: new Map(),
    /** message id -> whether it came back to us. Bounded; see MAX_TRACKED_OWN. */
    own: new Map(),
  };
  clients.push(client);

  const startedAt = Date.now();
  let token;
  try {
    token = signJwt({
      secret: context.jwtSecret,
      userId,
      name: nameFor(index),
      issuer: options.issuer,
      audience: options.audience,
    });
  } catch (error) {
    metrics.connectionsFailed++;
    noteError(error);
    return;
  }

  const target = `${options.url.replace(/\/$/, "")}/ws/${encodeURIComponent(options.room)}?token=${encodeURIComponent(token)}`;
  const headers = {};
  const bypass = bypassSigner();
  if (bypass) headers[LOADTEST_BYPASS_HEADER] = bypass;

  const ws = new WebSocket(target, { headers });
  client.ws = ws;

  ws.on("open", () => {
    client.open = true;
    metrics.connectionsOpened++;
    metrics.connectLatency.add(Date.now() - startedAt);
  });

  ws.on("message", (data) => onFrame(client, data.toString()));

  ws.on("error", (error) => {
    // `close` always follows; count the failure only if we never opened.
    if (!client.open) {
      metrics.connectionsFailed++;
      noteError(error);
    }
  });

  ws.on("close", () => {
    if (client.open) metrics.connectionsClosed++;
    client.open = false;
  });
}

function noteError(error) {
  // A socket that never opened is the single most important thing to classify,
  // and `ws` reports an HTTP rejection as a plain message with no `code` — so
  // without this every 401 in a run lands in the same "UNKNOWN" bucket as an
  // exhausted port table, which is exactly the confusion this tool exists to
  // prevent.
  const message = String(error?.message ?? "");
  const status = /Unexpected server response:\s*(\d{3})/.exec(message);
  const code = status ? `HTTP_${status[1]}` : (error?.code ?? error?.errno ?? "UNKNOWN");
  metrics.errorCodes[code] = (metrics.errorCodes[code] ?? 0) + 1;
}

function onFrame(client, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  apply(client, msg, Date.now());
}

function apply(client, msg, now) {
  switch (msg.t) {
    case "batch": {
      metrics.batchFrames++;
      if (msg.dropped > 0) {
        metrics.sampledOut += msg.dropped;
        bucket().dropped += msg.dropped;
      }
      for (const inner of msg.events) apply(client, inner, now);
      return;
    }
    case "hello":
      metrics.helloReceived++;
      if (typeof msg.config?.maxDeliveredPerSecond === "number") {
        metrics.viewerCap = msg.config.maxDeliveredPerSecond;
      }
      return;
    case "ack": {
      const sentAt = client.inflight.get(msg.cid);
      if (sentAt !== undefined) {
        client.inflight.delete(msg.cid);
        const latency = now - sentAt;
        metrics.ackLatency.add(latency);
        if (inHold()) metrics.holdAck.add(latency);
      }
      metrics.acked++;
      if (inHold()) metrics.holdAcked++;
      bucket().acked++;
      // Tracked so the run can prove no acked message vanished. Bounded: the
      // oldest is dropped rather than letting a long run grow without limit.
      if (client.own.size >= MAX_TRACKED_OWN) {
        const oldest = client.own.keys().next().value;
        if (client.own.get(oldest) === false) metrics.ownPending--;
        client.own.delete(oldest);
      }
      // The fanout reaches the sender's own socket *before* the ack does — the
      // shard publishes, then acks — so by the time we see the ack the message
      // has usually already come back. Both orders have to work.
      if (client.own.get(msg.id) === true) {
        metrics.ownDelivered++;
        if (inHold()) metrics.holdOwnDelivered++;
      } else {
        client.own.set(msg.id, false);
        metrics.ownPending++;
      }
      return;
    }
    case "rejected":
      client.inflight.delete(msg.cid);
      metrics.rejected++;
      bucket().rejected++;
      metrics.rejectedByCode.set(msg.code, (metrics.rejectedByCode.get(msg.code) ?? 0) + 1);
      return;
    case "msg": {
      metrics.delivered++;
      bucket().delivered++;
      const stamp = /@(\d+)\|/.exec(msg.m?.body ?? "");
      if (stamp) {
        const latency = now - Number(stamp[1]);
        metrics.deliveryLatency.add(latency);
        if (inHold()) metrics.holdDelivery.add(latency);
      }
      if (msg.m?.userId === client.userId) {
        const known = client.own.get(msg.m.id);
        if (known === false) {
          // The ack got here first: resolve the message it was waiting for.
          client.own.set(msg.m.id, true);
          metrics.ownPending--;
          metrics.ownDelivered++;
          if (inHold()) metrics.holdOwnDelivered++;
        } else if (known === undefined) {
          // The usual order: remember it so the ack can settle immediately.
          client.own.set(msg.m.id, true);
        }
      }
      return;
    }
    case "presence":
      metrics.presenceMax = Math.max(metrics.presenceMax, msg.count ?? 0);
      return;
    default:
      return;
  }
}

function sendOne(client) {
  if (!client.open || client.ws?.readyState !== WebSocket.OPEN) return false;
  client.seq++;
  const cid = `${client.index}-${client.seq}`;
  const now = Date.now();
  // The timestamp travels in the body so *receivers* can measure fanout. The
  // rest is generated in the product's own voice, because a run is visible on
  // the public page while it happens — see voice.mjs.
  const body = messageFor(client.index, client.seq, now);
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
/* the room's own view                                                 */
/* ------------------------------------------------------------------ */

async function fetchJson(url, init = {}) {
  try {
    const res = await fetch(url, init);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function readRoomStats(base, room) {
  const payload = await fetchJson(`${base}/api/rooms/${encodeURIComponent(room)}/stats`);
  return payload?.stats ?? null;
}

/**
 * Per-shard socket counts, which `/stats` only reports in aggregate. Needed for
 * the "no shard went over its ceiling" criterion: a room can hold the right
 * total and still have piled everyone onto one shard.
 */
async function readShardLoad(base, room) {
  const payload = await fetchJson(`${base}/api/rooms/${encodeURIComponent(room)}/observability`);
  const shards = payload?.snapshot?.shards;
  if (!Array.isArray(shards) || shards.length === 0) return null;
  return Math.max(...shards.map((shard) => shard.connections ?? 0));
}

async function readRoomConfig(base, room) {
  const payload = await fetchJson(`${base}/api/rooms/${encodeURIComponent(room)}/config`);
  return payload?.config ?? null;
}

/**
 * Asks the deployment what it puts in its own tokens.
 *
 * The generator signs 300k JWTs locally, so `iss` and `aud` have to match the
 * target exactly — and a mismatch fails *every* handshake with a 401, which
 * looks identical to a capacity wall until you decode a token. Minting one
 * token and reading the claims off it costs a single request for the whole run
 * and removes the class of error entirely.
 *
 * Returns null when the route is disabled (`ENVIRONMENT=production`), in which
 * case the flags are the only source and the operator is told so.
 */
async function discoverClaims(base) {
  const payload = await fetchJson(`${base}/api/dev/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: "loadtest-probe", name: "probe" }),
  });
  if (!payload?.token) return null;
  try {
    const [, body] = payload.token.split(".");
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof claims.iss !== "string" || typeof claims.aud !== "string") return null;
    return { issuer: claims.iss, audience: claims.aud };
  } catch {
    return null;
  }
}

async function readPresets(base, room) {
  const payload = await fetchJson(`${base}/api/rooms/${encodeURIComponent(room)}/loadtest`);
  return Array.isArray(payload?.presets) && payload.presets.length ? payload.presets : null;
}

async function announceRun(base, room, key, body) {
  if (!key) return null;
  return fetchJson(`${base}/api/rooms/${encodeURIComponent(room)}/loadtest`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-moderator-key": key },
    body: JSON.stringify(body),
  });
}

async function reportProgress(base, room, key, body) {
  if (!key) return;
  await fetchJson(`${base}/api/rooms/${encodeURIComponent(room)}/loadtest`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-moderator-key": key },
    body: JSON.stringify(body),
  });
}

async function endRun(base, room, key) {
  if (!key) return;
  await fetchJson(`${base}/api/rooms/${encodeURIComponent(room)}/loadtest`, {
    method: "DELETE",
    headers: { "x-moderator-key": key },
  });
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

function portRange() {
  try {
    const [start, end] = readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8")
      .trim()
      .split(/\s+/)
      .map(Number);
    return { start, end };
  } catch {
    // Not Linux, or not readable: assume the common default rather than guess.
    return { start: 32768, end: 60999 };
  }
}

/** Nanoseconds to whole milliseconds; the histogram reports in ns. */
const toMs = (ns) => Math.round(ns / 1e6);

function buildReport(options, context, partial) {
  loopDelay.disable();
  const generatorLagMs = {
    p50: toMs(loopDelay.percentile(50)),
    p99: toMs(loopDelay.percentile(99)),
    max: toMs(loopDelay.max),
  };
  const elapsedMs = Math.max(1, Date.now() - metrics.startedAt);
  const seconds = elapsedMs / 1000;
  const connected = clients.filter((c) => c.open).length;

  const verdict = evaluate({
    opened: metrics.holdOpened || metrics.connectionsOpened,
    requested: options.clients,
    failed: metrics.connectionsFailed,
    acked: metrics.holdAcked,
    deliveredOwn: metrics.holdOwnDelivered,
    presenceMax: metrics.presenceMax,
    openAtHold: metrics.openAtHoldEnd || connected,
    maxShardSockets: metrics.maxShardSockets,
    maxSocketsPerShard: metrics.maxSocketsPerShard,
    ackLatency: metrics.holdAck.summary(),
    deliveryLatency: metrics.holdDelivery.summary(),
  });

  const cost = estimateCost({
    handshakes: metrics.connectionsOpened,
    inboundMessages: metrics.sent,
    publishedMessages: metrics.acked,
    shardCount: metrics.shardCount || 1,
    batchWindowMs: metrics.batchWindowMs,
    runSeconds: seconds,
  });

  return {
    partial,
    target: { url: options.url, room: options.room },
    plan: {
      preset: options.preset || "custom",
      node: options.node,
      nodes: options.nodes,
      clients: options.clients,
      talkers: options.talkers,
      rate: options.rate,
      rampSeconds: options.ramp,
      holdSeconds: options.duration,
      bypass: Boolean(context.bypassKey),
      announced: Boolean(context.moderatorKey) && options.announce,
    },
    room: {
      shardCount: metrics.shardCount,
      maxSocketsPerShard: metrics.maxSocketsPerShard,
      batchWindowMs: metrics.batchWindowMs,
      maxDeliveredPerSecond: metrics.viewerCap ?? 0,
      busiestShard: metrics.maxShardSockets,
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
      openAtHoldEnd: metrics.openAtHoldEnd,
      hello: metrics.helloReceived,
      presenceMax: metrics.presenceMax,
      errorCodes: metrics.errorCodes,
    },
    messages: {
      sent: metrics.sent,
      acked: metrics.acked,
      rejected: metrics.rejected,
      inflight: clients.reduce((total, c) => total + c.inflight.size, 0),
      deliveredFrames: metrics.delivered,
      batchFrames: metrics.batchFrames,
      sampledOut: metrics.sampledOut,
      ownDelivered: metrics.ownDelivered,
      ownPending: metrics.ownPending,
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
      holdAckMs: metrics.holdAck.summary(),
      holdDeliveryMs: metrics.holdDelivery.summary(),
    },
    drain: {
      seconds: metrics.drainSeconds,
      presenceAfter: metrics.presenceAfterDrain,
    },
    verdict,
    generatorLagMs,
    saturation: diagnoseSaturation({
      requested: options.clients,
      opened: metrics.connectionsOpened,
      failed: metrics.connectionsFailed,
      portRange: portRange(),
      errorCodes: metrics.errorCodes,
      generatorLagMs,
      framesPerSecond: Math.round(metrics.delivered / seconds),
      ackP50: metrics.holdAck.summary().p50,
      deliveryP50: metrics.holdDelivery.summary().p50,
    }),
    cost: { estimated: cost, measured: context.usage ?? null },
    slo: SLO,
    timeline: metrics.timeline.filter(Boolean),
  };
}

function printReport(report) {
  const lines = [];
  const p = (line) => lines.push(line);
  p("");
  p(`=== live-chat load test ${report.partial ? "(partial — interrupted)" : "report"} ===`);
  p(`  ${pad("target", 18)} ${report.target.url}  room=${report.target.room}`);
  p(
    `  ${pad("plan", 18)} ${report.plan.preset} — ${report.plan.clients} clients / ${report.plan.talkers} talkers / ${report.plan.rate} msg/s, ramp ${report.plan.rampSeconds}s + hold ${report.plan.holdSeconds}s` +
      (report.plan.nodes > 1 ? `  [node ${report.plan.node + 1} of ${report.plan.nodes}]` : ""),
  );
  p(
    `  ${pad("room", 18)} ${report.room.shardCount} shards, ceiling ${report.room.maxSocketsPerShard}/shard, batch window ${report.room.batchWindowMs}ms, viewer cap ${report.room.maxDeliveredPerSecond || "off"}`,
  );
  if (report.plan.bypass) p(`  ${pad("", 18)} ⚠ edge connection limit BYPASSED for this run`);
  p(`  ${pad("elapsed", 18)} ${report.elapsedSeconds}s`);
  p("");
  p(
    `  ${pad("connections", 18)} ${report.connections.opened}/${report.connections.requested} opened, ${report.connections.failed} failed, ${report.connections.connecting} still handshaking, ${report.connections.openNow} open at the end (peak presence ${report.connections.presenceMax})`,
  );
  p(
    `  ${pad("messages", 18)} ${report.messages.sent} sent, ${report.messages.acked} acked, ${report.messages.rejected} rejected, ${report.messages.inflight} unanswered`,
  );
  p(
    `  ${pad("fanout", 18)} ${report.messages.deliveredFrames} messages in ${report.messages.batchFrames} batch frames, ${report.messages.sampledOut} withheld by the viewer cap`,
  );
  const codes = Object.entries(report.messages.rejectedByCode);
  p(`  ${pad("rejections", 18)} ${codes.length ? codes.map(([c, n]) => `${c}=${n}`).join(", ") : "none"}`);
  p("");
  p(
    `  ${pad("throughput", 18)} sent ${report.throughput.sentPerSecond}/s, acked ${report.throughput.ackedPerSecond}/s, delivered ${report.throughput.deliveredFramesPerSecond} msg/s`,
  );
  p(latencyLine("connect", report.latency.connectMs));
  p(latencyLine("ack (all)", report.latency.ackMs));
  p(latencyLine("ack (hold)", report.latency.holdAckMs));
  p(latencyLine("delivery (all)", report.latency.deliveryMs));
  p(latencyLine("delivery (hold)", report.latency.holdDeliveryMs));
  p(
    `  ${pad("generator lag", 18)} p50 ${pad(`${report.generatorLagMs.p50}ms`, 8)} p99 ${pad(`${report.generatorLagMs.p99}ms`, 8)} max ${pad(`${report.generatorLagMs.max}ms`, 8)} (this process's own event loop)`,
  );
  if (report.drain.seconds !== null) {
    p(
      `  ${pad("drain", 18)} every socket closed at once; room back to ${report.drain.presenceAfter} present after ${report.drain.seconds}s`,
    );
  }
  p("");
  p(`  === verdict (judged on the ${report.plan.holdSeconds}s hold window only) ===`);
  for (const check of report.verdict.checks) {
    const mark = check.skipped ? "–" : check.ok ? "✓" : "✗";
    p(`  ${mark} ${pad(check.name, 26)} ${check.detail}`);
  }
  p(
    `  ${report.verdict.passed ? "PASS" : "FAIL"}${report.verdict.failedCount ? ` — ${report.verdict.failedCount} criterion/criteria not met` : ""}`,
  );
  p("");
  p(`  === what saturated ===`);
  for (const reason of report.saturation) p(`  · ${reason}`);
  p("");
  p(`  === cost ===`);
  const est = report.cost.estimated;
  p(`  ${pad("estimated", 18)} US$ ${est.usd.total.toFixed(4)}  (${est.pricing})`);
  p(
    `  ${pad("", 18)} ${est.units.workerRequests} worker requests, ${est.units.durableObjectRequests} DO requests (${est.units.fanoutDoRequests} of them fanout), ${est.units.gbSeconds} GB-s`,
  );
  if (report.cost.measured) {
    const m = report.cost.measured;
    p(
      `  ${pad("measured", 18)} ${m.workerRequests} worker requests, ${m.durableObjectRequests} DO requests, ${m.workerErrors + m.durableObjectErrors} errors`,
    );
    p(`  ${pad("", 18)} (Cloudflare analytics lag minutes and bucket by minute — treat as confirmation, not as the number)`);
  } else {
    p(`  ${pad("measured", 18)} not available (no CF_API_TOKEN / CF_ACCOUNT_ID)`);
  }
  p("");
  p(`  ${pad("second", 8)}${pad("phase", 8)}${pad("sockets", 9)}${pad("sent", 8)}${pad("acked", 8)}${pad("rejected", 10)}${pad("msgs", 8)}${pad("dropped", 9)}`);
  for (const slot of report.timeline) {
    p(
      `  ${pad(slot.second, 8)}${pad(slot.phase, 8)}${pad(slot.connections, 9)}${pad(slot.sent, 8)}${pad(slot.acked, 8)}${pad(slot.rejected, 10)}${pad(slot.delivered, 8)}${pad(slot.dropped, 9)}`,
    );
  }
  p("");
  process.stdout.write(`${lines.join("\n")}\n`);
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

let finished = false;

async function finish(options, context, partial) {
  if (finished) return;
  finished = true;
  stopping = true;

  const base = httpBase(options.url);
  if (!partial) {
    // Phase four: everybody leaves at once, which is what the end of a live
    // stream looks like and the cheapest way to find state nobody cleans up.
    setPhase("drain", options, context);
    const drainStart = Date.now();
    for (const client of clients) {
      try {
        client.ws?.close(1000, "load test finished");
      } catch {
        /* already gone */
      }
    }
    const deadline = drainStart + options.drainTimeout * 1000;
    let presence = null;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const stats = await readRoomStats(base, options.room);
      presence = stats?.connections ?? presence;
      if (presence !== null && presence <= 0) break;
    }
    metrics.drainSeconds = Math.round((Date.now() - drainStart) / 100) / 10;
    metrics.presenceAfterDrain = presence;
  } else {
    for (const client of clients) {
      try {
        client.ws?.close(1000, "load test interrupted");
      } catch {
        /* already gone */
      }
    }
  }

  context.usage = usageDelta(
    context.usageBefore,
    await readAccountUsage({
      apiToken: context.cfApiToken,
      accountId: context.cfAccountId,
      scriptName: context.cfScriptName,
    }),
  );

  setPhase("done", options, context);
  await endRun(base, options.room, context.moderatorKey);

  const report = buildReport(options, context, partial);
  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else printReport(report);
  if (options.out) {
    await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`);
    if (!options.json) process.stdout.write(`  report written to ${options.out}\n\n`);
  }

  // A load test that cannot fail is a demo. An interrupted run is not a verdict.
  process.exit(partial ? 130 : report.verdict.passed ? 0 : 1);
}

function setPhase(phase, options, context) {
  if (metrics.phase === phase) return;
  metrics.phase = phase;
  metrics.phaseChangedAt[phase] = Date.now();
  if (phase === "hold") {
    metrics.holdOpened = metrics.connectionsOpened;
    metrics.holdFailed = metrics.connectionsFailed;
    metrics.holdRequested = options.clients;
  }
  if (phase === "drain") {
    metrics.openAtHoldEnd = clients.filter((c) => c.open).length;
  }
}

async function run(options, context) {
  const base = httpBase(options.url);
  metrics.startedAt = Date.now();
  bypassSigner = makeBypassSigner(context.bypassKey);
  loopDelay.enable();

  // What the room is actually configured with. Reported alongside the result,
  // because a number obtained at one shard count says nothing at another.
  const config = await readRoomConfig(base, options.room);
  if (config) {
    metrics.shardCount = config.shardCount ?? 0;
    metrics.maxSocketsPerShard = config.maxSocketsPerShard ?? 0;
    metrics.batchWindowMs = config.fanout?.batchWindowMs ?? 0;
  }

  context.usageBefore = await readAccountUsage({
    apiToken: context.cfApiToken,
    accountId: context.cfAccountId,
    scriptName: context.cfScriptName,
  });

  if (options.announce && context.moderatorKey) {
    await announceRun(base, options.room, context.moderatorKey, {
      preset: options.preset || undefined,
      connections: options.clients * options.nodes,
      talkers: options.talkers * options.nodes,
      rampSeconds: options.ramp,
      holdSeconds: options.duration,
    });
  }

  const rampMs = options.ramp * 1000;
  const spacing = options.clients > 1 ? rampMs / options.clients : 0;
  for (let i = 0; i < options.clients; i++) {
    setTimeout(() => {
      if (!stopping) spawnClient(i, options, context);
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
    for (let i = 0; i < due; i++) sendOne(talkers[cursor++ % talkers.length]);
  }, SEND_TICK_MS);
  ticker.unref?.();

  let progressTicks = 0;
  const progress = setInterval(async () => {
    if (stopping) return;
    const stats = await readRoomStats(base, options.room);
    if (stats) {
      metrics.presenceMax = Math.max(metrics.presenceMax, stats.connections ?? 0);
      if (Array.isArray(stats.registeredShards)) metrics.shardCount = stats.registeredShards.length;
    }
    if (++progressTicks % SHARD_POLL_EVERY === 0) {
      const busiest = await readShardLoad(base, options.room);
      if (busiest !== null) metrics.maxShardSockets = Math.max(metrics.maxShardSockets, busiest);
    }
    await reportProgress(base, options.room, context.moderatorKey, {
      phase: metrics.phase,
      progress: {
        open: clients.filter((c) => c.open).length,
        failed: metrics.connectionsFailed,
        sent: metrics.sent,
        acked: metrics.acked,
        rejected: metrics.rejected,
        delivered: metrics.delivered,
      },
    });
  }, PROGRESS_TICK_MS);
  progress.unref?.();

  // These two are deliberately *not* unref'd. Everything else here is, and the
  // sockets are not a reliable anchor — if the last one closes early, or none
  // has opened yet, an all-unref'd loop lets Node exit with the run half done
  // and nothing printed. The timer that produces the report has to be the thing
  // that keeps the process alive.
  setTimeout(() => setPhase("hold", options, context), rampMs);
  setTimeout(
    () => {
      clearInterval(ticker);
      clearInterval(progress);
      // A short window lets the last acks and fanout frames land before the
      // sockets are torn down; otherwise the drain eats them and the "nothing
      // acked was lost" check fails on the tool, not on the room.
      setTimeout(() => finish(options, context, false), 1_000);
    },
    rampMs + options.duration * 1000,
  );

  process.on("SIGINT", () => {
    clearInterval(ticker);
    clearInterval(progress);
    finish(options, context, true);
  });
}

/* ------------------------------------------------------------------ */
/* entry                                                               */
/* ------------------------------------------------------------------ */

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${String(error.message ?? error)}\n\n${HELP}`);
    process.exit(2);
  }
  if (parsed.help) {
    process.stdout.write(HELP);
    return;
  }

  const options = parsed.options;
  const base = httpBase(options.url);
  const devVars = readDevVars();

  const context = {
    jwtSecret: options.jwtSecret || process.env.JWT_HS256_SECRET || devVars.JWT_HS256_SECRET || "",
    moderatorKey:
      options.moderatorKey || process.env.MODERATOR_API_KEY || devVars.MODERATOR_API_KEY || "",
    // `.dev.vars` is gitignored and is already where every other secret this
    // tool needs lives; leaving it out here was an inconsistency, and it forced
    // the one key you most want to keep out of a shell history onto the command
    // line.
    bypassKey:
      options.bypassKey || process.env.LOADTEST_BYPASS_KEY || devVars.LOADTEST_BYPASS_KEY || "",
    cfApiToken: process.env.CF_API_TOKEN || devVars.CF_API_TOKEN || "",
    cfAccountId: process.env.CF_ACCOUNT_ID || devVars.CF_ACCOUNT_ID || "",
    cfScriptName: process.env.CF_SCRIPT_NAME || devVars.CF_SCRIPT_NAME || "live-chat",
  };

  if (!context.jwtSecret) {
    process.stderr.write(
      "no HS256 secret: pass --jwt-secret, set JWT_HS256_SECRET, or run from a directory with .dev.vars\n",
    );
    process.exit(2);
  }

  if (options.preset) {
    const presets = (await readPresets(base, options.room)) ?? FALLBACK_PRESETS;
    const preset = presets.find((p) => p.name === options.preset);
    if (!preset) {
      process.stderr.write(
        `unknown preset "${options.preset}" — have ${presets.map((p) => p.name).join(", ")}\n`,
      );
      process.exit(2);
    }
    options.clients = shareOf(preset.connections, options.node, options.nodes);
    options.talkers = shareOf(preset.talkers, options.node, options.nodes);
    options.ramp = preset.rampSeconds;
    options.duration = preset.holdSeconds;
  }

  // Only when the operator did not say otherwise: an explicit flag always wins,
  // because testing a deployment against claims it does *not* issue is a valid
  // thing to want to check.
  const discovered = await discoverClaims(base);
  if (discovered) {
    if (!options._explicit.has("issuer")) options.issuer = discovered.issuer;
    if (!options._explicit.has("audience")) options.audience = discovered.audience;
    if (!options.json) {
      process.stderr.write(
        `token claims from the deployment: iss=${options.issuer} aud=${options.audience}\n`,
      );
    }
  } else if (!options.json) {
    process.stderr.write(
      `could not read token claims from ${base} (dev token route disabled?) — ` +
        `using iss=${options.issuer} aud=${options.audience}; a mismatch fails every handshake with 401\n`,
    );
  }

  if (options.clients < 1) {
    process.stderr.write("--clients must be at least 1\n");
    process.exit(2);
  }
  if (options.talkers === 0 || options.talkers > options.clients) options.talkers = options.clients;
  if (options.rate === 0) {
    options.rate = Math.max(1, Math.round(options.talkers * options.perTalkerRate));
  }

  await run(options, context);
}

main().catch((error) => {
  process.stderr.write(`load test failed: ${String(error?.stack ?? error)}\n`);
  process.exit(1);
});
