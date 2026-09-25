import {
  MAX_SUGGESTED_FIELDS_PER_DOCUMENT,
  appendSuggestedFields,
  fuseFormDetections,
  fusedDraftFields,
  localStructureCandidates,
} from "./detection-fusion";
import type { RasterPage, RawAssetUpload } from "./document-files";
import {
  labelFormStructures,
  type FormStructure,
  type PositionedWord,
} from "./form-structure";
import {
  ImportAssetTypeMismatchError,
  ImportCancelledError,
  isImportAssetTypeMismatchError,
  isImportCancelledError,
  throwIfImportCancelled,
} from "./import-runtime";
import {
  rollbackImport,
  type ImportRollbackDeps,
  type ImportRollbackResult,
} from "./import-rollback";
import {
  labelBlankCandidates,
  ocrWordCandidates,
  type TableBoundary,
} from "./label-fields";

export type ImportReviewPageEntry = {
  pageIndex: number;
  pageNumber: number;
  assetId: string;
  widthMm: number;
  heightMm: number;
  pixelWidth?: number;
  pixelHeight?: number;
};

export type ImportReviewContext = {
  templateId: string;
  versionId: string;
  templateName: string;
  isDocx: boolean;
  truncation: "document" | "page" | "none";
  runDetection: boolean;
  ocrAvailable: boolean;
  pages: ImportReviewPageEntry[];
  suggestedFields: ImportPipelineDraftField[];
  signal: AbortSignal;
};
import {
  nativePdfFieldCandidatePlan,
  nativePdfTextPlan,
} from "./native-pdf-import";
import { vectorFormStructures } from "./vector-structure";
import { awaitImportReview } from "./import-review-lifecycle";

export type ImportPageManifestEntry = {
  page: number;
  widthMm: number;
  heightMm: number;
  rotation: number;
  assetId: string;
  mimeType: string;
  originalAssetIds: string[];
};

export type ImportPipelineDraftField = {
  stableFieldId: string;
  fieldType: string;
  displayOrder: number;
  definition: Record<string, unknown>;
  coordinate: Record<string, unknown>;
};

export type ImportPipelineInput = {
  files: File[];
  name: string;
  runDetection: boolean;
  preprocessing: {
    rotation: number;
    contrast: number;
    grayscale: boolean;
    autoCrop: boolean;
  };
  signal: AbortSignal;
};

export type ImportPipelineDeps = {
  createDraft: (name: string) => Promise<{
    templateId: string;
    versionId: string;
  }>;
  uploadAsset: (
    upload: RawAssetUpload,
    signal: AbortSignal
  ) => Promise<{ assetId: string; mimeType?: string }>;
  pageBatches: (options: {
    rotation: number;
    contrast: number;
    grayscale: boolean;
    autoCrop: boolean;
    captureNativePdf: boolean;
    signal: AbortSignal;
    batchSize: number;
    onTotalPages: (total: number) => void;
  }) => AsyncGenerator<RasterPage[]>;
  detectStructures: (
    blob: Blob,
    signal: AbortSignal
  ) => Promise<
    FormStructure[] | { structures: FormStructure[]; truncated: boolean }
  >;
  recognizeWords: (
    page: RasterPage,
    pageIndex: number,
    label: string,
    signal: AbortSignal
  ) => Promise<
    PositionedWord[] | { words: PositionedWord[]; truncated: boolean }
  >;
  savePages: (input: {
    versionId: string;
    pageManifest: ImportPageManifestEntry[];
  }) => Promise<unknown>;
  saveFields: (input: {
    versionId: string;
    fields: ImportPipelineDraftField[];
  }) => Promise<unknown>;
  rollbackDeps: ImportRollbackDeps;
  onProgress: (message: string) => void;
  onOcrUnavailable?: (pageNumber: number) => void;
  ocrAvailable: boolean;
  onReview?: (
    ctx: ImportReviewContext
  ) => Promise<
    | ImportPipelineDraftField[]
    | "cancelled"
    | { cancelled?: boolean; fields?: ImportPipelineDraftField[] }
    | void
  >;
};

export type ImportPipelineResult =
  | {
      status: "created";
      versionId: string;
      pages: number;
      suggestions: number;
      truncation: "none" | "page" | "document";
    }
  | {
      status: "cancelled";
      rollback: ImportRollbackResult;
    }
  | {
      status: "failed";
      rollback: ImportRollbackResult;
    }
  | {
      status: "service-outdated";
      rollback: ImportRollbackResult;
    };

const DOCX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** A .docx picked from disk sometimes arrives with an empty type. */
function sourceMimeType(file: File) {
  if (file.type) return file.type;
  const filename = file.name.toLowerCase();
  if (filename.endsWith(".pdf")) return "application/pdf";
  if (filename.endsWith(".docx")) return DOCX_MIME_TYPE;
  return "application/octet-stream";
}

function isDocxSource(files: File[]) {
  return files.some(
    file =>
      file.type === DOCX_MIME_TYPE ||
      file.name.toLowerCase().endsWith(".docx")
  );
}

/**
 * The Local Data Service must store an asset under the type it was given. A
 * service process older than this client silently keeps its own default, which
 * would save a page bitmap nobody can display.
 */
function assertStoredType(stored: string | undefined, requested: string) {
  if (stored && stored !== requested) throw new ImportAssetTypeMismatchError();
}

/**
 * Build a Template Draft from one source document, page by page.
 *
 * Every step re-checks cancellation before it writes anything, so a person who
 * cancels during upload, recognition, or the final save never ends up with a
 * half-built Draft or a success message. Whatever the run did create is rolled
 * back and the rollback result is reported rather than assumed.
 */
export async function runSourceImport(
  input: ImportPipelineInput,
  deps: ImportPipelineDeps,
  options: {
    ocrThreshold?: number;
    createStableFieldId?: () => string;
    fieldTypeFor?: (label: string) => string;
  } = {}
): Promise<ImportPipelineResult> {
  const createStableFieldId =
    options.createStableFieldId ??
    (() => `field-${crypto.randomUUID().slice(0, 8)}`);
  const threshold = options.ocrThreshold ?? 65;
  let created: { templateId: string; versionId: string } | null = null;
  const createdAssetIds: string[] = [];
  let totalPages = 0;
  let ocrAttempts = 0;
  let ocrSuccesses = 0;
  let knownPageCount: number | null = null;
  const pageLabel = (index: number) =>
    knownPageCount === null
      ? `已處理 ${index + 1} 頁`
      : `第 ${index + 1}/${knownPageCount} 頁`;

  try {
    deps.onProgress("建立本機 Draft…");
    throwIfImportCancelled(input.signal);
    created = await deps.createDraft(input.name);

    deps.onProgress("保存不可破壞的原始來源…");
    const originalAssetIds: string[] = [];
    for (const file of input.files) {
      throwIfImportCancelled(input.signal);
      const source = await deps.uploadAsset(
        {
          blob: file,
          filename: file.name,
          kind: "source",
          mimeType: sourceMimeType(file),
          purpose: "original-source",
          templateId: created.templateId,
          versionId: created.versionId,
        },
        input.signal
      );
      // Record before every other check: an upload that lands during a cancel
      // or a rejected type still has to be rolled back.
      originalAssetIds.push(source.assetId);
      createdAssetIds.push(source.assetId);
      assertStoredType(source.mimeType, sourceMimeType(file));
      throwIfImportCancelled(input.signal);
    }

    deps.onProgress("轉換並預處理頁面…");
    const pageManifest: ImportPageManifestEntry[] = [];
    const reviewPages: ImportReviewPageEntry[] = [];
    const suggestedFields: ImportPipelineDraftField[] = [];
    let pageTruncated = false;
    let documentTruncated = false;

    for await (const batch of deps.pageBatches({
      ...input.preprocessing,
      captureNativePdf: input.runDetection,
      signal: input.signal,
      batchSize: 1,
      onTotalPages: total => {
        knownPageCount = total;
      },
    })) {
      for (const page of batch) {
        throwIfImportCancelled(input.signal);
        const index = totalPages;
        totalPages += 1;
        const pageNumber = index + 1;
        deps.onProgress(`保存${pageLabel(index)}…`);
        const pageAsset = await deps.uploadAsset(
          {
            blob: page.blob,
            filename: `${input.name}-page-${pageNumber}.png`,
            kind: "page",
            mimeType: "image/png",
            purpose: "template-page",
            templateId: created.templateId,
            versionId: created.versionId,
            originalAssetIds,
            preprocessing: page.appliedPreprocessing ?? input.preprocessing,
          },
          input.signal
        );
        createdAssetIds.push(pageAsset.assetId);
        assertStoredType(pageAsset.mimeType, "image/png");
        throwIfImportCancelled(input.signal);
        pageManifest.push({
          page: pageNumber,
          widthMm: page.widthMm,
          heightMm: page.heightMm,
          rotation: 0,
          assetId: pageAsset.assetId,
          mimeType: "image/png",
          originalAssetIds,
        });
        reviewPages.push({
          pageIndex: index,
          pageNumber,
          assetId: pageAsset.assetId,
          widthMm: page.widthMm,
          heightMm: page.heightMm,
          pixelWidth: page.pixelWidth,
          pixelHeight: page.pixelHeight,
        });

        if (!input.runDetection) continue;
        pageTruncated = page.sourceDetectionTruncated === true || pageTruncated;
        // The document ceiling bounds the suggestion list only: later pages are
        // still rasterised and saved, and the partial state is reported.
        if (suggestedFields.length >= MAX_SUGGESTED_FIELDS_PER_DOCUMENT) {
          documentTruncated = true;
          continue;
        }

        deps.onProgress(`免費自動識別：${pageLabel(index)}…`);
        let structures: FormStructure[] = [];
        try {
          const detected = await deps.detectStructures(page.blob, input.signal);
          if (Array.isArray(detected)) structures = detected;
          else {
            structures = detected.structures;
            pageTruncated = detected.truncated || pageTruncated;
          }
        } catch (error) {
          if (isImportCancelledError(error)) throw error;
          // OCR-only suggestions stay available if the geometry pass fails.
        }
        throwIfImportCancelled(input.signal);

        const nativeText = nativePdfTextPlan(
          page.nativePdf,
          page.pixelWidth,
          page.pixelHeight
        );
        let words = nativeText.words;
        if (!nativeText.usableInsteadOfOcr) {
          ocrAttempts++;
          try {
            const recognized = await deps.recognizeWords(
              page,
              index,
              pageLabel(index),
              input.signal
            );
            ocrSuccesses++;
            if (Array.isArray(recognized)) words = recognized;
            else {
              words = recognized.words;
              pageTruncated = recognized.truncated || pageTruncated;
            }
          } catch (error) {
            if (isImportCancelledError(error)) throw error;
            deps.onOcrUnavailable?.(pageNumber);
          }
        }
        throwIfImportCancelled(input.signal);

        const nativePlan = nativePdfFieldCandidatePlan(
          page.nativePdf,
          page.pixelWidth,
          page.pixelHeight,
          words
        );
        pageTruncated = nativePlan.truncated || pageTruncated;
        // Three complementary local sources feed one fusion pass:
        //  - traced pixel geometry (works on scans and images)
        //  - the page's own vector rules (exact on a vector PDF)
        //  - "label：" runs in the text layer (office exports carry no widgets)
        const vectorStructures = vectorFormStructures(
          page.vectorRules ?? [],
          page.pixelWidth,
          page.pixelHeight
        );
        const labelled = labelFormStructures(
          [...structures, ...vectorStructures],
          words
        ).filter(
          structure =>
            structure.kind !== "radio" || (structure.options?.length ?? 0) >= 2
        );
        const pageTables: TableBoundary[] = [
          ...structures.filter(s => s.kind === "table"),
          ...vectorStructures.filter(s => s.kind === "table"),
        ].map(s => ({
          left: s.left,
          top: s.top,
          width: s.width,
          height: s.height,
          columns: s.columns,
          rows: s.rows,
          writableCells: s.writableCells,
          cellGuides: s.cellGuides,
        }));
        const textBlanks = labelBlankCandidates(
          words,
          page.pixelWidth,
          page.pixelHeight,
          { tables: pageTables }
        );
        // These helpers have bounded source-reading limits. Reaching one is
        // conservatively reported so the UI never claims a complete page after
        // a source may have been clipped before the final fusion pass.
        pageTruncated = textBlanks.length >= 300 || pageTruncated;
        // A page with no geometry at all is a scan the tracer cannot read.
        // Only then do recognised words become last-resort blanks, and they go
        // through the same fusion so anything stronger still wins.
        // Judge on what survived labelling and filtering, not on raw counts: a
        // structure that was dropped as unusable is not usable geometry.
        const hasGeometry =
          labelled.length > 0 || nativePlan.candidates.length > 0;
        const fallback = hasGeometry
          ? []
          : ocrWordCandidates(
              words,
              page.pixelWidth,
              page.pixelHeight,
              threshold
            );
        pageTruncated = fallback.length >= 80 || pageTruncated;
        const fused = fuseFormDetections(
          nativePlan.candidates,
          localStructureCandidates([...labelled, ...textBlanks, ...fallback])
        );
        pageTruncated = fused.truncated || pageTruncated;
        const drafts = fusedDraftFields(
          fused.candidates,
          { ...page, page: pageNumber },
          index,
          createStableFieldId
        ) as ImportPipelineDraftField[];
        documentTruncated =
          appendSuggestedFields(suggestedFields, drafts) || documentTruncated;
      }
    }

    throwIfImportCancelled(input.signal);

    let finalFields: ImportPipelineDraftField[] = suggestedFields;
    let hadReview = false;
    if (deps.onReview) {
      hadReview = true;
      deps.onProgress("等待覆核建議…");
      const reviewResult = await awaitImportReview(input.signal, () => deps.onReview!({
        templateId: created!.templateId,
        versionId: created!.versionId,
        templateName: input.name,
        isDocx: isDocxSource(input.files),
        runDetection: input.runDetection,
        ocrAvailable: ocrAttempts > 0 ? ocrSuccesses > 0 : deps.ocrAvailable,
        truncation: documentTruncated
          ? "document"
          : pageTruncated
            ? "page"
            : "none",
        pages: reviewPages,
        suggestedFields,
        signal: input.signal,
      }));
      throwIfImportCancelled(input.signal);
      if (
        reviewResult === "cancelled" ||
        (reviewResult &&
          typeof reviewResult === "object" &&
          "cancelled" in reviewResult &&
          reviewResult.cancelled)
      ) {
        throw new ImportCancelledError();
      }
      if (Array.isArray(reviewResult)) {
        finalFields = reviewResult;
      } else if (
        reviewResult &&
        typeof reviewResult === "object" &&
        "fields" in reviewResult &&
        Array.isArray(reviewResult.fields)
      ) {
        finalFields = reviewResult.fields;
      }
    }

    throwIfImportCancelled(input.signal);
    await deps.savePages({ versionId: created.versionId, pageManifest });
    throwIfImportCancelled(input.signal);
    if (finalFields.length || hadReview) {
      await deps.saveFields({
        versionId: created.versionId,
        fields: finalFields.map((field, displayOrder) => ({
          ...field,
          displayOrder,
        })),
      });
    }
    // Nothing after this point may run for a cancelled import.
    throwIfImportCancelled(input.signal);

    return {
      status: "created",
      versionId: created.versionId,
      pages: totalPages,
      suggestions: finalFields.length,
      truncation: documentTruncated
        ? "document"
        : pageTruncated
          ? "page"
          : "none",
    };
  } catch (error) {
    const rollback = created
      ? await rollbackImport(
          [
            { kind: "template", id: created.templateId },
            ...createdAssetIds.map(id => ({ kind: "asset" as const, id })),
          ],
          deps.rollbackDeps
        )
      : { verified: true, remaining: 0 };
    return {
      status: isImportAssetTypeMismatchError(error)
        ? "service-outdated"
        : isImportCancelledError(error)
          ? "cancelled"
          : "failed",
      rollback,
    };
  }
}
