import { describe, expect, it } from "vitest";
import type { PdfRuleSegment } from "./native-pdf-rules";
import { vectorFormStructures } from "./vector-structure";

function horizontal(
  left: number,
  top: number,
  width: number,
  thickness = 1
): PdfRuleSegment {
  return {
    leftPx: left,
    topPx: top,
    widthPx: width,
    heightPx: thickness,
    orientation: "horizontal",
  };
}

function vertical(
  left: number,
  top: number,
  height: number,
  thickness = 1
): PdfRuleSegment {
  return {
    leftPx: left,
    topPx: top,
    widthPx: thickness,
    heightPx: height,
    orientation: "vertical",
  };
}

const PAGE_WIDTH = 1_190;
const PAGE_HEIGHT = 1_684;

describe("vector form structures", () => {
  it("turns a standalone rule into a writable underline", () => {
    const structures = vectorFormStructures(
      [horizontal(200, 400, 600)],
      PAGE_WIDTH,
      PAGE_HEIGHT
    );

    expect(structures).toHaveLength(1);
    expect(structures[0]).toMatchObject({ kind: "underline", left: 200, width: 600 });
    // The writable box sits above the printed rule.
    expect(structures[0]!.top).toBeLessThan(400);
  });

  it("accepts a blank that spans most of the page width", () => {
    const structures = vectorFormStructures(
      [horizontal(180, 400, 900)],
      PAGE_WIDTH,
      PAGE_HEIGHT
    );

    expect(structures.map(item => item.kind)).toEqual(["underline"]);
  });

  it("joins a rule that the page emitted as several collinear pieces", () => {
    const structures = vectorFormStructures(
      [
        horizontal(200, 400, 200),
        horizontal(402, 400, 200),
        horizontal(604, 400.5, 196),
      ],
      PAGE_WIDTH,
      PAGE_HEIGHT
    );

    expect(structures).toHaveLength(1);
    expect(structures[0]!.width).toBeGreaterThan(590);
  });

  it("never reports the edges of a ruled grid as blanks", () => {
    const rules: PdfRuleSegment[] = [];
    for (const top of [600, 660, 720, 780]) rules.push(horizontal(150, top, 800));
    for (const left of [150, 400, 650, 950]) rules.push(vertical(left, 600, 180));

    const structures = vectorFormStructures(rules, PAGE_WIDTH, PAGE_HEIGHT);

    expect(structures).toEqual([]);
  });

  it("leaves tables and character boxes to the pixel detector", () => {
    const comb: PdfRuleSegment[] = [
      horizontal(300, 500, 240),
      horizontal(300, 540, 240),
    ];
    for (let index = 0; index <= 8; index += 1)
      comb.push(vertical(300 + index * 30, 500, 40));

    const structures = vectorFormStructures(comb, PAGE_WIDTH, PAGE_HEIGHT);

    expect(structures.some(item => item.kind === "table")).toBe(false);
    expect(structures.some(item => item.kind === "character-box")).toBe(false);
  });

  it("rejects a rule that is the bottom edge of a box", () => {
    const structures = vectorFormStructures(
      [
        horizontal(300, 500, 300),
        vertical(300, 460, 40),
        vertical(600, 460, 40),
      ],
      PAGE_WIDTH,
      PAGE_HEIGHT
    );

    expect(structures.some(item => item.kind === "underline")).toBe(false);
  });

  it("ignores a rule too short to be a form blank", () => {
    expect(
      vectorFormStructures([horizontal(200, 400, 20)], PAGE_WIDTH, PAGE_HEIGHT)
    ).toEqual([]);
  });

  it("returns nothing for an unusable page", () => {
    expect(vectorFormStructures([], PAGE_WIDTH, PAGE_HEIGHT)).toEqual([]);
    expect(
      vectorFormStructures([horizontal(200, 400, 600)], 0, PAGE_HEIGHT)
    ).toEqual([]);
    expect(
      vectorFormStructures(
        [horizontal(200, 400, 600)],
        PAGE_WIDTH,
        Number.NaN
      )
    ).toEqual([]);
  });
});
