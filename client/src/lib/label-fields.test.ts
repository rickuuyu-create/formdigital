import { describe, expect, it } from "vitest";
import type { PositionedWord } from "./form-structure";
import { labelBlankCandidates, ocrWordCandidates } from "./label-fields";

const PAGE_WIDTH = 1_190;
const PAGE_HEIGHT = 1_684;

function word(
  text: string,
  left: number,
  top: number,
  width: number,
  height = 20,
  confidence = 99
): PositionedWord {
  return { text, left, top, width, height, confidence };
}

describe("text-layer label blanks", () => {
  it("opens a blank after a label and stops at the next word on the line", () => {
    const [first, second] = labelBlankCandidates(
      [
        word("學生組織名稱：", 120, 300, 160),
        word("莊名：", 120, 340, 80),
        word("（英文）", 700, 340, 90),
      ],
      PAGE_WIDTH,
      PAGE_HEIGHT
    );

    expect(first).toMatchObject({ label: "學生組織名稱", left: 280 });
    // The first blank runs to the right margin because nothing follows it.
    expect(first!.width).toBeGreaterThan(800);
    // The second stops where the next word starts.
    expect(second).toMatchObject({ label: "莊名", left: 200 });
    expect(second!.left + second!.width).toBeCloseTo(700, 5);
  });

  it("treats a run of underscores as the blank itself", () => {
    const [candidate] = labelBlankCandidates(
      [word("日期________________", 120, 300, 400)],
      PAGE_WIDTH,
      PAGE_HEIGHT
    );

    expect(candidate).toMatchObject({ kind: "underline", label: "日期" });
    expect(candidate!.left).toBeGreaterThan(120);
  });

  it("accepts a full-width colon label and a half-width one", () => {
    const labels = labelBlankCandidates(
      [word("Name:", 120, 300, 90), word("職位：", 120, 360, 80)],
      PAGE_WIDTH,
      PAGE_HEIGHT
    ).map(item => item.label);

    expect(labels).toEqual(["Name", "職位"]);
  });

  it("ignores text that is not a label", () => {
    const candidates = labelBlankCandidates(
      [
        word("這是一段說明文字，沒有冒號", 120, 300, 400),
        word("2.", 120, 340, 30),
        word("(", 120, 380, 20),
        word(
          "如活動已於年度計劃表內獲學生發展委員會批准，請於活動舉行前提交：",
          120,
          420,
          800
        ),
      ],
      PAGE_WIDTH,
      PAGE_HEIGHT
    );

    expect(candidates).toEqual([]);
  });

  it("skips a label with no room left to write in", () => {
    expect(
      labelBlankCandidates(
        [word("職位：", 1_080, 300, 60)],
        PAGE_WIDTH,
        PAGE_HEIGHT
      )
    ).toEqual([]);
  });

  it("returns blanks in reading order", () => {
    const labels = labelBlankCandidates(
      [
        word("地點：", 700, 300, 80),
        word("日期：", 120, 300, 80),
        word("名稱：", 120, 240, 80),
      ],
      PAGE_WIDTH,
      PAGE_HEIGHT
    ).map(item => item.label);

    expect(labels).toEqual(["名稱", "日期", "地點"]);
  });

  it("returns nothing for an unusable page or empty text layer", () => {
    expect(labelBlankCandidates([], PAGE_WIDTH, PAGE_HEIGHT)).toEqual([]);
    expect(
      labelBlankCandidates([word("職位：", 120, 300, 80)], 0, PAGE_HEIGHT)
    ).toEqual([]);
    expect(
      labelBlankCandidates(
        [word("職位：", 120, 300, 80)],
        PAGE_WIDTH,
        Number.NaN
      )
    ).toEqual([]);
  });

  it("keeps every candidate unconfirmed and label-scored", () => {
    const [candidate] = labelBlankCandidates(
      [word("聯絡電話：", 120, 300, 120, 20, 88)],
      PAGE_WIDTH,
      PAGE_HEIGHT
    );

    expect(candidate).toMatchObject({ kind: "underline", confidence: 0.8 });
    expect(candidate!.labelConfidence).toBeCloseTo(0.88, 5);
    expect(candidate).not.toHaveProperty("confirmed");
  });

  it("S3-T01: prevents text blanks from extending across table cells when table geometry exists", () => {
    // 6-column table spanning x=200 to x=1000, y=500 to y=800. Col width = 800/6 = 133.33px.
    // Cell 0 spans x=200 to x=333.33.
    const tableStructure = {
      kind: "table" as const,
      left: 200,
      top: 500,
      width: 800,
      height: 300,
      confidence: 0.9,
      columns: 6,
      rows: 4,
      cellGuides: Array.from({ length: 24 }, (_, i) => ({
        xRatio: (i % 6) / 6, yRatio: Math.floor(i / 6) / 4,
        widthRatio: 1 / 6, heightRatio: 1 / 4,
      })),
    };

    const words = [
      // Word inside column 0 of table:
      word("項目：", 210, 520, 50),
      // Word outside table above:
      word("申請人：", 100, 200, 80),
      // Word to the left of table on the same horizontal row:
      word("編號：", 50, 520, 50),
    ];

    // With table geometry passed in options:
    const candidatesWithTable = labelBlankCandidates(words, PAGE_WIDTH, PAGE_HEIGHT, {
      tables: [tableStructure],
    });

    // 1. Label outside table above (申請人：) retains full space to right margin
    const applicant = candidatesWithTable.find(c => c.label === "申請人");
    expect(applicant).toBeDefined();
    expect(applicant!.left).toBe(180);
    expect(applicant!.width).toBeGreaterThan(800);

    // 2. Label to the left of the table on the same row (編號：) stops at table.left (200)
    const code = candidatesWithTable.find(c => c.label === "編號");
    expect(code).toBeDefined();
    expect(code!.left).toBe(100);
    expect(code!.left + code!.width).toBeLessThanOrEqual(200);

    // 3. Label inside column 0 of table (項目：) does NOT cross into column 1+
    // Column 0 right edge is 200 + 133.33 = 333.33. It must not extend past column 0!
    const item = candidatesWithTable.find(c => c.label === "項目");
    expect(item).toBeDefined();
    expect(item!.left + item!.width).toBeLessThanOrEqual(335);
  });

  it.each([undefined, [], [{ xRatio: 0, yRatio: 0, widthRatio: NaN, heightRatio: 1 }]])("does not invent internal boundaries from missing or malformed guides: %j", cellGuides => {
    const found = labelBlankCandidates([word("First:", 110, 110, 50)], PAGE_WIDTH, PAGE_HEIGHT, {
      tables: [{ left: 100, top: 100, width: 600, height: 100, rows: 1, columns: 2, cellGuides }],
    });
    expect(found[0].left + found[0].width).toBeCloseTo(700);
  });

  it("uses the actual nonuniform cell right edge, including a merged second row", () => {
    const table = { left: 100, top: 100, width: 600, height: 100, columns: 2, rows: 2,
      cellGuides: [
        { xRatio: 0, yRatio: 0, widthRatio: 2/3, heightRatio: 0.5 },
        { xRatio: 2/3, yRatio: 0, widthRatio: 1/3, heightRatio: 0.5 },
        { xRatio: 0, yRatio: 0.5, widthRatio: 1, heightRatio: 0.5 },
        { xRatio: 0, yRatio: 0.5, widthRatio: 1, heightRatio: 0.5 },
      ] };
    const found = labelBlankCandidates([word("First:", 110, 110, 50), word("Merged:", 110, 160, 50)], PAGE_WIDTH, PAGE_HEIGHT, { tables: [table] });
    expect(found.find(c => c.label === "First")!.left + found.find(c => c.label === "First")!.width).toBeCloseTo(500);
    expect(found.find(c => c.label === "Merged")!.left + found.find(c => c.label === "Merged")!.width).toBeCloseTo(700);
  });
});

describe("OCR fallback blanks", () => {
  it("keeps a candidate beside a word at the page edge inside the page", () => {
    const [candidate] = ocrWordCandidates(
      [word("ADA", 150, 190, 45, 20)],
      200,
      200,
      65
    );

    expect(candidate).toBeDefined();
    expect(candidate!.left).toBeGreaterThanOrEqual(0);
    expect(candidate!.top).toBeGreaterThanOrEqual(0);
    expect(candidate!.left + candidate!.width).toBeLessThanOrEqual(200);
    expect(candidate!.top + candidate!.height).toBeLessThanOrEqual(200);
  });
});
