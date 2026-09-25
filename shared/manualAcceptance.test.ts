import { describe, expect, it } from "vitest";
import { selectedCheckboxOptions } from "./checkboxSelection";
import { validateFieldValues } from "./fieldValidation";
import { resolveEffectiveTableGrid, validateTableFormulaDefinition } from "./tableFormula";
import { validateValues, type FormField } from "../client/src/lib/form-model";
import { PDFDocument } from "pdf-lib";
import { renderVersionPdf } from "../server/formdigital/pdfRenderer";

describe("regressions found during full manual acceptance", () => {
  const single = { stableFieldId: "consent", fieldType: "checkbox", definition: { label: "Consent", options: ["Agree"] } };

  it("accepts old one-option checkbox booleans and keeps canonical option values", () => {
    for (const value of ["checked", "true", "1", "Agree"]) {
      expect(validateFieldValues({ consent: value }, [single])).toEqual([]);
      expect(selectedCheckboxOptions(value, ["Agree"])).toEqual(["Agree"]);
    }
    for (const value of ["", "false", "0", "no"]) {
      expect(validateFieldValues({ consent: value }, [single])).toEqual([]);
      expect(selectedCheckboxOptions(value, ["Agree"])).toEqual([]);
    }
  });

  it("does not turn arbitrary or multi-option booleans into valid selections", () => {
    expect(validateFieldValues({ consent: "foreign" }, [single])).toHaveLength(1);
    expect(validateFieldValues({ consent: "checked" }, [{ ...single, definition: { options: ["A", "B"] } }])).toHaveLength(1);
  });

  it("shows invalid option and numeric-only values before attempting server export", () => {
    const fields = [
      { id: "choice", label: "Choice", type: "checkbox", options: ["A", "B"] },
      { id: "numeric", label: "Number", type: "text", inputMode: "number" },
    ] as FormField[];
    expect(validateValues({ choice: "foreign", numeric: "abc" }, fields)).toHaveLength(2);
    expect(validateValues({ choice: "A", numeric: "123" }, fields)).toEqual([]);
  });

  it("rejects same-row arithmetic depending on later SUM totals instead of returning a silent blank", () => {
    const definition = {
      tableFormulaSchemaVersion: 2,
      tableColumns: 3,
      maxRows: 3,
      tableFormulaCells: [
        { row: 2, column: 0, expression: "SUM(A1:A2)" },
        { row: 2, column: 1, expression: "SUM(B1:B2)" },
        { row: 2, column: 2, expression: "A+B" },
      ],
    };
    expect(validateTableFormulaDefinition(definition).some(i => i.code === "table_formula_aggregate_dependency")).toBe(true);
    const grid = resolveEffectiveTableGrid(definition, JSON.stringify([["100", "-20", ""], ["100", "-20", ""], ["", "", ""]]));
    expect(grid.hasErrors).toBe(true);
    expect(grid.errors.some(e => e.code === "AGGREGATE_DEPENDENCY")).toBe(true);
  });

  it.each(["checked", "Agree"])("exports a single named checkbox as checked for %s", async value => {
    const background = await PDFDocument.create();
    background.addPage([595.28, 841.89]);
    const source = await background.save();
    const bytes = await renderVersionPdf({
      mode: "editable",
      pages: [{ page: 1, widthMm: 210, heightMm: 297, assetId: "synthetic-source" }],
      fields: [{ ...single, coordinate: { page: 1, xMm: 20, yMm: 20, widthMm: 5, heightMm: 5 } }],
      values: { consent: value },
      loadSource: async () => ({ mimeType: "application/pdf", bytes: source }),
    });
    const doc = await PDFDocument.load(bytes);
    const field = doc.getForm().getFields()[0];
    expect(doc.getForm().getCheckBox(field.getName()).isChecked()).toBe(true);
  });
});
