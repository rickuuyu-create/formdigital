import { renderAsync } from "docx-preview";
import { toBlob as elementToPngBlob } from "html-to-image";
import * as pdfjs from "pdfjs-dist";
import {
  createNativePdfExtractionBudget,
  extractNativePdfPageSnapshot,
  type NativePdfPageSnapshot,
} from "./native-pdf";
import {
  extractPdfRuleSegments,
  type PdfRuleSegment,
} from "./native-pdf-rules";
import {
  DEFAULT_PAGE_TIMEOUT_MS,
  boundedRasterViewport,
  normalizeBatchSize,
  throwIfImportCancelled,
  withPageTimeout,
} from "./import-runtime";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

export type RasterPage = {
  blob: Blob;
  page: number;
  widthMm: number;
  heightMm: number;
  rotation: number;
  pixelWidth: number;
  pixelHeight: number;
  nativePdf?: NativePdfPageSnapshot;
  /** Exact rules read from a vector PDF page, in canvas pixels. */
  vectorRules?: PdfRuleSegment[];
  /** A detector hit one of its bounded source-reading limits on this page. */
  sourceDetectionTruncated?: boolean;
  /** What was really applied to the stored raster, not merely requested. */
  appliedPreprocessing?: AppliedRasterPreprocessing;
};

export type RasterPreprocessing = {
  rotation?: number;
  contrast?: number;
  grayscale?: boolean;
  autoCrop?: boolean;
};

export type AppliedRasterPreprocessing = {
  rotation: number;
  contrast: number;
  grayscale: boolean;
  autoCropRequested: boolean;
  autoCropApplied: boolean;
};

export async function blobToBase64(blob: Blob, signal?: AbortSignal) {
  throwIfImportCancelled(signal);
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    const abort = () => {
      reader.abort();
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    reader.onload = () => {
      signal?.removeEventListener("abort", abort);
      try {
        throwIfImportCancelled(signal);
        resolve(String(reader.result).split(",")[1] || "");
      } catch (error) {
        reject(error);
      }
    };
    reader.onerror = () => reject(new Error("無法讀取檔案。"));
    reader.onabort = () => {
      signal?.removeEventListener("abort", abort);
    };
    reader.readAsDataURL(blob);
  });
}

export type RawCsvUploadResult = {
  assetId: string;
  originalFilename: string;
  mimeType: string;
  size: number;
  deduplicated: boolean;
};

export function uploadRawCsv(
  file: File,
  context: { templateId?: string; versionId?: string } = {}
) {
  return new Promise<RawCsvUploadResult>((resolve, reject) => {
    const query = new URLSearchParams({ filename: file.name });
    if (context.templateId) query.set("templateId", context.templateId);
    if (context.versionId) query.set("versionId", context.versionId);
    const request = new XMLHttpRequest();
    request.open("POST", `/api/local/csv-assets?${query.toString()}`);
    request.setRequestHeader("content-type", "application/octet-stream");
    request.setRequestHeader("x-formdigital-csv-upload", "1");
    request.withCredentials = true;
    request.onload = () => {
      try {
        const result = JSON.parse(request.responseText || "{}");
        if (request.status >= 200 && request.status < 300 && result.assetId)
          resolve(result);
        else reject(new Error("CSV 上傳失敗。"));
      } catch {
        reject(new Error("CSV 上傳失敗。"));
      }
    };
    request.onerror = () => reject(new Error("CSV 上傳失敗。"));
    request.send(file);
  });
}

export type RawAssetUpload = {
  blob: Blob;
  filename: string;
  kind: "source" | "page" | "signature" | "image" | "export";
  mimeType: string;
  purpose?: string;
  templateId?: string;
  versionId?: string;
  originalAssetIds?: string[];
  preprocessing?: Record<string, unknown>;
};

/**
 * Stream one asset to the same-origin server as raw bytes. The browser never
 * builds a base64 copy, so a large source file or page bitmap is bounded by
 * the blob itself rather than by a 21 MB JSON envelope.
 */
export async function uploadRawAsset(
  upload: RawAssetUpload,
  signal?: AbortSignal
): Promise<RawCsvUploadResult> {
  throwIfImportCancelled(signal);
  const query = new URLSearchParams({
    filename: upload.filename,
    kind: upload.kind,
    mimeType: upload.mimeType,
  });
  if (upload.purpose) query.set("purpose", upload.purpose);
  if (upload.templateId) query.set("templateId", upload.templateId);
  if (upload.versionId) query.set("versionId", upload.versionId);
  if (upload.originalAssetIds?.length)
    query.set("originalAssetIds", upload.originalAssetIds.join(","));
  if (upload.preprocessing)
    query.set("preprocessing", JSON.stringify(upload.preprocessing));
  const response = await fetch(`/api/local/raw-assets?${query.toString()}`, {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/octet-stream",
      "x-formdigital-raw-upload": "1",
    },
    body: upload.blob,
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error("本機資產上傳失敗。");
  const result = (await response.json()) as Partial<RawCsvUploadResult>;
  if (!result.assetId) throw new Error("本機資產上傳失敗。");
  throwIfImportCancelled(signal);
  return result as RawCsvUploadResult;
}

function canvasBlob(
  canvas: HTMLCanvasElement,
  type = "image/png",
  quality = 0.94
) {
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      blob => (blob ? resolve(blob) : reject(new Error("無法建立頁面影像。"))),
      type,
      quality
    )
  );
}

function normalizedPreprocessing(
  options: RasterPreprocessing
): Omit<AppliedRasterPreprocessing, "autoCropApplied"> {
  const requestedRotation = Number(options.rotation ?? 0);
  const rotation = Number.isFinite(requestedRotation)
    ? ((requestedRotation % 360) + 360) % 360
    : 0;
  const requestedContrast = Number(options.contrast ?? 1);
  return {
    rotation,
    contrast: Number.isFinite(requestedContrast)
      ? Math.max(0.1, Math.min(4, requestedContrast))
      : 1,
    grayscale: options.grayscale === true,
    autoCropRequested: options.autoCrop === true,
  };
}

async function cropCanvas(
  canvas: HTMLCanvasElement,
  signal?: AbortSignal
): Promise<HTMLCanvasElement | null> {
  const context = canvas.getContext("2d", {
    alpha: false,
    willReadFrequently: true,
  });
  if (!context) return null;
  let minX = canvas.width;
  let minY = canvas.height;
  let maxX = -1;
  let maxY = -1;
  const stride = Math.max(
    1,
    Math.floor(Math.min(canvas.width, canvas.height) / 1_200)
  );
  const bandHeight = Math.max(
    stride,
    Math.min(
      canvas.height,
      Math.max(1, Math.floor(1_048_576 / Math.max(1, canvas.width)))
    )
  );
  for (let bandTop = 0; bandTop < canvas.height; bandTop += bandHeight) {
    throwIfImportCancelled(signal);
    const rows = Math.min(bandHeight, canvas.height - bandTop);
    const band = context.getImageData(0, bandTop, canvas.width, rows).data;
    const firstY = bandTop % stride === 0 ? 0 : stride - (bandTop % stride);
    for (let y = firstY; y < rows; y += stride) {
      for (let x = 0; x < canvas.width; x += stride) {
        const offset = (y * canvas.width + x) * 4;
        if ((band[offset]! + band[offset + 1]! + band[offset + 2]!) / 3 < 246) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, bandTop + y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, bandTop + y);
        }
      }
    }
    // Yield to the browser between bounded bands so a Cancel click can be
    // delivered while auto-crop scans a large page.
    if (bandTop + bandHeight < canvas.height)
      await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  if (maxX < minX || maxY < minY) return null;
  const margin = Math.round(Math.min(canvas.width, canvas.height) * 0.01);
  minX = Math.max(0, minX - margin);
  minY = Math.max(0, minY - margin);
  maxX = Math.min(canvas.width - 1, maxX + margin);
  maxY = Math.min(canvas.height - 1, maxY + margin);
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  if (width >= canvas.width && height >= canvas.height) return null;
  const cropped = document.createElement("canvas");
  cropped.width = width;
  cropped.height = height;
  const croppedContext = cropped.getContext("2d", { alpha: false });
  if (!croppedContext) return null;
  croppedContext.fillStyle = "white";
  croppedContext.fillRect(0, 0, width, height);
  croppedContext.drawImage(
    canvas,
    minX,
    minY,
    width,
    height,
    0,
    0,
    width,
    height
  );
  return cropped;
}

/** Apply the same bounded raster preprocessing to PDF, DOCX and image pages. */
async function preprocessCanvas(
  source: HTMLCanvasElement,
  options: RasterPreprocessing,
  signal?: AbortSignal
) {
  throwIfImportCancelled(signal);
  const normalized = normalizedPreprocessing(options);
  const radians = (normalized.rotation * Math.PI) / 180;
  const rotatedWidth =
    Math.abs(source.width * Math.cos(radians)) +
    Math.abs(source.height * Math.sin(radians));
  const rotatedHeight =
    Math.abs(source.width * Math.sin(radians)) +
    Math.abs(source.height * Math.cos(radians));
  const bounded = boundedRasterViewport(rotatedWidth, rotatedHeight, 1);
  const output = document.createElement("canvas");
  output.width = bounded.width;
  output.height = bounded.height;
  const context = output.getContext("2d", {
    alpha: false,
    willReadFrequently: normalized.autoCropRequested,
  });
  if (!context) throw new Error("瀏覽器無法建立頁面預處理畫布。");
  context.fillStyle = "white";
  context.fillRect(0, 0, output.width, output.height);
  context.translate(output.width / 2, output.height / 2);
  context.rotate(radians);
  context.scale(bounded.scale, bounded.scale);
  context.filter = `${normalized.grayscale ? "grayscale(1) " : ""}contrast(${normalized.contrast})`;
  context.drawImage(source, -source.width / 2, -source.height / 2);
  context.setTransform(1, 0, 0, 1, 0, 0);
  const cropped = normalized.autoCropRequested
    ? await cropCanvas(output, signal)
    : null;
  return {
    canvas: cropped ?? output,
    uncroppedPixelWidth: output.width,
    uncroppedPixelHeight: output.height,
    applied: {
      ...normalized,
      autoCropApplied: cropped !== null,
    } satisfies AppliedRasterPreprocessing,
  };
}

function processedPhysicalSize(
  sourceWidthMm: number,
  sourceHeightMm: number,
  processed: Awaited<ReturnType<typeof preprocessCanvas>>
) {
  const radians = (processed.applied.rotation * Math.PI) / 180;
  const rotatedWidthMm =
    Math.abs(sourceWidthMm * Math.cos(radians)) +
    Math.abs(sourceHeightMm * Math.sin(radians));
  const rotatedHeightMm =
    Math.abs(sourceWidthMm * Math.sin(radians)) +
    Math.abs(sourceHeightMm * Math.cos(radians));
  const candidateWidth =
    rotatedWidthMm *
    (processed.canvas.width / Math.max(1, processed.uncroppedPixelWidth));
  const candidateHeight =
    rotatedHeightMm *
    (processed.canvas.height / Math.max(1, processed.uncroppedPixelHeight));
  // Pixel rounding can introduce a small physical-aspect mismatch. Preserve
  // the mapped physical area while making the final millimetres describe the
  // exact stored bitmap geometry.
  const area = Math.max(0.01, candidateWidth * candidateHeight);
  const aspect =
    processed.canvas.width / Math.max(1, processed.canvas.height);
  const widthMm = Math.sqrt(area * aspect);
  return { widthMm, heightMm: widthMm / aspect };
}

export type RasterPageBatchOptions = RasterPreprocessing & {
  captureNativePdf?: boolean;
  signal?: AbortSignal;
  batchSize?: number;
  pageTimeoutMs?: number;
  /** Reported once the real page count is known, for honest progress. */
  onTotalPages?: (total: number) => void;
};

export const MAX_PDF_SOURCE_BYTES = 128 * 1024 * 1024;

async function* rasterizePdfBatches(
  input: Blob | Uint8Array,
  scale = 2,
  options: RasterPageBatchOptions = {}
): AsyncGenerator<RasterPage[]> {
  const timeoutMs = options.pageTimeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS;
  if (!(input instanceof Uint8Array) && input.size > MAX_PDF_SOURCE_BYTES)
    throw new Error(
      "PDF 檔案超過安全上限；請先分拆檔案再匯入。"
    );
  const data =
    input instanceof Uint8Array
      ? input
      : new Uint8Array(await input.arrayBuffer());
  throwIfImportCancelled(options.signal);
  const loadingTask = pdfjs.getDocument({
    data,
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard-fonts/",
  });
  let pdfDocument: Awaited<typeof loadingTask.promise>;
  try {
    pdfDocument = await withPageTimeout(
      () => loadingTask.promise,
      Math.max(DEFAULT_PAGE_TIMEOUT_MS, timeoutMs),
      options.signal
    );
  } catch (error) {
    // A cancelled or timed-out load must stop the worker too, otherwise the
    // document keeps parsing behind the rejected promise.
    await loadingTask.destroy().catch(() => undefined);
    throw error;
  }
  try {
    options.onTotalPages?.(pdfDocument.numPages);
    const nativePdfBudget = options.captureNativePdf
      ? createNativePdfExtractionBudget()
      : null;
    for (
      let pageNumber = 1;
      pageNumber <= pdfDocument.numPages;
      pageNumber += 1
    ) {
      throwIfImportCancelled(options.signal);
      const page = await withPageTimeout(
        () => pdfDocument.getPage(pageNumber),
        timeoutMs,
        options.signal
      );
      let renderTask: ReturnType<typeof page.render> | undefined;
      let renderSettled = false;
      try {
        const physical = page.getViewport({ scale: 1 });
        const bounded = boundedRasterViewport(
          physical.width,
          physical.height,
          scale
        );
        const viewport = page.getViewport({ scale: bounded.scale });
        const canvas = document.createElement("canvas");
        canvas.width = bounded.width;
        canvas.height = bounded.height;
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("瀏覽器無法建立 PDF 頁面畫布。");
        context.fillStyle = "white";
        context.fillRect(0, 0, canvas.width, canvas.height);
        const nativePdfPromise = nativePdfBudget
          ? extractNativePdfPageSnapshot(page, viewport, nativePdfBudget).catch(
              () => undefined
            )
          : Promise.resolve(undefined);
        const nativePdf = await withPageTimeout(
          async pageSignal => {
            renderTask = page.render({
              canvas,
              canvasContext: context,
              viewport,
            });
            const stopRender = () => renderTask?.cancel();
            pageSignal.addEventListener("abort", stopRender, { once: true });
            try {
              await renderTask.promise;
              renderSettled = true;
            } finally {
              pageSignal.removeEventListener("abort", stopRender);
            }
            return nativePdfPromise;
          },
          timeoutMs,
          options.signal
        );
        throwIfImportCancelled(options.signal);
        // A vector page already records where every rule is; reading them beats
        // tracing lines back out of the bitmap.
        const vectorRuleExtraction = nativePdfBudget
          ? await withPageTimeout(
              async () =>
                extractPdfRuleSegments(
                  await page.getOperatorList(),
                  pdfjs.OPS,
                  viewport.transform,
                  canvas.width,
                  canvas.height
                ),
              timeoutMs,
              options.signal
            ).catch(() => ({ status: "unavailable" as const, rules: [] }))
          : { status: "unavailable" as const, rules: [] };
        const normalizedRotation =
          ((Number(options.rotation ?? 0) % 360) + 360) % 360;
        const hasNativeGeometry = Boolean(
          nativePdf?.text.items.length ||
            nativePdf?.widgets.items.length ||
            vectorRuleExtraction.rules.length
        );
        // Cropping changes the page origin and scale. Until those transforms
        // can be applied to every native text, Widget and vector-rule
        // coordinate, preserve the full PDF page instead of silently throwing
        // away the more accurate native geometry and falling back to OCR.
        const suppressAutoCropForNativeGeometry =
          options.autoCrop === true &&
          normalizedRotation === 0 &&
          hasNativeGeometry;
        const processedBase = await preprocessCanvas(
          canvas,
          suppressAutoCropForNativeGeometry
            ? { ...options, autoCrop: false }
            : options,
          options.signal
        );
        const processed = suppressAutoCropForNativeGeometry
          ? {
              ...processedBase,
              applied: {
                ...processedBase.applied,
                autoCropRequested: true,
              },
            }
          : processedBase;
        const blob = await withPageTimeout(
          () => canvasBlob(processed.canvas),
          timeoutMs,
          options.signal
        );
        throwIfImportCancelled(options.signal);
        const geometryChanged =
          processed.applied.rotation !== 0 || processed.applied.autoCropApplied;
        const nativeSourceTruncated = Boolean(
          nativePdf?.text.truncated ||
            nativePdf?.widgets.truncated ||
            nativePdf?.text.status === "budget-exhausted" ||
            nativePdf?.widgets.status === "budget-exhausted"
        );
        const physicalSize = processedPhysicalSize(
          (physical.width * 25.4) / 72,
          (physical.height * 25.4) / 72,
          processed
        );
        yield [
          {
            blob,
            page: pageNumber,
            widthMm: physicalSize.widthMm,
            heightMm: physicalSize.heightMm,
            rotation: page.rotate,
            pixelWidth: processed.canvas.width,
            pixelHeight: processed.canvas.height,
            appliedPreprocessing: processed.applied,
            sourceDetectionTruncated:
              nativeSourceTruncated ||
              vectorRuleExtraction.status === "truncated",
            ...(!geometryChanged && nativePdf ? { nativePdf } : {}),
            ...(!geometryChanged && vectorRuleExtraction.rules.length
              ? { vectorRules: vectorRuleExtraction.rules }
              : {}),
          },
        ];
      } finally {
        if (!renderSettled) renderTask?.cancel();
        page.cleanup();
      }
    }
  } finally {
    // Destroying the document tears down its loading task and worker port.
    await pdfDocument.destroy();
  }
}

export async function processImagePage(
  file: Blob,
  options: {
    rotation?: number;
    contrast?: number;
    grayscale?: boolean;
    autoCrop?: boolean;
    signal?: AbortSignal;
    sourceWidthMm?: number;
    sourceHeightMm?: number;
  } = {}
): Promise<RasterPage> {
  throwIfImportCancelled(options.signal);
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("無法讀取圖片。"));
      element.src = url;
    });
    throwIfImportCancelled(options.signal);
    // Decode into a bounded source canvas first. Preprocessing then uses the
    // exact same path as PDF and DOCX, so the controls never become format-only
    // metadata.
    const sourceSize = boundedRasterViewport(
      image.naturalWidth,
      image.naturalHeight,
      1
    );
    const canvas = document.createElement("canvas");
    canvas.width = sourceSize.width;
    canvas.height = sourceSize.height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("瀏覽器無法建立圖片畫布。");
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const processed = await preprocessCanvas(canvas, options, options.signal);
    const output = processed.canvas;
    throwIfImportCancelled(options.signal);
    const blob = await canvasBlob(output);
    // A blob produced after the person cancelled must never reach the caller.
    throwIfImportCancelled(options.signal);
    const sourceAspect = canvas.width / Math.max(1, canvas.height);
    const sourcePhysical =
      options.sourceWidthMm !== undefined &&
      options.sourceHeightMm !== undefined
        ? {
            widthMm: options.sourceWidthMm,
            heightMm: options.sourceHeightMm,
          }
        : sourceAspect <= 1
          ? { widthMm: 297 * sourceAspect, heightMm: 297 }
          : { widthMm: 297, heightMm: 297 / sourceAspect };
    const physicalSize = processedPhysicalSize(
      sourcePhysical.widthMm,
      sourcePhysical.heightMm,
      processed
    );
    return {
      blob,
      page: 1,
      widthMm: physicalSize.widthMm,
      heightMm: physicalSize.heightMm,
      rotation: processed.applied.rotation,
      pixelWidth: output.width,
      pixelHeight: output.height,
      appliedPreprocessing: processed.applied,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * docx-preview has to build the whole document in the DOM before any page can
 * be measured, so this path is explicitly bounded rather than described as
 * input-size-independent streaming.
 */
const MAX_DOCX_BYTES = 64 * 1024 * 1024;
const MAX_DOCX_PAGES = 400;

async function* renderDocxPageBatches(
  file: Blob,
  options: RasterPageBatchOptions = {}
): AsyncGenerator<RasterPage[]> {
  if (file.size > MAX_DOCX_BYTES)
    throw new Error("DOCX 檔案超過 64 MB 的安全上限；請先分拆檔案再匯入。");
  const host = document.createElement("div");
  host.style.cssText =
    "position:fixed;left:-100000px;top:0;background:white;z-index:-1";
  document.body.appendChild(host);
  try {
    throwIfImportCancelled(options.signal);
    await withPageTimeout(
      async () =>
        renderAsync(await file.arrayBuffer(), host, host, {
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: false,
          renderAltChunks: true,
          debug: false,
        }),
      Math.max(DEFAULT_PAGE_TIMEOUT_MS, options.pageTimeoutMs ?? 0),
      options.signal
    );
    throwIfImportCancelled(options.signal);
    const sections = Array.from(
      host.querySelectorAll<HTMLElement>("section.docx")
    );
    if (!sections.length) throw new Error("DOCX 未能產生任何可用頁面。");
    if (sections.length > MAX_DOCX_PAGES)
      throw new Error(
        `DOCX 頁數超過 ${MAX_DOCX_PAGES} 頁的安全上限；請先分拆檔案再匯入。`
      );
    options.onTotalPages?.(sections.length);
    for (let index = 0; index < sections.length; index += 1) {
      throwIfImportCancelled(options.signal);
      const section = sections[index]!;
      const rectangle = section.getBoundingClientRect();
      const bounded = boundedRasterViewport(
        rectangle.width,
        rectangle.height,
        2
      );
      const sourceBlob = await withPageTimeout(
        () =>
          elementToPngBlob(section, {
            backgroundColor: "#ffffff",
            pixelRatio: bounded.scale,
            // docx-preview supplies fresh blob: URLs. A cache-busting query
            // changes their identity and makes embedded images unreadable.
            cacheBust: false,
          }),
        Math.max(DEFAULT_PAGE_TIMEOUT_MS, options.pageTimeoutMs ?? 0),
        options.signal
      );
      // html-to-image cannot be aborted, so a late blob is dropped here rather
      // than reaching the import as a page.
      throwIfImportCancelled(options.signal);
      if (!sourceBlob)
        throw new Error(`DOCX 第 ${index + 1} 頁無法轉換成圖片。`);
      const processed = await withPageTimeout(
        pageSignal =>
          processImagePage(sourceBlob, {
            ...options,
            signal: pageSignal,
            sourceWidthMm: (rectangle.width * 25.4) / 96,
            sourceHeightMm: (rectangle.height * 25.4) / 96,
          }),
        Math.max(DEFAULT_PAGE_TIMEOUT_MS, options.pageTimeoutMs ?? 0),
        options.signal
      );
      yield [
        {
          ...processed,
          page: index + 1,
        },
      ];
      // Release the rendered page before the next one is rasterised.
      section.remove();
    }
  } finally {
    host.remove();
  }
}

export async function rasterizePdf(
  input: Blob | Uint8Array,
  scale = 2,
  options: { captureNativePdf?: boolean } = {}
): Promise<RasterPage[]> {
  const pages: RasterPage[] = [];
  for await (const batch of rasterizePdfBatches(input, scale, options))
    pages.push(...batch);
  return pages;
}

export async function renderDocxPages(file: Blob): Promise<RasterPage[]> {
  const pages: RasterPage[] = [];
  for await (const batch of renderDocxPageBatches(file)) pages.push(...batch);
  return pages;
}

export async function* sourceToRasterPageBatches(
  files: File[],
  options: {
    rotation?: number;
    contrast?: number;
    grayscale?: boolean;
    autoCrop?: boolean;
    captureNativePdf?: boolean;
    signal?: AbortSignal;
    batchSize?: number;
    pageTimeoutMs?: number;
    onTotalPages?: (total: number) => void;
  } = {}
): AsyncGenerator<RasterPage[]> {
  if (!files.length) throw new Error("請選擇來源檔案。");
  const batchSize = normalizeBatchSize(options.batchSize);
  if (
    files.length === 1 &&
    (files[0]!.type === "application/pdf" ||
      (!files[0]!.type && files[0]!.name.toLowerCase().endsWith(".pdf")))
  ) {
    for await (const batch of rasterizePdfBatches(files[0]!, 2, {
      rotation: options.rotation,
      contrast: options.contrast,
      grayscale: options.grayscale,
      autoCrop: options.autoCrop,
      captureNativePdf: options.captureNativePdf !== false,
      signal: options.signal,
      batchSize,
      pageTimeoutMs: options.pageTimeoutMs,
      ...(options.onTotalPages ? { onTotalPages: options.onTotalPages } : {}),
    }))
      yield batch;
    return;
  }
  if (
    files.length === 1 &&
    (files[0]!.type ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      files[0]!.name.toLowerCase().endsWith(".docx"))
  ) {
    for await (const batch of renderDocxPageBatches(files[0]!, options))
      yield batch;
    return;
  }
  const imageFiles = files.filter(
    file => file.type === "image/png" || file.type === "image/jpeg"
  );
  if (imageFiles.length !== files.length)
    throw new Error("只可同時匯入 JPG／PNG；PDF 或 DOCX 請一次選擇一個檔案。");
  options.onTotalPages?.(imageFiles.length);
  for (let index = 0; index < imageFiles.length; index += batchSize) {
    throwIfImportCancelled(options.signal);
    const batch = imageFiles.slice(index, index + batchSize);
    const pages: RasterPage[] = [];
    for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1) {
      const file = batch[batchIndex]!;
      const page = await withPageTimeout(
        pageSignal =>
          processImagePage(file, { ...options, signal: pageSignal }),
        Math.max(DEFAULT_PAGE_TIMEOUT_MS, options.pageTimeoutMs ?? 0),
        options.signal
      );
      throwIfImportCancelled(options.signal);
      pages.push({ ...page, page: index + batchIndex + 1 });
    }
    yield pages;
  }
}

export async function sourceToRasterPages(
  files: File[],
  options: {
    rotation?: number;
    contrast?: number;
    grayscale?: boolean;
    autoCrop?: boolean;
    captureNativePdf?: boolean;
  } = {}
) {
  const pages: RasterPage[] = [];
  for await (const batch of sourceToRasterPageBatches(files, options))
    pages.push(...batch);
  return pages;
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export async function downloadUrl(url: string, filename: string) {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) throw new Error("無法下載本機輸出資產。");
  downloadBlob(await response.blob(), filename);
}

export function openLocalOutput(url: string) {
  // Supplying noopener as a window feature makes window.open() return null in
  // Firefox/WebKit even when the new page was created. Opening the same-origin
  // asset first keeps popup detection reliable; sever the opener immediately.
  const popup = window.open(url, "_blank");
  if (!popup) return false;
  try {
    popup.opener = null;
    return true;
  } catch {
    popup.close();
    return false;
  }
}

export async function downloadPdfPagesAsImages(
  url: string,
  format: "png" | "jpeg",
  filenameBase: string
) {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) throw new Error("無法讀取 PDF 以轉換圖片。");
  const pages = await rasterizePdf(
    new Uint8Array(await response.arrayBuffer()),
    2.2
  );
  for (const page of pages) {
    if (format === "png")
      downloadBlob(page.blob, `${filenameBase}-p${page.page}.png`);
    else {
      const image = await createImageBitmap(page.blob);
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      canvas.getContext("2d", { alpha: false })!.drawImage(image, 0, 0);
      downloadBlob(
        await canvasBlob(canvas, "image/jpeg", 0.94),
        `${filenameBase}-p${page.page}.jpg`
      );
    }
  }
  return pages.length;
}
