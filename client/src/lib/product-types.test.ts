import { describe, expect, it } from "vitest";
import { cleanCharacterBoxes, remapDetectedOptionMarks } from "./form-model";
import { serializeCanvasFields, toCanvasFields, type FieldRecord } from "./product-types";

describe("advanced detected field metadata", () => {
  it("keeps a circle choice and its A/B/C/D positions through Draft load and save", () => {
    const optionMarks = ["A", "B", "C", "D"].map((option, index) => ({
      option,
      xRatio: (index + 0.25) / 4,
      yRatio: 0,
      widthRatio: 0.125,
      heightRatio: 1,
    }));
    const pages = [{ page: 1, widthMm: 210, heightMm: 297 }];
    const fields = toCanvasFields([{
      stableFieldId: "choice",
      fieldType: "radio",
      displayOrder: 0,
      definition: { label: "Choice", options: ["A", "B", "C", "D"], markStyle: "circle", optionMarks },
      coordinate: { page: 1, xMm: 20, yMm: 30, widthMm: 60, heightMm: 8 },
    }], pages);
    expect(fields[0]!.markStyle).toBe("circle");
    expect(serializeCanvasFields(fields, pages)[0]!.definition).toMatchObject({
      markStyle: "circle",
      optionMarks,
    });
  });

  it("preserves relative detected geometry through editor load and save", () => {
    const persisted: FieldRecord[] = [{
      stableFieldId: "gender",
      fieldType: "radio",
      displayOrder: 0,
      definition: {
        label: "Gender",
        options: ["Male", "Female"],
        detectionSource: "local-structure:radio",
        detectionGroup: [
          { xRatio: 0, yRatio: 0, widthRatio: 0.1, heightRatio: 1 },
          { xRatio: 0.8, yRatio: 0, widthRatio: 0.1, heightRatio: 1 },
        ],
        optionMarks: [
          { option: "Male", xRatio: 0, yRatio: 0, widthRatio: 0.1, heightRatio: 1 },
          { option: "Female", xRatio: 0.8, yRatio: 0, widthRatio: 0.1, heightRatio: 1 },
        ],
      },
      coordinate: { page: 1, xMm: 20, yMm: 30, widthMm: 100, heightMm: 10 },
    }];
    const pages = [{ page: 1, widthMm: 210, heightMm: 297 }];

    const fields = toCanvasFields(persisted, pages);
    fields[0]!.x += 5;
    const serialized = serializeCanvasFields(fields, pages)[0]!;

    expect(serialized.definition).toMatchObject({
      detectionSource: "local-structure:radio",
      detectionGroup: persisted[0]!.definition && (persisted[0]!.definition as Record<string, unknown>).detectionGroup,
      optionMarks: persisted[0]!.definition && (persisted[0]!.definition as Record<string, unknown>).optionMarks,
    });
    expect(serialized.coordinate.xMm).toBeCloseTo(30.5, 6);
  });

  it("carries per-cell table positions through editor load and save", () => {
    const tableCellGuides = [
      { xRatio: 0, yRatio: 0.2, widthRatio: 0.5, heightRatio: 0.4 },
      { xRatio: 0.55, yRatio: 0.2, widthRatio: 0.4, heightRatio: 0.4 },
      { xRatio: 0, yRatio: 0.6, widthRatio: 0.5, heightRatio: 0.4 },
      { xRatio: 0.55, yRatio: 0.6, widthRatio: 0.4, heightRatio: 0.4 },
    ];
    const persisted: FieldRecord[] = [{
      stableFieldId: "goods",
      fieldType: "table",
      displayOrder: 0,
      definition: {
        label: "Goods",
        tableColumns: 2,
        maxRows: 2,
        detectionSource: "local-structure:table",
        tableCellGuides,
      },
      coordinate: { page: 1, xMm: 20, yMm: 30, widthMm: 100, heightMm: 20 },
    }];
    const pages = [{ page: 1, widthMm: 210, heightMm: 297 }];

    const fields = toCanvasFields(persisted, pages);
    expect(fields[0]!.tableCellGuides).toEqual(tableCellGuides);
    expect(
      serializeCanvasFields(fields, pages)[0]!.definition
    ).toMatchObject({ tableCellGuides });
  });

  it("leaves a table saved before per-cell positions existed without any", () => {
    const fields = toCanvasFields(
      [{
        stableFieldId: "goods",
        fieldType: "table",
        displayOrder: 0,
        definition: { label: "Goods", tableColumns: 2, maxRows: 2 },
        coordinate: { page: 1, xMm: 20, yMm: 30, widthMm: 100, heightMm: 20 },
      }],
      [{ page: 1, widthMm: 210, heightMm: 297 }]
    );
    expect(fields[0]!.tableCellGuides).toEqual([]);
  });

  it("does not impose an eight-character limit before the configured box count", () => {
    expect(cleanCharacterBoxes("AB-12 34CD56")).toBe("AB1234CD56");
  });

  it("keeps detected radio marks attached when users correct option labels", () => {
    expect(
      remapDetectedOptionMarks(
        [
          { option: "Male", xRatio: 0, yRatio: 0, widthRatio: 0.1, heightRatio: 1 },
          { option: "Female", xRatio: 0.8, yRatio: 0, widthRatio: 0.1, heightRatio: 1 },
        ],
        ["男", "女"]
      )
    ).toEqual([
      { option: "男", xRatio: 0, yRatio: 0, widthRatio: 0.1, heightRatio: 1 },
      { option: "女", xRatio: 0.8, yRatio: 0, widthRatio: 0.1, heightRatio: 1 },
    ]);
  });
  it("round-trips segment capacities and writable table cells through editor save", () => {
    const pages = [{ page: 1, widthMm: 210, heightMm: 297 }];
    const persisted: FieldRecord[] = [
      {
        stableFieldId: "dob",
        fieldType: "characterBox",
        displayOrder: 0,
        definition: {
          label: "出生日期",
          boxCount: 8,
          maxLength: 8,
          segmentCapacities: [2, 2, 4],
          detectionGroup: Array.from({ length: 8 }, (_, index) => ({
            xRatio: index / 8,
            yRatio: 0,
            widthRatio: 1 / 8,
            heightRatio: 1,
          })),
        },
        coordinate: { page: 1, xMm: 20, yMm: 30, widthMm: 80, heightMm: 8 },
      },
      {
        stableFieldId: "grid",
        fieldType: "table",
        displayOrder: 1,
        definition: {
          label: "Grid",
          tableColumns: 3,
          maxRows: 3,
          tableWritableCells: [
            { row: 2, column: 2 },
            { row: 2, column: 2 },
            { row: -1, column: 0 },
            { row: 0, column: "x" },
          ],
        },
        coordinate: { page: 1, xMm: 20, yMm: 60, widthMm: 90, heightMm: 30 },
      },
    ];

    const fields = toCanvasFields(persisted, pages);
    expect(fields[0]!.segmentCapacities).toEqual([2, 2, 4]);
    expect(fields[0]!.boxCount).toBe(8);
    expect(fields[1]!.tableWritableCells).toEqual([{ row: 2, column: 2 }]);

    const serialized = serializeCanvasFields(fields, pages);
    expect(serialized[0]!.definition.segmentCapacities).toEqual([2, 2, 4]);
    expect(serialized[1]!.definition.tableWritableCells).toEqual([
      { row: 2, column: 2 },
    ]);
  });

  it("leaves older templates without a writable-cell mask fully fillable", () => {
    const pages = [{ page: 1, widthMm: 210, heightMm: 297 }];
    const [field] = toCanvasFields(
      [
        {
          stableFieldId: "grid",
          fieldType: "table",
          displayOrder: 0,
          definition: { label: "Grid", tableColumns: 2, maxRows: 2 },
          coordinate: { page: 1, xMm: 20, yMm: 60, widthMm: 90, heightMm: 30 },
        },
      ],
      pages
    );

    expect(field!.tableWritableCells).toBeUndefined();
    expect(field!.segmentCapacities).toBeUndefined();
    expect(
      serializeCanvasFields([field!], pages)[0]!.definition.tableWritableCells
    ).toBeNull();
  });

  it("preserves explicit empty tableWritableCells [] without reviving as undefined (TBL-01)", () => {
    const pages = [{ page: 1, widthMm: 210, heightMm: 297 }];
    const persisted = [
      {
        stableFieldId: "locked_grid",
        fieldType: "table",
        displayOrder: 0,
        definition: {
          label: "Locked Grid",
          tableColumns: 2,
          maxRows: 2,
          tableWritableCells: [],
        },
        coordinate: { page: 1, xMm: 10, yMm: 10, widthMm: 50, heightMm: 20 },
      },
    ];

    const fields = toCanvasFields(persisted, pages);
    expect(fields[0]!.tableWritableCells).toEqual([]);

    const serialized = serializeCanvasFields(fields, pages);
    expect(serialized[0]!.definition.tableWritableCells).toEqual([]);
  });

  it("preserves and normalizes tableFormulaCells in table fields (TBL-01)", () => {
    const pages = [{ page: 1, widthMm: 210, heightMm: 297 }];
    const persisted = [
      {
        stableFieldId: "formula_grid",
        fieldType: "table",
        displayOrder: 0,
        definition: {
          label: "Formula Grid",
          tableColumns: 3,
          maxRows: 2,
          tableFormulaCells: [
            { row: 0, column: 2, expression: "=A+B", decimalPlaces: 2 },
            { row: 1, column: 2, expression: "A*B", decimalPlaces: 0 },
          ],
        },
        coordinate: { page: 1, xMm: 10, yMm: 10, widthMm: 50, heightMm: 20 },
      },
    ];

    const fields = toCanvasFields(persisted, pages);
    expect(fields[0]!.tableFormulaCells).toEqual([
      { row: 0, column: 2, expression: "=A+B", decimalPlaces: 2 },
      { row: 1, column: 2, expression: "A*B", decimalPlaces: 0 },
    ]);

    const serialized = serializeCanvasFields(fields, pages);
    expect(serialized[0]!.definition.tableFormulaCells).toEqual([
      { row: 0, column: 2, expression: "=A+B", decimalPlaces: 2 },
      { row: 1, column: 2, expression: "A*B", decimalPlaces: 0 },
    ]);
  });

  it("preserves draft tableFormulaCells with empty expression through load and save (P1-B)", () => {
    const pages = [{ page: 1, widthMm: 210, heightMm: 297 }];
    const persisted = [
      {
        stableFieldId: "formula_draft",
        fieldType: "table",
        displayOrder: 0,
        definition: {
          label: "Formula Draft",
          tableColumns: 3,
          maxRows: 2,
          tableFormulaCells: [
            { row: 0, column: 1, expression: "" },
          ],
        },
        coordinate: { page: 1, xMm: 10, yMm: 10, widthMm: 50, heightMm: 20 },
      },
    ];

    const fields = toCanvasFields(persisted, pages);
    expect(fields[0]!.tableFormulaCells).toEqual([
      { row: 0, column: 1, expression: "" },
    ]);

    const serialized = serializeCanvasFields(fields, pages);
    expect(serialized[0]!.definition.tableFormulaCells).toEqual([
      { row: 0, column: 1, expression: "" },
    ]);
  });

  it("omits the formula schema marker for legacy fields and persists version 2 explicitly", () => {
    const pages = [{ page: 1, widthMm: 210, heightMm: 297 }];
    const base = {
      stableFieldId: "legacy_formula",
      fieldType: "table",
      displayOrder: 0,
      definition: { label: "Legacy", tableColumns: 2, maxRows: 2 },
      coordinate: { page: 1, xMm: 10, yMm: 10, widthMm: 50, heightMm: 20 },
    };
    const legacy = serializeCanvasFields(toCanvasFields([base], pages), pages)[0]!.definition;
    expect(Object.prototype.hasOwnProperty.call(legacy, "tableFormulaSchemaVersion")).toBe(false);

    const version2Record = {
      ...base,
      stableFieldId: "aggregate_formula",
      definition: { ...base.definition, tableFormulaSchemaVersion: 2 },
    };
    const version2 = serializeCanvasFields(toCanvasFields([version2Record], pages), pages)[0]!.definition;
    expect(version2.tableFormulaSchemaVersion).toBe(2);
  });
});
