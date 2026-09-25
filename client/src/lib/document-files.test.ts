/**
 * Large-document import runtime: page-count honesty, hard raster caps on every
 * source type, and the guarantee that a cancelled or timed-out page never
 * leaves a result behind.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_IMPORT_RASTER_PIXELS } from "./import-runtime";

const { pdfState, docxState, imageState } = vi.hoisted(() => ({
  pdfState: {
    pages: [] as Array<Record<string, unknown>>,
    destroyed: 0,
    loadingTaskDestroyed: 0,
    cancelledRenders: 0,
    cleanedPages: 0,
    renderDelayMs: 0,
  },
  docxState: {
    sections: [] as Array<{ width: number; height: number }>,
    pixelRatios: [] as number[],
    renderDelayMs: 0,
  },
  imageState: {
    naturalWidth: 100,
    naturalHeight: 100,
    darkBounds: null as null | {
      left: number;
      top: number;
      right: number;
      bottom: number;
    },
  },
}));

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: () => {
    const document = {
      numPages: pdfState.pages.length,
      getPage: async (pageNumber: number) => {
        const size = pdfState.pages[pageNumber - 1]!;
        return {
          rotate: 0,
          view: [0, 0, size.width as number, size.height as number],
          userUnit: 1,
          getViewport: ({ scale }: { scale: number }) => {
            const width = (size.width as number) * scale;
            const height = (size.height as number) * scale;
            return {
              width,
              height,
              scale,
              rotation: 0,
              transform: [scale, 0, 0, -scale, 0, height],
              convertToViewportPoint: (x: number, y: number) => [
                x * scale,
                height - y * scale,
              ],
              convertToViewportRectangle: (rect: number[]) => [
                rect[0]! * scale,
                height - rect[1]! * scale,
                rect[2]! * scale,
                height - rect[3]! * scale,
              ],
            };
          },
          getTextContent: async () => ({
            items: (size.textItems as unknown[] | undefined) ?? [],
          }),
          getAnnotations: async () =>
            (size.annotations as unknown[] | undefined) ?? [],
          getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
          render: () => {
            const cancelHandles: Array<() => void> = [];
            const promise = new Promise<void>((resolve, reject) => {
              if (pdfState.renderDelayMs <= 0) {
                resolve();
                return;
              }
              const timer = setTimeout(resolve, pdfState.renderDelayMs);
              cancelHandles.push(() => {
                clearTimeout(timer);
                pdfState.cancelledRenders += 1;
                reject(new Error("RENDER_CANCELLED"));
              });
            });
            return {
              promise,
              cancel: () => cancelHandles.shift()?.(),
            };
          },
          cleanup: () => {
            pdfState.cleanedPages += 1;
          },
        };
      },
      destroy: async () => {
        pdfState.destroyed += 1;
        pdfState.loadingTaskDestroyed += 1;
      },
    };
    return {
      promise: Promise.resolve(document),
      destroy: async () => {
        pdfState.loadingTaskDestroyed += 1;
      },
    };
  },
}));

vi.mock("docx-preview", () => ({
  renderAsync: async (
    _bytes: unknown,
    host: { __sections?: Array<{ width: number; height: number }> }
  ) => {
    if (docxState.renderDelayMs > 0)
      await new Promise(resolve =>
        setTimeout(resolve, docxState.renderDelayMs)
      );
    host.__sections = docxState.sections;
  },
}));

vi.mock("html-to-image", () => ({
  toBlob: async (
    node: { getBoundingClientRect: () => { width: number; height: number } },
    options: { pixelRatio: number }
  ) => {
    docxState.pixelRatios.push(options.pixelRatio);
    const rectangle = node.getBoundingClientRect();
    imageState.naturalWidth = Math.max(
      1,
      Math.round(rectangle.width * options.pixelRatio)
    );
    imageState.naturalHeight = Math.max(
      1,
      Math.round(rectangle.height * options.pixelRatio)
    );
    return new Blob(["docx-page"], { type: "image/png" });
  },
}));

const canvases: Array<{ width: number; height: number }> = [];
const canvasRotations: number[] = [];
const canvasFilters: string[] = [];

function fakeCanvas() {
  let filter = "";
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      fillStyle: "",
      get filter() {
        return filter;
      },
      set filter(value: string) {
        filter = value;
        canvasFilters.push(value);
      },
      fillRect: () => {},
      translate: () => {},
      rotate: (value: number) => canvasRotations.push(value),
      scale: () => {},
      setTransform: () => {},
      drawImage: () => {},
      getImageData: (
        left: number,
        top: number,
        width: number,
        height: number
      ) => {
        const data = new Uint8ClampedArray(width * height * 4).fill(255);
        const bounds = imageState.darkBounds;
        if (bounds)
          for (let y = 0; y < height; y += 1)
            for (let x = 0; x < width; x += 1) {
              const sourceX = left + x;
              const sourceY = top + y;
              if (
                sourceX < bounds.left ||
                sourceX > bounds.right ||
                sourceY < bounds.top ||
                sourceY > bounds.bottom
              )
                continue;
              const offset = (y * width + x) * 4;
              data[offset] = 0;
              data[offset + 1] = 0;
              data[offset + 2] = 0;
              data[offset + 3] = 255;
            }
        return { width, height, data };
      },
    }),
    toBlob: (callback: (blob: Blob | null) => void) =>
      callback(new Blob(["page"], { type: "image/png" })),
  };
  canvases.push(canvas as unknown as { width: number; height: number });
  return canvas;
}

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = imageState.naturalWidth;
  naturalHeight = imageState.naturalHeight;
  set src(_value: string) {
    this.naturalWidth = imageState.naturalWidth;
    this.naturalHeight = imageState.naturalHeight;
    setTimeout(() => this.onload?.(), 0);
  }
}

beforeEach(() => {
  canvases.length = 0;
  canvasRotations.length = 0;
  canvasFilters.length = 0;
  pdfState.pages = [];
  pdfState.destroyed = 0;
  pdfState.loadingTaskDestroyed = 0;
  pdfState.cancelledRenders = 0;
  pdfState.cleanedPages = 0;
  pdfState.renderDelayMs = 0;
  docxState.sections = [];
  docxState.pixelRatios = [];
  docxState.renderDelayMs = 0;
  imageState.naturalWidth = 100;
  imageState.naturalHeight = 100;
  imageState.darkBounds = null;

  const body = {
    appendChild: () => {},
    removeChild: () => {},
  };
  vi.stubGlobal("document", {
    body,
    createElement: (tag: string) => {
      if (tag === "canvas") return fakeCanvas();
      const element: Record<string, unknown> = {
        style: {},
        __sections: [] as Array<{ width: number; height: number }>,
        appendChild: () => {},
        remove: () => {},
      };
      element.querySelectorAll = () =>
        (
          (element.__sections as Array<{ width: number; height: number }>) ?? []
        ).map(section => ({
          getBoundingClientRect: () => ({
            width: section.width,
            height: section.height,
          }),
          remove: () => {},
        }));
      return element;
    },
  });
  vi.stubGlobal("Image", FakeImage);
  // Keep the real URL constructor (the module resolves its worker URL at
  // import time) and add only the object-URL helpers a browser would provide.
  const StubURL = class extends URL {};
  (StubURL as unknown as Record<string, unknown>).createObjectURL = () =>
    "blob:fake";
  (StubURL as unknown as Record<string, unknown>).revokeObjectURL = () => {};
  vi.stubGlobal("URL", StubURL);
});

afterEach(() => vi.unstubAllGlobals());

async function importModule() {
  return import("./document-files");
}

function pdfFile(type = "application/pdf") {
  return new File(["%PDF"], "source.pdf", { type });
}

function docxFile() {
  return new File(["docx"], "source.docx", {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}

function imageFile(name = "scan.png") {
  return new File(["png"], name, { type: "image/png" });
}

describe("bounded page rasterisation", () => {
  it("reports the real PDF page count once and yields one page per batch", async () => {
    pdfState.pages = [
      { width: 595, height: 842 },
      { width: 595, height: 842 },
      { width: 595, height: 842 },
    ];
    const { sourceToRasterPageBatches } = await importModule();
    const totals: number[] = [];
    const pages = [];
    for await (const batch of sourceToRasterPageBatches([pdfFile()], {
      onTotalPages: total => totals.push(total),
    }))
      pages.push(...batch);

    expect(totals).toEqual([3]);
    expect(pages.map(page => page.page)).toEqual([1, 2, 3]);
    expect(pdfState.cleanedPages).toBe(3);
    expect(pdfState.destroyed).toBe(1);
  });

  it("caps an oversized PDF page canvas at the raster budget", async () => {
    pdfState.pages = [{ width: 20_000, height: 40_000 }];
    const { sourceToRasterPageBatches } = await importModule();
    const pages = [];
    for await (const batch of sourceToRasterPageBatches([pdfFile()]))
      pages.push(...batch);

    expect(canvases).toHaveLength(2);
    for (const canvas of canvases)
      expect(canvas.width * canvas.height).toBeLessThanOrEqual(
        MAX_IMPORT_RASTER_PIXELS
      );
    expect(pages[0]!.pixelWidth * pages[0]!.pixelHeight).toBeLessThanOrEqual(
      MAX_IMPORT_RASTER_PIXELS
    );
  });

  it("caps oversized JPG and PNG sources at the same raster budget", async () => {
    const { sourceToRasterPageBatches } = await importModule();
    for (const [width, height] of [
      [12_000, 9_000],
      [9_000, 12_000],
      [400, 400_000],
      [4_001, 4_001],
    ] as Array<[number, number]>) {
      imageState.naturalWidth = width;
      imageState.naturalHeight = height;
      canvases.length = 0;
      const pages = [];
      for await (const batch of sourceToRasterPageBatches([imageFile()], {
        autoCrop: false,
      }))
        pages.push(...batch);

      expect(pages).toHaveLength(1);
      expect(pages[0]!.pixelWidth * pages[0]!.pixelHeight).toBeLessThanOrEqual(
        MAX_IMPORT_RASTER_PIXELS
      );
      expect(pages[0]!.pixelWidth).toBeGreaterThanOrEqual(1);
      expect(pages[0]!.pixelHeight).toBeGreaterThanOrEqual(1);
    }
  });

  it("actually applies PDF preprocessing and records the applied values", async () => {
    pdfState.pages = [{ width: 595, height: 842 }];
    const { sourceToRasterPageBatches } = await importModule();
    const pages = [];
    for await (const batch of sourceToRasterPageBatches([pdfFile()], {
      rotation: 90,
      contrast: 1.5,
      grayscale: true,
      autoCrop: false,
    }))
      pages.push(...batch);

    expect(canvasRotations).toContain(Math.PI / 2);
    expect(canvasFilters).toContain("grayscale(1) contrast(1.5)");
    expect(pages[0]!.appliedPreprocessing).toEqual({
      rotation: 90,
      contrast: 1.5,
      grayscale: true,
      autoCropRequested: false,
      autoCropApplied: false,
    });
    // Native coordinates refer to the unrotated viewport and must not be
    // attached to a geometrically changed bitmap.
    expect(pages[0]!.nativePdf).toBeUndefined();
    expect(pages[0]!.vectorRules).toBeUndefined();
    expect(pages[0]!.widthMm).toBeCloseTo((842 * 25.4) / 72, 1);
    expect(pages[0]!.heightMm).toBeCloseTo((595 * 25.4) / 72, 1);
    expect(pages[0]!.widthMm / pages[0]!.heightMm).toBeCloseTo(
      pages[0]!.pixelWidth / pages[0]!.pixelHeight,
      6
    );
  });

  it("applies the same preprocessing contract to DOCX pages", async () => {
    docxState.sections = [{ width: 794, height: 1_123 }];
    const { sourceToRasterPageBatches } = await importModule();
    const pages = [];
    for await (const batch of sourceToRasterPageBatches([docxFile()], {
      rotation: 5,
      contrast: 1.25,
      grayscale: true,
      autoCrop: false,
    }))
      pages.push(...batch);

    expect(canvasRotations).toContain((5 * Math.PI) / 180);
    expect(canvasFilters).toContain("grayscale(1) contrast(1.25)");
    expect(pages[0]!.appliedPreprocessing).toMatchObject({
      rotation: 5,
      contrast: 1.25,
      grayscale: true,
      autoCropRequested: false,
      autoCropApplied: false,
    });
    expect(pages[0]!.widthMm / pages[0]!.heightMm).toBeCloseTo(
      pages[0]!.pixelWidth / pages[0]!.pixelHeight,
      6
    );
  });

  it("keeps cropped PDF millimetres aligned with the stored bitmap", async () => {
    pdfState.pages = [{ width: 595, height: 842 }];
    imageState.darkBounds = { left: 300, top: 400, right: 899, bottom: 1_199 };
    const { sourceToRasterPageBatches } = await importModule();
    const pages = [];
    for await (const batch of sourceToRasterPageBatches([pdfFile()], {
      autoCrop: true,
    }))
      pages.push(...batch);

    expect(pages[0]!.appliedPreprocessing?.autoCropApplied).toBe(true);
    expect(pages[0]!.widthMm).toBeLessThan((595 * 25.4) / 72);
    expect(pages[0]!.heightMm).toBeLessThan((842 * 25.4) / 72);
    expect(pages[0]!.widthMm / pages[0]!.heightMm).toBeCloseTo(
      pages[0]!.pixelWidth / pages[0]!.pixelHeight,
      6
    );
  });

  it("preserves native PDF geometry instead of auto-cropping it away", async () => {
    pdfState.pages = [
      {
        width: 595,
        height: 842,
        textItems: [
          {
            str: "Full Name",
            dir: "ltr",
            transform: [10, 0, 0, 10, 40, 780],
            width: 48,
            height: 10,
            fontName: "font-1",
            hasEOL: false,
          },
        ],
      },
    ];
    imageState.darkBounds = { left: 300, top: 400, right: 899, bottom: 1_199 };
    const { sourceToRasterPageBatches } = await importModule();
    const pages = [];
    for await (const batch of sourceToRasterPageBatches([pdfFile()], {
      autoCrop: true,
    }))
      pages.push(...batch);

    expect(pages[0]!.appliedPreprocessing).toMatchObject({
      autoCropRequested: true,
      autoCropApplied: false,
    });
    expect(pages[0]!.nativePdf?.text.items[0]?.text).toBe("Full Name");
    expect(pages[0]!.widthMm).toBeCloseTo((595 * 25.4) / 72, 1);
    expect(pages[0]!.heightMm).toBeCloseTo((842 * 25.4) / 72, 1);
  });

  it("keeps rotated and cropped DOCX millimetres aligned with the stored bitmap", async () => {
    docxState.sections = [{ width: 794, height: 1_123 }];
    imageState.darkBounds = { left: 300, top: 200, right: 1_599, bottom: 1_099 };
    const { sourceToRasterPageBatches } = await importModule();
    const pages = [];
    for await (const batch of sourceToRasterPageBatches([docxFile()], {
      rotation: 90,
      autoCrop: true,
    }))
      pages.push(...batch);

    expect(pages[0]!.appliedPreprocessing).toMatchObject({
      rotation: 90,
      autoCropApplied: true,
    });
    expect(pages[0]!.widthMm / pages[0]!.heightMm).toBeCloseTo(
      pages[0]!.pixelWidth / pages[0]!.pixelHeight,
      6
    );
  });

  it("accepts a .pdf with an empty MIME type in the raster entry point", async () => {
    pdfState.pages = [{ width: 595, height: 842 }];
    const { sourceToRasterPageBatches } = await importModule();
    const pages = [];
    for await (const batch of sourceToRasterPageBatches([pdfFile("")]))
      pages.push(...batch);
    expect(pages).toHaveLength(1);
  });

  it("rejects an oversized PDF before reading its bytes and accepts the exact boundary", async () => {
    pdfState.pages = [{ width: 595, height: 842 }];
    const { MAX_PDF_SOURCE_BYTES, sourceToRasterPageBatches } =
      await importModule();
    const oversized = pdfFile();
    const oversizedRead = vi.fn(async () => new ArrayBuffer(4));
    Object.defineProperty(oversized, "size", {
      value: MAX_PDF_SOURCE_BYTES + 1,
    });
    Object.defineProperty(oversized, "arrayBuffer", { value: oversizedRead });
    await expect(
      (async () => {
        for await (const batch of sourceToRasterPageBatches([oversized]))
          void batch;
      })()
    ).rejects.toThrow("PDF 檔案超過安全上限；請先分拆檔案再匯入。");
    expect(oversizedRead).not.toHaveBeenCalled();

    const boundary = pdfFile();
    const boundaryRead = vi.fn(async () => new TextEncoder().encode("%PDF").buffer);
    Object.defineProperty(boundary, "size", { value: MAX_PDF_SOURCE_BYTES });
    Object.defineProperty(boundary, "arrayBuffer", { value: boundaryRead });
    const pages = [];
    for await (const batch of sourceToRasterPageBatches([boundary]))
      pages.push(...batch);
    expect(boundaryRead).toHaveBeenCalledOnce();
    expect(pages).toHaveLength(1);
  });

  it("keeps auto-crop inside the raster budget too", async () => {
    imageState.naturalWidth = 20_000;
    imageState.naturalHeight = 20_000;
    const { sourceToRasterPageBatches } = await importModule();
    const pages = [];
    for await (const batch of sourceToRasterPageBatches([imageFile()], {
      autoCrop: true,
    }))
      pages.push(...batch);

    expect(pages[0]!.pixelWidth * pages[0]!.pixelHeight).toBeLessThanOrEqual(
      MAX_IMPORT_RASTER_PIXELS
    );
  });

  it("records auto-crop only when it really changes the stored raster", async () => {
    imageState.darkBounds = { left: 30, top: 30, right: 69, bottom: 69 };
    const { sourceToRasterPageBatches } = await importModule();
    const pages = [];
    for await (const batch of sourceToRasterPageBatches([imageFile()], {
      autoCrop: true,
    }))
      pages.push(...batch);

    expect(pages[0]!.pixelWidth).toBeLessThan(100);
    expect(pages[0]!.pixelHeight).toBeLessThan(100);
    expect(pages[0]!.appliedPreprocessing).toMatchObject({
      autoCropRequested: true,
      autoCropApplied: true,
    });
  });

  it("caps DOCX pages and reports their real count", async () => {
    docxState.sections = [
      { width: 40_000, height: 30_000 },
      { width: 794, height: 1_123 },
    ];
    const { sourceToRasterPageBatches } = await importModule();
    const totals: number[] = [];
    const pages = [];
    for await (const batch of sourceToRasterPageBatches([docxFile()], {
      onTotalPages: total => totals.push(total),
    }))
      pages.push(...batch);

    expect(totals).toEqual([2]);
    expect(pages).toHaveLength(2);
    for (const page of pages)
      expect(page.pixelWidth * page.pixelHeight).toBeLessThanOrEqual(
        MAX_IMPORT_RASTER_PIXELS
      );
    expect(docxState.pixelRatios[1]).toBeCloseTo(2, 6);
    expect(docxState.pixelRatios[0]).toBeLessThan(2);
  });

  it("reports the page count for a multi-image import", async () => {
    const { sourceToRasterPageBatches } = await importModule();
    const totals: number[] = [];
    const pages = [];
    for await (const batch of sourceToRasterPageBatches(
      [imageFile("a.png"), imageFile("b.png"), imageFile("c.png")],
      { autoCrop: false, onTotalPages: total => totals.push(total) }
    ))
      pages.push(...batch);

    expect(totals).toEqual([3]);
    expect(pages.map(page => page.page)).toEqual([1, 2, 3]);
  });
});

describe("import cancellation", () => {
  it("stops a PDF import on the last page and destroys the document", async () => {
    pdfState.pages = [
      { width: 595, height: 842 },
      { width: 595, height: 842 },
      { width: 595, height: 842 },
    ];
    const { sourceToRasterPageBatches } = await importModule();
    const controller = new AbortController();
    const pages = [];
    await expect(
      (async () => {
        for await (const batch of sourceToRasterPageBatches([pdfFile()], {
          signal: controller.signal,
        })) {
          pages.push(...batch);
          if (pages.length === 2) controller.abort();
        }
      })()
    ).rejects.toMatchObject({ name: "ImportCancelledError" });

    expect(pages).toHaveLength(2);
    expect(pdfState.destroyed).toBe(1);
  });

  it("cancels the underlying PDF render task instead of only rejecting", async () => {
    pdfState.pages = [{ width: 595, height: 842 }];
    pdfState.renderDelayMs = 5_000;
    const { sourceToRasterPageBatches } = await importModule();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    await expect(
      (async () => {
        for await (const batch of sourceToRasterPageBatches([pdfFile()], {
          signal: controller.signal,
        }))
          void batch;
      })()
    ).rejects.toMatchObject({ name: "ImportCancelledError" });

    expect(pdfState.cancelledRenders).toBeGreaterThanOrEqual(1);
    expect(pdfState.destroyed).toBe(1);
  });

  it("drops a DOCX page that finished after cancellation", async () => {
    docxState.sections = [
      { width: 794, height: 1_123 },
      { width: 794, height: 1_123 },
    ];
    const { sourceToRasterPageBatches } = await importModule();
    const controller = new AbortController();
    const pages = [];
    await expect(
      (async () => {
        for await (const batch of sourceToRasterPageBatches([docxFile()], {
          signal: controller.signal,
        })) {
          controller.abort();
          pages.push(...batch);
        }
      })()
    ).rejects.toMatchObject({ name: "ImportCancelledError" });

    expect(pages).toHaveLength(1);
  });

  it("never returns an image page once the import was cancelled", async () => {
    const { processImagePage } = await importModule();
    const controller = new AbortController();
    controller.abort();

    await expect(
      processImagePage(imageFile(), { signal: controller.signal })
    ).rejects.toMatchObject({ name: "ImportCancelledError" });
  });

  it("stops a multi-image import between pages", async () => {
    const { sourceToRasterPageBatches } = await importModule();
    const controller = new AbortController();
    const pages = [];
    await expect(
      (async () => {
        for await (const batch of sourceToRasterPageBatches(
          [imageFile("a.png"), imageFile("b.png"), imageFile("c.png")],
          { autoCrop: false, signal: controller.signal }
        )) {
          pages.push(...batch);
          controller.abort();
        }
      })()
    ).rejects.toMatchObject({ name: "ImportCancelledError" });

    expect(pages).toHaveLength(1);
  });
});
