import { millimetersToPercent, pageDimensions, percentToMillimeters, type PageManifestEntry } from "./page-geometry";
import type { FormField } from "./form-model";
import { normalizeFieldMark } from "@shared/fieldMark";
import {
  normalizeTableCellPositions,
  normalizeTableFormulaCells,
} from "@shared/tableFormula";

function detectedBoxes(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const box = item as Record<string, unknown>;
    const xRatio = Number(box.xRatio);
    const yRatio = Number(box.yRatio);
    const widthRatio = Number(box.widthRatio);
    const heightRatio = Number(box.heightRatio);
    if (![xRatio, yRatio, widthRatio, heightRatio].every(Number.isFinite)) return [];
    if (widthRatio <= 0 || heightRatio <= 0) return [];
    return [{ xRatio, yRatio, widthRatio, heightRatio }];
  });
}

function segmentCapacities(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const capacities = value.flatMap(item => {
    const count = Number(item);
    return Number.isInteger(count) && count > 0 ? [count] : [];
  });
  return capacities.length ? capacities : undefined;
}

function tableWritableCells(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  return normalizeTableCellPositions(value);
}

function tableFormulaCells(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const cells = normalizeTableFormulaCells(value, undefined, undefined, true);
  return cells.length ? cells : undefined;
}

function detectedOptionMarks(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const mark = item as Record<string, unknown>;
    const option = typeof mark.option === "string" ? mark.option : "";
    const boxes = detectedBoxes([mark]);
    return option && boxes[0] ? [{ option, ...boxes[0] }] : [];
  });
}

export type TemplateRecord = {
  id: string;
  name: string;
  description: string | null;
  lifecycle: "draft" | "published" | "archived";
  currentPublishedVersionId: string | null;
  currentDraftVersionId: string | null;
  folderIds: string[];
  tagIds: string[];
  favorite: boolean;
  pinned: boolean;
  printProfile: Record<string, unknown>;
  instanceNamePattern: string;
  keyFieldIds: string[];
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
};

export type VersionRecord = {
  id: string;
  templateId: string;
  versionNumber: number;
  state: "draft" | "published" | "superseded";
  contentHash: string;
  note: string | null;
  pageManifest: unknown;
  printSettings: unknown;
  publishedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type FieldRecord = { stableFieldId: string; fieldType: string; displayOrder: number; definition: unknown; coordinate: unknown };

export type InstanceRecord = {
  id: string;
  templateId: string;
  templateVersionId: string;
  templateVersionHash: string;
  name: string;
  status: "draft" | "completed" | "printed";
  values: Record<string, string>;
  printCount: number;
  outputHistory: Array<Record<string, unknown>>;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  lastPrintedAt: number | null;
};

export type FolderRecord = { id: string; name: string; parentId?: string | null };
export type TagRecord = { id: string; name: string; color: string };
export type SavedValueRecord = { id: string; templateId: string; stableFieldId: string; value: string; useCount?: number; lastUsedAt?: number | null };

export function pageManifestOf(value: unknown): PageManifestEntry[] {
  return Array.isArray(value) && value.length ? value as PageManifestEntry[] : [{ page: 1, widthMm: 210, heightMm: 297, rotation: 0 }];
}

export function toCanvasFields(persistedFields: FieldRecord[], pageManifest: unknown = []): FormField[] {
  return persistedFields.map((field) => {
    const definition = (field.definition ?? {}) as Record<string, unknown>;
    const coordinate = (field.coordinate ?? {}) as Record<string, unknown>;
    const page = Number(coordinate.page) || 1;
    const dimensions = pageDimensions(pageManifest, page);
    return {
      id: field.stableFieldId,
      label: String(definition.label || field.stableFieldId),
      type: field.fieldType as FormField["type"],
      status: definition.confirmed === false ? "needs-review" : definition.aiSuggested ? "suggested" : "confirmed",
      confirmed: definition.confirmed !== false,
      aiConfidence: typeof definition.aiConfidence === "number" ? definition.aiConfidence : undefined,
      page,
      pageWidthMm: dimensions.widthMm,
      pageHeightMm: dimensions.heightMm,
      required: Boolean(definition.required),
      placeholder: typeof definition.placeholder === "string" ? definition.placeholder : undefined,
      options: Array.isArray(definition.options) ? definition.options.map(String) : [],
      maxLength: typeof definition.maxLength === "number" ? definition.maxLength : undefined,
      fontSizePt: typeof definition.fontSizePt === "number" ? definition.fontSizePt : 10,
      align: definition.align === "center" || definition.align === "right" ? definition.align : "left",
      fontFamily: typeof definition.fontFamily === "string" ? definition.fontFamily : "Noto Sans TC",
      bold: Boolean(definition.bold),
      italic: Boolean(definition.italic),
      underline: Boolean(definition.underline),
      color: typeof definition.color === "string" ? definition.color : "#113d66",
      letterSpacingPt: typeof definition.letterSpacingPt === "number" ? definition.letterSpacingPt : 0,
      lineHeightPt: typeof definition.lineHeightPt === "number" ? definition.lineHeightPt : 12,
      overflow: ["block", "shrink", "warn", "wrap"].includes(String(definition.overflow)) ? definition.overflow as FormField["overflow"] : "warn",
      defaultValue: typeof definition.defaultValue === "string" ? definition.defaultValue : undefined,
      dynamicDefault: definition.dynamicDefault === "today" || definition.dynamicDefault === "now" ? definition.dynamicDefault : null,
      validation: ["email", "phone", "regex", "none"].includes(String(definition.validation)) ? definition.validation as FormField["validation"] : "none",
      regex: typeof definition.regex === "string" ? definition.regex : undefined,
      inputMode: definition.inputMode === "text" || definition.inputMode === "number" ? definition.inputMode : "any",
      dateFormat: ["yyyy-mm-dd", "dd-mm-yyyy", "mm-dd-yyyy"].includes(String(definition.dateFormat)) ? definition.dateFormat as FormField["dateFormat"] : "yyyy-mm-dd",
      timeFormat: definition.timeFormat === "hhmm" ? "hhmm" : "hh:mm",
      min: typeof definition.min === "number" ? definition.min : undefined,
      max: typeof definition.max === "number" ? definition.max : undefined,
      boxCount: typeof definition.boxCount === "number" ? definition.boxCount : 8,
      segmentCapacities: segmentCapacities(definition.segmentCapacities),
      maxRows: typeof definition.maxRows === "number" ? definition.maxRows : 3,
      tableColumns: typeof definition.tableColumns === "number" ? definition.tableColumns : undefined,
      tableWritableCells: tableWritableCells(definition.tableWritableCells),
      tableFormulaCells: tableFormulaCells(definition.tableFormulaCells),
      tableFormulaSchemaVersion: Number(definition.tableFormulaSchemaVersion) === 2 ? 2 : undefined,
      tableCellGuides: detectedBoxes(definition.tableCellGuides),
      detectionSource: typeof definition.detectionSource === "string" ? definition.detectionSource : undefined,
      detectionGroup: detectedBoxes(definition.detectionGroup),
      optionMarks: detectedOptionMarks(definition.optionMarks),
      maxFileSizeMb: typeof definition.maxFileSizeMb === "number" ? definition.maxFileSizeMb : 10,
      allowedMimeTypes: Array.isArray(definition.allowedMimeTypes) ? definition.allowedMimeTypes.map(String) : ["image/png", "image/jpeg"],
      imageFit: ["contain", "cover", "stretch"].includes(String(definition.imageFit)) ? definition.imageFit as FormField["imageFit"] : "contain",
      signatureMode: ["draw", "upload", "text", "all"].includes(String(definition.signatureMode)) ? definition.signatureMode as FormField["signatureMode"] : "all",
      markStyle: normalizeFieldMark(definition.markStyle),
      zIndex: typeof definition.zIndex === "number" ? definition.zIndex : field.displayOrder + 1,
      x: millimetersToPercent(Number(coordinate.xMm) || 0, dimensions.widthMm),
      y: millimetersToPercent(Number(coordinate.yMm) || 0, dimensions.heightMm),
      width: millimetersToPercent(Number(coordinate.widthMm) || 30, dimensions.widthMm),
      height: millimetersToPercent(Number(coordinate.heightMm) || 7, dimensions.heightMm),
    };
  });
}

export function serializeCanvasFields(fields: FormField[], pageManifest: unknown) {
  return fields.map((field, displayOrder) => {
    const dimensions = pageDimensions(pageManifest, field.page ?? 1);
    return {
      stableFieldId: field.id,
      fieldType: field.type,
      displayOrder,
      definition: {
        label: field.label,
        confirmed: field.confirmed !== false && field.status === "confirmed",
        aiSuggested: field.status === "suggested",
        aiConfidence: field.aiConfidence ?? null,
        required: Boolean(field.required),
        placeholder: field.placeholder ?? null,
        options: field.options ?? [],
        maxLength: field.maxLength ?? null,
        fontSizePt: field.fontSizePt ?? 10,
        align: field.align ?? "left",
        fontFamily: field.fontFamily ?? "Noto Sans TC",
        bold: Boolean(field.bold),
        italic: Boolean(field.italic),
        underline: Boolean(field.underline),
        color: field.color ?? "#113d66",
        letterSpacingPt: field.letterSpacingPt ?? 0,
        lineHeightPt: field.lineHeightPt ?? 12,
        overflow: field.overflow ?? "warn",
        defaultValue: field.defaultValue ?? null,
        dynamicDefault: field.dynamicDefault ?? null,
        validation: field.validation ?? "none",
        regex: field.regex ?? null,
        inputMode: field.inputMode ?? "any",
        dateFormat: field.dateFormat ?? "yyyy-mm-dd",
        timeFormat: field.timeFormat ?? "hh:mm",
        min: field.min ?? null,
        max: field.max ?? null,
        boxCount: field.boxCount ?? 8,
        segmentCapacities: field.segmentCapacities ?? null,
        maxRows: field.maxRows ?? 3,
        tableColumns: field.tableColumns ?? null,
        tableWritableCells: Array.isArray(field.tableWritableCells)
          ? normalizeTableCellPositions(field.tableWritableCells)
          : null,
        tableFormulaCells: Array.isArray(field.tableFormulaCells) && field.tableFormulaCells.length > 0
          ? normalizeTableFormulaCells(field.tableFormulaCells, undefined, undefined, true)
          : null,
        ...(field.tableFormulaSchemaVersion === 2 ? { tableFormulaSchemaVersion: 2 } : {}),
        tableCellGuides: field.tableCellGuides ?? [],
        detectionSource: field.detectionSource ?? null,
        detectionGroup: field.detectionGroup ?? [],
        optionMarks: field.optionMarks ?? [],
        maxFileSizeMb: field.maxFileSizeMb ?? 10,
        allowedMimeTypes: field.allowedMimeTypes ?? ["image/png", "image/jpeg"],
        imageFit: field.imageFit ?? "contain",
        signatureMode: field.signatureMode ?? "all",
        markStyle: normalizeFieldMark(field.markStyle),
        zIndex: field.zIndex ?? displayOrder + 1,
      },
      coordinate: {
        page: field.page ?? 1,
        xMm: percentToMillimeters(field.x, dimensions.widthMm),
        yMm: percentToMillimeters(field.y, dimensions.heightMm),
        widthMm: percentToMillimeters(field.width, dimensions.widthMm),
        heightMm: percentToMillimeters(field.height, dimensions.heightMm),
        fontSizePt: field.fontSizePt ?? 10,
        align: field.align ?? "left",
      },
    };
  });
}

export function createEmptyField(page: number, pageManifest: unknown, index: number): FormField {
  const dimensions = pageDimensions(pageManifest, page);
  return {
    id: `field-${crypto.randomUUID().slice(0, 8)}`,
    label: "",
    type: "text",
    status: "needs-review",
    confirmed: false,
    page,
    pageWidthMm: dimensions.widthMm,
    pageHeightMm: dimensions.heightMm,
    x: 8 + (index % 5) * 3,
    y: 8 + (index % 8) * 3,
    width: 24,
    height: 3.5,
    options: [],
    fontSizePt: 10,
    align: "left",
    color: "#113d66",
    overflow: "warn",
    inputMode: "any",
    dateFormat: "yyyy-mm-dd",
    timeFormat: "hh:mm",
    boxCount: 8,
    maxRows: 3,
    maxFileSizeMb: 10,
    allowedMimeTypes: ["image/png", "image/jpeg"],
    imageFit: "contain",
    signatureMode: "all",
    zIndex: index + 1,
  };
}
