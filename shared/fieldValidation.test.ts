import { describe, it, expect } from "vitest";
import { validateFieldValues, validateTemplateFields } from "./fieldValidation";

describe("shared/fieldValidation", () => {
  it("blocks output when table formula has evaluation errors (TBL-01)", () => {
    const fields = [
      {
        stableFieldId: "finance_table",
        fieldType: "table",
        definition: {
          label: "收支表",
          tableColumns: 3,
          maxRows: 3,
          tableWritableCells: [{ row: 0, column: 0 }, { row: 0, column: 1 }],
          tableFormulaCells: [{ row: 0, column: 2, expression: "A/B" }],
        },
      },
    ];

    // Division by zero in row 0, col 2 (A=10, B=0)
    const issues = validateFieldValues(
      {
        finance_table: JSON.stringify([
          ["10", "0", ""],
          ["", "", ""], // unused row: should NOT be an error
        ]),
      },
      fields
    );

    expect(issues.some(i => i.code === "table_formula" && i.blocking)).toBe(true);
    expect(issues.find(i => i.code === "table_formula")?.message).toContain("第 1 列 C 欄公式無法計算");
  });

  it("passes validation when all referenced inputs in unused row are blank (TBL-01)", () => {
    const fields = [
      {
        stableFieldId: "finance_table",
        fieldType: "table",
        definition: {
          label: "收支表",
          tableColumns: 3,
          maxRows: 3,
          tableWritableCells: [{ row: 0, column: 0 }, { row: 0, column: 1 }],
          tableFormulaCells: [{ row: 0, column: 2, expression: "A+B" }],
        },
      },
    ];

    const issues = validateFieldValues(
      {
        finance_table: JSON.stringify([
          ["10", "20", ""], // row 0: valid (A+B = 30)
          ["", "", ""],     // row 1: blank unused
          ["", "", ""],     // row 2: blank unused
        ]),
      },
      fields
    );

    expect(issues.filter(i => i.code === "table_formula")).toEqual([]);
  });

  it("blocks output when referenced cell contains invalid non-number string (TBL-01)", () => {
    const fields = [
      {
        stableFieldId: "finance_table",
        fieldType: "table",
        definition: {
          label: "收支表",
          tableColumns: 3,
          maxRows: 2,
          tableWritableCells: [{ row: 0, column: 0 }, { row: 0, column: 1 }],
          tableFormulaCells: [{ row: 0, column: 2, expression: "A+B" }],
        },
      },
    ];

    const issues = validateFieldValues(
      {
        finance_table: JSON.stringify([["invalid_num", "20", ""]]),
      },
      fields
    );

    expect(issues.some(i => i.code === "table_formula" && i.blocking)).toBe(true);
    expect(issues.find(i => i.code === "table_formula")?.message).toContain("非有效數字");
  });

  describe("validateTemplateFields (P1-B)", () => {
    it("blocks template publishing when formula expression is empty", () => {
      const fields = [
        {
          stableFieldId: "finance_table",
          fieldType: "table",
          definition: {
            label: "財務表",
            tableColumns: 3,
            maxRows: 2,
            tableFormulaCells: [{ row: 0, column: 1, expression: "" }],
          },
        },
      ];
      const issues = validateTemplateFields(fields);
      expect(issues.length).toBeGreaterThan(0);
      expect(issues.some(i => i.blocking && i.code === "table_formula_empty")).toBe(true);
    });

    it("blocks template publishing when decimalPlaces is 7 (> 6)", () => {
      const fields = [
        {
          stableFieldId: "finance_table",
          fieldType: "table",
          definition: {
            label: "財務表",
            tableColumns: 3,
            maxRows: 2,
            tableFormulaCells: [{ row: 0, column: 1, expression: "A+1", decimalPlaces: 7 }],
          },
        },
      ];
      const issues = validateTemplateFields(fields);
      expect(issues.length).toBeGreaterThan(0);
      expect(issues.some(i => i.blocking && i.code === "table_formula_decimal_places")).toBe(true);
    });

    it("blocks template publishing when formula has circular reference", () => {
      const fields = [
        {
          stableFieldId: "finance_table",
          fieldType: "table",
          definition: {
            label: "財務表",
            tableColumns: 3,
            maxRows: 2,
            tableFormulaCells: [
              { row: 0, column: 1, expression: "C+1" },
              { row: 0, column: 2, expression: "B+1" },
            ],
          },
        },
      ];
      const issues = validateTemplateFields(fields);
      expect(issues.length).toBeGreaterThan(0);
      expect(issues.some(i => i.blocking && i.code === "table_formula_circular_reference")).toBe(true);
    });

    it("passes template validation when all formulas are valid", () => {
      const fields = [
        {
          stableFieldId: "finance_table",
          fieldType: "table",
          definition: {
            label: "財務表",
            tableColumns: 3,
            maxRows: 2,
            tableFormulaCells: [
              { row: 0, column: 2, expression: "A+B", decimalPlaces: 2 },
            ],
          },
        },
      ];
      const issues = validateTemplateFields(fields);
      expect(issues.length).toBe(0);
    });

    it("blocks template publishing when tableColumns > 30 or maxRows > 100 (P1-D)", () => {
      const issuesCols = validateTemplateFields([
        {
          stableFieldId: "t1",
          fieldType: "table",
          definition: { label: "T1", tableColumns: 31, maxRows: 10 },
        },
      ]);
      expect(issuesCols.some(i => i.code === "table_columns_bounds" && i.blocking)).toBe(true);

      const issuesRows = validateTemplateFields([
        {
          stableFieldId: "t2",
          fieldType: "table",
          definition: { label: "T2", tableColumns: 3, maxRows: 101 },
        },
      ]);
      expect(issuesRows.some(i => i.code === "table_rows_bounds" && i.blocking)).toBe(true);
    });
  });

  describe("malformed raw table JSON validation (P1-D)", () => {
    const tableField = {
      stableFieldId: "finance_table",
      fieldType: "table",
      definition: {
        label: "收支表",
        tableColumns: 3,
        maxRows: 2,
        tableWritableCells: [{ row: 0, column: 0 }],
      },
    };

    it("blocks validation when row is not an array (object, number, null)", () => {
      const issuesObj = validateFieldValues({ finance_table: JSON.stringify([{}]) }, [tableField]);
      expect(issuesObj.some(i => i.blocking && i.code === "table_malformed_row")).toBe(true);

      const issuesNum = validateFieldValues({ finance_table: JSON.stringify([123]) }, [tableField]);
      expect(issuesNum.some(i => i.blocking && i.code === "table_malformed_row")).toBe(true);

      const issuesNull = validateFieldValues({ finance_table: JSON.stringify([null]) }, [tableField]);
      expect(issuesNull.some(i => i.blocking && i.code === "table_malformed_row")).toBe(true);
    });

    it("blocks validation when a cell inside a row is an object", () => {
      const issuesCell = validateFieldValues(
        { finance_table: JSON.stringify([[{}], [""]]) },
        [tableField]
      );
      expect(issuesCell.some(i => i.blocking && i.code === "table_malformed_cell")).toBe(true);
    });
  });
});
