#!/usr/bin/env node
/**
 * Post-deploy verification against the deployed Worker.
 *
 * A green `wrangler deploy` only means the upload succeeded. This asks the live
 * URL the questions that would actually break a viewer: the Worker answers, the
 * demo client is being served, production really is in production mode (dev
 * tokens off), and a WebSocket can still connect, send and get an ack through
 * the real Durable Objects.
 *
 * Usage:
 *   node tools/ci/verify-deploy.mjs --url https://live-chat.<sub>.workers.dev
 *                                   [--room ci-smoke] [--expect-env production]
 *
 * The WebSocket leg needs a token, so it runs only when JWT_HS256_SECRET (and
 * an HS256 configuration) is available; without it the HTTP checks still run.
 */
import { appendFileSync } from "node:fs";
import { SignJWT } from "jose";
import { WebSocket } from "ws";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const url = (arg("url", process.env.DEPLOY_URL) ?? "").replace(/\/+$/, "");
const room = arg("room", "ci-smoke");
const expectedEnv = arg("expect-env", "production");
const HEALTH_TIMEOUT_MS = 90_000;
const WS_TIMEOUT_MS = 20_000;

if (!url) {
  process.stderr.write("verify-deploy: informe --url https://…\n");
  process.exit(2);
}

const checks = [];
function record(name, ok, detail) {
  checks.push({ name, ok, detail });
  process.stdout.write(`${ok ? "  ✅" : "  ❌"} ${name}${detail ? ` — ${detail}` : ""}\n`);
}

/** A fresh deploy takes a few seconds to be live everywhere; retry before failing. */
async function waitForHealth() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return await res.json();
      last = `HTTP ${res.status}`;
    } catch (error) {
      last = String(error?.message ?? error);
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`/health não respondeu em ${HEALTH_TIMEOUT_MS / 1000}s (${last})`);
}

async function mintToken() {
  const secret = process.env.JWT_HS256_SECRET;
  const alg = (process.env.JWT_ALG ?? "HS256").toUpperCase();
  if (!secret || alg !== "HS256") return null;
  return new SignJWT({ name: "CI verify", roles: [] })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("ci-verify")
    .setIssuer(process.env.JWT_ISSUER ?? "")
    .setAudience(process.env.JWT_AUDIENCE ?? "live-chat")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(secret));
}

/** Opens a socket, sends one message and resolves on the ack for that cid. */
function chatRoundtrip(token) {
  return new Promise((resolve) => {
    const wsUrl = `${url.replace(/^http/, "ws")}/ws/${encodeURIComponent(room)}?token=${encodeURIComponent(token)}`;
    const socket = new WebSocket(wsUrl);
    const cid = `ci-${Date.now()}`;
    const result = { hello: false, ack: false, delivered: false, error: null };
    const timer = setTimeout(() => {
      result.error = result.error ?? "timeout";
      try {
        socket.close();
      } catch {
        /* already closing */
      }
      resolve(result);
    }, WS_TIMEOUT_MS);

    socket.on("open", () => {
      socket.send(JSON.stringify({ t: "send", cid, body: `deploy check ${new Date().toISOString()}` }));
    });
    socket.on("message", (data) => {
      let frame;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (frame.t === "hello") result.hello = true;
      if (frame.t === "ack" && frame.cid === cid) result.ack = true;
      if (frame.t === "rejected" && frame.cid === cid) result.error = `${frame.code}: ${frame.reason}`;
      if (frame.t === "msg" && frame.m?.body?.startsWith("deploy check")) result.delivered = true;
      if ((result.ack && result.delivered) || result.error) {
        clearTimeout(timer);
        socket.close();
        resolve(result);
      }
    });
    socket.on("error", (error) => {
      result.error = String(error?.message ?? error);
      clearTimeout(timer);
      resolve(result);
    });
  });
}

async function main() {
  process.stdout.write(`verify-deploy: ${url}\n`);

  const health = await waitForHealth();
  record("o Worker responde /health", health?.ok === true, `environment=${health?.environment}`);
  record(
    `está rodando como "${expectedEnv}"`,
    health?.environment === expectedEnv,
    `recebido "${health?.environment}"`,
  );

  const index = await fetch(`${url}/`);
  const html = await index.text();
  record(
    "o cliente de demonstração é servido",
    index.ok && /<html/i.test(html),
    `${index.status}, ${html.length} bytes`,
  );

  const config = await fetch(`${url}/api/rooms/${room}/config`);
  record("a sala responde a configuração (coordinator vivo)", config.ok, `HTTP ${config.status}`);

  /**
   * `POST /api/dev/token` é a porta de entrada da demo pública — é dela que o
   * cliente tira o token, e é ela que o Worker desliga quando ENVIRONMENT é
   * "production". Nos dois modos a rota é o que precisa ser verificado, só que
   * a expectativa se inverte.
   */
  let token = null;
  if (expectedEnv === "production") {
    const devToken = await fetch(`${url}/api/dev/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "should-not-work" }),
    });
    record(
      "a rota de token de desenvolvimento está desligada",
      devToken.status === 404,
      `HTTP ${devToken.status}`,
    );
    token = await mintToken();
  } else {
    const devToken = await fetch(`${url}/api/dev/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: `ci-verify-${Date.now()}`, name: "CI verify", roles: ["moderator"] }),
    });
    const minted = await devToken.json().catch(() => null);
    token = typeof minted?.token === "string" ? minted.token : null;
    record(
      "qualquer visitante consegue um token (porta da demo)",
      devToken.ok && Boolean(token),
      `HTTP ${devToken.status}`,
    );
    // Numa demo, poder se declarar moderador é a funcionalidade: é assim que
    // se experimenta apagar, silenciar e banir sem um painel de administração.
    record(
      "o token pode se declarar moderador",
      (minted?.identity?.roles ?? []).includes("moderator"),
      `roles=${JSON.stringify(minted?.identity?.roles ?? [])}`,
    );
  }

  if (!token) {
    process.stdout.write("  ⏭  roundtrip de WebSocket pulado (não consegui um token)\n");
  } else {
    const trip = await chatRoundtrip(token);
    record(
      "WebSocket conecta e recebe hello",
      trip.hello,
      trip.error && !trip.hello ? trip.error : "",
    );
    record("uma mensagem é aceita (ack do shard)", trip.ack, trip.error ?? "");
    record("a mensagem volta pelo fanout", trip.delivered, trip.error ?? "");
  }

  const failed = checks.filter((c) => !c.ok);
  const lines = [];
  lines.push(`## ${failed.length === 0 ? "✅" : "❌"} Verificação pós-deploy`);
  lines.push("");
  lines.push(`Alvo: ${url}`);
  lines.push("");
  lines.push("| | Verificação | Detalhe |");
  lines.push("|---|---|---|");
  for (const check of checks) {
    lines.push(`| ${check.ok ? "✅" : "❌"} | ${check.name} | ${(check.detail ?? "").replace(/\|/g, "\\|")} |`);
  }
  lines.push("");
  const text = lines.join("\n");
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  return failed.length === 0;
}

main()
  .then((ok) => {
    process.stdout.write(ok ? "verify-deploy: OK\n" : "verify-deploy: FALHOU\n");
    process.exit(ok ? 0 : 1);
  })
  .catch((error) => {
    process.stderr.write(`verify-deploy: ${String(error?.message ?? error)}\n`);
    process.exit(1);
  });
