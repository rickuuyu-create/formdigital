import { describe, expect, it } from "vitest";
import {
  tableCellGuideAt,
  tableCellIndex,
  tableCellRect,
  tableGridSize,
  uniformCellRect,
} from "./tableGeometry";

const EVEN_2X2 = [
  { xRatio: 0, yRatio: 0, widthRatio: 0.5, heightRatio: 0.5 },
  { xRatio: 0.5, yRatio: 0, widthRatio: 0.5, heightRatio: 0.5 },
  { xRatio: 0, yRatio: 0.5, widthRatio: 0.5, heightRatio: 0.5 },
  { xRatio: 0.5, yRatio: 0.5, widthRatio: 0.5, heightRatio: 0.5 },
];

describe("table grid size", () => {
  it("uses the declared column count and row limit", () => {
    expect(tableGridSize({ tableColumns: 3, maxRows: 4 }, [])).toEqual({
      rowSlots: 4,
      columns: 3,
    });
  });

  /**
   * The preview read a column count from `options` while the renderer did
   * not, so a table whose columns were only ever named printed as one wide
   * column however many the editor had shown.
   */
  it("falls back to the named columns, the same way on both sides", () => {
    expect(
      tableGridSize({ options: ["欄位 1", "欄位 2", "欄位 3"] }, [])
    ).toEqual({ rowSlots: 1, columns: 3 });
  });

  it("grows rather than dropping rows that were actually entered", () => {
    expect(
      tableGridSize({ tableColumns: 2, maxRows: 2 }, [
        ["a", "b"],
        ["c", "d"],
        ["e", "f"],
      ]).rowSlots
    ).toBe(3);
  });

  it("grows past the declared columns for a wider row", () => {
    expect(
      tableGridSize({ tableColumns: 2, maxRows: 1 }, [["a", "b", "c"]]).columns
    ).toBe(3);
  });

  it("never returns an empty grid", () => {
    expect(tableGridSize({}, [])).toEqual({ rowSlots: 1, columns: 1 });
    expect(
      tableGridSize({ tableColumns: -4, maxRows: "many" }, [])
    ).toEqual({ rowSlots: 1, columns: 1 });
  });
});

describe("table cell placement", () => {
  it("divides the field box evenly when nothing has been positioned", () => {
    for (let row = 0; row < 2; row += 1)
      for (let column = 0; column < 2; column += 1)
        expect(tableCellRect(undefined, 2, 2, row, column)).toEqual(
          uniformCellRect(2, 2, row, column)
        );
  });

  it("keeps the even division for guides that match it", () => {
    expect(tableCellRect(EVEN_2X2, 2, 2, 1, 0)).toEqual(
      uniformCellRect(2, 2, 1, 0)
    );
  });

  it("reads guides row by row", () => {
    expect(tableCellIndex(3, 2, 1)).toBe(7);
    const guides = Array.from({ length: 9 }, (_, index) => ({
      xRatio: index / 100,
      yRatio: 0,
      widthRatio: 0.1,
      heightRatio: 0.1,
    }));
    expect(tableCellRect(guides, 3, 3, 2, 1).xRatio).toBeCloseTo(0.07, 10);
  });

  it("moves only the cell that was positioned", () => {
    const moved = EVEN_2X2.map((guide, index) =>
      index === 1
        ? { xRatio: 0.6, yRatio: 0.1, widthRatio: 0.3, heightRatio: 0.3 }
        : guide
    );
    expect(tableCellRect(moved, 2, 2, 0, 1)).toEqual({
      xRatio: 0.6,
      yRatio: 0.1,
      widthRatio: 0.3,
      heightRatio: 0.3,
    });
    for (const [row, column] of [
      [0, 0],
      [1, 0],
      [1, 1],
    ] as const)
      expect(tableCellRect(moved, 2, 2, row, column)).toEqual(
        uniformCellRect(2, 2, row, column)
      );
  });

  it("falls back for rows entered beyond the guides that were made", () => {
    expect(tableCellRect(EVEN_2X2, 3, 2, 2, 0)).toEqual(
      uniformCellRect(3, 2, 2, 0)
    );
  });

  it("ignores stored geometry that cannot be drawn", () => {
    expect(tableCellGuideAt([{ xRatio: 0, yRatio: 0, widthRatio: 0, heightRatio: 0.5 }], 0)).toBeNull();
    expect(tableCellGuideAt([{ xRatio: "x" }], 0)).toBeNull();
    expect(tableCellGuideAt("not an array", 0)).toBeNull();
    expect(tableCellGuideAt([null], 0)).toBeNull();
    expect(tableCellRect([null], 2, 2, 0, 0)).toEqual(uniformCellRect(2, 2, 0, 0));
  });
});
