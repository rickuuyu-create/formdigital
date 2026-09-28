const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Width-aware soft wrapping. Explicit newlines are preserved; Latin words
 * move as a unit. Only a token wider than an entire line may be split, and
 * shrink-to-fit can disable that fallback so a long word is shrunk instead. */
export function wrapTextLines(value: string, maxWidth: number, measure: (text: string) => number, breakLongWords = true): string[] {
  const lines: string[] = [];
  for (const paragraph of value.replace(/\r\n?/g, "\n").split("\n")) {
    if (!paragraph || maxWidth <= 0) { lines.push(paragraph); continue; }
    // Han/kana can wrap between characters. Everything else (including a
    // non-breaking space inside a name, apostrophes and hyphenated IDs) stays
    // in a token unless it cannot fit on a fresh line.
    const tokens = paragraph.match(new RegExp(String.raw`[ \t]+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[^ \t\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+`, "gu")) ?? [];
    let current = "";
    let pendingSpace = "";
    for (const token of tokens) {
      if (/^[ \t]+$/.test(token)) { pendingSpace += token; continue; }
      const candidate = current + pendingSpace + token;
      if (current && measure(candidate) > maxWidth) {
        lines.push(current);
        current = "";
        pendingSpace = ""; // whitespace at a soft line break is not indentation
      }
      const next = current + pendingSpace + token;
      pendingSpace = "";
      if (breakLongWords && measure(token) > maxWidth) {
        // Keep combining accents, surrogate pairs and joined emoji together.
        current = "";
        for (const { segment: character } of Array.from(graphemes.segment(next))) {
          if (current && measure(current + character) > maxWidth) {
            lines.push(current);
            current = "";
          }
          current += character;
        }
      } else current = next;
    }
    // Preserve blank whitespace-only paragraphs and explicit indentation.
    lines.push(current || pendingSpace);
  }
  return lines;
}
