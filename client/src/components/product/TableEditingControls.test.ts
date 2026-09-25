/**
 * UX-TPL-01 階段 2／S2-R3（第二輪）：`TableEditingControls` 的正式元件測試。
 *
 * 與只測 helper（`rawTableGridStatus`／`isLegalTableGridSize`）不同，這裡
 * 真的掛載元件，驗證「非法網格不會跑角色解析、不會枚舉把手組」這條接線
 * 在**元件層**成立：
 * - NaN／Infinity／41 欄／101 列／derived 溢位 → 顯示安全拒絕文案，且格線
 *   與逐格模式按鈕 disabled、分組導覽不渲染；
 * - 合法缺省（undefined／0）與「沒有 guides 的一般舊表格」→ 不得被誤判非法。
 *
 * 以 `react-dom/server` 靜態渲染（本專案 vitest 環境為 node，無 jsdom）；
 * 只斷言元件實際輸出的 markup，不依賴任何測試用假資料。
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FormField } from "@/lib/form-model";
import { I18nProvider } from "@/lib/i18n";
import { TableEditingControls } from "./TableEditingControls";

/** 建立一個 table 欄位；未指定的欄位沿用合法缺省。 */
function tableField(overrides: Partial<FormField> = {}): FormField {
  return {
    id: "f-1",
    label: "成績表",
    type: "table",
    status: "confirmed",
    page: 1,
    x: 10,
    y: 10,
    width: 80,
    height: 40,
    maxRows: 6,
    tableColumns: 12,
    ...overrides,
  };
}

function render(field: FormField, mode: "field" | "gridline" | "cell" = "cell") {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      null,
      createElement(TableEditingControls, {
        field,
        mode,
        onModeChange: () => {},
        group: 0,
        onGroupChange: () => {},
        onDeleteTable: () => {},
        onRequestFocus: () => {},
      })
    )
  );
}

/** 安全拒絕文案的判準（三語共通的錨點）。 */
const INVALID_MARKER = "超出支援範圍";
const EMPTY_MARKER = "目前沒有可調整的填寫格";

function countOf(markup: string, needle: string): number {
  return markup.split(needle).length - 1;
}

/**
 * 取出某個 `data-testid` 按鈕的整段開始標籤，用來判斷 disabled。
 * 不能直接用字串比對 `data-testid="..." disabled`——React 會在兩者之間
 * 插入 `class`／`aria-pressed` 等屬性，順序不固定。
 */
function buttonTag(markup: string, testId: string): string {
  const at = markup.indexOf(`data-testid="${testId}"`);
  if (at < 0) throw new Error(`button ${testId} not rendered`);
  const start = markup.lastIndexOf("<button", at);
  const end = markup.indexOf(">", at);
  return markup.slice(start, end);
}

function isDisabled(markup: string, testId: string): boolean {
  return buttonTag(markup, testId).includes("disabled");
}

describe("TableEditingControls raw＋derived 守衛（元件層）", () => {
  it("legal 6x12 without guides is NOT rejected (no invalid message)", () => {
    const markup = render(tableField({ tableCellGuides: undefined }));
    expect(markup).toContain("data-testid=\"table-editing-controls\"");
    expect(markup).not.toContain(INVALID_MARKER);
    // 合法網格 → 格線／逐格入口可用（不是 disabled）
    expect(isDisabled(markup, "mode-gridline")).toBe(false);
    expect(isDisabled(markup, "mode-cell")).toBe(false);
  });

  it("legal defaults (tableColumns undefined / 0) stay usable", () => {
    for (const value of [undefined, 0]) {
      const markup = render(
        tableField({ tableColumns: value as unknown as number, maxRows: undefined })
      );
      expect(markup).not.toContain(INVALID_MARKER);
      expect(isDisabled(markup, "mode-cell")).toBe(false);
    }
  });

  it("NaN tableColumns is rejected before role resolution", () => {
    const markup = render(tableField({ tableColumns: Number.NaN }));
    expect(markup).toContain(INVALID_MARKER);
    expect(isDisabled(markup, "mode-gridline")).toBe(true);
    expect(isDisabled(markup, "mode-cell")).toBe(true);
    // 分組導覽不得渲染（沒有合法把手組）
    expect(markup).not.toContain("data-testid=\"group-status\"");
    expect(markup).not.toContain("data-testid=\"group-next\"");
  });

  it("Infinity maxRows is rejected", () => {
    const markup = render(tableField({ maxRows: Number.POSITIVE_INFINITY }));
    expect(markup).toContain(INVALID_MARKER);
    expect(isDisabled(markup, "mode-cell")).toBe(true);
    expect(markup).not.toContain("data-testid=\"group-status\"");
  });

  it("41 columns (raw overflow) is rejected", () => {
    const markup = render(tableField({ tableColumns: 41 }));
    expect(markup).toContain(INVALID_MARKER);
    expect(isDisabled(markup, "mode-gridline")).toBe(true);
    expect(markup).not.toContain("data-testid=\"group-status\"");
  });

  it("101 rows (raw overflow) is rejected", () => {
    const markup = render(tableField({ maxRows: 101 }));
    expect(markup).toContain(INVALID_MARKER);
    expect(isDisabled(markup, "mode-cell")).toBe(true);
  });

  it("derived column overflow (options.length = 41) is rejected even though raw is legal", () => {
    // raw 檢查看 tableColumns＝12（合法），但 tableGridSize 會由 options
    // 推導出 41 欄；derived 檢查必須接在後面擋下來。
    const markup = render(
      tableField({
        tableColumns: 12,
        options: Array.from({ length: 41 }, (_, i) => `c${i}`),
      })
    );
    expect(markup).toContain(INVALID_MARKER);
    expect(isDisabled(markup, "mode-cell")).toBe(true);
    expect(markup).not.toContain("data-testid=\"group-status\"");
  });

  it("upper legal bounds (30 columns / 100 rows) are accepted", () => {
    const markup = render(tableField({ tableColumns: 30, maxRows: 100 }));
    expect(markup).not.toContain(INVALID_MARKER);
    expect(isDisabled(markup, "mode-cell")).toBe(false);
  });

  it("all-fixed table shows the empty state instead of handles, and is not 'invalid'", () => {
    // `tableWritableCells: []` → 每格都是 fixed（沒有可調整把手）。
    // 這不是非法尺寸：不得顯示「超出支援範圍」，應顯示空狀態。
    const markup = render(
      tableField({ maxRows: 2, tableColumns: 2, tableWritableCells: [] })
    );
    expect(markup).not.toContain(INVALID_MARKER);
    expect(markup).toContain(EMPTY_MARKER);
    expect(markup).not.toContain("data-testid=\"group-status\"");
  });

  it("renders exactly one invalid status line per rejection (no duplicated guards)", () => {
    const markup = render(tableField({ tableColumns: Number.NaN, maxRows: Number.NaN }));
    expect(countOf(markup, INVALID_MARKER)).toBe(1);
    // 空狀態與非法狀態不會同時出現
    expect(markup).not.toContain(EMPTY_MARKER);
  });
});
