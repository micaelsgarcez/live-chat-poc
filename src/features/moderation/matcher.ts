/**
 * The compiled wordlist.
 *
 * Compiling regexes is by far the most expensive thing this slice does, and the
 * gate runs on the hot path of every inbound message. `ModerationConfig` carries
 * a `wordlistVersion` precisely so the result can be cached: we rebuild only
 * when the coordinator bumps it, not on every message and not on every config
 * object identity change.
 */
import type { Logger } from "../../shared/logger";
import type { ModerationConfig } from "../../shared/room-config";
import { normalize, normalizeTerm, toSourceSpan, type Span } from "./normalize";

/** Guards against a pathological pattern producing unbounded matches. */
const MAX_MATCHES_PER_PATTERN = 64;

export interface ModerationMatcher {
  readonly version: number;
  readonly terms: readonly string[];
  readonly patterns: readonly RegExp[];
  /** Source-coordinate spans of everything blocked in `body`; empty when clean. */
  scan(body: string): Span[];
}

export function buildMatcher(config: ModerationConfig, log: Logger): ModerationMatcher {
  const terms = [...new Set(config.blockedTerms.map(normalizeTerm))].filter((t) => t.length > 0);

  const patterns: RegExp[] = [];
  for (const source of config.blockedPatterns) {
    try {
      patterns.push(new RegExp(source, "gi"));
    } catch (error) {
      // A moderator typo in the room config must never take a shard down: the
      // pattern is dropped and every other rule keeps working.
      log.warn("ignoring invalid moderation pattern", { pattern: source, error: String(error) });
    }
  }

  return {
    version: config.wordlistVersion,
    terms,
    patterns,
    scan(body: string): Span[] {
      if (terms.length === 0 && patterns.length === 0) return [];
      const norm = normalize(body);
      const spans: Span[] = [];

      for (const term of terms) {
        let from = 0;
        for (;;) {
          const at = norm.text.indexOf(term, from);
          if (at < 0) break;
          const span = toSourceSpan(norm, at, at + term.length);
          if (span) spans.push(span);
          from = at + term.length;
        }
      }

      for (const pattern of patterns) {
        // Patterns are author-written, so they are matched against the body as
        // typed *and* against the folded text — the second pass is what catches
        // the same evasions the literal terms are folded for.
        collect(pattern, body, (start, end) => spans.push([start, end]));
        collect(pattern, norm.text, (start, end) => {
          const span = toSourceSpan(norm, start, end);
          if (span) spans.push(span);
        });
      }

      return spans;
    },
  };
}

const cache = new Map<string, ModerationMatcher>();

/** Memoised per room; rebuilt only when `wordlistVersion` changes. */
export function getMatcher(
  roomId: string,
  config: ModerationConfig,
  log: Logger,
): ModerationMatcher {
  const cached = cache.get(roomId);
  if (cached && cached.version === config.wordlistVersion) return cached;
  const built = buildMatcher(config, log);
  cache.set(roomId, built);
  return built;
}

/** Test seam: the cache is process-global and would leak between cases. */
export function resetMatcherCache(): void {
  cache.clear();
}

function collect(
  pattern: RegExp,
  text: string,
  emit: (start: number, end: number) => void,
): void {
  pattern.lastIndex = 0;
  let found = 0;
  let match = pattern.exec(text);
  while (match !== null && found < MAX_MATCHES_PER_PATTERN) {
    if (match[0].length > 0) {
      emit(match.index, match.index + match[0].length);
      found++;
    } else {
      // Zero-length match: `exec` would otherwise spin on the same index.
      pattern.lastIndex++;
    }
    match = pattern.exec(text);
  }
  pattern.lastIndex = 0;
}
