/**
 * UX-TPL-01 階段 2／S2-01＋S2-02＋S2-05：表格專用控制條。
 *
 * 在側欄（TemplateEditor）於選取表格欄位時渲染：
 * - 三種互斥模式（欄位／格線／逐格）切換；
 * - 逐格模式的邏輯分頁導覽（上一組／下一組＋組指示器＋說明）；
 * - 跳至格子（選列欄後切到所屬組並聚焦）；
 * - 刪除整個表格欄位的守護按鈕（確認在父層進行）。
 *
 * 不重做既有批量角色能力（selectColumn／selectRow／setBatchRole），
 * 只改善其可發現性與此處的模式入口。
 */

import * as React from "react";
import { useEffect, useMemo, useState } from "react";
import type { FormField } from "@/lib/form-model";
import { tableGridSize } from "@shared/tableGeometry";
import { resolveTableGridRoles } from "@shared/tableFormula";
import {
  groupTableHandles,
  isLegalTableGridSize,
  rawTableGridStatus,
  tableHandleGroupForCell,
} from "@/lib/tableHandlePaging";
import { tableEditingText } from "@/lib/tableEditingMessages";
import { useI18n } from "@/lib/i18n";

export type TableEditMode = "field" | "gridline" | "cell";

export function TableEditingControls({
  field,
  mode,
  onModeChange,
  group,
  onGroupChange,
  onDeleteTable,
  onRequestFocus,
}: {
  field: FormField;
  mode: TableEditMode;
  onModeChange: (mode: TableEditMode) => void;
  group: number;
  onGroupChange: (group: number) => void;
  onDeleteTable: () => void;
  /** S2-R4：跳至指定絕對 index 的格子後請求聚焦。 */
  onRequestFocus?: (absoluteIndex: number) => void;
}) {
  const { locale } = useI18n();
  const T = useMemo(() => tableEditingText(locale), [locale]);
  const { rowSlots, columns } = tableGridSize(field, []);
  /**
   * S2-R3（第二輪）：raw＋derived 尺寸檢查必須發生在「角色解析、guides 物化、
   * 維度迴圈」之前。
   *
   * 上一輪雖已計算 `rawInvalid`，但仍緊接著呼叫 `resolveTableGridRoles`，
   * 並在其後的 `useMemo` 內以非法尺寸呼叫 `roles.isFixed`——等於用非法網格
   * 跑完角色解析。這裡改成先判定，非法時根本不解析角色、不枚舉把手組。
   *
   * 兩段檢查缺一不可：
   * - raw（`tableColumns`／`maxRows`）：`tableGridSize()` 不是 validator，
   *   NaN／Infinity 會被 `positiveCount` 轉成 0 再被 `Math.max(1, …)` 吃掉；
   * - derived（`rowSlots`／`columns`）：可由 `options.length` 或已輸入列數推導
   *   而超出 1–30 欄／1–100 列，raw 合法時仍可能越界。
   *
   * 缺省定義（undefined／null／""／0）沿用既有 `positiveCount` 的合法 fallback，
   * 不把「沒有 guides 的一般舊表格」誤判為非法。
   */
  const gridInvalid =
    rawTableGridStatus({
      tableColumns: field.tableColumns,
      maxRows: field.maxRows,
    }) === "invalid" || !isLegalTableGridSize(rowSlots, columns);
  const roles = gridInvalid
    ? null
    : resolveTableGridRoles(field, rowSlots, columns);
  const paging = useMemo(
    () =>
      roles
        ? groupTableHandles(rowSlots, columns, (row, column) =>
            roles.isFixed(row, column)
          )
        : { ok: false as const, reason: "invalid-grid" as const },
    // `roles` 由 `field`／尺寸推導，非 hook，故以原始依賴重算即可。
    [rowSlots, columns, field, roles]
  );

  const totalGroups = paging.ok ? paging.groups.length : 0;
  const safeGroup = Math.max(0, Math.min(group, Math.max(0, totalGroups - 1)));
  const current =
    paging.ok && totalGroups > 0 ? paging.groups[safeGroup] : undefined;
  const totalHandles = paging.ok ? paging.totalHandles : 0;
  const isCellMode = mode === "cell";

  const [jumpRow, setJumpRow] = useState(1);
  const [jumpColumn, setJumpColumn] = useState(1);
  // S2-R4 #2：跳至 fixed 格時顯示「已定位到所屬組」說明，不改 role、不創造把手、不聚焦別的格假裝成功。
  const [locatedNote, setLocatedNote] = useState<string | null>(null);

  // S2-R4（第二輪）#6：換表／換頁／換版本（欄位 ID、網格尺寸變化）時重置
  // 跳格選擇與定位說明，避免沿用上一張表的列欄編號造成錯位跳格。
  useEffect(() => {
    setJumpRow(1);
    setJumpColumn(1);
    setLocatedNote(null);
  }, [field.id, rowSlots, columns]);

  // S2-R4（第二輪）#6：角色改變（如整列改為 fixed）會讓組數變少；顯示用
  // `safeGroup` 雖已夾限，父層 state 仍可能停在已不存在的組。這裡把真實
  // state 拉回與顯示一致，避免「顯示第 1/1 組」但實際仍在第 3 組。
  useEffect(() => {
    if (!paging.ok) return;
    if (group !== safeGroup) onGroupChange(safeGroup);
  }, [paging.ok, group, safeGroup, onGroupChange]);

  const jumpToCell = (row: number, column: number) => {
    if (!paging.ok || !roles) return;
    const absolute = row * columns + column;
    const target = tableHandleGroupForCell(paging.groups, columns, row, column);
    if (target >= 0) onGroupChange(target);
    // S2-R4 #2：fixed 格只定位（切到所屬組）並說明，不切模式、不創造把手、不聚焦別的格；
    // 非 fixed 格才切到逐格模式並請求聚焦指定 index。
    if (!roles.isFixed(row, column)) {
      setLocatedNote(null);
      onModeChange("cell");
      onRequestFocus?.(absolute);
    } else {
      setLocatedNote(T.fixedCellLocated);
    }
  };

  return (
    <div id="editor-section-table" className="table-editing-controls" data-testid="table-editing-controls">
      <div className="te-mode-bar" role="group" aria-label={T.modeSwitchAria}>
        <button
          type="button"
          data-testid="mode-field"
          className={mode === "field" ? "is-active" : ""}
          aria-pressed={mode === "field"}
          onClick={() => onModeChange("field")}
        >
          {T.modeField}
        </button>
        <button
          type="button"
          data-testid="mode-gridline"
          className={mode === "gridline" ? "is-active" : ""}
          aria-pressed={mode === "gridline"}
          disabled={!paging.ok}
          onClick={() => onModeChange("gridline")}
        >
          {T.enterGridlineMode}
        </button>
        <button
          type="button"
          data-testid="mode-cell"
          className={mode === "cell" ? "is-active" : ""}
          aria-pressed={mode === "cell"}
          disabled={!paging.ok}
          onClick={() => onModeChange("cell")}
        >
          {T.enterCellMode}
        </button>
      </div>
      <p className="te-mode-hint">
        {mode === "field"
          ? T.modeHintField
          : mode === "gridline"
            ? T.modeHintGridline
            : T.modeHintCell}
      </p>

      {!paging.ok && (
        <p className="te-status te-status-warn" role="status">
          {T.invalidGridSize}
        </p>
      )}
      {paging.ok && totalHandles === 0 && (
        <p className="te-status" role="status">
          {T.emptyNoWritableCells}
        </p>
      )}

      {isCellMode && paging.ok && totalGroups > 0 && (
        <>
          <div className="te-group-nav" role="group" aria-label={T.groupNavAria}>
            <button
              type="button"
              data-testid="group-previous"
              disabled={group <= 0}
              aria-label={T.previousGroup}
              onClick={() => {
                setLocatedNote(null);
                onGroupChange(group - 1);
              }}
            >
              {T.previousGroup}
            </button>
            <span className="te-group-status" data-testid="group-status">
              {current
                ? T.groupStatus(
                    safeGroup + 1,
                    totalGroups,
                    (current.rows[0] ?? 0) + 1,
                    (current.rows[current.rows.length - 1] ?? 0) + 1,
                    current.handleCount
                  )
                : ""}
            </span>
            <button
              type="button"
              data-testid="group-next"
              disabled={group >= totalGroups - 1}
              aria-label={T.nextGroup}
              onClick={() => {
                setLocatedNote(null);
                onGroupChange(group + 1);
              }}
            >
              {T.nextGroup}
            </button>
            <p className="te-group-note">{T.groupPagingNote}</p>
          </div>
          {locatedNote && (
            <p className="te-status" role="status">
              {locatedNote}
            </p>
          )}

          <div className="te-jump">
            <label>{T.jumpToCell}</label>
            <select
              aria-label={T.rowSelectAria}
              value={jumpRow}
              onChange={event => setJumpRow(Number(event.target.value))}
            >
              {Array.from({ length: rowSlots }, (_, r) => (
                <option key={r} value={r + 1}>
                  {T.rowOption(r)}
                </option>
              ))}
            </select>
            <select
              aria-label={T.columnSelectAria}
              value={jumpColumn}
              onChange={event => setJumpColumn(Number(event.target.value))}
            >
              {Array.from({ length: columns }, (_, c) => (
                <option key={c} value={c + 1}>
                  {T.columnOption(c)}
                </option>
              ))}
            </select>
            <button
              type="button"
              data-testid="jump-go"
              onClick={() => jumpToCell(jumpRow - 1, jumpColumn - 1)}
            >
              {T.go}
            </button>
          </div>
        </>
      )}

      <div className="te-delete">
        <button
          type="button"
          data-testid="delete-table"
          className="te-delete-table"
          onClick={onDeleteTable}
        >
          {T.deleteTableTitle}
        </button>
      </div>
    </div>
  );
}
