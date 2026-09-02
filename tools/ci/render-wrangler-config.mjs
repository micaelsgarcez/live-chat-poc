#!/usr/bin/env node
/**
 * Renders the deploy-time wrangler config from the checked-in `wrangler.jsonc`.
 *
 * `wrangler.jsonc` is a frozen contract and it describes the *local* world:
 * placeholder resource ids, `ENVIRONMENT=local`. A real deploy needs the ids of
 * one specific Cloudflare account, and those belong to the pipeline's
 * configuration, not to the repository. So instead of duplicating the config
 * (and letting the two copies drift on the next binding, queue or DO
 * migration), the deploy config is generated: one source of truth for the
 * shape, account-specific values injected from the environment.
 *
 * Usage:
 *   node tools/ci/render-wrangler-config.mjs [--out wrangler.deploy.json] [--placeholders]
 *
 * `--placeholders` fills the account-specific ids with fakes so CI can run
 * `wrangler deploy --dry-run` against the rendered config without credentials.
 */
import { readFileSync, writeFileSync } from "node:fs";

const SOURCE = "wrangler.jsonc";

/** Strips `//` and block comments without touching anything inside a string. */
function stripJsonComments(input) {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    const next = input[i + 1];
    if (inLine) {
      if (char === "\n") {
        inLine = false;
        out += char;
      }
      continue;
    }
    if (inBlock) {
      if (char === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        i++;
      } else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += char;
  }
  return out;
}

const args = process.argv.slice(2);
const placeholders = args.includes("--placeholders");
const outIndex = args.indexOf("--out");
const outPath = outIndex >= 0 ? args[outIndex + 1] : "wrangler.deploy.json";

const env = process.env;
const missing = [];

/** Reads a value that only the target account can provide. */
function required(name, placeholder) {
  const value = env[name]?.trim();
  if (value) return value;
  if (placeholders) return placeholder;
  missing.push(name);
  return "";
}

function optional(name, fallback) {
  const value = env[name]?.trim();
  return value ? value : fallback;
}

const workerName = optional("CF_WORKER_NAME", "live-chat");
/**
 * Deliberately NOT "production": este deploy é uma demonstração pública, e o
 * Worker desliga `POST /api/dev/token` exatamente quando `ENVIRONMENT` é
 * "production" — sem essa rota o cliente da demo não consegue token nenhum e a
 * página não conecta. Com "demo" qualquer visitante entra na sala, escreve e
 * pode se declarar moderador, que é o ponto: as regras (rate limit, slow mode,
 * spam, moderação, ban) só se mostram se dá para tentar quebrá-las.
 * `CF_ENVIRONMENT=production` fecha isso quando existir um emissor de tokens.
 */
const environment = optional("CF_ENVIRONMENT", "demo");
const kvId = required("CF_KV_ID", "0".repeat(32));
const d1Id = required("CF_D1_DATABASE_ID", "00000000-0000-0000-0000-000000000001");
const d1Name = optional("CF_D1_DATABASE_NAME", "live-chat");
const customDomain = optional("CF_CUSTOM_DOMAIN", "");
const rateLimitNamespace = optional("CF_RATE_LIMIT_NAMESPACE_ID", "1001");
const rateLimit = Number(optional("CF_RATE_LIMIT", "60"));
const rateLimitPeriod = Number(optional("CF_RATE_LIMIT_PERIOD", "60"));

if (missing.length > 0) {
  process.stderr.write(
    [
      "render-wrangler-config: faltam valores obrigatórios do ambiente:",
      ...missing.map((name) => `  - ${name}`),
      "",
      "Rode `node tools/ci/provision.mjs` para criar os recursos e obter os ids,",
      "ou veja docs/CICD.md para a lista completa de secrets e variables.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

const config = JSON.parse(stripJsonComments(readFileSync(SOURCE, "utf8")));

delete config.$schema;
config.name = workerName;

/* Bindings: same shape as local, real ids. */
config.kv_namespaces = (config.kv_namespaces ?? []).map((ns) => {
  const next = { ...ns, id: kvId };
  delete next.preview_id;
  return next;
});
config.d1_databases = (config.d1_databases ?? []).map((db) => ({
  ...db,
  database_name: d1Name,
  database_id: d1Id,
}));

/**
 * Cloudflare's native Rate Limiting binding only exists once deployed; the
 * edge-limiter slice feature-detects it and falls back to KV locally, so
 * production is where `EDGE_RATE_LIMITER` finally gets its real implementation.
 * Limit and period mirror `EDGE_CONNECTIONS_PER_MINUTE` in the slice.
 */
config.ratelimits = [
  {
    name: "EDGE_RATE_LIMITER",
    namespace_id: rateLimitNamespace,
    simple: { limit: rateLimit, period: rateLimitPeriod },
  },
];

config.vars = {
  ...config.vars,
  ENVIRONMENT: environment,
  JWT_ISSUER: optional("JWT_ISSUER", config.vars?.JWT_ISSUER ?? ""),
  JWT_AUDIENCE: optional("JWT_AUDIENCE", config.vars?.JWT_AUDIENCE ?? ""),
  JWT_ALG: optional("JWT_ALG", config.vars?.JWT_ALG ?? "HS256"),
  JWKS_URL: optional("JWKS_URL", config.vars?.JWKS_URL ?? ""),
  DEFAULT_SHARD_COUNT: optional("DEFAULT_SHARD_COUNT", config.vars?.DEFAULT_SHARD_COUNT ?? "4"),
  MAX_SOCKETS_PER_SHARD: optional(
    "MAX_SOCKETS_PER_SHARD",
    config.vars?.MAX_SOCKETS_PER_SHARD ?? "5000",
  ),
  LOG_LEVEL: optional("LOG_LEVEL", config.vars?.LOG_LEVEL ?? "info"),
};

// The workers.dev URL is what the post-deploy check talks to, so it stays on
// even when a custom domain is configured.
config.workers_dev = true;
if (customDomain) {
  config.routes = [{ pattern: customDomain, custom_domain: true }];
}

/**
 * Enquanto o próprio Worker emite os tokens (`/api/dev/token`), o emissor só
 * precisa ser consistente consigo mesmo e o valor local serve. Com
 * ENVIRONMENT=production a rota some e os tokens passam a vir de fora — aí o
 * placeholder significa que nenhum token vai validar.
 */
if (
  environment === "production" &&
  /\.local\.test$/.test(new URL(config.vars.JWT_ISSUER || "https://x").hostname)
) {
  process.stderr.write(
    `render-wrangler-config: aviso — JWT_ISSUER ainda é "${config.vars.JWT_ISSUER}" (valor local),\n` +
      "  mas /api/dev/token está desligada. Configure a variable JWT_ISSUER com o emissor real.\n",
  );
}

writeFileSync(outPath, `${JSON.stringify(config, null, 2)}\n`);

process.stdout.write(
  [
    `render-wrangler-config: ${outPath}`,
    `  worker            ${config.name}`,
    `  environment       ${config.vars.ENVIRONMENT}${environment === "production" ? " (tokens de dev desligados)" : " (demo pública: /api/dev/token ligada)"}`,
    `  kv                ${config.kv_namespaces?.[0]?.binding} -> ${kvId.slice(0, 8)}…`,
    `  d1                ${d1Name} -> ${d1Id.slice(0, 8)}…`,
    `  queues            ${(config.queues?.producers ?? []).map((p) => p.queue).join(", ")}`,
    `  rate limiter      ${rateLimit}/${rateLimitPeriod}s (namespace ${rateLimitNamespace})`,
    `  custom domain     ${customDomain || "(nenhum, só workers.dev)"}`,
    "",
  ].join("\n"),
);
