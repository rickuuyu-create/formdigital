/**
 * Vector rule extraction from a PDF operator list.
 *
 * The path payload format is pdf.js-internal and not exported, so these tests
 * pin the shape this module decodes. If pdf.js changes it, these fail loudly
 * instead of the extractor silently returning nothing.
 */
import { describe, expect, it } from "vitest";
import {
  extractPdfRuleSegments,
  type PdfRuleOps,
} from "./native-pdf-rules";

/** Mirrors pdfjs-dist OPS for the operators this module reads. */
const OPS: PdfRuleOps = {
  save: 10,
  restore: 11,
  transform: 12,
  constructPath: 91,
  setLineWidth: 2,
  stroke: 20,
  closeStroke: 21,
  fill: 22,
  eoFill: 23,
  fillStroke: 24,
  eoFillStroke: 25,
  closeFillStroke: 26,
  closeEOFillStroke: 27,
};

const CLIP = 28;
const MOVE_TO = 0;
const LINE_TO = 1;
const CURVE_TO = 2;
const CLOSE_PATH = 4;

/** Identity in PDF space, y already flipped, as a page viewport supplies. */
const IDENTITY = [1, 0, 0, 1, 0, 0];

function list(
  entries: Array<{ fn: number; args?: unknown }>
) {
  return {
    fnArray: entries.map(entry => entry.fn),
    argsArray: entries.map(entry => entry.args ?? null),
  };
}

function path(paintOp: number, subpaths: number[][]) {
  return [paintOp, subpaths.map(values => Float32Array.from(values)), null];
}

describe("pdf vector rule extraction", () => {
  it("reads a horizontal rule painted through constructPath", () => {
    const result = extractPdfRuleSegments(
      list([
        {
          fn: OPS.constructPath,
          args: path(OPS.stroke, [[MOVE_TO, 100, 700, LINE_TO, 400, 700]]),
        },
      ]),
      OPS,
      IDENTITY,
      600,
      800
    );

    expect(result.status).toBe("ok");
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]).toMatchObject({
      orientation: "horizontal",
      leftPx: 100,
      widthPx: 300,
    });
  });

  it("reads a vertical rule and reports its orientation", () => {
    const result = extractPdfRuleSegments(
      list([
        {
          fn: OPS.constructPath,
          args: path(OPS.stroke, [[MOVE_TO, 120, 200, LINE_TO, 120, 500]]),
        },
      ]),
      OPS,
      IDENTITY,
      600,
      800
    );

    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]).toMatchObject({
      orientation: "vertical",
      topPx: 200,
      heightPx: 300,
    });
  });

  it("never turns a clipping path into a rule", () => {
    const result = extractPdfRuleSegments(
      list([
        {
          fn: OPS.constructPath,
          args: path(CLIP, [
            [MOVE_TO, 0, 0, LINE_TO, 600, 0, LINE_TO, 600, 800, CLOSE_PATH],
          ]),
        },
      ]),
      OPS,
      IDENTITY,
      600,
      800
    );

    expect(result.rules).toEqual([]);
  });

  it("keeps the four sides of a closed rectangle but drops diagonals and curves", () => {
    const rectangle = extractPdfRuleSegments(
      list([
        {
          fn: OPS.constructPath,
          args: path(OPS.stroke, [
            [
              MOVE_TO, 100, 100,
              LINE_TO, 300, 100,
              LINE_TO, 300, 160,
              LINE_TO, 100, 160,
              CLOSE_PATH,
            ],
          ]),
        },
      ]),
      OPS,
      IDENTITY,
      600,
      800
    );
    expect(rectangle.rules).toHaveLength(4);

    const diagonal = extractPdfRuleSegments(
      list([
        {
          fn: OPS.constructPath,
          args: path(OPS.stroke, [[MOVE_TO, 100, 100, LINE_TO, 300, 400]]),
        },
      ]),
      OPS,
      IDENTITY,
      600,
      800
    );
    expect(diagonal.rules).toEqual([]);

    const curve = extractPdfRuleSegments(
      list([
        {
          fn: OPS.constructPath,
          args: path(OPS.stroke, [
            [MOVE_TO, 100, 100, CURVE_TO, 120, 140, 160, 180, 300, 100],
          ]),
        },
      ]),
      OPS,
      IDENTITY,
      600,
      800
    );
    expect(curve.rules).toEqual([]);
  });

  it("applies the transform stack so nested rules land in viewport pixels", () => {
    const result = extractPdfRuleSegments(
      list([
        { fn: OPS.save },
        { fn: OPS.transform, args: [2, 0, 0, 2, 50, 10] },
        {
          fn: OPS.constructPath,
          args: path(OPS.stroke, [[MOVE_TO, 10, 20, LINE_TO, 110, 20]]),
        },
        { fn: OPS.restore },
        {
          fn: OPS.constructPath,
          args: path(OPS.stroke, [[MOVE_TO, 10, 20, LINE_TO, 110, 20]]),
        },
      ]),
      OPS,
      IDENTITY,
      600,
      800
    );

    expect(result.rules).toHaveLength(2);
    // Scaled by 2 and offset by 50 while the transform was in effect.
    expect(result.rules[0]).toMatchObject({ leftPx: 70, widthPx: 200 });
    // Back to page space once the state was restored.
    expect(result.rules[1]).toMatchObject({ leftPx: 10, widthPx: 100 });
  });

  it("refuses an unusable operator list instead of inventing rules", () => {
    expect(extractPdfRuleSegments(null, OPS, IDENTITY, 600, 800)).toEqual({
      status: "unavailable",
      rules: [],
    });
    expect(
      extractPdfRuleSegments(list([]), OPS, null, 600, 800).status
    ).toBe("unavailable");
    expect(
      extractPdfRuleSegments(list([]), OPS, IDENTITY, 0, 800).status
    ).toBe("unavailable");
    expect(
      extractPdfRuleSegments(
        { fnArray: [OPS.stroke], argsArray: [] },
        OPS,
        IDENTITY,
        600,
        800
      ).status
    ).toBe("unavailable");
  });

  it("drops a malformed path payload rather than guessing at it", () => {
    const unknownCode = extractPdfRuleSegments(
      list([
        { fn: OPS.constructPath, args: path(OPS.stroke, [[99, 1, 2, 3]]) },
      ]),
      OPS,
      IDENTITY,
      600,
      800
    );
    expect(unknownCode.rules).toEqual([]);

    const truncatedPayload = extractPdfRuleSegments(
      list([
        { fn: OPS.constructPath, args: path(OPS.stroke, [[MOVE_TO, 10]]) },
      ]),
      OPS,
      IDENTITY,
      600,
      800
    );
    expect(truncatedPayload.rules).toEqual([]);
  });

  it("ignores a rule shorter than a form blank could be", () => {
    const result = extractPdfRuleSegments(
      list([
        {
          fn: OPS.constructPath,
          args: path(OPS.stroke, [[MOVE_TO, 100, 100, LINE_TO, 104, 100]]),
        },
      ]),
      OPS,
      IDENTITY,
      600,
      800
    );

    expect(result.rules).toEqual([]);
  });
});
