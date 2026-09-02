#!/usr/bin/env node
/**
 * One-off provisioning of the Cloudflare resources the Worker binds to.
 *
 * The deploy pipeline injects real resource ids into the rendered config
 * (`render-wrangler-config.mjs`), so something has to create those resources
 * first. This does it idempotently and then prints the exact `gh` commands that
 * put the ids where the pipeline reads them.
 *
 * Needs credentials: either `npx wrangler login`, or CLOUDFLARE_API_TOKEN and
 * CLOUDFLARE_ACCOUNT_ID in the environment.
 *
 * Usage: node tools/ci/provision.mjs [--name live-chat] [--d1 live-chat]
 */
import { spawnSync } from "node:child_process";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const workerName = arg("name", process.env.CF_WORKER_NAME ?? "live-chat");
const d1Name = arg("d1", process.env.CF_D1_DATABASE_NAME ?? "live-chat");
const QUEUES = ["chat-persist", "chat-moderation", "chat-dlq"];

function wrangler(args, { allowFailure = false } = {}) {
  const result = spawnSync("npx", ["wrangler", ...args], {
    encoding: "utf8",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0 && !allowFailure) {
    process.stderr.write(`${output}\n`);
    throw new Error(`wrangler ${args.join(" ")} falhou (código ${result.status})`);
  }
  return { ok: result.status === 0, output };
}

/** Wrangler prints JSON with a banner around it; take the first JSON value. */
function parseJson(output) {
  const start = output.search(/[[{]/);
  if (start < 0) return null;
  try {
    return JSON.parse(output.slice(start));
  } catch {
    return null;
  }
}

/** Some list commands need `--json`, others already print it; try both. */
function listJson(args) {
  const asJson = parseJson(wrangler([...args, "--json"], { allowFailure: true }).output);
  if (Array.isArray(asJson)) return asJson;
  const plain = parseJson(wrangler(args, { allowFailure: true }).output);
  return Array.isArray(plain) ? plain : [];
}

/** True when a create failed only because the resource is already there. */
function alreadyExists(output) {
  return /already exists|already have|duplicate/i.test(output);
}

function provisionD1() {
  const list = () => listJson(["d1", "list"]);
  let found = list().find((db) => db.name === d1Name);
  if (found) {
    process.stdout.write(`  banco D1 "${d1Name}" já existe\n`);
  } else {
    process.stdout.write(`  criando banco D1 "${d1Name}"…\n`);
    const created = wrangler(["d1", "create", d1Name], { allowFailure: true });
    if (!created.ok && !alreadyExists(created.output)) {
      process.stderr.write(`${created.output}\n`);
      throw new Error(`não consegui criar o banco D1 "${d1Name}"`);
    }
    found = list().find((db) => db.name === d1Name);
  }
  const id = found?.uuid ?? found?.database_id;
  if (!id) {
    throw new Error(
      `não consegui resolver o id do banco D1 "${d1Name}".\n` +
        "Liste com `npx wrangler d1 list` e configure CF_D1_DATABASE_ID à mão.",
    );
  }
  return id;
}

function provisionKv() {
  /**
   * O wrangler já titulou o namespace de duas formas: hoje ele usa o nome
   * passado no comando ("CHAT_KV"), versões anteriores prefixavam com o nome do
   * Worker. Aceitar os dois evita criar um namespace duplicado só porque a
   * conta foi provisionada com outra versão da CLI.
   */
  const candidates = ["CHAT_KV", `${workerName}-CHAT_KV`];
  const list = () => listJson(["kv", "namespace", "list"]);
  const find = (namespaces) => namespaces.find((ns) => candidates.includes(ns.title));

  let found = find(list());
  if (found) {
    process.stdout.write(`  namespace KV "${found.title}" já existe\n`);
  } else {
    process.stdout.write('  criando namespace KV "CHAT_KV"…\n');
    const created = wrangler(["kv", "namespace", "create", "CHAT_KV"], { allowFailure: true });
    if (!created.ok && !alreadyExists(created.output)) {
      process.stderr.write(`${created.output}\n`);
      throw new Error('não consegui criar o namespace KV "CHAT_KV"');
    }
    found = find(list());
  }

  if (!found?.id) {
    const titles = list().map((ns) => `    ${ns.id}  ${ns.title}`);
    throw new Error(
      [
        'não consegui resolver o id do namespace KV "CHAT_KV".',
        titles.length > 0 ? "Namespaces na conta:" : "A conta não listou nenhum namespace.",
        ...titles,
        "Configure CF_KV_ID à mão com o id certo.",
      ].join("\n"),
    );
  }
  return found.id;
}

function provisionQueues() {
  for (const queue of QUEUES) {
    const { ok, output } = wrangler(["queues", "create", queue], { allowFailure: true });
    if (ok) process.stdout.write(`  fila "${queue}" criada\n`);
    else if (/already exists|already have/i.test(output)) process.stdout.write(`  fila "${queue}" já existe\n`);
    else {
      process.stderr.write(`${output}\n`);
      throw new Error(`não consegui criar a fila "${queue}" (Queues exige o plano Workers Paid)`);
    }
  }
}

process.stdout.write(`provision: conta ${process.env.CLOUDFLARE_ACCOUNT_ID ?? "(da sessão do wrangler)"}\n`);
process.stdout.write("provision: D1\n");
const d1Id = provisionD1();
process.stdout.write("provision: KV\n");
const kvId = provisionKv();
process.stdout.write("provision: Queues\n");
provisionQueues();

process.stdout.write(
  [
    "",
    "Recursos prontos. Configure o repositório com:",
    "",
    `  gh variable set CF_WORKER_NAME        --body '${workerName}'`,
    `  gh variable set CF_D1_DATABASE_NAME   --body '${d1Name}'`,
    `  gh variable set CF_D1_DATABASE_ID     --body '${d1Id}'`,
    `  gh variable set CF_KV_ID              --body '${kvId}'`,
    "",
    "  gh secret set CLOUDFLARE_API_TOKEN",
    "  gh secret set CLOUDFLARE_ACCOUNT_ID",
    "  gh secret set JWT_HS256_SECRET",
    "  gh secret set MODERATOR_API_KEY",
    "",
    "Depois aplique o schema: npx wrangler d1 migrations apply CHAT_DB --remote",
    "(o pipeline também faz isso a cada deploy).",
    "",
  ].join("\n"),
);
