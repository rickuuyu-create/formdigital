/**
 * 免費 OCR Provider：只使用開源 Tesseract.js，不呼叫任何付費 AI API。
 * Worker、WASM core 及繁中／簡中／英文語言模型均由同源網站提供，
 * 不依賴 CDN 或付費 API；文件影像與辨識內容保留在瀏覽器記憶體內。
 */
import { createWorker, PSM } from "tesseract.js";
import {
  DEFAULT_PAGE_TIMEOUT_MS,
  ImportCancelledError,
  throwIfImportCancelled,
  withPageTimeout,
} from "./import-runtime";

export type OcrWord = {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
};
export type OcrSuggestion = OcrWord & { status: "suggested" };
export type FreeOcrLanguage = "auto" | "eng" | "chi_tra" | "chi_sim";
export const MAX_FREE_OCR_WORDS_PER_PAGE = 10_000;
export const DEFAULT_OCR_TIMEOUT_MS = Math.max(
  DEFAULT_PAGE_TIMEOUT_MS,
  120_000
);

export type FreeOcrResult = {
  provider: "tesseract.js";
  cost: "free-open-source";
  suggestions: OcrSuggestion[];
  truncated: boolean;
  notice: string;
};

export type FreeOcrSession = {
  recognize: (
    file: File,
    options?: {
      signal?: AbortSignal;
      timeoutMs?: number;
      onProgress?: (progress: number) => void;
    }
  ) => Promise<FreeOcrResult>;
  terminate: () => Promise<void>;
};

export function resolveFreeOcrLanguages(language: FreeOcrLanguage) {
  return language === "auto" ? ["chi_tra", "chi_sim", "eng"] : [language];
}

export function localOcrRuntimePaths(baseUrl: string) {
  return {
    workerPath: new URL("/ocr-runtime/worker.min.js", baseUrl).href,
    corePath: new URL("/ocr-runtime/tesseract-core-lstm.wasm.js", baseUrl).href,
    langPath: new URL("/ocr-runtime/tessdata", baseUrl).href.replace(/\/$/, ""),
  };
}

export function toUnconfirmedSuggestions(words: OcrWord[]): OcrSuggestion[] {
  return words
    .filter(word => word.text.trim().length > 0)
    .map(word => ({ ...word, status: "suggested" as const }));
}

/**
 * One worker is reused for every page in an import. Cancellation or timeout
 * terminates that worker, so WASM recognition cannot continue behind a closed
 * import dialog.
 */
export function createFreeOcrSession(
  language: FreeOcrLanguage = "eng"
): FreeOcrSession {
  type Worker = Awaited<ReturnType<typeof createWorker>>;
  let workerPromise: Promise<Worker> | null = null;
  let configured = false;
  let closed = false;
  let progressListener: ((progress: number) => void) | undefined;

  const retireWorker = async () => {
    const retiring = workerPromise;
    workerPromise = null;
    configured = false;
    if (!retiring) return;
    await retiring
      .then(worker => worker.terminate())
      .catch(() => undefined);
  };

  const ensureWorker = async () => {
    if (closed) throw new ImportCancelledError();
    workerPromise ??= createWorker(resolveFreeOcrLanguages(language), 1, {
      ...localOcrRuntimePaths(window.location.href),
      logger: event =>
        progressListener?.(
          typeof event.progress === "number" ? event.progress : 0
        ),
    });
    const creating = workerPromise;
    const worker = await creating;
    if (closed || workerPromise !== creating) {
      throw new ImportCancelledError();
    }
    if (!configured) {
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SPARSE_TEXT,
        preserve_interword_spaces: "1",
      });
      configured = true;
    }
    return worker;
  };

  const terminate = async () => {
    if (closed) return;
    closed = true;
    await retireWorker();
  };

  const recognize: FreeOcrSession["recognize"] = async (file, options = {}) => {
    if (!file.type.startsWith("image/"))
      throw new Error(
        "免費瀏覽器 OCR 目前只接受影像檔；掃描 PDF 請先轉換成頁面影像。"
      );
    throwIfImportCancelled(options.signal);
    return withPageTimeout(
      async pageSignal => {
        // A page timeout retires only the worker that is stuck. The session
        // remains open and lazily creates a fresh worker for the next page.
        // A caller abort is still converted into an import-wide cancellation.
        const stopWorker = () => void retireWorker();
        pageSignal.addEventListener("abort", stopWorker, { once: true });
        progressListener = options.onProgress;
        try {
          const worker = await ensureWorker();
          throwIfImportCancelled(pageSignal);
          const result = await worker.recognize(
            file,
            {},
            { text: true, blocks: true }
          );
          throwIfImportCancelled(pageSignal);
          const words: OcrWord[] = [];
          let truncated = false;
          outer: for (const block of result.data.blocks ?? []) {
            for (const paragraph of block.paragraphs) {
              for (const line of paragraph.lines) {
                for (const word of line.words) {
                  if (words.length >= MAX_FREE_OCR_WORDS_PER_PAGE) {
                    truncated = true;
                    break outer;
                  }
                  words.push({
                    text: word.text,
                    confidence: word.confidence,
                    bbox: word.bbox,
                  });
                }
              }
            }
          }
          return {
            provider: "tesseract.js",
            cost: "free-open-source",
            suggestions: toUnconfirmedSuggestions(words),
            truncated,
            notice:
              "所有結果均為未確認建議，必須由使用者確認後才可存入 Template Draft。",
          };
        } catch (error) {
          if (options.signal?.aborted) {
            await retireWorker();
            throw new ImportCancelledError();
          }
          throw error;
        } finally {
          progressListener = undefined;
          pageSignal.removeEventListener("abort", stopWorker);
        }
      },
      options.timeoutMs ?? DEFAULT_OCR_TIMEOUT_MS,
      options.signal
    );
  };

  return { recognize, terminate };
}

export async function recognizeImageWithFreeOcr(
  file: File,
  language: FreeOcrLanguage = "eng",
  onProgress?: (progress: number) => void,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
) {
  const session = createFreeOcrSession(language);
  try {
    return await session.recognize(file, { ...options, onProgress });
  } finally {
    await session.terminate();
  }
}
