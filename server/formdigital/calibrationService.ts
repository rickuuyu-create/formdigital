import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { storeOwnedAsset } from "./assetStore";
import { mmToPoint } from "./pdfRenderer";

export async function createCalibrationTestPage(ownerId: string | number, input: { templateId: string; xOffsetMm: number; yOffsetMm: number; xScale: number; yScale: number }) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([mmToPoint(210), mmToPoint(297)]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const scaleX = input.xScale / 100, scaleY = input.yScale / 100;
  const x = (mm: number) => mmToPoint(mm * scaleX + input.xOffsetMm);
  const y = (mm: number) => page.getHeight() - mmToPoint(mm * scaleY + input.yOffsetMm);
  for (let mm = 10; mm <= 200; mm += 10) page.drawLine({ start: { x: x(mm), y: y(10) }, end: { x: x(mm), y: y(287) }, thickness: mm % 50 === 0 ? .8 : .25, color: rgb(.65, .7, .72) });
  for (let mm = 10; mm <= 287; mm += 10) page.drawLine({ start: { x: x(10), y: y(mm) }, end: { x: x(200), y: y(mm) }, thickness: mm % 50 === 0 ? .8 : .25, color: rgb(.65, .7, .72) });
  [[10,10],[200,10],[10,287],[200,287],[105,148.5]].forEach(([xMm,yMm]) => { page.drawLine({ start:{x:x(xMm!-3),y:y(yMm!)},end:{x:x(xMm!+3),y:y(yMm!)},thickness:1,color:rgb(.75,.15,.12) }); page.drawLine({ start:{x:x(xMm!),y:y(yMm!-3)},end:{x:x(xMm!),y:y(yMm!+3)},thickness:1,color:rgb(.75,.15,.12) }); });
  page.drawText("FORMDIGITAL CALIBRATION TEST - PRINT AT 100% / ACTUAL SIZE", { x: x(15), y: y(20), size: 9, font, color: rgb(.05,.12,.18) });
  page.drawText(`X ${input.xOffsetMm.toFixed(1)} mm  Y ${input.yOffsetMm.toFixed(1)} mm  Scale ${input.xScale.toFixed(2)}% / ${input.yScale.toFixed(2)}%`, { x: x(15), y: y(26), size: 8, font, color: rgb(.25,.3,.35) });
  const bytes = await pdf.save();
  const stored = await storeOwnedAsset(ownerId, { bytes, kind: "export", mimeType: "application/pdf", originalFilename: `Formdigital-calibration-${Date.now()}.pdf`, templateId: input.templateId, metadata: { format: "calibration-test", ...input } });
  return { assetId: stored.asset.id, url: stored.url, filename: stored.asset.originalFilename };
}
