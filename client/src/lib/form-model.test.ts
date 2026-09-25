import { describe, expect, it } from "vitest";
import {
  optionMarksForOptions,
  tableCellGuidesForGrid,
  textGeometryWarning,
} from "./form-model";

describe("table cell guides", () => {
  it("covers the whole grid with the even division to start from", () => {
    const guides = tableCellGuidesForGrid(undefined, 2, 3);
    expect(guides).toHaveLength(6);
    expect(guides[0]).toEqual({
      xRatio: 0,
      yRatio: 0,
      widthRatio: 1 / 3,
      heightRatio: 0.5,
    });
    expect(guides[4]).toEqual({
      xRatio: 1 / 3,
      yRatio: 0.5,
      widthRatio: 1 / 3,
      heightRatio: 0.5,
    });
  });

  it("keeps every cell already positioned when a row is added", () => {
    const placed = tableCellGuidesForGrid(undefined, 2, 2).map(
      (guide, index) => (index === 1 ? { ...guide, xRatio: 0.7 } : guide)
    );
    const grown = tableCellGuidesForGrid(placed, 3, 2);
    expect(grown).toHaveLength(6);
    expect(grown.slice(0, 4)).toEqual(placed);
    expect(grown[4]).toEqual({
      xRatio: 0,
      yRatio: 2 / 3,
      widthRatio: 0.5,
      heightRatio: 1 / 3,
    });
  });

  /**
   * Guides are stored row by row, so widening the grid without remapping
   * would slide every row's cells onto the row above it.
   */
  it("keeps cells on their own row when a column is added", () => {
    const placed = tableCellGuidesForGrid(undefined, 2, 2).map(
      (guide, index) => ({ ...guide, xRatio: index / 10 })
    );
    const widened = tableCellGuidesForGrid(placed, 2, 3, 2);
    expect(widened).toHaveLength(6);
    expect(widened[0]!.xRatio).toBeCloseTo(0, 10);
    expect(widened[1]!.xRatio).toBeCloseTo(0.1, 10);
    // The third column of the first row is new, so it starts on the division.
    expect(widened[2]!.xRatio).toBeCloseTo(2 / 3, 10);
    // Row two keeps the cells that were positioned for row two.
    expect(widened[3]!.xRatio).toBeCloseTo(0.2, 10);
    expect(widened[4]!.xRatio).toBeCloseTo(0.3, 10);
  });

  it("never produces an empty grid", () => {
    expect(tableCellGuidesForGrid(undefined, 0, 0)).toHaveLength(1);
  });
});

describe("option marks", () => {
  it("gives every option a slot to print into and to drag", () => {
    expect(optionMarksForOptions(undefined, ["有", "沒有"])).toEqual([
      { option: "有", xRatio: 0, yRatio: 0, widthRatio: 0.5, heightRatio: 1 },
      { option: "沒有", xRatio: 0.5, yRatio: 0, widthRatio: 0.5, heightRatio: 1 },
    ]);
    expect(optionMarksForOptions(undefined, [])).toEqual([]);
  });

  it("supports any number of choice options without losing their individual positions", () => {
    const options = ["甲", "乙", "丙", "丁", "戊", "己", "庚"];
    const marks = optionMarksForOptions(undefined, options);
    expect(marks).toHaveLength(7);
    expect(marks.map(mark => mark.option)).toEqual(options);
    expect(marks.at(-1)).toMatchObject({ xRatio: 6 / 7, widthRatio: 1 / 7 });
  });
});

describe("text geometry warnings", () => {
  const page = { pageWidthMm: 210, pageHeightMm: 297 };

  it("warns before a normal text field is too short for its configured font", () => {
    expect(
      textGeometryWarning({
        ...page,
        type: "text",
        width: 20,
        height: 1,
        fontSizePt: 12,
      })
    ).toBe("too-short");
  });

  it("warns when the configured capacity cannot fit in the available width", () => {
    expect(
      textGeometryWarning({
        ...page,
        type: "text",
        width: 3,
        height: 3,
        fontSizePt: 10,
        maxLength: 20,
      })
    ).toBe("too-narrow");
  });

  it("does not warn for a spacious field or non-text choice controls", () => {
    expect(
      textGeometryWarning({
        ...page,
        type: "text",
        width: 35,
        height: 4,
        fontSizePt: 10,
        maxLength: 8,
      })
    ).toBeNull();
    expect(
      textGeometryWarning({
        ...page,
        type: "radio",
        width: 1,
        height: 1,
        fontSizePt: 14,
      })
    ).toBeNull();
  });
});
