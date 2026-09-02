#!/usr/bin/env node
/**
 * Functional smoke test against a real `wrangler dev`.
 *
 * The unit and integration suites run inside `vitest-pool-workers`, which is
 * the same workerd but not the same *process boundary*: the config file, the
 * asset binding, the queue consumers and the WebSocket upgrade path are only
 * exercised end to end once the dev server actually boots. This boots it, walks
 * the product the way the demo client does, and fails the build if any of that
 * stops working — no Cloudflare account involved.
 *
 * Usage: node tools/ci/smoke.mjs [--port 8787] [--keep-server]
 */
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import process from "node:process";

const args = process.argv.slice(2);
const portIndex = args.indexOf("--port");
// Not 8787: a developer running `npm run dev` should not have the smoke
// silently talk to their server instead of a clean one.
const PORT = Number(portIndex >= 0 ? args[portIndex + 1] : 8788);
const KEEP = args.includes("--keep-server");
const BASE = `http://127.0.0.1:${PORT}`;
const ROOM = "ci-smoke";
const BOOT_TIMEOUT_MS = 120_000;

const checks = [];
let serverLog = "";

function record(name, ok, detail) {
  checks.push({ name, ok, detail });
  process.stdout.write(`${ok ? "  ✅" : "  ❌"} ${name}${detail ? ` — ${detail}` : ""}\n`);
}

function run(command, commandArgs, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, { ...options, shell: false });
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk) => (out += chunk));
    child.stderr?.on("data", (chunk) => (err += chunk));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

async function waitForHealth(deadline) {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return await res.json();
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* checks                                                              */
/* ------------------------------------------------------------------ */

async function httpChecks() {
  const health = await fetch(`${BASE}/health`).then((r) => r.json());
  record("GET /health responde ok", health?.ok === true, `environment=${health?.environment}`);

  const index = await fetch(`${BASE}/`);
  const html = await index.text();
  record(
    "cliente de demonstração é servido pelo binding ASSETS",
    index.ok && /<html/i.test(html),
    `${index.status}, ${html.length} bytes`,
  );

  const tokenRes = await fetch(`${BASE}/api/dev/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: "smoke-user", name: "Smoke", ttlSeconds: 600 }),
  });
  const token = (await tokenRes.json())?.token;
  record("POST /api/dev/token emite um token local", typeof token === "string" && token.length > 20);
  if (!token) return null;

  const me = await fetch(`${BASE}/api/me`, { headers: { authorization: `Bearer ${token}` } });
  const identity = (await me.json())?.identity;
  record("GET /api/me resolve a identidade do token", me.ok && identity?.userId === "smoke-user");

  const config = await fetch(`${BASE}/api/rooms/${ROOM}/config`);
  record("GET config da sala responde", config.ok, `${config.status}`);

  const messages = await fetch(`${BASE}/api/rooms/${ROOM}/messages?limit=5`);
  record("GET histórico responde", messages.ok, `${messages.status}`);

  return token;
}

/**
 * The load generator already opens sockets, sends, and measures ack and
 * end-to-end delivery. Reusing it keeps one implementation of the client
 * instead of a second, subtly different one living in CI.
 */
async function realtimeCheck() {
  const result = await run(
    process.execPath,
    [
      "tools/loadtest/run.mjs",
      "--url",
      `ws://127.0.0.1:${PORT}`,
      "--room",
      ROOM,
      "--clients",
      "6",
      "--talkers",
      "3",
      "--rate",
      "2",
      "--duration",
      "8",
      "--ramp",
      "2",
      // The drain phase waits for the room to empty; six sockets do that almost
      // at once, and CI should not sit on the default 30s ceiling to find out.
      "--drain-timeout",
      "5",
      "--json",
    ],
    { env: process.env },
  );

  let report;
  try {
    report = JSON.parse(result.out);
  } catch {
    record("teste de carga produziu um relatório", false, result.err.slice(0, 200));
    return null;
  }

  record(
    "todos os sockets conectaram",
    report.connections.failed === 0 && report.connections.opened === report.connections.requested,
    `${report.connections.opened}/${report.connections.requested} abertos, ${report.connections.failed} falharam`,
  );
  // 3 remetentes a 2 msg/s no total ficam abaixo da recarga do token bucket
  // (1/s por usuário), então qualquer rejeição aqui é um gate se comportando
  // diferente do que os testes de unidade dizem.
  record(
    "o pipeline de entrada aceitou mensagens (ack)",
    report.messages.acked > 0 && report.messages.rejected === 0,
    `${report.messages.acked} de ${report.messages.sent} enviadas, ${report.messages.rejected} rejeitadas, ${report.messages.inflight} sem resposta`,
  );
  // Cada mensagem aceita vira um frame por socket aberto; a margem cobre a
  // rampa, em que as primeiras mensagens saem antes de todo mundo conectar.
  record(
    "o fanout entregou a todos os clientes",
    report.messages.deliveredFrames >= report.messages.acked * report.connections.opened * 0.6,
    `${report.messages.deliveredFrames} frames para ${report.connections.opened} sockets`,
  );
  record(
    "latência fim a fim medida",
    Number.isFinite(report.latency.deliveryMs?.p95),
    `p50 ${report.latency.deliveryMs?.p50}ms / p95 ${report.latency.deliveryMs?.p95}ms`,
  );

  // `?refresh=1` runs the same recompute the cron job does (D1 -> KV), so this
  // covers the scheduled path without waiting a minute for a real trigger.
  const ranking = await fetch(`${BASE}/api/rooms/${ROOM}/ranking?refresh=1`);
  record("ranking recalcula de D1 para o KV", ranking.ok, `${ranking.status}`);

  // The generator's last phase closes every socket at once, and a shard with no
  // sockets left unregisters itself. So by the time we get here the right number
  // of registered shards is *zero* — asserting otherwise would be asserting that
  // the cleanup failed. What has to survive is the counter.
  const stats = (await fetch(`${BASE}/api/rooms/${ROOM}/stats`).then((r) => r.json()))?.stats;
  record(
    "o coordinator contou as publicações",
    (stats?.messagesPublished ?? 0) > 0,
    `${stats?.messagesPublished ?? 0} publicadas`,
  );
  record(
    "os shards se desregistraram depois que todos desconectaram",
    (stats?.registeredShards?.length ?? 0) === 0 && (stats?.connections ?? 0) === 0,
    `${stats?.registeredShards?.length ?? 0} shards registrados, ${stats?.connections ?? 0} conexões`,
  );

  record(
    "o run de carga foi anunciado e encerrado",
    (await fetch(`${BASE}/api/rooms/${ROOM}/loadtest`).then((r) => r.json()))?.run === null,
    "nenhum run ativo depois do fim",
  );

  return report;
}

function summarise(report) {
  const failed = checks.filter((c) => !c.ok);
  const lines = [];
  lines.push(`## ${failed.length === 0 ? "✅" : "❌"} Smoke funcional (\`wrangler dev\`)`);
  lines.push("");
  lines.push("| | Verificação | Detalhe |");
  lines.push("|---|---|---|");
  for (const check of checks) {
    lines.push(`| ${check.ok ? "✅" : "❌"} | ${check.name} | ${(check.detail ?? "").replace(/\|/g, "\\|")} |`);
  }
  if (report) {
    lines.push("");
    lines.push(
      `Latência: ack p50 ${report.latency.ackMs?.p50}ms / p95 ${report.latency.ackMs?.p95}ms · ` +
        `entrega p50 ${report.latency.deliveryMs?.p50}ms / p95 ${report.latency.deliveryMs?.p95}ms · ` +
        `${report.throughput.deliveredFramesPerSecond} frames/s`,
    );
  }
  lines.push("");
  const text = lines.join("\n");
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  return failed.length === 0;
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

let server = null;

function stopServer() {
  if (!server || KEEP) return;
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    try {
      server.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  server = null;
}

async function main() {
  process.stdout.write("smoke: preparando o ambiente local\n");
  await run(process.execPath, ["tools/ensure-dev-vars.mjs"]);
  const migrated = await run("npx", ["wrangler", "d1", "migrations", "apply", "CHAT_DB", "--local"], {
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  if (migrated.code !== 0) {
    process.stderr.write(`${migrated.out}\n${migrated.err}\n`);
    throw new Error("falha ao aplicar as migrations locais");
  }

  // A server already on this port would make every check below pass against
  // something this script did not build.
  const squatter = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) }).catch(() => null);
  if (squatter) throw new Error(`já existe um servidor em ${BASE}; use --port para escolher outra porta`);

  process.stdout.write(`smoke: subindo wrangler dev em ${BASE}\n`);
  server = spawn("npx", ["wrangler", "dev", "--local", "--ip", "127.0.0.1", "--port", String(PORT)], {
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => (serverLog += chunk));
  server.stderr.on("data", (chunk) => (serverLog += chunk));

  const health = await waitForHealth(Date.now() + BOOT_TIMEOUT_MS);
  if (!health) throw new Error("wrangler dev não respondeu /health a tempo");

  process.stdout.write("smoke: verificando\n");
  await httpChecks();
  const report = await realtimeCheck();
  return summarise(report);
}

main()
  .then((ok) => {
    stopServer();
    if (!ok) {
      process.stderr.write(`\n--- wrangler dev ---\n${serverLog.slice(-4000)}\n`);
      process.stderr.write("smoke: FALHOU\n");
    } else {
      process.stdout.write("smoke: OK\n");
    }
    process.exit(ok ? 0 : 1);
  })
  .catch((error) => {
    stopServer();
    process.stderr.write(`\n--- wrangler dev ---\n${serverLog.slice(-4000)}\n`);
    process.stderr.write(`smoke: ${String(error?.message ?? error)}\n`);
    process.exit(1);
  });
