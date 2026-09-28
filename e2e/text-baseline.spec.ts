import { test, expect } from "@playwright/test";
import path from "node:path";
import fs from "node:fs/promises";
import { PDFDocument, rgb } from "pdf-lib";
import { renderVersionPdf, mmToPoint } from "../server/formdigital/pdfRenderer";

const rows = [
  { y: 8, height: 6, text: "KKKK", fontSizePt: 10 },
  { y: 22, height: 14, text: "KKKK", fontSizePt: 10 },
  { y: 43, height: 12, text: "Agpq", fontSizePt: 12, bold: true },
  { y: 62, height: 14, text: "中文測試", fontSizePt: 10 },
  { y: 83, height: 12, text: "Agpq", fontSizePt: 12, fontFamily: "monospace" },
  { y: 103, height: 20, text: "KKKK", fontSizePt: 10, lineHeightPt: 24 },
];

test("single-line ink stays at the preview height in full and overlay PDFs", async ({ page }, info) => {
  await page.goto("/");
  const moduleUrl = `/@fs/${path.resolve("e2e/text-baseline.browser.tsx").replaceAll("\\", "/")}`;
  const fields = rows.map((row, i) => ({ id: `f${i}`, label: `Baseline ${i}`, type: "text", status: "confirmed", x: 10, y: row.y / 130 * 100, width: 80, height: row.height / 130 * 100, align: "center", fontFamily: row.fontFamily ?? "Arial", fontSizePt: row.fontSizePt, lineHeightPt: row.lineHeightPt, bold: row.bold, color: "#173c63" }));
  const values = Object.fromEntries(rows.map((row, i) => [`f${i}`, row.text]));
  await page.evaluate(async ({ moduleUrl, fields, values }) => {
    const module = await import(/* @vite-ignore */ moduleUrl);
    (window as any).__baseline = module;
    module.mountTextBaseline(fields, values);
  }, { moduleUrl, fields, values });
  await expect(page.locator("#baseline-preview input")).toHaveCount(rows.length);
  await page.evaluate(() => document.fonts.ready);
  const preview = await page.locator("#baseline-preview .document-page").screenshot();
  await fs.writeFile(info.outputPath("preview.png"), preview);
  await info.attach("fill-preview", { body: preview, contentType: "image/png" });
  const previewInk = await page.evaluate(({ image, rows }) => (window as any).__baseline.inkCenters(image, rows), { image: preview.toString("base64"), rows });
  const source = await PDFDocument.create();
  const sourcePage = source.addPage([mmToPoint(100), mmToPoint(130)]);
  rows.forEach(row => sourcePage.drawRectangle({ x: mmToPoint(10), y: mmToPoint(130 - row.y - row.height),
    width: mmToPoint(80), height: mmToPoint(row.height), borderColor: rgb(.65, .65, .65), borderWidth: .3 }));
  const sourceBytes = await source.save();
  for (const mode of ["full", "overlay"] as const) {
    const bytes = await renderVersionPdf({ mode,
      pages: [{ page: 1, widthMm: 100, heightMm: 130, assetId: "synthetic" }],
      fields: fields.map((field, i) => ({ stableFieldId: field.id, fieldType: "text", definition: field, coordinate: { page: 1, xMm: 10, yMm: rows[i].y, widthMm: 80, heightMm: rows[i].height, fontSizePt: field.fontSizePt, align: "center" } })),
      values, loadSource: async () => ({ mimeType: "application/pdf", bytes: sourceBytes }) });
    await page.locator("#baseline-pdf").evaluateAll(nodes => nodes.forEach(n => n.remove()));
    await page.evaluate(({ bytes, assets }) => (window as any).__baseline.renderBaselinePdf(bytes, assets), { bytes: Buffer.from(bytes).toString("base64"), assets: `/@fs/${path.resolve("node_modules/pdfjs-dist").replaceAll("\\", "/")}` });
    const pdf = await page.locator("#baseline-pdf").screenshot();
    await fs.writeFile(info.outputPath(`${mode}.png`), pdf);
    await fs.writeFile(info.outputPath(`${mode}.pdf`), bytes);
    await info.attach(`${mode}-pdf`, { body: pdf, contentType: "image/png" });
    const pdfInk = await page.evaluate(({ image, rows }) => (window as any).__baseline.inkCenters(image, rows), { image: pdf.toString("base64"), rows });
    await fs.writeFile(info.outputPath(`${mode}-measurements.json`), JSON.stringify({ previewInk, pdfInk }, null, 2));
    await info.attach(`${mode}-measurements`, { body: Buffer.from(JSON.stringify({ previewInk, pdfInk }, null, 2)), contentType: "application/json" });
    rows.forEach((row, i) => {
      expect(Number.isFinite(previewInk[i].center), `preview ${i} visible`).toBe(true);
      expect(Number.isFinite(pdfInk[i].center), `${mode} ${i} visible`).toBe(true);
      // Different browser/embedded font rasterisers may differ by a pixel;
      // a half-mm bound catches the original height-dependent top anchoring.
      expect.soft(Math.abs(pdfInk[i].center - previewInk[i].center), `${mode} ${row.text}, ${row.height}mm tall`).toBeLessThan(.5);
    });
  }
});
