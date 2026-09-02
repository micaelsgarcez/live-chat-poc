/**
 * The official numbers, when they exist.
 *
 * Cloudflare's GraphQL Analytics API is account-level: it needs an API token
 * and an account tag, which a local `wrangler dev` has neither of. The repo is
 * local-first, so this is feature-detected exactly like the native Rate
 * Limiting binding — configured, it answers; unconfigured, it says so and every
 * other panel keeps working.
 *
 * These numbers also lag by minutes and are aggregated in one-minute buckets,
 * so they are never mixed into the live health verdict. They answer "is the
 * Worker healthy at the account level today", not "is the room healthy now",
 * and the response carries `staleness` so the UI can say which it is.
 *
 * `src/env.ts` is a frozen contract, so the two settings are read through a
 * local structural type instead of being added to `Env`.
 */
import type { Env } from "../../env";
import { createLogger, type LogLevel } from "../../shared/logger";

/** Set in `.dev.vars` locally, or `wrangler secret put` in production. */
export interface CloudflareAnalyticsVars {
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  /** Defaults to the `name` in wrangler.jsonc. */
  CF_SCRIPT_NAME?: string;
}

const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
const DEFAULT_SCRIPT_NAME = "live-chat";
/** The API buckets by minute; polling faster only burns rate limit. */
export const CLOUDFLARE_CACHE_SECONDS = 60;
export const CLOUDFLARE_WINDOW_MINUTES = 30;

export interface WorkerAnalytics {
  requests: number;
  errors: number;
  subrequests: number;
  cpuTimeP50: number | null;
  cpuTimeP99: number | null;
}

export interface DurableObjectAnalytics {
  requests: number;
  errors: number;
  responseBodyBytes: number;
  wallTimeP50: number | null;
  wallTimeP99: number | null;
  activeTimeSeconds: number;
  storageReadUnits: number;
  storageWriteUnits: number;
  storageDeletes: number;
}

export interface CloudflareAnalytics {
  available: true;
  accountId: string;
  scriptName: string;
  windowMinutes: number;
  fetchedAt: number;
  worker: WorkerAnalytics;
  durableObjects: DurableObjectAnalytics;
  /** Non-fatal GraphQL complaints; a partial answer beats no panel. */
  warnings: string[];
}

export interface CloudflareUnavailable {
  available: false;
  /** Why, in words the demo can put on screen. */
  reason: string;
}

export type CloudflareResult = CloudflareAnalytics | CloudflareUnavailable;

export function cloudflareVars(env: Env): CloudflareAnalyticsVars {
  return env as Env & CloudflareAnalyticsVars;
}

export function isCloudflareConfigured(env: Env): boolean {
  const vars = cloudflareVars(env);
  return Boolean(vars.CF_API_TOKEN && vars.CF_ACCOUNT_ID);
}

const QUERY = `
query LiveChatObservability($account: String!, $script: String!, $since: Time!, $until: Time!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      workersInvocationsAdaptive(
        limit: 1000
        filter: { scriptName: $script, datetime_geq: $since, datetime_leq: $until }
      ) {
        sum { requests errors subrequests }
        quantiles { cpuTimeP50 cpuTimeP99 }
      }
      durableObjectsInvocationsAdaptiveGroups(
        limit: 1000
        filter: { datetime_geq: $since, datetime_leq: $until }
      ) {
        sum { requests errors responseBodySize }
        quantiles { wallTimeP50 wallTimeP99 }
      }
      durableObjectsPeriodicGroups(
        limit: 1000
        filter: { datetime_geq: $since, datetime_leq: $until }
      ) {
        sum { activeTime storageReadUnits storageWriteUnits storageDeletes }
      }
    }
  }
}`;

interface GraphQLResponse {
  data?: {
    viewer?: {
      accounts?: Array<{
        workersInvocationsAdaptive?: Array<{
          sum?: { requests?: number; errors?: number; subrequests?: number };
          quantiles?: { cpuTimeP50?: number; cpuTimeP99?: number };
        }>;
        durableObjectsInvocationsAdaptiveGroups?: Array<{
          sum?: { requests?: number; errors?: number; responseBodySize?: number };
          quantiles?: { wallTimeP50?: number; wallTimeP99?: number };
        }>;
        durableObjectsPeriodicGroups?: Array<{
          sum?: {
            activeTime?: number;
            storageReadUnits?: number;
            storageWriteUnits?: number;
            storageDeletes?: number;
          };
        }>;
      }>;
    };
  };
  errors?: Array<{ message?: string }>;
}

function cacheKey(accountId: string, scriptName: string): string {
  return `obs:cf:${accountId}:${scriptName}`;
}

/**
 * KV rather than an isolate-local map: the console is polled from one browser
 * but served by whichever isolate the edge picks, so a per-isolate cache would
 * miss most of the time and hammer the analytics API.
 */
export async function fetchCloudflareAnalytics(env: Env): Promise<CloudflareResult> {
  const vars = cloudflareVars(env);
  const accountId = vars.CF_ACCOUNT_ID;
  const token = vars.CF_API_TOKEN;
  const scriptName = vars.CF_SCRIPT_NAME || DEFAULT_SCRIPT_NAME;
  if (!accountId || !token) {
    return {
      available: false,
      reason:
        "CF_API_TOKEN e CF_ACCOUNT_ID não configurados — o painel ao vivo ao lado não depende deles",
    };
  }

  const log = createLogger("observability", (env.LOG_LEVEL as LogLevel) ?? "info");
  const key = cacheKey(accountId, scriptName);
  try {
    const cached = await env.CHAT_KV.get(key, "json");
    if (cached) return cached as CloudflareResult;
  } catch (error) {
    log.warn("analytics cache read failed", { error: String(error) });
  }

  const until = new Date();
  const since = new Date(until.getTime() - CLOUDFLARE_WINDOW_MINUTES * 60_000);

  let payload: GraphQLResponse;
  try {
    const response = await fetch(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: QUERY,
        variables: {
          account: accountId,
          script: scriptName,
          since: since.toISOString(),
          until: until.toISOString(),
        },
      }),
    });
    if (!response.ok) {
      return {
        available: false,
        reason: `a API de analytics respondeu ${response.status}: verifique o escopo account_analytics:read do token`,
      };
    }
    payload = (await response.json()) as GraphQLResponse;
  } catch (error) {
    return { available: false, reason: `analytics inalcançável: ${String(error)}` };
  }

  const warnings = (payload.errors ?? [])
    .map((entry) => entry.message ?? "erro sem mensagem")
    .slice(0, 4);
  const account = payload.data?.viewer?.accounts?.[0];
  if (!account) {
    return {
      available: false,
      reason:
        warnings[0] ?? "a conta não devolveu dados — o token pode não enxergar este account tag",
    };
  }

  const result: CloudflareAnalytics = {
    available: true,
    accountId,
    scriptName,
    windowMinutes: CLOUDFLARE_WINDOW_MINUTES,
    fetchedAt: Date.now(),
    worker: reduceWorker(account.workersInvocationsAdaptive ?? []),
    durableObjects: reduceDurableObjects(
      account.durableObjectsInvocationsAdaptiveGroups ?? [],
      account.durableObjectsPeriodicGroups ?? [],
    ),
    warnings,
  };

  try {
    await env.CHAT_KV.put(key, JSON.stringify(result), {
      expirationTtl: CLOUDFLARE_CACHE_SECONDS,
    });
  } catch (error) {
    log.warn("analytics cache write failed", { error: String(error) });
  }
  return result;
}

interface WorkerRow {
  sum?: { requests?: number; errors?: number; subrequests?: number };
  quantiles?: { cpuTimeP50?: number; cpuTimeP99?: number };
}

function reduceWorker(rows: readonly WorkerRow[]): WorkerAnalytics {
  let requests = 0;
  let errors = 0;
  let subrequests = 0;
  // Quantiles do not add up, so the worst bucket in the window is reported —
  // an average of percentiles would hide exactly the spike worth seeing.
  let cpuTimeP50: number | null = null;
  let cpuTimeP99: number | null = null;
  for (const row of rows) {
    requests += row.sum?.requests ?? 0;
    errors += row.sum?.errors ?? 0;
    subrequests += row.sum?.subrequests ?? 0;
    cpuTimeP50 = maxOrNull(cpuTimeP50, row.quantiles?.cpuTimeP50);
    cpuTimeP99 = maxOrNull(cpuTimeP99, row.quantiles?.cpuTimeP99);
  }
  return { requests, errors, subrequests, cpuTimeP50, cpuTimeP99 };
}

function reduceDurableObjects(
  invocations: ReadonlyArray<{
    sum?: { requests?: number; errors?: number; responseBodySize?: number };
    quantiles?: { wallTimeP50?: number; wallTimeP99?: number };
  }>,
  periodic: ReadonlyArray<{
    sum?: {
      activeTime?: number;
      storageReadUnits?: number;
      storageWriteUnits?: number;
      storageDeletes?: number;
    };
  }>,
): DurableObjectAnalytics {
  let requests = 0;
  let errors = 0;
  let responseBodyBytes = 0;
  let wallTimeP50: number | null = null;
  let wallTimeP99: number | null = null;
  for (const row of invocations) {
    requests += row.sum?.requests ?? 0;
    errors += row.sum?.errors ?? 0;
    responseBodyBytes += row.sum?.responseBodySize ?? 0;
    wallTimeP50 = maxOrNull(wallTimeP50, row.quantiles?.wallTimeP50);
    wallTimeP99 = maxOrNull(wallTimeP99, row.quantiles?.wallTimeP99);
  }

  let activeTime = 0;
  let storageReadUnits = 0;
  let storageWriteUnits = 0;
  let storageDeletes = 0;
  for (const row of periodic) {
    activeTime += row.sum?.activeTime ?? 0;
    storageReadUnits += row.sum?.storageReadUnits ?? 0;
    storageWriteUnits += row.sum?.storageWriteUnits ?? 0;
    storageDeletes += row.sum?.storageDeletes ?? 0;
  }

  return {
    requests,
    errors,
    responseBodyBytes,
    wallTimeP50,
    wallTimeP99,
    // `activeTime` comes back in microseconds.
    activeTimeSeconds: activeTime / 1_000_000,
    storageReadUnits,
    storageWriteUnits,
    storageDeletes,
  };
}

function maxOrNull(current: number | null, candidate: number | undefined): number | null {
  if (typeof candidate !== "number") return current;
  return current === null ? candidate : Math.max(current, candidate);
}
