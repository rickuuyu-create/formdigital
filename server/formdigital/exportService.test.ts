import { describe, it, expect } from "vitest";
import { formatExportFieldValue } from "./exportService";

describe("server/formdigital/exportService", () => {
  it("formats table field value with calculated formulas and excludes fixed cell residuals (TBL-01)", () => {
    const rawValue = JSON.stringify([
      ["12", "34", "stale_residual_formula"],
      ["stale_1", "stale_2", "stale_3"],
    ]);
    const definition = {
      label: "收支總表",
      tableColumns: 3,
      maxRows: 2,
      tableWritableCells: [{ row: 0, column: 0 }, { row: 0, column: 1 }],
      tableFormulaCells: [{ row: 0, column: 2, expression: "A+B", decimalPlaces: 2 }],
    };

    const formatted = formatExportFieldValue(rawValue, "table", definition);
    const parsed = JSON.parse(formatted);

    // Row 0: "12", "34", "46.00"
    expect(parsed[0][0]).toBe("12");
    expect(parsed[0][1]).toBe("34");
    expect(parsed[0][2]).toBe("46.00");

    // Row 1: fixed cells cleared
    expect(parsed[1][0]).toBe("");
    expect(parsed[1][1]).toBe("");
    expect(parsed[1][2]).toBe("");
  });
});
