import { useEffect, useRef, useState } from "react";
import {
  Camera,
  FileImage,
  FileText,
  LoaderCircle,
  RotateCw,
  ScanLine,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { MAX_SUGGESTED_FIELDS_PER_DOCUMENT } from "@/lib/detection-fusion";
import {
  blobToBase64,
  uploadRawAsset,
  sourceToRasterPageBatches,
  type RasterPage,
} from "@/lib/document-files";
import {
  createFreeOcrSession,
  MAX_FREE_OCR_WORDS_PER_PAGE,
  type FreeOcrSession,
} from "@/lib/free-ocr";
import {
  MAX_IMPORT_SOURCE_FILES,
  isImportCancelledError,
  isImportPageTimeoutError,
  throwIfImportCancelled,
  withPageTimeout,
} from "@/lib/import-runtime";
import {
  runSourceImport,
  type ImportPipelineDraftField,
  type ImportReviewContext,
} from "@/lib/import-pipeline";
import { ImportReviewPanel } from "./ImportReviewPanel";
import { initReviewSession } from "@/lib/import-review";
import { getImportReviewMessages } from "@/lib/import-review-messages";
import { useI18n } from "@/lib/i18n";
import { importRunGate, reviewDecision } from "@/lib/import-review-lifecycle";
import { PRACTICE_DESCRIPTION, PRACTICE_PDF } from "@/lib/template-practice";
import {
  detectFormStructures,
  type PositionedWord,
} from "@/lib/form-structure";

const DOCX =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MAX_SYSTEM_OCR_BLOB_BYTES = 12 * 1024 * 1024;
const SYSTEM_OCR_TIMEOUT_MS = 45_000;

export function SourceImportDialog({
  open,
  onClose,
  onCreated,
  practice = false,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (versionId: string) => void;
  practice?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { locale, tr } = useI18n();
  const [practiceSource, setPracticeSource] = useState(false);
  const [loadingExample, setLoadingExample] = useState(false);
  const [exampleError, setExampleError] = useState(false);
  const reviewMessages = getImportReviewMessages(locale);
  const runGate = useRef(importRunGate());
  const mountedRef = useRef(true);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [name, setName] = useState("");
  const [rotation, setRotation] = useState(0);
  const [contrast, setContrast] = useState(1.12);
  const [grayscale, setGrayscale] = useState(false);
  const [autoCrop, setAutoCrop] = useState(true);
  const [runOcr, setRunOcr] = useState(true);
  const [language, setLanguage] = useState<
    "auto" | "eng" | "chi_tra" | "chi_sim"
  >("auto");
  const [threshold, setThreshold] = useState(65);
  const [progress, setProgress] = useState("");
  const localizeImportProgress = (message: string): string => {
    const fixed: Record<string, string> = {
      "建立本機 Draft…": "Creating a local draft…",
      "保存不可破壞的原始來源…": "Saving the original source…",
      "轉換並預處理頁面…": "Converting and preparing pages…",
      "等待覆核建議…": "Waiting for field review…",
    };
    if (fixed[message]) return tr(message, fixed[message]);
    const page = message.match(/^(保存|免費自動識別：)(已處理 (\d+) 頁|第 (\d+)\/(\d+) 頁)…$/);
    if (!page) return message;
    const pageText = page[3]
      ? tr(`已處理 ${page[3]} 頁`, `page ${page[3]}`)
      : tr(`第 ${page[4]}/${page[5]} 頁`, `page ${page[4]} of ${page[5]}`);
    return page[1] === "保存"
      ? tr(`保存${page[2]}…`, `Saving ${pageText}…`)
      : tr(`免費自動識別：${page[2]}…`, `Free recognition: ${pageText}…`);
  };
  const [reviewContext, setReviewContext] = useState<ImportReviewContext | null>(null);
  const [unverifiedCleanupError, setUnverifiedCleanupError] = useState<string | null>(null);
  const reviewResolverRef = useRef<
    ((value: ImportPipelineDraftField[] | "cancelled") => void) | null
  >(null);
  const importControllerRef = useRef<AbortController | null>(null);
  const systemOcrDisabledForRunRef = useRef(false);
  const utils = trpc.useUtils();
  const createDraft = trpc.formdigital.templates.createDraft.useMutation();
  const savePages = trpc.formdigital.templates.savePages.useMutation();
  const saveFields = trpc.formdigital.templates.saveDraftFields.useMutation();
  const deleteTemplate = trpc.formdigital.templates.delete.useMutation();
  const deleteAsset = trpc.formdigital.assets.delete.useMutation();
  const ocrCapabilities = trpc.formdigital.ocr.capabilities.useQuery(
    undefined,
    { enabled: open }
  );
  const recognize = trpc.formdigital.ocr.recognize.useMutation();
  const systemOcrAvailable = ocrCapabilities.data?.available === true;

  useEffect(() => {
    if (!open || !practice) return;
    const controller = new AbortController();
    setLoadingExample(true); setExampleError(false); setPracticeSource(false);
    void fetch(PRACTICE_PDF, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('example unavailable');
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      setFiles([new File([blob], 'Formdigital-template-practice-v1.pdf', {type:'application/pdf'})]);
      setName(tr('範本建立實習', 'Template building practice'));
      setPracticeSource(true); setAutoCrop(false); setContrast(1); setRotation(0);
      setGrayscale(false); setRunOcr(false);
    }).catch(() => { if (!controller.signal.aborted) setExampleError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoadingExample(false); });
    return () => controller.abort();
  }, [open, practice]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      importControllerRef.current?.abort();
      if (reviewResolverRef.current) {
        reviewResolverRef.current("cancelled");
        reviewResolverRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!open) {
      importControllerRef.current?.abort();
      if (reviewResolverRef.current) {
        reviewResolverRef.current("cancelled");
        reviewResolverRef.current = null;
      }
    }
  }, [open]);

  if (!open) return null;

  const cancelImport = () => importControllerRef.current?.abort();

  const handleReviewConfirm = (fields: ImportPipelineDraftField[]) => {
    const resolver = reviewResolverRef.current;
    reviewResolverRef.current = null;
    setReviewContext(null);
    resolver?.(fields);
  };

  const handleReviewCancel = () => {
    const resolver = reviewResolverRef.current;
    reviewResolverRef.current = null;
    setReviewContext(null);
    importControllerRef.current?.abort();
    resolver?.("cancelled");
  };

  /**
   * System Tesseract first, then the offline browser engine shipped with the
   * site. Both paths return the same positioned words, so the import pipeline
   * does not need to know which engine answered.
   */
  const recognizePageWords = async (
    page: RasterPage,
    pageIndex: number,
    label: string,
    signal: AbortSignal,
    browserOcrSession: FreeOcrSession
  ): Promise<{ words: PositionedWord[]; truncated: boolean }> => {
    const browserOcr = async () => {
      const result = await browserOcrSession.recognize(
        new File([page.blob], `page-${pageIndex + 1}.png`, {
          type: "image/png",
        }),
        {
          signal,
          onProgress: value =>
            setProgress(`${tr("內置免費 OCR：", "Built-in free OCR: ")}${label} · ${Math.round(value * 100)}%`),
        }
      );
      return {
        words: result.suggestions.map(suggestion => ({
          text: suggestion.text,
          confidence: suggestion.confidence,
          left: suggestion.bbox.x0,
          top: suggestion.bbox.y0,
          width: Math.max(1, suggestion.bbox.x1 - suggestion.bbox.x0),
          height: Math.max(1, suggestion.bbox.y1 - suggestion.bbox.y0),
        })),
        truncated: result.truncated,
      };
    };
    if (!systemOcrAvailable || systemOcrDisabledForRunRef.current)
      return browserOcr();
    if (page.blob.size > MAX_SYSTEM_OCR_BLOB_BYTES) {
      toast.info(
        tr("頁面影像超過系統 OCR 的安全傳輸上限，正在改用內置免費瀏覽器 OCR。", "This page image exceeds the system OCR transfer limit. Switching to built-in browser OCR.")
      );
      return browserOcr();
    }
    try {
        const result = await withPageTimeout(
          async pageSignal =>
            recognize.mutateAsync({
              base64: await blobToBase64(page.blob, pageSignal),
              mimeType: "image/png",
              language,
              width: page.pixelWidth,
              height: page.pixelHeight,
            }),
          SYSTEM_OCR_TIMEOUT_MS,
          signal
        );
        throwIfImportCancelled(signal);
        return {
          words: result.words.slice(0, MAX_FREE_OCR_WORDS_PER_PAGE),
          truncated: result.words.length > MAX_FREE_OCR_WORDS_PER_PAGE,
        };
    } catch (error) {
      if (isImportCancelledError(error)) throw error;
      // A tRPC mutation cannot currently abort the server-side OCR process.
      // Starting browser OCR immediately after its deadline would run the same
      // page twice, so a timed-out system page is marked unavailable instead.
      if (isImportPageTimeoutError(error)) {
        // The tRPC request cannot terminate an already-running host process.
        // Disable host OCR for the rest of this import so later pages cannot
        // accumulate more timed-out Tesseract processes behind it.
        systemOcrDisabledForRunRef.current = true;
        throw error;
      }
      toast.info(tr("系統 Tesseract 未提供，正在改用內置免費瀏覽器 OCR。", "System Tesseract is unavailable. Switching to built-in browser OCR."));
      return browserOcr();
    }
  };

  const selectFiles = (selected: FileList | null) => {
    const next = Array.from(selected ?? []);
    if (!next.length) return;
    const supported = next.every(
      file =>
        ["application/pdf", "image/png", "image/jpeg", DOCX].includes(
          file.type
        ) ||
        file.name.toLowerCase().endsWith(".pdf") ||
        file.name.toLowerCase().endsWith(".docx")
    );
    if (!supported) return toast.error(tr("只支援 PDF、JPG、PNG 或 DOCX。", "Only PDF, JPG, PNG and DOCX files are supported."));
    if (next.length > 1 && next.some(file => !file.type.startsWith("image/")))
      return toast.error(
        tr("多檔匯入只支援 JPG／PNG；PDF 或 DOCX 請逐份建立 Template。", "Multiple files can be imported together only for JPG or PNG. Create one template per PDF or DOCX file.")
      );
    if (next.length > MAX_IMPORT_SOURCE_FILES)
      return toast.error(
        `${tr("單次匯入最多", "You can import up to")} ${MAX_IMPORT_SOURCE_FILES} ${tr("個來源檔案；請分批建立 Template。", "source files at once. Create templates in batches.")}`
      );
    setFiles(next);
    setPracticeSource(false);
    const selectedPdf =
      next.length === 1 &&
      (next[0]!.type === "application/pdf" ||
        next[0]!.name.toLowerCase().endsWith(".pdf"));
    // Native PDF text and AcroForm geometry are more accurate than a cropped
    // raster. Keep the visible setting aligned with the safe default; scanned
    // images continue to use automatic edge detection.
    setAutoCrop(!selectedPdf);
    if (!name) setName(next[0]!.name.replace(/\.[^.]+$/, ""));
  };

  const create = async () => {
    if (!files.length || !name.trim())
      return toast.error(tr("請選擇來源並輸入 Template 名稱。", "Choose a source file and enter a template name."));
    const importController = runGate.current.start();
    if (!importController) return;
    importControllerRef.current = importController;
    systemOcrDisabledForRunRef.current = false;
    setUnverifiedCleanupError(null);
    const browserOcrSession = createFreeOcrSession(language);
    const templateName = name.trim();
    try {
      const result = await runSourceImport(
        {
          files,
          name: templateName,
          runDetection: runOcr,
          preprocessing: { rotation, contrast, grayscale, autoCrop },
          signal: importController.signal,
        },
        {
          createDraft: async draftName => {
            const draft = await createDraft.mutateAsync({
              name: draftName,
              ...(practiceSource ? { description: PRACTICE_DESCRIPTION } : {}),
              pageManifest: [
                { page: 1, widthMm: 210, heightMm: 297, rotation: 0 },
              ],
              fields: [],
              printSettings: {
                paper: "A4",
                orientation: "portrait",
                xOffsetMm: 0,
                yOffsetMm: 0,
                xScale: 100,
                yScale: 100,
              },
            });
            return {
              templateId: draft.templateId,
              versionId: draft.versionId,
            };
          },
          uploadAsset: (upload, signal) => uploadRawAsset(upload, signal),
          // Browser OCR is shipped locally and remains available when host OCR is absent.
          ocrAvailable: true,
          pageBatches: options => sourceToRasterPageBatches(files, options),
          detectStructures: async (blob, signal) => {
            const structures = await withPageTimeout(
              () => detectFormStructures(blob),
              30_000,
              signal
            );
            throwIfImportCancelled(signal);
            return {
              structures,
              // The pixel detector intentionally keeps at most 160 structures.
              truncated: structures.length >= 160,
            };
          },
          recognizeWords: (page, index, label, signal) =>
            recognizePageWords(page, index, label, signal, browserOcrSession),
          savePages: input => savePages.mutateAsync(input),
          saveFields: input => saveFields.mutateAsync(input),
          rollbackDeps: {
            deleteTemplate: templateId =>
              deleteTemplate.mutateAsync({ templateId }),
            deleteAsset: assetId => deleteAsset.mutateAsync({ assetId }),
            listTemplateIds: async () =>
              (await utils.formdigital.templates.list.fetch()).map(
                template => template.id
              ),
            listAssetIds: async () =>
              (await utils.formdigital.assets.list.fetch()).map(
                asset => asset.id
              ),
          },
          onProgress: message => setProgress(localizeImportProgress(message)),
          onOcrUnavailable: pageNumber =>
            toast.warning(
              `${tr("第", "Free OCR is unavailable for page")} ${pageNumber}${tr(" 頁免費 OCR 暫時不可用；頁面已保留，可先手動建立欄位。", ". The page was kept; you can add fields manually.")}`
            ),
          onReview: async (ctx: ImportReviewContext) => {
            // Validate before rendering: a malformed candidate cannot crash React or vanish silently.
            try { initReviewSession(ctx); } catch (error) {
              if (mountedRef.current) toast.error(reviewMessages.invalidGeometry);
              throw error;
            }
            const decision = reviewDecision<ImportPipelineDraftField[]>(ctx.signal);
            reviewResolverRef.current = decision.settle;
            if (mountedRef.current && !ctx.signal.aborted) setReviewContext(ctx);
            try { return await decision.promise; }
            finally {
              if (reviewResolverRef.current === decision.settle) reviewResolverRef.current = null;
              if (mountedRef.current) setReviewContext(null);
            }
          },
        },
        { ocrThreshold: threshold }
      );

      if (!mountedRef.current) return;
      if (result.status === "created") {
        toast.success(
          `${tr("Template Draft 已建立：", "Template draft created: ")}${result.pages} ${tr("頁，", "pages, ")}${result.suggestions} ${tr("個未確認自動識別候選。", "unreviewed field suggestions.")}`
        );
        if (result.truncation === "document")
          toast.warning(
            `${tr("自動識別候選已達每份文件", "Automatic field suggestions reached the limit of")} ${MAX_SUGGESTED_FIELDS_PER_DOCUMENT} ${tr("個安全上限；其餘頁面的欄位請在 Editor 內人工新增。", "per document. Add remaining fields manually in the editor.")}`
          );
        else if (result.truncation === "page")
          toast.warning(
            tr("部分自動識別候選已達每頁安全上限；其餘欄位請在 Editor 內人工新增。", "Some pages reached the suggestion limit. Add remaining fields manually in the editor.")
          );
        setFiles([]);
        setName("");
        setProgress("");
        onClose();
        onCreated(result.versionId);
        return;
      }

      if (!result.rollback.verified) {
        setUnverifiedCleanupError(
          tr("清理未確認：本次匯入未能確認完全清理；請在 Template Library 檢查並移除未完成的 Draft，再重試。", "Cleanup could not be verified. Check the template library, remove any incomplete draft, then retry.")
        );
        toast.error(
          tr("本次匯入未能確認完全清理；請在 Template Library 檢查並移除未完成的 Draft，再重試。", "Cleanup could not be verified. Check the template library, remove any incomplete draft, then retry.")
        );
        return;
      }
      if (result.status === "service-outdated") {
        toast.error(
          tr("本機資料服務版本較舊，無法保存頁面圖片格式。請關閉並重新執行 start-formdigital-dev.cmd，再重新匯入。", "The local data service is too old to save page images. Restart it and import the template again."),
          { duration: 15_000 }
        );
        return;
      }
      toast[result.status === "cancelled" ? "info" : "error"](
        result.status === "cancelled"
          ? tr("Template 建立已取消；已建立的暫存資料已清理。", "Template creation was cancelled and temporary data was removed.")
          : tr("Template 建立失敗，請檢查來源檔案後再試。", "Template creation failed. Check the source file and try again.")
      );
    } finally {
      try { await browserOcrSession.terminate(); } finally { runGate.current.finish(importController); }
      if (reviewResolverRef.current) {
        reviewResolverRef.current("cancelled");
        reviewResolverRef.current = null;
      }
      if (mountedRef.current) setReviewContext(null);
      if (importControllerRef.current === importController)
        importControllerRef.current = null;
      if (mountedRef.current) setProgress("");
    }
  };
  const isReviewing = Boolean(reviewContext);
  const pending = Boolean(progress) || isReviewing || loadingExample;

  if (reviewContext) {
    return (
      <div
        className="fixed inset-0 z-50 grid place-items-center bg-[#102a43]/60 p-4"
        role="dialog"
        aria-modal="true"
        aria-label={reviewMessages.reviewTitle}
      >
        <section className="max-h-[95vh] w-full max-w-5xl overflow-hidden border border-[#d9d4ca] bg-[#fffdfa] shadow-2xl rounded-lg flex flex-col">
          <ImportReviewPanel
            context={reviewContext}
            onConfirm={handleReviewConfirm}
            onCancel={handleReviewCancel}
            locale={locale}
          />
        </section>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-[#102a43]/60 p-3"
      role="dialog"
      aria-modal="true"
      aria-labelledby="source-title"
    >
      <section className="max-h-[94vh] w-full max-w-3xl overflow-auto border border-[#d9d4ca] bg-[#fffdfa] shadow-2xl">
        {practice && <div className="border-b bg-amber-50 p-4 text-sm text-slate-800" role="status">
          {loadingExample ? tr('正在載入八頁示範原表…', 'Loading the eight-page example…') : exampleError ? tr('示範原表未能載入。請關閉後重試。','The example could not load. Close and try again.') : tr('實習會建立一份獨立草稿。先按「建立 Draft」，覆核八頁後選「只匯入頁面」，接著在編輯器親手建立欄位。若想比較自動辨識，可勾選建立候選；所有建議仍需人工覆核。','This creates a separate practice draft. Choose Create Draft, review the eight pages, then import pages only. You will build fields in the editor. Optionally enable detection to compare suggestions; review them before accepting.')}
        </div>}
        <header className="flex items-center justify-between border-b p-5">
          <div>
            <div className="eyebrow">NEW TEMPLATE</div>
            <h2
              id="source-title"
              className="mt-1 text-xl font-bold text-[#17364d]"
            >
              {tr("選擇原始來源", "Choose source files")}
            </h2>
          </div>
          <button
            className="icon-button"
            onClick={onClose}
            disabled={pending}
            aria-label={tr("關閉", "Close")}
          >
            <X size={16} />
          </button>
        </header>
        {unverifiedCleanupError && (
          <div
            className="m-4 p-3 bg-red-100 border border-red-300 text-red-800 text-xs font-semibold rounded flex items-start gap-2"
            role="alert"
            data-testid="unverified-cleanup-alert"
          >
            <span className="font-bold shrink-0">{tr("⚠️ 清理未確認：", "⚠️ Cleanup not verified:")}</span>
            <span>{unverifiedCleanupError}</span>
          </div>
        )}
        <div className="grid gap-6 p-5 md:grid-cols-[1fr_280px]">
          <div>
            <div className="grid gap-3 sm:grid-cols-3">
              <button
                className="border border-[#d9d4ca] p-5 text-left hover:border-[#d9573b]"
                onClick={() => inputRef.current?.click()}
              >
                <FileText className="mb-4 text-[#a23f2b]" />
                <b className="block text-sm">PDF／DOCX</b>
                <span className="mt-1 block text-xs text-slate-500">
                  {tr("單頁或多頁", "One or more pages")}
                </span>
              </button>
              <button
                className="border border-[#d9d4ca] p-5 text-left hover:border-[#d9573b]"
                onClick={() => inputRef.current?.click()}
              >
                <FileImage className="mb-4 text-[#a23f2b]" />
                <b className="block text-sm">JPG／PNG</b>
                <span className="mt-1 block text-xs text-slate-500">
                  {tr("可一次選多張", "Select multiple images")}
                </span>
              </button>
              <button
                className="border border-[#d9d4ca] p-5 text-left hover:border-[#d9573b]"
                onClick={() => cameraRef.current?.click()}
              >
                <Camera className="mb-4 text-[#a23f2b]" />
                <b className="block text-sm">{tr("手機相機", "Phone camera")}</b>
                <span className="mt-1 block text-xs text-slate-500">
                  {tr("可連續加入頁面", "Add pages one at a time")}
                </span>
              </button>
            </div>
            <input
              ref={inputRef}
              className="hidden"
              type="file"
              multiple
              accept=".pdf,.jpg,.jpeg,.png,.docx,application/pdf,image/jpeg,image/png,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              onChange={event => selectFiles(event.target.files)}
            />
            <input
              ref={cameraRef}
              className="hidden"
              type="file"
              multiple
              accept="image/*"
              capture="environment"
              onChange={event => selectFiles(event.target.files)}
            />
            <label className="setting-label mt-6" htmlFor="template-name">
              {tr("TEMPLATE 名稱", "Template name")}
            </label>
            <input
              id="template-name"
              className="setting-input"
              value={name}
              onChange={event => setName(event.target.value)}
            />
            <div className="mt-4 border bg-[#f7f4ee] p-3 text-xs text-slate-600">
              {files.length
                ? files.map((file, index) => (
                    <div
                      key={`${file.name}-${index}`}
                      className="flex justify-between border-b py-2 last:border-0"
                    >
                      <span>
                        {index + 1}. {file.name}
                      </span>
                      <span>{(file.size / 1024 / 1024).toFixed(1)} MB</span>
                    </div>
                  ))
                : tr("尚未選擇來源", "No source selected")}
            </div>
            {files.some(
              file =>
                file.name.toLowerCase().endsWith(".docx") ||
                file.type === DOCX
            ) && (
              <div
                className="mt-3 p-2.5 rounded bg-[#fff8e6] border border-[#f0b429] text-xs text-[#744210]"
                data-testid="dialog-docx-notice"
              >
                <b>DOCX: </b>{reviewMessages.docxNotice}
              </div>
            )}
          </div>
          <aside className="border border-[#d9d4ca] p-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <ScanLine size={15} />
              {tr("頁面預處理", "Page preprocessing")}
            </h3>
            <label className="setting-label">{tr("細微校正傾斜（度）", "Rotation correction (degrees)")}</label>
            <input
              className="setting-input"
              type="number"
              min="-5"
              max="365"
              step="0.1"
              value={rotation}
              onChange={event => setRotation(Number(event.target.value))}
            />
            <label className="setting-label">{tr("對比", "Contrast")}</label>
            <input
              className="w-full"
              type="range"
              min="0.8"
              max="1.8"
              step="0.05"
              value={contrast}
              onChange={event => setContrast(Number(event.target.value))}
            />
            <label className="mt-4 flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={autoCrop}
                onChange={event => setAutoCrop(event.target.checked)}
              />
              {tr("自動裁邊", "Automatically crop edges")}
            </label>
            <label className="mt-3 flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={grayscale}
                onChange={event => setGrayscale(event.target.checked)}
              />
              {tr("去陰影／灰階增強", "Reduce shadows / enhance grayscale")}
            </label>
            <h3 className="mt-6 flex items-center gap-2 text-sm font-semibold">
              <ScanLine size={15} />
              {tr("免費本機 OCR", "Free local OCR")}
            </h3>
            <label className="mt-3 flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={runOcr}
                onChange={event => setRunOcr(event.target.checked)}
              />
              {tr("建立未確認欄位候選", "Create unreviewed field suggestions")}
            </label>
            <select
              className="setting-select mt-3"
              value={language}
              onChange={event =>
                setLanguage(event.target.value as typeof language)
              }
            >
              <option value="auto">{tr("自動混合：繁中＋簡中＋English", "Automatic: Traditional and Simplified Chinese + English")}</option>
              <option value="chi_tra">{tr("繁體中文", "Traditional Chinese")}</option>
              <option value="chi_sim">{tr("簡體中文", "Simplified Chinese")}</option>
              <option value="eng">English</option>
            </select>
            <label className="setting-label">{tr("信心門檻", "Confidence threshold")} {threshold}%</label>
            <input
              className="w-full"
              type="range"
              min="30"
              max="95"
              value={threshold}
              onChange={event => setThreshold(Number(event.target.value))}
            />
          </aside>
        </div>
        <footer className="flex items-center justify-between border-t p-5">
          <span className="flex items-center gap-2 text-xs text-slate-500">
            {pending && <LoaderCircle size={14} className="animate-spin" />}
            {progress || tr("原始檔與處理後頁面會分開保存。", "Original files and processed pages are saved separately.")}
          </span>
          <div className="flex items-center gap-3">
            {pending && (
              <button
                className="btn-paper"
                type="button"
                onClick={cancelImport}
              >
                {tr("取消匯入", "Cancel import")}
              </button>
            )}
            <button
              className="btn-ink"
              onClick={create}
              disabled={pending || !files.length || !name.trim()}
            >
              {pending ? tr("處理中", "Processing") : tr("建立 Draft", "Create draft")}
              <RotateCw size={14} />
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
