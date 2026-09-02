/**
 * Text normalisation for the synchronous wordlist.
 *
 * A literal `indexOf` on the raw body is trivially defeated ("f-r-e-e" aside,
 * `FrEe`, `frée`, `fr33` and `freeee` are all the same word to a human). We fold
 * those tricks away *and* remember where every normalised character came from,
 * so a match can still be masked in the original body with the accents, casing
 * and repetitions the author typed.
 */

/** Digits/symbols people substitute for letters. Deliberately small: an
 *  aggressive table starts eating innocent messages ("l" for "1" breaks prices). */
const LEET: Record<string, string> = {
  "4": "a",
  "3": "e",
  "1": "i",
  "0": "o",
  $: "s",
};

const COMBINING_MARKS = /[\u0300-\u036f]/g;

export const MASK = "****";

export interface NormalizedText {
  text: string;
  /** `starts[i]` / `ends[i]` are the source span the i-th normalised char covers. */
  starts: number[];
  ends: number[];
}

/** A half-open `[start, end)` range in the *source* string. */
export type Span = readonly [number, number];

export function normalize(input: string): NormalizedText {
  const chars: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];

  for (let i = 0; i < input.length; i++) {
    // NFD splits "á" into "a" + a combining accent; dropping the marks is what
    // makes accented obfuscation collapse onto the plain term.
    const folded = input[i]!.normalize("NFD").replace(COMBINING_MARKS, "").toLowerCase();
    for (const char of folded) {
      const mapped = LEET[char] ?? char;
      // Repeated characters collapse ("heellooo" -> "helo") so padding a term
      // with duplicates does not slip past the wordlist. The span of the run is
      // extended instead, so masking still covers every repetition.
      if (chars.length > 0 && chars[chars.length - 1] === mapped) {
        ends[ends.length - 1] = i + 1;
        continue;
      }
      chars.push(mapped);
      starts.push(i);
      ends.push(i + 1);
    }
  }

  return { text: chars.join(""), starts, ends };
}

/** Same folding applied to a configured term, so both sides compare equal. */
export function normalizeTerm(term: string): string {
  return normalize(term).text;
}

/** Translates a `[start, end)` range in normalised coordinates back to the source. */
export function toSourceSpan(norm: NormalizedText, start: number, end: number): Span | null {
  if (end <= start || start < 0 || end > norm.starts.length) return null;
  return [norm.starts[start]!, norm.ends[end - 1]!];
}

/** Replaces every (possibly overlapping) span with `****`. */
export function maskSpans(input: string, spans: readonly Span[]): string {
  if (spans.length === 0) return input;
  const merged = mergeSpans(spans);
  let out = "";
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) out += input.slice(cursor, start);
    out += MASK;
    cursor = Math.max(cursor, end);
  }
  return out + input.slice(cursor);
}

export function mergeSpans(spans: readonly Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Span[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1]) merged[merged.length - 1] = [last[0], Math.max(last[1], span[1])];
    else merged.push(span);
  }
  return merged;
}
