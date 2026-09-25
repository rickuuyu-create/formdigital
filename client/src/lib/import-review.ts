/**
 * Import Review Domain Model and State Reducer (S3-02, S3-04)
 *
 * Manages in-memory human review during the import session:
 * - Attachment page exclusion (reversible client-side filter, keeps page & asset)
 * - Per-candidate retention / exclusion / restoration
 * - Ultra-wide candidate detection (> 80% width)
 * - Safe computation of final fields without modifying draft schema or persistence
 */

import type { ImportPipelineDraftField } from "./import-pipeline";

export type ReviewCandidate = {
  stableFieldId: string;
  fieldType: string;
  displayOrder: number;
  definition: Record<string, unknown>;
  coordinate: Record<string, unknown>;
  label: string;
  confidence: number;
  detectionSource: string;
  leftRatio: number;
  topRatio: number;
  widthRatio: number;
  heightRatio: number;
  isUltraWide: boolean;
  isTable: boolean;
};

export type ReviewPageState = {
  pageIndex: number;
  pageNumber: number;
  assetId: string;
  widthMm: number;
  heightMm: number;
  pixelWidth: number;
  pixelHeight: number;
  isAttachment: boolean;
  candidates: ReviewCandidate[];
  excludedCandidateIds: Set<string>;
  tablesCount: number;
  textCount: number;
  needsCheckCount: number;
};

export type ReviewSessionState = {
  templateId: string;
  versionId: string;
  templateName: string;
  isDocx: boolean;
  truncation: "document" | "page" | "none";
  pages: ReviewPageState[];
  activePageIndex: number;
  activeFilter: "all" | "table" | "text" | "needsCheck";
};

export function isUltraWideCoordinate(coordinate: Record<string, unknown>): boolean {
  if (typeof coordinate.widthRatio === "number" && coordinate.widthRatio > 0.8) {
    return true;
  }
  return false;
}

export function initReviewSession(params: {
  templateId: string;
  versionId: string;
  templateName: string;
  isDocx: boolean;
  truncation: "document" | "page" | "none";
  pages: Array<{
    pageIndex: number;
    pageNumber: number;
    assetId: string;
    widthMm: number;
    heightMm: number;
    pixelWidth?: number;
    pixelHeight?: number;
  }>;
  suggestedFields: ImportPipelineDraftField[];
}): ReviewSessionState {
  const invalid = () => { throw new Error("IMPORT_REVIEW_INVALID_GEOMETRY"); };
  const pageNumbers = new Set<number>();
  if (!params.pages.length) invalid();
  for (const p of params.pages) {
    if (!Number.isInteger(p.pageNumber) || p.pageNumber <= 0 || pageNumbers.has(p.pageNumber) ||
        !Number.isFinite(p.widthMm) || !Number.isFinite(p.heightMm) || p.widthMm <= 0 || p.heightMm <= 0) invalid();
    pageNumbers.add(p.pageNumber);
  }
  const fieldIds = new Set<string>();
  const fieldsByPageNumber = new Map<number, ImportPipelineDraftField[]>();
  for (const field of params.suggestedFields) {
    const pageNum =
      typeof field.coordinate?.page === "number"
        ? field.coordinate.page
        : undefined;
    if (pageNum === undefined || !pageNumbers.has(pageNum) || !field.stableFieldId || fieldIds.has(field.stableFieldId)) invalid();
    fieldIds.add(field.stableFieldId);
    const list = fieldsByPageNumber.get(pageNum!) ?? [];
    list.push(field);
    fieldsByPageNumber.set(pageNum!, list);
  }

  const reviewPages: ReviewPageState[] = params.pages.map((p, pageIndex) => {
    const rawFields = fieldsByPageNumber.get(p.pageNumber) ?? [];
    const candidates: ReviewCandidate[] = [];

    for (let idx = 0; idx < rawFields.length; idx++) {
      const field = rawFields[idx];
      const coord = field.coordinate || {};

      // Calculate ratios using mm boundaries and the current page's physical size
      const xMm = typeof coord.xMm === "number" ? coord.xMm : undefined;
      const yMm = typeof coord.yMm === "number" ? coord.yMm : undefined;
      const widthMm = typeof coord.widthMm === "number" ? coord.widthMm : undefined;
      const heightMm = typeof coord.heightMm === "number" ? coord.heightMm : undefined;

      if (xMm === undefined || yMm === undefined || widthMm === undefined || heightMm === undefined ||
          ![xMm, yMm, widthMm, heightMm].every(Number.isFinite) || xMm < 0 || yMm < 0 || widthMm <= 0 || heightMm <= 0 ||
          xMm + widthMm > p.widthMm + 1e-9 || yMm + heightMm > p.heightMm + 1e-9) invalid();

      // Safe coordinate mapping
      const leftRatio = xMm! / p.widthMm;
      const topRatio = yMm! / p.heightMm;
      const wRatio = widthMm! / p.widthMm;
      const hRatio = heightMm! / p.heightMm;

      if (!Number.isFinite(leftRatio) || !Number.isFinite(topRatio) || !Number.isFinite(wRatio) || !Number.isFinite(hRatio)) {
        invalid();
      }

      // Compute UltraWide
      const isUltraWide = wRatio > 0.8;
      const isTable = field.fieldType === "table";
      const label =
        typeof field.definition?.label === "string" && field.definition.label.trim()
          ? field.definition.label.trim()
          : "";

      // Use definition.aiConfidence for formal contract
      const confidence =
        typeof field.definition?.aiConfidence === "number"
          ? field.definition.aiConfidence
          : 0.8;

      const detectionSource =
        typeof field.definition?.detectionSource === "string"
          ? field.definition.detectionSource
          : "local-structure";

      candidates.push({
        stableFieldId: field.stableFieldId,
        fieldType: field.fieldType,
        displayOrder: field.displayOrder ?? idx,
        definition: field.definition,
        coordinate: { ...coord },
        leftRatio,
        topRatio,
        label,
        confidence,
        detectionSource,
        widthRatio: wRatio,
        heightRatio: hRatio,
        isUltraWide,
        isTable,
      });
    }

    const tablesCount = candidates.filter(c => c.isTable).length;
    const textCount = candidates.filter(c => !c.isTable).length;
    const needsCheckCount = candidates.filter(c => c.isUltraWide).length;

    return {
      pageIndex,
      pageNumber: p.pageNumber,
      assetId: p.assetId,
      widthMm: p.widthMm,
      heightMm: p.heightMm,
      pixelWidth: p.pixelWidth ?? Math.round(p.widthMm * (96 / 25.4)),
      pixelHeight: p.pixelHeight ?? Math.round(p.heightMm * (96 / 25.4)),
      isAttachment: false,
      candidates,
      excludedCandidateIds: new Set<string>(),
      tablesCount,
      textCount,
      needsCheckCount,
    };
  });

  return {
    templateId: params.templateId,
    versionId: params.versionId,
    templateName: params.templateName,
    isDocx: params.isDocx,
    truncation: params.truncation,
    pages: reviewPages,
    activePageIndex: 0,
    activeFilter: "all",
  };
}

/**
 * Toggle whether a page is an attachment.
 * Reversible: toggling to false restores all candidates with their previous exclusion choices.
 */
export function togglePageAttachment(
  session: ReviewSessionState,
  pageIndex: number,
  isAttachment: boolean
): ReviewSessionState {
  if (pageIndex < 0 || pageIndex >= session.pages.length) return session;

  const newPages = session.pages.map((p, idx) => {
    if (idx !== pageIndex) return p;
    return {
      ...p,
      isAttachment,
    };
  });

  return {
    ...session,
    pages: newPages,
  };
}

/**
 * Toggle whether a specific candidate on a page is excluded.
 */
export function toggleCandidateExcluded(
  session: ReviewSessionState,
  pageIndex: number,
  candidateId: string,
  excluded: boolean
): ReviewSessionState {
  if (pageIndex < 0 || pageIndex >= session.pages.length) return session;

  const newPages = session.pages.map((p, idx) => {
    if (idx !== pageIndex) return p;
    const newExcluded = new Set(p.excludedCandidateIds);
    if (excluded) {
      newExcluded.add(candidateId);
    } else {
      newExcluded.delete(candidateId);
    }
    return {
      ...p,
      excludedCandidateIds: newExcluded,
    };
  });

  return {
    ...session,
    pages: newPages,
  };
}

/**
 * Exclude all candidates on the specified page.
 */
export function excludeAllCandidatesOnPage(
  session: ReviewSessionState,
  pageIndex: number
): ReviewSessionState {
  if (pageIndex < 0 || pageIndex >= session.pages.length) return session;

  const newPages = session.pages.map((p, idx) => {
    if (idx !== pageIndex) return p;
    const newExcluded = new Set<string>();
    for (const c of p.candidates) {
      newExcluded.add(c.stableFieldId);
    }
    return {
      ...p,
      excludedCandidateIds: newExcluded,
    };
  });

  return {
    ...session,
    pages: newPages,
  };
}

/**
 * Restore all candidates on the specified page.
 */
export function restoreAllCandidatesOnPage(
  session: ReviewSessionState,
  pageIndex: number
): ReviewSessionState {
  if (pageIndex < 0 || pageIndex >= session.pages.length) return session;

  const newPages = session.pages.map((p, idx) => {
    if (idx !== pageIndex) return p;
    return {
      ...p,
      excludedCandidateIds: new Set<string>(),
    };
  });

  return {
    ...session,
    pages: newPages,
  };
}

/**
 * Compute the final list of fields to save.
 * Excludes candidates from pages marked as attachment and individual excluded candidates.
 * Preserves confirmed: false status.
 */
export function computeFinalFields(
  session: ReviewSessionState
): ImportPipelineDraftField[] {
  const result: ImportPipelineDraftField[] = [];
  let displayOrder = 0;

  for (const page of session.pages) {
    if (page.isAttachment) continue;
    for (const candidate of page.candidates) {
      if (page.excludedCandidateIds.has(candidate.stableFieldId)) continue;
      result.push({
        stableFieldId: candidate.stableFieldId,
        fieldType: candidate.fieldType,
        displayOrder: displayOrder++,
        definition: {
          ...candidate.definition,
          confirmed: false, // Must remain unconfirmed suggestions
        },
        coordinate: candidate.coordinate,
      });
    }
  }

  return result;
}
