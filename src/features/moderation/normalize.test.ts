import { describe, expect, it } from "vitest";
import { MASK, maskSpans, mergeSpans, normalize, normalizeTerm } from "./normalize";

describe("normalize", () => {
  it("folds case, accents, leet and repeated characters onto one form", () => {
    expect(normalize("FrEeE").text).toBe("fre");
    expect(normalize("frée").text).toBe("fre");
    expect(normalize("fr33").text).toBe("fre");
    expect(normalize("$pam").text).toBe("spam");
    expect(normalizeTerm("Free")).toBe("fre");
  });

  it("keeps a span that covers every source character of a collapsed run", () => {
    const norm = normalize("heellooo");
    expect(norm.text).toBe("helo");
    // "o" is the 4th normalised char and must cover all three source "o"s.
    expect(norm.starts[3]).toBe(5);
    expect(norm.ends[3]).toBe(8);
  });

  it("masks the source span, not the normalised one", () => {
    const body = "buy FR33 stuff";
    const norm = normalize(body);
    const at = norm.text.indexOf("fre");
    expect(maskSpans(body, [[norm.starts[at]!, norm.ends[at + 2]!]])).toBe(`buy ${MASK} stuff`);
  });

  it("merges overlapping spans so a double match masks once", () => {
    expect(mergeSpans([[0, 4], [2, 6], [8, 9]])).toEqual([[0, 6], [8, 9]]);
    expect(maskSpans("abcdefghij", [[0, 4], [2, 6]])).toBe(`${MASK}ghij`);
  });
});
