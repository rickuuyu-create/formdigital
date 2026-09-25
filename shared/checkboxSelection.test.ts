import { describe, expect, it } from "vitest";
import {
  isCheckboxChecked,
  isCheckboxOptionSelected,
  isSingleOptionSelected,
  knownOptions,
  normalizeOption,
  selectedCheckboxOptions,
  selectedSingleOption,
  toggleCheckboxOption,
} from "./checkboxSelection";

const ROW = ["關愛人格", "終身學習", "生涯規劃"];
/** Written this way so no editor or tool can quietly rewrite the escape. */
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);

describe("checkbox selection values", () => {
  it("keeps the single boolean meaning for a lone printed square", () => {
    for (const yes of ["checked", "true", "1", "yes", "是", " checked "])
      expect(isCheckboxChecked(yes)).toBe(true);
    for (const no of ["", "false", "0", "no", "否", "maybe"])
      expect(isCheckboxChecked(no)).toBe(false);
  });

  it("reads selections in the field's own option order, not tick order", () => {
    expect(selectedCheckboxOptions(`生涯規劃${LF}關愛人格`, ROW)).toEqual([
      "關愛人格",
      "生涯規劃",
    ]);
  });

  it("drops blank lines, stray spacing, and values that are not options", () => {
    expect(
      selectedCheckboxOptions(`  終身學習  ${LF}${LF}不存在的項目${LF}`, ROW)
    ).toEqual(["終身學習"]);
  });

  it("ticks and unticks one option without disturbing the others", () => {
    let value = "";
    value = toggleCheckboxOption(value, ROW, "終身學習");
    expect(selectedCheckboxOptions(value, ROW)).toEqual(["終身學習"]);

    value = toggleCheckboxOption(value, ROW, "關愛人格");
    expect(selectedCheckboxOptions(value, ROW)).toEqual([
      "關愛人格",
      "終身學習",
    ]);

    value = toggleCheckboxOption(value, ROW, "終身學習");
    expect(selectedCheckboxOptions(value, ROW)).toEqual(["關愛人格"]);
  });

  it("reports whether one option is ticked", () => {
    const value = toggleCheckboxOption("", ROW, "生涯規劃");
    expect(isCheckboxOptionSelected(value, ROW, "生涯規劃")).toBe(true);
    expect(isCheckboxOptionSelected(value, ROW, "關愛人格")).toBe(false);
  });

  it("treats a field with no options as having no selectable options", () => {
    expect(selectedCheckboxOptions("checked", [])).toEqual([]);
    expect(selectedCheckboxOptions("anything", undefined)).toEqual([]);
    expect(knownOptions(undefined)).toEqual([]);
    expect(knownOptions(["a", "", "b"])).toEqual(["a", "b"]);
  });

  /**
   * Selections are stored one per line and read back trimmed. While the
   * options themselves were left exactly as typed, an option carrying a
   * trailing space — or the carriage return a list pasted from Word leaves on
   * every line — could be written into the value but never matched when
   * reading it back, so that one square stayed empty however often it was
   * clicked, and nothing was logged to say why.
   */
  it("ticks an option whose own text carries stray whitespace", () => {
    const messyForms = [
      "關愛人格 ",
      " 關愛人格",
      `關愛人格${CR}`,
      `關愛${LF}人格`,
    ];
    for (const messy of messyForms) {
      const options = [messy, "終身學習", "生涯規劃"];
      const value = toggleCheckboxOption("", options, messy);
      expect(isCheckboxOptionSelected(value, options, messy)).toBe(true);
      // An option holding a line break would otherwise split one selection
      // into two lines, so it reads back as a single spaced option.
      expect(selectedCheckboxOptions(value, options)).toEqual([
        normalizeOption(messy),
      ]);
      expect(toggleCheckboxOption(value, options, messy)).toBe("");
    }
  });

  it("keeps a pasted CRLF option row tickable one square at a time", () => {
    const pasted = `關愛人格${CR}${LF}終身學習${CR}${LF}生涯規劃`.split(LF);
    expect(knownOptions(pasted)).toEqual(ROW);
    let value = toggleCheckboxOption("", pasted, pasted[0]!);
    value = toggleCheckboxOption(value, pasted, pasted[2]!);
    expect(selectedCheckboxOptions(value, pasted)).toEqual([
      "關愛人格",
      "生涯規劃",
    ]);
    expect(isCheckboxOptionSelected(value, pasted, pasted[1]!)).toBe(false);
  });

  it("collapses duplicate options so one square cannot shadow another", () => {
    const options = ["關愛人格", "關愛人格 ", "終身學習"];
    expect(knownOptions(options)).toEqual(["關愛人格", "終身學習"]);
    const value = toggleCheckboxOption("", options, "終身學習");
    expect(selectedCheckboxOptions(value, options)).toEqual(["終身學習"]);
  });

  it("ignores a toggle for something that is not an option", () => {
    expect(toggleCheckboxOption("", ROW, "不存在的項目")).toBe("");
    expect(normalizeOption("  a  b  ")).toBe("a b");
  });

  /**
   * Radio and dropdown compare a stored value against the printed options in
   * five places. While the PDF normalised and the canvas did not, the same
   * stored value printed a mark in the exported form and showed nothing on
   * screen.
   */
  it("matches a single-select option through the one shared comparison", () => {
    const options = ["沒有 ", "有"];
    expect(isSingleOptionSelected("沒有", options, "沒有 ")).toBe(true);
    expect(isSingleOptionSelected("沒有 ", options, "沒有")).toBe(true);
    expect(isSingleOptionSelected(`沒有${CR}`, options, "沒有")).toBe(true);
    expect(isSingleOptionSelected("有", options, "沒有")).toBe(false);
  });

  it("treats a stored value that is not an option as nothing chosen", () => {
    expect(selectedSingleOption("不存在", ROW)).toBe("");
    expect(selectedSingleOption("", ROW)).toBe("");
    expect(selectedSingleOption("  終身學習  ", ROW)).toBe("終身學習");
    // An empty option can never read as chosen, however it is spelled.
    expect(isSingleOptionSelected("", ROW, " ")).toBe(false);
  });

  it("reports nothing chosen when the field carries no options", () => {
    expect(selectedSingleOption("anything", [])).toBe("");
    expect(isSingleOptionSelected("anything", undefined, "anything")).toBe(false);
  });

  /**
   * The options are normalised, so anything comparing against them has to be
   * too. While validation trimmed and the options collapsed inner runs, a
   * value the preview and the PDF both showed as chosen was blocked from
   * being saved.
   */
  it("collapses inner whitespace on both sides of the comparison", () => {
    const options = ["New  York", "Hong Kong"];
    expect(knownOptions(options)).toEqual(["New York", "Hong Kong"]);
    expect(isCheckboxOptionSelected("New York", options, "New  York")).toBe(true);
    expect(selectedCheckboxOptions("New  York", options)).toEqual(["New York"]);
    expect(isSingleOptionSelected("New York", options, "New  York")).toBe(true);
  });

  it("survives a round trip through its stored text form", () => {
    const value = ROW.reduce(
      (current, option) => toggleCheckboxOption(current, ROW, option),
      ""
    );
    expect(value).toBe(ROW.join(LF));
    expect(selectedCheckboxOptions(value, ROW)).toEqual(ROW);
  });
});
