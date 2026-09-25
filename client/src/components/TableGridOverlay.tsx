/**
 * UX-TPL-01 階段 2／S2-03：共享格線覆層（在「格線模式」下渲染）。
 *
 * 共享格線只在已儲存的座標確實對齊時開放調整。
 *
 * - 先做 raw＋derived 尺寸檢查，只有合法網格才會物化 guides、建立分隔線
 *   陣列、解析角色（S2-R3 第二輪：檢查必須在這些動作「之前」）。
 * - 每條分隔線（水平＝列間、垂直＝欄間）先以 `checkSharedGridline`
 *   檢驗是否「可證實共享對齊」；只有對齊者才可拖動，其餘灰色停用。
 *   判定來源一律是「已儲存的 raw guides」，顯示用的均分 fallback 不算證據。
 * - 拖動與鍵盤微調都只更新 preview，pointerup／Enter 才提交一次（一次 undo）；
 *   Esc 取消當次。拖動／微調錨點以「容器相對比例」保存，每次 move 都用
 *   當下的 rect 換算，拖動中捲動或縮放不會用過期 DOMRect 算錯位移。
 * - S2-R3（第三輪）：滑鼠與鍵盤的基準**分離**。滑鼠 delta 是從 pointerdown
 *   起點算起的絕對位移，必須每次回到「手勢起始幾何」重新計算；鍵盤每次
 *   方向鍵則從最新 preview 累加。兩者共用同一個基準會讓連續 pointermove
 *   重複累加（+4／+8／+12px 會變成 51%／53%／56%，提交 0.56）。
 * - S2-R4（第四輪）：**指標手勢進行期間忽略方向鍵微調**。指標與鍵盤同時
 *   作用於同一條線會錯位——`applyDelta` 若推進手勢基準，卻不同步指標起始
 *   錨點 `startRatioX/Y`，下一次 pointermove 會把既有位移再算一次
 *   （12px→53%、ArrowDown→54%、續移 4px 會變 58%，應 55%／忽略策略下 54%）。
 *   最小安全做法是讓兩種輸入在同一條線上**互斥**：手勢進行中方向鍵只阻止
 *   頁面捲動、不改變幾何；Enter 提交與 Esc 取消完全不受影響，純鍵盤微調與
 *   「先鍵盤 preview、再開始指標拖動」也維持原語意。
 * - 不對齊者絕不自動平均化，也不會寫入任何變更。
 *
 * 本元件不修改 shared 契約，也不碰 tableCellGuides 的格式。
 */

import * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FormField } from "@/lib/form-model";
import { tableCellGuidesForGrid } from "@/lib/form-model";
import {
  tableGridSize,
  type TableCellRect,
} from "@shared/tableGeometry";
import {
  checkSharedGridline,
  moveSharedGridline,
  type GridlineAxis,
} from "@/lib/tableGridEdit";
import { tableEditingText } from "@/lib/tableEditingMessages";
import {
  isLegalTableGridSize,
  rawTableGridStatus,
} from "@/lib/tableHandlePaging";
import { useI18n } from "@/lib/i18n";

/** 鍵盤微調步幅（容器比例）；按住 Shift 加大步幅，與逐格把手一致。 */
const GRIDLINE_KEY_STEP = 0.01;
const GRIDLINE_KEY_STEP_LARGE = 0.03;

export function TableGridOverlay({
  field,
  onCommit,
  onBusyChange,
}: {
  field: FormField;
  /** 提交一組完整的新 guides（未受影響項目與原陣列同一參照）。 */
  onCommit: (next: TableCellRect[]) => void;
  /**
   * S2-R1（第二輪）：把「是否有未提交的格線操作」告知父層，讓父層停用或
   * 先取消 Save／Undo／Redo 等衝突入口，不得暗中提交 preview。
   */
  onBusyChange?: (busy: boolean) => void;
}) {
  const { locale } = useI18n();
  const T = useMemo(() => tableEditingText(locale), [locale]);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  /**
   * S2-R1（第二輪）：抓取錨點以「容器相對比例」保存，不再保存開始時的
   * `boxRect`。比例對捲動／縮放不變，每次 move 用當下 rect 重新換算。
   */
  const gesture = useRef<{
    axis: GridlineAxis;
    boundary: number;
    startRatioX: number;
    startRatioY: number;
    /**
     * S2-R3（第三輪）：這次指標手勢「不變的起始幾何」。
     *
     * 滑鼠的 delta 是從 pointerdown 起點算起的**絕對**位移，因此每次
     * pointermove 都必須回到這個固定基準重新計算，不能再把它加進上一次
     * 已經移動過的 preview（舊行為：+4／+8／+12px 會得到 51%／53%／56%）。
     * 鍵盤微調則相反——每次方向鍵要從**最新 preview** 累加，兩者不能共用
     * 同一個基準。
     */
    startGuides: TableCellRect[];
    /** 手勢開始時是否已有未提交的 preview（決定移回起點時要還原到哪裡）。 */
    hadPreview: boolean;
  } | null>(null);
  const [preview, setPreview] = useState<TableCellRect[] | null>(null);

  const { rowSlots, columns } = tableGridSize(field, []);
  /**
   * S2-R3（第二輪）：raw＋derived 檢查必須在 guides 物化、分隔線陣列建立、
   * 任何維度迴圈之前完成。
   *
   * 上一輪的 `rawInvalid` 寫在兩個 guides `useMemo` 之後（等於先補了 guides
   * 才檢查），且 `horizontal`／`vertical` 分隔線陣列仍無條件建立。這裡改為
   * 先判定，非法時 rawGuides／displayGuides 直接是空陣列、分隔線陣列為空。
   */
  const gridInvalid =
    rawTableGridStatus({
      tableColumns: field.tableColumns,
      maxRows: field.maxRows,
    }) === "invalid" || !isLegalTableGridSize(rowSlots, columns);

  // S2-R3：rawGuides 只含「可證實已儲存」的 guide；缺漏視為 missing（不回填），
  // 絕不作為「原始幾何證據」。checkSharedGridline 只能依 rawGuides 判定。
  const rawGuides = useMemo<TableCellRect[]>(() => {
    if (gridInvalid) return [];
    const base = field.tableCellGuides;
    if (
      base &&
      Array.isArray(base) &&
      base.length === rowSlots * columns
    )
      return base as TableCellRect[];
    return [];
  }, [gridInvalid, field, rowSlots, columns]);
  // displayGuides：渲染／定位用的 fallback（缺漏時以均分回填顯示），
  // 不含缺失資訊、僅供定位；不是對齊證據。
  const displayGuides = useMemo<TableCellRect[]>(() => {
    if (gridInvalid) return [];
    if (rawGuides.length === rowSlots * columns) return rawGuides;
    return tableCellGuidesForGrid(
      field.tableCellGuides,
      rowSlots,
      columns
    ) as TableCellRect[];
  }, [gridInvalid, field, rowSlots, columns, rawGuides]);
  const display = preview ?? displayGuides;

  // 分隔線陣列：只在網格合法時建立（維度迴圈在守衛之後）。
  const horizontal = useMemo<number[]>(() => {
    if (gridInvalid) return [];
    const list: number[] = [];
    for (let b = 1; b < rowSlots; b += 1) list.push(b);
    return list;
  }, [gridInvalid, rowSlots]);
  const vertical = useMemo<number[]>(() => {
    if (gridInvalid) return [];
    const list: number[] = [];
    for (let b = 1; b < columns; b += 1) list.push(b);
    return list;
  }, [gridInvalid, columns]);

  /**
   * 鍵盤微調的基準：preview 優先，讓每次方向鍵從「目前可見的最新幾何」
   * 累加（S2-R1 第二輪的行為，第三輪保留）。
   *
   * 指標拖動**不能**用這個值：它會隨每次 pointermove 改變，配上「從起點
   * 算起」的絕對 delta 就會重複累加。指標一律使用 `gesture.current.startGuides`。
   */
  const sourceGuides = preview ?? rawGuides;

  // S2-R1（第二輪）：未提交的格線操作要讓父層知道（鍵盤微調沒有 pointer
  // gesture，只看 gesture.current 會漏掉）。
  useEffect(() => {
    onBusyChange?.(preview != null);
  }, [preview, onBusyChange]);

  // S2-R1（第二輪）：換表／網格尺寸變化／變成非法時取消未提交操作；
  // 正常提交後 field.id 與尺寸不變，effect 不會重跑，不會撤銷已完成結果。
  useEffect(() => {
    gesture.current = null;
    setPreview(null);
  }, [field.id, rowSlots, columns, gridInvalid]);

  // S2-R1（第二輪）：卸載（換表／換模式／換頁）時清除未提交操作並通知父層，
  // 避免父層的衝突入口永遠卡在停用狀態。
  const busyRef = useRef(onBusyChange);
  busyRef.current = onBusyChange;
  useEffect(
    () => () => {
      gesture.current = null;
      setPreview(null);
      busyRef.current?.(false);
    },
    []
  );

  // S2-R1 #6：拖動或鍵盤微調進行中按 Esc 取消當次（清除 preview＋gesture），
  // 並以 capture 階段阻止上層的模式切換處理器把元件卸載偽裝成「完成」。
  // 沒有未提交操作時不攔截 Esc。
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (!gesture.current && !preview) return;
      setPreview(null);
      gesture.current = null;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [preview]);

  const separatorRatio = (axis: GridlineAxis, boundary: number): number => {
    if (axis === "horizontal") {
      const g = display[(boundary - 1) * columns] ?? display[0];
      return g ? g.yRatio + g.heightRatio : 0;
    }
    const g = display[boundary - 1] ?? display[0];
    return g ? g.xRatio + g.widthRatio : 0;
  };

  /** 一條分隔線是否「可證實共享對齊」——只依已儲存的 raw guides 判定。 */
  const isAligned = (axis: GridlineAxis, boundary: number): boolean =>
    checkSharedGridline({
      guides: rawGuides,
      rowSlots,
      columns,
      axis,
      boundary,
    }).ok;

  /**
   * 以單一位移（ratio）從**指定基準**重算 guides；被安全拒絕時回傳 null
   * （呼叫方自行決定是否保留上一次 preview，不暗中提交）。
   */
  const computeDelta = (
    axis: GridlineAxis,
    boundary: number,
    delta: number,
    base: TableCellRect[]
  ): TableCellRect[] | null => {
    if (gridInvalid) return null;
    const result = moveSharedGridline({
      guides: base,
      rowSlots,
      columns,
      axis,
      boundary,
      delta,
    });
    if (!result.ok) return null;
    return result.guides as TableCellRect[];
  };

  /**
   * 鍵盤／共用入口：以目前可見幾何為基準累加。
   *
   * S2-R4（第四輪）：這裡**不再**推進 `gesture.current.startGuides`。該推進
   * 是第三輪為了「拖動中按方向鍵」加的，但它沒有同步指標起始錨點
   * `startRatioX/Y`，造成下一次 pointermove 把既有位移再算一次（58% vs 55%）。
   * 第四輪改為「手勢進行中忽略方向鍵」後，進入本函式時 `gesture.current`
   * 必為 null，這段推進已成為死碼——留著只會讓未來再次踩到同一個陷阱。
   */
  const applyDelta = (
    axis: GridlineAxis,
    boundary: number,
    delta: number
  ): boolean => {
    const next = computeDelta(axis, boundary, delta, sourceGuides);
    if (!next) return false;
    setPreview(next);
    return true;
  };

  /**
   * 指標拖動：每次 move 都從「手勢起始幾何」＋「從起點算起的絕對 delta」
   * 重新計算——不是把 delta 再加進上一次的 preview。
   */
  const applyPointerDelta = (
    current: NonNullable<typeof gesture.current>,
    delta: number
  ): void => {
    if (gridInvalid) return;
    if (delta === 0) {
      // 移回起點：還原到手勢開始時的可見幾何；若手勢開始時沒有任何未提交
      // preview，直接清除（零變更就不該產生一次 undo 項目）。
      setPreview(current.hadPreview ? current.startGuides : null);
      return;
    }
    const next = computeDelta(
      current.axis,
      current.boundary,
      delta,
      current.startGuides
    );
    // 被安全拒絕（夾限／不合法）時保留上一次 preview，不讓座標跳動。
    if (!next) return;
    setPreview(next);
  };

  const commitPreview = (): boolean => {
    if (!preview) return false;
    onCommit(preview);
    setPreview(null);
    gesture.current = null;
    return true;
  };

  const startDrag = (
    event: React.PointerEvent<HTMLElement>,
    axis: GridlineAxis,
    boundary: number
  ) => {
    event.stopPropagation();
    event.preventDefault();
    if (gridInvalid) return;
    const box = rootRef.current;
    if (!box) return;
    if (!isAligned(axis, boundary)) return; // 不對齊：不拖動，保留原座標
    const rect = box.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = {
      axis,
      boundary,
      startRatioX: (event.clientX - rect.left) / rect.width,
      startRatioY: (event.clientY - rect.top) / rect.height,
      // 這次手勢的固定基準＝當下可見幾何；若先前已有鍵盤 preview，就從它
      // 繼續，不會忽然跳回尚未提交的原始座標。
      startGuides: preview ?? rawGuides,
      hadPreview: preview != null,
    };
  };
  const moveDrag = (event: React.PointerEvent<HTMLElement>) => {
    const current = gesture.current;
    if (!current) return;
    // 以「當下」的容器 rect 換算，支援拖動中捲動／縮放（不用過期 DOMRect）。
    const box = rootRef.current;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const delta =
      current.axis === "horizontal"
        ? (event.clientY - rect.top) / rect.height - current.startRatioY
        : (event.clientX - rect.left) / rect.width - current.startRatioX;
    // 以「起始幾何＋絕對 delta」重算，不是把 delta 加進上一次 preview。
    applyPointerDelta(current, delta);
  };
  const endDrag = () => {
    // 有 preview 才提交（一次 undo）；沒有位移時只清掉手勢，不新增 undo。
    if (!commitPreview()) gesture.current = null;
  };
  const cancelDrag = () => {
    setPreview(null);
    gesture.current = null;
  };

  /**
   * S2-R4（第二輪）#8：分隔線的鍵盤可達性——`tabIndex=0` 可聚焦，方向鍵
   * 微調（水平線上下、垂直線左右）、Enter 提交一次、Esc 取消。與拖動同樣
   * 只接受「可證實共享對齊」的線，且以目前 preview 為基準累加。
   */
  const handleKeyDown = (
    event: React.KeyboardEvent<HTMLElement>,
    axis: GridlineAxis,
    boundary: number
  ) => {
    if (event.key === "Enter") {
      if (commitPreview()) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (event.key === "Escape") {
      // 交給上面的 window capture 處理器統一取消；這裡只阻止繼續冒泡。
      if (gesture.current || preview) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    const step = event.shiftKey
      ? GRIDLINE_KEY_STEP_LARGE
      : GRIDLINE_KEY_STEP;
    let delta: number | null = null;
    if (axis === "horizontal" && event.key === "ArrowUp") delta = -step;
    else if (axis === "horizontal" && event.key === "ArrowDown") delta = step;
    else if (axis === "vertical" && event.key === "ArrowLeft") delta = -step;
    else if (axis === "vertical" && event.key === "ArrowRight") delta = step;
    else return;
    // 已針對方向鍵 preventDefault／stopPropagation（避免手勢中捲動頁面、
    // 避免冒泡到上層快捷鍵），但不改變幾何。
    event.preventDefault();
    event.stopPropagation();
    /**
     * S2-R4（第四輪）：指標手勢進行中**忽略**方向鍵微調。
     *
     * 兩種輸入同時改同一條線會錯位（詳見檔案開頭註解）。Enter（提交）與
     * Esc（取消）在上方已處理完畢，因此這裡不會擋掉任何取消路徑。
     */
    if (gesture.current) return;
    if (gridInvalid) return;
    if (!isAligned(axis, boundary)) return; // 不對齊：鍵盤也不調整
    applyDelta(axis, boundary, delta);
  };

  const renderSeparator = (axis: GridlineAxis, boundary: number) => {
    const aligned = isAligned(axis, boundary);
    const ratio = separatorRatio(axis, boundary);
    const isHorizontal = axis === "horizontal";
    return (
      <span
        key={`${isHorizontal ? "h" : "v"}-${boundary}`}
        role="separator"
        tabIndex={0}
        aria-label={T.gridlineHandleAria(axis, boundary)}
        aria-disabled={!aligned}
        data-testid="table-gridline"
        data-axis={axis}
        data-boundary={boundary}
        data-aligned={aligned ? "true" : "false"}
        title={
          aligned
            ? T.modeHintGridline
            : isHorizontal
              ? T.gridlineNotAlignedH
              : T.gridlineNotAlignedV
        }
        className={`table-gridline-handle ${aligned ? "" : "is-disabled"}`}
        style={
          isHorizontal
            ? { top: `${ratio * 100}%` }
            : { left: `${ratio * 100}%` }
        }
        onPointerDown={event => startDrag(event, axis, boundary)}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={cancelDrag}
        onLostPointerCapture={() => {
          // 非正常失去指標捕獲：只在仍有未提交操作時取消。正常 pointerup
          // 之後 preview 已清空，這裡不會撤銷已完成的結果。
          if (gesture.current || preview) cancelDrag();
        }}
        onKeyDown={event => handleKeyDown(event, axis, boundary)}
      />
    );
  };

  return (
    <span ref={rootRef} className="table-gridline-overlay absolute inset-0">
      {horizontal.map(boundary => renderSeparator("horizontal", boundary))}
      {vertical.map(boundary => renderSeparator("vertical", boundary))}
    </span>
  );
}
