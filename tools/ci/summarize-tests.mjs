#!/usr/bin/env node
/**
 * Turns a vitest JSON run into a per-functionality report.
 *
 * The suite is organised by vertical slice, so the interesting question in CI
 * is never "how many tests ran" but "which capability broke". This groups the
 * result by the slice a test file lives in and writes the table to the job
 * summary, so a red build names the functionality on the first screen instead
 * of in the middle of the log.
 *
 * Usage: node tools/ci/summarize-tests.mjs [path-to-vitest.json]
 * Exit code mirrors the run: 0 when everything passed, 1 otherwise.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { relative, sep } from "node:path";

const DEFAULT_INPUT = ".ci/vitest-results.json";

/**
 * Directory prefix -> the capability a reader recognises. Ordered: the first
 * prefix that matches wins, so the more specific paths come first.
 */
const FUNCTIONALITIES = [
  ["src/features/auth", "Autenticação (JWT, tokens de dev)"],
  ["src/features/ban", "Ban (KV quente + verdade em D1)"],
  ["src/features/rate-limit", "Rate limit (borda + token bucket)"],
  ["src/features/slow-mode", "Slow mode"],
  ["src/features/spam", "Anti-spam"],
  ["src/features/moderation", "Moderação (síncrona + fila + delete retroativo)"],
  ["src/features/persistence", "Persistência em lote + histórico"],
  ["src/features/ranking", "Ranking (cron + KV)"],
  ["src/features/routing", "Roteamento e shard placement"],
  ["src/features/room", "Configuração de sala"],
  ["src/features/connect", "Handshake de conexão"],
  ["src/realtime/coordinator", "RoomCoordinator (registro, fanout, escala)"],
  ["src/realtime/shard", "ChatShard (hibernação, presença, backpressure)"],
  ["src/shared", "Kernel compartilhado"],
  ["tests", "Integração fim a fim"],
];

const OTHER = "Outros";

function functionalityOf(file) {
  const path = relative(process.cwd(), file).split(sep).join("/");
  for (const [prefix, label] of FUNCTIONALITIES) {
    // A slice is a directory, but its own entry point sits next to it as
    // `<slice>.ts` / `<slice>.test.ts` — both belong to the same capability.
    if (path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}.`)) {
      return label;
    }
  }
  return OTHER;
}

function emptyGroup(label) {
  return { label, total: 0, passed: 0, failed: 0, skipped: 0, durationMs: 0, failures: [] };
}

function collect(report) {
  const groups = new Map();
  for (const suite of report.testResults ?? []) {
    const label = functionalityOf(suite.name);
    const group = groups.get(label) ?? emptyGroup(label);
    groups.set(label, group);

    for (const test of suite.assertionResults ?? []) {
      group.total++;
      group.durationMs += test.duration ?? 0;
      if (test.status === "passed") group.passed++;
      else if (test.status === "failed") {
        group.failed++;
        group.failures.push({
          file: relative(process.cwd(), suite.name).split(sep).join("/"),
          name: test.fullName ?? test.title,
          message: (test.failureMessages ?? []).join("\n").split("\n")[0] ?? "",
        });
      } else group.skipped++;
    }
  }
  // Keep the declared order; anything unmapped lands at the end.
  const order = [...FUNCTIONALITIES.map(([, label]) => label), OTHER];
  return [...groups.values()].sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));
}

function render(groups, report) {
  const lines = [];
  const ok = report.success !== false && groups.every((g) => g.failed === 0);
  lines.push(`## ${ok ? "✅" : "❌"} Validação por funcionalidade`);
  lines.push("");
  lines.push("| Funcionalidade | Testes | Passou | Falhou | Pulou | Tempo |");
  lines.push("|---|---:|---:|---:|---:|---:|");
  for (const g of groups) {
    const mark = g.failed > 0 ? "❌" : "✅";
    lines.push(
      `| ${mark} ${g.label} | ${g.total} | ${g.passed} | ${g.failed} | ${g.skipped} | ${(g.durationMs / 1000).toFixed(1)}s |`,
    );
  }
  const totals = groups.reduce(
    (acc, g) => ({
      total: acc.total + g.total,
      passed: acc.passed + g.passed,
      failed: acc.failed + g.failed,
      skipped: acc.skipped + g.skipped,
      durationMs: acc.durationMs + g.durationMs,
    }),
    { total: 0, passed: 0, failed: 0, skipped: 0, durationMs: 0 },
  );
  lines.push(
    `| **Total** | **${totals.total}** | **${totals.passed}** | **${totals.failed}** | **${totals.skipped}** | **${(totals.durationMs / 1000).toFixed(1)}s** |`,
  );

  const failures = groups.flatMap((g) => g.failures.map((f) => ({ ...f, label: g.label })));
  if (failures.length > 0) {
    lines.push("");
    lines.push("### Falhas");
    lines.push("");
    for (const failure of failures.slice(0, 25)) {
      lines.push(`- **${failure.label}** — \`${failure.file}\` › ${failure.name}`);
      if (failure.message) lines.push(`  - \`${failure.message.slice(0, 220)}\``);
    }
    if (failures.length > 25) lines.push(`- … e mais ${failures.length - 25} falha(s).`);
  }
  lines.push("");
  return { text: lines.join("\n"), ok };
}

const input = process.argv[2] ?? DEFAULT_INPUT;
if (!existsSync(input)) {
  process.stderr.write(`summarize-tests: ${input} não existe (o vitest rodou?)\n`);
  process.exit(1);
}

const report = JSON.parse(readFileSync(input, "utf8"));
const { text, ok } = render(collect(report), report);

process.stdout.write(`${text}\n`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);

process.exit(ok ? 0 : 1);
