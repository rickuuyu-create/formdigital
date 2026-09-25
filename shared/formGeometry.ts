export type MillimeterFieldBox = { xMm?: number; yMm?: number; widthMm?: number; heightMm?: number };
export type Calibration = { scaleX?: number; scaleY?: number; offsetXmm?: number; offsetYmm?: number };

export function millimetersToPercent(valueMm: number, dimensionMm: number) {
  return (valueMm / dimensionMm) * 100;
}

export function percentToMillimeters(percent: number, dimensionMm: number) {
  return (percent / 100) * dimensionMm;
}

export function projectFieldBoxMm(box: MillimeterFieldBox, calibration: Calibration = {}) {
  const scaleX = calibration.scaleX ?? 1;
  const scaleY = calibration.scaleY ?? 1;
  const offsetXmm = calibration.offsetXmm ?? 0;
  const offsetYmm = calibration.offsetYmm ?? 0;
  return {
    xMm: (box.xMm ?? 0) * scaleX + offsetXmm,
    yMm: (box.yMm ?? 0) * scaleY + offsetYmm,
    widthMm: Math.max(0, (box.widthMm ?? 0) * scaleX),
    heightMm: Math.max(0, (box.heightMm ?? 0) * scaleY),
  };
}
