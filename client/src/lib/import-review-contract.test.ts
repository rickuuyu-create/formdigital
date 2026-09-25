import { describe, expect, it } from "vitest";
import { initReviewSession, computeFinalFields, togglePageAttachment } from "./import-review";

const make = () => ({ templateId: "t", versionId: "v", templateName: "Test", isDocx: false, truncation: "none" as const,
  pages: [{ pageIndex: 0, pageNumber: 1, assetId: "a", widthMm: 200, heightMm: 300 }],
  suggestedFields: [{ stableFieldId: "f", fieldType: "text", displayOrder: 0, definition: { label: "Name" },
    coordinate: { page: 1, xMm: 20, yMm: 30, widthMm: 100, heightMm: 20 } }] });

describe("review formal coordinate contract", () => {
  it("never persists derived ratios", () => {
    const input = make();
    expect(computeFinalFields(initReviewSession(input))[0].coordinate).toEqual(input.suggestedFields[0].coordinate);
  });
  it("uses each page's physical dimensions and excludes only the selected page", () => {
    const input = make();
    input.pages = [1, 2, 3].map(n => ({ pageIndex: n - 1, pageNumber: n, assetId: `a${n}`, widthMm: 200 * n, heightMm: 300 * n }));
    input.suggestedFields = input.pages.map(p => ({ ...make().suggestedFields[0], stableFieldId: `f${p.pageNumber}`, coordinate: { ...make().suggestedFields[0].coordinate, page: p.pageNumber } }));
    const session = initReviewSession(input);
    expect(session.pages.map(p => p.candidates[0].leftRatio)).toEqual([.1, .05, 20/600]);
    expect(computeFinalFields(togglePageAttachment(session, 1, true)).map(f => f.coordinate.page)).toEqual([1, 3]);
    expect(computeFinalFields(togglePageAttachment(togglePageAttachment(session, 1, true), 1, false)).map(f => f.coordinate)).toEqual(input.suggestedFields.map(f => f.coordinate));
  });
  it("rejects a missing coordinate member rather than silently omitting the candidate", () => {
    const input = make();
    delete (input.suggestedFields[0].coordinate as Partial<typeof input.suggestedFields[0]["coordinate"]>).heightMm;
    expect(() => initReviewSession(input)).toThrow("IMPORT_REVIEW_INVALID_GEOMETRY");
  });
  it.each([{ page: 4 }, { page: NaN }, { xMm: -1 }, { xMm: Infinity }, { widthMm: 0 }, { widthMm: 181 }, { heightMm: 271 }])("rejects invalid coordinates without leaking values: %j", patch => {
    const input = make(); Object.assign(input.suggestedFields[0].coordinate, patch);
    expect(() => initReviewSession(input)).toThrow("IMPORT_REVIEW_INVALID_GEOMETRY");
  });
  it.each(["duplicate", "zero", "infinite", "missing"])("rejects %s manifest", kind => {
    const input = make();
    if (kind === "duplicate") input.pages.push({ ...input.pages[0] });
    if (kind === "zero") input.pages[0].widthMm = 0;
    if (kind === "infinite") input.pages[0].heightMm = Infinity;
    if (kind === "missing") input.pages = [];
    expect(() => initReviewSession(input)).toThrow("IMPORT_REVIEW_INVALID_GEOMETRY");
  });
});
