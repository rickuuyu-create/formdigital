import React, { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useI18n } from "@/lib/i18n";
import { planColumnTotal } from "@/lib/formulaWizard";
import type { FormField } from "@/lib/form-model";
import { columnIndexToName, formatFormulaErrorMessage } from "@shared/tableFormula";

const copy = {
  title: ["跨列總額嚮導", "跨行总额向导", "Column total wizard"],
  description: ["選擇要相加的欄和列範圍，不用自行輸入公式。試算值不會儲存。", "选择要相加的列和行范围，无需输入公式。试算值不会保存。", "Choose one column and a row range. No formula typing is needed; sample values are not saved."],
  source: ["合計欄", "合计列", "Column to total"],
  start: ["起始列", "起始行", "First row"],
  end: ["結束列", "结束行", "Last row"],
  targetRow: ["總額放在第幾列", "总额放在第几行", "Total row"],
  targetColumn: ["總額放在哪一欄", "总额放在哪一列", "Total column"],
  decimal: ["小數位", "小数位", "Decimal places"],
  preview: ["試算結果", "试算结果", "Sample result"],
  blank: ["留白", "留白", "Blank"],
  apply: ["套用總額", "应用总额", "Apply total"],
  cancel: ["取消", "取消", "Cancel"],
  warning: ["欄位 A、B、C 代表目前位置；日後重排或刪除欄位前，系統必須先重新檢查公式。", "列 A、B、C 代表当前位置；日后重排或删除列前，系统必须先重新检查公式。", "A, B and C refer to current positions. Formulas must be rechecked before columns are reordered or removed."],
  samples: ["試算數字（每行一個）", "试算数字（每行一个）", "Sample numbers (one per row)"],
} as const;

type Props = {
  field: FormField;
  rows: number;
  columns: number;
  disabled?: boolean;
  onApply: (patch: Partial<FormField>) => void;
};

export function ColumnTotalWizard({ field, rows, columns, disabled, onApply }: Props) {
  const { locale } = useI18n();
  const language = locale === "en" ? 2 : locale === "zh-Hans" ? 1 : 0;
  const text = (key: keyof typeof copy) => copy[key][language];
  const [open, setOpen] = useState(false);
  const [sourceColumn, setSourceColumn] = useState(0);
  const [startRow, setStartRow] = useState(0);
  const [endRow, setEndRow] = useState(Math.max(0, rows - 2));
  const [targetRow, setTargetRow] = useState(Math.max(0, rows - 1));
  const [targetColumn, setTargetColumn] = useState(Math.max(0, columns - 1));
  const [decimalPlaces, setDecimalPlaces] = useState(2);
  const [samplesText, setSamplesText] = useState("100\n200");
  const validDimensions = Number.isInteger(rows) && rows >= 2 && rows <= 100 && Number.isInteger(columns) && columns >= 1 && columns <= 30;
  // The editor may receive the saved field dimensions after this component
  // has already mounted.  Re-seed safe defaults when the dialog opens or the
  // grid size changes, instead of leaving stale row/column selections behind.
  useEffect(() => {
    if (!open || !validDimensions) return;
    setSourceColumn(current => Math.min(current, columns - 1));
    setTargetColumn(current => Math.min(current, columns - 1));
    setStartRow(current => Math.min(current, Math.max(0, rows - 2)));
    setEndRow(Math.max(0, rows - 2));
    setTargetRow(Math.max(0, rows - 1));
  }, [open, validDimensions, rows, columns]);
  const samples = useMemo(() => {
    const values = samplesText.split(/\r?\n/);
    return Array.from({ length: rows }, (_, row) =>
      Array.from({ length: columns }, (_, column) => column === sourceColumn ? (values[row - startRow] ?? "") : ""),
    );
  }, [columns, rows, samplesText, sourceColumn, startRow]);
  const trial = validDimensions ? planColumnTotal({ ...field, maxRows: rows, tableColumns: columns }, {
    sourceColumn, startRow, endRow, targetRow, targetColumn, decimalPlaces,
  }, samples, locale) : null;
  const target = trial?.preview.cells[targetRow]?.[targetColumn];
  const disabledApply = !trial || trial.issues.length > 0 || Boolean(target?.error);
  const options = () => Array.from({ length: columns }, (_, column) => (
    <option key={column} value={column}>{columnIndexToName(column)}{field.options?.[column] ? ` — ${field.options[column]}` : ""}</option>
  ));

  return (
    <Dialog open={open && !disabled} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button type="button" className="btn-paper w-full" data-testid="column-total-wizard-open" disabled={disabled || !validDimensions}>{text("title")}</button>
      </DialogTrigger>
      {open && validDimensions && !disabled && (
        <DialogContent showCloseButton={false} className="max-h-[85vh] overflow-y-auto sm:max-w-2xl" data-testid="column-total-wizard">
          <DialogTitle>{text("title")}</DialogTitle>
          <DialogDescription>{text("description")}</DialogDescription>
          <div className="grid gap-3 text-sm sm:grid-cols-2">
            <label className="grid gap-1">{text("source")}<select className="setting-select" data-testid="total-source-column" value={sourceColumn} onChange={event => setSourceColumn(Number(event.target.value))}>{options()}</select></label>
            <label className="grid gap-1">{text("targetColumn")}<select className="setting-select" data-testid="total-target-column" value={targetColumn} onChange={event => setTargetColumn(Number(event.target.value))}>{options()}</select></label>
            <label className="grid gap-1">{text("start")}<input type="number" min={1} max={rows} className="setting-input" data-testid="total-start-row" value={startRow + 1} onChange={event => setStartRow(Math.max(0, Math.min(rows - 1, Number(event.target.value) - 1)))} /></label>
            <label className="grid gap-1">{text("end")}<input type="number" min={1} max={rows} className="setting-input" data-testid="total-end-row" value={endRow + 1} onChange={event => setEndRow(Math.max(0, Math.min(rows - 1, Number(event.target.value) - 1)))} /></label>
            <label className="grid gap-1">{text("targetRow")}<input type="number" min={1} max={rows} className="setting-input" data-testid="total-target-row" value={targetRow + 1} onChange={event => setTargetRow(Math.max(0, Math.min(rows - 1, Number(event.target.value) - 1)))} /></label>
            <label className="grid gap-1">{text("decimal")}<select className="setting-select" data-testid="total-decimal" value={decimalPlaces} onChange={event => setDecimalPlaces(Number(event.target.value))}>{Array.from({ length: 7 }, (_, value) => <option key={value} value={value}>{value}</option>)}</select></label>
          </div>
          <label className="grid gap-1 text-sm">{text("samples")}<textarea className="setting-input min-h-20" data-testid="total-samples" value={samplesText} onChange={event => setSamplesText(event.target.value)} /></label>
          <p className="text-sm" data-testid="total-expression"><code>{trial?.patch.tableFormulaCells.at(-1)?.expression}</code></p>
          <p className="text-sm" data-testid="total-preview" aria-live="polite">{text("preview")}: {target?.error ? formatFormulaErrorMessage(target.error, locale) : target?.value || text("blank")}</p>
          <div role="alert" className="text-sm">{trial?.issues.map((issue, index) => <p key={`${issue.code}-${index}`}>{issue.message}</p>)}</div>
          <p className="text-xs text-muted-foreground">{text("warning")}</p>
          <div className="flex gap-2">
            <button type="button" className="btn-ink" data-testid="total-apply" disabled={disabledApply} onClick={() => { onApply(trial!.patch); setOpen(false); }}>{text("apply")}</button>
            <button type="button" className="btn-paper" data-testid="total-cancel" onClick={() => setOpen(false)}>{text("cancel")}</button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
