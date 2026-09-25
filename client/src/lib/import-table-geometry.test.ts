import { describe, expect, it } from "vitest";
import { validImportCellGuides } from "./import-table-geometry";
import { localStructureCandidates, fuseFormDetections, fusedDraftFields } from "./detection-fusion";

describe("import cell geometry", () => {
  const guides = [{ xRatio: 0, yRatio: 0, widthRatio: .7, heightRatio: 1 }, { xRatio: .7, yRatio: 0, widthRatio: .3, heightRatio: 1 }];
  it.each([undefined, [], [{ ...guides[0], widthRatio: Infinity }], [{ ...guides[0], xRatio: -1 }, guides[1]], [{ ...guides[0], widthRatio: 2 }, guides[1]]])("rejects malformed guides %j", value => {
    expect(validImportCellGuides(value, 1, 2)).toBeUndefined();
  });
  it("keeps line members separate from actual cell rectangles through the formal draft path", () => {
    const local = localStructureCandidates([{ kind: "table", label: "Grid", labelConfidence: .9, confidence: .9,
      left: 100, top: 100, width: 600, height: 100, rows: 1, columns: 2, cellGuides: guides,
      members: [{ left: 100, top: 100, width: 600, height: 1 }] }]);
    const fused = fuseFormDetections(local, []).candidates;
    const draft = fusedDraftFields(fused, { page: 1, widthMm: 210, heightMm: 297, pixelWidth: 1000, pixelHeight: 1414 }, 0)[0];
    expect(draft.definition.tableCellGuides).toEqual(guides);
    expect(draft.definition.detectionGroup).not.toEqual(guides);
  });
});
