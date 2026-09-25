import { useState } from "react";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useI18n } from "@/lib/i18n";
import {
  buildWizardExpression,
  planFormulaWizard,
  wizardSampleColumns,
  type WizardKind,
} from "@/lib/formulaWizard";
import {
  columnIndexToName,
  formatFormulaErrorMessage,
} from "@shared/tableFormula";
import type { FormField } from "@/lib/form-model";

const words = {
  title: ["同列公式嚮導", "同行公式向导", "Same-row formula wizard"],
  description: [
    "先試算，再套用；範例值只留在記憶體，不會儲存。",
    "先试算，再应用；示例值只留在内存，不会保存。",
    "Try sample values before applying. Samples stay in memory and are not saved.",
  ],
  kind: ["計算方式", "计算方式", "Calculation"],
  multiply: ["數量 × 單價", "数量 × 单价", "Quantity × unit price"],
  add: ["兩欄相加", "两列相加", "Add two columns"],
  subtract: ["兩欄相減", "两列相减", "Subtract two columns"],
  percent: ["金額 × 百分率", "金额 × 百分率", "Amount × percentage"],
  custom: ["自訂", "自定义", "Custom"],
  left: ["來源一", "来源一", "First source"],
  right: ["來源二", "来源二", "Second source"],
  result: ["結果欄", "结果列", "Result column"],
  row: ["目標列（單格套用）", "目标行（单格应用）", "Target row (single cell)"],
  decimal: ["小數位", "小数位", "Decimal places"],
  expression: ["公式", "公式", "Expression"],
  percentageHint: [
    "百分率填 10 代表 10%，公式為來源一 × 來源二 ÷ 100。",
    "百分率填 10 代表 10%，公式为来源一 × 来源二 ÷ 100。",
    "Enter 10 for 10%; first source × second source ÷ 100.",
  ],
  rules: [
    "全空留白；部分有值時，其他空白當 0。0 是有效數字。這裡只設定同列計算；跨列總額請使用下方的總額嚮導。",
    "全空留白；部分有值时，其他空白当 0。0 是有效数字。这里仅设置同行计算；跨行总额请使用下方的总额向导。",
    "All sources blank: leave blank. Otherwise blank sources count as 0. Zero is a number. Use the total wizard below for cross-row totals.",
  ],
  sample: ["試算", "试算", "Sample"],
  inputsHint: [
    "只列出會影響結果的可輸入欄；其他公式及不可填格沿用原設定。",
    "只列出会影响结果的可输入列；其他公式及不可填单元格沿用原设置。",
    "Only relevant writable inputs are shown. Other formulas and fixed cells retain their existing rules.",
  ],
  blank: ["留白", "留白", "Blank"],
  overwrite: [
    "套用會取代目標格的角色及公式；整欄包含原本不需填寫的格子。範例值不會寫入。可用復原撤銷。",
    "应用会替换目标单元格的角色及公式；整列包含原本不需填写的单元格。示例值不会写入。可撤销。",
    "Applying replaces target roles and formulas, including fixed cells for a whole column. Sample values are never written. Undo is available.",
  ],
  single: ["只套用這一格", "只应用此单元格", "Apply to this cell"],
  column: ["套用整欄", "应用整列", "Apply to whole column"],
  cancel: ["取消", "取消", "Cancel"],
  invalid: [
    "表格尺寸無效，無法開啟嚮導。",
    "表格尺寸无效，无法打开向导。",
    "Invalid table dimensions; wizard unavailable.",
  ],
} as const;
type Props = {
  field: FormField;
  rows: number;
  columns: number;
  initialRow: number;
  initialColumn: number;
  disabled?: boolean;
  onApply: (patch: Partial<FormField>) => void;
};

export function FormulaWizard(props: Props) {
  const { locale } = useI18n();
  const index = locale === "en" ? 2 : locale === "zh-Hans" ? 1 : 0;
  const [open, setOpen] = useState(false);
  const valid =
    Number.isInteger(props.rows) &&
    props.rows >= 1 &&
    props.rows <= 100 &&
    Number.isInteger(props.columns) &&
    props.columns >= 1 &&
    props.columns <= 30;
  return (
    <Dialog open={open && !props.disabled} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="btn-paper w-full"
          data-testid="formula-wizard-open"
          disabled={props.disabled || !valid}
        >
          {words.title[index]}
        </button>
      </DialogTrigger>
      {!valid && <p role="alert">{words.invalid[index]}</p>}
      {open && valid && !props.disabled && (
        <DialogContent
          showCloseButton={false}
          className="max-h-[85vh] overflow-y-auto sm:max-w-3xl"
          data-testid="formula-wizard"
        >
          <DialogTitle>{words.title[index]}</DialogTitle>
          <DialogDescription>{words.description[index]}</DialogDescription>
          <WizardBody
            {...props}
            onCancel={() => setOpen(false)}
            onApply={(patch) => {
              props.onApply(patch);
              setOpen(false);
            }}
          />
        </DialogContent>
      )}
    </Dialog>
  );
}

function WizardBody({
  field,
  rows,
  columns,
  initialRow,
  initialColumn,
  onApply,
  onCancel,
}: Props & { onCancel: () => void }) {
  const { locale } = useI18n();
  const msg = (key: keyof typeof words) =>
    words[key][locale === "en" ? 2 : locale === "zh-Hans" ? 1 : 0];
  const [row, setRow] = useState(Math.min(rows - 1, Math.max(0, initialRow)));
  const [column, setColumn] = useState(
    Math.min(columns - 1, Math.max(0, initialColumn)),
  );
  const sources = Array.from({ length: columns }, (_, c) => c).filter(
    (c) => c !== column,
  );
  const [left, setLeft] = useState(sources[0] ?? 0),
    [right, setRight] = useState(sources[1] ?? sources[0] ?? 0);
  const existing = field.tableFormulaCells?.find(
    (cell) => cell.row === row && cell.column === column,
  );
  const [kind, setKind] = useState<WizardKind>(
      existing ? "custom" : "multiply",
    ),
    [custom, setCustom] = useState(existing?.expression ?? "");
  const [decimalPlaces, setDecimalPlaces] = useState(
    existing?.decimalPlaces ?? 2,
  );
  const [samples, setSamples] = useState<string[][]>(() =>
    Array.from({ length: 3 }, (_, i) =>
      Array.from({ length: columns }, (_, c) =>
        i === 0
          ? c === left
            ? "3"
            : c === right
              ? "12.5"
              : ""
          : i === 1 && c === left
            ? "2"
            : "",
      ),
    ),
  );
  const expression = buildWizardExpression(kind, left, right, custom);
  const definition = { ...field, maxRows: rows, tableColumns: columns };
  const sampleColumns = wizardSampleColumns(
    definition,
    row,
    column,
    expression,
  );
  const trial = (wholeColumn: boolean, sample: string[]) => {
    const values = Array.from({ length: rows }, (_, r) =>
      r === row ? sample : [],
    );
    return planFormulaWizard(
      definition,
      { row, column, decimalPlaces, expression, wholeColumn },
      values,
      locale,
    );
  };
  const previews = samples.map((sample) => trial(false, sample));
  const single = previews[0],
    whole = trial(true, samples[0]);
  const runtimeError = previews.some(
    (result) => result.preview.cells[row][column].error,
  );
  const columnOptions = () =>
    Array.from({ length: columns }, (_, c) => (
      <option key={c} value={c}>
        {columnIndexToName(c)}
        {field.options?.[c] ? ` — ${field.options[c]}` : ""}
      </option>
    ));
  const columnSelect = (
    key: "left" | "right" | "result",
    value: number,
    set: (n: number) => void,
  ) => (
    <label className="grid gap-1">
      {msg(key)}
      <select
        className="setting-select"
        data-testid={`wizard-${key}`}
        value={value}
        onChange={(e) => set(Number(e.target.value))}
      >
        {columnOptions()}
      </select>
    </label>
  );
  return (
    <div className="space-y-3 text-sm">
      <label className="grid gap-1">
        {msg("kind")}
        <select
          className="setting-select"
          data-testid="wizard-kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as WizardKind)}
        >
          {(["multiply", "add", "subtract", "percent", "custom"] as const).map(
            (k) => (
              <option key={k} value={k}>
                {msg(k)}
              </option>
            ),
          )}
        </select>
      </label>
      <div className="grid grid-cols-2 gap-3">
        {kind !== "custom" && (
          <>
            {columnSelect("left", left, setLeft)}
            {columnSelect("right", right, setRight)}
          </>
        )}
        {columnSelect("result", column, setColumn)}
        <label className="grid gap-1">
          {msg("row")}
          <select
            className="setting-select"
            data-testid="wizard-row"
            value={row}
            onChange={(e) => setRow(Number(e.target.value))}
          >
            {Array.from({ length: rows }, (_, r) => (
              <option key={r} value={r}>
                {r + 1}
              </option>
            ))}
          </select>
        </label>
      </div>
      {kind === "percent" && <p>{msg("percentageHint")}</p>}
      <label className="grid gap-1">
        {msg("expression")}
        <input
          className="setting-input"
          data-testid="wizard-expression"
          readOnly={kind !== "custom"}
          maxLength={256}
          value={expression}
          onChange={(e) => setCustom(e.target.value)}
        />
      </label>
      <label className="grid gap-1">
        {msg("decimal")}
        <select
          className="setting-select"
          data-testid="wizard-decimal"
          value={decimalPlaces}
          onChange={(e) => setDecimalPlaces(Number(e.target.value))}
        >
          {Array.from({ length: 7 }, (_, n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <p>{msg("rules")}</p>
      <p>{msg("inputsHint")}</p>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr>
              <th>{msg("sample")}</th>
              {sampleColumns.map((c) => (
                <th key={c}>{columnIndexToName(c)}</th>
              ))}
              <th>{msg("result")}</th>
            </tr>
          </thead>
          <tbody>
            {samples.map((sample, i) => (
              <tr key={i}>
                <th>{i + 1}</th>
                {sampleColumns.map((c) => (
                  <td key={c}>
                    <input
                      className="setting-input min-w-20"
                      aria-label={`${msg("sample")} ${i + 1} ${columnIndexToName(c)}`}
                      data-testid={`wizard-sample-${i}-${c}`}
                      value={sample[c]}
                      maxLength={80}
                      onChange={(e) =>
                        setSamples((prev) =>
                          prev.map((r, ri) =>
                            ri === i
                              ? r.map((v, ci) =>
                                  ci === c ? e.target.value : v,
                                )
                              : r,
                          ),
                        )
                      }
                    />
                  </td>
                ))}
                <td data-testid={`wizard-preview-${i}`} aria-live="polite">
                  {previews[i].preview.cells[row][column].error
                    ? formatFormulaErrorMessage(
                        previews[i].preview.cells[row][column].error!,
                        locale,
                      )
                    : previews[i].preview.cells[row][column].value ||
                      msg("blank")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div role="status" data-testid="wizard-validation">
        {single.issues.map((issue, i) => (
          <p key={i}>{issue.message}</p>
        ))}
      </div>
      {whole.issues.length > 0 && single.issues.length === 0 && (
        <p role="alert">{whole.issues[0].message}</p>
      )}
      <p>{msg("overwrite")}</p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-ink"
          data-testid="wizard-apply-cell"
          disabled={single.issues.length > 0 || runtimeError}
          onClick={() => onApply(single.patch)}
        >
          {msg("single")}
        </button>
        <button
          type="button"
          className="btn-ink"
          data-testid="wizard-apply-column"
          disabled={whole.issues.length > 0 || runtimeError}
          onClick={() => onApply(whole.patch)}
        >
          {msg("column")} ({rows})
        </button>
        <button
          type="button"
          className="btn-paper"
          data-testid="wizard-cancel"
          onClick={onCancel}
        >
          {msg("cancel")}
        </button>
      </div>
    </div>
  );
}
