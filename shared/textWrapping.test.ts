import { describe, expect, it } from "vitest";
import { wrapTextLines } from "./textWrapping";

const count = (text: string) => Array.from(text).length;
describe("word-aware wrapping", () => {
  it("moves the whole word is to the next line", () => {
    expect(wrapTextLines("Hong Kong is the city", 11, count)).toEqual(["Hong Kong", "is the city"]);
  });
  it("keeps is on the first line when it fits", () => {
    expect(wrapTextLines("Hong Kong is the city", 12, count)).toEqual(["Hong Kong is", "the city"]);
  });
  it("keeps apostrophes and hyphenated words intact when they fit", () => {
    expect(wrapTextLines("It's a well-known city", 11, count)).toEqual(["It's a", "well-known", "city"]);
  });
  it("retains explicit blank lines and normalizes all newline formats", () => {
    expect(wrapTextLines("Hong\r\n\r\nKong\rcity", 20, count)).toEqual(["Hong", "", "Kong", "city"]);
  });
  it("retains spaces inside a line and indentation after explicit newlines", () => {
    expect(wrapTextLines("  Hong  Kong\n  city", 20, count)).toEqual(["  Hong  Kong", "  city"]);
  });
  it("can wrap Chinese next to an intact English word", () => {
    expect(wrapTextLines("香港Hong Kong城市", 6, count)).toEqual(["香港Hong", "Kong城市"]);
  });
  it("splits only an oversized token, preserving every code point", () => {
    const value = "https://example.test/verylongpath";
    const lines = wrapTextLines(value, 8, count);
    expect(lines.join("")).toBe(value);
    expect(lines.every(line => count(line) <= 8)).toBe(true);
    expect(wrapTextLines("𠮷𠮷𠮷", 2, count)).toEqual(["𠮷𠮷", "𠮷"]);
  });
  it("allows shrinking to measure an oversized word without splitting it", () => {
    expect(wrapTextLines("a verylongword", 8, count, false)).toEqual(["a", "verylongword"]);
  });
  it("does not treat a non-breaking space as a word boundary", () => {
    expect(wrapTextLines("a Hong\u00a0Kong", 10, count)).toEqual(["a", "Hong\u00a0Kong"]);
  });
  it("uses measured width, not character count", () => {
    const width = (text: string) => Array.from(text).reduce((sum, c) => sum + (c === "W" ? 3 : 1), 0);
    expect(wrapTextLines("ii WWW", 9, width)).toEqual(["ii", "WWW"]);
  });
  it("does not detach a combining accent when splitting a long token", () => {
    expect(wrapTextLines("e\u0301e\u0301", 3, count)).toEqual(["e\u0301", "e\u0301"]);
  });
});
