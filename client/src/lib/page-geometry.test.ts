import { describe, expect, it } from "vitest";
import { millimetersToPercent, pageDimensions, percentToMillimeters } from "./page-geometry";
import { createFieldRenderPlan } from "@shared/renderPlan";

describe("pageManifest geometry", () => {
  it("uses the selected page dimensions instead of fixed A4 portrait values", () => {
    const pages = [{ page: 1, widthMm: 210, heightMm: 297 }, { page: 2, widthMm: 297, heightMm: 210 }];
    expect(pageDimensions(pages, 2)).toEqual({ widthMm: 297, heightMm: 210 });
    expect(millimetersToPercent(148.5, 297)).toBe(50);
    expect(millimetersToPercent(105, 210)).toBe(50);
  });

  it("round-trips percentage coordinates for non-A4 custom pages", () => {
    const dimensions = pageDimensions([{ page: 1, widthMm: 152, heightMm: 229 }], 1);
    expect(percentToMillimeters(millimetersToPercent(38, dimensions.widthMm), dimensions.widthMm)).toBeCloseTo(38, 8);
    expect(percentToMillimeters(millimetersToPercent(57.25, dimensions.heightMm), dimensions.heightMm)).toBeCloseTo(57.25, 8);
  });

  it("projects the selected landscape page with the same calibrated box used by Preview", () => {
    const dimensions = pageDimensions([{ page: 1, widthMm: 210, heightMm: 297 }, { page: 2, widthMm: 297, heightMm: 210 }], 2);
    const plan = createFieldRenderPlan({
      pageWidthMm: dimensions.widthMm,
      pageHeightMm: dimensions.heightMm,
      field: { xMm: 40, yMm: 50, widthMm: 60, heightMm: 8 },
      calibration: { offsetXmm: 1.5, offsetYmm: -0.8, scaleX: 0.998, scaleY: 1.002 },
    });
    expect(plan.xMm).toBeCloseTo(41.42, 8);
    expect(plan.yMm).toBeCloseTo(49.3, 8);
    expect(plan.widthMm).toBeCloseTo(59.88, 8);
    expect(plan.heightMm).toBeCloseTo(8.016, 8);
    expect(plan.leftPercent).toBeCloseTo(13.9461279461, 8);
    expect(plan.topPercent).toBeCloseTo(23.4761904762, 8);
  });
});
