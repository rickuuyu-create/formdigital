import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import {
  FieldSettingsNavigator,
  TemplateWorkflowGuide,
  workflowCompletion,
} from "./TemplateWorkflowGuide";

function render(node: ReturnType<typeof createElement>) {
  return renderToStaticMarkup(createElement(I18nProvider, null, node));
}

describe("stage 5 nontechnical workflow guidance", () => {
  it("shows all five steps and the human-review disclaimer", () => {
    const html = render(createElement(TemplateWorkflowGuide, { completed: [true, true, false, false, false] }));
    expect((html.match(/<li/g) ?? []).length).toBe(5);
    expect(html).toContain("逐項人工確認");
    expect(html).toContain("不代表系統保證辨識結果完全正確");
    expect(html).toContain('data-complete="true"');
  });

  it("groups table settings into basic, table, calculation and appearance navigation", () => {
    const html = render(createElement(FieldSettingsNavigator, { table: true }));
    expect(html).toContain("基本資料");
    expect(html).toContain("表格");
    expect(html).toContain("計算");
    expect(html).toContain("外觀");
  });

  it("keeps output checking unfinished after publication until a real output check is recorded", () => {
    expect(
      workflowCompletion({
        hasPages: true,
        hasFields: true,
        hasTableFormula: true,
        allFieldsConfirmed: true,
        isDraft: false,
        outputChecked: false,
      })
    ).toEqual([true, true, true, true, false]);
  });
});
