import { describe, expect, it } from "vitest";
import {
  computeFinalFields,
  excludeAllCandidatesOnPage,
  initReviewSession,
  isUltraWideCoordinate,
  restoreAllCandidatesOnPage,
  toggleCandidateExcluded,
  togglePageAttachment,
} from "./import-review";
import type { ImportPipelineDraftField } from "./import-pipeline";

import { fusedDraftFields } from "./detection-fusion";

function generateFields(
  pageIndex: number,
  pageNumber: number,
  items: Array<{ id: string; widthPx: number; isTable?: boolean }>
): ImportPipelineDraftField[] {
  const pageGeom = {
    page: pageNumber,
    widthMm: 210,
    heightMm: 297,
    pixelWidth: 800,
    pixelHeight: 1100,
  };

  const candidates = items.map((item) => ({
    fieldType: (item.isTable ? "table" : "text") as any,
    label: item.isTable ? "Table 1" : `Field ${item.id}`,
    confidence: 0.9,
    required: false,
    options: [],
    detectionSource: "test",
    detectionGroup: [],
    optionMarks: [],
    left: 80, // xRatio = 80/800 = 0.1
    top: 110, // yRatio = 110/1100 = 0.1
    width: item.widthPx,
    height: 55, // heightRatio = 55/1100 = 0.05
  }));

  let index = 0;
  return fusedDraftFields(candidates, pageGeom, pageIndex, () => items[index++].id);
}

describe("import-review", () => {
  const samplePages = [
    {
      pageIndex: 0,
      pageNumber: 1,
      assetId: "asset-page-1",
      widthMm: 210,
      heightMm: 297,
    },
    {
      pageIndex: 1,
      pageNumber: 2,
      assetId: "asset-page-2",
      widthMm: 210,
      heightMm: 297,
    },
    {
      pageIndex: 2,
      pageNumber: 3,
      assetId: "asset-page-3",
      widthMm: 210,
      heightMm: 297,
    },
  ];

  const suggestedFields: ImportPipelineDraftField[] = [
    ...generateFields(0, 1, [
      { id: "p1-f1", widthPx: 240 }, // 240/800 = 0.3
      { id: "p1-table", widthPx: 560, isTable: true }, // 560/800 = 0.7
    ]),
    ...generateFields(1, 2, [
      { id: "p2-wide", widthPx: 680 }, // 680/800 = 0.85 Ultra-wide
      { id: "p2-f2", widthPx: 200 }, // 200/800 = 0.25
    ]),
    ...generateFields(2, 3, [
      { id: "p3-attach-f1", widthPx: 240 }, // 240/800 = 0.3
    ]),
  ];

  it("S3-T03: attachment page toggling is reversible and does not affect other pages", () => {
    let session = initReviewSession({
      templateId: "tpl-1",
      versionId: "ver-1",
      templateName: "Reimbursement",
      isDocx: true,
      truncation: "none",
      runDetection: true,
      ocrAvailable: true,
      pages: samplePages,
      suggestedFields,
    });

    expect(session.pages[2].isAttachment).toBe(false);
    expect(session.pages[2].candidates).toHaveLength(1);

    // Toggle Page 3 to attachment
    session = togglePageAttachment(session, 2, true);
    expect(session.pages[2].isAttachment).toBe(true);

    // Final fields should not include Page 3 fields
    let finalFields = computeFinalFields(session);
    expect(finalFields.map(f => f.stableFieldId)).toEqual([
      "p1-f1",
      "p1-table",
      "p2-wide",
      "p2-f2",
    ]);

    // Page 1 and Page 2 candidates are unchanged
    expect(session.pages[0].candidates).toHaveLength(2);
    expect(session.pages[1].candidates).toHaveLength(2);

    // Toggle Page 3 back to general page: candidate is restored!
    session = togglePageAttachment(session, 2, false);
    expect(session.pages[2].isAttachment).toBe(false);
    finalFields = computeFinalFields(session);
    expect(finalFields.map(f => f.stableFieldId)).toEqual([
      "p1-f1",
      "p1-table",
      "p2-wide",
      "p2-f2",
      "p3-attach-f1",
    ]);
  });

  it("S3-T04: individual candidate exclusion and restoration", () => {
    let session = initReviewSession({
      templateId: "tpl-1",
      versionId: "ver-1",
      templateName: "Reimbursement",
      isDocx: false,
      truncation: "none",
      pages: samplePages,
      suggestedFields,
    });

    // Exclude ultra-wide candidate p2-wide on page 1
    session = toggleCandidateExcluded(session, 1, "p2-wide", true);
    expect(session.pages[1].excludedCandidateIds.has("p2-wide")).toBe(true);

    let finalFields = computeFinalFields(session);
    expect(finalFields.find(f => f.stableFieldId === "p2-wide")).toBeUndefined();
    expect(finalFields.find(f => f.stableFieldId === "p2-f2")).toBeDefined();

    // Restore candidate
    session = toggleCandidateExcluded(session, 1, "p2-wide", false);
    expect(session.pages[1].excludedCandidateIds.has("p2-wide")).toBe(false);

    finalFields = computeFinalFields(session);
    expect(finalFields.find(f => f.stableFieldId === "p2-wide")).toBeDefined();
  });

  it("S3-T05: excluding all candidates still preserves pages and produces empty fields", () => {
    let session = initReviewSession({
      templateId: "tpl-1",
      versionId: "ver-1",
      templateName: "Reimbursement",
      isDocx: true,
      truncation: "none",
      runDetection: true,
      ocrAvailable: true,
      pages: samplePages,
      suggestedFields,
    });

    // Exclude all on every page
    session = excludeAllCandidatesOnPage(session, 0);
    session = excludeAllCandidatesOnPage(session, 1);
    session = excludeAllCandidatesOnPage(session, 2);

    const finalFields = computeFinalFields(session);
    expect(finalFields).toEqual([]);

    // Pages still exist
    expect(session.pages).toHaveLength(3);
  });

  it("identifies ultra-wide candidate correctly", () => {
    expect(isUltraWideCoordinate({ widthRatio: 0.85 })).toBe(true);
    expect(isUltraWideCoordinate({ widthRatio: 0.8 })).toBe(false);
    expect(isUltraWideCoordinate({ widthRatio: 0.5 })).toBe(false);
  });

  it("preserves confirmed: false on all output fields", () => {
    const session = initReviewSession({
      templateId: "tpl-1",
      versionId: "ver-1",
      templateName: "Reimbursement",
      isDocx: true,
      truncation: "none",
      runDetection: true,
      ocrAvailable: true,
      pages: samplePages,
      suggestedFields: generateFields(0, 1, [{ id: "f1", widthPx: 400 }]),
    });

    const finalFields = computeFinalFields(session);
    expect(finalFields[0].definition.confirmed).toBe(false);
  });
});
