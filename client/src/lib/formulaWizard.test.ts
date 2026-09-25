import { describe, expect, it } from "vitest";
import {
  buildWizardExpression,
  planColumnTotal,
  planFormulaWizard,
  wizardSampleColumns,
} from "./formulaWizard";

const field = { maxRows: 6, tableColumns: 12 };
const selection = {
  row: 1,
  column: 11,
  expression: "C*D",
  decimalPlaces: 2,
  wholeColumn: true,
};
describe("same-row formula wizard", () => {
  it("shows only relevant writable sample inputs, including transitive dependencies", () => {
    expect(wizardSampleColumns(field, 0, 11, "C*D")).toEqual([2, 3]);
    expect(
      wizardSampleColumns(
        {
          ...field,
          tableFormulaCells: [{ row: 0, column: 2, expression: "A+B" }],
        },
        0,
        11,
        "C*D",
      ),
    ).toEqual([0, 1, 3]);
    expect(
      wizardSampleColumns(
        {
          ...field,
          tableWritableCells: [],
          tableFormulaCells: [{ row: 0, column: 2, expression: "C" }],
        },
        0,
        11,
        "C*D",
      ),
    ).toEqual([]);
  });
  it("produces existing expressions for all five presets", () => {
    expect(
      ["multiply", "add", "subtract", "percent", "custom"].map((kind) =>
        buildWizardExpression(kind as any, 2, 3, "SQRT(C)^2"),
      ),
    ).toEqual(["C*D", "C+D", "C-D", "C*D/100", "SQRT(C)^2"]);
  });
  it("F01 creates six independent formulas and preserves source fields", () => {
    const before = JSON.stringify(field);
    const result = planFormulaWizard(field, selection, [], "en");
    expect(result.issues).toEqual([]);
    expect(result.patch.tableFormulaCells).toEqual(
      Array.from({ length: 6 }, (_, row) => ({
        row,
        column: 11,
        expression: "C*D",
        decimalPlaces: 2,
      })),
    );
    expect(JSON.stringify(field)).toBe(before);
  });
  it.each([
    ["2", "", "0.00", undefined],
    ["", "", "", undefined],
    ["0", "5", "0.00", undefined],
    ["2", "abc", "", "INVALID_NUMBER"],
    ["3", "12.5", "37.50", undefined],
  ])("uses the production evaluator for %s and %s", (a, b, value, error) => {
    const rows = [["", "", a, b]];
    const result = planFormulaWizard(field, selection, rows, "en");
    expect(result.preview.cells[0][11].value).toBe(value);
    expect(result.preview.cells[0][11].error).toBe(error);
  });
  it.each(["C/0", "SQRT(-1)", "2^101"])(
    "does not hide runtime error %s",
    (expression) => {
      expect(
        planFormulaWizard(
          field,
          { ...selection, expression },
          [["", "", "2"]],
          "en",
        ).preview.hasErrors,
      ).toBe(true);
    },
  );
  it.each(["L+1", "C1+D1", "SUM(C)", "A*"])(
    "rejects invalid definition %s",
    (expression) => {
      expect(
        planFormulaWizard(field, { ...selection, expression }, [], "en").issues
          .length,
      ).toBeGreaterThan(0);
    },
  );
  it("preserves fixed cells and unrelated formulas on single-cell apply", () => {
    const source = {
      ...field,
      tableWritableCells: [{ row: 0, column: 2 }],
      tableFormulaCells: [
        { row: 0, column: 4, expression: "C+1", decimalPlaces: 0 },
      ],
    };
    const result = planFormulaWizard(
      source,
      { ...selection, wholeColumn: false },
      [],
      "en",
    );
    expect(result.patch.tableWritableCells).toEqual(source.tableWritableCells);
    expect(result.patch.tableFormulaCells).toEqual([
      ...source.tableFormulaCells,
      { row: 1, column: 11, expression: "C*D", decimalPlaces: 2 },
    ]);
  });
  it("rejects dimensions, targets and decimal places outside the existing contract", () => {
    expect(() =>
      planFormulaWizard({ ...field, tableColumns: 31 }, selection, [], "en"),
    ).toThrow();
    expect(() =>
      planFormulaWizard(field, { ...selection, row: 6 }, [], "en"),
    ).toThrow();
    expect(() =>
      planFormulaWizard(field, { ...selection, decimalPlaces: 7 }, [], "en"),
    ).toThrow();
  });
});

describe("column total wizard", () => {
  it("creates a versioned total while preserving every unrelated role", () => {
    const source = {
      maxRows: 7,
      tableColumns: 4,
      tableWritableCells: [{ row: 0, column: 0 }, { row: 0, column: 2 }, { row: 1, column: 2 }, { row: 6, column: 2 }],
      tableFormulaCells: [{ row: 0, column: 1, expression: "A*2", decimalPlaces: 2 }],
    };
    const result = planColumnTotal(source, {
      sourceColumn: 2,
      startRow: 0,
      endRow: 5,
      targetRow: 6,
      targetColumn: 2,
      decimalPlaces: 2,
    }, [["", "", "10"], ["", "", "5"]], "en");
    expect(result.issues).toEqual([]);
    expect(result.patch.tableFormulaSchemaVersion).toBe(2);
    expect(result.patch.tableWritableCells).toEqual([{ row: 0, column: 0 }, { row: 0, column: 2 }, { row: 1, column: 2 }]);
    expect(result.patch.tableFormulaCells).toEqual([
      { row: 0, column: 1, expression: "A*2", decimalPlaces: 2 },
      { row: 6, column: 2, expression: "SUM(C1:C6)", decimalPlaces: 2 },
    ]);
    expect(result.preview.effectiveRows[6]![2]).toBe("15.00");
  });

  it("rejects a total whose target is inside its own source range", () => {
    const result = planColumnTotal({ maxRows: 6, tableColumns: 2 }, {
      sourceColumn: 0,
      startRow: 0,
      endRow: 5,
      targetRow: 5,
      targetColumn: 0,
      decimalPlaces: 2,
    }, [], "en");
    expect(result.issues.some(issue => issue.code === "table_formula_aggregate_self_reference")).toBe(true);
  });
});
