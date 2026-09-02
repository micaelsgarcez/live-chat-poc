/**
 * What a run costs, twice over.
 *
 * **Estimated** from what the generator itself counted, using the price table
 * below. Available the instant the run ends, and wrong in a knowable way: it
 * models the calls this design makes, so if the model and the bill disagree,
 * the model is what needs fixing.
 *
 * **Measured** from Cloudflare's GraphQL Analytics API, as a delta across the
 * run. Right, but late: the API aggregates in one-minute buckets and lags
 * several minutes, so a 90-second run lands badly inside it.
 *
 * Reporting both is the point. Agreement means the cost model is sound; a gap
 * means either the model is missing a call or the run did something nobody
 * planned — and both of those are worth knowing before running the next size up.
 */

/**
 * Workers Paid, US pricing, current as of 2026-09. Kept here and versioned so a
 * number in a report can always be re-derived from the rates that produced it.
 * Update deliberately: an estimate silently computed from stale rates is worse
 * than no estimate.
 */
export const PRICING = {
  label: "Workers Paid (US), 2026-09",
  workerRequestsPerMillion: 0.3,
  durableObjectRequestsPerMillion: 0.15,
  durableObjectGbSeconds: 12.5 / 1_000_000,
  /** Cloudflare bills one Durable Object request per 20 inbound WebSocket messages. */
  websocketMessagesPerRequest: 20,
  /** Durable Objects are billed at 128 MB regardless of what they use. */
  durableObjectMemoryGb: 128 / 1024,
};

/**
 * The model, stated so it can be argued with:
 *
 *   worker requests      one per WebSocket handshake (the upgrade is a request)
 *   DO requests, in      inbound client messages, at 20 per billed request
 *   DO requests, fanout  one coordinator->shard call per *batch* per shard —
 *                        this is the term coalescing collapses, and the reason
 *                        `batchWindowMs` shows up in a cost estimate at all
 *   DO duration          shards plus the coordinator, alive for the run
 *
 * Outbound WebSocket frames are deliberately absent: they are free, which is
 * the whole premise of the shard/coordinator split in PLAN.md, and this is the
 * arithmetic that either confirms that or does not.
 */
export function estimateCost({
  handshakes,
  inboundMessages,
  publishedMessages,
  shardCount,
  batchWindowMs,
  runSeconds,
}) {
  const workerRequests = handshakes;

  const inboundDoRequests = Math.ceil(inboundMessages / PRICING.websocketMessagesPerRequest);

  // With a window, N messages in the window cost one call per shard instead of
  // N. Without one, every message pays for every shard.
  const batches =
    batchWindowMs > 0
      ? Math.max(1, Math.ceil((runSeconds * 1000) / batchWindowMs))
      : publishedMessages;
  const fanoutDoRequests = Math.min(publishedMessages, batches) * shardCount;

  const objectsAlive = shardCount + 1;
  const gbSeconds = objectsAlive * PRICING.durableObjectMemoryGb * runSeconds;

  const doRequests = inboundDoRequests + fanoutDoRequests;
  const usd = {
    workerRequests: (workerRequests / 1_000_000) * PRICING.workerRequestsPerMillion,
    durableObjectRequests: (doRequests / 1_000_000) * PRICING.durableObjectRequestsPerMillion,
    durableObjectDuration: gbSeconds * PRICING.durableObjectGbSeconds,
  };
  usd.total = usd.workerRequests + usd.durableObjectRequests + usd.durableObjectDuration;

  return {
    pricing: PRICING.label,
    units: {
      workerRequests,
      durableObjectRequests: doRequests,
      inboundDoRequests,
      fanoutDoRequests,
      fanoutBatches: Math.min(publishedMessages, batches),
      gbSeconds: Math.round(gbSeconds * 100) / 100,
    },
    usd: Object.fromEntries(
      Object.entries(usd).map(([key, value]) => [key, Math.round(value * 10_000) / 10_000]),
    ),
  };
}

/**
 * Reads the account-level counters the Worker's own observability panel reads.
 * Returns `null` — never throws — when the credentials are absent or the API is
 * unhappy: a cost figure is a nice-to-have, and losing one must not lose a run.
 */
export async function readAccountUsage({ apiToken, accountId, scriptName, minutes = 30 }) {
  if (!apiToken || !accountId) return null;
  const since = new Date(Date.now() - minutes * 60_000).toISOString();
  const query = `
    query Usage($accountId: String!, $since: Time!, $script: String!) {
      viewer {
        accounts(filter: { accountTag: $accountId }) {
          workersInvocationsAdaptive(
            limit: 10000
            filter: { datetime_geq: $since, scriptName: $script }
          ) {
            sum { requests errors subrequests }
          }
          durableObjectsInvocationsAdaptiveGroups(
            limit: 10000
            filter: { datetime_geq: $since }
          ) {
            sum { requests errors }
          }
          durableObjectsPeriodicGroups(limit: 10000, filter: { datetime_geq: $since }) {
            sum { activeTime }
          }
        }
      }
    }`;

  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables: { accountId, since, script: scriptName },
      }),
    });
    if (!res.ok) return null;
    const payload = await res.json();
    const account = payload?.data?.viewer?.accounts?.[0];
    if (!account) return null;

    const sum = (rows, field) =>
      (rows ?? []).reduce((total, row) => total + (row?.sum?.[field] ?? 0), 0);

    return {
      since,
      workerRequests: sum(account.workersInvocationsAdaptive, "requests"),
      workerErrors: sum(account.workersInvocationsAdaptive, "errors"),
      subrequests: sum(account.workersInvocationsAdaptive, "subrequests"),
      durableObjectRequests: sum(account.durableObjectsInvocationsAdaptiveGroups, "requests"),
      durableObjectErrors: sum(account.durableObjectsInvocationsAdaptiveGroups, "errors"),
      /** Microseconds of active time, as the API reports it. */
      durableObjectActiveTime: sum(account.durableObjectsPeriodicGroups, "activeTime"),
    };
  } catch {
    return null;
  }
}

/** `after - before`, field by field; null when either side is missing. */
export function usageDelta(before, after) {
  if (!before || !after) return null;
  const delta = {};
  for (const key of Object.keys(after)) {
    if (typeof after[key] === "number" && typeof before[key] === "number") {
      delta[key] = after[key] - before[key];
    }
  }
  return delta;
}
