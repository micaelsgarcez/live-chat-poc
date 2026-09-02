/**
 * Internal to the spam slice — the pure content heuristics.
 *
 * They run on every unprivileged message on the hot path, so each one is a
 * single linear scan. The regexes deliberately use flat character classes with
 * no nested quantifiers: a catastrophic-backtracking pattern here would be a
 * remote CPU-exhaustion bug in the Durable Object, not just a slow test.
 */

const EXPLICIT_LINK_RE = /(?:https?:\/\/|www\.)[^\s]+/gi;

/**
 * Bare hostnames are only counted on the handful of TLDs spammers actually use.
 * Matching every `word.word` pair would flag ordinary typing ("hi.Then"), and a
 * false positive here silently eats a legitimate message.
 */
const LINK_TLDS = [
  "com", "net", "org", "io", "gg", "ly", "me", "co", "xyz",
  "tv", "info", "biz", "link", "click", "app", "live", "shop",
];

const BARE_HOST_RE = new RegExp(
  `\\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.(?:${LINK_TLDS.join("|")})\\b`,
  "gi",
);

/** `@name` — the same shape the client renders as a mention. */
const MENTION_RE = /@[a-z0-9][a-z0-9._-]{0,31}/gi;

export function countLinks(body: string): number {
  const explicit = body.match(EXPLICIT_LINK_RE)?.length ?? 0;
  // Bare hosts are counted in what is left, so "https://a.com" is one link.
  const remainder = body.replace(EXPLICIT_LINK_RE, " ");
  return explicit + (remainder.match(BARE_HOST_RE)?.length ?? 0);
}

export function countMentions(body: string): number {
  return body.match(MENTION_RE)?.length ?? 0;
}

/**
 * Share of cased letters that are uppercase. Characters without a case (digits,
 * punctuation, emoji, CJK) are ignored so "OK 12345!!!" is not read as shouting.
 * Returns 0 when there is nothing with a case to measure.
 */
export function capsRatio(body: string): number {
  let cased = 0;
  let upper = 0;
  for (const ch of body) {
    const lower = ch.toLowerCase();
    if (lower === ch.toUpperCase()) continue;
    cased++;
    if (ch !== lower) upper++;
  }
  return cased === 0 ? 0 : upper / cased;
}
