/**
 * UX-TPL-01 階段 2／S2-03：共享格線的安全調整。
 *
 * 只在共享邊界有充分座標證據時，才批量調整相鄰儲存格。
 *
 * `tableCellGuides` 每格獨立；批量移動只有在「邊界確實共享」時才安全。
 * 本模組提供兩個純函式：
 *
 * 1. `checkSharedGridline`：先檢驗——只接受「儲存資料可證實」的共享對齊邊界。
 *    缺 guide／無效 rect／不規則／不對齊 → 保守拒絕（UI 提示改用逐格）。
 *    絕不以顯示用的均分 fallback 冒充原始缺失 guide 已證實對齊。
 * 2. `moveSharedGridline`：後計算——以單一合法分隔線位置夾限後一次算出
 *    完整新陣列；呼叫方最後一次提交。沒移動或被拒絕時不產生任何變更。
 *
 * 純函式：無 I/O、確定性、不修改輸入；未受影響的陣列項目保持同一參照。
 */

import {
  tableCellGuideAt,
  type TableCellRect,
} from "@shared/tableGeometry";

/**
 * 共享一致性只處理 IEEE 浮點運算尾差（normalized ratio 1e-9）。
 * 不是把肉眼不對齊的格子用 0.5%／1px 平均吸附；不自動平均座標。
 */
export const SHARED_GRIDLINE_EPSILON = 1e-9;

/**
 * 最小尺寸策略：移動後每格尺寸必須「嚴格為正」（沿用 `tableCellGuideAt`
 * 對 widthRatio／heightRatio ≤ 0 的拒絕）。夾限時以此微量 guard 保證
 * 嚴格正值，而不設定任何較大可視下限——原已合法的小格不被強制撐大。
 */
export const GRIDLINE_MIN_SIZE_GUARD = 1e-12;

export type GridlineAxis = "horizontal" | "vertical";

export type SharedGridlineCheck =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "invalid-input"
        | "boundary-out-of-range"
        | "missing-guides"
        | "not-shared";
    };

export type SharedGridlineMove =
  | {
      ok: true;
      /** 完整新陣列：未受影響項目與原陣列同一參照（精確不變）。 */
      guides: unknown[];
      /** 受影響的絕對 index（相鄰兩列或兩欄的全部格）。 */
      changedIndexes: number[];
      /** 夾限後實際採用的位移（ratio）。 */
      delta: number;
    }
  | {
      ok: false;
      reason:
        | "invalid-input"
        | "boundary-out-of-range"
        | "missing-guides"
        | "not-shared"
        | "below-min-size"
        | "out-of-bounds"
        | "no-op";
    };

type GridlineInput = {
  guides: unknown;
  rowSlots: number;
  columns: number;
  axis: GridlineAxis;
  boundary: number;
};

function validateInput(input: GridlineInput): SharedGridlineCheck | null {
  const { rowSlots, columns, axis, boundary } = input;
  if (
    !Number.isInteger(rowSlots) ||
    !Number.isInteger(columns) ||
    rowSlots < 1 ||
    columns < 1 ||
    (axis !== "horizontal" && axis !== "vertical")
  )
    return { ok: false, reason: "invalid-input" };
  if (!Number.isFinite(boundary) || !Number.isInteger(boundary))
    return { ok: false, reason: "invalid-input" };
  const span = axis === "horizontal" ? rowSlots : columns;
  if (boundary < 1 || boundary > span - 1)
    return { ok: false, reason: "boundary-out-of-range" };
  return null;
}

/**
 * 檢驗一條分隔線是否「可證實共享」。
 *
 * 水平線（boundary = b，介於第 b-1 列與第 b 列之間）要求：
 * - 兩列每一格都有「已儲存且可繪製」的 guide（`tableCellGuideAt`）；
 * - 第 b-1 列所有格 yRatio 一致、heightRatio 一致（上緣是一條直線）；
 * - 第 b 列所有格 yRatio 一致（下緣是一條直線）；
 * - 每一對同欄相鄰格：`上格 yRatio + heightRatio ≈ 下格 yRatio`（≤ epsilon）。
 * 垂直線同理（xRatio／widthRatio）。任一不成立即拒絕。
 */
export function checkSharedGridline(
  input: GridlineInput
): SharedGridlineCheck {
  const invalid = validateInput(input);
  if (invalid) return invalid;
  const { guides, rowSlots, columns, axis, boundary } = input;
  if (!Array.isArray(guides)) return { ok: false, reason: "missing-guides" };

  const along = axis === "horizontal" ? columns : rowSlots;
  const at = (line: number, offset: number): TableCellRect | null => {
    const row = axis === "horizontal" ? line : offset;
    const column = axis === "horizontal" ? offset : line;
    if (row < 0 || row >= rowSlots || column < 0 || column >= columns)
      return null;
    return tableCellGuideAt(guides, row * columns + column);
  };

  const before: TableCellRect[] = [];
  const after: TableCellRect[] = [];
  for (let offset = 0; offset < along; offset += 1) {
    const upperOrLeft = at(boundary - 1, offset);
    const lowerOrRight = at(boundary, offset);
    if (!upperOrLeft || !lowerOrRight)
      return { ok: false, reason: "missing-guides" };
    before.push(upperOrLeft);
    after.push(lowerOrRight);
  }

  const startKey = axis === "horizontal" ? "yRatio" : "xRatio";
  const sizeKey = axis === "horizontal" ? "heightRatio" : "widthRatio";
  const firstBefore = before[0]!;
  const firstAfter = after[0]!;
  for (let offset = 0; offset < along; offset += 1) {
    const b = before[offset]!;
    const a = after[offset]!;
    if (Math.abs(b[startKey] - firstBefore[startKey]) > SHARED_GRIDLINE_EPSILON)
      return { ok: false, reason: "not-shared" };
    if (Math.abs(b[sizeKey] - firstBefore[sizeKey]) > SHARED_GRIDLINE_EPSILON)
      return { ok: false, reason: "not-shared" };
    if (Math.abs(a[startKey] - firstAfter[startKey]) > SHARED_GRIDLINE_EPSILON)
      return { ok: false, reason: "not-shared" };
    if (
      Math.abs(b[startKey] + b[sizeKey] - a[startKey]) >
      SHARED_GRIDLINE_EPSILON
    )
      return { ok: false, reason: "not-shared" };
  }
  return { ok: true };
}

/**
 * 計算一條可證實共享分隔線的移動結果。
 *
 * 水平線位移 delta（向下為正）：第 b-1 列 heightRatio += delta；
 * 第 b 列 yRatio += delta、heightRatio -= delta；兩側外邊界不動。
 * 垂直線同理（xRatio／widthRatio，向右為正）。
 *
 * 夾限：delta 被夾在「所有受影響格尺寸嚴格為正」的單一區間內，
 * 全列採用同一個 effective delta（不各格獨立 clamp）。
 * 之後逐格驗證：有限、寬高嚴格正值、位於 0–1 且右／下邊界不超出 1；
 * 任一違反即整體拒絕，不部分提交。
 */
export function moveSharedGridline(
  input: GridlineInput & { delta: number }
): SharedGridlineMove {
  const check = checkSharedGridline(input);
  if (!check.ok) return check;
  const { guides, rowSlots, columns, axis, boundary, delta } = input;
  if (!Number.isFinite(delta)) return { ok: false, reason: "invalid-input" };

  const along = axis === "horizontal" ? columns : rowSlots;
  const beforeIndexes: number[] = [];
  const afterIndexes: number[] = [];
  for (let offset = 0; offset < along; offset += 1) {
    const row = axis === "horizontal" ? boundary - 1 : offset;
    const column = axis === "horizontal" ? offset : boundary - 1;
    beforeIndexes.push(row * columns + column);
    const row2 = axis === "horizontal" ? boundary : offset;
    const column2 = axis === "horizontal" ? offset : boundary;
    afterIndexes.push(row2 * columns + column2);
  }

  const sizeKey = axis === "horizontal" ? "heightRatio" : "widthRatio";
  const startKey = axis === "horizontal" ? "yRatio" : "xRatio";
  const source = guides as unknown[];
  const rects = (indexes: number[]) =>
    indexes.map(index => tableCellGuideAt(source, index)!);

  const beforeRects = rects(beforeIndexes);
  const afterRects = rects(afterIndexes);
  const minBeforeSize = Math.min(...beforeRects.map(rect => rect[sizeKey]));
  const minAfterSize = Math.min(...afterRects.map(rect => rect[sizeKey]));

  // 單一合法區間：delta ∈ (-minBeforeSize, +minAfterSize)，再以 guard
  // 保證結果嚴格為正。原始尺寸退化到連 guard 都容不下時保守拒絕。
  const low = -minBeforeSize + GRIDLINE_MIN_SIZE_GUARD;
  const high = minAfterSize - GRIDLINE_MIN_SIZE_GUARD;
  if (low > high) return { ok: false, reason: "below-min-size" };
  const effective = Math.max(low, Math.min(high, delta));
  if (effective === 0) return { ok: false, reason: "no-op" };

  const next = source.slice();
  const changedIndexes = [...beforeIndexes, ...afterIndexes];
  for (let position = 0; position < along; position += 1) {
    const b = beforeRects[position]!;
    const a = afterRects[position]!;
    const nextBefore: TableCellRect = { ...b, [sizeKey]: b[sizeKey] + effective };
    const nextAfter: TableCellRect = {
      ...a,
      [startKey]: a[startKey] + effective,
      [sizeKey]: a[sizeKey] - effective,
    };
    for (const rect of [nextBefore, nextAfter]) {
      const values = [
        rect.xRatio,
        rect.yRatio,
        rect.widthRatio,
        rect.heightRatio,
      ];
      if (!values.every(Number.isFinite))
        return { ok: false, reason: "out-of-bounds" };
      if (rect.widthRatio <= 0 || rect.heightRatio <= 0)
        return { ok: false, reason: "out-of-bounds" };
      if (
        rect.xRatio < -SHARED_GRIDLINE_EPSILON ||
        rect.yRatio < -SHARED_GRIDLINE_EPSILON ||
        rect.xRatio > 1 + SHARED_GRIDLINE_EPSILON ||
        rect.yRatio > 1 + SHARED_GRIDLINE_EPSILON ||
        rect.xRatio + rect.widthRatio > 1 + SHARED_GRIDLINE_EPSILON ||
        rect.yRatio + rect.heightRatio > 1 + SHARED_GRIDLINE_EPSILON
      )
        return { ok: false, reason: "out-of-bounds" };
    }
    next[beforeIndexes[position]!] = nextBefore;
    next[afterIndexes[position]!] = nextAfter;
  }

  return { ok: true, guides: next, changedIndexes, delta: effective };
}
