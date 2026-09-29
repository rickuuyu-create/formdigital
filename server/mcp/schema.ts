import { z } from "zod";

export const fieldTypes = [
  "text",
  "textarea",
  "number",
  "date",
  "time",
  "select",
  "radio",
  "checkbox",
  "characterBox",
  "table",
  "image",
  "signature",
] as const;
const scalar = z.number().finite();
const cell = z.object({
  row: z.number().int().nonnegative(),
  column: z.number().int().nonnegative(),
});
const box = z.object({
  xRatio: scalar.min(0).max(1),
  yRatio: scalar.min(0).max(1),
  widthRatio: scalar.positive().max(1),
  heightRatio: scalar.positive().max(1),
});
export const fieldSchema = z
  .object({
    stableFieldId: z.string().regex(/^[a-z][a-z0-9-]{0,127}$/i),
    fieldType: z.enum(fieldTypes),
    displayOrder: z.number().int().nonnegative(),
    definition: z
      .object({
        label: z.string().max(500),
        confirmed: z.boolean().default(false),
        required: z.boolean().default(false),
        aiSuggested: z.boolean().optional(),
        aiConfidence: scalar.optional(),
        options: z.array(z.string().max(500)).max(500).optional(),
        maxLength: z.number().int().positive().max(10000).optional(),
        fontSizePt: scalar.positive().max(144).optional(),
        align: z.enum(["left", "center", "right"]).optional(),
        fontFamily: z.string().max(80).optional(),
        bold: z.boolean().optional(),
        italic: z.boolean().optional(),
        underline: z.boolean().optional(),
        color: z
          .string()
          .regex(/^#[0-9a-f]{6}$/i)
          .optional(),
        letterSpacingPt: scalar.min(-5).max(40).optional(),
        lineHeightPt: scalar.positive().max(200).optional(),
        overflow: z.enum(["warn", "wrap", "shrink", "block"]).optional(),
        defaultValue: z.string().max(10000).optional(),
        dynamicDefault: z.enum(["today", "now"]).nullable().optional(),
        validation: z.enum(["email", "phone", "regex", "none"]).optional(),
        regex: z.string().max(500).optional(),
        inputMode: z.string().max(30).optional(),
        dateFormat: z.string().max(40).optional(),
        timeFormat: z.string().max(40).optional(),
        min: scalar.optional(),
        max: scalar.optional(),
        boxCount: z.number().int().positive().max(500).optional(),
        segmentCapacities: z
          .array(z.number().int().positive())
          .max(100)
          .optional(),
        maxRows: z.number().int().positive().max(500).optional(),
        tableColumns: z.number().int().positive().max(100).optional(),
        tableWritableCells: z.array(cell).max(10000).optional(),
        tableFormulaCells: z
          .array(
            cell.extend({
              expression: z.string().max(2000),
              decimalPlaces: z.number().int().min(0).max(6).optional(),
            })
          )
          .max(10000)
          .optional(),
        tableFormulaSchemaVersion: z.literal(2).optional(),
        tableCellGuides: z.array(box).max(10000).optional(),
        detectionSource: z.string().max(80).optional(),
        detectionGroup: z.array(box).max(500).optional(),
        optionMarks: z
          .array(box.extend({ option: z.string().max(500) }))
          .max(500)
          .optional(),
        maxFileSizeMb: scalar.positive().max(100).optional(),
        allowedMimeTypes: z.array(z.string().max(120)).max(10).optional(),
        imageFit: z.enum(["contain", "cover", "stretch"]).optional(),
        signatureMode: z.string().max(30).optional(),
        markStyle: z.enum(["check", "cross", "dot", "circle"]).optional(),
        zIndex: z.number().int().optional(),
      })
      .strict(),
    coordinate: z
      .object({
        page: z.number().int().positive(),
        xMm: scalar.nonnegative(),
        yMm: scalar.nonnegative(),
        widthMm: scalar.positive(),
        heightMm: scalar.positive(),
        fontSizePt: scalar.positive().optional(),
        align: z.enum(["left", "center", "right"]).optional(),
      })
      .strict(),
  })
  .strict();
export const expectedSchema = z
  .array(
    z.object({
      collection: z.enum([
        "templates",
        "templateVersions",
        "instances",
        "folders",
        "tags",
        "savedValues",
        "mappingTemplates",
      ]),
      id: z.string().min(1),
      hash: z.string().length(64),
    })
  )
  .max(5000);
export const writeMeta = {
  operationKey: z.string().min(8).max(128),
  expected: expectedSchema.default([]),
};
export const pageSchema = z.object({
  widthMm: scalar.min(50).max(1000).default(210),
  heightMm: scalar.min(50).max(1000).default(297),
  title: z.string().max(150).default(""),
  texts: z
    .array(
      z.object({
        text: z.string().max(1000),
        xMm: scalar.nonnegative(),
        yMm: scalar.nonnegative(),
        fontSizePt: scalar.min(5).max(60).default(10),
      })
    )
    .max(200)
    .default([]),
});
export const designSchema = z.object({
  name: z.string().min(1).max(255),
  pages: z.array(pageSchema).min(1).max(50),
  fields: z.array(fieldSchema).max(5000),
});
