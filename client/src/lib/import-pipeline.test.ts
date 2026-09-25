/**
 * Source-import orchestration: what gets written, when a cancelled run stops,
 * and what the person is told afterwards. Every dependency is injected, so
 * these are deterministic and never touch a real Local Data Service.
 */
import { describe, expect, it, vi } from "vitest";
import { MAX_SUGGESTED_FIELDS_PER_DOCUMENT } from "./detection-fusion";
import type { RasterPage } from "./document-files";
import type { FormStructure, PositionedWord } from "./form-structure";
import { ImportCancelledError } from "./import-runtime";
import { runSourceImport, type ImportPipelineDeps } from "./import-pipeline";

function rasterPage(pageNumber: number): RasterPage {
  return {
    blob: new Blob([`page-${pageNumber}`], { type: "image/png" }),
    page: pageNumber,
    widthMm: 210,
    heightMm: 297,
    rotation: 0,
    pixelWidth: 1_000,
    pixelHeight: 1_414,
  };
}

function textBox(index: number): FormStructure {
  return {
    kind: "text-box",
    left: 100,
    top: 100 + index * 40,
    width: 200,
    height: 24,
    confidence: 0.9,
  };
}

type Harness = {
  deps: ImportPipelineDeps;
  state: {
    templates: Set<string>;
    assets: Set<string>;
    savedPages: unknown[];
    savedFields: unknown[];
    progress: string[];
  };
};

function harness(
  overrides: Partial<ImportPipelineDeps> = {},
  options: {
    pages?: number;
    structuresPerPage?: (pageIndex: number) => FormStructure[];
    words?: PositionedWord[];
    totalPagesKnown?: boolean;
  } = {}
): Harness {
  const state = {
    templates: new Set<string>(),
    assets: new Set<string>(),
    savedPages: [] as unknown[],
    savedFields: [] as unknown[],
    progress: [] as string[],
  };
  let assetCounter = 0;
  const pageCount = options.pages ?? 1;
  const deps: ImportPipelineDeps = {
    createDraft: async () => {
      state.templates.add("tpl-1");
      return { templateId: "tpl-1", versionId: "ver-1" };
    },
    uploadAsset: async () => {
      assetCounter += 1;
      const assetId = `asset-${assetCounter}`;
      state.assets.add(assetId);
      return { assetId };
    },
    pageBatches: async function* (batchOptions) {
      if (options.totalPagesKnown !== false)
        batchOptions.onTotalPages(pageCount);
      for (let index = 0; index < pageCount; index += 1)
        yield [rasterPage(index + 1)];
    },
    detectStructures: async blob => {
      const match = /page-(\d+)/.exec(await blob.text());
      const pageIndex = Number(match?.[1] ?? 1) - 1;
      return options.structuresPerPage?.(pageIndex) ?? [textBox(0)];
    },
    recognizeWords: async () => options.words ?? [],
    savePages: async input => {
      state.savedPages.push(input);
    },
    saveFields: async input => {
      state.savedFields.push(input);
    },
    rollbackDeps: {
      deleteTemplate: async id => {
        state.templates.delete(id);
      },
      deleteAsset: async id => {
        state.assets.delete(id);
      },
      listTemplateIds: async () => [...state.templates],
      listAssetIds: async () => [...state.assets],
    },
    onProgress: message => state.progress.push(message),
    ocrAvailable: true,
    ...overrides,
  };
  return { deps, state };
}

function input(signal: AbortSignal, files = 1, runDetection = true) {
  return {
    files: Array.from(
      { length: files },
      (_, index) =>
        new File(["source"], `source-${index + 1}.pdf`, {
          type: "application/pdf",
        })
    ),
    name: "Fixture Template",
    runDetection,
    preprocessing: {
      rotation: 0,
      contrast: 1,
      grayscale: false,
      autoCrop: false,
    },
    signal,
  };
}

let idCounter = 0;
const stableId = () => `field-${(idCounter += 1)}`;

describe("source import pipeline", () => {
  it.each([true, false])("review OCR availability reflects runtime fallback success=%s", async succeeds => {
    const { deps } = harness({
      ocrAvailable: true,
      recognizeWords: async () => { if (!succeeds) throw new Error("synthetic offline engines unavailable"); return []; },
    });
    let available: boolean | undefined;
    deps.onReview = async ctx => { available = ctx.ocrAvailable; return []; };
    await runSourceImport(input(new AbortController().signal), deps);
    expect(available).toBe(succeeds);
  });
  it.each(["late-resolve", "late-reject"])("abort during a pending review rolls back once and ignores %s", async late => {
    const run = new AbortController(); const { deps, state } = harness({}, { pages: 3 });
    let enter!: () => void; const entered = new Promise<void>(r => { enter = r; });
    let resolve!: (v: []) => void; let reject!: (e: Error) => void;
    deps.onReview = () => { enter(); return new Promise<[]>((a, b) => { resolve = a; reject = b; }); };
    const deletion = vi.spyOn(deps.rollbackDeps, "deleteTemplate");
    const pending = runSourceImport(input(run.signal), deps, { createStableFieldId: stableId });
    await entered; run.abort();
    await expect(pending).resolves.toMatchObject({ status: "cancelled", rollback: { verified: true } });
    if (late === "late-resolve") resolve([]); else reject(new Error("late fixture"));
    await Promise.resolve(); expect(deletion).toHaveBeenCalledTimes(1);
    expect(state.assets.size).toBe(0); expect(state.templates.size).toBe(0);
    expect(state.savedFields).toEqual([]); expect(state.savedPages).toEqual([]);
  });

  it("400-page review holds metadata and bounded candidates, never page blobs", async () => {
    const { deps } = harness({}, { pages: 400 });
    deps.onReview = async ctx => {
      expect(ctx.pages).toHaveLength(400); expect(ctx.suggestedFields.length).toBeLessThanOrEqual(5000);
      const visit = (v: unknown) => {
        expect(v instanceof Blob).toBe(false);
        if (typeof v === "string") expect(v).not.toMatch(/^(data:|blob:)/);
        if (v && typeof v === "object") Object.values(v).forEach(visit);
      };
      visit(ctx.pages); visit(ctx.suggestedFields);
      expect(Buffer.byteLength(JSON.stringify(ctx.pages))).toBeLessThan(100_000);
      return [];
    };
    const result = await runSourceImport(input(new AbortController().signal), deps, { createStableFieldId: stableId });
    expect(result).toMatchObject({ status: "created", pages: 400, suggestions: 0 });
  });

  it("failed review rollback is surfaced, never reported as clean cancellation", async () => {
    const { deps, state } = harness();
    deps.onReview = async () => "cancelled";
    deps.rollbackDeps.deleteTemplate = async () => { throw new Error("synthetic failure"); };
    const result = await runSourceImport(input(new AbortController().signal), deps);
    expect(result).toMatchObject({ status: "cancelled", rollback: { verified: false } });
    expect(state.templates.has("tpl-1")).toBe(true);
  });
  it("saves one manifest entry and one page asset per page", async () => {
    const { deps, state } = harness({}, { pages: 3 });
    const result = await runSourceImport(
      input(new AbortController().signal),
      deps,
      { createStableFieldId: stableId }
    );

    expect(result).toMatchObject({
      status: "created",
      versionId: "ver-1",
      pages: 3,
      truncation: "none",
    });
    expect(state.savedPages).toHaveLength(1);
    const manifest = (state.savedPages[0] as { pageManifest: unknown[] })
      .pageManifest;
    expect(manifest).toHaveLength(3);
    // One original source asset plus one asset per rasterised page.
    expect(state.assets.size).toBe(4);
    expect(
      (manifest as Array<{ page: number; assetId: string }>).map(
        entry => entry.page
      )
    ).toEqual([1, 2, 3]);
  });

  it("stores preprocessing metadata from the raster that was really produced", async () => {
    const uploads: Array<{ kind: string; preprocessing?: unknown }> = [];
    const { deps } = harness({
      uploadAsset: async upload => {
        uploads.push(upload);
        return {
          assetId: `asset-${uploads.length}`,
          mimeType: upload.mimeType,
        };
      },
      pageBatches: async function* (batchOptions) {
        batchOptions.onTotalPages(1);
        yield [
          {
            ...rasterPage(1),
            appliedPreprocessing: {
              rotation: 5,
              contrast: 1.25,
              grayscale: true,
              autoCropRequested: true,
              autoCropApplied: false,
            },
          },
        ];
      },
    });

    await runSourceImport(
      { ...input(new AbortController().signal), runDetection: false },
      deps,
      { createStableFieldId: stableId }
    );

    expect(
      uploads.find(upload => upload.kind === "page")?.preprocessing
    ).toEqual({
      rotation: 5,
      contrast: 1.25,
      grayscale: true,
      autoCropRequested: true,
      autoCropApplied: false,
    });
  });

  it("truthfully propagates bounded detector and OCR source truncation", async () => {
    const cases: Array<Partial<ImportPipelineDeps>> = [
      {
        pageBatches: async function* (batchOptions) {
          batchOptions.onTotalPages(1);
          yield [{ ...rasterPage(1), sourceDetectionTruncated: true }];
        },
      },
      {
        detectStructures: async () => ({
          structures: [textBox(0)],
          truncated: true,
        }),
      },
      {
        recognizeWords: async () => ({ words: [], truncated: true }),
      },
    ];

    for (const overrides of cases) {
      const { deps } = harness(overrides);
      const result = await runSourceImport(
        input(new AbortController().signal),
        deps,
        { createStableFieldId: stableId }
      );
      expect(result).toMatchObject({
        status: "created",
        truncation: "page",
      });
    }
  });

  it("counts pages against the real total when the format knows it", async () => {
    const { deps, state } = harness({}, { pages: 3 });
    await runSourceImport(input(new AbortController().signal), deps, {
      createStableFieldId: stableId,
    });

    expect(state.progress).toContain("保存第 1/3 頁…");
    expect(state.progress).toContain("保存第 2/3 頁…");
    expect(state.progress).toContain("保存第 3/3 頁…");
    expect(state.progress.some(message => message.includes("/1 頁"))).toBe(
      false
    );
  });

  it("counts processed pages honestly when the page count is unknown", async () => {
    const { deps, state } = harness({}, { pages: 2, totalPagesKnown: false });
    await runSourceImport(input(new AbortController().signal), deps, {
      createStableFieldId: stableId,
    });

    expect(state.progress).toContain("保存已處理 1 頁…");
    expect(state.progress).toContain("保存已處理 2 頁…");
    expect(state.progress.some(message => message.includes("/"))).toBe(false);
  });

  it("keeps detecting on every page instead of stopping after the first", async () => {
    const { deps, state } = harness(
      {},
      {
        pages: 3,
        structuresPerPage: pageIndex =>
          Array.from({ length: 4 }, (_, index) => ({
            ...textBox(index),
            top: 100 + index * 40 + pageIndex,
          })),
      }
    );
    const result = await runSourceImport(
      input(new AbortController().signal),
      deps,
      { createStableFieldId: stableId }
    );

    expect(result).toMatchObject({ status: "created", suggestions: 12 });
    const fields = (
      state.savedFields[0] as {
        fields: Array<{ coordinate: { page: number } }>;
      }
    ).fields;
    expect(new Set(fields.map(field => field.coordinate.page))).toEqual(
      new Set([1, 2, 3])
    );
    expect(
      fields.every(
        field =>
          (field as unknown as { definition: { confirmed: boolean } })
            .definition.confirmed === false
      )
    ).toBe(true);
  });

  it("rolls back and reports cancellation raised during a source upload", async () => {
    const controller = new AbortController();
    const { deps, state } = harness({
      uploadAsset: async () => {
        controller.abort();
        throw new ImportCancelledError();
      },
    });
    const result = await runSourceImport(input(controller.signal), deps, {
      createStableFieldId: stableId,
    });

    expect(result).toMatchObject({
      status: "cancelled",
      rollback: { verified: true, remaining: 0 },
    });
    expect(state.templates.size).toBe(0);
    expect(state.savedPages).toHaveLength(0);
  });

  it("stops during recognition without saving anything", async () => {
    const controller = new AbortController();
    const { deps, state } = harness(
      {
        recognizeWords: async () => {
          controller.abort();
          return [];
        },
      },
      { pages: 2 }
    );
    const result = await runSourceImport(input(controller.signal), deps, {
      createStableFieldId: stableId,
    });

    expect(result.status).toBe("cancelled");
    expect(state.savedPages).toHaveLength(0);
    expect(state.savedFields).toHaveLength(0);
    expect(state.templates.size).toBe(0);
    expect(state.assets.size).toBe(0);
  });

  it("creates nothing when the last page is cancelled", async () => {
    const controller = new AbortController();
    let uploads = 0;
    const { deps, state } = harness(
      {
        uploadAsset: async () => {
          uploads += 1;
          const assetId = `asset-${uploads}`;
          state0.assets.add(assetId);
          // One source asset plus three page assets: abort on the last page.
          if (uploads === 4) controller.abort();
          return { assetId };
        },
      },
      { pages: 3 }
    );
    const state0 = state;
    const result = await runSourceImport(input(controller.signal), deps, {
      createStableFieldId: stableId,
    });

    expect(result).toMatchObject({ status: "cancelled" });
    expect(state.savedPages).toHaveLength(0);
    expect(state.templates.size).toBe(0);
    expect(state.assets.size).toBe(0);
  });

  it("does not save fields or report success when cancelled between the two saves", async () => {
    const controller = new AbortController();
    const { deps, state } = harness({
      savePages: async input_ => {
        state0.savedPages.push(input_);
        controller.abort();
      },
    });
    const state0 = state;
    const result = await runSourceImport(input(controller.signal), deps, {
      createStableFieldId: stableId,
    });

    expect(result.status).toBe("cancelled");
    expect(state.savedFields).toHaveLength(0);
    expect(state.templates.size).toBe(0);
  });

  it("does not report success when cancelled after the final save", async () => {
    const controller = new AbortController();
    const { deps, state } = harness({
      saveFields: async input_ => {
        state0.savedFields.push(input_);
        controller.abort();
      },
    });
    const state0 = state;
    const result = await runSourceImport(input(controller.signal), deps, {
      createStableFieldId: stableId,
    });

    expect(result.status).toBe("cancelled");
    expect(result).not.toHaveProperty("versionId");
    expect(state.templates.size).toBe(0);
  });

  it("drops a late timeout result instead of writing it into the template", async () => {
    const { deps, state } = harness({
      pageBatches: async function* (batchOptions) {
        batchOptions.onTotalPages(2);
        yield [rasterPage(1)];
        throw new Error("頁面處理逾時，已停止本次匯入。");
      },
    });
    const result = await runSourceImport(
      input(new AbortController().signal),
      deps,
      { createStableFieldId: stableId }
    );

    expect(result).toMatchObject({ status: "failed" });
    expect(state.savedPages).toHaveLength(0);
    expect(state.savedFields).toHaveLength(0);
    expect(state.templates.size).toBe(0);
    expect(state.assets.size).toBe(0);
  });

  it("reports an unverified rollback rather than a clean failure", async () => {
    const { deps } = harness({
      savePages: async () => {
        throw new Error("SAVE_FAILED");
      },
    });
    const result = await runSourceImport(
      input(new AbortController().signal),
      {
        ...deps,
        rollbackDeps: {
          ...deps.rollbackDeps,
          deleteAsset: async () => {
            throw new Error("STUCK");
          },
        },
      },
      { createStableFieldId: stableId }
    );

    expect(result).toMatchObject({
      status: "failed",
      rollback: { verified: false },
    });
    expect(
      (result as { rollback: { remaining: number } }).rollback.remaining
    ).toBeGreaterThan(0);
  });

  it("still saves pages when detection is switched off", async () => {
    const detectStructures = vi.fn();
    const { deps, state } = harness({ detectStructures }, { pages: 2 });
    const result = await runSourceImport(
      { ...input(new AbortController().signal), runDetection: false },
      deps,
      { createStableFieldId: stableId }
    );

    expect(result).toMatchObject({ status: "created", suggestions: 0 });
    expect(detectStructures).not.toHaveBeenCalled();
    expect(state.savedFields).toHaveLength(0);
    expect(
      (state.savedPages[0] as { pageManifest: unknown[] }).pageManifest
    ).toHaveLength(2);
  });

  it("keeps saving later pages after the document suggestion ceiling is reached", async () => {
    const perPage = 60;
    const pages = Math.ceil(MAX_SUGGESTED_FIELDS_PER_DOCUMENT / perPage) + 2;
    const { deps, state } = harness(
      {},
      {
        pages,
        structuresPerPage: () =>
          Array.from({ length: perPage }, (_, index) => textBox(index)),
      }
    );
    const result = await runSourceImport(
      input(new AbortController().signal),
      deps,
      { createStableFieldId: stableId }
    );

    expect(result).toMatchObject({
      status: "created",
      pages,
      suggestions: MAX_SUGGESTED_FIELDS_PER_DOCUMENT,
      truncation: "document",
    });
    // Every page is still rasterised and saved; only the suggestion list stops.
    expect(
      (state.savedPages[0] as { pageManifest: unknown[] }).pageManifest
    ).toHaveLength(pages);
  });

  it("falls back to OCR labels only when geometry found nothing", async () => {
    const { deps, state } = harness(
      {},
      {
        pages: 1,
        structuresPerPage: () => [],
        words: [
          {
            text: "Student Name",
            confidence: 92,
            left: 40,
            top: 60,
            width: 120,
            height: 20,
          },
        ],
      }
    );
    const result = await runSourceImport(
      input(new AbortController().signal),
      deps,
      { createStableFieldId: stableId }
    );

    expect(result).toMatchObject({ status: "created", suggestions: 1 });
    const [field] = (
      state.savedFields[0] as {
        fields: Array<{ definition: Record<string, unknown> }>;
      }
    ).fields;
    expect(field?.definition.label).toBe("Student Name");
    expect(field?.definition.confirmed).toBe(false);
    expect(field?.definition.aiSuggested).toBe(true);
  });

  it("keeps the template when OCR is unavailable for a page", async () => {
    const onOcrUnavailable = vi.fn();
    const { deps, state } = harness(
      {
        recognizeWords: async () => {
          throw new Error("OCR_DOWN");
        },
        onOcrUnavailable,
      },
      { pages: 1 }
    );
    const result = await runSourceImport(
      input(new AbortController().signal),
      deps,
      { createStableFieldId: stableId }
    );

    expect(result.status).toBe("created");
    expect(onOcrUnavailable).toHaveBeenCalledWith(1);
    expect(state.templates.has("tpl-1")).toBe(true);
  });
  it("refuses the import when the service stores a page under another type", async () => {
    // A Local Data Service process older than this client ignores the requested
    // mimeType and keeps its own default, which would save a page bitmap the
    // editor can never display.
    const { deps, state } = harness(
      {
        uploadAsset: async upload => {
          const assetId = `asset-${state0.assets.size + 1}`;
          state0.assets.add(assetId);
          return {
            assetId,
            mimeType: upload.kind === "page" ? "text/csv" : upload.mimeType,
          };
        },
      },
      { pages: 2 }
    );
    const state0 = state;

    const result = await runSourceImport(
      input(new AbortController().signal),
      deps,
      { createStableFieldId: stableId }
    );

    expect(result).toMatchObject({
      status: "service-outdated",
      rollback: { verified: true, remaining: 0 },
    });
    // Nothing half-built survives: no Template, no orphan page asset.
    expect(state.templates.size).toBe(0);
    expect(state.assets.size).toBe(0);
    expect(state.savedPages).toHaveLength(0);
    expect(state.savedFields).toHaveLength(0);
  });

  it("accepts an upload whose stored type matches the request", async () => {
    const { deps } = harness({
      uploadAsset: async upload => ({
        assetId: `asset-${Math.random().toString(36).slice(2, 8)}`,
        mimeType: upload.mimeType,
      }),
    });

    const result = await runSourceImport(
      input(new AbortController().signal),
      deps,
      { createStableFieldId: stableId }
    );

    expect(result.status).toBe("created");
  });

  it("stays compatible with an upload that reports no stored type", async () => {
    const { deps } = harness({
      uploadAsset: async () => ({ assetId: "asset-x" }),
    });

    const result = await runSourceImport(
      input(new AbortController().signal),
      deps,
      { createStableFieldId: stableId }
    );

    expect(result.status).toBe("created");
  });
  it("combines traced pixels, vector rules, and text-layer labels on one page", async () => {
    const { deps, state } = harness(
      {
        // Traced geometry finds a box the other two sources cannot see.
        detectStructures: async () => [
          {
            kind: "checkbox",
            left: 80,
            top: 900,
            width: 18,
            height: 18,
            confidence: 0.9,
          },
        ],
        // The text layer supplies a "label：" blank with real wording.
        recognizeWords: async () => [
          {
            text: "職位：",
            confidence: 99,
            left: 100,
            top: 300,
            width: 80,
            height: 20,
          },
        ],
        pageBatches: async function* (batchOptions) {
          batchOptions.onTotalPages(1);
          yield [
            {
              ...rasterPage(1),
              // A vector rule far from both of the above.
              vectorRules: [
                {
                  leftPx: 120,
                  topPx: 600,
                  widthPx: 500,
                  heightPx: 1,
                  orientation: "horizontal" as const,
                },
              ],
            },
          ];
        },
      },
      { pages: 1 }
    );

    const result = await runSourceImport(
      input(new AbortController().signal),
      deps,
      { createStableFieldId: stableId }
    );

    expect(result).toMatchObject({ status: "created" });
    const fields = (
      state.savedFields[0] as {
        fields: Array<{
          fieldType: string;
          definition: Record<string, unknown>;
        }>;
      }
    ).fields;
    // One from each source, none swallowed by the others.
    expect(fields).toHaveLength(3);
    expect(fields.some(field => field.fieldType === "checkbox")).toBe(true);
    expect(fields.some(field => field.definition.label === "職位")).toBe(true);
    expect(fields.every(field => field.definition.confirmed === false)).toBe(
      true
    );
  });

  it("still works on a page with no vector rules at all", async () => {
    const { deps } = harness({}, { pages: 1 });
    const result = await runSourceImport(
      input(new AbortController().signal),
      deps,
      { createStableFieldId: stableId }
    );

    expect(result).toMatchObject({ status: "created", suggestions: 1 });
  });

  it("allows onReview to filter suggestions before saving", async () => {
    const { deps, state } = harness({}, { pages: 2 });
    const onReview = vi.fn().mockImplementation(async ctx => {
      // Exclude second suggestion
      return [ctx.suggestedFields[0]];
    });
    deps.onReview = onReview;

    const result = await runSourceImport(
      input(new AbortController().signal),
      deps,
      { createStableFieldId: stableId }
    );

    expect(result).toMatchObject({ status: "created", suggestions: 1 });
    expect(onReview).toHaveBeenCalledOnce();
    const ctx = onReview.mock.calls[0][0];
    expect(ctx.pages).toHaveLength(2);
    expect(ctx.isDocx).toBe(false);
    expect(state.savedFields).toHaveLength(1);
    expect((state.savedFields[0] as { fields: unknown[] }).fields).toHaveLength(1);
  });

  it("allows onReview to cancel the entire import and trigger rollback", async () => {
    const { deps, state } = harness({}, { pages: 2 });
    deps.onReview = vi.fn().mockResolvedValue("cancelled");

    const result = await runSourceImport(
      input(new AbortController().signal),
      deps,
      { createStableFieldId: stableId }
    );

    expect(result).toMatchObject({
      status: "cancelled",
      rollback: { verified: true, remaining: 0 },
    });
    expect(state.templates.size).toBe(0);
    expect(state.assets.size).toBe(0);
    expect(state.savedPages).toHaveLength(0);
    expect(state.savedFields).toHaveLength(0);
  });

  it("saves empty fields and complete pages when review excludes all suggestions", async () => {
    const { deps, state } = harness({}, { pages: 2 });
    deps.onReview = vi.fn().mockResolvedValue([]);

    const result = await runSourceImport(
      input(new AbortController().signal),
      deps,
      { createStableFieldId: stableId }
    );

    expect(result).toMatchObject({
      status: "created",
      pages: 2,
      suggestions: 0,
    });
    expect(state.savedPages).toHaveLength(1);
    expect(state.savedFields).toHaveLength(1);
    expect((state.savedFields[0] as { fields: unknown[] }).fields).toHaveLength(0);
  });

  it("identifies docx files in review context", async () => {
    const { deps } = harness({}, { pages: 1 });
    let capturedIsDocx = false;
    deps.onReview = async ctx => {
      capturedIsDocx = ctx.isDocx;
      return ctx.suggestedFields;
    };

    const docxInput = {
      ...input(new AbortController().signal),
      files: [new File(["docx"], "form.docx", { type: "" })],
    };

    const result = await runSourceImport(docxInput, deps, {
      createStableFieldId: stableId,
    });

    expect(result.status).toBe("created");
    expect(capturedIsDocx).toBe(true);
  });
});
