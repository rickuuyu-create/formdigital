import { beforeEach, describe, expect, it, vi } from "vitest";

const { ocrState } = vi.hoisted(() => ({
  ocrState: {
    created: 0,
    terminated: 0,
    recognizeCalls: 0,
    stall: false,
    stallFirstWorker: false,
    wordCount: 1,
  },
}));

vi.mock("tesseract.js", () => ({
  PSM: { SPARSE_TEXT: 11 },
  createWorker: async () => {
    ocrState.created += 1;
    const workerNumber = ocrState.created;
    return {
      setParameters: async () => undefined,
      recognize: async () => {
        ocrState.recognizeCalls += 1;
        if (ocrState.stall || (ocrState.stallFirstWorker && workerNumber === 1))
          await new Promise(() => undefined);
        return {
          data: {
            blocks: [
              {
                paragraphs: [
                  {
                    lines: [
                      {
                        words: Array.from(
                          { length: ocrState.wordCount },
                          (_, index) => ({
                            text: index === 0 ? "Name" : `Word ${index}`,
                            confidence: 91,
                            bbox: { x0: 1, y0: 2, x1: 20, y1: 12 },
                          })
                        ),
                      },
                    ],
                  },
                ],
              },
            ],
          },
        };
      },
      terminate: async () => {
        ocrState.terminated += 1;
      },
    };
  },
}));
import {
  createFreeOcrSession,
  localOcrRuntimePaths,
  MAX_FREE_OCR_WORDS_PER_PAGE,
  resolveFreeOcrLanguages,
  toUnconfirmedSuggestions,
} from "./free-ocr";

beforeEach(() => {
  ocrState.created = 0;
  ocrState.terminated = 0;
  ocrState.recognizeCalls = 0;
  ocrState.stall = false;
  ocrState.stallFirstWorker = false;
  ocrState.wordCount = 1;
  vi.stubGlobal("window", { location: { href: "http://127.0.0.1:3000/" } });
});

describe("free OCR suggestion contract", () => {
  it("drops blank OCR output and forces every retained result into suggested state", () => {
    expect(
      toUnconfirmedSuggestions([
        { text: "", confidence: 91, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } },
        {
          text: "Student ID",
          confidence: 88,
          bbox: { x0: 2, y0: 3, x1: 30, y1: 10 },
        },
      ])
    ).toEqual([
      {
        text: "Student ID",
        confidence: 88,
        bbox: { x0: 2, y0: 3, x1: 30, y1: 10 },
        status: "suggested",
      },
    ]);
  });

  it("uses all three required languages for automatic mixed-language OCR", () => {
    expect(resolveFreeOcrLanguages("auto")).toEqual([
      "chi_tra",
      "chi_sim",
      "eng",
    ]);
    expect(resolveFreeOcrLanguages("chi_tra")).toEqual(["chi_tra"]);
  });

  it("loads the OCR worker, core, and language data from the local app origin", () => {
    expect(localOcrRuntimePaths("http://127.0.0.1:3000/editor")).toEqual({
      workerPath: "http://127.0.0.1:3000/ocr-runtime/worker.min.js",
      corePath: "http://127.0.0.1:3000/ocr-runtime/tesseract-core-lstm.wasm.js",
      langPath: "http://127.0.0.1:3000/ocr-runtime/tessdata",
    });
  });

  it("reuses one browser OCR worker across an import and terminates it once", async () => {
    const session = createFreeOcrSession("eng");
    const file = new File(["image"], "page.png", { type: "image/png" });

    await expect(session.recognize(file)).resolves.toMatchObject({
      suggestions: [{ text: "Name" }],
      truncated: false,
    });
    await expect(session.recognize(file)).resolves.toMatchObject({
      suggestions: [{ text: "Name" }],
    });
    await session.terminate();
    await session.terminate();

    expect(ocrState.created).toBe(1);
    expect(ocrState.recognizeCalls).toBe(2);
    expect(ocrState.terminated).toBe(1);
  });

  it("returns promptly and terminates the worker when OCR is cancelled", async () => {
    ocrState.stall = true;
    const session = createFreeOcrSession("eng");
    const controller = new AbortController();
    const operation = session.recognize(
      new File(["image"], "page.png", { type: "image/png" }),
      { signal: controller.signal, timeoutMs: 10_000 }
    );
    setTimeout(() => controller.abort(), 10);

    await expect(operation).rejects.toMatchObject({
      name: "ImportCancelledError",
    });
    await vi.waitFor(() => expect(ocrState.terminated).toBe(1));
  });

  it("reports when browser OCR words hit the bounded per-page limit", async () => {
    ocrState.wordCount = MAX_FREE_OCR_WORDS_PER_PAGE + 1;
    const session = createFreeOcrSession("eng");
    const result = await session.recognize(
      new File(["image"], "page.png", { type: "image/png" })
    );
    await session.terminate();

    expect(result.suggestions).toHaveLength(MAX_FREE_OCR_WORDS_PER_PAGE);
    expect(result.truncated).toBe(true);
  });

  it("bounds a stalled browser OCR page with a timeout", async () => {
    ocrState.stall = true;
    const session = createFreeOcrSession("eng");
    const operation = session.recognize(
      new File(["image"], "page.png", { type: "image/png" }),
      { timeoutMs: 20 }
    );

    await expect(operation).rejects.toThrow("頁面處理逾時");
    await vi.waitFor(() => expect(ocrState.terminated).toBe(1));
  });

  it("retires only a timed-out page worker and recognizes the next page with a fresh worker", async () => {
    ocrState.stallFirstWorker = true;
    const session = createFreeOcrSession("eng");
    const file = new File(["image"], "page.png", { type: "image/png" });

    await expect(
      session.recognize(file, { timeoutMs: 20 })
    ).rejects.toMatchObject({ name: "ImportPageTimeoutError" });
    await vi.waitFor(() => expect(ocrState.terminated).toBe(1));

    await expect(session.recognize(file, { timeoutMs: 1_000 })).resolves.toMatchObject({
      suggestions: [{ text: "Name" }],
    });
    expect(ocrState.created).toBe(2);
    expect(ocrState.recognizeCalls).toBe(2);
    await session.terminate();
    expect(ocrState.terminated).toBe(2);
  });
});
