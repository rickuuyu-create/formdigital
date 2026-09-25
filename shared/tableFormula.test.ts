import { describe, it, expect } from "vitest";
import { validateFieldValues } from "./fieldValidation";
import {
  columnIndexToName,
  columnNameToIndex,
  normalizeTableCellPositions,
  normalizeTableFormulaCells,
  resolveTableGridRoles,
  evaluateFormulaExpression,
  resolveEffectiveTableGrid,
  parseTableAggregateExpression,
  validateTableFormulaDefinition,
  formatFormulaNumber,
  formatFormulaErrorMessage,
  formatFormulaIssueMessage,
  normalizeFormulaLocale,
  renderServerIssue,
  localizeServerIssueMarkers,
  FORMULA_ISSUE_CODES,
  FORMULA_ISSUE_CATALOG,
} from "./tableFormula";

describe("shared/tableFormula", () => {
  describe("column conversions", () => {
    it("converts 0-based column indices to column letters A..AD", () => {
      expect(columnIndexToName(0)).toBe("A");
      expect(columnIndexToName(1)).toBe("B");
      expect(columnIndexToName(25)).toBe("Z");
      expect(columnIndexToName(26)).toBe("AA");
      expect(columnIndexToName(27)).toBe("AB");
      expect(columnIndexToName(28)).toBe("AC");
      expect(columnIndexToName(29)).toBe("AD");
      expect(columnIndexToName(30)).toBe("");
      expect(columnIndexToName(-1)).toBe("");
    });

    it("converts column letters A..AD to 0-based column indices", () => {
      expect(columnNameToIndex("A")).toBe(0);
      expect(columnNameToIndex("b")).toBe(1);
      expect(columnNameToIndex("Z")).toBe(25);
      expect(columnNameToIndex("AA")).toBe(26);
      expect(columnNameToIndex("ad")).toBe(29);
      expect(columnNameToIndex("AE")).toBe(-1);
      expect(columnNameToIndex("AAA")).toBe(-1);
      expect(columnNameToIndex("1")).toBe(-1);
    });
  });

  describe("cell roles and normalization", () => {
    it("treats undefined writable mask as legacy all-writable", () => {
      const roles = resolveTableGridRoles({ maxRows: 2, tableColumns: 2 }, 2, 2);
      expect(roles.writableSet).toBeNull();
      expect(roles.getRole(0, 0)).toBe("writable");
      expect(roles.getRole(0, 1)).toBe("writable");
      expect(roles.getRole(1, 0)).toBe("writable");
      expect(roles.getRole(1, 1)).toBe("writable");
    });

    it("treats explicit empty array [] as all fixed (none writable)", () => {
      const roles = resolveTableGridRoles(
        { maxRows: 2, tableColumns: 2, tableWritableCells: [] },
        2,
        2
      );
      expect(roles.writableSet).toEqual(new Set());
      expect(roles.getRole(0, 0)).toBe("fixed");
      expect(roles.getRole(0, 1)).toBe("fixed");
      expect(roles.getRole(1, 0)).toBe("fixed");
      expect(roles.getRole(1, 1)).toBe("fixed");
    });

    it("prioritizes formula cells over writable mask", () => {
      const roles = resolveTableGridRoles(
        {
          maxRows: 2,
          tableColumns: 3,
          tableWritableCells: [
            { row: 0, column: 0 },
            { row: 0, column: 2 }, // also in formula
          ],
          tableFormulaCells: [
            { row: 0, column: 2, expression: "A+B" },
          ],
        },
        2,
        3
      );
      expect(roles.getRole(0, 0)).toBe("writable");
      expect(roles.getRole(0, 1)).toBe("fixed");
      expect(roles.getRole(0, 2)).toBe("formula");
      expect(roles.getRole(1, 0)).toBe("fixed");
    });

    it("normalizes, deduplicates, and sorts coordinates row-major", () => {
      const rawPositions = [
        { row: 1, column: 1 },
        { row: 0, column: 2 },
        { row: 0, column: 0 },
        { row: 0, column: 2 }, // duplicate
        { row: -1, column: 0 }, // negative
        { row: 0, column: 5 }, // out of bounds (columns=3)
        { row: 4, column: 0 }, // out of bounds (maxRows=2)
        { row: "bad", column: 1 },
      ];
      const normalized = normalizeTableCellPositions(rawPositions, 2, 3);
      expect(normalized).toEqual([
        { row: 0, column: 0 },
        { row: 0, column: 2 },
        { row: 1, column: 1 },
      ]);
    });

    it("normalizes tableFormulaCells ignoring invalid and sorting row-major", () => {
      const rawFormulas = [
        { row: 1, column: 2, expression: "A*B", decimalPlaces: 0 },
        { row: 0, column: 1, expression: "=A+1", decimalPlaces: 2 },
        { row: 0, column: 1, expression: "duplicate", decimalPlaces: 2 },
        { row: 0, column: 0, expression: "   " }, // empty
        { row: 2, column: 0, expression: "A+1" }, // out of bounds
        { row: 0, column: 2, expression: "A+2", decimalPlaces: 99 }, // invalid decimalPlaces
      ];
      const normalized = normalizeTableFormulaCells(rawFormulas, 2, 3);
      expect(normalized).toEqual([
        { row: 0, column: 1, expression: "=A+1", decimalPlaces: 2 },
        { row: 1, column: 2, expression: "A*B", decimalPlaces: 0 },
      ]);
    });
  });

  describe("formula evaluator", () => {
    it("evaluates basic arithmetic 2+3*4=14 and (2+3)*4=20", () => {
      const res1 = evaluateFormulaExpression("2+3*4", () => 0);
      expect(res1.value).toBe(14);
      expect(res1.formatted).toBe("14.00");

      const res2 = evaluateFormulaExpression("(2+3)*4", () => 0);
      expect(res2.value).toBe(20);
      expect(res2.formatted).toBe("20.00");
    });

    it("evaluates right-associative exponentiation 2^3^2 = 512", () => {
      const res = evaluateFormulaExpression("2^3^2", () => 0);
      expect(res.value).toBe(512);
      expect(res.formatted).toBe("512.00");
    });

    it("evaluates sqrt(81)=9", () => {
      const res = evaluateFormulaExpression("sqrt(81)", () => 0);
      expect(res.value).toBe(9);
      expect(res.formatted).toBe("9.00");
    });

    it("evaluates unary minus and optional leading =", () => {
      const res1 = evaluateFormulaExpression("=-5 + 3", () => 0);
      expect(res1.value).toBe(-2);
      expect(res1.formatted).toBe("-2.00");

      const res2 = evaluateFormulaExpression("-(2+3)*4", () => 0);
      expect(res2.value).toBe(-20);
      expect(res2.formatted).toBe("-20.00");
    });

    it("evaluates column references in same row (A, B, AA)", () => {
      const values: Record<string, number> = { A: 10, B: 25, AA: 5 };
      const res1 = evaluateFormulaExpression("=A+B", col => values[col] ?? 0);
      expect(res1.value).toBe(35);
      expect(res1.formatted).toBe("35.00");

      const res2 = evaluateFormulaExpression("A * AA", col => values[col] ?? 0);
      expect(res2.value).toBe(50);
      expect(res2.formatted).toBe("50.00");
    });

    it("handles thousand-comma formatted numbers", () => {
      const res = evaluateFormulaExpression("1,234.50 + 2,000", () => 0);
      expect(res.value).toBe(3234.5);
      expect(res.formatted).toBe("3234.50");
    });

    it("handles decimalPlaces 0, 2, 6 and normalizes -0", () => {
      const res0 = evaluateFormulaExpression("14.49", () => 0, { decimalPlaces: 0 });
      expect(res0.formatted).toBe("14");

      const res2 = evaluateFormulaExpression("14.49", () => 0, { decimalPlaces: 2 });
      expect(res2.formatted).toBe("14.49");

      const res6 = evaluateFormulaExpression("1/3", () => 0, { decimalPlaces: 6 });
      expect(res6.formatted).toBe("0.333333");

      const resMinusZero = evaluateFormulaExpression("-0.00001", () => 0, { decimalPlaces: 2 });
      expect(resMinusZero.formatted).toBe("0.00");
    });

    it("returns error code for division by zero", () => {
      const res = evaluateFormulaExpression("5 / 0", () => 0);
      expect(res.error).toBe("DIVISION_BY_ZERO");
      expect(res.value).toBeNull();
    });

    it("returns error code for negative sqrt", () => {
      const res = evaluateFormulaExpression("sqrt(-4)", () => 0);
      expect(res.error).toBe("NEGATIVE_SQRT");
      expect(res.value).toBeNull();
    });

    it("returns error code for exponent too large abs(exponent) > 100", () => {
      const res = evaluateFormulaExpression("2 ^ 101", () => 0);
      expect(res.error).toBe("EXPONENT_TOO_LARGE");
    });

    it("rejects cross-row references like A1", () => {
      const res = evaluateFormulaExpression("A1 + B", () => 0);
      expect(res.error).toMatch(/CROSS_ROW|SYNTAX/);
    });

    it("rejects unsupported functions like SUM, IF, etc.", () => {
      const res1 = evaluateFormulaExpression("SUM(A, B)", () => 0);
      expect(res1.error).toMatch(/UNSUPPORTED_FUNCTION|SYNTAX/);

      const res2 = evaluateFormulaExpression("IF(A>0, 1, 0)", () => 0);
      expect(res2.error).toMatch(/UNSUPPORTED_FUNCTION|SYNTAX/);
    });

    it("rejects expressions exceeding 256 characters", () => {
      const longExpr = "1+" + "1+".repeat(130) + "1";
      const res = evaluateFormulaExpression(longExpr, () => 0);
      expect(res.error).toBe("EXPRESSION_TOO_LONG");
    });
  });

  describe("resolveEffectiveTableGrid", () => {
    it("returns empty string when all referenced inputs are blank", () => {
      const grid = resolveEffectiveTableGrid(
        {
          tableColumns: 3,
          maxRows: 2,
          tableFormulaCells: [{ row: 0, column: 2, expression: "A+B" }],
        },
        JSON.stringify([["", "", ""]])
      );
      expect(grid.effectiveRows[0]![2]).toBe("");
      expect(grid.hasErrors).toBe(false);
    });

    it("treats blank referenced cells as 0 when at least one referenced cell has a number", () => {
      const grid = resolveEffectiveTableGrid(
        {
          tableColumns: 3,
          maxRows: 2,
          tableFormulaCells: [{ row: 0, column: 2, expression: "A+B" }],
        },
        JSON.stringify([["10", "", ""]])
      );
      expect(grid.effectiveRows[0]![2]).toBe("10.00");
    });

    it("reports error when referenced cell contains non-empty non-number string", () => {
      const grid = resolveEffectiveTableGrid(
        {
          tableColumns: 3,
          maxRows: 2,
          tableFormulaCells: [{ row: 0, column: 2, expression: "A+B" }],
        },
        JSON.stringify([["abc", "", ""]])
      );
      expect(grid.hasErrors).toBe(true);
      expect(grid.errors.some(e => e.row === 0 && e.column === 2)).toBe(true);
    });

    it("excludes fixed cell residual data from effective output", () => {
      const grid = resolveEffectiveTableGrid(
        {
          tableColumns: 3,
          maxRows: 2,
          tableWritableCells: [{ row: 0, column: 0 }],
          tableFormulaCells: [{ row: 0, column: 2, expression: "A*2" }],
        },
        JSON.stringify([
          ["15", "old_residual_in_fixed_cell", "old_formula_residual"],
        ])
      );
      expect(grid.effectiveRows[0]![0]).toBe("15");
      expect(grid.effectiveRows[0]![1]).toBe(""); // fixed cell cleared
      expect(grid.effectiveRows[0]![2]).toBe("30.00"); // formula evaluated
    });

    it("detects circular reference within same row", () => {
      const grid = resolveEffectiveTableGrid(
        {
          tableColumns: 3,
          maxRows: 2,
          tableFormulaCells: [
            { row: 0, column: 1, expression: "C+1" },
            { row: 0, column: 2, expression: "B+1" },
          ],
        },
        JSON.stringify([["1", "", ""]])
      );
      expect(grid.hasErrors).toBe(true);
      expect(grid.errors.some(e => e.code === "CIRCULAR_REFERENCE")).toBe(true);
    });

    it("keeps schema v1 byte-compatible and treats SUM as unsupported", () => {
      const legacy = {
        tableColumns: 2,
        maxRows: 3,
        tableFormulaCells: [{ row: 2, column: 1, expression: "SUM(A1:A2)" }],
      };
      expect(validateTableFormulaDefinition(legacy).some(i => i.code === "table_formula_syntax")).toBe(true);
      const grid = resolveEffectiveTableGrid(legacy, JSON.stringify([["2", ""], ["3", ""], ["", ""]]));
      expect(grid.hasErrors).toBe(true);
      expect(grid.effectiveRows[2]![1]).toBe("");
    });

    it("calculates a bounded schema v2 column total after same-row formulas", () => {
      const grid = resolveEffectiveTableGrid(
        {
          tableFormulaSchemaVersion: 2,
          tableColumns: 3,
          maxRows: 4,
          tableFormulaCells: [
            { row: 0, column: 2, expression: "A*B", decimalPlaces: 2 },
            { row: 1, column: 2, expression: "A*B", decimalPlaces: 2 },
            { row: 3, column: 2, expression: "SUM(C1:C3)", decimalPlaces: 2 },
          ],
        },
        JSON.stringify([["2", "10", ""], ["3", "5", ""], ["", "", ""], ["", "", ""]])
      );
      expect(grid.hasErrors).toBe(false);
      expect(grid.effectiveRows[0]![2]).toBe("20.00");
      expect(grid.effectiveRows[1]![2]).toBe("15.00");
      expect(grid.effectiveRows[3]![2]).toBe("35.00");
    });

    it("leaves an all-blank aggregate blank and rejects invalid source values", () => {
      const definition = {
        tableFormulaSchemaVersion: 2,
        tableColumns: 2,
        maxRows: 3,
        tableFormulaCells: [{ row: 2, column: 0, expression: "SUM(A1:A2)", decimalPlaces: 2 }],
      };
      expect(resolveEffectiveTableGrid(definition, JSON.stringify([["", ""], ["", ""], ["", ""]])).effectiveRows[2]![0]).toBe("");
      const invalid = resolveEffectiveTableGrid(definition, JSON.stringify([["not-a-number", ""], ["2", ""], ["", ""]]));
      expect(invalid.hasErrors).toBe(true);
      expect(invalid.errors.some(error => error.code === "INVALID_NUMBER")).toBe(true);
    });
  });

  describe("validateTableFormulaDefinition", () => {
    it("reports error for unknown column reference", () => {
      const issues = validateTableFormulaDefinition({
        tableColumns: 2,
        tableFormulaCells: [{ row: 0, column: 1, expression: "C+1" }],
      });
      expect(issues.length).toBeGreaterThan(0);
      expect(issues[0]!.code).toMatch(/unknown_column|ref/i);
    });

    it("reports error for self reference", () => {
      const issues = validateTableFormulaDefinition({
        tableColumns: 3,
        tableFormulaCells: [{ row: 0, column: 1, expression: "B+1" }],
      });
      expect(issues.length).toBeGreaterThan(0);
      expect(issues[0]!.code).toMatch(/circular|self/i);
    });

    it("passes for valid formula definitions", () => {
      const issues = validateTableFormulaDefinition({
        tableColumns: 3,
        tableFormulaCells: [{ row: 0, column: 2, expression: "A+B" }],
      });
      expect(issues.length).toBe(0);
    });

    it("accepts only bounded schema v2 SUM ranges", () => {
      expect(parseTableAggregateExpression("=SUM(C1:C6)").reference).toEqual({
        column: 2,
        startRow: 0,
        endRow: 5,
      });
      expect(parseTableAggregateExpression("SUM(A1:B2)").error).toBe("AGGREGATE_RANGE_MUST_USE_ONE_COLUMN");
      expect(validateTableFormulaDefinition({
        tableFormulaSchemaVersion: 2,
        tableColumns: 3,
        maxRows: 7,
        tableFormulaCells: [{ row: 6, column: 2, expression: "SUM(C1:C6)" }],
      })).toEqual([]);
    });

    it("rejects aggregate self-reference and aggregate-on-aggregate dependencies", () => {
      const self = validateTableFormulaDefinition({
        tableFormulaSchemaVersion: 2,
        tableColumns: 2,
        maxRows: 3,
        tableFormulaCells: [{ row: 1, column: 0, expression: "SUM(A1:A2)" }],
      });
      expect(self.some(i => i.code === "table_formula_aggregate_self_reference")).toBe(true);

      const nested = validateTableFormulaDefinition({
        tableFormulaSchemaVersion: 2,
        tableColumns: 2,
        maxRows: 5,
        tableFormulaCells: [
          { row: 2, column: 0, expression: "SUM(A1:A2)" },
          { row: 4, column: 0, expression: "SUM(A1:A4)" },
        ],
      });
      expect(nested.some(i => i.code === "table_formula_aggregate_dependency")).toBe(true);
    });

    it("reports error for empty formula expression (P1-B)", () => {
      const issues = validateTableFormulaDefinition({
        tableColumns: 3,
        tableFormulaCells: [{ row: 0, column: 0, expression: "" }],
      });
      expect(issues.length).toBeGreaterThan(0);
      expect(issues[0]!.code).toBe("table_formula_empty");
    });

    it("reports error for invalid decimalPlaces > 6 (P1-B)", () => {
      const issues = validateTableFormulaDefinition({
        tableColumns: 3,
        tableFormulaCells: [{ row: 0, column: 0, expression: "A+1", decimalPlaces: 7 }],
      });
      expect(issues.length).toBeGreaterThan(0);
      expect(issues[0]!.code).toBe("table_formula_decimal_places");
    });

    it("reports error for out-of-bounds formula cell row or column (P1-B)", () => {
      const issues = validateTableFormulaDefinition({
        maxRows: 2,
        tableColumns: 3,
        tableFormulaCells: [
          { row: 5, column: 0, expression: "A+1" },
          { row: 0, column: 5, expression: "A+1" },
        ],
      });
      expect(issues.length).toBeGreaterThanOrEqual(2);
      expect(issues.some(i => i.code === "table_formula_bounds")).toBe(true);
    });
  });

  describe("financial decimal rounding & strict number parsing (P2-A)", () => {
    it("rounds 1.005 to 1.01 and 2.675 to 2.68 at 2 decimal places", () => {
      expect(formatFormulaNumber(1.005, 2)).toBe("1.01");
      expect(formatFormulaNumber(2.675, 2)).toBe("2.68");
      expect(formatFormulaNumber(-1.005, 2)).toBe("-1.01");
    });

    it("rejects non-standard JavaScript numbers like 0x10, 1e3, and bad thousand separators", () => {
      const grid = resolveEffectiveTableGrid(
        {
          tableColumns: 2,
          maxRows: 4,
          tableFormulaCells: [
            { row: 0, column: 1, expression: "A+1" },
            { row: 1, column: 1, expression: "A+1" },
            { row: 2, column: 1, expression: "A+1" },
            { row: 3, column: 1, expression: "A+1" },
          ],
        },
        JSON.stringify([
          ["0x10", ""],
          ["1e3", ""],
          ["1,23", ""],
          ["+", ""],
        ])
      );
      expect(grid.hasErrors).toBe(true);
      expect(grid.errors.length).toBe(4);
      for (const err of grid.errors) {
        expect(err.code).toBe("INVALID_NUMBER");
      }
    });
  });

  describe("formal grid boundary enforcement (P2-B)", () => {
    it("does not expand formal grid when raw JSON has extra rows or columns", () => {
      const grid = resolveEffectiveTableGrid(
        {
          tableColumns: 2,
          maxRows: 1,
          tableWritableCells: [{ row: 0, column: 0 }, { row: 0, column: 1 }],
        },
        JSON.stringify([
          ["A", "B", "OUT_OF_BOUNDS_COL_C"],
          ["OUT_OF_BOUNDS_ROW_2", "DATA", "DATA"],
        ])
      );
      expect(grid.rowSlots).toBe(1);
      expect(grid.columns).toBe(2);
      expect(grid.effectiveRows.length).toBe(1);
      expect(grid.effectiveRows[0]!.length).toBe(2);
      expect(grid.effectiveRows[0]![0]).toBe("A");
      expect(grid.effectiveRows[0]![1]).toBe("B");
      expect(grid.effectiveJson).toBe(JSON.stringify([["A", "B"]]));
    });
  });

  describe("P1-A: 6-decimal places scientific notation formatting (round 3)", () => {
    it("formats 6-decimal numbers without producing NaN", () => {
      expect(formatFormulaNumber(0.0000005, 6)).toBe("0.000001");
      expect(formatFormulaNumber(0.0000001, 6)).toBe("0.000000");
      expect(formatFormulaNumber(-0.0000005, 6)).toBe("-0.000001");
      expect(formatFormulaNumber(0.0000015, 6)).toBe("0.000002");
    });

    it("evaluateFormulaExpression formats 6-decimal results without producing NaN", () => {
      const res = evaluateFormulaExpression("A", () => 0.0000005, { decimalPlaces: 6 });
      expect(res.error).toBeUndefined();
      expect(res.formatted).toBe("0.000001");
    });
  });

  describe("P1-D: fail-closed validation for malformed formulas and dimensions (round 3)", () => {
    it("reports error for primitive and null tableFormulaCells entries", () => {
      const issues1 = validateTableFormulaDefinition({
        tableColumns: 3,
        tableFormulaCells: ["bad" as any],
      });
      expect(issues1.length).toBeGreaterThan(0);
      expect(issues1[0]!.code).toBe("table_formula_malformed");

      const issues2 = validateTableFormulaDefinition({
        tableColumns: 3,
        tableFormulaCells: [null as any],
      });
      expect(issues2.length).toBeGreaterThan(0);
      expect(issues2[0]!.code).toBe("table_formula_malformed");
    });

    it("reports error for tableColumns > 30 and maxRows > 100", () => {
      const issuesCols = validateTableFormulaDefinition({
        tableColumns: 31,
        tableFormulaCells: [{ row: 0, column: 0, expression: "A+1" }],
      });
      expect(issuesCols.some(i => i.code === "table_columns_bounds")).toBe(true);

      const issuesRows = validateTableFormulaDefinition({
        tableColumns: 3,
        maxRows: 101,
        tableFormulaCells: [{ row: 0, column: 0, expression: "A+1" }],
      });
      expect(issuesRows.some(i => i.code === "table_rows_bounds")).toBe(true);
    });

    it("reports bounds error when column index equals tableColumns (0-indexed)", () => {
      const issues = validateTableFormulaDefinition({
        tableColumns: 30,
        maxRows: 10,
        tableFormulaCells: [{ row: 0, column: 30, expression: "A+1" }],
      });
      expect(issues.some(i => i.code === "table_formula_bounds")).toBe(true);
    });
  });

  describe("P2-B: formatFormulaErrorMessage safe extraction and trilingual mapping", () => {
    it("strips raw syntax suffixes and returns localized error messages", () => {
      expect(formatFormulaErrorMessage("UNEXPECTED_CHARACTER: $", "zh-TW")).toBe("公式包含未允許的字元");
      expect(formatFormulaErrorMessage("UNEXPECTED_CHARACTER: $", "zh-CN")).toBe("公式包含未允许的字符");
      expect(formatFormulaErrorMessage("UNEXPECTED_CHARACTER: $", "en")).toBe("Formula contains disallowed characters");

      expect(formatFormulaErrorMessage("UNEXPECTED_TOKEN: ;", "zh-TW")).toBe("公式語法不符合規則");
      expect(formatFormulaErrorMessage("UNEXPECTED_TOKEN: ;", "zh-CN")).toBe("公式语法不符合规则");
      expect(formatFormulaErrorMessage("UNEXPECTED_TOKEN: ;", "en")).toBe("Unexpected token in formula syntax");
    });

    it("provides trilingual translations for mathematical and reference errors", () => {
      expect(formatFormulaErrorMessage("DIVISION_BY_ZERO", "zh-TW")).toBe("除以零錯誤");
      expect(formatFormulaErrorMessage("DIVISION_BY_ZERO", "zh-CN")).toBe("除以零错误");
      expect(formatFormulaErrorMessage("DIVISION_BY_ZERO", "en")).toBe("Division by zero");

      expect(formatFormulaErrorMessage("CIRCULAR_REFERENCE", "zh-TW")).toBe("公式存在循環引用");
      expect(formatFormulaErrorMessage("CIRCULAR_REFERENCE", "zh-CN")).toBe("公式存在循环引用");
      expect(formatFormulaErrorMessage("CIRCULAR_REFERENCE", "en")).toBe("Circular reference detected");
    });

    it("R4-P4: covers missing codes EXPRESSION_TOO_LONG, INVALID_NUMBER_VALUE, CROSS_ROW_NOT_ALLOWED, UNSUPPORTED_FUNCTION across 3 languages", () => {
      for (const lang of ["zh-TW", "zh-CN", "en"] as const) {
        expect(formatFormulaErrorMessage("EXPRESSION_TOO_LONG", lang)).not.toBe("EXPRESSION_TOO_LONG");
        expect(formatFormulaErrorMessage("INVALID_NUMBER_VALUE", lang)).not.toBe("INVALID_NUMBER_VALUE");
        expect(formatFormulaErrorMessage("CROSS_ROW_NOT_ALLOWED", lang)).not.toBe("CROSS_ROW_NOT_ALLOWED");
        expect(formatFormulaErrorMessage("UNSUPPORTED_FUNCTION", lang)).not.toBe("UNSUPPORTED_FUNCTION");
      }
      expect(formatFormulaErrorMessage("UNSUPPORTED_FUNCTION: SUM", "en")).toBe("Unsupported function (only sqrt is supported)");
      expect(formatFormulaErrorMessage("UNSUPPORTED_FUNCTION: SUM", "zh-TW")).toBe("不支援的函數名稱（僅支援 sqrt）");
      expect(formatFormulaErrorMessage("CROSS_ROW_NOT_ALLOWED", "zh-TW")).toBe("公式不允許跨列引用");
    });

    it("R4-P4: returns generic safe message for completely unknown error codes without leaking internal code", () => {
      expect(formatFormulaErrorMessage("INTERNAL_SECRET_DETAIL: sensitive", "zh-TW")).toBe("公式無法處理");
      expect(formatFormulaErrorMessage("INTERNAL_SECRET_DETAIL: sensitive", "zh-CN")).toBe("公式无法处理");
      expect(formatFormulaErrorMessage("INTERNAL_SECRET_DETAIL: sensitive", "en")).toBe("Formula could not be processed");
    });
  });

  describe("R4-P1: large numbers decimal formatting without scientific notation corruption", () => {
    const decimalRegex = /^-?\d+(?:\.\d+)?$/;

    it("formats 1e15 with 6 decimal places as plain decimal string", () => {
      const res = formatFormulaNumber(1000000000000000, 6);
      expect(res).toMatch(decimalRegex);
      expect(res).toBe("1000000000000000.000000");
    });

    it("formats Number.MAX_SAFE_INTEGER with 6 decimal places as plain decimal string", () => {
      const res = formatFormulaNumber(Number.MAX_SAFE_INTEGER, 6);
      expect(res).toMatch(decimalRegex);
      expect(res).toBe("9007199254740991.000000");
    });

    it("formats 999999999999999.5 with 6 decimal places as plain decimal string", () => {
      const res = formatFormulaNumber(999999999999999.5, 6);
      expect(res).toMatch(decimalRegex);
      expect(res).toBe("999999999999999.500000");
    });

    it("evaluateFormulaExpression evaluates Number.MAX_SAFE_INTEGER without corrupting into scientific notation", () => {
      const res = evaluateFormulaExpression("A", () => Number.MAX_SAFE_INTEGER, { decimalPlaces: 6 });
      expect(res.error).toBeUndefined();
      expect(res.formatted).toMatch(decimalRegex);
      expect(res.formatted).toBe("9007199254740991.000000");
    });
  });

  describe("R5-P3: full trilingual table formula definition validation", () => {
    const CJK = /[一-鿿]/;
    type AnyDef = Parameters<typeof validateTableFormulaDefinition>[0];

    const cases: Array<{ code: string; definition: AnyDef }> = [
      { code: "table_columns_bounds", definition: { tableColumns: 31 } },
      { code: "table_rows_bounds", definition: { maxRows: 101 } },
      { code: "table_formula_malformed", definition: { tableColumns: 3, tableFormulaCells: ["bad"] as never } },
      {
        code: "table_formula_bounds",
        definition: { tableColumns: 3, maxRows: 2, tableFormulaCells: [{ row: 5, column: 0, expression: "A+1" }] },
      },
      {
        code: "table_formula_duplicate",
        definition: {
          tableColumns: 3,
          tableFormulaCells: [
            { row: 0, column: 0, expression: "A+1" },
            { row: 0, column: 0, expression: "A+2" },
          ],
        },
      },
      { code: "table_formula_empty", definition: { tableColumns: 3, tableFormulaCells: [{ row: 0, column: 0, expression: "" }] } },
      {
        code: "table_formula_decimal_places",
        definition: { tableColumns: 3, tableFormulaCells: [{ row: 0, column: 0, expression: "A+1", decimalPlaces: 7 }] },
      },
      { code: "table_formula_syntax", definition: { tableColumns: 3, tableFormulaCells: [{ row: 0, column: 0, expression: "$ + 1" }] } },
      { code: "table_formula_unknown_column", definition: { tableColumns: 2, tableFormulaCells: [{ row: 0, column: 1, expression: "C+1" }] } },
      { code: "table_formula_self_reference", definition: { tableColumns: 3, tableFormulaCells: [{ row: 0, column: 1, expression: "B+1" }] } },
      {
        code: "table_formula_circular_reference",
        definition: {
          tableColumns: 3,
          tableFormulaCells: [
            { row: 0, column: 1, expression: "C+1" },
            { row: 0, column: 2, expression: "B+1" },
          ],
        },
      },
    ];

    it("direct counterexample: English unknown column, self reference and circular reference are fully English", () => {
      for (const code of ["table_formula_unknown_column", "table_formula_self_reference", "table_formula_circular_reference"]) {
        const testCase = cases.find(item => item.code === code)!;
        const issues = validateTableFormulaDefinition(testCase.definition, "en" as never);
        const issue = issues.find(item => item.code === code);
        expect(issue, `${code} @ en`).toBeTruthy();
        expect(issue!.message, `${code} @ en must not contain CJK`).not.toMatch(CJK);
        expect(issue!.message).not.toContain("UNSUPPORTED_FUNCTION");
        expect(issue!.message).not.toContain(code);
      }
    });

    it("direct counterexample: Simplified circular reference and decimal bounds use Simplified wording", () => {
      const circular = validateTableFormulaDefinition(
        cases.find(item => item.code === "table_formula_circular_reference")!.definition,
        "zh-Hans" as never
      ).find(item => item.code === "table_formula_circular_reference")!;
      expect(circular).toBeTruthy();
      expect(circular.message).toContain("循环");
      expect(circular.message).not.toContain("循環");

      const decimals = validateTableFormulaDefinition(
        cases.find(item => item.code === "table_formula_decimal_places")!.definition,
        "zh-Hans" as never
      ).find(item => item.code === "table_formula_decimal_places")!;
      expect(decimals).toBeTruthy();
      expect(decimals.message).toContain("小数");
      expect(decimals.message).not.toContain("小數");
    });

    it("every stable issue code is localized in zh-Hant / zh-Hans / en", () => {
      for (const testCase of cases) {
        const rendered = new Map<string, string>();
        for (const locale of ["zh-Hant", "zh-Hans", "en"] as const) {
          const issues = validateTableFormulaDefinition(testCase.definition, locale as never);
          const issue = issues.find(item => item.code === testCase.code);
          expect(issue, `${testCase.code} @ ${locale}`).toBeTruthy();
          expect(issue!.message.length, `${testCase.code} @ ${locale}`).toBeGreaterThan(0);
          expect(issue!.message, `${testCase.code} @ ${locale} leaks the code`).not.toContain(testCase.code);
          if (locale === "en") expect(issue!.message).not.toMatch(CJK);
          rendered.set(locale, issue!.message);
        }
        // en must actually differ from zh-Hant, otherwise it is not translated.
        expect(rendered.get("en"), `${testCase.code} en === zh-Hant`).not.toBe(rendered.get("zh-Hant"));
        // The traditional and simplified variants must differ where the wording differs.
        expect(rendered.get("zh-Hans") === rendered.get("zh-Hant")).toBe(false);
      }
    });

    it("unknown parser codes fall back to a generic safe message in all three locales", () => {
      expect(formatFormulaErrorMessage("INTERNAL_SECRET_DETAIL: anything", "en")).toBe("Formula could not be processed");
      expect(formatFormulaErrorMessage("INTERNAL_SECRET_DETAIL: anything", "zh-Hant")).toBe("公式無法處理");
      expect(formatFormulaErrorMessage("INTERNAL_SECRET_DETAIL: anything", "zh-Hans")).toBe("公式无法处理");
    });

    it("catalog completeness: every stable issue code has three fixed messages", () => {
      const ALLOWED_PLACEHOLDERS = new Set(["index", "row", "column", "reference", "detail", "max", "min"]);
      const SAMPLE_PARAMS = { index: 1, row: 1, column: "B", reference: "C", detail: "detail", max: 10, min: 1 };
      // For each code its zh-Hant and zh-Hans are parallel translations, so any
      // glyph present in zh-Hant but absent from that code's zh-Hans is genuinely
      // Traditional-only for THIS code. Checking per-code (not a global denylist)
      // avoids false positives for shared glyphs like 列 / 格 / 位 that are
      // Traditional in one code's wording but a valid Simplified glyph elsewhere.
      const traditionalOnlyFor = (code: string): Set<string> => {
        const hant = String((FORMULA_ISSUE_CATALOG as Record<string, Record<string, string>>)[code]?.["zh-Hant"] ?? "");
        const hans = String((FORMULA_ISSUE_CATALOG as Record<string, Record<string, string>>)[code]?.["zh-Hans"] ?? "");
        return new Set([...hant].filter(ch => !hans.includes(ch)));
      };
      expect(FORMULA_ISSUE_CODES.length).toBeGreaterThan(0);
      for (const code of FORMULA_ISSUE_CODES) {
        const traditional = formatFormulaIssueMessage(code, "zh-Hant", SAMPLE_PARAMS);
        const simplified = formatFormulaIssueMessage(code, "zh-Hans", SAMPLE_PARAMS);
        const english = formatFormulaIssueMessage(code, "en", SAMPLE_PARAMS);
        for (const text of [traditional, simplified, english]) {
          expect(text.length, `${code} must have a message`).toBeGreaterThan(0);
          expect(text, `${code} must not leak an unresolved placeholder`).not.toContain("{");
        }
        // Codes are ASCII identifiers (e.g. table_formula_unknown_column,
        // required). They must never appear verbatim inside a Chinese message.
        // The English message may legitimately contain the code word (e.g.
        // "This field is required"), so we only forbid the raw-code-exact case
        // there and rely on the Chinese checks plus the "differs from zh-Hant"
        // guarantee below to catch real leaks.
        expect(traditional, `${code} zh-Hant must not leak the code`).not.toContain(code);
        expect(simplified, `${code} zh-Hans must not leak the code`).not.toContain(code);
        expect(english, `${code} en must not be the raw code`).not.toBe(code);
        // Only safe, bounded placeholders may ever be interpolated.
        const raw = String((FORMULA_ISSUE_CATALOG as Record<string, Record<string, string>>)[code]?.["zh-Hant"] ?? "");
        for (const match of raw.matchAll(/\{(\w+)\}/g)) {
          expect(ALLOWED_PLACEHOLDERS.has(match[1]!), `${code} uses placeholder {${match[1]}}`).toBe(true);
        }
        expect(english, `${code} en must differ from zh-Hant`).not.toBe(traditional);
        const trad = traditionalOnlyFor(code);
        expect([...simplified].some(ch => trad.has(ch)), `${code} zh-Hans must not retain Traditional-only characters`).toBe(false);
      }
    });

    it("normalizes the legacy zh-TW / zh-CN spelling onto the product locale", () => {
      expect(normalizeFormulaLocale("zh-TW")).toBe("zh-Hant");
      expect(normalizeFormulaLocale("zh-Hant")).toBe("zh-Hant");
      expect(normalizeFormulaLocale("zh-CN")).toBe("zh-Hans");
      expect(normalizeFormulaLocale("zh-Hans")).toBe("zh-Hans");
      expect(normalizeFormulaLocale("en")).toBe("en");
      expect(normalizeFormulaLocale(undefined)).toBe("zh-Hant");
      expect(formatFormulaIssueMessage("table_formula_empty", "zh-TW", { row: 1, column: "A" }))
        .toBe(formatFormulaIssueMessage("table_formula_empty", "zh-Hant", { row: 1, column: "A" }));
    });

    it("never echoes an unknown issue code through the server marker path", () => {
      const marker = renderServerIssue(
        "table_formula_unknown_column",
        { row: 1, column: "B", reference: "C" },
        "第 1 列 B 欄公式引用了不存在的欄位 C"
      );
      expect(marker).toContain("table_formula_unknown_column");
      expect(localizeServerIssueMarkers(marker, "en")).not.toContain("FD_ISSUE");
      expect(localizeServerIssueMarkers(marker, "en")).not.toMatch(/[一-鿿]/);
      expect(localizeServerIssueMarkers(marker, "zh-Hant")).toContain("欄位 C");
      // The legacy fallback text must never be echoed verbatim in another locale.
      expect(localizeServerIssueMarkers(marker, "zh-Hans")).not.toContain("欄位");
      const unknown = renderServerIssue("totally_unknown_code", { row: 1 });
      // R7-P3: the wire validation marker path returns the generic VALIDATION
      // message (not a formula error) for an unknown code — no code/params leak.
      expect(localizeServerIssueMarkers(unknown, "en")).toBe("Data validation failed");
      expect(localizeServerIssueMarkers(unknown, "zh-Hant")).toBe("資料驗證失敗");
      expect(localizeServerIssueMarkers(unknown, "zh-Hans")).toBe("数据验证失败");
    });

    it("R8-P1: Object.prototype keys (constructor/toString/__proto__) are NOT catalog codes", () => {
      const CJK = /[一-鿿]/;
      // A wire attacker (or a confused server) can send a key that happens to be
      // on Object.prototype. `in` would treat these as catalog members and
      // mislabel them as formula errors; the membership check must be own-property.
      for (const protoKey of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
        const marker = renderServerIssue(protoKey, { row: 1 });
        expect(marker).toContain(protoKey);
        // Must degrade to the generic DATA VALIDATION message, never a formula error.
        expect(localizeServerIssueMarkers(marker, "en")).toBe("Data validation failed");
        expect(localizeServerIssueMarkers(marker, "zh-Hant")).toBe("資料驗證失敗");
        expect(localizeServerIssueMarkers(marker, "zh-Hans")).toBe("数据验证失败");
        // No raw code, params, or legacy fallback text may leak.
        const en = localizeServerIssueMarkers(marker, "en");
        expect(en).not.toContain("FD_ISSUE");
        expect(en).not.toContain(protoKey);
        expect(en).not.toContain("{row}");
        expect(en).not.toMatch(CJK);
        const hant = localizeServerIssueMarkers(marker, "zh-Hant");
        expect(hant).not.toContain(protoKey);
        expect(hant).not.toContain("FD_ISSUE");
        const hans = localizeServerIssueMarkers(marker, "zh-Hans");
        expect(hans).not.toContain(protoKey);
        expect(hans).not.toContain("FD_ISSUE");
      }
    });

    it("R6-P1: validateTableFormulaDefinition returns structured params (row/column/reference)", () => {
      const issues = validateTableFormulaDefinition({
        tableColumns: 3,
        maxRows: 2,
        tableFormulaCells: [{ row: 0, column: 2, expression: "A+Z" }],
      });
      const unknown = issues.find(i => i.code === "table_formula_unknown_column");
      expect(unknown).toBeTruthy();
      expect(unknown!.params).toBeDefined();
      expect(unknown!.params.row).toBe(1);
      expect(unknown!.params.column).toBe("C");
      expect(unknown!.params.reference).toBe("Z");
      // The message must not itself carry the code; params drive localization.
      expect(unknown!.message).not.toContain("table_formula_unknown_column");
    });

    it("R6-P1: every wire code produced by the validate functions exists in the trilingual catalog", () => {
      const catalog = FORMULA_ISSUE_CATALOG as Record<string, unknown>;
      const formulaCodes = new Set<string>();
      const tableDefs: Array<Record<string, unknown>> = [
        {},
        { tableColumns: 40 },
        { maxRows: 200 },
        { tableFormulaCells: [[] as unknown as Record<string, unknown>] },
        { tableColumns: 3, maxRows: 2, tableFormulaCells: [{ row: 5, column: 2, expression: "A" }] },
        { tableColumns: 3, maxRows: 2, tableFormulaCells: [{ row: 0, column: 2, expression: "A+Z" }] },
        { tableColumns: 3, maxRows: 2, tableFormulaCells: [{ row: 0, column: 2, expression: "C" }] },
        { tableColumns: 3, maxRows: 2, tableFormulaCells: [{ row: 0, column: 1, expression: "C" }, { row: 0, column: 2, expression: "B" }] },
      ];
      for (const def of tableDefs) {
        for (const issue of validateTableFormulaDefinition(def, "zh-Hant")) {
          formulaCodes.add(issue.code);
        }
      }

      const fields: Array<{ stableFieldId: string; fieldType: string; definition?: unknown }> = [
        { stableFieldId: "req", fieldType: "text", definition: { label: "R", required: true } },
        { stableFieldId: "maxlen", fieldType: "text", definition: { label: "M", maxLength: 3 } },
        { stableFieldId: "num", fieldType: "number", definition: { label: "N", min: 1, max: 10 } },
        { stableFieldId: "date", fieldType: "date", definition: { label: "D" } },
        { stableFieldId: "time", fieldType: "time", definition: { label: "T" } },
        { stableFieldId: "email", fieldType: "text", definition: { label: "E", validation: "email" } },
        { stableFieldId: "phone", fieldType: "text", definition: { label: "P", validation: "phone" } },
        { stableFieldId: "regex", fieldType: "text", definition: { label: "Rx", regex: "\\d+" } },
        { stableFieldId: "sel", fieldType: "select", definition: { label: "S", options: ["a"] } },
        { stableFieldId: "chk", fieldType: "checkbox", definition: { label: "C", options: ["a"] } },
        { stableFieldId: "img", fieldType: "image", definition: { label: "I", maxFileSizeMb: 5 } },
        {
          stableFieldId: "tbl",
          fieldType: "table",
          definition: {
            tableColumns: 3, maxRows: 2,
            tableWritableCells: [{ row: 0, column: 0 }],
            tableFormulaCells: [{ row: 0, column: 2, expression: "A/B", decimalPlaces: 2 }],
          },
        },
      ];

      const valueSets: Array<Record<string, string>> = [
        {},
        { maxlen: "abcd" },
        { num: "abc" },
        { num: "100" },
        { date: "not-a-date" },
        { time: "25:00" },
        { email: "nope" },
        { phone: "x" },
        { regex: "abc" },
        { sel: "zzz" },
        { chk: "zzz" },
        { img: "plaintext" },
        { tbl: "[{},[\"x\",{}]]" },
        { tbl: JSON.stringify([["10", "0", ""], ["", "", ""]]) },
        { tbl: JSON.stringify(Array.from({ length: 5 }, () => ["", "", ""])) },
      ];

      const fieldCodes = new Set<string>();
      for (const values of valueSets) {
        for (const issue of validateFieldValues(values, fields as never)) {
          fieldCodes.add(issue.code);
        }
      }

      // Transport ambiguity / busy codes are produced by the repository layer but
      // must still map to a catalog entry so the client can localize them.
      const allCodes = new Set<string>([
        ...formulaCodes,
        ...fieldCodes,
        "v2_transport_unconfirmed",
        "v2_busy",
      ]);

      expect(allCodes.size).toBeGreaterThan(0);
      for (const code of allCodes) {
        expect(catalog[code], `wire code '${code}' must be present in FORMULA_ISSUE_CATALOG`).toBeTruthy();
      }
    });
  });
});
