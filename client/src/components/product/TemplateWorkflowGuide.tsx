import React, { useState } from "react";
import { useI18n } from "@/lib/i18n";

const wording = {
  title: ["建立範本的五個步驟", "创建模板的五个步骤", "Five steps to a Template"],
  reopen: ["顯示操作導引", "显示操作向导", "Show guide"],
  close: ["暫時收起", "暂时收起", "Hide for now"],
  steps: [
    ["匯入並檢查原文件", "导入并检查原文件", "Import and inspect the source"],
    ["整理欄位與表格格線", "整理字段与表格线", "Arrange fields and table gridlines"],
    ["設定可填格、固定格和公式", "设置可填写、固定和公式单元格", "Set writable, fixed and formula cells"],
    ["試填並逐項人工確認", "试填并逐项人工确认", "Try sample data and review each field"],
    ["發佈後填寫表格，再檢查輸出", "发布后填写表格，再检查输出", "Publish, create an Instance, then inspect output"],
  ],
  caution: ["「全部確認」只代表你已檢查欄位，不代表系統保證辨識結果完全正確。", "“全部确认”只代表你已检查字段，不代表系统保证识别结果完全正确。", "“Confirm all” records your review; it does not guarantee that recognition is perfect."],
} as const;

export function workflowCompletion({
  hasPages,
  hasFields,
  hasTableFormula,
  allFieldsConfirmed,
  isDraft,
  outputChecked,
}: {
  hasPages: boolean;
  hasFields: boolean;
  hasTableFormula: boolean;
  allFieldsConfirmed: boolean;
  isDraft: boolean;
  /** True only after an actual Instance output has been checked. */
  outputChecked: boolean;
}): boolean[] {
  return [
    hasPages,
    hasFields,
    hasTableFormula,
    allFieldsConfirmed,
    !isDraft && outputChecked,
  ];
}

export function TemplateWorkflowGuide({ completed }: { completed: boolean[] }) {
  const { locale } = useI18n();
  const language = locale === "en" ? 2 : locale === "zh-Hans" ? 1 : 0;
  const [open, setOpen] = useState(true);
  if (!open) return <button type="button" className="btn-paper workflow-guide-reopen" data-testid="workflow-guide-reopen" onClick={() => setOpen(true)}>{wording.reopen[language]}</button>;
  return (
    <section className="workflow-guide" aria-labelledby="workflow-guide-title" data-testid="workflow-guide">
      <div className="workflow-guide-heading">
        <h2 id="workflow-guide-title">{wording.title[language]}</h2>
        <button type="button" onClick={() => setOpen(false)} data-testid="workflow-guide-close">{wording.close[language]}</button>
      </div>
      <ol>
        {wording.steps.map((step, index) => (
          <li key={index} data-complete={completed[index] ? "true" : "false"}>
            <span aria-hidden="true">{completed[index] ? "✓" : index + 1}</span>{step[language]}
          </li>
        ))}
      </ol>
      <p>{wording.caution[language]}</p>
    </section>
  );
}

const navWords = {
  label: ["設定分組", "设置分组", "Settings groups"],
  basic: ["基本資料", "基本信息", "Basics"],
  table: ["表格", "表格", "Table"],
  calculation: ["計算", "计算", "Calculations"],
  appearance: ["外觀", "外观", "Appearance"],
} as const;

export function FieldSettingsNavigator({ table }: { table: boolean }) {
  const { locale } = useI18n();
  const language = locale === "en" ? 2 : locale === "zh-Hans" ? 1 : 0;
  const go = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "center" });
  const buttons: Array<[keyof typeof navWords, string]> = [["basic", "editor-section-basic"], ["appearance", "editor-section-appearance"]];
  if (table) buttons.splice(1, 0, ["table", "editor-section-table"], ["calculation", "editor-section-calculation"]);
  return <nav className="field-settings-nav" aria-label={navWords.label[language]} data-testid="field-settings-nav">{buttons.map(([key, id]) => <button type="button" key={key} onClick={() => go(id)}>{navWords[key][language]}</button>)}</nav>;
}
