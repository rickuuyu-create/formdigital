import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  Download,
  Eraser,
  FileJson,
  FileSpreadsheet,
  Image,
  PenLine,
  Plus,
  Printer,
  Save,
  Trash2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { toast } from "sonner";
import { FormCanvas } from "@/components/FormCanvas";
import { PracticeFillGuide } from './TemplatePractice';
import { isPracticeTemplate } from '@/lib/template-practice';
import { trpc } from "@/lib/trpc";
import { useI18n } from "@/lib/i18n";
import {
  isCheckboxChecked,
  isCheckboxOptionSelected,
  isSingleOptionSelected,
  knownOptions,
  selectedSingleOption,
  toggleCheckboxOption,
} from "@shared/checkboxSelection";
import { resolveEffectiveTableGrid } from "@shared/tableFormula";
import { translateServerMessage } from "@/lib/server-messages";
import {
  blobToBase64,
  downloadPdfPagesAsImages,
  downloadUrl,
  openLocalOutput,
} from "@/lib/document-files";
import {
  pageManifestOf,
  toCanvasFields,
  type FieldRecord,
  type InstanceRecord,
  type SavedValueRecord,
  type TemplateRecord,
  type VersionRecord,
} from "@/lib/product-types";
import {
  cleanCharacterBoxes,
  fieldTypeLabel,
  validateValues,
  type FormField,
} from "@/lib/form-model";

function instanceName(
  pattern: string,
  template: TemplateRecord,
  version: VersionRecord,
  fields: FormField[],
  values: Record<string, string>
) {
  const now = new Date();
  let output = pattern || "{Template名稱}_{日期}_{時間}";
  output = output
    .replaceAll("{Template名稱}", template.name)
    .replaceAll("{Template版本}", `v${version.versionNumber}`)
    .replaceAll("{日期}", now.toISOString().slice(0, 10))
    .replaceAll("{時間}", now.toTimeString().slice(0, 5).replace(":", "-"));
  for (const field of fields)
    output = output.replaceAll(`{${field.label}}`, values[field.id] || "");
  return (
    output
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 255) || `Instance_${now.getTime()}`
  );
}

function FixedTableEditor({
  field,
  columns,
  rowSlots,
  rows,
  onChange,
}: {
  field: FormField;
  columns: string[];
  rowSlots: number;
  rows: string[][];
  onChange: (rows: string[][]) => void;
}) {
  const { tr, locale } = useI18n();
  const resolution = useMemo(
    () => resolveEffectiveTableGrid(field, JSON.stringify(rows)),
    [field, rows]
  );
  const setCell = (row: number, column: number, next: string) => {
    const grid = Array.from({ length: rowSlots }, (_, rowIndex) =>
      Array.from(
        { length: columns.length },
        (_, columnIndex) => rows[rowIndex]?.[columnIndex] ?? ""
      )
    );
    grid[row]![column] = next;
    onChange(grid);
  };
  return (
    <div className="overflow-auto border">
      <table className="w-full min-w-96 border-collapse text-xs">
        <thead>
          <tr>
            {columns.map(column => (
              <th key={column} className="border bg-[#f2efe9] p-2 text-left">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rowSlots }, (_, rowIndex) => (
            <tr key={rowIndex}>
              {columns.map((_, columnIndex) => {
                const cellResult = resolution.cells[rowIndex]?.[columnIndex];
                const role = cellResult?.role ?? "fixed";
                const cellError = resolution.errors.find(
                  e => e.row === rowIndex && e.column === columnIndex
                );
                return (
                  <td key={columnIndex} className="relative border p-0">
                    {role === "writable" ? (
                      <input
                        className="h-9 w-full border-0 px-2 outline-none"
                        aria-label={tr(
                          `第 ${rowIndex + 1} 列第 ${columnIndex + 1} 欄`,
                          `Row ${rowIndex + 1} column ${columnIndex + 1}`
                        )}
                        value={rows[rowIndex]?.[columnIndex] ?? ""}
                        onChange={event =>
                          setCell(rowIndex, columnIndex, event.target.value)
                        }
                      />
                    ) : role === "formula" ? (
                      <div
                        className={`flex h-9 w-full items-center justify-between px-2 font-mono text-xs ${
                          cellError
                            ? "bg-red-50 text-red-700"
                            : "bg-[#f4f7fa] text-[#1e3a5f]"
                        }`}
                        title={
                          cellResult?.formula?.expression
                            ? `=${cellResult.formula.expression}`
                            : ""
                        }
                      >
                        <span className="flex items-center gap-1 overflow-hidden truncate">
                          <span className="rounded bg-[#2b6cb0] px-1 py-0.5 text-[9px] font-bold text-white">
                            fx
                          </span>
                          <span>
                            {resolution.effectiveRows[rowIndex]?.[columnIndex] || "-"}
                          </span>
                        </span>
                        {cellError && (
                          <span
                            className="ml-1 shrink-0 text-[10px] font-semibold text-red-600"
                            title={cellError.message}
                          >
                            ⚠ {cellError.code}
                          </span>
                        )}
                      </div>
                    ) : (
                      <div
                        className="h-9 bg-[#f2efe9]"
                        title={tr(
                          "原表格已有內容，不可填寫",
                          "Already printed on the source form"
                        )}
                      />
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TableEditor({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: string;
  onChange: (value: string) => void;
}) {
  const { tr } = useI18n();
  const columns = field.options?.length
    ? field.options
    : Array.from(
        { length: field.tableColumns ?? 3 },
        (_, columnIndex) => tr(`欄位 ${columnIndex + 1}`, `Field ${columnIndex + 1}`)
      );
  let rows: string[][];
  try {
    rows = JSON.parse(value) as string[][];
    if (!Array.isArray(rows)) rows = [];
  } catch {
    rows = [];
  }
  const update = (next: string[][]) => onChange(JSON.stringify(next));
  // A table detected from a printed form or configured with roles has fixed geometry:
  // only writable cells can be written into, formula cells compute live, and fixed cells are blank.
  const hasFixedGrid =
    Array.isArray(field.tableWritableCells) ||
    (Array.isArray(field.tableFormulaCells) && field.tableFormulaCells.length > 0);

  if (hasFixedGrid)
    return (
      <FixedTableEditor
        field={field}
        columns={columns}
        rowSlots={Math.max(
          1,
          field.maxRows ?? 1,
          ...(field.tableWritableCells ?? []).map(cell => cell.row + 1),
          ...(field.tableFormulaCells ?? []).map(cell => cell.row + 1)
        )}
        rows={rows}
        onChange={update}
      />
    );
  return (
    <div className="overflow-auto border">
      <table className="w-full min-w-96 border-collapse text-xs">
        <thead>
          <tr>
            {columns.map(column => (
              <th key={column} className="border bg-[#f2efe9] p-2 text-left">
                {column}
              </th>
            ))}
            <th className="w-8 border" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {columns.map((_, columnIndex) => (
                <td key={columnIndex} className="border p-0">
                  <input
                    className="h-9 w-full border-0 px-2 outline-none"
                    value={row[columnIndex] ?? ""}
                    onChange={event => {
                      const next = rows.map(item => [...item]);
                      next[rowIndex]![columnIndex] = event.target.value;
                      update(next);
                    }}
                    onKeyDown={event => {
                      if (event.key === "Enter")
                        (
                          event.currentTarget.parentElement?.parentElement?.nextElementSibling?.querySelector(
                            "input"
                          ) as HTMLInputElement | null
                        )?.focus();
                    }}
                  />
                </td>
              ))}
              <td className="border">
                <button
                  className="p-2 text-red-600"
                  onClick={() =>
                    update(rows.filter((_, index) => index !== rowIndex))
                  }
                >
                  <Trash2 size={12} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        className="flex w-full items-center justify-center gap-2 p-2 text-xs text-[#a23f2b]"
        disabled={rows.length >= (field.maxRows ?? 3)}
        onClick={() => update([...rows, columns.map(() => "")])}
      >
        <Plus size={12} />
        {tr("新增列", "Add row")} ({rows.length}/{field.maxRows ?? 3})
      </button>
    </div>
  );
}

function SignaturePad({ onSave }: { onSave: (file: File) => void }) {
  const { tr } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) * canvas.width) / rect.width,
      y: ((event.clientY - rect.top) * canvas.height) / rect.height,
    };
  };
  const begin = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    canvas.setPointerCapture(event.pointerId);
    const context = canvas.getContext("2d")!;
    const at = point(event);
    context.beginPath();
    context.moveTo(at.x, at.y);
    drawing.current = true;
  };
  const move = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const context = canvasRef.current!.getContext("2d")!;
    const at = point(event);
    context.lineWidth = 3;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = "#102a43";
    context.lineTo(at.x, at.y);
    context.stroke();
  };
  const clear = () =>
    canvasRef.current
      ?.getContext("2d")
      ?.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
  const save = () =>
    canvasRef.current?.toBlob(blob => {
      if (blob)
        onSave(
          new File([blob], `signature-${Date.now()}.png`, { type: "image/png" })
        );
    }, "image/png");
  return (
    <div className="border bg-white p-2">
      <canvas
        ref={canvasRef}
        className="h-32 w-full touch-none border border-dashed bg-white"
        width={720}
        height={240}
        onPointerDown={begin}
        onPointerMove={move}
        onPointerUp={() => {
          drawing.current = false;
        }}
        onPointerCancel={() => {
          drawing.current = false;
        }}
        aria-label={tr("手寫簽名區", "Handwritten signature area")}
      />
      <div className="mt-2 flex gap-2">
        <button type="button" className="btn-paper !min-h-8" onClick={clear}>
          <Eraser size={12} />
          {tr("清除", "Clear")}
        </button>
        <button type="button" className="btn-ink !min-h-8" onClick={save}>
          <PenLine size={12} />
          {tr("使用手寫簽名", "Use handwritten signature")}
        </button>
      </div>
    </div>
  );
}

function SavedValuePicker({
  values,
  onPick,
  onDelete,
  refresh,
}: {
  values: SavedValueRecord[];
  onPick: (value: string) => void;
  onDelete: (id: string) => Promise<void>;
  refresh: () => void;
}) {
  const { tr } = useI18n();
  const [search, setSearch] = useState("");
  const recordUse = trpc.formdigital.savedValues.use.useMutation();
  const shown = values
    .filter(item =>
      item.value.toLocaleLowerCase().includes(search.toLocaleLowerCase())
    )
    .sort((a, b) => (b.useCount ?? 0) - (a.useCount ?? 0));
  return (
    <div className="mt-2 border bg-[#fffdfa] p-2">
      <input
        aria-label={tr("搜尋常用值", "Search saved values")}
        className="setting-input !h-8"
        value={search}
        onChange={event => setSearch(event.target.value)}
        placeholder={tr("包含關鍵字搜尋常用值…", "Search saved values by keyword…")}
      />
      <div className="value-chips">
        {shown.length ? (
          shown.map(saved => (
            <span key={saved.id} className="inline-flex">
              <button
                className="value-chip"
                onClick={async () => {
                  onPick(saved.value);
                  await recordUse.mutateAsync({ savedValueId: saved.id });
                  refresh();
                }}
                title={tr(`使用 ${saved.useCount ?? 0} 次`, `Used ${saved.useCount ?? 0} times`)}
              >
                {saved.value}
                <small className="ml-1 opacity-60">
                  ×{saved.useCount ?? 0}
                </small>
              </button>
              <button
                className="value-chip !px-1 text-red-600"
                aria-label={tr(`刪除常用值 ${saved.value}`, `Delete saved value ${saved.value}`)}
                onClick={() => onDelete(saved.id)}
              >
                ×
              </button>
            </span>
          ))
        ) : (
          <span className="text-[9px] text-slate-400">
            {tr("沒有符合的常用值", "No matching saved values")}
          </span>
        )}
      </div>
    </div>
  );
}

function FieldControl({
  field,
  value,
  onChange,
  onMedia,
}: {
  field: FormField;
  value: string;
  onChange: (value: string) => void;
  onMedia: (file: File) => void;
}) {
  const { tr } = useI18n();
  const id = `instance-${field.id}`;
  if (field.type === "checkbox" && knownOptions(field.options).length > 0)
    // A checkbox covering a printed row of squares is several independent
    // ticks, so the panel offers one box per option.
    return (
      <div className="flex flex-wrap gap-3">
        {knownOptions(field.options).map(option => (
          <label key={option} className="flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={isCheckboxOptionSelected(value, field.options, option)}
              onChange={() =>
                onChange(toggleCheckboxOption(value, field.options, option))
              }
            />
            {option}
          </label>
        ))}
      </div>
    );
  if (field.type === "checkbox")
    return (
      <label className="flex items-center gap-2 text-xs">
        <input
          id={id}
          type="checkbox"
          checked={isCheckboxChecked(value)}
          onChange={event => onChange(event.target.checked ? "checked" : "")}
        />
        {field.options?.[0] || field.label}
      </label>
    );
  if (field.type === "radio")
    return (
      <div className="flex flex-wrap gap-3">
        {knownOptions(field.options).map(option => (
          <label key={option} className="flex items-center gap-1 text-xs">
            <input
              type="radio"
              name={id}
              checked={isSingleOptionSelected(value, field.options, option)}
              onChange={() => onChange(option)}
            />
            {option}
          </label>
        ))}
      </div>
    );
  if (field.type === "select")
    return (
      <select
        id={id}
        value={selectedSingleOption(value, field.options)}
        onChange={event => onChange(event.target.value)}
      >
        <option value="">{tr("請選擇", "Select")}</option>
        {knownOptions(field.options).map(option => (
          <option key={option}>{option}</option>
        ))}
      </select>
    );
  if (field.type === "textarea")
    return (
      <textarea
        id={id}
        className="min-h-24 w-full border bg-[#fffefa] p-2 text-xs"
        value={value}
        maxLength={field.maxLength}
        onChange={event => onChange(event.target.value)}
      />
    );
  if (field.type === "table")
    return <TableEditor field={field} value={value} onChange={onChange} />;
  if (field.type === "image")
    return (
      <div>
        <input
          id={id}
          type="file"
          accept={(field.allowedMimeTypes ?? ["image/jpeg", "image/png"]).join(
            ","
          )}
          onChange={event =>
            event.target.files?.[0] && onMedia(event.target.files[0])
          }
        />
        {value && (
          <img
            className={`mt-2 h-28 w-full border ${field.imageFit === "cover" ? "object-cover" : field.imageFit === "stretch" ? "object-fill" : "object-contain"}`}
            src={`/api/local/assets/${encodeURIComponent(value)}`}
          />
        )}
      </div>
    );
  if (field.type === "signature")
    return (
      <div className="space-y-2">
        {(field.signatureMode === "all" ||
          field.signatureMode === "text" ||
          !field.signatureMode) && (
          <input
            id={id}
            value={value.startsWith("text:") ? value.slice(5) : ""}
            placeholder={tr("文字簽名", "Text signature")}
            onChange={event => onChange(`text:${event.target.value}`)}
          />
        )}
        {(field.signatureMode === "all" ||
          field.signatureMode === "upload" ||
          !field.signatureMode) && (
          <label className="btn-paper !min-h-8">
            <Image size={12} />
            {tr("上載簽名圖片", "Upload signature image")}
            <input
              className="hidden"
              type="file"
              accept="image/jpeg,image/png"
              onChange={event =>
                event.target.files?.[0] && onMedia(event.target.files[0])
              }
            />
          </label>
        )}
        {(field.signatureMode === "all" ||
          field.signatureMode === "draw" ||
          !field.signatureMode) && <SignaturePad onSave={onMedia} />}
      </div>
    );
  const type =
    field.type === "date"
      ? "date"
      : field.type === "time"
        ? "time"
        : field.type === "number"
          ? "number"
          : "text";
  return (
    <input
      id={id}
      type={type}
      value={value}
      placeholder={field.placeholder}
      maxLength={field.type === "characterBox" ? undefined : field.maxLength}
      min={field.min}
      max={field.max}
      onChange={event => {
        let next =
          field.type === "characterBox"
            ? cleanCharacterBoxes(event.target.value).slice(
                0,
                field.boxCount ?? 8
              )
            : event.target.value;
        if (field.inputMode === "number" && field.type !== "number")
          next = next.replace(/[^0-9+-.]/g, "");
        if (field.inputMode === "text") next = next.replace(/[0-9]/g, "");
        onChange(next);
      }}
    />
  );
}

export function InstanceStudio({
  versionId,
  instanceId,
  savedValues,
  onBack,
  onCreated,
  refresh,
}: {
  versionId?: string;
  instanceId?: string;
  savedValues: SavedValueRecord[];
  onBack: () => void;
  onCreated: (instanceId: string) => void;
  refresh: () => void;
}) {
  const { tr, locale } = useI18n();
  const FIELD_TYPE_ENGLISH = {
    text: "Single-line text",
    number: "Number",
    date: "Date",
    time: "Time",
    radio: "Radio",
    select: "Dropdown",
    checkbox: "Checkbox",
    signature: "Signature",
    image: "Image / photo",
    textarea: "Description / multiline text",
    characterBox: "Character boxes",
    table: "Repeating rows",
  } as const;
  const localizeIssue = (issue: string) => {
    const field = fields.find(
      item => item.label && issue.startsWith(item.label)
    );
    const suffix = field ? issue.slice(field.label.length) : issue;
    const englishSuffix =
      suffix === "為必填欄位"
        ? " is required"
        : /^不可超過 \d+ 字$/.test(suffix)
          ? ` exceeds the maximum length of ${suffix.match(/\d+/)?.[0]}`
          : suffix === "必須是有效數字"
            ? " must be a valid number"
            : /^不可小於 .+$/.test(suffix)
              ? ` cannot be less than ${suffix.replace("不可小於 ", "")}`
              : /^不可大於 .+$/.test(suffix)
                ? ` cannot be greater than ${suffix.replace("不可大於 ", "")}`
                : suffix === "必須使用 24 小時 HH:mm 格式"
                  ? " must use 24-hour HH:mm format"
                  : suffix === "不是有效 Email"
                    ? " is not a valid email"
                    : suffix === "不是有效電話號碼"
                      ? " is not a valid phone number"
                      : suffix === "格式不符合規則"
                        ? " does not match the configured rule"
                        : suffix === "的 Regex 設定無效"
                          ? " has an invalid Regex setting"
                          : suffix;
    return tr(issue, field ? `${field.label}${englishSuffix}` : issue);
  };
  const serverError = (
    error: unknown,
    traditionalChinese: string,
    english: string
  ) =>
    toast.error(
      error instanceof Error
        ? translateServerMessage(error.message, tr, locale)
        : tr(traditionalChinese, english)
    );
  const instanceQuery = trpc.formdigital.instances.get.useQuery(
    { instanceId: instanceId ?? "pending" },
    { enabled: Boolean(instanceId) }
  );
  const versionQuery = trpc.formdigital.templates.getVersionDetails.useQuery(
    { versionId: versionId ?? "pending" },
    { enabled: !instanceId && Boolean(versionId) }
  );
  const create = trpc.formdigital.instances.create.useMutation();
  const saveMutation = trpc.formdigital.instances.saveValues.useMutation();
  const statusMutation = trpc.formdigital.instances.setStatus.useMutation();
  const upload = trpc.formdigital.assets.upload.useMutation();
  const addSaved = trpc.formdigital.savedValues.add.useMutation();
  const deleteSaved = trpc.formdigital.savedValues.delete.useMutation();
  const exportPdf = trpc.formdigital.exports.pdf.useMutation();
  const exportStructured = trpc.formdigital.exports.structured.useMutation();
  const markPrinted = trpc.formdigital.instances.markPrinted.useMutation();
  const confirmOutputChecked = trpc.formdigital.instances.confirmOutputChecked.useMutation();
  const trpcUtils = trpc.useUtils();
  const data = (instanceQuery.data ?? versionQuery.data) as
    | {
        instance?: InstanceRecord;
        template: TemplateRecord;
        version: VersionRecord;
        fields: FieldRecord[];
      }
    | undefined;
  const [values, setValues] = useState<Record<string, string>>({});
  const [activeFieldId, setActiveFieldId] = useState("");
  const [activePage, setActivePage] = useState(1);
  const [zoom, setZoom] = useState(1);
  /**
   * Ctrl/Cmd + wheel zooms the page instead of scrolling the browser. A ref
   * callback attaches the listener whenever the canvas actually mounts, which
   * an effect cannot do here because the view returns early while loading.
   * The listener must be non-passive to stop the browser's own page zoom.
   */
  const fillCanvasRef = useCallback((node: HTMLElement | null) => {
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const step = event.deltaY > 0 ? -0.1 : 0.1;
      setZoom(value =>
        Math.min(1.8, Math.max(0.6, Math.round((value + step) * 10) / 10))
      );
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, []);
  const [currentId, setCurrentId] = useState(instanceId ?? "");
  const [pendingOutputReview, setPendingOutputReview] = useState<{
    instanceId: string;
    assetId: string;
  } | null>(null);
  const [dirty, setDirty] = useState(false);
  const fields = useMemo(
    () => (data ? toCanvasFields(data.fields, data.version.pageManifest) : []),
    [data?.version.id]
  );
  const pages = pageManifestOf(data?.version.pageManifest);
  const activePageManifest = pages.find(
    (item, index) => (item.page ?? index + 1) === activePage
  );
  const assetQuery = trpc.formdigital.assets.getUrl.useQuery(
    { assetId: activePageManifest?.assetId ?? "pending" },
    { enabled: Boolean(activePageManifest?.assetId) }
  );
  const issues = useMemo(
    () => validateValues(values, fields),
    [values, fields]
  );
  /**
   * Pages holding at least one validation issue.
   *
   * The field list shows only the page being filled, so an issue on another
   * page would otherwise stay invisible until saving refused it. Marking the
   * page button keeps every one of them a single click away.
   */
  const pagesWithIssues = useMemo(() => {
    const flagged = new Set<number>();
    for (const issue of issues) {
      const field = fields.find(
        item => item.label && issue.startsWith(item.label)
      );
      if (field) flagged.add(field.page ?? 1);
    }
    return flagged;
  }, [issues, fields]);
  /**
   * The fields printed on the page being filled, in reading order. A long
   * document put every page's inputs into one list, which grew far past what
   * anyone could scan while looking at a single sheet.
   */
  const pageFields = useMemo(
    () =>
      fields
        .filter(field => (field.page ?? 1) === activePage)
        .sort((a, b) => a.y - b.y || a.x - b.x),
    [fields, activePage]
  );
  useEffect(() => {
    if (!data) return;
    if (data.instance) {
      setValues(data.instance.values);
      setCurrentId(data.instance.id);
    } else {
      const defaults = Object.fromEntries(
        fields.map(field => [
          field.id,
          field.dynamicDefault === "today"
            ? new Date().toISOString().slice(0, 10)
            : field.dynamicDefault === "now"
              ? new Date().toTimeString().slice(0, 5)
              : (field.defaultValue ?? ""),
        ])
      );
      setValues(defaults);
    }
    setActiveFieldId(fields[0]?.id ?? "");
    setDirty(false);
  }, [data?.instance?.id, data?.version.id, fields.length]);
  useEffect(() => {
    if (!dirty || !currentId) return;
    const timer = window.setTimeout(async () => {
      try {
        await saveMutation.mutateAsync({ instanceId: currentId, values });
        if (!issues.length && data?.instance?.status === "draft")
          await statusMutation.mutateAsync({
            instanceId: currentId,
            status: "completed",
          });
        setDirty(false);
        refresh();
      } catch (error) {
        serverError(error, "自動保存失敗", "Autosave failed");
      }
    }, 700);
    return () => window.clearTimeout(timer);
  }, [dirty, currentId, values]);
  const update = (fieldId: string, value: string) => {
    setValues(current => ({ ...current, [fieldId]: value }));
    setDirty(true);
  };
  const createInstance = async () => {
    if (!data) return;
    try {
      const result = await create.mutateAsync({
        templateVersionId: data.version.id,
        name: instanceName(
          data.template.instanceNamePattern,
          data.template,
          data.version,
          fields,
          values
        ),
        values,
      });
      setCurrentId(result.instanceId);
      setDirty(false);
      onCreated(result.instanceId);
      refresh();
      toast.success(tr("Instance 已建立並綁定目前 Version", "Instance created and bound to this Version"));
    } catch (error) {
      serverError(error, "建立失敗", "Create failed");
    }
  };
  const save = async () => {
    if (!currentId) return createInstance();
    try {
      await saveMutation.mutateAsync({ instanceId: currentId, values });
      setDirty(false);
      refresh();
      toast.success(tr("Instance 已保存", "Instance saved"));
    } catch (error) {
      serverError(error, "保存失敗", "Save failed");
    }
  };
  const uploadMedia = async (field: FormField, file: File) => {
    if (!data) return;
    if (
      !(field.allowedMimeTypes ?? ["image/png", "image/jpeg"]).includes(
        file.type
      )
    )
      return toast.error(
        tr(
          `此欄位只接受 ${(field.allowedMimeTypes ?? []).join("、") || "PNG／JPG"}。`,
          `This field accepts ${(field.allowedMimeTypes ?? []).join(", ") || "PNG/JPG"} only.`,
        )
      );
    if (file.size > (field.maxFileSizeMb ?? 10) * 1024 * 1024)
      return toast.error(tr(`圖片不可超過 ${field.maxFileSizeMb ?? 10} MB。`, `Images cannot exceed ${field.maxFileSizeMb ?? 10} MB.`));
    try {
      const result = await upload.mutateAsync({
        base64: await blobToBase64(file),
        kind: field.type === "signature" ? "signature" : "image",
        mimeType: file.type as "image/png" | "image/jpeg",
        originalFilename: file.name,
        templateId: data.template.id,
        templateVersionId: data.version.id,
        instanceId: currentId || undefined,
        metadata: { fieldId: field.id },
      });
      update(field.id, result.asset.id);
    } catch (error) {
      serverError(error, "圖片保存失敗", "Could not save the image");
    }
  };
  const runPdf = async (
    mode: "full" | "overlay" | "editable",
    raster?: "png" | "jpeg",
    print = false
  ) => {
    if (!currentId) return toast.error(tr("請先保存 Instance。", "Save the Instance first."));
    if (issues.length)
      return toast.error(tr(`仍有 ${issues.length} 項驗證錯誤，不能預覽或輸出。`, `${issues.length} validation errors remain. Preview and export are blocked.`));
    try {
      const result = await exportPdf.mutateAsync({
        instanceId: currentId,
        mode,
      });
      if (raster) {
        const count = await downloadPdfPagesAsImages(
          result.url,
          raster,
          data?.instance?.name || "Formdigital"
        );
        toast.success(tr(`已輸出 ${count} 張 ${raster.toUpperCase()} 圖片`, `Exported ${count} ${raster.toUpperCase()} images`));
      } else if (print) {
        if (!openLocalOutput(result.url))
          return toast.error(tr("瀏覽器阻擋了列印預覽視窗。", "The browser blocked the print preview window."));
        toast.info(tr("請在新視窗使用系統列印對話框；完成後回到此頁確認。", "Use the system print dialog in the new window, then return here to confirm."));
        if (confirm(tr("系統列印對話框是否已成功送出列印？", "Did the system print dialog successfully submit the print job?"))) {
          await markPrinted.mutateAsync({
            instanceIds: [currentId],
            output: { assetId: result.assetId, mode },
          });
          refresh();
        }
      } else if (!openLocalOutput(result.url)) {
        toast.error(tr("瀏覽器阻擋了輸出預覽視窗。", "The browser blocked the output preview window."));
      } else {
        setPendingOutputReview({ instanceId: currentId, assetId: result.assetId });
      }
    } catch (error) {
      serverError(error, "輸出失敗", "Export failed");
    }
  };
  const runStructured = async (format: "json" | "csv") => {
    if (!currentId) return toast.error(tr("請先保存 Instance。", "Save the Instance first."));
    if (issues.length)
      return toast.error(tr(`仍有 ${issues.length} 項驗證錯誤，不能預覽或輸出。`, `${issues.length} validation errors remain. Preview and export are blocked.`));
    try {
      const result = await exportStructured.mutateAsync({
        instanceId: currentId,
        format,
      });
      await downloadUrl(result.url, result.filename || `instance.${format}`);
    } catch (error) {
      serverError(error, "輸出失敗", "Export failed");
    }
  };
  if (!data)
    return (
      <div className="grid min-h-96 place-items-center text-sm text-slate-500">
        {tr("正在載入 Instance／Version…", "Loading Instance / Version…")}
      </div>
    );
  return (
    <div>
      <header className="fill-header">
        <div className="row">
          <button className="icon-button" onClick={onBack}>
            <ArrowLeft size={15} />
          </button>
          <div>
            <h1 className="text-sm font-semibold">
              {data.template.name} · v{data.version.versionNumber}
            </h1>
            <p className="text-[10px] text-slate-500">
              {currentId
                ? `${data.instance?.name || tr("新 Instance", "New Instance")} · ${dirty ? tr("等待自動保存", "waiting for autosave") : tr("已保存", "saved")}`
                : tr("尚未建立 Instance", "No Instance created yet")}
            </p>
          </div>
        </div>
        <div className="row">
          <button className="btn-paper" onClick={save}>
            <Save size={14} />
            {tr("儲存", "Save")}
          </button>
          <details className="relative">
            <summary className="btn-ink list-none">
              <Download size={14} />
              {tr("輸出", "Export")}
            </summary>
            <div className="absolute right-0 z-30 mt-1 grid w-52 border bg-[#fffdfa] p-1 shadow-xl">
              <button
                className="px-3 py-2 text-left text-xs hover:bg-[#f4eee8]"
                onClick={() => runPdf("full")}
              >
                {tr("一般 PDF（連原表）", "PDF with original form")}
              </button>
              <button
                className="px-3 py-2 text-left text-xs hover:bg-[#f4eee8]"
                onClick={() => runPdf("overlay")}
              >
                {tr("套印 PDF（只印答案）", "Overlay PDF (answers only)")}
              </button>
              <button
                className="px-3 py-2 text-left text-xs hover:bg-[#f4eee8]"
                onClick={() => runPdf("editable")}
              >
                {tr("可繼續填寫的 PDF", "Editable PDF")}
              </button>
              <button
                className="px-3 py-2 text-left text-xs hover:bg-[#f4eee8]"
                onClick={() => runPdf("full", "png")}
              >
                PNG
              </button>
              <button
                className="px-3 py-2 text-left text-xs hover:bg-[#f4eee8]"
                onClick={() => runPdf("full", "jpeg")}
              >
                JPG
              </button>
              <button
                className="px-3 py-2 text-left text-xs hover:bg-[#f4eee8]"
                onClick={() => runStructured("json")}
              >
                <FileJson size={12} className="mr-2 inline" />
                JSON + Metadata
              </button>
              <button
                className="px-3 py-2 text-left text-xs hover:bg-[#f4eee8]"
                onClick={() => runStructured("csv")}
              >
                <FileSpreadsheet size={12} className="mr-2 inline" />
                CSV + Metadata
              </button>
            </div>
          </details>
          <button
            className="btn-red"
            onClick={() => runPdf("full", undefined, true)}
          >
            <Printer size={14} />
            {tr("列印", "Print")}
          </button>
        </div>
      </header>
      {isPracticeTemplate(data.template.description)&&<PracticeFillGuide fields={fields} values={values} page={activePage} onPage={setActivePage}/>}
      {pendingOutputReview?.instanceId === currentId && (
        <div className="mt-2 flex flex-wrap items-center gap-3 border border-[#96b8a5] bg-[#f2f8f4] p-3 text-xs" data-testid="output-review-prompt">
          <span>{tr("請查看剛開啟的 PDF，確認內容與位置正確後再按確認。", "Inspect the PDF you just opened, then confirm its content and placement.")}</span>
          <button
            type="button"
            className="btn-paper"
            data-testid="confirm-output-reviewed"
            disabled={confirmOutputChecked.isPending}
            onClick={async () => {
              try {
                await confirmOutputChecked.mutateAsync(pendingOutputReview);
                setPendingOutputReview(null);
                await trpcUtils.formdigital.templates.outputReviewed.invalidate({ versionId: data.version.id });
                toast.success(tr("已記錄你檢查過這份輸出。", "Your output review has been recorded."));
              } catch (error) {
                serverError(error, "無法記錄輸出檢查", "Could not record the output review");
              }
            }}
          >
            {tr("我已檢查這份輸出", "I checked this output")}
          </button>
        </div>
      )}
      <div className="mt-2 flex items-center gap-2 border bg-[#fffdfa] p-2">
        {pages.map((page, index) => (
          <button
            key={index}
            className={`btn-paper !min-h-8 ${activePage === index + 1 ? "!border-[#d9573b] !bg-[#f8e7e2]" : ""}`}
            onClick={() => setActivePage(index + 1)}
          >
            Page {index + 1}
            {pagesWithIssues.has(index + 1) ? (
              <span
                className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-red-600 align-middle"
                aria-label={tr("此頁有驗證問題", "This page has validation issues")}
              />
            ) : null}
          </button>
        ))}
        <button
          className="icon-button ml-auto"
          onClick={() => setZoom(value => Math.max(0.6, value - 0.1))}
        >
          <ZoomOut size={14} />
        </button>
        <span className="text-[10px]">{Math.round(zoom * 100)}%</span>
        <button
          className="icon-button"
          onClick={() => setZoom(value => Math.min(1.7, value + 0.1))}
        >
          <ZoomIn size={14} />
        </button>
      </div>
      <div className="fill-layout">
        <main className="fill-canvas" ref={fillCanvasRef}>
          <FormCanvas
            fields={fields}
            values={values}
            activeFieldId={activeFieldId}
            onActivate={id => {
              setActiveFieldId(id);
              document.getElementById(`instance-${id}`)?.focus();
            }}
            onValueChange={update}
            mode="fill"
            page={activePage}
            pageWidthMm={activePageManifest?.widthMm ?? 210}
            pageHeightMm={activePageManifest?.heightMm ?? 297}
            showDemoBackground={false}
            backgroundUrl={assetQuery.data?.url}
            backgroundMimeType={assetQuery.data?.asset.mimeType}
            zoom={zoom}
          />
        </main>
        <aside className="fill-panel">
          <div className="fill-panel-top">
            <h2>{tr("欄位輸入", "Field input")}</h2>
            <span
              className={`text-[10px] ${issues.length ? "text-red-700" : "text-emerald-700"}`}
            >
              {issues.length ? `${issues.length} errors` : tr("驗證通過", "Validation passed")}
            </span>
          </div>
          <div className="field-form">
            <p className="pt-3 text-[10px] text-[#84919a]">
              {tr(
                `第 ${activePage} 頁 · ${pageFields.length} 個欄位`,
                `Page ${activePage} · ${pageFields.length} fields`
              )}
            </p>
            {pageFields
              .map(field => {
                const fieldSaved = savedValues
                  .filter(
                    item =>
                      item.templateId === data.template.id &&
                      item.stableFieldId === field.id
                  )
                  .sort((a, b) => (b.useCount ?? 0) - (a.useCount ?? 0));
                return (
                  <div
                    key={field.id}
                    className={`field-form-row ${activeFieldId === field.id ? "active" : ""}`}
                    onFocus={() => {
                      setActiveFieldId(field.id);
                      setActivePage(field.page ?? 1);
                    }}
                    onKeyDown={event => {
                      if (
                        event.key !== "Enter" ||
                        (event.target as HTMLElement).tagName === "TEXTAREA" ||
                        field.type === "table"
                      )
                        return;
                      event.preventDefault();
                      const rows = Array.from(
                        event.currentTarget.parentElement?.querySelectorAll<HTMLElement>(
                          ".field-form-row"
                        ) ?? []
                      );
                      const next = rows[rows.indexOf(event.currentTarget) + 1];
                      next
                        ?.querySelector<HTMLElement>(
                          "input,select,textarea,button"
                        )
                        ?.focus();
                    }}
                  >
                    <label
                      className="field-form-label"
                      htmlFor={`instance-${field.id}`}
                    >
                      <span>
                        {field.label || tr("未命名欄位", "Untitled field")}
                        {field.required && <b className="required"> *</b>}
                      </span>
                      <small>{tr(fieldTypeLabel(field.type), FIELD_TYPE_ENGLISH[field.type])}</small>
                    </label>
                    <FieldControl
                      field={field}
                      value={values[field.id] ?? ""}
                      onChange={value => update(field.id, value)}
                      onMedia={file => uploadMedia(field, file)}
                    />
                    {activeFieldId === field.id && ["text", "textarea", "number", "date", "time"].includes(field.type) && (
                      <p className="mt-1 text-[10px] text-[#687782]">
                        {field.overflow === "shrink"
                          ? tr("輸出 PDF 時會按需要縮小文字；若仍放不下，會停止輸出並提示縮短內容。", "PDF export shrinks text to fit. If it still does not fit, export stops and asks you to shorten it.")
                          : field.overflow === "block"
                            ? tr("文字超出紙上欄位容量時，PDF 輸出會停止；輸入框可容納的字數不代表紙面容量。", "PDF export stops if text exceeds the printed field. Input length does not guarantee it fits on paper.")
                            : tr("請留意紙上欄位容量；輸出會換行，但超出框底的文字可能被裁切。", "Check the printed field capacity. Export wraps text, but text below the field may be clipped.")}
                      </p>
                    )}
                    {fieldSaved.length > 0 && (
                      <SavedValuePicker
                        values={fieldSaved}
                        onPick={value => update(field.id, value)}
                        onDelete={async savedValueId => {
                          await deleteSaved.mutateAsync({ savedValueId });
                          refresh();
                        }}
                        refresh={refresh}
                      />
                    )}
                    <button
                      className="mt-2 text-[10px] text-[#a23f2b]"
                      disabled={!values[field.id]}
                      onClick={async () => {
                        await addSaved.mutateAsync({
                          templateId: data.template.id,
                          stableFieldId: field.id,
                          value: values[field.id]!,
                        });
                        refresh();
                        toast.success(tr("已主動加入此欄位常用值", "Added this field's saved value"));
                      }}
                    >
                      ＋ {tr("加入常用值", "Add saved value")}
                    </button>
                    {issues
                      .filter(issue => issue.startsWith(field.label))
                      .map(issue => (
                        <p
                          key={issue}
                          className="mt-1 text-[10px] text-red-700"
                        >
                      {localizeIssue(issue)}
                        </p>
                      ))}
                  </div>
                );
              })}
          </div>
          <footer className="fill-footer">
            <div
              className={`validation-summary ${issues.length ? "" : "success"}`}
            >
              <b>{issues.length || "0"}</b> {tr("項驗證問題", "validation issues")}
            </div>
            <button className="btn-ink" onClick={save}>
              {currentId ? tr("儲存", "Save") : tr("建立 Instance", "Create Instance")}
              <Check size={13} />
            </button>
          </footer>
        </aside>
      </div>
    </div>
  );
}
