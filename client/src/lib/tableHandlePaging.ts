/**
 * UX-TPL-01 階段 2／S2-02：逐格把手的確定性邏輯分頁。
 *
 * 大型表格的把手按列分組，避免可編輯範圍被截斷。
 *
 * 核心不變量：
 * - 把手格集合由「合法網格尺寸＋角色」列舉，與 `tableCellGuides` 是否存在、
 *   捲動位置、縮放、視窗大小完全無關；guides 只提供每格座標。
 * - 分組必須在任何 `slice(0, MAX_TABLE_CELL_HANDLES)` 之前完成；
 *   每組把手 ≤ H=40 ≤ 60，進入編輯控制後不會再被截斷。
 * - 分組單位是「列」，不切斷一列；單列本身 ≥ H 時該列單獨成組。
 * - 非法、非有限或過大尺寸在列舉之前拒絕（不先建立巨大陣列）；
 *   缺省定義沿用既有 `positiveCount` 的合法 fallback，不擅自拒絕 legacy。
 *
 * 純函式：無 I/O、確定性、不修改任何輸入。
 */

/** 每組把手上限 H（固定常數；低於既有 60 上限，單屏可辨識）。 */
export const TABLE_HANDLE_GROUP_LIMIT = 40;

/**
 * 現有合法範圍：欄 1–30（`MAX_COLUMN_INDEX = 29`，A–AD）、列 1–100。
 * ≤30 欄配合 H=40 可證明同時存在的把手 DOM 絕對上界 = max(40, 30) = 40。
 */
export const MAX_TABLE_GRID_COLUMNS = 30;
export const MAX_TABLE_GRID_ROWS = 100;

export type TableHandleGroup = {
  /** 本組涵蓋的列（0-based，遞增）；全 fixed 列仍屬於組但不產生把手。 */
  rows: number[];
  /** 本組非 fixed 格的絕對 index（row*columns+column，row-major 遞增）。 */
  indexes: number[];
  /** = indexes.length（fixed 格不計入）。 */
  handleCount: number;
};

export type TableHandlePaging =
  | {
      ok: true;
      rowSlots: number;
      columns: number;
      groups: TableHandleGroup[];
      totalHandles: number;
    }
  | { ok: false; reason: "invalid-grid" };

/** 推導後的網格尺寸是否落在現有合法範圍（整數、1–100 列、1–30 欄）。 */
export function isLegalTableGridSize(
  rowSlots: unknown,
  columns: unknown
): boolean {
  return (
    typeof rowSlots === "number" &&
    typeof columns === "number" &&
    Number.isInteger(rowSlots) &&
    Number.isInteger(columns) &&
    rowSlots >= 1 &&
    rowSlots <= MAX_TABLE_GRID_ROWS &&
    columns >= 1 &&
    columns <= MAX_TABLE_GRID_COLUMNS
  );
}

/**
 * 在推導之前檢查 raw 定義（`tableColumns`／`maxRows`）。
 * `tableGridSize()` 不是 validator：`tableColumns=41` 仍回 41，
 * 因此入口必須先檢查 raw 值，不能依賴 geometry 自動驗證。
 *
 * - 缺省（undefined／null／""／0／負數以外的零值語義）沿用既有
 *   `positiveCount` fallback：視為「未定義」，合法。
 * - 有限、可 floor、在 1..max 範圍內 → 合法（與既有推導一致）。
 * - 非有限（NaN／Infinity）、非數字、> max → 非法。
 *   負數：既有 positiveCount 將其視為 0（缺省）；但明確負值屬損壞資料，
 *   這裡保守判非法，停止新互動並保留原資料。
 */
export function rawTableGridStatus(definition: {
  tableColumns?: unknown;
  maxRows?: unknown;
}): "ok" | "invalid" {
  const check = (value: unknown, max: number): "ok" | "invalid" => {
    if (value === undefined || value === null || value === "") return "ok";
    const count = Number(value);
    if (!Number.isFinite(count)) return "invalid";
    if (count === 0) return "ok"; // 既有 positiveCount 的缺省語義
    if (count < 0) return "invalid";
    if (count > max) return "invalid";
    return "ok";
  };
  if (check(definition.tableColumns, MAX_TABLE_GRID_COLUMNS) === "invalid")
    return "invalid";
  if (check(definition.maxRows, MAX_TABLE_GRID_ROWS) === "invalid")
    return "invalid";
  return "ok";
}

/**
 * 依 `(rowSlots, columns, isFixed)` 按列分組（不切斷一列）。
 *
 * 演算法（02 §3.2 擬碼，H 預設 40）：
 * 逐列累計非 fixed 格數；加入本列會超過 H 就先結束當前組；
 * 單列本身 ≥ H 時該列單獨成組。全表無任何非 fixed 格時回空組列表
 * （空狀態由 UI 顯示「目前沒有可調整的填寫格」，不渲染把手）。
 *
 * 非法尺寸在列舉之前拒絕，`isFixed` 不會被呼叫。
 */
export function groupTableHandles(
  rowSlots: number,
  columns: number,
  isFixed: (row: number, column: number) => boolean,
  limit: number = TABLE_HANDLE_GROUP_LIMIT
): TableHandlePaging {
  if (!isLegalTableGridSize(rowSlots, columns))
    return { ok: false, reason: "invalid-grid" };
  const safeLimit =
    Number.isInteger(limit) && limit >= 1 ? limit : TABLE_HANDLE_GROUP_LIMIT;

  const groups: TableHandleGroup[] = [];
  let currentRows: number[] = [];
  let currentIndexes: number[] = [];
  let totalHandles = 0;

  const flush = () => {
    if (!currentRows.length) return;
    groups.push({
      rows: currentRows,
      indexes: currentIndexes,
      handleCount: currentIndexes.length,
    });
    currentRows = [];
    currentIndexes = [];
  };

  for (let row = 0; row < rowSlots; row += 1) {
    const rowIndexes: number[] = [];
    for (let column = 0; column < columns; column += 1) {
      if (isFixed(row, column)) continue;
      rowIndexes.push(row * columns + column);
    }
    const n = rowIndexes.length;
    if (currentRows.length && currentIndexes.length + n > safeLimit) flush();
    currentRows.push(row);
    currentIndexes.push(...rowIndexes);
    totalHandles += n;
    if (n >= safeLimit) flush(); // 單列 ≥ H：單獨成組，不切斷
  }
  flush();

  if (totalHandles === 0)
    return { ok: true, rowSlots, columns, groups: [], totalHandles: 0 };
  return { ok: true, rowSlots, columns, groups, totalHandles };
}

/** 某列屬於哪一組（0-based 組 index）；找不到回 -1。 */
export function tableHandleGroupForRow(
  groups: readonly TableHandleGroup[],
  row: number
): number {
  if (!Number.isInteger(row) || row < 0) return -1;
  for (let index = 0; index < groups.length; index += 1)
    if (groups[index]!.rows.includes(row)) return index;
  return -1;
}

/**
 * 跳至格子：非 fixed 格由其絕對 index 找所屬組；
 * fixed 格不在任何組的 indexes 中，退回「所在列的組」
 * （只定位／說明，不改角色）。找不到回 -1。
 */
export function tableHandleGroupForCell(
  groups: readonly TableHandleGroup[],
  columns: number,
  row: number,
  column: number
): number {
  if (
    !Number.isInteger(columns) ||
    columns < 1 ||
    !Number.isInteger(row) ||
    !Number.isInteger(column) ||
    row < 0 ||
    column < 0 ||
    column >= columns
  )
    return -1;
  const absolute = row * columns + column;
  for (let index = 0; index < groups.length; index += 1)
    if (groups[index]!.indexes.includes(absolute)) return index;
  return tableHandleGroupForRow(groups, row);
}
