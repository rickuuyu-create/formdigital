import { describe, expect, it } from "vitest";
import { drawPosition, mmToPoint } from "../server/formdigital/pdfRenderer";
import { createFieldRenderPlan } from "./renderPlan";
import { tableCellRect, tableGridSize } from "./tableGeometry";
import { fieldMarkStrokes, normalizeFieldMark } from "./fieldMark";

/**
 * The on-screen preview and the PDF renderer are separate pieces of code, and
 * a field that is positioned in the editor is only trustworthy if both place
 * it identically. Comparing rendered pixels would mostly measure the
 * difference between a browser's text rasteriser and a PDF viewer's, which is
 * not the property that matters and is not stable enough to assert on. What
 * matters is that both derive every rectangle from the same helpers, so these
 * lock that agreement in place: a change to one side that is not made to the
 * other stops the geometry from matching here.
 */
const PAGE_WIDTH_MM = 210;
const PAGE_HEIGHT_MM = 297;
const pageWidthPt = mmToPoint(PAGE_WIDTH_MM);
const pageHeightPt = mmToPoint(PAGE_HEIGHT_MM);

const BOXES = [
  { xMm: 0, yMm: 0, widthMm: 210, heightMm: 297 },
  { xMm: 20, yMm: 30, widthMm: 60, heightMm: 8 },
  { xMm: 12.7, yMm: 145.3, widthMm: 91.4, heightMm: 6.2 },
  { xMm: 180, yMm: 280, widthMm: 25, heightMm: 12 },
];

/** The preview's percentage box, expressed in PDF points with y measured up. */
function previewBoxAsPdfPoints(field: (typeof BOXES)[number]) {
  const plan = createFieldRenderPlan({
    pageWidthMm: PAGE_WIDTH_MM,
    pageHeightMm: PAGE_HEIGHT_MM,
    field,
  });
  const width = (plan.widthPercent / 100) * pageWidthPt;
  const height = (plan.heightPercent / 100) * pageHeightPt;
  return {
    x: (plan.leftPercent / 100) * pageWidthPt,
    y: pageHeightPt - (plan.topPercent / 100) * pageHeightPt - height,
    width,
    height,
  };
}

describe("preview and PDF geometry parity", () => {
  it("places a field box in the same place on both sides", () => {
    for (const field of BOXES) {
      const pdf = drawPosition(
        pageWidthPt,
        pageHeightPt,
        { page: 1, ...field },
        1,
        1,
        0,
        0
      );
      const preview = previewBoxAsPdfPoints(field);
      expect(preview.x).toBeCloseTo(pdf.x, 6);
      expect(preview.y).toBeCloseTo(pdf.y, 6);
      expect(preview.width).toBeCloseTo(pdf.width, 6);
      expect(preview.height).toBeCloseTo(pdf.height, 6);
    }
  });

  it("keeps a print calibration out of the preview's own geometry", () => {
    const field = BOXES[1]!;
    const calibrated = drawPosition(
      pageWidthPt,
      pageHeightPt,
      { page: 1, ...field },
      1.02,
      0.98,
      1.5,
      -2,
      );
    // A calibration is a property of one printer, so it must move the PDF and
    // leave the on-screen box alone; otherwise the editor would drift too.
    expect(calibrated.x).not.toBeCloseTo(previewBoxAsPdfPoints(field).x, 3);
  });

  it("derives every table cell from the one shared helper", () => {
    const definition = { tableColumns: 3, maxRows: 2, options: [] };
    const { rowSlots, columns } = tableGridSize(definition, []);
    expect({ rowSlots, columns }).toEqual({ rowSlots: 2, columns: 3 });
    const guides = [
      { xRatio: 0.05, yRatio: 0.1, widthRatio: 0.2, heightRatio: 0.3 },
    ];
    // Cell 0 uses its guide; every other cell falls back to the even division,
    // and both renderers read exactly these rectangles.
    expect(tableCellRect(guides, rowSlots, columns, 0, 0)).toEqual(guides[0]);
    expect(tableCellRect(guides, rowSlots, columns, 1, 2)).toEqual({
      xRatio: 2 / 3,
      yRatio: 0.5,
      widthRatio: 1 / 3,
      heightRatio: 0.5,
    });
  });

  it("draws a tick from the one shared stroke set", () => {
    const strokes = fieldMarkStrokes(normalizeFieldMark("check"), 20, 20);
    expect(strokes.lines.length).toBeGreaterThan(0);
    // Centred in its box, so the preview and the PDF agree without either
    // side re-deriving where the middle is.
    expect(strokes.centerX).toBeCloseTo(10, 6);
    expect(strokes.centerY).toBeCloseTo(10, 6);
    expect(normalizeFieldMark("nonsense")).toBe("check");
  });
});
