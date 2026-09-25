import { describe, expect, it } from "vitest";
import {
  checkSharedGridline,
  GRIDLINE_MIN_SIZE_GUARD,
  moveSharedGridline,
  SHARED_GRIDLINE_EPSILON,
} from "./tableGridEdit";

/**
 * UX-TPL-01 階段 2／S2-03：共享格線的安全調整（先檢驗、後計算、最後一次提交）。
 * 共享格線座標與批量調整的回歸測試：
 * - 水平線只影響相鄰兩列、垂直線只影響相鄰兩欄；
 * - 共同邊界一致且相鄰格幾何可證實才啟用（列高不等 ≠ 不對齊）；
 * - epsilon 只處理 IEEE 尾差（normalized ratio 1e-9），不自動平均座標；
 * - 缺 guide／無效 rect／不對齊 → 保守禁用批量，提示改用逐格；
 * - 不能僅因顯示採用 fallback 就宣稱原始缺失 guide 已證實對齊；
 * - 單一合法分隔線位置夾限，兩側外邊界不動；有限、嚴格正值、0–1 內；
 * - 最小尺寸策略：結果必須 > 0（沿用 tableCellGuideAt 有效性），
 *   不得以較大下限把原已合法的小格強制撐大。
 * 對應驗收：03 T-06（不對齊不移動）、T-07（對齊批量移動、一次 gesture）。
 */

type Rect = {
  xRatio: number;
  yRatio: number;
  widthRatio: number;
  heightRatio: number;
};

function cumsum(values: number[]): number[] {
  const out: number[] = [];
  let acc = 0;
  for (const value of values) {
    out.push(acc);
    acc += value;
  }
  return out;
}

/** 列高不等／欄寬不等但格線確實對齊的正控 fixture（每格皆有明確儲存 guide）。 */
function alignedGrid(heights: number[], widths: number[]): Rect[] {
  const ys = cumsum(heights);
  const xs = cumsum(widths);
  const guides: Rect[] = [];
  for (let row = 0; row < heights.length; row += 1)
    for (let column = 0; column < widths.length; column += 1)
      guides.push({
        xRatio: xs[column]!,
        yRatio: ys[row]!,
        widthRatio: widths[column]!,
        heightRatio: heights[row]!,
      });
  return guides;
}

/** 6×12：列高不等（0.1–0.25）、欄寬不等，水平及垂直邊界全部對齊。 */
const HEIGHTS = [0.2, 0.15, 0.25, 0.1, 0.2, 0.1];
const WIDTHS = [0.12, 0.08, 0.1, 0.06, 0.08, 0.09, 0.07, 0.1, 0.08, 0.06, 0.09, 0.07];

function fixture6x12() {
  return alignedGrid(HEIGHTS, WIDTHS);
}

describe("checkSharedGridline positive control (T-07): uneven but aligned", () => {
  it("accepts every horizontal boundary of the uneven-height aligned grid", () => {
    const guides = fixture6x12();
    for (let boundary = 1; boundary <= 5; boundary += 1) {
      const result = checkSharedGridline({
        guides,
        rowSlots: 6,
        columns: 12,
        axis: "horizontal",
        boundary,
      });
      expect(result.ok).toBe(true);
    }
  });

  it("accepts every vertical boundary of the uneven-width aligned grid", () => {
    const guides = fixture6x12();
    for (let boundary = 1; boundary <= 11; boundary += 1) {
      const result = checkSharedGridline({
        guides,
        rowSlots: 6,
        columns: 12,
        axis: "vertical",
        boundary,
      });
      expect(result.ok).toBe(true);
    }
  });

  it("tolerates IEEE float tails within the documented epsilon (1e-9)", () => {
    const guides = fixture6x12();
    // 第 3 列（index 2）下緣與第 4 列上緣差 5e-10 < 1e-9：仍視為共享
    const lower = guides[3 * 12 + 5]!;
    lower.yRatio = lower.yRatio + SHARED_GRIDLINE_EPSILON / 2;
    expect(
      checkSharedGridline({
        guides,
        rowSlots: 6,
        columns: 12,
        axis: "horizontal",
        boundary: 3,
      }).ok
    ).toBe(true);
  });

  it("rejects a pair drift beyond the epsilon (no 0.5%/1px snapping)", () => {
    const guides = fixture6x12();
    const lower = guides[3 * 12 + 5]!;
    lower.yRatio = lower.yRatio + SHARED_GRIDLINE_EPSILON * 2;
    const result = checkSharedGridline({
      guides,
      rowSlots: 6,
      columns: 12,
      axis: "horizontal",
      boundary: 3,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not-shared");
    expect(result.reason).toBe("not-shared");
  });
});

describe("checkSharedGridline negative controls (T-06)", () => {
  it("rejects when only the LAST column pair is misaligned (checks all pairs)", () => {
    const guides = fixture6x12();
    guides[2 * 12 + 11]!.heightRatio += 0.01; // 僅最後一對不對齊
    const result = checkSharedGridline({
      guides,
      rowSlots: 6,
      columns: 12,
      axis: "horizontal",
      boundary: 3,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not-shared");
    expect(result.reason).toBe("not-shared");
  });

  it("rejects a zigzag row even when each pair happens to align (no straight line)", () => {
    const guides = fixture6x12();
    // 第 3 列內第 6 格單獨加高、其下格同步下移：成對仍對齊，但列內不一致
    guides[2 * 12 + 11]!.heightRatio += 0.02;
    guides[3 * 12 + 11]!.yRatio += 0.02;
    const result = checkSharedGridline({
      guides,
      rowSlots: 6,
      columns: 12,
      axis: "horizontal",
      boundary: 3,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not-shared");
    expect(result.reason).toBe("not-shared");
  });

  it("refuses to claim alignment from display fallback when guides are missing", () => {
    // 均分 fallback 在顯示上是完美網格，但原始資料沒有 guide 可證實
    expect(
      checkSharedGridline({
        guides: undefined,
        rowSlots: 6,
        columns: 12,
        axis: "horizontal",
        boundary: 3,
      })
    ).toEqual({ ok: false, reason: "missing-guides" });
    expect(
      checkSharedGridline({
        guides: { not: "an array" },
        rowSlots: 6,
        columns: 12,
        axis: "horizontal",
        boundary: 3,
      })
    ).toEqual({ ok: false, reason: "missing-guides" });
  });

  it("rejects holes, invalid rects and non-finite coords at affected indexes", () => {
    const withHole = fixture6x12();
    delete (withHole as unknown[])[2 * 12 + 4];
    expect(
      checkSharedGridline({
        guides: withHole,
        rowSlots: 6,
        columns: 12,
        axis: "horizontal",
        boundary: 3,
      })
    ).toEqual({ ok: false, reason: "missing-guides" });

    const zeroHeight = fixture6x12();
    zeroHeight[3 * 12 + 4]!.heightRatio = 0;
    expect(
      checkSharedGridline({
        guides: zeroHeight,
        rowSlots: 6,
        columns: 12,
        axis: "horizontal",
        boundary: 3,
      })
    ).toEqual({ ok: false, reason: "missing-guides" });

    const nanRect = fixture6x12();
    nanRect[2 * 12 + 7]!.xRatio = Number.NaN;
    expect(
      checkSharedGridline({
        guides: nanRect,
        rowSlots: 6,
        columns: 12,
        axis: "horizontal",
        boundary: 3,
      })
    ).toEqual({ ok: false, reason: "missing-guides" });
  });

  it("validates axis, grid size and boundary before inspecting guides", () => {
    const guides = fixture6x12();
    for (const boundary of [0, 6, -1, 7]) {
      const result = checkSharedGridline({
        guides,
        rowSlots: 6,
        columns: 12,
        axis: "horizontal",
        boundary,
      });
      expect(result).toEqual({ ok: false, reason: "boundary-out-of-range" });
    }
    for (const boundary of [2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = checkSharedGridline({
        guides,
        rowSlots: 6,
        columns: 12,
        axis: "horizontal",
        boundary,
      });
      expect(result).toEqual({ ok: false, reason: "invalid-input" });
    }
    expect(
      checkSharedGridline({
        guides,
        rowSlots: 0,
        columns: 12,
        axis: "horizontal",
        boundary: 1,
      })
    ).toEqual({ ok: false, reason: "invalid-input" });
    expect(
      checkSharedGridline({
        guides,
        rowSlots: 6,
        columns: 12,
        axis: "diagonal" as "horizontal",
        boundary: 1,
      })
    ).toEqual({ ok: false, reason: "invalid-input" });
  });
});

describe("moveSharedGridline commit computation (T-07)", () => {
  it("moves one horizontal boundary: two adjacent rows change, others byte-identical", () => {
    const guides = fixture6x12();
    const snapshot = guides.map(rect => ({ ...rect }));
    const result = moveSharedGridline({
      guides,
      rowSlots: 6,
      columns: 12,
      axis: "horizontal",
      boundary: 3,
      delta: 0.02,
    });
    if (!result.ok) throw new Error("expected ok move");
    expect(result.delta).toBe(0.02);
    expect(result.changedIndexes).toHaveLength(24);
    // 第 3 列（row 2）：height +0.02；第 4 列（row 3）：y +0.02、height -0.02
    for (let column = 0; column < 12; column += 1) {
      const upper = result.guides[2 * 12 + column] as Rect;
      const lower = result.guides[3 * 12 + column] as Rect;
      expect(upper.heightRatio).toBeCloseTo(
        snapshot[2 * 12 + column]!.heightRatio + 0.02,
        12
      );
      expect(upper.yRatio).toBe(snapshot[2 * 12 + column]!.yRatio);
      expect(lower.yRatio).toBeCloseTo(
        snapshot[3 * 12 + column]!.yRatio + 0.02,
        12
      );
      expect(lower.heightRatio).toBeCloseTo(
        snapshot[3 * 12 + column]!.heightRatio - 0.02,
        12
      );
    }
    // 其他列：與原陣列同一物件參照，精確不變；角色／公式／欄列數不在此函式範圍
    for (let index = 0; index < guides.length; index += 1) {
      if (result.changedIndexes.includes(index)) continue;
      expect(result.guides[index]).toBe(guides[index] as never);
    }
    // 不修改輸入陣列
    expect(guides[2 * 12 + 3]).toEqual(snapshot[2 * 12 + 3]);
  });

  it("moves one vertical boundary: two adjacent columns change, others identical", () => {
    const guides = fixture6x12();
    const snapshot = guides.map(rect => ({ ...rect }));
    const result = moveSharedGridline({
      guides,
      rowSlots: 6,
      columns: 12,
      axis: "vertical",
      boundary: 1,
      delta: -0.01,
    });
    if (!result.ok) throw new Error("expected ok move");
    expect(result.changedIndexes).toHaveLength(12);
    for (let row = 0; row < 6; row += 1) {
      const left = result.guides[row * 12] as Rect;
      const right = result.guides[row * 12 + 1] as Rect;
      expect(left.widthRatio).toBeCloseTo(
        snapshot[row * 12]!.widthRatio - 0.01,
        12
      );
      expect(right.xRatio).toBeCloseTo(snapshot[row * 12 + 1]!.xRatio - 0.01, 12);
      expect(right.widthRatio).toBeCloseTo(
        snapshot[row * 12 + 1]!.widthRatio + 0.01,
        12
      );
    }
  });

  it("keeps the moved boundary a single straight line (no per-cell clamp cracks)", () => {
    const guides = fixture6x12();
    const result = moveSharedGridline({
      guides,
      rowSlots: 6,
      columns: 12,
      axis: "horizontal",
      boundary: 3,
      delta: 0.03,
    });
    if (!result.ok) throw new Error("expected ok move");
    const upperHeights = new Set(
      Array.from({ length: 12 }, (_, c) => (result.guides[2 * 12 + c] as Rect).heightRatio)
    );
    const lowerTops = new Set(
      Array.from({ length: 12 }, (_, c) => (result.guides[3 * 12 + c] as Rect).yRatio)
    );
    expect(upperHeights.size).toBe(1);
    expect(lowerTops.size).toBe(1);
    // 邊界兩側精確相接（原資料精確對齊時，結果也精確對齊）
    for (let column = 0; column < 12; column += 1) {
      const upper = result.guides[2 * 12 + column] as Rect;
      const lower = result.guides[3 * 12 + column] as Rect;
      expect(upper.yRatio + upper.heightRatio).toBe(lower.yRatio);
    }
  });

  it("clamps to a single legal separator position, sizes stay strictly positive", () => {
    const guides = fixture6x12();
    const result = moveSharedGridline({
      guides,
      rowSlots: 6,
      columns: 12,
      axis: "horizontal",
      boundary: 3,
      delta: 0.5, // 第 4 列高只有 0.1
    });
    if (!result.ok) throw new Error("expected ok move");
    expect(result.delta).toBeCloseTo(0.1 - GRIDLINE_MIN_SIZE_GUARD, 15);
    for (let column = 0; column < 12; column += 1) {
      const lower = result.guides[3 * 12 + column] as Rect;
      expect(lower.heightRatio).toBeGreaterThan(0);
      expect(Number.isFinite(lower.heightRatio)).toBe(true);
      expect(lower.yRatio + lower.heightRatio).toBeLessThanOrEqual(1);
    }
  });

  it("does not force-stretch an originally small but legal cell", () => {
    // 5 列 × 2 欄，第 3 列高原僅 0.005（合法）；上拖時只縮小，不撐大到任何下限
    const guides = alignedGrid([0.25, 0.25, 0.005, 0.245, 0.25], [0.5, 0.5]);
    const result = moveSharedGridline({
      guides,
      rowSlots: 5,
      columns: 2,
      axis: "horizontal",
      boundary: 3,
      delta: -0.1,
    });
    if (!result.ok) throw new Error("expected ok move");
    const upper = result.guides[2 * 2] as Rect;
    expect(upper.heightRatio).toBeLessThan(0.005);
    expect(upper.heightRatio).toBeGreaterThan(0);
  });

  it("reports a no-op delta without producing changes", () => {
    const guides = fixture6x12();
    const result = moveSharedGridline({
      guides,
      rowSlots: 6,
      columns: 12,
      axis: "horizontal",
      boundary: 3,
      delta: 0,
    });
    expect(result).toEqual({ ok: false, reason: "no-op" });
  });

  it("propagates the not-shared refusal instead of moving (T-06)", () => {
    const guides = fixture6x12();
    guides[2 * 12 + 11]!.heightRatio += 0.01;
    const result = moveSharedGridline({
      guides,
      rowSlots: 6,
      columns: 12,
      axis: "horizontal",
      boundary: 3,
      delta: 0.02,
    });
    expect(result).toEqual({ ok: false, reason: "not-shared" });
    // 所有座標維持原樣
    expect(guides[2 * 12 + 11]!.heightRatio).toBeCloseTo(0.26, 12);
  });

  it("rejects a move that would leave affected cells outside 0..1", () => {
    // 原始資料最後一列底部已超出 1（非法但對齊）；移動不得默默接受
    const guides = alignedGrid([0.2, 0.15, 0.25, 0.15, 0.2, 0.15], [1]);
    const result = moveSharedGridline({
      guides,
      rowSlots: 6,
      columns: 1,
      axis: "horizontal",
      boundary: 5,
      delta: 0.01,
    });
    expect(result).toEqual({ ok: false, reason: "out-of-bounds" });
  });

  it("rejects degenerate originals instead of clamping them into existence", () => {
    const guides = alignedGrid([4e-13, 3e-13], [1]);
    const result = moveSharedGridline({
      guides,
      rowSlots: 2,
      columns: 1,
      axis: "horizontal",
      boundary: 1,
      delta: 0.001,
    });
    expect(result).toEqual({ ok: false, reason: "below-min-size" });
  });

  it("rejects non-finite deltas", () => {
    const guides = fixture6x12();
    for (const delta of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = moveSharedGridline({
        guides,
        rowSlots: 6,
        columns: 12,
        axis: "horizontal",
        boundary: 3,
        delta,
      });
      expect(result).toEqual({ ok: false, reason: "invalid-input" });
    }
  });

  it("works on a fully materialized uniform 6x12 grid (explicit guides)", () => {
    const guides = alignedGrid(
      Array.from({ length: 6 }, () => 1 / 6),
      Array.from({ length: 12 }, () => 1 / 12)
    );
    const check = checkSharedGridline({
      guides,
      rowSlots: 6,
      columns: 12,
      axis: "horizontal",
      boundary: 1,
    });
    expect(check.ok).toBe(true);
    const result = moveSharedGridline({
      guides,
      rowSlots: 6,
      columns: 12,
      axis: "horizontal",
      boundary: 1,
      delta: 0.02,
    });
    if (!result.ok) throw new Error("expected ok move");
    expect(result.changedIndexes).toHaveLength(24);
  });

  it("preserves holes and array shape outside the affected rows", () => {
    const guides = fixture6x12();
    delete (guides as unknown[])[5 * 12]; // 第 6 列第 1 格無 guide（不受影響列）
    const result = moveSharedGridline({
      guides,
      rowSlots: 6,
      columns: 12,
      axis: "horizontal",
      boundary: 3,
      delta: 0.02,
    });
    if (!result.ok) throw new Error("expected ok move");
    expect(result.guides).toHaveLength(guides.length);
    expect(5 * 12 in result.guides).toBe(false);
  });
});
