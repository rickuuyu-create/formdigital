import { millimetersToPercent, projectFieldBoxMm, type Calibration, type MillimeterFieldBox } from "./formGeometry";

export type RenderPlanInput = {
  pageWidthMm: number;
  pageHeightMm: number;
  field: MillimeterFieldBox;
  calibration?: Calibration;
};

export function createFieldRenderPlan({ pageWidthMm, pageHeightMm, field, calibration }: RenderPlanInput) {
  const box = projectFieldBoxMm(field, calibration);
  return {
    ...box,
    leftPercent: millimetersToPercent(box.xMm, pageWidthMm),
    topPercent: millimetersToPercent(box.yMm, pageHeightMm),
    widthPercent: millimetersToPercent(box.widthMm, pageWidthMm),
    heightPercent: millimetersToPercent(box.heightMm, pageHeightMm),
  };
}
