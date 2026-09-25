import catalog from "./template-practice-catalog.json";
import type {
  FormField,
  DetectedFieldBox,
  DetectedOptionMark,
} from "./form-model";
import {
  resolveTableGridRoles,
  validateTableFormulaDefinition,
} from "@shared/tableFormula";

export const PRACTICE_DESCRIPTION =
  "[Formdigital practice v1] 範本建立綜合練習 / Template building practice";
export const PRACTICE_PDF = "/practice/template-practice-v1.pdf";

// Table editors serialize empty rows on mount; JSON alone is not a filled value.
export function hasPracticeInput(type: FormField["type"], value: string): boolean {
  if (type !== "table") return Boolean(value.trim());
  try {
    const rows: unknown = JSON.parse(value);
    return Array.isArray(rows) && rows.some(row => Array.isArray(row) &&
      row.some(cell => (typeof cell === "string" || typeof cell === "number") && String(cell).trim() !== ""));
  } catch {
    return false;
  }
}
export type PracticeLesson = {
  id: string;
  page: number;
  type: FormField["type"];
  title: [string, string];
  sample: string;
  box: { x: number; y: number; width: number; height: number };
  settings: Partial<FormField>;
  marks?: DetectedOptionMark[];
  cells?: DetectedFieldBox[];
  segments?: DetectedFieldBox[];
  widths?: number[];
  heights?: number[];
};
export const practiceLessons = catalog as unknown as PracticeLesson[];
export const isPracticeTemplate = (description: unknown) =>
  description === PRACTICE_DESCRIPTION;
export function practiceField(lesson: PracticeLesson): FormField {
  const b = lesson.box;
  return {
    id: `field-${crypto.randomUUID()}`,
    label: `${lesson.id} ${lesson.title[0]}`,
    type: "text",
    page: lesson.page,
    x: (b.x / 210) * 100,
    y: (b.y / 297) * 100,
    width: (b.width / 210) * 100,
    height: (b.height / 297) * 100,
    pageWidthMm: 210,
    pageHeightMm: 297,
    status: "needs-review",
    confirmed: false,
    fontSizePt: 10,
    // This explicit frame action also supplies the approved segmented geometry.
    // It does not mark a field reviewed or apply the remaining lesson settings.
    ...(lesson.segments
      ? {
          type: "characterBox",
          detectionGroup: lesson.segments,
          segmentCapacities: [2, 2, 4],
          boxCount: 8,
        }
      : {}),
  };
}
export const matchingPracticeFields = (
  lesson: PracticeLesson,
  fields: FormField[]
) => fields.filter(f => new RegExp(`^${lesson.id}(?:\\s|$)`).test(f.label));
export type PracticeCheck = { key: string; ok: boolean };
const finiteNear = (a: number, b: number, tolerance: number) =>
  Number.isFinite(a) && Math.abs(a - b) <= tolerance;
function geometry(
  field: FormField,
  actual: DetectedFieldBox | undefined,
  expected: DetectedFieldBox
) {
  if (!actual) return false;
  return (
    finiteNear(
      (((actual.xRatio - expected.xRatio) * field.width) / 100) * 210,
      0,
      1.6
    ) &&
    finiteNear(
      (((actual.yRatio - expected.yRatio) * field.height) / 100) * 297,
      0,
      1.6
    ) &&
    finiteNear(
      (((actual.widthRatio - expected.widthRatio) * field.width) / 100) * 210,
      0,
      2
    ) &&
    finiteNear(
      (((actual.heightRatio - expected.heightRatio) * field.height) / 100) *
        297,
      0,
      2
    )
  );
}
// Match the values displayed by Field settings when older/new fields omit them.
const practiceDefaults: Partial<FormField> = {
  dateFormat: "yyyy-mm-dd", timeFormat: "hh:mm", imageFit: "contain",
  signatureMode: "all", align: "left", inputMode: "any", overflow: "warn",
  validation: "none", markStyle: "check", options: [], boxCount: 8,
};
export function checkPracticeLesson(
  lesson: PracticeLesson,
  fields: FormField[]
) {
  const matches = matchingPracticeFields(lesson, fields),
    field = matches[0];
  const checks: PracticeCheck[] = [{ key: "exists", ok: matches.length === 1 }];
  if (!field) return { field, checks, complete: false };
  checks.push({ key: "page", ok: field.page === lesson.page });
  checks.push({ key: "type", ok: field.type === lesson.type });
  const b = lesson.box;
  checks.push({
    key: "position",
    ok:
      finiteNear((field.x / 100) * 210, b.x, 2) &&
      finiteNear((field.y / 100) * 297, b.y, 2) &&
      finiteNear((field.width / 100) * 210, b.width, 2) &&
      finiteNear((field.height / 100) * 297, b.height, 2),
  });
  for (const [key, value] of Object.entries(lesson.settings)) {
    if (["tableWritableCells", "tableFormulaCells"].includes(key)) continue;
    checks.push({
      key,
      ok:
        JSON.stringify(field[key as keyof FormField] ?? practiceDefaults[key as keyof FormField]) === JSON.stringify(value),
    });
  }
  if (lesson.marks)
    checks.push({
      key: "marks",
      ok:
        field.optionMarks?.length === lesson.marks.length &&
        lesson.marks.every(
          (m, i) =>
            field.optionMarks?.[i]?.option === m.option &&
            geometry(field, field.optionMarks?.[i], m)
        ),
    });
  if (lesson.segments)
    checks.push({
      key: "segments",
      ok:
        field.detectionGroup?.length === lesson.segments.length &&
        lesson.segments.every((g, i) =>
          geometry(field, field.detectionGroup?.[i], g)
        ),
    });
  if (lesson.cells) {
    checks.push({
      key: "cells",
      ok:
        field.tableCellGuides?.length === lesson.cells.length &&
        lesson.cells.every((g, i) =>
          geometry(field, field.tableCellGuides?.[i], g)
        ),
    });
    const rows = lesson.settings.maxRows!,
      cols = lesson.settings.tableColumns!;
    const roles = resolveTableGridRoles(field, rows, cols),
      expected = resolveTableGridRoles(lesson.settings, rows, cols);
    checks.push({
      key: "roles",
      ok: lesson.cells.every(
        (_, i) =>
          roles.getRole(Math.floor(i / cols), i % cols) ===
          expected.getRole(Math.floor(i / cols), i % cols)
      ),
    });
    checks.push({
      key: "formulas",
      ok:
        validateTableFormulaDefinition(field).length === 0 &&
        (field.tableFormulaCells?.length ?? 0) ===
          (lesson.settings.tableFormulaCells?.length ?? 0) &&
        (lesson.settings.tableFormulaCells ?? []).every(e =>
          field.tableFormulaCells?.some(
            a =>
              a.row === e.row &&
              a.column === e.column &&
              a.expression.replace(/\s|^=/g, "").toUpperCase() ===
                e.expression.toUpperCase() &&
              (a.decimalPlaces ?? 2) === (e.decimalPlaces ?? 2)
          )
        ),
    });
  }
  checks.push({
    key: "confirmed",
    ok: field.confirmed === true && field.status === "confirmed",
  });
  return { field, checks, complete: checks.every(c => c.ok) };
}

export const practiceLabels: Record<string, [string, string]> = {
  exists: [
    "欄位名稱以本步編號開頭，且只保留一個",
    "Exactly one field named with this lesson ID",
  ],
  page: ["頁面", "Page"],
  type: ["欄位類型", "Field type"],
  position: ["框的位置與大小", "Frame position and size"],
  required: ["必填", "Required"],
  maxLength: ["最大字數", "Max characters"],
  inputMode: ["輸入限制", "Input mode"],
  validation: ["驗證", "Validation"],
  regex: ["格式規則", "Pattern"],
  min: ["最小值", "Minimum"],
  max: ["最大值", "Maximum"],
  align: ["文字對齊", "Alignment"],
  dynamicDefault: ["動態預設", "Dynamic default"],
  dateFormat: ["日期格式", "Date format"],
  timeFormat: ["時間格式", "Time format"],
  options: ["選項（依序）", "Options (in order)"],
  markStyle: ["記號樣式", "Mark style"],
  boxCount: ["字格數", "Character capacity"],
  segmentCapacities: ["分段容量", "Segment capacities"],
  overflow: ["超限處理", "Overflow"],
  lineHeightPt: ["行距 pt", "Line height pt"],
  bold: ["粗體", "Bold"],
  italic: ["斜體", "Italic"],
  underline: ["底線", "Underline"],
  defaultValue: ["固定預設", "Fixed default"],
  maxRows: ["表格列數", "Table rows"],
  tableColumns: ["表格欄數", "Table columns"],
  tableFormulaSchemaVersion: [
    "跨列總額嚮導已設定",
    "Column totals (use the total wizard)",
  ],
  imageFit: ["圖片適配", "Image fit"],
  maxFileSizeMb: ["最大檔案 MB", "Max file MB"],
  signatureMode: ["簽名方式", "Signature mode"],
  marks: ["每個選項的對位", "Each choice mark aligned"],
  cells: ["每個表格儲存格的對位", "Each table cell aligned"],
  roles: ["可填／固定／公式角色", "Writable, fixed and formula roles"],
  formulas: ["公式與小數位數", "Formulas and decimal places"],
  segments: ["分段字格對位", "Segmented character positions"],
  confirmed: [
    "按「確認此欄位」記錄人工覆核",
    "Confirm the field after reviewing",
  ],
};
export const practiceValueLabels: Record<string, [string, string]> = {
  true: ["是", "Yes"],
  false: ["否", "No"],
  text: ["文字", "Text"],
  number: ["數字", "Number"],
  date: ["日期", "Date"],
  time: ["時間", "Time"],
  radio: ["單選", "Radio"],
  checkbox: ["多選／核取", "Checkbox"],
  select: ["下拉選單", "Dropdown"],
  characterBox: ["逐格字元", "Character boxes"],
  textarea: ["多行文字", "Multiline text"],
  table: ["重複行資料", "Repeating rows"],
  image: ["圖片", "Image"],
  signature: ["簽名", "Signature"],
  any: ["文字與數字", "Text and numbers"],
  email: ["Email", "Email"],
  phone: ["電話", "Phone"],
  regex: ["Regex", "Regex"],
  left: ["靠左", "Left"],
  center: ["置中", "Center"],
  right: ["靠右", "Right"],
  today: ["今日日期", "Today"],
  now: ["當前時間", "Now"],
  circle: ["圈選選項", "Circle choices"],
  check: ["剔號", "Tick"],
  cross: ["交叉", "Cross"],
  dot: ["實心點", "Dot"],
  block: ["禁止輸入", "Block"],
  shrink: ["自動縮小", "Shrink"],
  warn: ["警告但允許", "Warn but allow"],
  wrap: ["多行換行", "Wrap"],
  contain: ["完整顯示", "Contain"],
  cover: ["填滿並裁切", "Cover"],
  stretch: ["拉伸填滿", "Stretch"],
  draw: ["只限手寫", "Draw only"],
  upload: ["只限圖片", "Upload only"],
  all: ["手寫、圖片、文字", "All modes"],
};
