/**
 * 測量工作臺設計提醒：畫布須維持原始文件為視覺主體；Overlay 只使用精準線框與
 * 狀態色，讓使用者清楚區分 AI 建議、人工確認和目前選取欄位。
 */

import { ChevronDown } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FormField } from "@/lib/form-model";
import { cleanCharacterBoxes, tableCellGuidesForGrid, textGeometryWarning } from "@/lib/form-model";
import { percentToMillimeters } from "@shared/formGeometry";
import { fieldMarkStrokes, normalizeFieldMark } from "@shared/fieldMark";
import {
  isCheckboxValueChecked,
  isCheckboxOptionSelected,
  isSingleOptionSelected,
  knownOptions,
  normalizeOption,
  selectedSingleOption,
  toggleCheckboxOption,
} from "@shared/checkboxSelection";
import { createFieldRenderPlan } from "@shared/renderPlan";
import {
  tableCellRect,
  tableGridSize,
} from "@shared/tableGeometry";
import {
  resolveEffectiveTableGrid,
  resolveTableGridRoles,
} from "@shared/tableFormula";
import {
  groupTableHandles,
  isLegalTableGridSize,
  rawTableGridStatus,
} from "@/lib/tableHandlePaging";
import {
  tableEditingText,
} from "@/lib/tableEditingMessages";
import { useI18n } from "@/lib/i18n";
import { TableGridOverlay } from "@/components/TableGridOverlay";

type CanvasMode = "editor" | "fill" | "preview";

interface FormCanvasProps {
  practiceGuide?: { label: string; x:number; y:number; width:number; height:number; marks?: Array<{xRatio:number;yRatio:number;widthRatio:number;heightRatio:number}> };
  fields: FormField[];
  values: Record<string, string>;
  activeFieldId: string;
  onActivate: (id: string) => void;
  onUpdateField?: (
    id: string,
    patch: Partial<FormField>,
    opts?: { boundary?: boolean }
  ) => void;
  mode: CanvasMode;
  page?: number;
  pageWidthMm?: number;
  pageHeightMm?: number;
  backgroundUrl?: string;
  showDemoBackground?: boolean;
  backgroundMimeType?: string;
  zoom?: number;
  selectedFieldIds?: string[];
  onToggleSelection?: (id: string, additive: boolean) => void;
  onValueChange?: (id: string, value: string) => void;
  onDrawField?: (bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) => void;
  drawingEnabled?: boolean;
  /** A group reframe starts on the source page, not on an existing overlay. */
  suppressFieldInteraction?: boolean;
  snapToFields?: boolean;
  /** 階段 2／S2-01：三種互斥表格模式（欄位／格線／逐格）。 */
  tableEditMode?: "field" | "gridline" | "cell";
  /** 階段 2／S2-02：目前顯示的逐格把手分組（0-based）。 */
  tableActiveGroup?: number;
  /** 階段 2／S2-R4：要求聚焦的逐格把手絕對 index（跳格／換組後）。 */
  tableFocusIndex?: number | null;
  /** 階段 2／S2-R4：聚焦完成後回調，讓上層清除 pending focus。 */
  onTableFocusHandled?: () => void;
  /**
   * 階段 2／S2-R1（第二輪）：告知父層目前是否有「未提交的表格操作」
   * （整表拖動／鍵盤微調的 preview）。父層須據此停用或先取消 Save／Publish／
   * Undo／Redo／duplicate／刪除／換組／改角色等衝突入口，不得暗中提交 preview。
   */
  onTableGestureBusy?: (busy: boolean) => void;
}

/**
 * The tick/cross/dot/circle a selected option shows, drawn from the same geometry the PDF
 * renderer uses so the preview is a faithful proof of the printed result.
 */
function FieldMark({ field }: { field: FormField }) {
  const style = normalizeFieldMark(field.markStyle);
  // A unit box keeps the SVG resolution-independent; the ratios do the work.
  const mark = fieldMarkStrokes(style, 100, 100);
  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox="0 0 100 100"
      preserveAspectRatio={style === "circle" ? "none" : "xMidYMid meet"}
      aria-hidden="true"
    >
      {mark.outline ? (
        <ellipse
          cx={mark.centerX}
          cy={mark.centerY}
          rx={mark.outline.radiusX}
          ry={mark.outline.radiusY}
          fill="none"
          stroke="currentColor"
          strokeWidth={mark.strokeWidth}
        />
      ) : mark.radius > 0 ? (
        <circle cx={mark.centerX} cy={mark.centerY} r={mark.radius} fill="currentColor" />
      ) : (
        mark.lines.map((line, index) => (
          <line
            key={index}
            x1={line.x0}
            y1={line.y0}
            x2={line.x1}
            y2={line.y1}
            stroke="currentColor"
            strokeWidth={mark.strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))
      )}
    </svg>
  );
}

type DetectedRect = {
  xRatio: number;
  yRatio: number;
  widthRatio: number;
  heightRatio: number;
};

/**
 * How much of a field box may poke outside another and still count as being
 * inside it, in page percent. Detected geometry is never pixel-exact.
 */
const CONTAINMENT_TOLERANCE = 0.15;

/**
 * A field whose only interactive parts are its printed option squares.
 *
 * A multi-select row usually spans a whole printed line, and that line can
 * contain a writable blank sitting between two squares. While the whole
 * overlay took the clicks, that blank could never be reached while filling.
 */
function hasOptionHotspotsOnly(field: FormField) {
  return (
    (field.type === "radio" || field.type === "checkbox") &&
    Boolean(field.optionMarks?.length)
  );
}

function clampRatio(value: number) {
  return Math.max(0, Math.min(1, value));
}

/**
 * Per-mark drag handles for a radio field's `optionMarks` or a character-box
 * field's `detectionGroup`.
 *
 * AI-detected geometry is a guess: the box it places over a printed ✓ / □ can
 * sit a few pixels off, which prints a tick over the neighbouring text instead
 * of inside the square. Moving or resizing the whole field cannot fix that —
 * every mark shares the same field box — so each mark needs its own handle.
 * Dragging or nudging here writes straight back into the same array the PDF
 * renderer and the read-only preview already draw from.
 */
function MarkPositionEditor({
  field,
  arrayKey,
  marks,
  visibleIndexes,
  describeIndex,
  handleClassName,
  handleBadge,
  onUpdateField,
  commitOnPointerUp,
  onBusyChange,
}: {
  field: FormField;
  arrayKey: "optionMarks" | "detectionGroup" | "tableCellGuides";
  marks: DetectedRect[];
  /**
   * Which marks get a handle. Every mark when absent. Indexes stay absolute
   * so a hidden mark is never overwritten by a visible one.
   */
  visibleIndexes?: readonly number[];
  describeIndex?: (index: number) => string;
  handleClassName?: (index: number) => string;
  handleBadge?: (index: number) => React.ReactNode;
  onUpdateField: (
    id: string,
    patch: Partial<FormField>,
    opts?: { boundary?: boolean }
  ) => void;
  /** 階段 2／S2-04：拖動中只更新 preview，pointerup 才提交（一次 undo）；Esc 取消當次。 */
  commitOnPointerUp?: boolean;
  /**
   * S2-R1（第二輪）：把「是否有未提交的逐格操作」告知父層。鍵盤微調不會建立
   * pointer 手勢，父層必須靠這個訊號才能停用 Save／Undo／Redo 等衝突入口，
   * 而不是暗中把 preview 提交出去。
   */
  onBusyChange?: (busy: boolean) => void;
}) {
  const { tr } = useI18n();
  const visible = visibleIndexes ? new Set(visibleIndexes) : null;
  const gesture = useRef<{
    index: number;
    mode: "move" | "resize";
    /**
     * S2-R1（第二輪）：抓取錨點以「容器相對比例」保存，不再保存開始時的
     * DOMRect；每次 move 都以當下 rect 重新換算，支援拖動中捲動／縮放。
     */
    startRatioX: number;
    startRatioY: number;
    startMark: DetectedRect;
    startMarks: DetectedRect[];
  } | null>(null);
  const [preview, setPreviewState] = useState<DetectedRect[] | null>(null);
  // Pointer release must read the latest event, not a previous React render.
  const previewRef = useRef<DetectedRect[] | null>(null);
  const setPreview = (next: DetectedRect[] | null) => {
    previewRef.current = next;
    setPreviewState(next);
  };

  // S2-R1（第二輪）：未提交的逐格操作要讓父層知道（鍵盤微調沒有 pointer
  // gesture，只看手勢狀態會漏掉）。
  const busyRef = useRef(onBusyChange);
  busyRef.current = onBusyChange;
  useEffect(() => {
    onBusyChange?.(preview != null);
  }, [preview, onBusyChange]);
  // 卸載（換組／換模式／換頁／換表）時清除未提交操作並通知父層，避免父層
  // 的衝突入口永遠卡在停用狀態。
  useEffect(
    () => () => {
      busyRef.current?.(false);
    },
    []
  );

  const applyDelta = (event: React.PointerEvent<HTMLElement>) => {
    const current = gesture.current;
    if (!current) return;
    // S2-R1（第二輪）：以「當下」的容器 rect 換算指標比例，再減去抓取錨點
    // 比例；不再沿用開始時保存的 boxRect，拖動中捲動／縮放才會正確。
    const boxEl = event.currentTarget.parentElement;
    if (!boxEl) return;
    const rect = boxEl.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dx = (event.clientX - rect.left) / rect.width - current.startRatioX;
    const dy = (event.clientY - rect.top) / rect.height - current.startRatioY;
    const next: DetectedRect =
      current.mode === "resize"
        ? {
            ...current.startMark,
            widthRatio: clampRatio(
              Math.max(
                0.02,
                Math.min(
                  1 - current.startMark.xRatio,
                  current.startMark.widthRatio + dx
                )
              )
            ),
            heightRatio: clampRatio(
              Math.max(
                0.02,
                Math.min(
                  1 - current.startMark.yRatio,
                  current.startMark.heightRatio + dy
                )
              )
            ),
          }
        : {
            ...current.startMark,
            xRatio: clampRatio(
              Math.min(
                1 - current.startMark.widthRatio,
                current.startMark.xRatio + dx
              )
            ),
            yRatio: clampRatio(
              Math.min(
                1 - current.startMark.heightRatio,
                current.startMark.yRatio + dy
              )
            ),
          };
    const nextMarks = current.startMarks.map((mark, index) =>
      index === current.index ? { ...mark, ...next } : mark
    );
    if (commitOnPointerUp) {
      const unchanged = nextMarks.every((mark, index) => {
        const original = marks[index];
        return original && mark.xRatio === original.xRatio && mark.yRatio === original.yRatio &&
          mark.widthRatio === original.widthRatio && mark.heightRatio === original.heightRatio;
      });
      setPreview(unchanged ? null : nextMarks);
    }
    else onUpdateField(field.id, { [arrayKey]: nextMarks } as Partial<FormField>);
  };

  const nudge = (index: number, dx: number, dy: number) => {
    // 以 preview（若有）或原始 marks 為基準：commitOnPointerUp 時只更新
    // preview，不直寫正式 fields（S2-R1：表格鍵盤微調 preview-only）。
    const source = previewRef.current ?? marks;
    const base = source[index]!;
    const next: DetectedRect = {
      ...base,
      xRatio: clampRatio(
        Math.min(1 - base.widthRatio, Math.max(0, base.xRatio + dx))
      ),
      yRatio: clampRatio(
        Math.min(1 - base.heightRatio, Math.max(0, base.yRatio + dy))
      ),
    };
    const nextMarks = source.map((item, itemIndex) =>
      itemIndex === index ? { ...item, ...next } : item
    );
    if (commitOnPointerUp) setPreview(nextMarks);
    else
      onUpdateField(field.id, { [arrayKey]: nextMarks } as Partial<FormField>);
  };

  const commitPreview = () => {
    const pending = previewRef.current;
    if (!commitOnPointerUp || !pending) return;
    gesture.current = null;
    onUpdateField(
      field.id,
      { [arrayKey]: pending } as Partial<FormField>,
      { boundary: true }
    );
    setPreview(null);
  };

  return (
    <span className="absolute inset-0">
      {(preview ?? marks)
        .map((mark, index) => ({ mark, index }))
        .filter(item => !visible || visible.has(item.index))
        .map(({ mark, index }) => (
        <span
          key={index}
          role="button"
          tabIndex={0}
          data-cell-index={index}
          aria-label={
            describeIndex?.(index) ?? `${tr("調整第", "Adjust detected position")} ${index + 1}${tr(" 個偵測位置", "")}`
          }
          title={tr("拖動：移動位置；右下角：調整大小；方向鍵：微調（Shift 加大步幅）", "Drag to move, use the lower-right corner to resize, or use arrow keys to nudge (Shift for larger steps)")}
          className={`mark-position-handle ${handleClassName?.(index) ?? ""}`}
          style={{
            left: `${mark.xRatio * 100}%`,
            top: `${mark.yRatio * 100}%`,
            width: `${mark.widthRatio * 100}%`,
            height: `${mark.heightRatio * 100}%`,
          }}
          onPointerDown={event => {
            event.stopPropagation();
            event.preventDefault();
            const box = event.currentTarget.parentElement;
            if (!box) return;
            const boxRectNow = box.getBoundingClientRect();
            if (!boxRectNow.width || !boxRectNow.height) return;
            const source = previewRef.current ?? marks;
            event.currentTarget.setPointerCapture(event.pointerId);
            gesture.current = {
              index,
              mode:
                (event.target as HTMLElement).dataset.markResizeHandle ===
                "true"
                  ? "resize"
                  : "move",
              // 以當下 rect 換算比例錨點（對捲動／縮放不變）。
              startRatioX:
                (event.clientX - boxRectNow.left) / boxRectNow.width,
              startRatioY:
                (event.clientY - boxRectNow.top) / boxRectNow.height,
              startMark: { ...source[index] },
              startMarks: source.map(item => ({ ...item })),
            };
          }}
          onPointerMove={applyDelta}
          onPointerUp={event => {
            if (!gesture.current) return;
            // Also consume the release coordinates when the engine coalesced
            // the last move. Legacy non-table marks keep their existing path.
            if (commitOnPointerUp) applyDelta(event);
            commitPreview();
            gesture.current = null;
          }}
          onPointerCancel={() => {
            if (commitOnPointerUp) setPreview(null);
            gesture.current = null;
          }}
          onLostPointerCapture={() => {
            if (!gesture.current) return; // normal loss after release is not cancellation
            if (commitOnPointerUp) setPreview(null);
            gesture.current = null;
          }}
          onClick={event => event.stopPropagation()}
          onKeyDown={event => {
            if (event.key === "Escape" && commitOnPointerUp && (previewRef.current || gesture.current)) {
              // 手勢進行中按 Esc：取消當次預覽並清除 gesture ref，避免後續
              // pointermove 復活並保存（S2-R1）。不冒泡到模式切換處理器。
              setPreview(null);
              gesture.current = null;
              event.preventDefault();
              event.stopPropagation();
              event.nativeEvent.stopImmediatePropagation();
              return;
            }
            if (event.key === "Enter") {
              // 鍵盤微調後按 Enter 才提交一次（S2-R1：不等 Enter 不落盤）。
              if (commitOnPointerUp && previewRef.current) {
                commitPreview();
                event.preventDefault();
                event.stopPropagation();
              }
              return;
            }
            if (commitOnPointerUp && gesture.current &&
              ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
              event.preventDefault();
              event.stopPropagation();
              return; // match shared-gridline policy: do not mix pointer and arrow deltas
            }
            const step = event.shiftKey ? 0.03 : 0.01;
            if (event.key === "ArrowLeft") nudge(index, -step, 0);
            else if (event.key === "ArrowRight") nudge(index, step, 0);
            else if (event.key === "ArrowUp") nudge(index, 0, -step);
            else if (event.key === "ArrowDown") nudge(index, 0, step);
            else return;
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          {handleBadge?.(index)}
          <span
            data-mark-resize-handle="true"
            aria-hidden="true"
            className="mark-position-resize-handle"
          />
        </span>
        ))}
    </span>
  );
}

/**
 * The guides to show and edit. A table nobody has positioned yet, or one
 * whose row count has since changed, gets the even division to start from —
 * the very placement the renderer was already using, so showing the handles
 * changes nothing until one is actually dragged.
 */
function tableGuidesFor(field: FormField) {
  const { rowSlots, columns } = tableGridSize(field, []);
  return field.tableCellGuides?.length === rowSlots * columns
    ? field.tableCellGuides
    : tableCellGuidesForGrid(field.tableCellGuides, rowSlots, columns);
}

/**
 * 階段 2／S2-02：由「合法網格尺寸＋角色」決定當前組的絕對 index 集合。
 * 分頁（groupTableHandles，每組 ≤ H=40 ≤ 60）必須在任何 `.slice(0, N)`
 * 之前完成，確保 6×12 等大型表格的尾列（index 60–71）仍可達。
 *
 * 非法網格尺寸（如欄 > 30）回傳空陣列；由格線／逐格模式上層的安全錯誤處理。
 */
function tableGroupIndexes(field: FormField, groupIndex: number): number[] {
  const { rowSlots, columns } = tableGridSize(field, []);
  // S2-R3（第二輪）：與 TableEditingControls 同一套 raw＋derived 守衛，
  // 非法網格不解析角色、不枚舉把手。
  const gridInvalid =
    rawTableGridStatus({
      tableColumns: field.tableColumns,
      maxRows: field.maxRows,
    }) === "invalid" || !isLegalTableGridSize(rowSlots, columns);
  if (gridInvalid) return [];
  const roles = resolveTableGridRoles(field, rowSlots, columns);
  const paging = groupTableHandles(
    rowSlots,
    columns,
    (row, column) => roles.isFixed(row, column)
  );
  if (!paging.ok) return [];
  const safeGroup = Math.max(
    0,
    Math.min(groupIndex, paging.groups.length - 1)
  );
  return paging.groups[safeGroup]?.indexes ?? [];
}

function FieldContent({
  field,
  values,
}: {
  field: FormField;
  values: Record<string, string>;
}) {
  const { tr } = useI18n();
  const value = values[field.id];

  if (field.type === "radio" && field.optionMarks?.length) {
    return (
      <span className="pointer-events-none absolute inset-0">
        {field.optionMarks.map(mark => (
          <i
            key={`${field.id}-${mark.option}`}
            className="absolute grid place-items-center not-italic"
            style={{
              left: `${mark.xRatio * 100}%`,
              top: `${mark.yRatio * 100}%`,
              width: `${mark.widthRatio * 100}%`,
              height: `${mark.heightRatio * 100}%`,
            }}
          >
            {isSingleOptionSelected(value, field.options, mark.option) ? (
              <FieldMark field={field} />
            ) : null}
          </i>
        ))}
      </span>
    );
  }

  if (field.type === "characterBox") {
    const count = field.boxCount ?? 8;
    const characters = cleanCharacterBoxes(value || "")
      .padEnd(count, " ")
      .slice(0, count)
      .split("");
    if (field.detectionGroup?.length === count)
      return (
        <span className="pointer-events-none absolute inset-0">
          {field.detectionGroup.map((box, index) => (
            <i
              key={`${field.id}-${index}`}
              className="absolute grid place-items-center not-italic"
              style={{
                left: `${box.xRatio * 100}%`,
                top: `${box.yRatio * 100}%`,
                width: `${box.widthRatio * 100}%`,
                height: `${box.heightRatio * 100}%`,
              }}
            >
              {characters[index]}
            </i>
          ))}
        </span>
      );
    return (
      <span
        className="character-boxes"
        style={{ gridTemplateColumns: `repeat(${count},1fr)` }}
      >
        {characters.map((character, index) => (
          <i key={`${field.id}-${index}`}>{character}</i>
        ))}
      </span>
    );
  }

  if (field.type === "checkbox") {
    // A checkbox that covers a printed row of squares marks each ticked option
    // in its own box; a lone square keeps the single centred mark.
    if (field.optionMarks?.length)
      return (
        <span className="pointer-events-none absolute inset-0">
          {field.optionMarks.map(mark => (
            <i
              key={`${field.id}-${mark.option}`}
              className="absolute grid place-items-center not-italic"
              style={{
                left: `${mark.xRatio * 100}%`,
                top: `${mark.yRatio * 100}%`,
                width: `${mark.widthRatio * 100}%`,
                height: `${mark.heightRatio * 100}%`,
              }}
            >
              {isCheckboxOptionSelected(
                value || "",
                field.options,
                mark.option
              ) ? (
                <FieldMark field={field} />
              ) : null}
            </i>
          ))}
        </span>
      );
    return (
      <span className="check-preview">
        {isCheckboxValueChecked(value || "", field.options) ? <FieldMark field={field} /> : null}
      </span>
    );
  }

  if (field.type === "select") {
    // Normalised the same way the fill control and both PDF paths do, so one
    // stored value cannot appear differently in the four of them.
    const chosen = knownOptions(field.options).length
      ? selectedSingleOption(value, field.options)
      : value;
    return (
      <span className="field-value">
        {chosen || tr("選取", "Select")}
        <ChevronDown size={13} />
      </span>
    );
  }

  if (field.type === "table") {
    const { effectiveRows, cells, rowSlots, columns } = resolveEffectiveTableGrid(
      field,
      value || ""
    );
    return (
      <span className="pointer-events-none absolute inset-0">
        {Array.from({ length: columns * rowSlots }, (_, index) => {
          const row = Math.floor(index / columns);
          const column = index % columns;
          if (cells[row]?.[column]?.role === "fixed") return null;
          const text = String(effectiveRows[row]?.[column] ?? "");
          if (!text) return null;
          const rect = tableCellRect(
            field.tableCellGuides,
            rowSlots,
            columns,
            row,
            column
          );
          return (
            <i
              key={`${field.id}-${row}-${column}`}
              className="absolute flex items-center overflow-hidden px-0.5 not-italic"
              style={{
                left: `${rect.xRatio * 100}%`,
                top: `${rect.yRatio * 100}%`,
                width: `${rect.widthRatio * 100}%`,
                height: `${rect.heightRatio * 100}%`,
              }}
            >
              {text}
            </i>
          );
        })}
      </span>
    );
  }

  if (
    field.type === "image" ||
    (field.type === "signature" && value?.startsWith("asset-"))
  )
    return value ? (
      <img
        src={`/api/local/assets/${encodeURIComponent(value)}`}
        alt={field.label}
        className={`h-full w-full ${field.imageFit === "cover" ? "object-cover" : field.imageFit === "stretch" ? "object-fill" : "object-contain"}`}
      />
    ) : (
      <span className="field-value">
        {field.type === "signature" ? tr("簽名", "Signature") : tr("圖片", "Image")}
      </span>
    );
  if (field.type === "signature" && value?.startsWith("text:"))
    return <span className="field-value italic">{value.slice(5)}</span>;

  return <span className="field-value">{value || field.placeholder}</span>;
}

function CanvasFillControl({
  field,
  value,
  onChange,
  onActivate,
}: {
  field: FormField;
  value: string;
  onChange: (value: string) => void;
  onActivate: () => void;
}) {
  const common = {
    "aria-label": field.label,
    className: "canvas-direct-input",
    value,
  };
  if (field.type === "checkbox" && field.optionMarks?.length)
    // Every printed square in the row is its own toggle; ticking one leaves
    // the others alone, which is what a multi-select row means on paper.
    return (
      <span className="pointer-events-none absolute inset-0">
        {field.optionMarks.map(mark => {
          const selected = isCheckboxOptionSelected(
            value,
            field.options,
            mark.option
          );
          return (
            <button
              key={`${field.id}-${mark.option}`}
              type="button"
              aria-label={`${field.label}：${mark.option}`}
              aria-pressed={selected}
              title={mark.option}
              className="canvas-option-hotspot"
              style={{
                left: `${mark.xRatio * 100}%`,
                top: `${mark.yRatio * 100}%`,
                width: `${mark.widthRatio * 100}%`,
                height: `${mark.heightRatio * 100}%`,
              }}
              onClick={event => {
                event.stopPropagation();
                onChange(
                  toggleCheckboxOption(value, field.options, mark.option)
                );
              }}
            >
              {selected ? <FieldMark field={field} /> : null}
            </button>
          );
        })}
      </span>
    );
  if (field.type === "checkbox")
    return (
      <button
        aria-label={field.label}
        className="canvas-direct-open"
        type="button"
        onClick={() => onChange(isCheckboxValueChecked(value, field.options) ? "" : (knownOptions(field.options)[0] ?? "checked"))}
      >
        <FieldContent field={field} values={{ [field.id]: value }} />
      </button>
    );
  if (field.type === "radio" && field.optionMarks?.length)
    // Each detected option box is its own click target, so a person ticks the
    // square printed on the form rather than picking from a list that covers
    // it. Clicking the chosen one again clears the answer.
    return (
      <span className="pointer-events-none absolute inset-0">
        {field.optionMarks.map(mark => {
          const selected = isSingleOptionSelected(
            value,
            field.options,
            mark.option
          );
          return (
            <button
              key={`${field.id}-${mark.option}`}
              type="button"
              aria-label={`${field.label}：${mark.option}`}
              aria-pressed={selected}
              title={mark.option}
              className="canvas-option-hotspot"
              style={{
                left: `${mark.xRatio * 100}%`,
                top: `${mark.yRatio * 100}%`,
                width: `${mark.widthRatio * 100}%`,
                height: `${mark.heightRatio * 100}%`,
              }}
              onClick={event => {
                event.stopPropagation();
                onChange(selected ? "" : normalizeOption(mark.option));
              }}
            >
              {selected ? <FieldMark field={field} /> : null}
            </button>
          );
        })}
      </span>
    );
  if (field.type === "select" || field.type === "radio")
    return (
      <select
        {...common}
        // The options are normalised, so the value has to be too: a stored
        // value carrying stray whitespace matched no option and the control
        // showed blank while the panel and the PDF showed it chosen.
        value={selectedSingleOption(value, field.options)}
        onChange={event => onChange(event.target.value)}
      >
        <option value="" />
        {knownOptions(field.options).map(option => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  if (field.type === "textarea")
    return (
      <textarea
        {...common}
        maxLength={field.maxLength}
        onChange={event => onChange(event.target.value)}
      />
    );
  if (
    field.type === "image" ||
    field.type === "signature" ||
    field.type === "table" ||
    (field.type === "characterBox" && Boolean(field.detectionGroup?.length))
  )
    return (
      <button className="canvas-direct-open" type="button" onClick={onActivate}>
        <FieldContent field={field} values={{ [field.id]: value }} />
      </button>
    );
  return (
    <input
      {...common}
      type={
        field.type === "number"
          ? "number"
          : field.type === "date"
            ? "date"
            : field.type === "time"
              ? "time"
              : "text"
      }
      maxLength={field.type === "characterBox" ? undefined : field.maxLength}
      min={field.min}
      max={field.max}
      onChange={event =>
        onChange(
          field.type === "characterBox"
            ? cleanCharacterBoxes(event.target.value).slice(
                0,
                field.boxCount ?? 8
              )
            : event.target.value
        )
      }
    />
  );
}

export function FormCanvas({
  practiceGuide,
  fields,
  values,
  activeFieldId,
  onActivate,
  onUpdateField,
  mode,
  page = 1,
  pageWidthMm = 210,
  pageHeightMm = 297,
  backgroundUrl,
  showDemoBackground = true,
  backgroundMimeType,
  zoom = 1,
  selectedFieldIds = [],
  onToggleSelection,
  onValueChange,
  onDrawField,
  drawingEnabled = false,
  suppressFieldInteraction = false,
  snapToFields = false,
  tableEditMode = "field",
  tableActiveGroup = 0,
  tableFocusIndex = null,
  onTableFocusHandled,
  onTableGestureBusy,
}: FormCanvasProps) {
  const { locale, tr } = useI18n();
  const gesture = useRef<{
    id: string;
    mode: "move" | "resize";
    /**
     * S2-R1（第二輪）：抓取錨點以「頁面相對比例」保存，不再保存開始時的
     * DOMRect。比例對捲動與縮放不變，每次 move 會用當下的 rect 重新換算。
     */
    startRatioX: number;
    startRatioY: number;
    field: FormField;
    /** S2-R1：整表（欄位模式下的 table 欄位）手勢 preview-only 標記。 */
    isTableWhole?: boolean;
  } | null>(null);
  const drawing = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    pageRect: DOMRect;
  } | null>(null);
  const [draftBox, setDraftBox] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const [guides, setGuides] = useState<{ x?: number; y?: number }>({});
  // S2-R1（第二輪）：格線模式下的未提交操作（拖動／鍵盤微調）由
  // TableGridOverlay 回報，與整表／逐格 preview 合併成單一 busy 訊號給父層。
  const [gridlineBusy, setGridlineBusy] = useState(false);
  const [cellBusy, setCellBusy] = useState(false);
  // S2-R4（第二輪）#5：把手焦點查詢必須限定在「目前這一頁、目前這一張表」。
  const pageRef = useRef<HTMLDivElement | null>(null);
  // S2-R1：整表（欄位模式下的 table 欄位）拖動／微調 preview-only，pointerup/Enter 才提交。
  const [tablePreview, setTablePreview] = useState<{
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  // A page asset that is not served as an image must say so; a silently
  // blank sheet looks like the original form was lost.
  const [backgroundFailed, setBackgroundFailed] = useState(false);
  // 階段 2：本輪新增控制的三語文案；跟隨 i18n locale 更新（S2-R4）。
  const T = useMemo(() => tableEditingText(locale), [locale]);
  const pageFields = useMemo(
    () => fields.filter(field => (field.page ?? 1) === page),
    [fields, page]
  );
  /**
   * How many other fields on the page completely enclose each field.
   *
   * Stacking otherwise follows the order fields were created, which has
   * nothing to do with size: a large multi-select row created later covered a
   * small text field printed inside it, and that inner field could not be
   * clicked at all. Nesting depth lifts the inner field above whatever
   * encloses it while leaving the relative order of everything else alone.
   */
  const containmentDepth = useMemo(() => {
    const depth = new Map<string, number>();
    for (const field of pageFields) {
      const area = field.width * field.height;
      const right = field.x + field.width;
      const bottom = field.y + field.height;
      let enclosing = 0;
      for (const other of pageFields) {
        if (other.id === field.id) continue;
        if (other.width * other.height <= area) continue;
        if (
          other.x <= field.x + CONTAINMENT_TOLERANCE &&
          other.y <= field.y + CONTAINMENT_TOLERANCE &&
          other.x + other.width >= right - CONTAINMENT_TOLERANCE &&
          other.y + other.height >= bottom - CONTAINMENT_TOLERANCE
        )
          enclosing += 1;
      }
      depth.set(field.id, enclosing);
    }
    return depth;
  }, [pageFields]);
  const clamp = (value: number, lower: number, upper: number) =>
    Math.max(lower, Math.min(upper, value));
  // S2-R1：拖動進行中（含整表 preview）按 Esc 取消——清除 gesture／preview，
  // 不讓手勢復活，也不冒泡到上層的模式切換處理器。無手勢時不攔截 Esc。
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // S2-R1（第二輪）：純鍵盤微調不會建立 pointer gesture（gesture.current
      // 為 null），但仍有未提交的 tablePreview。原本只在 gesture.current 存在時
      // 清除，導致鍵盤微調無法取消。這裡兩者任一存在即取消，並阻止冒泡到
      // 上層模式切換；兩者皆無時不攔截 Esc，保留原有退出行為。
      if (!gesture.current && !tablePreview) return;
      gesture.current = null;
      setTablePreview(null);
      setGuides({});
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };
    // 必須用**捕獲階段**註冊：TemplateEditor 的模式／選取快捷鍵同樣掛在 window
    // （冒泡）。若這裡用冒泡，本 effect 會因 [tablePreview] 每次變更而重新註冊、
    // 排序落到 TemplateEditor 之後，Esc 會先被 TemplateEditor 消化成
    // 「逐格→格線→欄位→取消選取」，導致取消 preview 的同時把欄位選取也清掉
    // （.field-overlay.is-active 消失），破壞「Esc 只取消手勢、不改模式／選取」。
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [tablePreview]);
  // S2-R1（第二輪）：把「是否有未提交的表格操作」告知父層。父層據此停用或
  // 先取消 Save／Publish／Undo／Redo／duplicate／刪除／換組／改角色等衝突
  // 入口，不得暗中把 preview 提交出去。
  useEffect(() => {
    onTableGestureBusy?.(tablePreview != null || gridlineBusy || cellBusy);
  }, [tablePreview, gridlineBusy, cellBusy, onTableGestureBusy]);
  // S2-R1（第二輪）：換頁時讓手勢失去意義，必須取消未提交操作，不留下中間值。
  useEffect(() => {
    gesture.current = null;
    setTablePreview(null);
    setGuides({});
  }, [page]);
  // S2-R1（第二輪）：作用欄位換成別張表時，舊表的未提交 preview 不再有意義
  // （preview 以 field.id 為鍵，只會套用到原欄位），直接取消，避免 busy 訊號
  // 永遠卡住。同一個欄位的拖動中活化不會觸發（id 相同）。
  useEffect(() => {
    if (!tablePreview || tablePreview.id === activeFieldId) return;
    gesture.current = null;
    setTablePreview(null);
    setGuides({});
  }, [activeFieldId, tablePreview]);
  // S2-R1（第二輪）：卸載時同樣清除未提交操作。
  useEffect(
    () => () => {
      gesture.current = null;
      setTablePreview(null);
    },
    []
  );
  /**
   * S2-R4（第二輪）#5：把手查詢範圍。
   *
   * 原本直接對整份文件查 `.mark-position-handle`，會拿到別的頁／別的表的
   * 把手（例如選取多張表時拿到第一張的把手），造成「跳格」聚焦到錯誤的
   * 格子。這裡先在「本頁容器」內找「目前作用中的欄位」，再在其內部查把手。
   */
  const scopedHandles = (): HTMLElement[] => {
    const root: ParentNode = pageRef.current ?? document;
    const owner =
      activeFieldId != null
        ? (root as HTMLElement | Document).querySelector<HTMLElement>(
            `[data-field-id="${activeFieldId}"]`
          )
        : null;
    const scope: ParentNode = owner ?? root;
    return Array.from(
      scope.querySelectorAll<HTMLElement>(".mark-position-handle")
    );
  };
  // S2-R4：進入／切換逐格模式或換組時，把焦點移到本組第一個非 fixed 把手
  // （fixed 格不產生把手，故 handles[0] 即為第一個可寫把手），便於鍵盤操作。
  // 此 effect 依賴模式／組，不依賴 tableFocusIndex，避免跳格清除後重複搶焦。
  useLayoutEffect(() => {
    if (tableEditMode !== "cell") return;
    // Install at commit time, before another user focus can occur. Default
    // autofocus is only a convenience: a newer focus (e.g. Next group) wins.
    // A passive effect could subscribe too late and miss that newer focus.
    const focusDocument = pageRef.current?.ownerDocument ?? document;
    let superseded = false;
    const preserveNewFocus = () => {
      superseded = true;
      cancelAnimationFrame(raf);
      focusDocument.removeEventListener("focusin", preserveNewFocus, true);
    };
    const raf = requestAnimationFrame(() => {
      focusDocument.removeEventListener("focusin", preserveNewFocus, true);
      if (superseded) return;
      const handles = scopedHandles();
      if (handles.length) handles[0]!.focus();
    });
    focusDocument.addEventListener("focusin", preserveNewFocus, true);
    return () => {
      cancelAnimationFrame(raf);
      focusDocument.removeEventListener("focusin", preserveNewFocus, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableEditMode, tableActiveGroup]);
  // S2-R4 #1：跳至指定可寫／公式格——聚焦指定絕對 index（scrollIntoView），
  // 完成後回調上層清除 pending focus；此 effect 只在本輪跳格請求時作用，
  // 清除回 null 後不會重複搶焦（依賴項不含 tableEditMode／tableActiveGroup）。
  useEffect(() => {
    if (tableFocusIndex == null) return;
    const raf = requestAnimationFrame(() => {
      // S2-R4（第二輪）#5：同樣只在本頁／本表的把手內尋找目標 index，
      // 避免聚焦到別張表剛好同 index 的把手。
      const target =
        scopedHandles().find(
          h => h.getAttribute("data-cell-index") === String(tableFocusIndex)
        ) ?? null;
      if (target) {
        target.focus();
        target.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
      onTableFocusHandled?.();
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableFocusIndex, onTableFocusHandled]);
  const beginGesture = (
    event: React.PointerEvent<HTMLElement>,
    field: FormField
  ) => {
    if (mode !== "editor" || !onUpdateField) return;
    // S2-R1 #9：整表拖動只允許在欄位模式（tableEditMode==='field'）發生；
    // 格線／逐格模式下點擊表格空白不應移動整表。
    if (field.type === "table" && tableEditMode !== "field") return;
    const page = event.currentTarget.parentElement;
    if (!page) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    onActivate(field.id);
    const pageRectNow = page.getBoundingClientRect();
    gesture.current = {
      id: field.id,
      mode:
        (event.target as HTMLElement).dataset.resizeHandle === "true"
          ? "resize"
          : "move",
      // 以當下 rect 換算成頁面相對比例作為錨點；後續每次 move 都用「當下」的
      // rect 重新換算，因此拖動中捲動或縮放都不會沿用過期的 DOMRect。
      startRatioX: (event.clientX - pageRectNow.left) / pageRectNow.width,
      startRatioY: (event.clientY - pageRectNow.top) / pageRectNow.height,
      field,
      // S2-R1：欄位模式下的 table 欄位整表拖動 preview-only。
      isTableWhole: field.type === "table" && tableEditMode === "field",
    };
  };
  const updateGesture = (event: React.PointerEvent<HTMLElement>) => {
    const current = gesture.current;
    if (!current || !onUpdateField) return;
    // S2-R1（第二輪）：每次 move 重新取得「當下」的頁面 rect（捲動／縮放後
    // 尺寸與位置都會變），把指標換算成頁面相對比例後再減去抓取錨點比例。
    // 不可繼續使用手勢開始時保存的 DOMRect，也不可只因目標 ID 未變就視為正確。
    // 注意：區域變數命名為 pageEl，避免遮蔽外層的 page（頁碼）prop。
    const pageEl = event.currentTarget.parentElement;
    if (!pageEl) return;
    const rect = pageEl.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dx =
      ((event.clientX - rect.left) / rect.width - current.startRatioX) * 100;
    const dy =
      ((event.clientY - rect.top) / rect.height - current.startRatioY) * 100;
    // S2-R1：整表（欄位模式下的 table 欄位）拖動只更新 preview，不寫入 fields。
    if (current.isTableWhole) {
      if (current.mode === "resize") {
        setTablePreview({
          id: current.id,
          x: current.field.x,
          y: current.field.y,
          width: clamp(current.field.width + dx, 1, 100 - current.field.x),
          height: clamp(current.field.height + dy, 1, 100 - current.field.y),
        });
      } else {
        setTablePreview({
          id: current.id,
          x: clamp(current.field.x + dx, 0, 100 - current.field.width),
          y: clamp(current.field.y + dy, 0, 100 - current.field.height),
          width: current.field.width,
          height: current.field.height,
        });
      }
      return;
    }
    if (current.mode === "resize") {
      onUpdateField(current.id, {
        width: clamp(current.field.width + dx, 1, 100 - current.field.x),
        height: clamp(current.field.height + dy, 1, 100 - current.field.y),
      });
    } else {
      let x = clamp(current.field.x + dx, 0, 100 - current.field.width);
      let y = clamp(current.field.y + dy, 0, 100 - current.field.height);
      const nextGuides: { x?: number; y?: number } = {};
      if (snapToFields) {
        const others = fields.filter(
          field => field.id !== current.id && (field.page ?? 1) === page
        );
        const vertical = others.flatMap(field => [
          field.x,
          field.x + field.width / 2,
          field.x + field.width,
        ]);
        const horizontal = others.flatMap(field => [
          field.y,
          field.y + field.height / 2,
          field.y + field.height,
        ]);
        const currentVertical = [
          { value: x, offset: 0 },
          {
            value: x + current.field.width / 2,
            offset: current.field.width / 2,
          },
          { value: x + current.field.width, offset: current.field.width },
        ];
        const currentHorizontal = [
          { value: y, offset: 0 },
          {
            value: y + current.field.height / 2,
            offset: current.field.height / 2,
          },
          { value: y + current.field.height, offset: current.field.height },
        ];
        const xMatch = currentVertical
          .flatMap(edge =>
            vertical.map(target => ({
              distance: Math.abs(edge.value - target),
              target,
              offset: edge.offset,
            }))
          )
          .sort((a, b) => a.distance - b.distance)[0];
        const yMatch = currentHorizontal
          .flatMap(edge =>
            horizontal.map(target => ({
              distance: Math.abs(edge.value - target),
              target,
              offset: edge.offset,
            }))
          )
          .sort((a, b) => a.distance - b.distance)[0];
        if (xMatch && xMatch.distance <= 0.7) {
          x = clamp(
            xMatch.target - xMatch.offset,
            0,
            100 - current.field.width
          );
          nextGuides.x = xMatch.target;
        }
        if (yMatch && yMatch.distance <= 0.7) {
          y = clamp(
            yMatch.target - yMatch.offset,
            0,
            100 - current.field.height
          );
          nextGuides.y = yMatch.target;
        }
      }
      setGuides(nextGuides);
      onUpdateField(current.id, { x, y });
    }
  };
  const beginDrawing = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drawingEnabled || !onDrawField || event.target !== event.currentTarget)
      return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const pageRect = event.currentTarget.getBoundingClientRect();
    const x = clamp(
      ((event.clientX - pageRect.left) / pageRect.width) * 100,
      0,
      100
    );
    const y = clamp(
      ((event.clientY - pageRect.top) / pageRect.height) * 100,
      0,
      100
    );
    drawing.current = {
      pointerId: event.pointerId,
      startX: x,
      startY: y,
      pageRect,
    };
    setDraftBox({ x, y, width: 0, height: 0 });
  };
  const updateDrawing = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = drawing.current;
    if (!current) return;
    const x = clamp(
      ((event.clientX - current.pageRect.left) / current.pageRect.width) * 100,
      0,
      100
    );
    const y = clamp(
      ((event.clientY - current.pageRect.top) / current.pageRect.height) * 100,
      0,
      100
    );
    setDraftBox({
      x: Math.min(current.startX, x),
      y: Math.min(current.startY, y),
      width: Math.abs(x - current.startX),
      height: Math.abs(y - current.startY),
    });
  };
  const finishDrawing = () => {
    if (
      drawing.current &&
      draftBox &&
      draftBox.width >= 1 &&
      draftBox.height >= 1
    )
      onDrawField?.(draftBox);
    drawing.current = null;
    setDraftBox(null);
  };
  return (
    <div
      className="canvas-stage"
      aria-label={tr("原始表格與欄位 Overlay", "Original form and field overlay")}
      style={{ ["--page-zoom" as string]: String(zoom) }}
    >
      {/* The scaler takes the zoomed size in layout so the scroll container can
          reach every edge; transform alone leaves the top and left unreachable. */}
      <div
        className="page-scaler"
        style={{ aspectRatio: `${pageWidthMm} / ${pageHeightMm}` }}
      >
      <div
        ref={pageRef}
        className={`document-page ${drawingEnabled ? "cursor-crosshair" : ""}`}
        style={{
          aspectRatio: `${pageWidthMm} / ${pageHeightMm}`,
        }}
        onPointerDown={beginDrawing}
        onPointerMove={updateDrawing}
        onPointerUp={finishDrawing}
        onPointerCancel={finishDrawing}
      >
        {backgroundUrl &&
          (backgroundMimeType === "image/png" ||
            backgroundMimeType === "image/jpeg") && (
            <img
              src={backgroundUrl}
              alt={`${tr("Template 第", "Template page")} ${page} ${tr("頁背景", "background")}`}
              className="pointer-events-none absolute inset-0 h-full w-full object-fill"
              onLoad={() => setBackgroundFailed(false)}
              onError={() => setBackgroundFailed(true)}
            />
          )}
        {backgroundFailed && (
          <div className="background-error" role="status">
            {tr("原表背景無法顯示：此頁資產未以圖片格式保存。請重新啟動本機資料服務（start-formdigital-dev.cmd）後重新匯入此 Template。", "The original page cannot be displayed because it was not saved as an image. Restart the local data service and import this template again.")}
          </div>
        )}
        {backgroundUrl && backgroundMimeType === "application/pdf" && (
          <object
            data={`${backgroundUrl}#page=${page}&view=FitH`}
            type="application/pdf"
            aria-label={`${tr("Template 第", "Template page")} ${page} ${tr("頁 PDF 背景", "PDF background")}`}
            className="pointer-events-none absolute inset-0 h-full w-full"
          />
        )}
        {!backgroundUrl && showDemoBackground && (
          <>
            <div className="crop crop-tl" />
            <div className="crop crop-tr" />
            <div className="crop crop-bl" />
            <div className="crop crop-br" />
            <div className="paper-heading">
              <div className="paper-seal">U</div>
              <div>
                <small>STUDENT RECORDS OFFICE</small>
                <h3>在校成績及榮譽申報表</h3>
                <p>Statement of Academic Results and Honours</p>
              </div>
              <div className="paper-meta">
                <b>FORM</b>
                <span>SR-02 / 2026</span>
              </div>
            </div>
            <div className="paper-rule" />
            <p className="paper-instruction">
              請以正楷填寫，所有資料僅作學術行政用途。Please complete in BLOCK
              LETTERS.
            </p>
            <div className="paper-section">
              <b>A</b>
              <span>個人資料 / PERSONAL PARTICULARS</span>
            </div>
            <div className="paper-lines">
              <div>
                <span>姓名 Name</span>
                <em />
              </div>
              <div>
                <span>學生編號 Student ID</span>
                <em />
              </div>
              <div>
                <span>出生日期 Date of birth</span>
                <em />
              </div>
              <div>
                <span>性別 Gender</span>
                <em />
              </div>
              <div>
                <span>聯絡電話 Contact No.</span>
                <em />
              </div>
              <div>
                <span>電郵地址 E-mail</span>
                <em />
              </div>
            </div>
            <div className="paper-section lower">
              <b>B</b>
              <span>學術及課外紀錄 / ACHIEVEMENTS</span>
            </div>
            <div className="paper-table">
              <div className="paper-table-head">
                <span>年份 Year</span>
                <span>獎項／活動名稱 Award / Activity</span>
                <span>備註 Remark</span>
              </div>
              <div />
              <div />
              <div />
            </div>
            <div className="paper-declaration">
              <span>□ 本人確認上述資料正確。</span>
              <span>申請人簽署 Signature</span>
            </div>
          </>
        )}
        {mode === 'editor' && practiceGuide && <>
          <div className="practice-outline" data-testid="practice-outline" style={{left:`${practiceGuide.x}%`,top:`${practiceGuide.y}%`,width:`${practiceGuide.width}%`,height:`${practiceGuide.height}%`}} aria-hidden="true"><span className="practice-outline-label">{practiceGuide.label}</span></div>
          {practiceGuide.marks?.map((m,i)=><div key={i} className="practice-outline" aria-hidden="true" style={{left:`${practiceGuide.x+m.xRatio*practiceGuide.width}%`,top:`${practiceGuide.y+m.yRatio*practiceGuide.height}%`,width:`${m.widthRatio*practiceGuide.width}%`,height:`${m.heightRatio*practiceGuide.height}%`}}/>)}</>}

        {pageFields
          .map(field => {
            const active =
              field.id === activeFieldId || selectedFieldIds.includes(field.id);
            const stateClass =
              mode === "preview"
                ? "overlay-preview"
                : `overlay-${field.status}`;
            const renderPlan = createFieldRenderPlan({
              pageWidthMm,
              pageHeightMm,
              field: {
                xMm: percentToMillimeters(field.x, pageWidthMm),
                yMm: percentToMillimeters(field.y, pageHeightMm),
                widthMm: percentToMillimeters(field.width, pageWidthMm),
                heightMm: percentToMillimeters(field.height, pageHeightMm),
              },
            });
            // S2-R1：整表（欄位模式下的 table 欄位）拖動／微調 preview-only：
            // 進行中的 preview 優先於正式 coordinate 渲染。
            const previewBox =
              tablePreview?.id === field.id ? tablePreview : null;
            const geometryWarning = textGeometryWarning(field);
            return (
              <div
                role="group"
                tabIndex={mode === "editor" ? 0 : undefined}
                key={field.id}
                data-field-id={field.id}
                aria-label={`${tr("選取欄位：", "Select field: ")}${field.label}`}
                className={`field-overlay ${stateClass} ${mode === "fill" ? "field-fill" : ""} ${active ? "is-active" : ""} ${renderPlan.topPercent < 4 ? "label-below" : ""} ${mode === "fill" && hasOptionHotspotsOnly(field) ? "hotspot-only" : ""} ${geometryWarning ? "field-geometry-warning" : ""}`}
                data-text-geometry-warning={geometryWarning ?? undefined}
                onClick={event => {
                  if (
                    (event.target as HTMLElement).matches(
                      "input,select,textarea,button"
                    )
                  )
                    return;
                  onToggleSelection
                    ? onToggleSelection(
                        field.id,
                        event.shiftKey || event.metaKey || event.ctrlKey
                      )
                    : onActivate(field.id);
                }}
                onKeyDown={event => {
                  if (!onUpdateField || mode !== "editor") return;
                  const step = event.shiftKey ? 1 : 0.2;
                  // S2-R1：欄位模式下的 table 欄位整表微調 preview-only，
                  // 按 Enter 才提交一次（不等 Enter 不落盤）。
                  const isTableWhole =
                    field.type === "table" && tableEditMode === "field";
                  if (
                    event.key === "Enter" &&
                    isTableWhole &&
                    tablePreview?.id === field.id
                  ) {
                    onUpdateField(
                      field.id,
                      {
                        x: tablePreview.x,
                        y: tablePreview.y,
                        width: tablePreview.width,
                        height: tablePreview.height,
                      },
                      { boundary: true }
                    );
                    setTablePreview(null);
                    event.preventDefault();
                    return;
                  }
                  // S2-R1（第二輪）：整表鍵盤微調必須以「目前 preview」為基準累加。
                  // 原本 changes.x／y 由已提交的 field.x／field.y 重算，再用它覆寫
                  // base，導致同方向連按每次都得到同一個值、不會累積。
                  const previewBase =
                    isTableWhole && tablePreview?.id === field.id
                      ? tablePreview
                      : null;
                  const baseX = previewBase ? previewBase.x : field.x;
                  const baseY = previewBase ? previewBase.y : field.y;
                  const baseWidth = previewBase
                    ? previewBase.width
                    : field.width;
                  const baseHeight = previewBase
                    ? previewBase.height
                    : field.height;
                  const changes: Partial<Pick<FormField, "x" | "y">> = {};
                  if (event.key === "ArrowLeft")
                    changes.x = Math.max(0, baseX - step);
                  if (event.key === "ArrowRight")
                    changes.x = Math.min(100 - baseWidth, baseX + step);
                  if (event.key === "ArrowUp")
                    changes.y = Math.max(0, baseY - step);
                  if (event.key === "ArrowDown")
                    changes.y = Math.min(100 - baseHeight, baseY + step);
                  if (Object.keys(changes).length) {
                    event.preventDefault();
                    if (isTableWhole) {
                      // 以目前 preview 為基準累加；尚無 preview 時由 field 起算。
                      setTablePreview({
                        id: field.id,
                        x: changes.x ?? baseX,
                        y: changes.y ?? baseY,
                        width: baseWidth,
                        height: baseHeight,
                      });
                    } else {
                      onUpdateField(field.id, changes);
                    }
                  }
                }}
                onPointerDown={event => beginGesture(event, field)}
                onPointerMove={updateGesture}
                onPointerUp={() => {
                  if (
                    gesture.current?.isTableWhole &&
                    tablePreview &&
                    tablePreview.id === gesture.current.id
                  ) {
                    onUpdateField?.(
                      gesture.current.id,
                      {
                        x: tablePreview.x,
                        y: tablePreview.y,
                        width: tablePreview.width,
                        height: tablePreview.height,
                      },
                      { boundary: true }
                    );
                  }
                  setTablePreview(null);
                  gesture.current = null;
                  setGuides({});
                }}
                onPointerCancel={() => {
                  setTablePreview(null);
                  gesture.current = null;
                  setGuides({});
                }}
                onLostPointerCapture={() => {
                  // S2-R1（第二輪）：非正常失去指標捕獲時取消未提交操作。
                  // 正常 pointerup 之後 gesture.current 與 tablePreview 都已
                  // 清空，因此這裡不會撤銷已完成的結果。
                  if (gesture.current || tablePreview) {
                    gesture.current = null;
                    setTablePreview(null);
                    setGuides({});
                  }
                }}
                title={
                  mode === "editor" && onUpdateField
                    ? tr("拖拉移動；右下角調整大小；方向鍵微調", "Drag to move, use the lower-right corner to resize, or use arrow keys to nudge")
                    : undefined
                }
                style={{
                  left: `${previewBox ? previewBox.x : renderPlan.leftPercent}%`,
                  top: `${previewBox ? previewBox.y : renderPlan.topPercent}%`,
                  width: `${previewBox ? previewBox.width : renderPlan.widthPercent}%`,
                  height: `${previewBox ? previewBox.height : renderPlan.heightPercent}%`,
                  zIndex:
                    (field.zIndex ?? 1) +
                    (containmentDepth.get(field.id) ?? 0) * 1000,
                  fontWeight: field.bold ? 700 : undefined,
                  // The paper is a scaled preview, not a 96-dpi physical page.
                  // All input and table text must use the same pt-to-page ratio.
                  fontSize: `calc(var(--page-base-width) * ${(field.fontSizePt ?? 10) * 25.4 / 72 / pageWidthMm})`,
                  fontFamily: field.fontFamily,
                  lineHeight: `calc(var(--page-base-width) * ${(field.lineHeightPt ?? (field.fontSizePt ?? 10) * 1.2) * 25.4 / 72 / pageWidthMm})`,
                  letterSpacing: `calc(var(--page-base-width) * ${(field.letterSpacingPt ?? 0) * 25.4 / 72 / pageWidthMm})`,
                  textAlign: field.align ?? "left",
                  fontStyle: field.italic ? "italic" : undefined,
                  textDecoration: field.underline ? "underline" : undefined,
                  color: field.color,
                  pointerEvents:
                    drawingEnabled && suppressFieldInteraction
                      ? "none"
                      : undefined,
                  justifyContent:
                    field.align === "center"
                      ? "center"
                      : field.align === "right"
                        ? "flex-end"
                        : "flex-start",
                }}
              >
                {mode !== "preview" && (
                  <span className="field-label">{field.label}</span>
                )}
                {mode === "fill" && onValueChange ? (
                  <CanvasFillControl
                    field={field}
                    value={values[field.id] ?? ""}
                    onChange={value => onValueChange(field.id, value)}
                    onActivate={() => onActivate(field.id)}
                  />
                ) : (
                  <FieldContent field={field} values={values} />
                )}
                {mode === "editor" && onUpdateField && active && (
                  <span
                    data-resize-handle="true"
                    aria-hidden="true"
                    className="absolute -bottom-1.5 -right-1.5 h-3 w-3 border border-white bg-[#d9573b]"
                  />
                )}
                {mode === "editor" &&
                  onUpdateField &&
                  active &&
                  (field.type === "radio" || field.type === "checkbox") &&
                  field.optionMarks?.length ? (
                    <MarkPositionEditor
                      field={field}
                      arrayKey="optionMarks"
                      marks={field.optionMarks}
                      onUpdateField={onUpdateField}
                    />
                  ) : null}
                {mode === "editor" &&
                  onUpdateField &&
                  active &&
                  field.type === "table" &&
                  tableEditMode === "cell" ? (
                    <MarkPositionEditor
                      field={field}
                      arrayKey="tableCellGuides"
                      marks={tableGuidesFor(field)}
                      visibleIndexes={tableGroupIndexes(field, tableActiveGroup ?? 0)}
                      commitOnPointerUp
                      onBusyChange={setCellBusy}
                      describeIndex={index => {
                        const columns = tableGridSize(field, []).columns;
                        return T.cellHandleAria(
                          Math.floor(index / columns),
                          index % columns
                        );
                      }}
                      handleClassName={index => {
                        const { columns, rowSlots } = tableGridSize(field, []);
                        const row = Math.floor(index / columns);
                        const column = index % columns;
                        const roles = resolveTableGridRoles(field, rowSlots, columns);
                        return roles.isFormula(row, column)
                          ? "formula-cell-handle"
                          : "";
                      }}
                      handleBadge={index => {
                        const { columns, rowSlots } = tableGridSize(field, []);
                        const row = Math.floor(index / columns);
                        const column = index % columns;
                        const roles = resolveTableGridRoles(field, rowSlots, columns);
                        return roles.isFormula(row, column) ? (
                          <span className="formula-handle-badge">fx</span>
                        ) : null;
                      }}
                      onUpdateField={onUpdateField}
                    />
                  ) : null}
                {mode === "editor" &&
                  onUpdateField &&
                  active &&
                  field.type === "table" &&
                  tableEditMode === "gridline" ? (
                    <TableGridOverlay
                      field={field}
                      onBusyChange={setGridlineBusy}
                      onCommit={next =>
                        onUpdateField(
                          field.id,
                          {
                            tableCellGuides:
                              next as FormField["tableCellGuides"],
                          },
                          { boundary: true }
                        )
                      }
                    />
                  ) : null}
                {mode === "editor" &&
                  onUpdateField &&
                  active &&
                  field.type === "characterBox" &&
                  field.detectionGroup?.length === (field.boxCount ?? 8) ? (
                    <MarkPositionEditor
                      field={field}
                      arrayKey="detectionGroup"
                      marks={field.detectionGroup}
                      onUpdateField={onUpdateField}
                    />
                  ) : null}
              </div>
            );
          })}
        {guides.x !== undefined && (
          <span
            className="snap-guide snap-guide-x"
            style={{ left: `${guides.x}%` }}
          />
        )}
        {guides.y !== undefined && (
          <span
            className="snap-guide snap-guide-y"
            style={{ top: `${guides.y}%` }}
          />
        )}
        {draftBox && (
          <span
            className="draw-field-box"
            style={{
              left: `${draftBox.x}%`,
              top: `${draftBox.y}%`,
              width: `${draftBox.width}%`,
              height: `${draftBox.height}%`,
            }}
          />
        )}
      </div>
      </div>
    </div>
  );
}
