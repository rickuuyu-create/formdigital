import { describe, expect, it } from "vitest";
import {
  MAX_FUSED_CANDIDATES_PER_PAGE,
  MAX_SUGGESTED_FIELDS_PER_DOCUMENT,
  appendSuggestedFields,
  fuseFormDetections,
  fusedDraftFields,
  localStructureCandidates,
} from "./detection-fusion";
import type { LabelledFormStructure } from "./form-structure";

function candidate(
  overrides: Partial<Parameters<typeof fuseFormDetections>[0][number]> = {}
) {
  return {
    fieldType: "text" as const,
    label: "Name",
    confidence: 0.8,
    required: false,
    options: [],
    detectionSource: "test",
    detectionGroup: [],
    optionMarks: [],
    left: 10,
    top: 10,
    width: 80,
    height: 20,
    ...overrides,
  };
}

const page = {
  page: 1,
  widthMm: 210,
  heightMm: 297,
  pixelWidth: 1_000,
  pixelHeight: 1_414,
};

describe("form detector fusion", () => {
  it("does not treat duplicated merged spans as two independent cells", () => {
    const merged = { xRatio: 0, yRatio: 0, widthRatio: 1, heightRatio: 1 };
    const table = candidate({ fieldType: "table", label: "Merged", left: 100, top: 100, width: 600, height: 100,
      tableColumns: 2, maxRows: 1, confidence: .99, tableCellGuides: [merged, merged] });
    const text = candidate({ label: "Legal merged text", left: 120, top: 120, width: 550, height: 20 });
    expect(fuseFormDetections([table, text], []).candidates.map(c => c.label)).toContain("Legal merged text");
  });
  it("preserves a legitimate wide first cell and rejects text spanning actual cells", () => {
    const table = candidate({ fieldType: "table", label: "Nonuniform", left: 100, top: 100, width: 600, height: 100,
      tableColumns: 2, maxRows: 1, detectionSource: "local-structure:table", confidence: 0.99,
      tableCellGuides: [{ xRatio: 0, yRatio: 0, widthRatio: 2 / 3, heightRatio: 1 },
        { xRatio: 2 / 3, yRatio: 0, widthRatio: 1 / 3, heightRatio: 1 }] });
    const inside = candidate({ label: "Legal", left: 120, top: 120, width: 370, height: 20 });
    const crossing = candidate({ label: "Crossing", left: 120, top: 150, width: 550, height: 20 });
    const result = fuseFormDetections([table, inside, crossing], []);
    expect(result.candidates.map(c => c.label)).toContain("Legal");
    expect(result.candidates.map(c => c.label)).not.toContain("Crossing");
  });
  it("prefers a stronger overlapping candidate and keeps complementary geometry", () => {
    const result = fuseFormDetections(
      [
        candidate({
          confidence: 0.99,
          label: "Native Name",
          left: 12,
          top: 11,
        }),
        candidate({
          fieldType: "checkbox",
          label: "Consent",
          confidence: 0.9,
          left: 20,
          top: 100,
          width: 14,
          height: 14,
        }),
      ],
      [
        candidate({
          confidence: 0.72,
          label: "Geometry Name",
          left: 10,
          top: 10,
        }),
        candidate({
          fieldType: "table",
          label: "Rows",
          confidence: 0.88,
          left: 20,
          top: 140,
          width: 160,
          height: 90,
          maxRows: 3,
          tableColumns: 2,
        }),
      ]
    );

    expect(result.candidates.map(item => item.label)).toEqual([
      "Native Name",
      "Consent",
      "Rows",
    ]);
    expect(result.truncated).toBe(false);
  });

  it("keeps different field kinds even when their boxes overlap", () => {
    const result = fuseFormDetections(
      [candidate({ fieldType: "text", confidence: 0.95 })],
      [
        candidate({
          fieldType: "checkbox",
          confidence: 0.82,
          width: 20,
          height: 20,
        }),
      ]
    );

    expect(result.candidates).toHaveLength(2);
  });

  it("never lets a native select or signature delete a stronger local field of another kind", () => {
    const result = fuseFormDetections(
      [
        candidate({
          fieldType: "select",
          label: "Native Select",
          confidence: 0.99,
          detectionSource: "native-pdf:widget:Ch",
        }),
        candidate({
          fieldType: "signature",
          label: "Native Signature",
          confidence: 0.99,
          top: 200,
          detectionSource: "native-pdf:widget:Sig",
        }),
      ],
      [
        candidate({
          fieldType: "checkbox",
          label: "Local Checkbox",
          confidence: 0.9,
          detectionSource: "local-structure:checkbox",
        }),
        candidate({
          fieldType: "table",
          label: "Local Table",
          confidence: 0.9,
          top: 200,
          detectionSource: "local-structure:table",
        }),
      ]
    );

    expect(result.candidates.map(item => item.label).sort()).toEqual([
      "Local Checkbox",
      "Local Table",
      "Native Select",
      "Native Signature",
    ]);
  });

  it("drops the weaker of two overlapping same-family candidates whichever source wins", () => {
    const nativeWins = fuseFormDetections(
      [
        candidate({
          label: "Native",
          confidence: 0.99,
          detectionSource: "native-pdf:widget:Tx",
        }),
      ],
      [
        candidate({
          fieldType: "date",
          label: "Local",
          confidence: 0.7,
          detectionSource: "local-structure:underline",
        }),
      ]
    );
    expect(nativeWins.candidates.map(item => item.label)).toEqual(["Native"]);

    const localWins = fuseFormDetections(
      [
        candidate({
          label: "Native",
          confidence: 0.4,
          detectionSource: "native-pdf:widget:Tx",
        }),
      ],
      [
        candidate({
          label: "Local",
          confidence: 0.95,
          detectionSource: "local-structure:text-box",
        }),
      ]
    );
    expect(localWins.candidates.map(item => item.label)).toEqual(["Local"]);
  });

  it("orders every source into one reading order with a deterministic tie-break", () => {
    const result = fuseFormDetections(
      [
        candidate({
          label: "Native bottom",
          top: 400,
          detectionSource: "native-pdf:widget:Tx",
        }),
        candidate({
          label: "Native tie",
          top: 100,
          left: 300,
          detectionSource: "native-pdf:widget:Tx",
        }),
      ],
      [
        candidate({
          label: "Local top",
          top: 20,
          left: 500,
          detectionSource: "local-structure:text-box",
        }),
        candidate({
          label: "Local tie",
          top: 100,
          left: 300,
          fieldType: "checkbox",
          width: 14,
          height: 14,
          detectionSource: "local-structure:checkbox",
        }),
      ]
    );

    expect(result.candidates.map(item => item.label)).toEqual([
      "Local top",
      "Local tie",
      "Native tie",
      "Native bottom",
    ]);
  });

  it("de-duplicates before the page ceiling so a unique candidate is never lost", () => {
    const duplicates = Array.from({ length: 500 }, () =>
      candidate({ confidence: 0.99, label: "Duplicate" })
    );
    const result = fuseFormDetections(duplicates, [
      candidate({
        confidence: 0.4,
        label: "Only unique",
        left: 400,
        top: 900,
      }),
    ]);

    expect(result.candidates.map(item => item.label)).toEqual([
      "Duplicate",
      "Only unique",
    ]);
    expect(result.truncated).toBe(false);
  });

  it("reports truncation only when more than the page ceiling survives de-duplication", () => {
    const many = Array.from({ length: MAX_FUSED_CANDIDATES_PER_PAGE + 5 }, (_, index) =>
      candidate({ top: index * 30, confidence: 0.5 })
    );
    const result = fuseFormDetections([], many);

    expect(result.candidates).toHaveLength(MAX_FUSED_CANDIDATES_PER_PAGE);
    expect(result.truncated).toBe(true);
  });

  it("does not report truncation when every candidate is malformed", () => {
    const malformed = Array.from({ length: 501 }, (_, index) =>
      candidate({ top: index * 30, width: Number.NaN })
    );
    const result = fuseFormDetections(malformed, []);

    expect(result.candidates).toHaveLength(0);
    expect(result.truncated).toBe(false);
  });

  it("rejects negative, non-finite, and empty boxes", () => {
    const result = fuseFormDetections(
      [
        candidate({ left: -1 }),
        candidate({ top: -0.5 }),
        candidate({ width: Number.POSITIVE_INFINITY }),
        candidate({ height: Number.NaN }),
        candidate({ width: 0 }),
        candidate({ height: -4 }),
        candidate({ confidence: 0 }),
        candidate({ confidence: 1.4 }),
      ],
      []
    );

    expect(result.candidates).toHaveLength(0);
    expect(result.truncated).toBe(false);
  });

  it("keeps every fused candidate unconfirmed and drops untrusted caller state", () => {
    const [fused] = fuseFormDetections(
      [],
      [
        {
          ...candidate({
            confidence: 0.86,
            detectionSource: "local-structure:text-box",
          }),
          confirmed: true,
          aiSuggested: false,
          status: "confirmed",
        } as never,
      ]
    ).candidates;

    expect(fused).toMatchObject({
      confidence: 0.86,
      detectionSource: "local-structure:text-box",
    });
    expect(fused).not.toHaveProperty("confirmed");
    expect(fused).not.toHaveProperty("aiSuggested");
    expect(fused).not.toHaveProperty("status");

    const [draft] = fusedDraftFields([fused!], page, 0, () => "field-abc");
    expect(draft?.definition.confirmed).toBe(false);
    expect(draft?.definition.aiSuggested).toBe(true);
  });

  it("carries native widget and local geometry from one page into draft fields", () => {
    const structures: LabelledFormStructure[] = [
      {
        kind: "table",
        left: 100,
        top: 600,
        width: 400,
        height: 200,
        confidence: 0.9,
        rows: 3,
        columns: 3,
        writableCells: [{ row: 2, column: 2 }],
        label: "Detected table",
        labelConfidence: 0.5,
      },
      {
        kind: "character-box",
        left: 100,
        top: 900,
        width: 300,
        height: 40,
        confidence: 0.88,
        boxCount: 8,
        segmentCapacities: [2, 2, 4],
        members: Array.from({ length: 8 }, (_, index) => ({
          left: 100 + index * 36,
          top: 900,
          width: 34,
          height: 40,
        })),
        label: "出生日期",
        labelConfidence: 0.6,
      },
    ];
    const fused = fuseFormDetections(
      [
        candidate({
          label: "Native text",
          confidence: 0.99,
          detectionSource: "native-pdf:widget:Tx",
        }),
      ],
      localStructureCandidates(structures)
    );

    expect(fused.candidates.map(item => item.label)).toEqual([
      "Native text",
      "Detected table",
      "出生日期",
    ]);

    let counter = 0;
    const drafts = fusedDraftFields(
      fused.candidates,
      page,
      0,
      () => `field-${(counter += 1)}`
    );
    expect(drafts.map(draft => draft.fieldType)).toEqual([
      "text",
      "table",
      "characterBox",
    ]);
    expect(drafts[1]?.definition.tableWritableCells).toEqual([
      { row: 2, column: 2 },
    ]);
    expect(drafts[1]?.definition.tableColumns).toBe(3);
    expect(drafts[2]?.definition.boxCount).toBe(8);
    expect(drafts[2]?.definition.maxLength).toBe(8);
    expect(drafts[2]?.definition.segmentCapacities).toEqual([2, 2, 4]);
    expect(drafts[2]?.definition.detectionGroup).toHaveLength(8);
    expect(drafts.every(draft => draft.definition.confirmed === false)).toBe(
      true
    );
    expect(drafts.every(draft => draft.definition.aiSuggested === true)).toBe(
      true
    );
  });

  it("keeps detecting on later pages after an early page fills its own ceiling", () => {
    const suggestions: string[] = [];
    const firstPage = fuseFormDetections(
      Array.from({ length: MAX_FUSED_CANDIDATES_PER_PAGE + 10 }, (_, index) =>
        candidate({ top: index * 30, label: `p1-${index}` })
      ),
      []
    );
    expect(firstPage.candidates).toHaveLength(MAX_FUSED_CANDIDATES_PER_PAGE);
    appendSuggestedFields(
      suggestions,
      firstPage.candidates.map(item => item.label)
    );

    const secondPage = fuseFormDetections(
      [candidate({ label: "p2-only", top: 42 })],
      []
    );
    expect(secondPage.candidates).toHaveLength(1);
    const truncated = appendSuggestedFields(
      suggestions,
      secondPage.candidates.map(item => item.label)
    );

    expect(truncated).toBe(false);
    expect(suggestions).toHaveLength(MAX_FUSED_CANDIDATES_PER_PAGE + 1);
    expect(suggestions.at(-1)).toBe("p2-only");
  });

  it("reports the document ceiling instead of silently dropping later pages", () => {
    const suggestions = Array.from(
      { length: MAX_SUGGESTED_FIELDS_PER_DOCUMENT - 1 },
      (_, index) => `existing-${index}`
    );

    expect(appendSuggestedFields(suggestions, ["a", "b", "c"])).toBe(true);
    expect(suggestions).toHaveLength(MAX_SUGGESTED_FIELDS_PER_DOCUMENT);
    expect(suggestions.at(-1)).toBe("a");
    expect(MAX_SUGGESTED_FIELDS_PER_DOCUMENT).toBeGreaterThan(
      MAX_FUSED_CANDIDATES_PER_PAGE
    );
  });

  it("refuses to place fields when the page geometry is unusable", () => {
    expect(
      fusedDraftFields([candidate() as never], { ...page, pixelWidth: 0 }, 0)
    ).toEqual([]);
    expect(
      fusedDraftFields(
        [candidate() as never],
        { ...page, widthMm: Number.NaN },
        0
      )
    ).toEqual([]);
  });
  it("merges a native widget with the untyped geometry traced over it", () => {
    const result = fuseFormDetections(
      [
        candidate({
          fieldType: "select",
          label: "Department",
          confidence: 0.99,
          detectionSource: "native-pdf:widget:Ch",
        }),
      ],
      [
        candidate({
          fieldType: "text",
          label: "Department",
          confidence: 0.9,
          detectionSource: "local-structure:text-box",
        }),
      ]
    );

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      fieldType: "select",
      detectionSource: "native-pdf:widget:Ch",
    });
  });

  it("keeps a traced checkbox next to an unrelated native widget", () => {
    const result = fuseFormDetections(
      [
        candidate({
          fieldType: "signature",
          label: "Signature",
          confidence: 0.99,
          detectionSource: "native-pdf:widget:Sig",
        }),
      ],
      [
        candidate({
          fieldType: "checkbox",
          label: "Agree",
          confidence: 0.9,
          detectionSource: "local-structure:checkbox",
        }),
      ]
    );

    expect(result.candidates).toHaveLength(2);
  });

  it("S3-T01 (fusion): suppresses text candidates crossing multiple columns of an accepted table while keeping independent text", () => {
    const tableCand = candidate({
      fieldType: "table",
      label: "Main Table",
      confidence: 0.95,
      left: 100,
      top: 200,
      width: 600,
      height: 300,
      tableColumns: 6, // 100px per column
      maxRows: 5,
      tableCellGuides: Array.from({ length: 30 }, (_, i) => ({ xRatio: (i % 6) / 6, yRatio: Math.floor(i / 6) / 5, widthRatio: 1 / 6, heightRatio: 1 / 5 })),
    });

    // Erroneous text crossing cols 0, 1, 2 of the table (width 250 > 100 * 1.2)
    const crossingText = candidate({
      fieldType: "text",
      label: "Cross Cell Text",
      confidence: 0.8,
      left: 120,
      top: 220,
      width: 250,
      height: 25,
      detectionSource: "local-structure:text-box",
    });

    // Valid independent text outside the table
    const outsideText = candidate({
      fieldType: "text",
      label: "Applicant",
      confidence: 0.85,
      left: 100,
      top: 50,
      width: 300,
      height: 25,
      detectionSource: "local-structure:text-box",
    });

    const result = fuseFormDetections([tableCand], [crossingText, outsideText]);

    // Table and outside text should survive, while crossingText should be suppressed
    expect(result.candidates.map(c => c.label)).toEqual(
      expect.arrayContaining(["Main Table", "Applicant"])
    );
    expect(result.candidates.find(c => c.label === "Cross Cell Text")).toBeUndefined();
  });
});
