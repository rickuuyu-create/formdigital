import {
  knownOptions,
  normalizeOption,
  selectedSingleOption,
} from "./checkboxSelection";
import {
  resolveEffectiveTableGrid,
  validateTableFormulaDefinition,
  columnIndexToName,
  checkTableRawStructure,
  type TableRoleDefinition,
} from "./tableFormula";

export type ValidatableField = {
  stableFieldId: string;
  fieldType: string;
  definition?: unknown;
};

export type FieldValidationIssue = {
  fieldId: string;
  code: string;
  message: string;
  blocking: boolean;
  /** Safe, structured params carried to the wire marker so the client can
   *  localize without reverse-parsing the Traditional Chinese message. */
  params?: Record<string, string | number>;
};

function definitionOf(field: ValidatableField) {
  return field.definition && typeof field.definition === "object" && !Array.isArray(field.definition)
    ? field.definition as Record<string, unknown>
    : {};
}

export function validateFieldValues(values: Record<string, string>, fields: ValidatableField[], options: { requiredIsBlocking?: boolean } = {}) {
  const issues: FieldValidationIssue[] = [];
  for (const field of fields) {
    const definition = definitionOf(field);
    const label = String(definition.label || field.stableFieldId);
    const value = values[field.stableFieldId] ?? "";
    const trimmed = value.trim();
    // `message` keeps the Traditional Chinese diagnostic (with the human label)
    // for server logs and any legacy consumer; the trilingual, params-driven
    // catalog entry is what the user actually sees.
    const add = (
      code: string,
      message: string,
      blocking = true,
      params: Record<string, string | number> = {},
    ) => issues.push({ fieldId: field.stableFieldId, code, message, blocking, params });
    if (definition.required === true && !trimmed) add("required", `${label}為必填欄位`, options.requiredIsBlocking !== false);
    if (!trimmed) continue;
    // Character boxes hold one printable character per box; separators printed
    // on the form ("23/08/2026") are not part of the value, so they are not
    // counted here either, matching the fill UI, the Preview, and the renderer.
    const measuredLength = field.fieldType === "characterBox"
      ? Array.from(value.replace(/[^a-zA-Z0-9一-鿿]/g, "")).length
      : value.length;
    if (typeof definition.maxLength === "number" && measuredLength > definition.maxLength) add("max_length", `${label}不可超過 ${definition.maxLength} 字`, true, { max: definition.maxLength });
    if ((field.fieldType === "number" || definition.inputMode === "number") && !Number.isFinite(Number(value))) add("number", `${label}必須是有效數字`);
    if (field.fieldType === "number" && typeof definition.min === "number" && Number(value) < definition.min) add("min", `${label}不可小於 ${definition.min}`, true, { min: definition.min });
    if (field.fieldType === "number" && typeof definition.max === "number" && Number(value) > definition.max) add("max", `${label}不可大於 ${definition.max}`, true, { max: definition.max });
    if (field.fieldType === "date" && Number.isNaN(Date.parse(value))) add("date", `${label}不是有效日期`);
    if (field.fieldType === "time" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) add("time", `${label}必須使用 24 小時 HH:mm 格式`);
    if (definition.validation === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) add("email", `${label}不是有效 Email`);
    if (definition.validation === "phone" && !/^[+()\d][+()\d\s.-]{5,24}$/.test(value)) add("phone", `${label}不是有效電話號碼`);
    const regexSource = typeof definition.regex === "string" ? definition.regex : "";
    if (regexSource) {
      try { if (!new RegExp(regexSource).test(value)) add("regex", `${label}格式不符合規則`); }
      catch { add("regex_config", `${label}的 Regex 設定無效`); }
    }
    // A single-select field may only hold an option the Template offers. The
    // stored value used to be accepted unchecked, so a dropdown exported as a
    // plain PDF text field could come back carrying anything at all.
    if (field.fieldType === "radio" || field.fieldType === "select") {
      const choices = knownOptions(definition.options);
      if (choices.length && !selectedSingleOption(value, choices))
        add("option", `${label}的值不屬於可選項目`);
    }
    if (field.fieldType === "checkbox") {
      // A checkbox covering a printed row stores one selected option per line;
      // a lone square keeps the single boolean value.
      const checkboxOptions = knownOptions(definition.options);
      if (checkboxOptions.length === 1 && /^(true|false|checked|1|0|yes|no|是|否)$/i.test(trimmed)) {
        // Backward-compatible single-square values from the original fill UI.
      } else if (checkboxOptions.length) {
        // Normalised the same way the options are, so a value the preview and
        // the PDF both show as chosen is never blocked here for differing by
        // whitespace inside it.
        const unknown = value
          .split("\n")
          .map((item) => normalizeOption(item))
          .filter(Boolean)
          .filter((item) => !checkboxOptions.includes(item));
        if (unknown.length) add("checkbox", `${label}含有不屬於選項的值`);
      } else if (!/^(true|false|checked|1|0|yes|no|是|否)$/i.test(trimmed)) add("checkbox", `${label}不是有效核取值`);
    }
    if ((field.fieldType === "image" || field.fieldType === "signature") && typeof definition.maxFileSizeMb === "number" && !/^asset-[\w-]+$/.test(value) && !/^text:/.test(value)) add("asset", `${label}必須使用已保存的本機圖片或文字簽名`);
    if (field.fieldType === "table") {
      const struct = checkTableRawStructure(value);
      const rawCode = struct.stableCode || struct.code || "table_structure_invalid";
      if (!struct.valid) {
        add(
          rawCode,
          `${label}的${struct.message || "表格資料格式無效"}`,
          true,
        );
      } else {
        const rows = (value.trim() ? JSON.parse(value.trim()) : []) as unknown[];
        if (typeof definition.maxRows === "number" && rows.length > definition.maxRows) {
          add("table_rows", `${label}最多只可有 ${definition.maxRows} 列`, true, { max: definition.maxRows });
        }
        const grid = resolveEffectiveTableGrid(definition as TableRoleDefinition, value);
        for (const err of grid.errors) {
          const colName = columnIndexToName(err.column);
          // `err.code` is a stable, locale-independent runtime error code
          // (e.g. DIVISION_BY_ZERO). The client derives the localized detail from
          // it via formatFormulaErrorMessage, so the message stays trilingual;
          // the Traditional Chinese `message` below is only the safe server-side
          // fallback and keeps the original position context for server logs.
          add("table_formula", `公式無法計算：${err.message}`, true, { code: err.code });
        }
      }
    }
  }
  return issues;
}

export function validateTemplateFields(fields: ValidatableField[]): FieldValidationIssue[] {
  const issues: FieldValidationIssue[] = [];
  for (const field of fields) {
    if (field.fieldType === "table") {
      const definition = definitionOf(field) as TableRoleDefinition;
      const formulaIssues = validateTableFormulaDefinition(definition);
      for (const issue of formulaIssues) {
        issues.push({
          fieldId: field.stableFieldId,
          code: issue.code,
          message: issue.message,
          blocking: true,
          params: issue.params,
        });
      }
    }
  }
  return issues;
}
