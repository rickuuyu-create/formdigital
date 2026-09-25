import { describe, expect, it, vi } from "vitest";
import {
  groupTableHandles,
  isLegalTableGridSize,
  rawTableGridStatus,
  tableHandleGroupForCell,
  tableHandleGroupForRow,
  TABLE_HANDLE_GROUP_LIMIT,
} from "./tableHandlePaging";

/**
 * UX-TPL-01 階段 2／S2-02：72 格全部可達的確定性分組。
 * 測試 H=40 按列分組、index 由合法
 * 尺寸＋角色列舉、三個邊界、接線不變量「分頁在 slice(0,60) 之前」）。
 * 對應驗收：03 T-01（兩組 36、全 72 格有歸屬組）；提示詞 §5.2 分組單元。
 */

const noneFixed = () => false;

describe("tableHandlePaging 6x12 quotation grid (T-01)", () => {
  it("splits 6x12 all-writable into two row-groups of 36 handles, index 71 reachable", () => {
    const result = groupTableHandles(6, 12, noneFixed);
    if (!result.ok) throw new Error("expected ok paging");
    expect(result.groups).toHaveLength(2);
    expect(result.groups[0]!.rows).toEqual([0, 1, 2]);
    expect(result.groups[0]!.handleCount).toBe(36);
    expect(result.groups[1]!.rows).toEqual([3, 4, 5]);
    expect(result.groups[1]!.handleCount).toBe(36);
    expect(result.totalHandles).toBe(72);
    // 全 72 格皆恰好歸屬一組（不以 guides 是否存在決定格子數）
    const all = result.groups.flatMap(group => group.indexes);
    expect(all).toHaveLength(72);
    expect(new Set(all).size).toBe(72);
    expect(Math.min(...all)).toBe(0);
    expect(Math.max(...all)).toBe(71);
    expect(result.groups[1]!.indexes).toContain(71);
    // 每組不超過 H=40（DOM 有界證明）
    for (const group of result.groups)
      expect(group.handleCount).toBeLessThanOrEqual(TABLE_HANDLE_GROUP_LIMIT);
  });

  it("is deterministic and independent of zoom or guides (pure inputs only)", () => {
    const first = groupTableHandles(6, 12, noneFixed);
    const second = groupTableHandles(6, 12, noneFixed);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("keeps every last-row cell reachable like the first row (no slice(0,60) truncation)", () => {
    const result = groupTableHandles(6, 12, noneFixed);
    if (!result.ok) throw new Error("expected ok paging");
    // 舊路徑 slice(0,60) 會截斷至 index 59；新分組必須涵蓋 60..71
    for (let index = 60; index <= 71; index += 1)
      expect(result.groups[1]!.indexes).toContain(index);
  });
});

describe("tableHandlePaging mixed roles and boundaries", () => {
  it("excludes fixed cells from handle counts but keeps row membership", () => {
    // 第 1 列全 fixed，其餘可填：每列非 fixed 數 [0,12,12,12,12,12]
    const isFixed = (row: number, _column: number) => row === 0;
    const result = groupTableHandles(6, 12, isFixed);
    if (!result.ok) throw new Error("expected ok paging");
    expect(result.totalHandles).toBe(60);
    expect(result.groups).toHaveLength(2);
    expect(result.groups[0]!.rows).toEqual([0, 1, 2, 3]);
    expect(result.groups[0]!.handleCount).toBe(36);
    expect(result.groups[1]!.rows).toEqual([4, 5]);
    expect(result.groups[1]!.handleCount).toBe(24);
    // fixed 格不產生把手
    expect(result.groups[0]!.indexes).not.toContain(0);
    expect(result.groups[0]!.indexes).not.toContain(11);
  });

  it("returns zero groups for an all-fixed grid (empty state, no phantom handles)", () => {
    const result = groupTableHandles(6, 12, () => true);
    if (!result.ok) throw new Error("expected ok paging");
    expect(result.groups).toEqual([]);
    expect(result.totalHandles).toBe(0);
  });

  it("handles a single row of 30 columns as one group", () => {
    const result = groupTableHandles(1, 30, noneFixed);
    if (!result.ok) throw new Error("expected ok paging");
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.rows).toEqual([0]);
    expect(result.groups[0]!.handleCount).toBe(30);
  });

  it("never splits a row even when the row alone exceeds the limit", () => {
    // 合成小 limit 驗證「不切斷一列」：單列 4 格、limit 3 → 該列單獨成組
    const result = groupTableHandles(1, 4, noneFixed, 3);
    if (!result.ok) throw new Error("expected ok paging");
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.handleCount).toBe(4);
  });

  it("groups 100x30 within the DOM bound: every group <= max(H, columns)", () => {
    const result = groupTableHandles(100, 30, noneFixed);
    if (!result.ok) throw new Error("expected ok paging");
    expect(result.groups).toHaveLength(100);
    expect(result.totalHandles).toBe(3000);
    for (const group of result.groups) {
      expect(group.handleCount).toBeLessThanOrEqual(
        Math.max(TABLE_HANDLE_GROUP_LIMIT, 30)
      );
      expect(group.rows).toHaveLength(1);
    }
  });

  it("honours a custom limit deterministically (3x4 with limit 5)", () => {
    const result = groupTableHandles(3, 4, noneFixed, 5);
    if (!result.ok) throw new Error("expected ok paging");
    expect(result.groups).toHaveLength(3);
    expect(result.groups.map(group => group.handleCount)).toEqual([4, 4, 4]);
  });
});

describe("tableHandlePaging invalid grids stop before any enumeration", () => {
  it.each([
    [6, 41], // 欄 > 30（tableGridSize 不是 validator，41 欄仍回 41）
    [101, 12], // 列 > 100
    [Number.NaN, 12],
    [6, Number.NaN],
    [Number.POSITIVE_INFINITY, 12],
    [6, Number.POSITIVE_INFINITY],
    [0, 12],
    [6, 0],
    [-1, 5],
    [2.5, 12],
    [6, 2.5],
  ])("rejects %s x %s without calling isFixed", (rowSlots, columns) => {
    const isFixed = vi.fn(() => false);
    const result = groupTableHandles(rowSlots, columns, isFixed);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid-grid");
    expect(result.reason).toBe("invalid-grid");
    // 不能先建立巨大陣列才拒絕：非法尺寸在列舉前停止
    expect(isFixed).not.toHaveBeenCalled();
  });

  it("validates derived grid sizes", () => {
    expect(isLegalTableGridSize(6, 12)).toBe(true);
    expect(isLegalTableGridSize(1, 1)).toBe(true);
    expect(isLegalTableGridSize(100, 30)).toBe(true);
    expect(isLegalTableGridSize(101, 30)).toBe(false);
    expect(isLegalTableGridSize(100, 31)).toBe(false);
    expect(isLegalTableGridSize(0, 12)).toBe(false);
    expect(isLegalTableGridSize(6, 0)).toBe(false);
    expect(isLegalTableGridSize(Number.NaN, 12)).toBe(false);
    expect(isLegalTableGridSize(6, Number.POSITIVE_INFINITY)).toBe(false);
    expect(isLegalTableGridSize("6", 12)).toBe(false);
    expect(isLegalTableGridSize(2.5, 12)).toBe(false);
  });
});

describe("rawTableGridStatus checks raw definitions before derivation", () => {
  it("treats absent and zero-like definitions as legal legacy fallback", () => {
    expect(rawTableGridStatus({})).toBe("ok");
    expect(rawTableGridStatus({ tableColumns: undefined })).toBe("ok");
    expect(rawTableGridStatus({ maxRows: undefined })).toBe("ok");
    expect(rawTableGridStatus({ tableColumns: 0 })).toBe("ok");
    expect(rawTableGridStatus({ maxRows: 0 })).toBe("ok");
    expect(rawTableGridStatus({ tableColumns: "" })).toBe("ok");
  });

  it("accepts in-range finite definitions (floored like positiveCount)", () => {
    expect(rawTableGridStatus({ tableColumns: 12, maxRows: 6 })).toBe("ok");
    expect(rawTableGridStatus({ tableColumns: 30 })).toBe("ok");
    expect(rawTableGridStatus({ maxRows: 100 })).toBe("ok");
    expect(rawTableGridStatus({ tableColumns: 2.7 })).toBe("ok");
  });

  it("rejects illegal, non-finite or oversized raw definitions", () => {
    expect(rawTableGridStatus({ tableColumns: 41 })).toBe("invalid");
    expect(rawTableGridStatus({ tableColumns: 31 })).toBe("invalid");
    expect(rawTableGridStatus({ maxRows: 101 })).toBe("invalid");
    expect(rawTableGridStatus({ tableColumns: Number.NaN })).toBe("invalid");
    expect(rawTableGridStatus({ maxRows: Number.NaN })).toBe("invalid");
    expect(rawTableGridStatus({ tableColumns: Number.POSITIVE_INFINITY })).toBe(
      "invalid"
    );
    expect(rawTableGridStatus({ tableColumns: "abc" })).toBe("invalid");
    expect(rawTableGridStatus({ maxRows: -3 })).toBe("invalid");
  });
});

describe("tableHandlePaging group lookup for jump-to-cell", () => {
  const paging = groupTableHandles(6, 12, noneFixed);
  if (!paging.ok) throw new Error("expected ok paging");
  const groups = paging.groups;

  it("finds the group owning a row", () => {
    expect(tableHandleGroupForRow(groups, 0)).toBe(0);
    expect(tableHandleGroupForRow(groups, 2)).toBe(0);
    expect(tableHandleGroupForRow(groups, 3)).toBe(1);
    expect(tableHandleGroupForRow(groups, 5)).toBe(1);
    expect(tableHandleGroupForRow(groups, 99)).toBe(-1);
    expect(tableHandleGroupForRow(groups, -1)).toBe(-1);
  });

  it("finds the group owning a non-fixed cell (tail cell 6x12 -> group 2)", () => {
    expect(tableHandleGroupForCell(groups, 12, 5, 11)).toBe(1);
    expect(tableHandleGroupForCell(groups, 12, 0, 0)).toBe(0);
    expect(tableHandleGroupForCell(groups, 12, 2, 11)).toBe(0);
    expect(tableHandleGroupForCell(groups, 12, 99, 0)).toBe(-1);
  });

  it("locates a fixed cell by its row group without changing its role", () => {
    const mixed = groupTableHandles(6, 12, (row, column) => row === 4 && column === 3);
    if (!mixed.ok) throw new Error("expected ok paging");
    // 第 5 列第 4 格 fixed：不在任何組的 indexes，但所屬列在第 2 組
    expect(mixed.groups[1]!.indexes).not.toContain(4 * 12 + 3);
    expect(tableHandleGroupForCell(mixed.groups, 12, 4, 3)).toBe(1);
  });
});
