/**
 * UX-TPL-01 階段 2／S2-R3（第二輪）：`TableGridOverlay` 的正式元件測試。
 *
 * 驗證三條接線在元件層成立（不只是 helper 層）：
 * 1. raw＋derived 檢查在 guides 物化與分隔線陣列建立「之前」：非法網格
 *    完全不產生 `table-gridline` 元素（不是先建再丟掉）。
 * 2. 共享格線的可拖動資格只來自「raw 已儲存 guides」；顯示用的均分
 *    fallback 不構成對齊證據——沒有 guides 的合法表格，分隔線全部
 *    `data-aligned="false"`。
 * 3. 分隔線可鍵盤聚焦（`tabindex="0"`），滿足格線鍵盤可達性。
 *
 * 以 `react-dom/server` 靜態渲染（vitest 環境為 node，無 jsdom）。
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { uniformCellRect, type TableCellRect } from "@shared/tableGeometry";
import type { FormField } from "@/lib/form-model";
import { I18nProvider } from "@/lib/i18n";
import { TableGridOverlay } from "./TableGridOverlay";

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

function render(field: FormField): string {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      null,
      createElement(TableGridOverlay, {
        field,
        onCommit: () => {},
        onBusyChange: () => {},
      })
    )
  );
}

function countOf(markup: string, needle: string): number {
  return markup.split(needle).length - 1;
}

/** 6 列 × 12 欄、完全對齊的已儲存 guides（均分網格）。 */
function alignedGuides(rowSlots = 6, columns = 12): TableCellRect[] {
  const list: TableCellRect[] = [];
  for (let row = 0; row < rowSlots; row += 1)
    for (let column = 0; column < columns; column += 1)
      list.push(uniformCellRect(rowSlots, columns, row, column));
  return list;
}

describe("TableGridOverlay raw＋derived 守衛（元件層）", () => {
  it("illegal grid emits zero separators (guards run before guides and loops)", () => {
    const cases: Array<{ name: string; field: FormField }> = [
      { name: "NaN columns", field: tableField({ tableColumns: Number.NaN }) },
      {
        name: "Infinity rows",
        field: tableField({ maxRows: Number.POSITIVE_INFINITY }),
      },
      { name: "41 columns", field: tableField({ tableColumns: 41 }) },
      { name: "101 rows", field: tableField({ maxRows: 101 }) },
      {
        name: "derived column overflow via options",
        field: tableField({
          tableColumns: 12,
          options: Array.from({ length: 41 }, (_, i) => `c${i}`),
        }),
      },
    ];
    for (const item of cases) {
      const markup = render(item.field);
      expect(countOf(markup, "data-testid=\"table-gridline\""), item.name).toBe(0);
    }
  });

  it("legal grid without stored guides renders separators but none are provably aligned", () => {
    const markup = render(tableField({ tableCellGuides: undefined }));
    // 5 條水平（列間）＋11 條垂直（欄間）＝16 條分隔線
    expect(countOf(markup, "data-testid=\"table-gridline\"")).toBe(16);
    expect(countOf(markup, "data-aligned=\"true\"")).toBe(0);
    expect(countOf(markup, "data-aligned=\"false\"")).toBe(16);
    // 全部停用（不對齊就不自動平均化）
    expect(countOf(markup, "is-disabled")).toBe(16);
  });

  it("legal grid with provably aligned guides marks every separator draggable", () => {
    const markup = render(
      tableField({ tableCellGuides: alignedGuides() as FormField["tableCellGuides"] })
    );
    expect(countOf(markup, "data-testid=\"table-gridline\"")).toBe(16);
    expect(countOf(markup, "data-aligned=\"true\"")).toBe(16);
    expect(countOf(markup, "is-disabled")).toBe(0);
  });

  it("stored guides of the wrong length are not treated as proof of alignment", () => {
    // 長度不符（舊網格殘留）→ rawGuides 為空 → 全部不對齊，且分隔線數量
    // 仍依目前網格建立。
    const markup = render(
      tableField({
        maxRows: 6,
        tableColumns: 12,
        tableCellGuides: alignedGuides(3, 4) as FormField["tableCellGuides"],
      })
    );
    expect(countOf(markup, "data-testid=\"table-gridline\"")).toBe(16);
    expect(countOf(markup, "data-aligned=\"true\"")).toBe(0);
  });

  it("separators are keyboard reachable (tabindex=0) and expose axis/boundary", () => {
    const markup = render(tableField({ tableCellGuides: alignedGuides() as FormField["tableCellGuides"] }));
    expect(countOf(markup, "tabindex=\"0\"")).toBe(16);
    expect(markup).toContain("data-axis=\"horizontal\"");
    expect(markup).toContain("data-axis=\"vertical\"");
    expect(markup).toContain("role=\"separator\"");
  });

  it("upper legal bounds (30 columns / 100 rows) still materialize separators", () => {
    const markup = render(
      tableField({
        maxRows: 100,
        tableColumns: 30,
        tableCellGuides: alignedGuides(100, 30) as FormField["tableCellGuides"],
      })
    );
    // 99 條水平 ＋ 29 條垂直 ＝ 128
    expect(countOf(markup, "data-testid=\"table-gridline\"")).toBe(128);
  });
});
