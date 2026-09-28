import { test, expect } from "@playwright/test";
import path from "node:path";
import fs from "node:fs/promises";
import { PDFDocument, rgb } from "pdf-lib";
import { renderVersionPdf, mmToPoint } from "../server/formdigital/pdfRenderer";

const rows = [
  { policy: "wrap", text: "Hong Kong is the city" },
  { policy: "shrink", text: "Hong Kong is the city" },
  { policy: "warn", text: "Hong Kong is the city" },
  { policy: "block", text: "Hong Kong is the city" },
  { policy: "shrink", text: "ABCDEFGHIJKLMNO", type: "textarea" },
  { policy: "wrap", text: "香港 Hong Kong 城市" },
  { policy: "wrap", text: "ABCDEFGHIJKLMNO" },
];

test("English word wrapping and all four overflow policies in real controls and PDF output", async ({ page }, info) => {
  await page.goto("/");
  const moduleUrl = `/@fs/${path.resolve("e2e/text-baseline.browser.tsx").replaceAll("\\", "/")}`;
  const widthMm = 55 / mmToPoint(1);
  const fields = rows.map((row, i) => ({ id: `overflow${i}`, label: `${row.policy}-${i}`, type: row.type ?? "text", overflow: row.policy,
    status: "confirmed", x: 10, y: (5 + i * 18) / 130 * 100, width: widthMm, height: 12 / 130 * 100,
    fontSizePt: 10, lineHeightPt: 12, fontFamily: "Arial", color: "#173c63" }));
  await page.evaluate(async ({ moduleUrl, fields }) => {
    const module = await import(/* @vite-ignore */ moduleUrl);
    (window as any).__baseline = module;
    module.mountTextBaseline(fields, {});
  }, { moduleUrl, fields });
  for (const [i, row] of rows.entries()) await page.getByRole("textbox", { name: `${row.policy}-${i}`, exact: true }).fill(row.text);
  const wrap = page.getByRole("textbox", { name: "wrap-0", exact: true });
  expect(await wrap.evaluate(node => node.tagName)).toBe("TEXTAREA");
  await wrap.fill("Hong Kong\nis the city");
  await expect(wrap).toHaveValue("Hong Kong\nis the city");
  await wrap.fill(rows[0].text);
  await page.locator("#baseline-preview").click({ position: { x: 5, y: 5 } });
  await fs.writeFile(info.outputPath("overflow-preview.png"), await page.locator("#baseline-preview .document-page").screenshot());

  const source = await PDFDocument.create();
  const sourcePage = source.addPage([mmToPoint(100), mmToPoint(130)]);
  rows.forEach((row, i) => {
    sourcePage.drawRectangle({ x: mmToPoint(10), y: mmToPoint(130 - 5 - i * 18 - 12), width: 55, height: mmToPoint(12), borderColor: rgb(.65, .65, .65), borderWidth: .3 });
    sourcePage.drawText(`${i + 1}. ${row.policy}${row.type ? " / multiline" : ""}`, { x: mmToPoint(40), y: mmToPoint(130 - 10 - i * 18), size: 10 });
  });
  const sourceBytes = await source.save();
  const fixture = {
    pages: [{ page: 1, widthMm: 100, heightMm: 130, assetId: "synthetic" }],
    fields: fields.map((field, i) => ({ stableFieldId: field.id, fieldType: field.type, definition: field,
      coordinate: { page: 1, xMm: 10, yMm: 5 + i * 18, widthMm, heightMm: 12, fontSizePt: 10 } })),
    values: Object.fromEntries(rows.map((row, i) => [`overflow${i}`, row.text])),
    loadSource: async () => ({ mimeType: "application/pdf", bytes: sourceBytes }),
  };
  for (const mode of ["full", "overlay", "editable"] as const) {
    const bytes = await renderVersionPdf({ ...fixture, mode });
    let rasterBytes = bytes;
    if (mode === "editable") {
      const pdf = await PDFDocument.load(bytes);
      expect(pdf.getForm().getFields()).toHaveLength(rows.length);
      rows.forEach((row, i) => expect(pdf.getForm().getTextField(`overflow${i}`).getText()).toBe(row.text));
      expect(pdf.getForm().getTextField("overflow0").isMultiline()).toBe(true);
      expect(pdf.getForm().getTextField("overflow1").isMultiline()).toBe(false);
      // Flatten the existing appearance only, so PDF.js can extract its lines
      // as well as rasterising them. Do not regenerate via a default provider.
      pdf.getForm().flatten({ updateFieldAppearances: false });
      rasterBytes = await pdf.save();
    }
    await page.locator("#baseline-pdf").evaluateAll(nodes => nodes.forEach(n => n.remove()));
    const items = await page.evaluate(({ bytes, assets }) => (window as any).__baseline.renderBaselinePdf(bytes, assets),
      { bytes: Buffer.from(rasterBytes).toString("base64"), assets: `/@fs/${path.resolve("node_modules/pdfjs-dist").replaceAll("\\", "/")}` });
    await fs.writeFile(info.outputPath(`overflow-${mode}.pdf`), bytes);
    await fs.writeFile(info.outputPath(`overflow-${mode}.png`), await page.locator("#baseline-pdf").screenshot());
    const textRows = rows.map((_, i) => items.filter((item: any) => item.text.trim() && item.x < mmToPoint(35)
      && item.y < mmToPoint(130 - 5 - i * 18) && item.y > mmToPoint(130 - 5 - i * 18 - 12)).map((item: any) => item.text.trim()));
    await fs.writeFile(info.outputPath(`overflow-${mode}-lines.json`), JSON.stringify(textRows, null, 2));
    for (const i of [0, 2, 3]) expect(textRows[i]).toEqual(["Hong Kong", "is the city"]);
    expect(textRows[1]).toEqual([rows[1].text]);
    expect(textRows[4]).toEqual([rows[4].text]);
    expect(textRows[5].join(" ")).toContain("Hong Kong");
    expect(textRows[6].join("")).toBe(rows[6].text);
  }
});
