import { type TableFormulaCell } from "@shared/tableFormula";
import { validateFieldValues } from "@shared/fieldValidation";

export type { TableFormulaCell };

export type FieldType =
  | "text"
  | "number"
  | "date"
  | "time"
  | "radio"
  | "select"
  | "checkbox"
  | "signature"
  | "image"
  | "textarea"
  | "characterBox"
  | "table";

export type FieldStatus = "confirmed" | "suggested" | "needs-review";

export type DetectedFieldBox = {
  xRatio: number;
  yRatio: number;
  widthRatio: number;
  heightRatio: number;
};

export type DetectedOptionMark = DetectedFieldBox & {
  option: string;
};

export function remapDetectedOptionMarks(
  marks: DetectedOptionMark[] | undefined,
  options: string[]
) {
  return (marks ?? []).flatMap((mark, index) =>
    options[index] ? [{ ...mark, option: options[index]! }] : []
  );
}

/**
 * Option marks for a radio field: keep whatever geometry was detected and give
 * every remaining option an evenly spaced slot.
 *
 * An option with no mark has no box to print its tick into and no handle to
 * drag, so a radio field typed by hand could never be positioned onto the
 * squares printed on the form. The generated slots are a starting point the
 * person then drags onto the real boxes.
 */
export function optionMarksForOptions(
  marks: DetectedOptionMark[] | undefined,
  options: string[]
): DetectedOptionMark[] {
  if (!options.length) return [];
  const remapped = remapDetectedOptionMarks(marks, options);
  return options.map(
    (option, index) =>
      remapped[index] ?? {
        option,
        xRatio: index / options.length,
        yRatio: 0,
        widthRatio: 1 / options.length,
        heightRatio: 1,
      }
  );
}

/**
 * A conservative preflight for a text box on a fixed paper page. It catches
 * a box that cannot sensibly show the chosen font or declared capacity before
 * a Draft is published; it is a warning, never a blocking validation rule.
 */
export function textGeometryWarning(field: {
  type: FieldType;
  width: number;
  height: number;
  pageWidthMm?: number;
  pageHeightMm?: number;
  fontSizePt?: number;
  maxLength?: number;
}): "too-short" | "too-narrow" | null {
  if (!(["text", "number", "date", "time", "textarea", "signature"] as FieldType[]).includes(field.type))
    return null;
  const fontSizePt = Math.max(1, field.fontSizePt ?? 10);
  const widthMm = Math.max(0, field.width) / 100 * (field.pageWidthMm ?? 210);
  const heightMm = Math.max(0, field.height) / 100 * (field.pageHeightMm ?? 297);
  const minimumHeightMm = Math.max(3.6, fontSizePt * 0.3528 * 1.25 + 0.9);
  if (heightMm < minimumHeightMm) return "too-short";
  if (typeof field.maxLength !== "number" || field.maxLength <= 0) return null;
  const estimatedCapacity = Math.floor(widthMm / Math.max(1.1, fontSizePt * 0.3528 * 0.72));
  return field.maxLength > estimatedCapacity ? "too-narrow" : null;
}

/**
 * One draggable box per table cell, stored row by row.
 *
 * A cell's index is `row * columns + column`, so the whole grid is covered
 * even when only some cells are writable — keeping the numbering tied to the
 * grid rather than to the writable mask means editing that mask, or adding a
 * row, cannot shift every stored position onto the wrong cell.
 *
 * Whatever is already positioned is kept; the rest start on the even division,
 * which is exactly where the renderer drew them before, so a template that is
 * never touched keeps printing identically.
 */
export function tableCellGuidesForGrid(
  guides: DetectedFieldBox[] | undefined,
  rowSlots: number,
  columns: number,
  previousColumns = columns
): DetectedFieldBox[] {
  const rows = Math.max(1, Math.floor(rowSlots));
  const cols = Math.max(1, Math.floor(columns));
  const priorCols = Math.max(1, Math.floor(previousColumns));
  const existing = guides ?? [];
  return Array.from({ length: rows * cols }, (_, index) => {
    const row = Math.floor(index / cols);
    const column = index % cols;
    const kept =
      column < priorCols ? existing[row * priorCols + column] : undefined;
    return (
      kept ?? {
        xRatio: column / cols,
        yRatio: row / rows,
        widthRatio: 1 / cols,
        heightRatio: 1 / rows,
      }
    );
  });
}

export interface FormField {
  id: string;
  label: string;
  type: FieldType;
  status: FieldStatus;
  required?: boolean;
  page?: number;
  x: number;
  y: number;
  width: number;
  height: number;
  placeholder?: string;
  options?: string[];
  savedValues?: string[];
  maxLength?: number;
  pageWidthMm?: number;
  pageHeightMm?: number;
  confirmed?: boolean;
  aiConfidence?: number;
  fontSizePt?: number;
  align?: "left" | "center" | "right";
  fontFamily?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
  letterSpacingPt?: number;
  lineHeightPt?: number;
  overflow?: "block" | "shrink" | "warn" | "wrap";
  defaultValue?: string;
  dynamicDefault?: "today" | "now" | null;
  validation?: "email" | "phone" | "regex" | "none";
  regex?: string;
  inputMode?: "text" | "number" | "any";
  dateFormat?: "yyyy-mm-dd" | "dd-mm-yyyy" | "mm-dd-yyyy";
  timeFormat?: "hh:mm" | "hhmm";
  min?: number;
  max?: number;
  boxCount?: number;
  /**
   * Character capacity of each printed segment, in reading order. A detected
   * DD / MM / YYYY date keeps [2, 2, 4] so the whole date survives.
   */
  segmentCapacities?: number[];
  maxRows?: number;
  tableColumns?: number;
  /**
   * Grid positions a person may write in. Absent means every cell is writable,
   * which is what templates created before detected tables carried a mask did.
   */
  tableWritableCells?: Array<{ row: number; column: number }>;
  /** Formula definitions for repeating table cells. */
  tableFormulaCells?: TableFormulaCell[];
  /** Version 2 permits the bounded cross-row total syntax SUM(A1:A6). */
  tableFormulaSchemaVersion?: 1 | 2;
  /** Per-cell positions, row by row. See `tableCellGuidesForGrid`. */
  tableCellGuides?: DetectedFieldBox[];
  detectionSource?: string;
  detectionGroup?: DetectedFieldBox[];
  optionMarks?: DetectedOptionMark[];
  maxFileSizeMb?: number;
  allowedMimeTypes?: string[];
  imageFit?: "contain" | "cover" | "stretch";
  signatureMode?: "draw" | "upload" | "text" | "all";
  /** How a ticked checkbox or selected radio option is drawn. */
  markStyle?: "check" | "cross" | "dot" | "circle";
  zIndex?: number;
}

export interface TemplateVersion {
  id: string;
  version: string;
  state: "Draft" | "Published";
  publishedAt?: string;
}

export interface FormTemplate {
  id: string;
  name: string;
  category: string;
  tag: string;
  version: TemplateVersion;
  updatedAt: string;
  fieldCount: number;
  fields: FormField[];
}

export interface MappingRow {
  csvField: string;
  sample: string;
  fieldId: string | null;
  confidence: "High" | "Medium" | "Low";
}

export const demoTemplate: FormTemplate = {
  id: "tpl_hku_honours",
  name: "在校成績及榮譽申報表",
  category: "學校文件",
  tag: "HKU",
  version: { id: "tpl_hku_honours_v1", version: "v1", state: "Published", publishedAt: "2026-08-19" },
  updatedAt: "剛剛更新",
  fieldCount: 9,
  fields: [
    { id: "studentName", label: "姓名", type: "text", status: "confirmed", required: true, x: 29, y: 25, width: 49, height: 5, placeholder: "請輸入學生姓名", savedValues: ["陳俊賢", "張芷晴", "王志文"], maxLength: 30 },
    { id: "studentId", label: "學生編號", type: "text", status: "confirmed", required: true, x: 29, y: 33, width: 43, height: 5, placeholder: "例如：202601234" },
    { id: "birthDate", label: "出生日期", type: "characterBox", status: "confirmed", required: true, x: 29, y: 41, width: 47, height: 7, placeholder: "YYYYMMDD", maxLength: 8 },
    { id: "gender", label: "性別", type: "select", status: "confirmed", required: true, x: 29, y: 50, width: 22, height: 5, options: ["男", "女", "其他"], savedValues: ["女", "男"] },
    { id: "phone", label: "聯絡電話", type: "text", status: "suggested", x: 29, y: 58, width: 43, height: 5, placeholder: "+852 0000 0000" },
    { id: "email", label: "電郵地址", type: "text", status: "confirmed", required: true, x: 29, y: 66, width: 49, height: 5, placeholder: "name@example.com" },
    { id: "award", label: "主要獎項／活動", type: "table", status: "needs-review", x: 17, y: 76, width: 66, height: 12, placeholder: "輸入獎項或活動名稱" },
    { id: "confirm", label: "本人確認資料正確", type: "checkbox", status: "confirmed", required: true, x: 17, y: 91, width: 5, height: 3 },
    { id: "signature", label: "申請人簽署", type: "text", status: "suggested", x: 52, y: 91, width: 30, height: 4, placeholder: "文字簽名" },
  ],
};

export const initialValues: Record<string, string> = {
  studentName: "陳俊賢",
  studentId: "202601248",
  birthDate: "20050412",
  gender: "男",
  phone: "",
  email: "junxian.chan@example.com",
  award: "2025 校際數學挑戰賽 · 銀獎",
  confirm: "",
  signature: "",
};

export const initialMappings: MappingRow[] = [
  { csvField: "Student Name", sample: "陳俊賢", fieldId: "studentName", confidence: "High" },
  { csvField: "Student ID", sample: "202601248", fieldId: "studentId", confidence: "High" },
  { csvField: "Gender", sample: "Male", fieldId: "gender", confidence: "High" },
  { csvField: "Birth Date", sample: "2005/04/12", fieldId: "birthDate", confidence: "Medium" },
  { csvField: "Contact No.", sample: "+852 6123 4567", fieldId: "phone", confidence: "Medium" },
  { csvField: "Class", sample: "4A", fieldId: null, confidence: "Low" },
];

export const templateCards = [
  { name: "在校成績及榮譽申報表", tag: "HKU", version: "v1", fields: 9, use: "今天 14:26", accent: "red" },
  { name: "學生入學資料表", tag: "Admissions", version: "v3", fields: 18, use: "昨天", accent: "blue" },
  { name: "部門費用報銷表", tag: "Finance", version: "v2", fields: 14, use: "08/16", accent: "amber" },
];

export function cleanCharacterBoxes(value: string) {
  return value.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "");
}

export function validateValues(values: Record<string, string>, fields: FormField[]) {
  return validateFieldValues(values, fields.map(field => ({
    stableFieldId: field.id,
    fieldType: field.type,
    definition: field,
  }))).filter(issue => issue.blocking).map(issue => issue.message);
}

export function fieldTypeLabel(type: FieldType) {
  const labels: Record<FieldType, string> = {
    text: "單行文字",
    number: "數字",
    date: "日期",
    time: "時間",
    radio: "單選",
    select: "下拉選單",
    checkbox: "多選",
    signature: "簽名",
    image: "圖片／相片",
    textarea: "描述／多行文字",
    characterBox: "逐格字元",
    table: "重複行資料",
  };
  return labels[type];
}
