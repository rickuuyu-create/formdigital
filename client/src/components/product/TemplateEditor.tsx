import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignHorizontalDistributeCenter,
  AlignVerticalDistributeCenter,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  BringToFront,
  Check,
  Copy,
  FilePlus,
  Grid3X3,
  History,
  MousePointer2,
  Plus,
  Redo2,
  Save,
  SendToBack,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { FormCanvas } from "@/components/FormCanvas";
import { FormulaWizard } from "@/components/product/FormulaWizard";
import { ColumnTotalWizard } from "@/components/product/ColumnTotalWizard";
import { FieldSettingsNavigator, TemplateWorkflowGuide, workflowCompletion } from "@/components/product/TemplateWorkflowGuide";
import { PracticeCoach, readPracticeStep } from './TemplatePractice';
import { isPracticeTemplate, matchingPracticeFields, practiceField, practiceLessons, type PracticeLesson } from '@/lib/template-practice';
import {
  TableEditingControls,
  type TableEditMode,
} from "@/components/product/TableEditingControls";
import { tableEditingText } from "@/lib/tableEditingMessages";
import { trpc } from "@/lib/trpc";
import { useI18n } from "@/lib/i18n";
import { knownOptions } from "@shared/checkboxSelection";
import { translateServerMessage } from "@/lib/server-messages";
import { blobToBase64, processImagePage } from "@/lib/document-files";
import { tableCellGuidesForGrid, textGeometryWarning } from "@/lib/form-model";
import { tableGridSize } from "@shared/tableGeometry";
import {
  columnIndexToName,
  columnNameToIndex,
  formatFormulaErrorMessage,
  getFormulaReferencedColumns,
  normalizeTableCellPositions,
  normalizeTableFormulaCells,
  parseFormula,
  resolveTableGridRoles,
  validateTableFormulaDefinition,
  type TableCellRole,
  type TableFormulaCell,
} from "@shared/tableFormula";
import {
  createEmptyField,
  pageManifestOf,
  serializeCanvasFields,
  toCanvasFields,
  type FieldRecord,
  type TemplateRecord,
  type VersionRecord,
} from "@/lib/product-types";
import {
  fieldTypeLabel,
  optionMarksForOptions,
  remapDetectedOptionMarks,
  type FieldType,
  type FormField,
} from "@/lib/form-model";

/** The column count a table renders with, matching the canvas and the PDF. */
function tableColumnsOf(field: FormField) {
  return tableGridSize(field, []).columns;
}

const FIELD_TYPES: FieldType[] = [
  "text",
  "number",
  "date",
  "time",
  "radio",
  "checkbox",
  "select",
  "signature",
  "image",
  "textarea",
  "characterBox",
  "table",
];

export function TemplateEditor({
  versionId,
  onBack,
  onFill,
  refresh,
}: {
  versionId: string;
  onBack: () => void;
  onFill: (versionId: string) => void;
  refresh: () => void;
}) {
  const { tr, locale } = useI18n();
  const formulaLang: "zh-TW" | "zh-CN" | "en" =
    locale === "zh-Hans" ? "zh-CN" : locale === "en" ? "en" : "zh-TW";
  const FIELD_TYPE_ENGLISH: Record<FieldType, string> = {
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
  };
  const localizedFieldType = (type: FieldType) =>
    tr(fieldTypeLabel(type), FIELD_TYPE_ENGLISH[type]);
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
  const detailsQuery = trpc.formdigital.templates.getVersionDetails.useQuery({
    versionId,
  });
  const saveFields = trpc.formdigital.templates.saveDraftFields.useMutation();
  const savePages = trpc.formdigital.templates.savePages.useMutation();
  const publish = trpc.formdigital.templates.publish.useMutation();
  const clone = trpc.formdigital.templates.cloneToDraft.useMutation();
  const [cloneDialogOpen, setCloneDialogOpen] = useState(false);
  const [cloneNote, setCloneNote] = useState("");
  const upload = trpc.formdigital.assets.upload.useMutation();
  const updateMetadata =
    trpc.formdigital.templates.updateMetadata.useMutation();
  const deleteAsset = trpc.formdigital.assets.delete.useMutation();
  const [fields, setFields] = useState<FormField[]>([]);
  const [pages, setPages] = useState<ReturnType<typeof pageManifestOf>>([
    { page: 1, widthMm: 210, heightMm: 297 },
  ]);
  const [activePage, setActivePage] = useState(1);
  const [practiceStep, setPracticeStep] = useState(() => readPracticeStep(versionId));
  useEffect(() => { setPracticeStep(readPracticeStep(versionId)); }, [versionId]);
  const [selected, setSelected] = useState<string[]>([]);
  const [undoStack, setUndoStack] = useState<FormField[][]>([]);
  const [redoStack, setRedoStack] = useState<FormField[][]>([]);
  const [dirty, setDirty] = useState(false);
  // Acknowledging an older autosave must not mark a newer edit as saved.
  // Serialize writes so a slow earlier request cannot overwrite a later snapshot.
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const latestSaveSnapshot = useRef({ versionId, fields, pages });
  latestSaveSnapshot.current = { versionId, fields, pages };
  const [snap, setSnap] = useState(true);
  const [drawing, setDrawing] = useState(false);
  // When set, drawing on the source page reframes this existing choice group
  // instead of creating a second, overlapping field.
  const [choiceRetargetId, setChoiceRetargetId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  // 階段 2／S2-01：三種互斥表格模式（欄位／格線／逐格）與逐格分組。
  const [tableEditMode, setTableEditMode] = useState<TableEditMode>("field");
  const [tableActiveGroup, setTableActiveGroup] = useState(0);
  // 階段 2／S2-R4：跳格／換組後要求 FormCanvas 聚焦的逐格把手絕對 index（一次性）。
  const [tableFocusIndex, setTableFocusIndex] = useState<number | null>(null);
  /**
   * 階段 2／S2-R1（第二輪）#5：FormCanvas 回報目前是否有「未提交的表格操作」
   * （整表拖動／鍵盤微調 preview）。為 true 時，Save／Publish／Undo／Redo／
   * duplicate／刪除等衝突入口一律停用，不得暗中把 preview 提交出去。
   */
  const [tableGestureBusy, setTableGestureBusy] = useState(false);
  // Raw text of the options editor while it is being typed in.
  const [optionsDraft, setOptionsDraft] = useState<{
    id: string;
    text: string;
  } | null>(null);
  /**
   * Ctrl/Cmd + wheel zooms the page instead of scrolling the browser. A ref
   * callback attaches the listener whenever the canvas actually mounts, which
   * an effect cannot do here because the view returns early while loading.
   * The listener must be non-passive to stop the browser's own page zoom.
   */
  const canvasRef = useCallback((node: HTMLElement | null) => {
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
  const [actionHistory, setActionHistory] = useState<
    Array<{ label: string; at: number }>
  >([]);
  const [compareVersionId, setCompareVersionId] = useState("");
  const [saveState, setSaveState] = useState<"saved" | "saving" | "unsaved">(
    "saved"
  );
  const pageInput = useRef<HTMLInputElement>(null);
  const lastCommitRef = useRef({ label: "", at: 0 });
  const data = detailsQuery.data as
    | {
        template: TemplateRecord;
        version: VersionRecord;
        fields: FieldRecord[];
      }
    | undefined;
  const isDraft = data?.version.state === "draft";
  const isPractice = isPracticeTemplate(data?.template.description);
  const currentLesson = isPractice ? practiceLessons[practiceStep] : undefined;
  useEffect(() => {
    if (isPractice) setActivePage(practiceLessons[readPracticeStep(versionId)]?.page ?? 8);
  }, [isPractice, versionId]);
  const outputReviewQuery = trpc.formdigital.templates.outputReviewed.useQuery(
    { versionId },
    { enabled: Boolean(data?.version && !isDraft) }
  );
  const activeField =
    fields.find(field => field.id === selected[0]) ?? (isPractice ? undefined : fields[0]);
  const activeManifest = pages.find(
    (item, index) => (item.page ?? index + 1) === activePage
  );
  const activeFieldTextWarning = activeField
    ? textGeometryWarning(activeField)
    : null;
  /**
   * 階段 2／S2-R4（第二輪）#6：換表／換頁／換版本時重置表格編輯狀態——
   * 模式回到欄位模式、組回到第 0 組、跳格請求清空，未提交操作也不留下。
   * 否則上一張表的逐格分組編號與模式會被帶到下一張表，造成錯位與誤操作。
   */
  useEffect(() => {
    setTableEditMode("field");
    setTableActiveGroup(0);
    setTableFocusIndex(null);
  }, [activeField?.id, activePage, data?.version.id]);
  const assetQuery = trpc.formdigital.assets.getUrl.useQuery(
    { assetId: activeManifest?.assetId ?? "pending" },
    { enabled: Boolean(activeManifest?.assetId) }
  );
  const versionsQuery = trpc.formdigital.templates.versions.useQuery(
    { templateId: data?.template.id ?? "pending" },
    { enabled: Boolean(data?.template.id) }
  );
  const comparisonQuery = trpc.formdigital.templates.getVersionDetails.useQuery(
    { versionId: compareVersionId || "pending" },
    { enabled: Boolean(compareVersionId) }
  );
  const assetsQuery = trpc.formdigital.assets.list.useQuery(undefined, {
    enabled: Boolean(data?.template.id),
  });
  const sourceAssets = (
    (assetsQuery.data ?? []) as Array<{
      id: string;
      originalFilename: string;
      metadata?: Record<string, unknown>;
    }>
  ).filter(
    asset =>
      asset.metadata?.templateId === data?.template.id &&
      asset.metadata?.kind === "source"
  );
  const comparison = useMemo(() => {
    if (!comparisonQuery.data) return null;
    const other = comparisonQuery.data.fields as FieldRecord[];
    const currentIds = new Set(fields.map(field => field.id));
    const otherIds = new Set(other.map(field => field.stableFieldId));
    const added = fields.filter(field => !otherIds.has(field.id)).length;
    const removed = other.filter(
      field => !currentIds.has(field.stableFieldId)
    ).length;
    const changed = other.filter(
      field =>
        currentIds.has(field.stableFieldId) &&
        JSON.stringify(
          serializeCanvasFields(
            fields.filter(item => item.id === field.stableFieldId),
            pages
          )[0]
        ) !==
          JSON.stringify({
            stableFieldId: field.stableFieldId,
            fieldType: field.fieldType,
            displayOrder: field.displayOrder,
            definition: field.definition,
            coordinate: field.coordinate,
          })
    ).length;
    return { added, removed, changed };
  }, [comparisonQuery.data, fields, pages]);

  useEffect(() => {
    if (!data) return;
    const loadedFields = toCanvasFields(data.fields, data.version.pageManifest);
    setFields(loadedFields);
    setPages(pageManifestOf(data.version.pageManifest));
    const savedLesson = isPracticeTemplate(data.template.description)
      ? practiceLessons[readPracticeStep(versionId)] : undefined;
    const initialField = isPracticeTemplate(data.template.description)
      ? (savedLesson ? matchingPracticeFields(savedLesson, loadedFields)[0] : undefined)
      : loadedFields[0];
    setSelected(initialField ? [initialField.id] : []);
    setUndoStack([]);
    setRedoStack([]);
    setDirty(false);
    setSaveState("saved");
    setActionHistory([]);
    setDrawing(false);
  }, [data?.version.id, data?.version.contentHash]);

  // 階段 2／S2-R1 #8：表格手勢提交需明確 history boundary。
  // forceBoundary=true 時跳過 650ms 合併窗，確保連續兩個同類 gesture 即使 <650ms 也各成一個 undo 項目。
  const commit = (
    next: FormField[],
    label = tr("欄位修改", "Field changed"),
    forceBoundary = false
  ) => {
    if (!isDraft)
      return toast.info(
        tr("已發佈 Version 不可修改；請先建立新 Draft。", "A published Version is locked. Create a new Draft first."),
      );
    const timestamp = Date.now();
    if (
      forceBoundary ||
      lastCommitRef.current.label !== label ||
      timestamp - lastCommitRef.current.at > 650
    ) {
      setUndoStack(history => [...history.slice(-79), fields]);
      setActionHistory(history =>
        [{ label, at: timestamp }, ...history].slice(0, 50)
      );
    }
    lastCommitRef.current = { label, at: timestamp };
    setRedoStack([]);
    setFields(next);
    setDirty(true);
    setSaveState("unsaved");
  };
  const updateField = (
    id: string,
    patch: Partial<FormField>,
    opts?: { boundary?: boolean }
  ) =>
    commit(
      fields.map(field =>
        field.id === id
          ? {
              ...field,
              ...Object.fromEntries(
                Object.entries(patch).map(([key, value]) => [
                  key,
                  snap &&
                  ["x", "y", "width", "height"].includes(key) &&
                  typeof value === "number"
                    ? Math.round(value * 2) / 2
                    : value,
                ])
              ),
            }
          : field
      ),
      Object.keys(patch).some(key =>
        ["x", "y", "width", "height"].includes(key)
      )
        ? tr("移動／調整欄位", "Field moved or resized")
        : tr("修改欄位設定", "Field settings changed"),
      opts?.boundary
    );
  const save = async (silent = false) => {
    if (!isDraft || !dirty) return;
    const snapshot = { versionId, fields, pages };
    setSaveState("saving");
    try {
      const write = saveQueueRef.current.then(async () => {
        await saveFields.mutateAsync({
          versionId: snapshot.versionId,
          fields: serializeCanvasFields(snapshot.fields, snapshot.pages),
        });
      });
      saveQueueRef.current = write.catch(() => {});
      await write;
      const latest = latestSaveSnapshot.current;
      if (latest.versionId !== snapshot.versionId) return;
      if (latest.fields !== snapshot.fields || latest.pages !== snapshot.pages) {
        setSaveState("unsaved");
        return; // keep the newer edit dirty (or queued) until its own acknowledgement
      }
      setDirty(false);
      setSaveState("saved");
      if (!silent)
        toast.success(tr("Draft 已保存至 localhost Workspace", "Draft saved to the localhost Workspace"));
    } catch (error) {
      setSaveState("unsaved");
      if (!silent)
        serverError(error, "保存失敗", "Save failed");
    }
  };
  useEffect(() => {
    if (!dirty || !isDraft) return;
    const timer = window.setTimeout(() => save(true), 900);
    return () => window.clearTimeout(timer);
  }, [dirty, fields, pages, isDraft]);

  const undo = () => {
    const previous = undoStack.at(-1);
    if (!previous) return;
    setRedoStack(history => [...history, fields]);
    setFields(previous);
    setUndoStack(history => history.slice(0, -1));
    setDirty(true);
  };
  const redo = () => {
    const next = redoStack.at(-1);
    if (!next) return;
    setUndoStack(history => [...history, fields]);
    setFields(next);
    setRedoStack(history => history.slice(0, -1));
    setDirty(true);
  };
  const addField = () => {
    const field = createEmptyField(activePage, pages, fields.length);
    commit([...fields, field], tr("新增欄位", "Field added"));
    setSelected([field.id]);
  };
  const locatePractice = (lesson: PracticeLesson, scrollToFrame = true) => {
    if (tableGestureBusy) return;
    setActivePage(lesson.page);
    const existing = matchingPracticeFields(lesson, fields)[0];
    setSelected(existing ? [existing.id] : []);
    if (scrollToFrame) requestAnimationFrame(() => document.querySelector('.practice-outline')?.scrollIntoView({block:'center',behavior:'smooth'}));
  };
  const framePractice = (lesson: PracticeLesson) => {
    if (!isPractice || !isDraft || tableGestureBusy || matchingPracticeFields(lesson,fields).length) return;
    const frame = practiceField(lesson);
    commit([...fields,frame],tr('建立練習空框','Practice frame created'));
    setActivePage(lesson.page); setSelected([frame.id]); setDrawing(false);
  };
  const drawField = (bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) => {
    const field = {
      ...createEmptyField(activePage, pages, fields.length),
      ...bounds,
      label: "",
      confirmed: false,
      status: "needs-review" as const,
    };
    commit([...fields, field], tr("在畫布拖拉新增欄位", "Field drawn on canvas"));
    setSelected([field.id]);
    setDrawing(false);
    toast.info(
      tr("欄位框已建立；請在右側設定名稱、類型及規則後確認。", "Field box created. Set its name, type, and rules on the right, then confirm it."),
    );
  };
  const drawOrRetargetField = (bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) => {
    const target = choiceRetargetId
      ? fields.find(field => field.id === choiceRetargetId)
      : undefined;
    if (!target || (target.type !== "radio" && target.type !== "checkbox")) {
      setChoiceRetargetId(null);
      drawField(bounds);
      return;
    }
    const options = knownOptions(target.options);
    commit(
      fields.map(field =>
        field.id === target.id
          ? {
              ...field,
              ...bounds,
              // A new group rectangle starts with clear, evenly-spaced
              // handles. The field type and every option remain unchanged.
              optionMarks: optionMarksForOptions(undefined, options),
            }
          : field
      ),
      tr("重新框選選項群組", "Choice group reframed"),
      true
    );
    setSelected([target.id]);
    setChoiceRetargetId(null);
    setDrawing(false);
    toast.success(
      tr("已重新框選整組；請逐一拖動綠色框對準每個選項。", "The whole group was reframed. Now drag each green box onto its option.")
    );
  };
  const beginChoiceRetarget = () => {
    if (!activeField || (activeField.type !== "radio" && activeField.type !== "checkbox")) return;
    setChoiceRetargetId(activeField.id);
    setDrawing(true);
    document.querySelector(".editor-canvas")?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
    toast.info(
      tr("請在原表上拖拉框住整組選項；欄位名稱和選項會保留。", "Drag a box around the whole choice group on the source page. The field and its options will be kept.")
    );
  };
  const deleteSelected = () => {
    if (!selected.length) return;
    commit(
      fields.filter(field => !selected.includes(field.id)),
      tr("刪除欄位", "Field deleted")
    );
    setSelected([]);
  };
  // 階段 2／S2-R2：所有刪除入口（toolbar、快捷鍵、整表按鈕）共用同一守護。
  // 確認對話框文案必須對應實際將刪除的 ID 集合；取消時 fields／roles／guides／
  // history／dirty／server 全部零變化。
  const deleteSelectionWithGuard = useCallback(() => {
    if (!selected.length || !isDraft) return;
    const T = tableEditingText(locale);
    const selectedFields = fields.filter(f => selected.includes(f.id));
    const tables = selectedFields.filter(f => f.type === "table");
    const tableNames = tables
      .map(t => t.label || tr("未命名表格", "Untitled table"))
      .join("、");
    let message: string;
    if (tables.length > 0) {
      message = T.deleteSelectionConfirm(tables.length, tableNames);
      const otherCount = selectedFields.length - tables.length;
      if (otherCount > 0) message += " " + T.deleteAlsoOtherFields(otherCount);
    } else {
      message = T.deleteFieldConfirm(selectedFields.length);
    }
    if (window.confirm(message)) {
      deleteSelected();
    }
  }, [selected, fields, locale, isDraft, deleteSelected]);
  // 階段 2／S2-05＋S2-R2：刪除「整個表格欄位」的守護——確認對話框標示影響範圍，
  // 且精確只刪 active table（不會默默刪除多選中的其他欄位）。
  const requestDeleteTable = useCallback(() => {
    if (!activeField || activeField.type !== "table" || !isDraft) return;
    const { rowSlots, columns } = tableGridSize(activeField, []);
    const T = tableEditingText(locale);
    if (
      window.confirm(T.deleteTableConfirm(rowSlots, columns, activeField.label))
    ) {
      commit(
        fields.filter(field => field.id !== activeField.id),
        tr("刪除表格欄位", "Table field deleted")
      );
      setSelected(current => current.filter(id => id !== activeField.id));
    }
  }, [activeField, fields, locale, isDraft]);
  const duplicate = () => {
    const sources = fields.filter(field => selected.includes(field.id));
    if (!sources.length) return;
    const copies = sources.map((field, index) => ({
      ...field,
      id: `field-${crypto.randomUUID().slice(0, 8)}`,
      label: `${field.label || tr("未命名欄位", "Untitled field")} ${tr("副本", "copy")}`,
      x: Math.min(100 - field.width, field.x + 2),
      y: Math.min(100 - field.height, field.y + 2),
      zIndex: fields.length + index + 1,
    }));
    commit([...fields, ...copies], tr("複製欄位", "Fields duplicated"));
    setSelected(copies.map(field => field.id));
  };
  const distribute = (axis: "horizontal" | "vertical") => {
    const targets = fields.filter(field => selected.includes(field.id));
    if (targets.length < 3)
      return toast.info(tr("平均分佈需要至少三個欄位。", "Even distribution needs at least three fields."));
    const sorted = targets
      .slice()
      .sort((a, b) => (axis === "horizontal" ? a.x - b.x : a.y - b.y));
    const first = sorted[0]!,
      last = sorted.at(-1)!;
    const totalSize = sorted.reduce(
      (sum, field) =>
        sum + (axis === "horizontal" ? field.width : field.height),
      0
    );
    const available =
      (axis === "horizontal"
        ? last.x + last.width - first.x
        : last.y + last.height - first.y) - totalSize;
    const gap = available / (sorted.length - 1);
    let cursor = axis === "horizontal" ? first.x : first.y;
    const position = new Map<string, number>();
    for (const field of sorted) {
      position.set(field.id, cursor);
      cursor += (axis === "horizontal" ? field.width : field.height) + gap;
    }
    commit(
      fields.map(field =>
        position.has(field.id)
          ? {
              ...field,
              [axis === "horizontal" ? "x" : "y"]: position.get(field.id)!,
            }
          : field
      ),
      axis === "horizontal"
        ? tr("水平平均分佈", "Distributed horizontally")
        : tr("垂直平均分佈", "Distributed vertically")
    );
  };
  const align = (
    kind: "left" | "right" | "top" | "bottom" | "hcenter" | "vcenter"
  ) => {
    const targets = fields.filter(field => selected.includes(field.id));
    if (targets.length < 2)
      return toast.info(tr("請按 Shift 選取至少兩個欄位。", "Hold Shift and select at least two fields."));
    const anchor = targets[0]!;
    commit(
      fields.map(field =>
        !selected.includes(field.id)
          ? field
          : kind === "left"
            ? { ...field, x: anchor.x }
            : kind === "right"
              ? { ...field, x: anchor.x + anchor.width - field.width }
              : kind === "top"
                ? { ...field, y: anchor.y }
                : kind === "bottom"
                  ? { ...field, y: anchor.y + anchor.height - field.height }
                  : kind === "hcenter"
                    ? {
                        ...field,
                        x: anchor.x + anchor.width / 2 - field.width / 2,
                      }
                    : {
                        ...field,
                        y: anchor.y + anchor.height / 2 - field.height / 2,
                      }
      )
    );
  };
  const changeLayer = (front: boolean) =>
    commit(
      fields.map(field =>
        selected.includes(field.id)
          ? {
              ...field,
              zIndex: front
                ? Math.max(...fields.map(item => item.zIndex ?? 1)) + 1
                : Math.min(...fields.map(item => item.zIndex ?? 1)) - 1,
            }
          : field
      )
    );
  const confirmAll = () => {
    const incomplete = fields.filter(
      field =>
        !field.label.trim() ||
        !FIELD_TYPES.includes(field.type) ||
        (field.status === "suggested" && (field.aiConfidence ?? 0) < 0.75)
    );
    if (incomplete.length)
      return toast.error(
        tr(`仍有 ${incomplete.length} 個欄位屬低信心或缺少名稱／類型，請逐項處理。`, `${incomplete.length} fields still have low confidence or are missing a name/type. Handle each one.`)
      );
    const reviewNotice = locale === "en"
      ? "Confirm that you reviewed every field. This records your review; it does not guarantee that recognition is perfect. Continue?"
      : locale === "zh-Hans"
        ? "请确认你已逐项检查所有字段。此操作只记录你的人工检查，并不代表系统保证识别结果完全正确。是否继续？"
        : "請確認你已逐項檢查所有欄位。此操作只記錄你的人工檢查，並不代表系統保證辨識結果完全正確。是否繼續？";
    if (!window.confirm(reviewNotice)) return;
    commit(
      fields.map(field => ({ ...field, confirmed: true, status: "confirmed" }))
    );
  };
  const confirmSelected = () => {
    const targets = fields.filter(field => selected.includes(field.id));
    if (!targets.length) return;
    if (
      targets.some(
        field => !field.label.trim() || !FIELD_TYPES.includes(field.type)
      )
    )
      return toast.error(tr("選取欄位仍缺少名稱或類型。", "The selected fields still need a name or type."));
    commit(
      fields.map(field =>
        selected.includes(field.id)
          ? { ...field, confirmed: true, status: "confirmed" }
          : field
      ),
      tr("批量確認欄位", "Fields batch-confirmed")
    );
  };
  const publishVersion = async () => {
    if (
      fields.some(field => field.status !== "confirmed" || !field.label.trim())
    )
      return toast.error(tr("所有欄位必須命名並人工確認後才可發佈。", "Every field needs a name and human confirmation before publishing."));
    for (const field of fields) {
      if (field.type === "table" && field.tableFormulaCells?.length) {
        const formulaIssues = validateTableFormulaDefinition(field, formulaLang);
        if (formulaIssues.length) {
          return toast.error(
            tr(
              `表格「${field.label}」公式錯誤：${formulaIssues[0]?.message}`,
              `Table "${field.label}" formula error: ${formulaIssues[0]?.message}`
            )
          );
        }
      }
    }
    try {
      if (dirty) await save();
      await publish.mutateAsync({ versionId });
      refresh();
      await detailsQuery.refetch();
      toast.success(tr("Template Version 已發佈及鎖定", "Template Version published and locked"));
    } catch (error) {
      serverError(error, "發佈失敗", "Publish failed");
    }
  };
  const cloneToDraft = async () => {
    if (clone.isPending) return;
    try {
      const result = await clone.mutateAsync({
        versionId,
        note: cloneNote.trim() || undefined,
      });
      setCloneDialogOpen(false);
      refresh();
      window.location.search = `?view=editor&version=${encodeURIComponent(result.versionId)}`;
    } catch (error) {
      serverError(error, "建立 Draft 失敗", "Could not create the Draft");
    }
  };
  const persistPages = async (next: typeof pages) => {
    const normalized = next.map((page, index) => ({
      ...page,
      page: index + 1,
    }));
    await savePages.mutateAsync({ versionId, pageManifest: normalized });
    const oldToNew = new Map<number, number>();
    next.forEach((page, newIndex) => {
      const oldIndex = pages.indexOf(page);
      if (oldIndex >= 0) oldToNew.set(oldIndex + 1, newIndex + 1);
    });
    if (
      next.length === pages.length &&
      oldToNew.size === pages.length &&
      Array.from(oldToNew).some(([oldPage, newPage]) => oldPage !== newPage)
    ) {
      const reorderedFields = fields.map(field => ({
        ...field,
        page: oldToNew.get(field.page ?? 1) ?? field.page,
      }));
      setFields(reorderedFields);
      await saveFields.mutateAsync({
        versionId,
        fields: serializeCanvasFields(reorderedFields, normalized),
      });
      setActionHistory(history =>
        [{ label: tr("重新排序頁面及其欄位", "Pages and fields reordered"), at: Date.now() }, ...history].slice(
          0,
          50
        )
      );
    } else if (next.length === pages.length + 1) {
      const insertedIndex = next.findIndex(page => !pages.includes(page));
      const inserted = next[insertedIndex];
      const sourceIndex = inserted
        ? pages.findIndex(
            page =>
              page.assetId === inserted.assetId &&
              page.widthMm === inserted.widthMm &&
              page.heightMm === inserted.heightMm
          )
        : -1;
      if (insertedIndex >= 0 && sourceIndex >= 0) {
        const insertPageNumber = insertedIndex + 1;
        const shifted = fields.map(field => ({
          ...field,
          page:
            (field.page ?? 1) >= insertPageNumber
              ? (field.page ?? 1) + 1
              : field.page,
        }));
        const copies = fields
          .filter(field => (field.page ?? 1) === sourceIndex + 1)
          .map((field, index) => ({
            ...field,
            id: `field-${crypto.randomUUID().slice(0, 8)}`,
            label: field.label ? `${field.label} ${tr("副本", "copy")}` : "",
            page: insertPageNumber,
            zIndex: shifted.length + index + 1,
          }));
        const duplicatedFields = [...shifted, ...copies];
        setFields(duplicatedFields);
        await saveFields.mutateAsync({
          versionId,
          fields: serializeCanvasFields(duplicatedFields, normalized),
        });
        setActionHistory(history =>
          [{ label: tr("複製頁面及頁上欄位", "Page and its fields duplicated"), at: Date.now() }, ...history].slice(
            0,
            50
          )
        );
      }
    }
    setPages(normalized);
    setDirty(true);
    setActivePage(Math.min(activePage, normalized.length));
  };
  const addPage = async (file?: File) => {
    if (!file || !data) return;
    try {
      const page = await processImagePage(file, {
        autoCrop: true,
        contrast: 1.08,
      });
      const asset = await upload.mutateAsync({
        base64: await blobToBase64(page.blob),
        kind: "page",
        mimeType: "image/png",
        originalFilename: file.name,
        templateId: data.template.id,
        templateVersionId: versionId,
        metadata: { purpose: "inserted-page" },
      });
      await persistPages([
        ...pages,
        {
          page: pages.length + 1,
          widthMm: page.widthMm,
          heightMm: page.heightMm,
          rotation: 0,
          assetId: asset.asset.id,
          mimeType: "image/png",
        },
      ]);
      setActivePage(pages.length + 1);
      toast.success(tr("頁面已插入", "Page inserted"));
    } catch (error) {
      serverError(error, "插入頁面失敗", "Could not insert the page");
    }
  };

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName ?? "";
      // S2-R4 #4：輸入框／可編輯元素（含其子節點）內的快捷鍵一律不攔截。
      const editable =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target?.isContentEditable === true ||
        !!target?.closest("[contenteditable='true']");
      if (editable) return;
      if (event.defaultPrevented) return;
      if (
        !(event.metaKey || event.ctrlKey) &&
        !["Delete", "Backspace"].includes(event.key)
      )
        return;
      // S2-R1（第二輪）#5：有未提交的表格操作時，衝突入口明確停用
      // （Ctrl+S 儲存、Ctrl+Z/Y 復原重做、Ctrl+D 複製、Ctrl+P 預覽、Delete/
      // Backspace 刪除），避免暗中提交 preview 或覆蓋手勢結果。
      //
      // 停用必須「吃掉事件」而不只是「不執行」：實測若只 return 不
      // preventDefault，Blink 會接手 Ctrl+Z 的瀏覽器預設復原，把焦點移到
      // 上一次編輯過的輸入框（設定側欄的 number input），造成
      //   (1) 後續 Esc 打不到原本的把手，取消失效；
      //   (2) 更嚴重的是它可能悄悄復原使用者在別處輸入的文字。
      // 因此在 busy 時明確 preventDefault + stopImmediatePropagation。
      if (tableGestureBusy) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        save();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d") {
        event.preventDefault();
        duplicate();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p") {
        event.preventDefault();
        if (data?.version.state === "published") onFill(versionId);
        else toast.info(tr("先發佈 Template 才可建立預覽。", "Publish the Template before creating a preview."));
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        // S2-R2：表格子格／格線上下文下，Delete/Backspace 不刪整表（攔截，不冒泡成 deleteSelected）。
        if (activeField?.type === "table" && tableEditMode !== "field") return;
        deleteSelectionWithGuard();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  // 階段 2／S2-01＋S2-04：表格模式的鍵盤入口（僅在選取表格欄位、且焦點不在輸入框時）。
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      // S2-R4 #4：Ctrl/Meta/Alt 組合鍵不應被當成模式切換（如 Ctrl+C 不切到逐格模式）。
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (
        target?.isContentEditable === true ||
        !!target?.closest("[contenteditable='true']")
      )
        return;
      // modal / popover 先取得這些按鍵
      if (
        target?.closest("[role='dialog']") ||
        target?.closest("[data-popover]") ||
        target?.closest("[popover]")
      )
        return;
      if (!activeField || activeField.type !== "table") return;
      if (event.key === "Escape") {
        // 自然操作的可達 Escape：只有無手勢時才逐格→格線→欄位→退出。
        if (tableEditMode === "cell") setTableEditMode("gridline");
        else if (tableEditMode === "gridline") setTableEditMode("field");
        else setSelected([]);
        event.preventDefault();
      } else if (event.key.toLowerCase() === "g") {
        setTableEditMode("gridline");
        event.preventDefault();
      } else if (event.key.toLowerCase() === "c") {
        setTableEditMode("cell");
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeField, tableEditMode, setSelected]);

  if (detailsQuery.isLoading)
    return (
      <div className="grid min-h-96 place-items-center text-sm text-slate-500">
        {tr("正在載入 Version Snapshot…", "Loading Version snapshot…")}
      </div>
    );
  if (!data)
    return (
      <div className="grid min-h-96 place-items-center">
        <button className="btn-paper" onClick={onBack}>
          {tr("返回範本庫", "Back to Template Library")}
        </button>
      </div>
    );
  return (
    <div>
      <header className="editor-header !min-h-14">
        <div className="row">
          <button className="icon-button" onClick={onBack}>
            <ArrowLeft size={15} />
          </button>
          <div>
            <h1>
              {data.template.name} · v{data.version.versionNumber}
            </h1>
            <span>
              {data.version.state.toUpperCase()} ·{" "}
              {saveState === "saving"
                ? tr("自動保存中…", "Autosaving…")
                : saveState === "unsaved"
                  ? tr("等待保存", "Waiting to save")
                  : tr("已保存至 localhost", "Saved to localhost")}
            </span>
          </div>
        </div>
        <div className="row">
          {isDraft ? (
            <>
              <button className="btn-paper" onClick={() => save()}>
                <Save size={14} />
                {tr("儲存", "Save")}
              </button>
              <button
                className="btn-red"
                onClick={publishVersion}
                disabled={publish.isPending}
              >
                <Check size={14} />
                {tr("發佈", "Publish")}
              </button>
            </>
          ) : (
            <>
              <button className="btn-paper" onClick={() => { setCloneNote(""); setCloneDialogOpen(true); }}>
                <Copy size={14} />
                {tr("建立新 Draft", "Create new Draft")}
              </button>
              <button className="btn-ink" onClick={() => onFill(versionId)}>
                {tr("建立 Instance", "Create Instance")}
              </button>
            </>
          )}
        </div>
      </header>
      <Dialog open={cloneDialogOpen} onOpenChange={open => { if (!clone.isPending) setCloneDialogOpen(open); }}>
        <DialogContent>
          <DialogTitle>{tr("建立新 Draft", "Create new Draft")}</DialogTitle>
          <DialogDescription>{tr("從目前已發佈版本建立可編輯的草稿。", "Create an editable draft from this published version.")}</DialogDescription>
          <form onSubmit={event => { event.preventDefault(); void cloneToDraft(); }}>
            <label htmlFor="clone-version-note">{tr("版本備註（可留空）", "Version note (optional)")}</label>
            <input id="clone-version-note" className="mt-2 w-full rounded border p-2" value={cloneNote} onChange={event => setCloneNote(event.target.value)} disabled={clone.isPending} />
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="btn-paper" disabled={clone.isPending} onClick={() => setCloneDialogOpen(false)}>{tr("取消", "Cancel")}</button>
              <button type="submit" className="btn-ink" disabled={clone.isPending}>{clone.isPending ? tr("建立中…", "Creating…") : tr("建立草稿", "Create draft")}</button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      {isPractice && <PracticeCoach key={versionId} versionId={versionId} fields={fields} index={practiceStep}
        onStep={index=>{setPracticeStep(index);const lesson=practiceLessons[index];if(lesson)locatePractice(lesson,false);else {setActivePage(8);setSelected([]);}}}
        onLocate={locatePractice} onFrame={framePractice} hasSelection={selected.length===1} isDraft={isDraft}
        onUseSelected={lesson=>{if(!isDraft||selected.length!==1||matchingPracticeFields(lesson,fields).length)return;updateField(selected[0],{label:`${lesson.id} ${lesson.title[0]}`,confirmed:false,status:'needs-review'});}}
        saveState={saveState} pages={pages.length} outputReviewed={outputReviewQuery.data?.reviewed===true} busy={tableGestureBusy} />}
      <TemplateWorkflowGuide completed={workflowCompletion({
        hasPages: pages.length > 0,
        hasFields: fields.length > 0,
        hasTableFormula: fields.some(field => field.type === "table" && (field.tableFormulaCells?.length ?? 0) > 0),
        allFieldsConfirmed: fields.length > 0 && fields.every(field => field.status === "confirmed"),
        isDraft: Boolean(isDraft),
        outputChecked: outputReviewQuery.data?.reviewed === true,
      })} />
      <div
        className="editor-toolbar mt-2 flex flex-wrap items-center gap-1 border bg-[#fffdfa] p-2"
        role="toolbar"
        aria-label={tr("欄位編輯工具", "Field editing tools")}
      >
        <button
          className="icon-button"
          onClick={undo}
          disabled={!undoStack.length}
          title={tr("復原", "Undo")}
        >
          <Undo2 size={14} />
        </button>
        <button
          className="icon-button"
          onClick={redo}
          disabled={!redoStack.length}
          title={tr("重做", "Redo")}
        >
          <Redo2 size={14} />
        </button>
        <button
          className={`btn-paper !min-h-8 ${drawing ? "!border-[#d9573b] !bg-[#f8e7e2]" : ""}`}
          onClick={() => setDrawing(value => !value)}
          disabled={!isDraft}
        >
          <MousePointer2 size={13} />
          {drawing
            ? tr("在頁上拖出方框…", "Drag a box on the page…")
            : tr("拖拉新增欄位", "Drag to add a field")}
        </button>
        <button
          className="btn-paper !min-h-8"
          onClick={addField}
          disabled={!isDraft}
        >
          <Plus size={13} />
          {tr("快速新增", "Quick add")}
        </button>
        <button
          className="icon-button"
          onClick={duplicate}
          disabled={!selected.length || !isDraft}
          title={tr("複製", "Duplicate")}
        >
          <Copy size={14} />
        </button>
        <button
          className="icon-button"
          onClick={deleteSelectionWithGuard}
          disabled={!selected.length || !isDraft}
          title={tr("刪除", "Delete")}
        >
          <Trash2 size={14} />
        </button>
        <span className="mx-1 h-6 border-l" />
        <button
          className={`icon-button ${snap ? "!bg-[#f8e7e2]" : ""}`}
          onClick={() => setSnap(value => !value)}
          title={tr("Snap to Grid 與欄位邊界", "Snap to grid and field edges")}
        >
          <Grid3X3 size={14} />
        </button>
        <details className="editor-arrange-menu relative">
          <summary className="btn-paper !min-h-8 cursor-pointer list-none">
            {tr("排列", "Arrange")}
          </summary>
          <div className="absolute left-0 top-full z-20 mt-1 grid grid-cols-5 gap-1 border bg-[#fffdfa] p-2 shadow-lg">
        <button
          className="icon-button"
          onClick={() => align("left")}
          title={tr("靠左對齊", "Align left")}
        >
          L
        </button>
        <button
          className="icon-button"
          onClick={() => align("right")}
          title={tr("靠右對齊", "Align right")}
        >
          R
        </button>
        <button
          className="icon-button"
          onClick={() => align("top")}
          title={tr("靠上對齊", "Align top")}
        >
          T
        </button>
        <button
          className="icon-button"
          onClick={() => align("bottom")}
          title={tr("靠下對齊", "Align bottom")}
        >
          B
        </button>
        <button
          className="icon-button"
          onClick={() => align("hcenter")}
          title={tr("水平置中", "Center horizontally")}
        >
          <AlignCenterVertical size={14} />
        </button>
        <button
          className="icon-button"
          onClick={() => align("vcenter")}
          title={tr("垂直置中", "Center vertically")}
        >
          <AlignCenterHorizontal size={14} />
        </button>
        <button
          className="icon-button"
          onClick={() => distribute("horizontal")}
          title={tr("水平平均分佈", "Distribute horizontally")}
        >
          <AlignHorizontalDistributeCenter size={14} />
        </button>
        <button
          className="icon-button"
          onClick={() => distribute("vertical")}
          title={tr("垂直平均分佈", "Distribute vertically")}
        >
          <AlignVerticalDistributeCenter size={14} />
        </button>
        <button
          className="icon-button"
          onClick={() => changeLayer(true)}
          title={tr("移至最上層", "Bring to front")}
        >
          <BringToFront size={14} />
        </button>
        <button
          className="icon-button"
          onClick={() => changeLayer(false)}
          title={tr("移至最下層", "Send to back")}
        >
          <SendToBack size={14} />
        </button>
          </div>
        </details>
        <span className="ml-auto text-[10px] text-slate-500">
          {tr(`已選 ${selected.length} 個`, `${selected.length} selected`)}
        </span>
        <button
          className="btn-paper !min-h-8"
          onClick={confirmSelected}
          disabled={!isDraft || !selected.length}
        >
          <Check size={13} />
          {tr("確認已選", "Confirm selected")}
        </button>
        <button
          className="btn-paper !min-h-8"
          onClick={confirmAll}
          disabled={!isDraft}
          title={locale === "en" ? "Records your review; it is not a guarantee of perfect recognition." : locale === "zh-Hans" ? "仅记录人工检查，不保证识别结果完全正确。" : "只記錄人工檢查，不保證辨識結果完全正確。"}
        >
          <Check size={13} />
          {tr("全部確認", "Confirm all")}
        </button>
        <button
          className="icon-button"
          onClick={() => setZoom(value => Math.max(0.6, value - 0.1))}
        >
          <ZoomOut size={14} />
        </button>
        <span className="w-11 text-center text-[10px]">
          {Math.round(zoom * 100)}%
        </span>
        <button
          className="icon-button"
          onClick={() => setZoom(value => Math.min(1.8, value + 0.1))}
        >
          <ZoomIn size={14} />
        </button>
      </div>
      <div className="editor-layout">
        <aside className="editor-nav panel-surface overflow-auto">
          <div className="panel-title">
            <span>{tr("頁面", "Pages")}</span>
            <small>{pages.length}</small>
          </div>
          {pages.map((page, index) => (
            <div
              key={`${page.assetId}-${index}`}
              draggable={isDraft}
              onDragStart={event =>
                event.dataTransfer.setData(
                  "text/formdigital-page",
                  String(index)
                )
              }
              onDragOver={event => event.preventDefault()}
              onDrop={event => {
                const from = Number(
                  event.dataTransfer.getData("text/formdigital-page")
                );
                if (!Number.isInteger(from) || from === index) return;
                const next = [...pages];
                const [moved] = next.splice(from, 1);
                next.splice(index, 0, moved!);
                persistPages(next);
              }}
              className={`page-row !p-1 ${activePage === index + 1 ? "active" : ""}`}
            >
              <button
                className="flex flex-1 items-center gap-2 p-2 text-left"
                onClick={() => setActivePage(index + 1)}
              >
                Page {index + 1}
                <small>
                  {Math.round(page.widthMm ?? 210)}×
                  {Math.round(page.heightMm ?? 297)}
                </small>
              </button>
              {isDraft && (
                <>
                  <button
                    className="p-1"
                    disabled={index === 0}
                    onClick={() => {
                      const next = [...pages];
                      [next[index - 1], next[index]] = [
                        next[index]!,
                        next[index - 1]!,
                      ];
                      persistPages(next);
                    }}
                  >
                    <ArrowUp size={12} />
                  </button>
                  <button
                    className="p-1"
                    disabled={index === pages.length - 1}
                    onClick={() => {
                      const next = [...pages];
                      [next[index + 1], next[index]] = [
                        next[index]!,
                        next[index + 1]!,
                      ];
                      persistPages(next);
                    }}
                  >
                    <ArrowDown size={12} />
                  </button>
                  <button
                    className="p-1"
                    onClick={() =>
                      persistPages([
                        ...pages.slice(0, index + 1),
                        { ...page },
                        ...pages.slice(index + 1),
                      ])
                    }
                  >
                    <Copy size={12} />
                  </button>
                  <button
                    className="p-1 text-red-600"
                    disabled={pages.length === 1}
                    onClick={() =>
                      confirm(tr("刪除此頁及頁上欄位？", "Delete this page and its fields?")) &&
                      (commit(
                        fields
                          .filter(field => field.page !== index + 1)
                          .map(field => ({
                            ...field,
                            page:
                              (field.page ?? 1) > index + 1
                                ? (field.page ?? 1) - 1
                                : field.page,
                          })),
                        tr("刪除頁面", "Page deleted")
                      ),
                      persistPages(
                        pages.filter((_, itemIndex) => itemIndex !== index)
                      ))
                    }
                  >
                    <Trash2 size={12} />
                  </button>
                </>
              )}
            </div>
          ))}
          {isDraft && (
            <button
              className="page-row"
              onClick={() => pageInput.current?.click()}
            >
              <FilePlus size={13} />
              {tr("插入圖片頁", "Insert image page")}
            </button>
          )}
          <input
            ref={pageInput}
            hidden
            type="file"
            accept="image/jpeg,image/png"
            onChange={event => addPage(event.target.files?.[0])}
          />
          {isDraft && activeManifest && (
            <div className="border-b p-3">
              <label className="setting-label !mt-0">{tr("紙張／方向", "Paper / orientation")}</label>
              <select
                className="setting-select"
                value={
                  [
                    [210, 297, tr("A4 直向", "A4 portrait")],
                    [297, 210, tr("A4 橫向", "A4 landscape")],
                    [297, 420, tr("A3 直向", "A3 portrait")],
                    [420, 297, tr("A3 橫向", "A3 landscape")],
                    [215.9, 279.4, "Letter"],
                    [215.9, 355.6, "Legal"],
                  ].find(
                    ([w, h]) =>
                      Math.abs(Number(w) - (activeManifest.widthMm ?? 210)) <
                        0.2 &&
                      Math.abs(Number(h) - (activeManifest.heightMm ?? 297)) <
                        0.2
                  )?.[2] || "custom"
                }
                onChange={event => {
                  const preset = [
                    [210, 297, tr("A4 直向", "A4 portrait")],
                    [297, 210, tr("A4 橫向", "A4 landscape")],
                    [297, 420, tr("A3 直向", "A3 portrait")],
                    [420, 297, tr("A3 橫向", "A3 landscape")],
                    [215.9, 279.4, "Letter"],
                    [215.9, 355.6, "Legal"],
                  ].find(item => item[2] === event.target.value);
                  if (preset)
                    persistPages(
                      pages.map((item, index) =>
                        index === activePage - 1
                          ? {
                              ...item,
                              widthMm: Number(preset[0]),
                              heightMm: Number(preset[1]),
                            }
                          : item
                      )
                    );
                }}
              >
                <option value="custom">{tr("自訂尺寸", "Custom size")}</option>
                <option>{tr("A4 直向", "A4 portrait")}</option>
                <option>{tr("A4 橫向", "A4 landscape")}</option>
                <option>{tr("A3 直向", "A3 portrait")}</option>
                <option>{tr("A3 橫向", "A3 landscape")}</option>
                <option>Letter</option>
                <option>Legal</option>
              </select>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <label className="text-[9px]">
                  {tr("寬 mm", "Width mm")}
                  <input
                    className="setting-input mt-1"
                    type="number"
                    value={activeManifest.widthMm ?? 210}
                    onChange={event =>
                      setPages(current =>
                        current.map((item, index) =>
                          index === activePage - 1
                            ? { ...item, widthMm: Number(event.target.value) }
                            : item
                        )
                      )
                    }
                    onBlur={() => persistPages(pages)}
                  />
                </label>
                <label className="text-[9px]">
                  {tr("高 mm", "Height mm")}
                  <input
                    className="setting-input mt-1"
                    type="number"
                    value={activeManifest.heightMm ?? 297}
                    onChange={event =>
                      setPages(current =>
                        current.map((item, index) =>
                          index === activePage - 1
                            ? { ...item, heightMm: Number(event.target.value) }
                            : item
                        )
                      )
                    }
                    onBlur={() => persistPages(pages)}
                  />
                </label>
              </div>
            </div>
          )}
          <div className="panel-title">
            <span>{tr("原始來源", "Original source")}</span>
            <small>{sourceAssets.length}</small>
          </div>
          {sourceAssets.length ? (
            sourceAssets.map(asset => (
              <div
                key={asset.id}
                className="flex items-center gap-1 border-b p-2 text-[9px]"
              >
                <a
                  className="min-w-0 flex-1 truncate text-[#a23f2b] underline"
                  href={`/api/local/assets/${encodeURIComponent(asset.id)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {asset.originalFilename}
                </a>
                {isDraft && (
                  <button
                    className="p-1 text-red-600"
                    title={tr("只刪除原始來源；獨立頁面資產不受影響", "Deletes the original source only. Independent page assets are unaffected.")}
                    onClick={async () => {
                      if (
                        !confirm(
                          tr(`刪除原始來源「${asset.originalFilename}」？Template 頁面及欄位會保留。`, `Delete original source "${asset.originalFilename}"? Template pages and fields are retained.`)
                        )
                      )
                        return;
                      await deleteAsset.mutateAsync({ assetId: asset.id });
                      await assetsQuery.refetch();
                    }}
                  >
                    <Trash2 size={11} />
                  </button>
                )}
              </div>
            ))
          ) : (
            <p className="border-b p-3 text-[9px] text-slate-400">
              {tr("沒有保留的原始來源", "No original sources retained")}
            </p>
          )}
          <div className="panel-title">
            <span>{tr("欄位", "Fields")}</span>
            <small>
              {fields.filter(field => (field.page ?? 1) === activePage).length}
            </small>
          </div>
          {fields
            .filter(field => (field.page ?? 1) === activePage)
            .map(field => (
              <button
                key={field.id}
                data-field-type={field.type}
                className={`field-row ${selected.includes(field.id) ? "active" : ""}`}
                onClick={event =>
                  setSelected(current =>
                    event.shiftKey
                      ? current.includes(field.id)
                        ? current.filter(id => id !== field.id)
                        : [...current, field.id]
                      : [field.id]
                  )
                }
              >
                <i className={`field-dot ${field.status}`} />
                <span className="truncate">
                  {field.label || tr("未命名欄位", "Untitled field")}
                </span>
              </button>
            ))}
          <div className="panel-title">
            <span>{tr("版本歷史", "Version history")}</span>
            <small>{versionsQuery.data?.length ?? 0}</small>
          </div>
          <div className="border-b p-2">
            <select
              className="setting-select"
              value={compareVersionId}
              onChange={event => setCompareVersionId(event.target.value)}
            >
              <option value="">{tr("選擇版本作比較…", "Choose a version to compare…")}</option>
              {(versionsQuery.data ?? [])
                .filter(version => version.id !== versionId)
                .map(version => (
                  <option key={version.id} value={version.id}>
                    v{version.versionNumber} · {version.state}
                  </option>
                ))}
            </select>
            {comparison && (
              <p className="mt-2 text-[9px] text-slate-600">
                {tr("相對所選版本：新增", "Compared with the selected version: added")}{" "}
                {comparison.added}
                {tr("、刪除", ", removed")} {comparison.removed}
                {tr("、修改", ", changed")} {comparison.changed}
              </p>
            )}
          </div>
          {(versionsQuery.data ?? []).map(version => (
            <div key={version.id} className="border-b px-3 py-2 text-[10px]">
              <b>
                v{version.versionNumber} · {version.state}
              </b>
              <p className="mt-1 text-slate-500">
                {version.note || tr("沒有備註", "No note")}
              </p>
              <time className="mt-1 block text-[8px] text-slate-400">
                {new Date(version.createdAt).toLocaleString()}
              </time>
            </div>
          ))}
          <div className="panel-title">
            <span>
              <History className="mr-1 inline" size={11} />
              {tr("操作歷史", "Action history")}
            </span>
            <small>{actionHistory.length}</small>
          </div>
          {actionHistory.length ? (
            actionHistory.map((entry, index) => (
              <div
                key={`${entry.at}-${index}`}
                className="border-b px-3 py-2 text-[9px]"
              >
                <span>{entry.label}</span>
                <time className="mt-1 block text-[8px] text-slate-400">
                  {new Date(entry.at).toLocaleTimeString()}
                </time>
              </div>
            ))
          ) : (
            <p className="p-3 text-[9px] text-slate-400">
              {tr("本次開啟尚無操作", "No actions in this session")}
            </p>
          )}
        </aside>
        <main className="editor-canvas" ref={canvasRef}>
          <FormCanvas
            practiceGuide={currentLesson && activePage===currentLesson.page ? {
              label:currentLesson.id, x:currentLesson.box.x/210*100,y:currentLesson.box.y/297*100,
              width:currentLesson.box.width/210*100,height:currentLesson.box.height/297*100,
              marks:currentLesson.marks ?? currentLesson.segments,
            } : undefined}
            fields={fields}
            values={{}}
            activeFieldId={selected[0] ?? ""}
            selectedFieldIds={selected}
            onActivate={id => setSelected([id])}
            onToggleSelection={(id, additive) =>
              setSelected(current =>
                additive
                  ? current.includes(id)
                    ? current.filter(item => item !== id)
                    : [...current, id]
                  : [id]
              )
            }
            onUpdateField={isDraft ? updateField : undefined}
            onDrawField={isDraft ? drawOrRetargetField : undefined}
            drawingEnabled={drawing}
            suppressFieldInteraction={Boolean(choiceRetargetId)}
            snapToFields={snap}
            mode="editor"
            page={activePage}
            pageWidthMm={activeManifest?.widthMm ?? 210}
            pageHeightMm={activeManifest?.heightMm ?? 297}
            showDemoBackground={false}
            backgroundUrl={assetQuery.data?.url}
            backgroundMimeType={assetQuery.data?.asset.mimeType}
            zoom={zoom}
            tableEditMode={tableEditMode}
            tableActiveGroup={tableActiveGroup}
            tableFocusIndex={tableFocusIndex}
            onTableFocusHandled={() => setTableFocusIndex(null)}
            onTableGestureBusy={setTableGestureBusy}
          />
        </main>
        <aside className="editor-inspector panel-surface overflow-auto">
          <div className="panel-title">
            <span>{tr("欄位設定", "Field settings")}</span>
            <small>
              {activeField ? localizedFieldType(activeField.type) : "—"}
            </small>
          </div>
              {activeField ? (
                <div className="inspector-body">
                  <FieldSettingsNavigator table={activeField.type === "table"} />
                  {/* S2-R4 #5：published／preview／Instance 不顯示本輪可寫工具；保留既有 isDraft 保護。 */}
                  {activeField.type === "table" && isDraft && (
                    <TableEditingControls
                      field={activeField}
                      mode={tableEditMode}
                      onModeChange={setTableEditMode}
                      group={tableActiveGroup}
                      onGroupChange={setTableActiveGroup}
                      onDeleteTable={requestDeleteTable}
                      onRequestFocus={absolute => {
                        setTableEditMode("cell");
                        setTableFocusIndex(absolute);
                      }}
                    />
                  )}
              <details id="editor-section-template" className="mb-4 border bg-[#f7f4ee] p-3">
                <summary className="cursor-pointer text-[10px] font-semibold text-[#17364d]">
                  {tr("範本與已填表格的進階設定", "Advanced template and filled-form settings")}
                </summary>
                <label className="setting-label">
                  {tr("已填表格命名規則", "Filled form naming pattern")}
                </label>
                <input
                  className="setting-input"
                  defaultValue={data.template.instanceNamePattern}
                  onBlur={async event => {
                    await updateMetadata.mutateAsync({
                      templateId: data.template.id,
                      instanceNamePattern: event.target.value,
                    });
                    refresh();
                  }}
                  placeholder="{TemplateName}_{Date}_{Time}"
                />
                <p className="mt-1 text-[8px] text-slate-500">
                  {tr("可用 Template 名稱／版本、日期、時間及任何欄位名稱。", "Use Template name/version, date, time, and any field name.")}
                </p>
                <label className="setting-label">
                  {tr("列表關鍵欄位", "List key fields")}
                </label>
                <div className="max-h-28 overflow-auto border bg-[#fffdfa] p-2">
                  {fields.map(field => (
                    <label
                      key={field.id}
                      className="flex items-center gap-2 py-1 text-[9px]"
                    >
                      <input
                        type="checkbox"
                        checked={data.template.keyFieldIds.includes(field.id)}
                        onChange={async event => {
                          const keyFieldIds = event.target.checked
                            ? Array.from(
                                new Set([
                                  ...data.template.keyFieldIds,
                                  field.id,
                                ])
                              )
                            : data.template.keyFieldIds.filter(
                                id => id !== field.id
                              );
                          await updateMetadata.mutateAsync({
                            templateId: data.template.id,
                            keyFieldIds,
                          });
                          refresh();
                        }}
                      />
                      {field.label || field.id}
                    </label>
                  ))}
                </div>
              </details>
              <div id="editor-section-basic" className="field-status">
                {activeField.status === "confirmed"
                  ? tr("已人工確認", "Human confirmed")
                  : activeField.status === "suggested"
                    ? tr("OCR 建議", "OCR suggestion")
                    : tr("需要確認", "Needs confirmation")}
              </div>
              <label
                className="setting-label"
                htmlFor={`field-label-${activeField.id}`}
              >
                {tr("欄位名稱", "Field name")}
              </label>
              <input
                id={`field-label-${activeField.id}`}
                data-settings-section="basic"
                className="setting-input"
                disabled={!isDraft}
                value={activeField.label}
                onChange={event =>
                  updateField(activeField.id, {
                    label: event.target.value,
                    confirmed: false,
                    status: "needs-review",
                  })
                }
              />
              <label className="setting-label">{tr("欄位類型", "Field type")}</label>
              <select
                className="setting-select"
                disabled={!isDraft}
                value={activeField.type}
                onChange={event =>
                  updateField(activeField.id, {
                    type: event.target.value as FieldType,
                    // Persist the rows displayed by the inspector for new tables.
                    // The renderer deliberately keeps a one-row fallback for legacy data.
                    ...(event.target.value === "table" && activeField.maxRows == null
                      ? { maxRows: 3 }
                      : {}),
                    confirmed: false,
                    status: "needs-review",
                  })
                }
              >
                {FIELD_TYPES.map(type => (
                  <option key={type} value={type}>
                    {localizedFieldType(type)}
                  </option>
                ))}
              </select>
              <label className="toggle-row">
                <span>{tr("必填", "Required")}</span>
                <input
                  type="checkbox"
                  disabled={!isDraft}
                  checked={Boolean(activeField.required)}
                  onChange={event =>
                    updateField(activeField.id, {
                      required: event.target.checked,
                    })
                  }
                />
              </label>
              <label className="setting-label">{tr("提示文字", "Placeholder")}</label>
              <input
                className="setting-input"
                disabled={!isDraft}
                value={activeField.placeholder ?? ""}
                onChange={event =>
                  updateField(activeField.id, {
                    placeholder: event.target.value,
                  })
                }
              />
              {(activeField.type === "radio" || activeField.type === "checkbox") && (
                <section className="choice-setup" data-testid="choice-setup">
                  <h3>{activeField.type === "radio" ? tr("單選設定", "Single-choice setup") : tr("多選設定", "Multiple-choice setup")}</h3>
                  <p>{tr("選項數目不限；每行一個。可直接改名、刪除或調整順序。", "There is no option limit. Use one option per line; rename, remove, or reorder them directly.")}</p>
                  <label className="setting-label">{tr("選項（每行一個）", "Options (one per line)")}</label>
                  <textarea
                    data-testid="choice-options"
                    className="setting-input !h-24 py-2"
                    disabled={!isDraft}
                    value={optionsDraft && optionsDraft.id === activeField.id ? optionsDraft.text : (activeField.options ?? []).join("\n")}
                    onChange={event => {
                      const text = event.target.value;
                      const options = knownOptions(text.split("\n"));
                      setOptionsDraft({ id: activeField.id, text });
                      updateField(activeField.id, {
                        options,
                        optionMarks: optionMarksForOptions(activeField.optionMarks, options),
                      });
                    }}
                    onBlur={() => setOptionsDraft(null)}
                  />
                  <div className="choice-setup-actions">
                    <button
                      type="button"
                      className="btn-paper"
                      disabled={!isDraft}
                      onClick={() => {
                        const options = [...knownOptions(activeField.options), tr(`選項 ${knownOptions(activeField.options).length + 1}`, `Option ${knownOptions(activeField.options).length + 1}`)];
                        setOptionsDraft({ id: activeField.id, text: options.join("\n") });
                        updateField(activeField.id, { options, optionMarks: optionMarksForOptions(activeField.optionMarks, options) });
                      }}
                    >
                      {tr("＋ 新增選項", "+ Add option")}
                    </button>
                    <button
                      type="button"
                      className="btn-paper"
                      disabled={!isDraft}
                      onClick={() => {
                        const options = ["A", "B", "C", "D"];
                        updateField(activeField.id, { options, markStyle: "circle", optionMarks: optionMarksForOptions(undefined, options) });
                        setOptionsDraft(null);
                      }}
                    >
                      {tr("帶入 A／B／C／D 範例", "Use A/B/C/D example")}
                    </button>
                  </div>
                  <label className="setting-label">{tr("記號樣式", "Mark style")}</label>
                  <select
                    className="setting-input"
                    disabled={!isDraft}
                    value={activeField.markStyle ?? "check"}
                    onChange={event => updateField(activeField.id, { markStyle: event.target.value as FormField["markStyle"] })}
                  >
                    <option value="check">{tr("剔號 ✓", "Tick")}</option>
                    <option value="cross">{tr("交叉 ✗", "Cross")}</option>
                    <option value="dot">{tr("實心點 ●", "Dot")}</option>
                    <option value="circle">{tr("圈選選項 ◯", "Circle choices")}</option>
                  </select>
                  {activeField.markStyle === "circle" && (
                    <div className="choice-retarget" data-testid="choice-retarget-tools">
                      <p>{tr("先重新框住整組選項，再逐一拖動綠色框對準原表文字；單選只可選一項，多選可同時圈多項。", "First frame the whole option group, then drag each green box onto its printed text. Single choice allows one selection; multiple choice allows many.")}</p>
                      <button type="button" className="btn-ink" disabled={!isDraft || !knownOptions(activeField.options).length} onClick={beginChoiceRetarget}>
                        {tr("重新框選整組選項", "Reframe whole choice group")}
                      </button>
                    </div>
                  )}
                </section>
              )}
              {activeField.type === "select" && (
                <>
                  <label className="setting-label">{tr("選項（每行一個）", "Options (one per line)")}</label>
                  <textarea className="setting-input !h-20 py-2" disabled={!isDraft} value={optionsDraft && optionsDraft.id === activeField.id ? optionsDraft.text : (activeField.options ?? []).join("\n")} onChange={event => {
                    const text = event.target.value;
                    setOptionsDraft({ id: activeField.id, text });
                    updateField(activeField.id, { options: knownOptions(text.split("\n")) });
                  }} onBlur={() => setOptionsDraft(null)} />
                </>
              )}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="setting-label">{tr("最大字數", "Max characters")}</label>
                  <input
                    className="setting-input"
                    type="number"
                    disabled={!isDraft}
                    value={activeField.maxLength ?? ""}
                    onChange={event =>
                      updateField(activeField.id, {
                        maxLength: event.target.value
                          ? Number(event.target.value)
                          : undefined,
                      })
                    }
                  />
                </div>
                <div>
                  <label className="setting-label">{tr("字體 pt", "Font pt")}</label>
                  <input
                    className="setting-input"
                    type="number"
                    disabled={!isDraft}
                    value={activeField.fontSizePt ?? 10}
                    onChange={event =>
                      updateField(activeField.id, {
                        fontSizePt: Number(event.target.value),
                      })
                    }
                  />
                </div>
              </div>
              {activeFieldTextWarning && (
                <p className="field-geometry-warning-copy" role="alert" data-testid="text-geometry-warning">
                  {activeFieldTextWarning === "too-short"
                    ? tr("這個框的高度可能裁掉文字；請把框拉高或減小字體。", "This box may crop text vertically. Make it taller or reduce the font size.")
                    : tr("這個框可能放不下設定的字數；請把框拉寬、縮短字數或減小字體。", "This box may not fit the configured character count. Make it wider, lower the limit, or reduce the font size.")}
                </p>
              )}
              <label className="setting-label">{tr("輸入限制", "Input restriction")}</label>
              <select
                className="setting-select"
                disabled={!isDraft}
                value={activeField.inputMode ?? "any"}
                onChange={event =>
                  updateField(activeField.id, {
                    inputMode: event.target.value as FormField["inputMode"],
                  })
                }
              >
                <option value="any">{tr("文字與數字", "Text and numbers")}</option>
                <option value="text">{tr("只允許文字", "Text only")}</option>
                <option value="number">{tr("只允許數字", "Numbers only")}</option>
              </select>
              <label id="editor-section-appearance" className="setting-label">{tr("字體", "Font")}</label>
              <select
                className="setting-select"
                disabled={!isDraft}
                value={activeField.fontFamily ?? "Noto Sans TC"}
                onChange={event =>
                  updateField(activeField.id, {
                    fontFamily: event.target.value,
                  })
                }
              >
                <option>Noto Sans TC</option>
                <option>Microsoft JhengHei</option>
                <option>Arial</option>
                <option>Times New Roman</option>
                <option>KaiTi</option>
              </select>
              <label className="setting-label">{tr("對齊", "Alignment")}</label>
              <select
                className="setting-select"
                disabled={!isDraft}
                value={activeField.align ?? "left"}
                onChange={event =>
                  updateField(activeField.id, {
                    align: event.target.value as FormField["align"],
                  })
                }
              >
                <option value="left">{tr("靠左", "Left")}</option>
                <option value="center">{tr("置中", "Center")}</option>
                <option value="right">{tr("靠右", "Right")}</option>
              </select>
              <div className="mt-3 flex gap-2">
                <button
                  className={`icon-button ${activeField.bold ? "!bg-[#f8e7e2]" : ""}`}
                  onClick={() =>
                    updateField(activeField.id, { bold: !activeField.bold })
                  }
                >
                  <b>B</b>
                </button>
                <button
                  className={`icon-button ${activeField.italic ? "!bg-[#f8e7e2]" : ""}`}
                  onClick={() =>
                    updateField(activeField.id, { italic: !activeField.italic })
                  }
                >
                  <i>I</i>
                </button>
                <button
                  className={`icon-button ${activeField.underline ? "!bg-[#f8e7e2]" : ""}`}
                  onClick={() =>
                    updateField(activeField.id, {
                      underline: !activeField.underline,
                    })
                  }
                >
                  <u>U</u>
                </button>
                <input
                  className="h-8 w-10"
                  type="color"
                  value={activeField.color ?? "#113d66"}
                  onChange={event =>
                    updateField(activeField.id, { color: event.target.value })
                  }
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="setting-label">{tr("字距 pt", "Letter spacing pt")}</label>
                  <input
                    className="setting-input"
                    type="number"
                    step=".1"
                    value={activeField.letterSpacingPt ?? 0}
                    onChange={event =>
                      updateField(activeField.id, {
                        letterSpacingPt: Number(event.target.value),
                      })
                    }
                  />
                </div>
                <div>
                  <label className="setting-label">{tr("行距 pt", "Line height pt")}</label>
                  <input
                    className="setting-input"
                    type="number"
                    step=".1"
                    value={activeField.lineHeightPt ?? 12}
                    onChange={event =>
                      updateField(activeField.id, {
                        lineHeightPt: Number(event.target.value),
                      })
                    }
                  />
                </div>
              </div>
              <label className="setting-label">{tr("固定預設值", "Fixed default")}</label>
              <input
                className="setting-input"
                disabled={!isDraft}
                value={activeField.defaultValue ?? ""}
                onChange={event =>
                  updateField(activeField.id, {
                    defaultValue: event.target.value,
                  })
                }
              />
              {(activeField.type === "date" || activeField.type === "time") && (
                <>
                  <label className="setting-label">{tr("動態預設", "Dynamic default")}</label>
                  <select
                    className="setting-select"
                    disabled={!isDraft}
                    value={activeField.dynamicDefault ?? ""}
                    onChange={event =>
                      updateField(activeField.id, {
                        dynamicDefault:
                          event.target.value === "today" ||
                          event.target.value === "now"
                            ? event.target.value
                            : null,
                      })
                    }
                  >
                    <option value="">{tr("沒有", "None")}</option>
                    {activeField.type === "date" && (
                      <option value="today">{tr("今日日期", "Today's date")}</option>
                    )}
                    {activeField.type === "time" && (
                      <option value="now">{tr("當前時間", "Current time")}</option>
                    )}
                  </select>
                  <label className="setting-label">{tr("顯示格式", "Display format")}</label>
                  {activeField.type === "date" ? (
                    <select
                      className="setting-select"
                      value={activeField.dateFormat ?? "yyyy-mm-dd"}
                      onChange={event =>
                        updateField(activeField.id, {
                          dateFormat: event.target
                            .value as FormField["dateFormat"],
                        })
                      }
                    >
                      <option value="yyyy-mm-dd">YYYY-MM-DD</option>
                      <option value="dd-mm-yyyy">DD-MM-YYYY</option>
                      <option value="mm-dd-yyyy">MM-DD-YYYY</option>
                    </select>
                  ) : (
                    <select
                      className="setting-select"
                      value={activeField.timeFormat ?? "hh:mm"}
                      onChange={event =>
                        updateField(activeField.id, {
                          timeFormat: event.target
                            .value as FormField["timeFormat"],
                        })
                      }
                    >
                      <option value="hh:mm">HH:mm</option>
                      <option value="hhmm">HHmm</option>
                    </select>
                  )}
                </>
              )}
              <label className="setting-label">{tr("超限處理", "Overflow handling")}</label>
              <select
                className="setting-select"
                value={activeField.overflow ?? "warn"}
                onChange={event =>
                  updateField(activeField.id, {
                    overflow: event.target.value as FormField["overflow"],
                  })
                }
              >
                <option value="block">{tr("禁止輸入", "Block input")}</option>
                <option value="shrink">{tr("自動縮小", "Shrink automatically")}</option>
                <option value="warn">{tr("警告但允許", "Warn but allow")}</option>
                <option value="wrap">{tr("多行換行", "Wrap lines")}</option>
              </select>
              <label className="setting-label">{tr("驗證", "Validation")}</label>
              <select
                className="setting-select"
                value={activeField.validation ?? "none"}
                onChange={event =>
                  updateField(activeField.id, {
                    validation: event.target.value as FormField["validation"],
                  })
                }
              >
                <option value="none">{tr("一般", "General")}</option>
                <option value="email">Email</option>
                <option value="phone">{tr("電話", "Phone")}</option>
                <option value="regex">Regex</option>
              </select>
              {activeField.validation === "regex" && (
                <input
                  className="setting-input mt-2"
                  value={activeField.regex ?? ""}
                  onChange={event =>
                    updateField(activeField.id, { regex: event.target.value })
                  }
                  placeholder="^[A-Z0-9]+$"
                />
              )}
              {activeField.type === "number" && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="setting-label">{tr("最小值", "Minimum")}</label>
                    <input
                      className="setting-input"
                      type="number"
                      value={activeField.min ?? ""}
                      onChange={event =>
                        updateField(activeField.id, {
                          min: event.target.value
                            ? Number(event.target.value)
                            : undefined,
                        })
                      }
                    />
                  </div>
                  <div>
                    <label className="setting-label">{tr("最大值", "Maximum")}</label>
                    <input
                      className="setting-input"
                      type="number"
                      value={activeField.max ?? ""}
                      onChange={event =>
                        updateField(activeField.id, {
                          max: event.target.value
                            ? Number(event.target.value)
                            : undefined,
                        })
                      }
                    />
                  </div>
                </div>
              )}
              {activeField.type === "characterBox" && (
                <>
                  <label className="setting-label">{tr("格數", "Box count")}</label>
                  <input
                    className="setting-input"
                    type="number"
                    min="1"
                    max="64"
                    value={activeField.boxCount ?? 8}
                    onChange={event =>
                      updateField(activeField.id, {
                        boxCount: Number(event.target.value),
                      })
                    }
                  />
                </>
              )}
              {activeField.type === "table" && (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="setting-label">{tr("最大列數", "Max rows")}</label>
                      <input
                        className="setting-input"
                        type="number"
                        min="1"
                        max="100"
                        value={activeField.maxRows ?? 3}
                        onChange={event => {
                          const maxRows = Math.min(100, Math.max(1, Number(event.target.value) || 1));
                          updateField(activeField.id, {
                            maxRows,
                            tableWritableCells: activeField.tableWritableCells
                              ? normalizeTableCellPositions(
                                  activeField.tableWritableCells,
                                  maxRows,
                                  tableColumnsOf(activeField)
                                )
                              : undefined,
                            tableFormulaCells: activeField.tableFormulaCells
                              ? normalizeTableFormulaCells(
                                  activeField.tableFormulaCells,
                                  maxRows,
                                  tableColumnsOf(activeField)
                                )
                              : undefined,
                          });
                        }}
                      />
                    </div>
                    <div>
                      <label className="setting-label">{tr("欄數", "Columns")}</label>
                      <input
                        className="setting-input"
                        type="number"
                        min="1"
                        max="30"
                        value={tableColumnsOf(activeField)}
                        onChange={event => {
                          // Cell positions are stored row by row, so changing
                          // the column count has to move the ones already
                          // placed instead of leaving them on the wrong cells.
                          const columns = Math.min(
                            30,
                            Math.max(1, Number(event.target.value) || 1)
                          );
                          const maxRows = Math.min(100, Math.max(1, activeField.maxRows ?? 3));
                          updateField(activeField.id, {
                            tableColumns: columns,
                            tableCellGuides: tableCellGuidesForGrid(
                              activeField.tableCellGuides,
                              maxRows,
                              columns,
                              tableColumnsOf(activeField)
                            ),
                            tableWritableCells: activeField.tableWritableCells
                              ? normalizeTableCellPositions(
                                  activeField.tableWritableCells,
                                  maxRows,
                                  columns
                                )
                              : undefined,
                            tableFormulaCells: activeField.tableFormulaCells
                              ? normalizeTableFormulaCells(
                                  activeField.tableFormulaCells,
                                  maxRows,
                                  columns
                                )
                              : undefined,
                          });
                        }}
                      />
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn-paper mt-2 w-full"
                    disabled={!isDraft}
                    onClick={() => updateField(activeField.id, {
                      tableCellGuides: tableCellGuidesForGrid(undefined, activeField.maxRows ?? 3, tableColumnsOf(activeField)),
                      confirmed: false,
                      status: "needs-review",
                    }, { boundary: true })}
                  >
                    {tr("重新均分格線", "Reset to an even grid")}
                  </button>
                  <p className="mt-1 text-[10px] text-[#84919a]">
                    {tr(
                      "選取此欄位後，畫布上每一格都有綠色虛框，可逐格拖動對準原表格的格線。",
                      "Select this field to drag each cell's dashed green box onto the printed grid."
                    )}
                  </p>
                  <div id="editor-section-calculation">
                    <TableRoleEditor
                      field={activeField}
                      disabled={!isDraft}
                      onUpdate={(patch, boundary) => updateField(activeField.id, patch, { boundary })}
                    />
                  </div>
                </>
              )}
              {activeField.type === "image" && (
                <>
                  <label className="setting-label">{tr("圖片適配", "Image fit")}</label>
                  <select
                    className="setting-select"
                    value={activeField.imageFit ?? "contain"}
                    onChange={event =>
                      updateField(activeField.id, {
                        imageFit: event.target.value as FormField["imageFit"],
                      })
                    }
                  >
                    <option value="contain">{tr("完整顯示", "Fit completely")}</option>
                    <option value="cover">{tr("填滿並裁切", "Fill and crop")}</option>
                    <option value="stretch">{tr("拉伸填滿", "Stretch to fill")}</option>
                  </select>
                  <label className="setting-label">{tr("最大檔案 MB", "Max file MB")}</label>
                  <input
                    className="setting-input"
                    type="number"
                    min="1"
                    max="50"
                    value={activeField.maxFileSizeMb ?? 10}
                    onChange={event =>
                      updateField(activeField.id, {
                        maxFileSizeMb: Number(event.target.value),
                      })
                    }
                  />
                </>
              )}
              {activeField.type === "signature" && (
                <>
                  <label className="setting-label">
                    {tr("允許簽名方式", "Allowed signature modes")}
                  </label>
                  <select
                    className="setting-select"
                    value={activeField.signatureMode ?? "all"}
                    onChange={event =>
                      updateField(activeField.id, {
                        signatureMode: event.target
                          .value as FormField["signatureMode"],
                      })
                    }
                  >
                    <option value="all">{tr("手寫、圖片、文字", "Draw, image, text")}</option>
                    <option value="draw">{tr("只限手寫", "Draw only")}</option>
                    <option value="upload">{tr("只限上載圖片", "Image upload only")}</option>
                    <option value="text">{tr("只限文字簽名", "Text signature only")}</option>
                  </select>
                </>
              )}
              <button
                className="btn-ink mt-5 w-full"
                disabled={!isDraft || !activeField.label.trim()}
                onClick={() =>
                  updateField(activeField.id, {
                    confirmed: true,
                    status: "confirmed",
                  })
                }
              >
                <Check size={14} />
                {tr("確認此欄位", "Confirm this field")}
              </button>
            </div>
          ) : (
            <p className="p-5 text-xs text-slate-500">
              {tr("選取欄位以編輯設定。", "Select a field to edit its settings.")}
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}

function TableRoleEditor({
  field,
  onUpdate,
  disabled,
}: {
  field: FormField;
  onUpdate: (patch: Partial<FormField>, boundary?: boolean) => void;
  disabled?: boolean;
}) {
  const { tr, locale } = useI18n();
  const formulaLang: "zh-TW" | "zh-CN" | "en" =
    locale === "zh-Hans" ? "zh-CN" : locale === "en" ? "en" : "zh-TW";

  const maxRows = Math.max(1, field.maxRows ?? 3);
  const columns = Math.max(1, tableColumnsOf(field));

  // Multi-cell selection: Set of "row:col" keys
  const [selectedCells, setSelectedCells] = useState<Set<string>>(() => new Set(["0:0"]));
  const [isMultiSelectMode, setIsMultiSelectMode] = useState<boolean>(false);

  // Formula inputs for batch or single cell
  const [formulaExpr, setFormulaExpr] = useState<string>("");
  const [decimalPlaces, setDecimalPlaces] = useState<number>(2);

  const roles = resolveTableGridRoles(field, maxRows, columns, true);

  // Parse selected cells list bounded by grid
  const selectedList = useMemo(() => {
    const list: Array<{ row: number; column: number }> = [];
    for (const key of Array.from(selectedCells)) {
      const [rStr, cStr] = key.split(":");
      const r = Number(rStr);
      const c = Number(cStr);
      if (
        Number.isInteger(r) &&
        Number.isInteger(c) &&
        r >= 0 &&
        r < maxRows &&
        c >= 0 &&
        c < columns
      ) {
        list.push({ row: r, column: c });
      }
    }
    return list.sort((a, b) => (a.row !== b.row ? a.row - b.row : a.column - b.column));
  }, [selectedCells, maxRows, columns]);

  const primaryCell = selectedList[0] ?? { row: 0, column: 0 };
  const primaryFormula = roles.formulaMap.get(`${primaryCell.row}:${primaryCell.column}`);

  // When a single cell is selected, sync formula inputs from that cell
  useEffect(() => {
    if (selectedList.length === 1 && primaryFormula) {
      setFormulaExpr(primaryFormula.expression ?? "");
      setDecimalPlaces(primaryFormula.decimalPlaces ?? 2);
    }
  }, [selectedList.length, primaryCell.row, primaryCell.column, primaryFormula]);

  // Count non-fixed cells for canvas handle warning
  let nonFixedCount = 0;
  for (let r = 0; r < maxRows; r += 1) {
    for (let c = 0; c < columns; c += 1) {
      if (roles.getRole(r, c) !== "fixed") {
        nonFixedCount += 1;
      }
    }
  }

  const applyCellRoleChanges = (
    mutator: (cellMap: Map<string, { role: TableCellRole; formula?: TableFormulaCell }>) => void
  ) => {
    const cellMap = new Map<string, { role: TableCellRole; formula?: TableFormulaCell }>();
    for (let r = 0; r < maxRows; r += 1) {
      for (let c = 0; c < columns; c += 1) {
        const k = `${r}:${c}`;
        const rRole = roles.getRole(r, c);
        const rFormula = roles.formulaMap.get(k);
        cellMap.set(k, { role: rRole, formula: rFormula });
      }
    }
    mutator(cellMap);
    const nextWritable: Array<{ row: number; column: number }> = [];
    const nextFormulas: TableFormulaCell[] = [];
    for (let r = 0; r < maxRows; r += 1) {
      for (let c = 0; c < columns; c += 1) {
        const k = `${r}:${c}`;
        const entry = cellMap.get(k);
        if (!entry) continue;
        if (entry.role === "writable") {
          nextWritable.push({ row: r, column: c });
        } else if (entry.role === "formula") {
          nextFormulas.push({
            row: r,
            column: c,
            expression: entry.formula?.expression ?? "",
            ...(entry.formula?.decimalPlaces !== undefined
              ? { decimalPlaces: entry.formula.decimalPlaces }
              : {}),
          });
        }
      }
    }
    onUpdate({
      tableWritableCells: nextWritable,
      tableFormulaCells: nextFormulas,
    });
  };

  const toggleCell = (r: number, c: number, event?: React.MouseEvent) => {
    const key = `${r}:${c}`;
    setSelectedCells(prev => {
      const next = new Set(prev);
      const isMulti = isMultiSelectMode || (event && (event.shiftKey || event.ctrlKey || event.metaKey));
      if (isMulti) {
        if (next.has(key)) next.delete(key);
        else next.add(key);
      } else {
        next.clear();
        next.add(key);
      }
      return next;
    });
  };

  const selectColumn = (col: number, event?: React.MouseEvent) => {
    setSelectedCells(prev => {
      const isMulti = isMultiSelectMode || (event && (event.shiftKey || event.ctrlKey || event.metaKey));
      const next = isMulti ? new Set(prev) : new Set<string>();
      for (let r = 0; r < maxRows; r += 1) {
        next.add(`${r}:${col}`);
      }
      return next;
    });
  };

  const selectRow = (row: number, event?: React.MouseEvent) => {
    setSelectedCells(prev => {
      const isMulti = isMultiSelectMode || (event && (event.shiftKey || event.ctrlKey || event.metaKey));
      const next = isMulti ? new Set(prev) : new Set<string>();
      for (let c = 0; c < columns; c += 1) {
        next.add(`${row}:${c}`);
      }
      return next;
    });
  };

  const selectAll = () => {
    const next = new Set<string>();
    for (let r = 0; r < maxRows; r += 1) {
      for (let c = 0; c < columns; c += 1) {
        next.add(`${r}:${c}`);
      }
    }
    setSelectedCells(next);
  };

  const clearSelection = () => {
    setSelectedCells(new Set());
  };

  const setBatchRole = (newRole: "writable" | "fixed" | "formula") => {
    if (selectedList.length === 0) return;
    applyCellRoleChanges(map => {
      for (const cell of selectedList) {
        if (newRole === "formula") {
          const existing = map.get(`${cell.row}:${cell.column}`)?.formula;
          map.set(`${cell.row}:${cell.column}`, {
            role: "formula",
            formula: {
              row: cell.row,
              column: cell.column,
              expression: existing?.expression ?? formulaExpr.trim(),
              decimalPlaces,
            },
          });
        } else {
          map.set(`${cell.row}:${cell.column}`, { role: newRole });
        }
      }
    });
  };

  const applyFormulaToSelected = () => {
    if (selectedList.length === 0) return;
    const expr = formulaExpr.trim();
    applyCellRoleChanges(map => {
      for (const cell of selectedList) {
        map.set(`${cell.row}:${cell.column}`, {
          role: "formula",
          formula: {
            row: cell.row,
            column: cell.column,
            expression: expr,
            decimalPlaces,
          },
        });
      }
    });
  };

  const formulaValidation = useMemo(() => {
    const expr = formulaExpr.trim();
    if (!expr) {
      return {
        valid: false,
        message: formatFormulaErrorMessage("EMPTY_EXPRESSION", formulaLang),
      };
    }
    const parsed = parseFormula(expr);
    if (parsed.error) {
      const formattedErr = formatFormulaErrorMessage(parsed.error, formulaLang);
      return {
        valid: false,
        message: tr(`語法錯誤：${formattedErr}`, `Syntax error: ${formattedErr}`),
      };
    }
    const refs = getFormulaReferencedColumns(expr);
    for (const colName of refs.columns) {
      const cIdx = columnNameToIndex(colName);
      if (cIdx < 0 || cIdx >= columns) {
        return {
          valid: false,
          message: tr(`引用了不存在的欄位 ${colName}`, `Referenced non-existent column ${colName}`),
        };
      }
      const selfRef = selectedList.find(c => c.column === cIdx);
      if (selfRef) {
        return {
          valid: false,
          message: tr(
            `公式不可引用自身欄位 (${colName})`,
            `Formula cannot reference self column (${colName})`
          ),
        };
      }
    }
    return {
      valid: true,
      message: tr("公式語法正確", "Formula syntax valid"),
    };
  }, [formulaExpr, columns, selectedList, formulaLang, tr]);

  const insertColumnToFormula = (colName: string) => {
    setFormulaExpr(prev => prev + colName);
  };

  const isAllSelected = selectedList.length === maxRows * columns && maxRows * columns > 0;

  return (
    <div className="mt-4 space-y-3 rounded border border-[#d6d0c6] bg-[#faf8f5] p-3">
      <FormulaWizard key={`${field.id}:${maxRows}:${columns}`} field={field} rows={maxRows} columns={columns} initialRow={primaryCell.row} initialColumn={primaryCell.column} disabled={disabled} onApply={patch=>onUpdate(patch,true)} />
      <ColumnTotalWizard key={`total:${field.id}:${maxRows}:${columns}`} field={field} rows={maxRows} columns={columns} disabled={disabled} onApply={patch=>onUpdate(patch,true)} />
      <div className="flex flex-wrap items-center gap-2 border-b border-[#e8e2d8] pb-2">
        <h4 className="font-mono text-xs font-bold text-[#20394e]">
          {tr("表格儲存格角色與公式", "Table Cell Roles & Formulas")}
        </h4>
        <div className="flex flex-wrap items-center gap-2 [&>*]:shrink-0">
          <button
            type="button"
            data-testid="toggle-multi-select-mode"
            aria-pressed={isMultiSelectMode}
            disabled={disabled}
            onClick={() => setIsMultiSelectMode(prev => !prev)}
            className={`rounded border px-2 py-0.5 text-[10px] font-medium transition-colors ${
              isMultiSelectMode
                ? "border-blue-600 bg-blue-600 text-white"
                : "border-[#d6d0c6] bg-white text-[#4a6272] hover:bg-[#ede8e0]"
            }`}
          >
            {isMultiSelectMode
              ? tr("多選模式：開啟", "Multi-Select: ON")
              : tr("多選模式：關閉", "Multi-Select: OFF")}
          </button>
          <span
            data-testid="selection-count-badge"
            className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold text-blue-800"
          >
            {tr(
              `已選取 ${selectedList.length} 個儲存格`,
              `Selected ${selectedList.length} cell${selectedList.length === 1 ? "" : "s"}`
            )}
          </span>
          <button
            type="button"
            data-testid="clear-selection-button"
            disabled={disabled || selectedList.length === 0}
            onClick={clearSelection}
            className="rounded border border-[#d6d0c6] bg-white px-2 py-0.5 text-[10px] text-[#4a6272] hover:bg-[#ede8e0] disabled:opacity-40"
          >
            {tr("清除選取", "Clear Selection")}
          </button>
          <span className="text-[10px] text-[#84919a]">
            {maxRows} × {columns}
          </span>
        </div>
      </div>

      {nonFixedCount > 60 && (
        <div className="rounded border border-amber-300 bg-amber-50 p-2 text-[10px] text-amber-800">
          {tr(
            "大型表格的逐格控制點分組顯示。請使用右側設定的組別切換或指定列／欄，前往後面的儲存格；所有儲存格均可調整及輸出。",
            "Large tables show cell handles in groups. Use the group controls or row/column navigation in Field settings to reach later cells. Every cell can be adjusted and exported."
          )}
        </div>
      )}

      {/* Compact Interactive Grid */}
      <div className="max-h-52 overflow-auto rounded border border-[#d6d0c6] bg-white">
        <table className="w-full border-collapse text-center text-[10px]">
          <thead className="sticky top-0 bg-[#eee9e1]">
            <tr>
              <th className="w-8 border-b border-r border-[#d6d0c6] p-0 font-mono text-[#71808b]">
                <button
                  type="button"
                  data-testid="select-all-button"
                  aria-label={tr("選取全表格", "Select All Cells")}
                  aria-pressed={isAllSelected}
                  onClick={selectAll}
                  className={`w-full py-1 text-[10px] font-bold transition-colors ${
                    isAllSelected
                      ? "bg-[#345064] text-white"
                      : "hover:bg-[#e0dad0] text-[#71808b]"
                  }`}
                >
                  #
                </button>
              </th>
              {Array.from({ length: columns }, (_, c) => {
                const colName = columnIndexToName(c);
                const isColAll = Array.from({ length: maxRows }, (_, r) => `${r}:${c}`).every(k =>
                  selectedCells.has(k)
                );
                return (
                  <th
                    key={c}
                    className="border-b border-r border-[#d6d0c6] p-0 font-mono font-bold text-[#345064]"
                  >
                    <button
                      type="button"
                      data-testid={`select-col-${c}`}
                      aria-label={`${tr("選取第", "Select Column ")}${c + 1}${tr("欄", "")} (${colName})`}
                      aria-pressed={isColAll}
                      onClick={e => selectColumn(c, e)}
                      title={tr(`選取整欄 (${colName})`, `Select Column (${colName})`)}
                      className={`w-full py-1 text-[10px] transition-colors ${
                        isColAll
                          ? "bg-[#345064] text-white"
                          : "hover:bg-[#e0dad0] text-[#345064]"
                      }`}
                    >
                      {colName}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: maxRows }, (_, r) => {
              const isRowAll = Array.from({ length: columns }, (_, c) => `${r}:${c}`).every(k =>
                selectedCells.has(k)
              );
              return (
                <tr key={r}>
                  <td className="border-b border-r border-[#d6d0c6] bg-[#f5f1ea] p-0 font-mono font-bold text-[#71808b]">
                    <button
                      type="button"
                      data-testid={`select-row-${r}`}
                      aria-label={`${tr("選取第", "Select Row ")}${r + 1}${tr("列", "")}`}
                      aria-pressed={isRowAll}
                      onClick={e => selectRow(r, e)}
                      title={tr(`選取整列 (${r + 1})`, `Select Row (${r + 1})`)}
                      className={`w-full py-1 text-[10px] transition-colors ${
                        isRowAll
                          ? "bg-[#345064] text-white"
                          : "hover:bg-[#e0dad0] text-[#71808b]"
                      }`}
                    >
                      {r + 1}
                    </button>
                  </td>
                  {Array.from({ length: columns }, (_, c) => {
                    const role = roles.getRole(r, c);
                    const isSelected = selectedCells.has(`${r}:${c}`);
                    const fCell = roles.formulaMap.get(`${r}:${c}`);
                    const colName = columnIndexToName(c);
                    return (
                      <td
                        key={c}
                        className={`border-b border-r border-[#d6d0c6] p-0 ${
                          isSelected ? "ring-2 ring-[#d9573b] ring-inset" : ""
                        }`}
                      >
                        <button
                          type="button"
                          data-testid={`cell-${r}-${c}`}
                          aria-label={`${tr("第", "Row ")}${r + 1}${tr("列", ", Column ")}${colName}`}
                          aria-pressed={isSelected}
                          onClick={e => toggleCell(r, c, e)}
                          title={
                            role === "formula"
                              ? `=${fCell?.expression || ""}`
                              : role === "fixed"
                                ? tr("不可填寫", "Fixed / Non-writable")
                                : tr("可輸入", "Writable")
                          }
                          className={`w-full py-1 text-[10px] transition-colors ${
                            role === "formula"
                              ? "bg-blue-50 text-blue-700 font-mono font-medium hover:bg-blue-100"
                              : role === "fixed"
                                ? "bg-[#ede9e1] text-[#9aa6ab] hover:bg-[#e2ddd3]"
                                : "bg-white text-emerald-700 hover:bg-emerald-50"
                          }`}
                        >
                          {role === "formula" ? "fx" : role === "fixed" ? "—" : "✓"}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Legend */}
      <div className="flex items-center justify-between text-[10px] text-[#71808b]">
        <div className="flex gap-3">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
            {tr("可輸入", "Writable")}
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full bg-blue-500" />
            {tr("公式", "Formula")}
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full bg-gray-400" />
            {tr("不可填寫", "Fixed")}
          </span>
        </div>
      </div>

      {/* Selected Cells Configuration Panel */}
      <div className="rounded border border-[#e0dad0] bg-white p-2.5">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs font-bold text-[#1b3449]">
            {selectedList.length === 0
              ? tr("請選取儲存格進行設定", "Please select cell(s) to configure")
              : selectedList.length === 1
                ? tr(
                    `選取：第 ${primaryCell.row + 1} 列 ${columnIndexToName(primaryCell.column)} 欄`,
                    `Selected: Row ${primaryCell.row + 1} Col ${columnIndexToName(primaryCell.column)}`
                  )
                : tr(
                    `已選取 ${selectedList.length} 個儲存格（批次操作）`,
                    `Selected ${selectedList.length} cells (Batch action)`
                  )}
          </span>
          <div className="flex flex-wrap gap-1 [&>button]:whitespace-nowrap">
            <button
              type="button"
              data-testid="batch-writable-button"
              disabled={disabled || selectedList.length === 0}
              className="rounded border border-emerald-600 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-40"
              onClick={() => setBatchRole("writable")}
            >
              {tr("可輸入", "Writable")}
            </button>
            <button
              type="button"
              data-testid="batch-formula-button"
              disabled={disabled || selectedList.length === 0}
              className="rounded border border-blue-600 bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-800 hover:bg-blue-100 disabled:opacity-40"
              onClick={() => setBatchRole("formula")}
            >
              {tr("公式", "Formula")}
            </button>
            <button
              type="button"
              data-testid="batch-fixed-button"
              disabled={disabled || selectedList.length === 0}
              className="rounded border border-gray-400 bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-800 hover:bg-gray-200 disabled:opacity-40"
              onClick={() => setBatchRole("fixed")}
            >
              {tr("不可填寫", "Fixed")}
            </button>
          </div>
        </div>

        {/* Formula Details / Batch Formula Panel */}
        <div className="mt-2 space-y-2 rounded border border-blue-100 bg-blue-50/50 p-2 text-xs">
          <div>
            <label className="mb-1 block font-mono text-[10px] text-[#4a6272]">
              {tr(
                "公式表達式（同列欄位運算，可選開頭 =）",
                "Formula Expression (same row columns, optional =)"
              )}
            </label>
            <input
              type="text"
              data-testid="formula-expression-input"
              disabled={disabled || selectedList.length === 0}
              placeholder={tr("例：B+C 或 =B*C", "e.g. B+C or =B*C")}
              className="setting-input !h-8 font-mono text-xs"
              value={formulaExpr}
              onChange={e => {
                const val = e.target.value;
                setFormulaExpr(val);
                if (
                  selectedList.length === 1 &&
                  roles.getRole(primaryCell.row, primaryCell.column) === "formula"
                ) {
                  applyCellRoleChanges(map => {
                    const k = `${primaryCell.row}:${primaryCell.column}`;
                    const existing = map.get(k)?.formula;
                    map.set(k, {
                      role: "formula",
                      formula: {
                        row: primaryCell.row,
                        column: primaryCell.column,
                        expression: val,
                        decimalPlaces: existing?.decimalPlaces ?? decimalPlaces,
                      },
                    });
                  });
                }
              }}
            />
          </div>

          {/* Quick column insert buttons */}
          <div>
            <span className="mb-1 block text-[10px] text-[#71808b]">
              {tr("點擊插入欄位代號：", "Click to insert column:")}
            </span>
            <div className="flex flex-wrap gap-1">
              {Array.from({ length: columns }, (_, c) => {
                const colName = columnIndexToName(c);
                const isSelectedInCol = selectedList.some(cell => cell.column === c);
                return (
                  <button
                    key={c}
                    type="button"
                    disabled={disabled || selectedList.length === 0}
                    className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${
                      isSelectedInCol
                        ? "border-amber-300 bg-amber-50 text-amber-800"
                        : "border-blue-300 bg-white text-blue-700 hover:bg-blue-100"
                    }`}
                    onClick={() => insertColumnToFormula(colName)}
                    title={
                      isSelectedInCol
                        ? tr("同欄注意自我引用", "Warning: Column in selection")
                        : `+ ${colName}`
                    }
                  >
                    +{colName}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Decimal places & Apply button */}
          <div className="flex items-center justify-between pt-1">
            <div className="flex items-center gap-2">
              <label className="text-[10px] text-[#71808b]">
                {tr("小數位數 (0–6)", "Decimal Places (0–6)")}
              </label>
              <select
                data-testid="formula-decimal-places-select"
                disabled={disabled || selectedList.length === 0}
                className="setting-select !h-7 !w-20 text-xs"
                value={decimalPlaces}
                onChange={e => setDecimalPlaces(Number(e.target.value))}
              >
                {[0, 1, 2, 3, 4, 5, 6].map(dp => (
                  <option key={dp} value={dp}>
                    {dp}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              data-testid="apply-batch-formula-button"
              disabled={disabled || selectedList.length === 0 || !formulaExpr.trim()}
              className="rounded bg-blue-600 px-3 py-1 text-xs font-semibold text-white shadow-sm hover:bg-blue-700 disabled:opacity-40"
              onClick={applyFormulaToSelected}
            >
              {tr("套用到已選格", "Apply to Selected Cells")}
            </button>
          </div>

          {/* Formula validation banner */}
          {selectedList.length > 0 && (formulaExpr.trim().length > 0 || selectedList.some(cell => roles.getRole(cell.row, cell.column) === "formula")) && (
            <div
              data-testid="formula-validation-banner"
              className={`text-[10px] font-medium ${
                formulaValidation.valid ? "text-emerald-700" : "text-red-600"
              }`}
            >
              {formulaValidation.valid ? "✓ " : "⚠ "}
              {formulaValidation.message}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
