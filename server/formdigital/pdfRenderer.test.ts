/** 長期資料契約提醒：毫米座標與校準換算須可重複驗證，避免把 viewport 像素帶入正式輸出。 */
import { describe, expect, it } from "vitest";
import zlib from "node:zlib";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import fontkit from "@pdf-lib/fontkit";
import {
  drawPosition,
  fontCoversCodePoints,
  mmToPoint,
  renderVersionPdf,
  requiredCjkCodePoints,
  unusableFontReason,
} from "./pdfRenderer";
import { PDFDict, PDFDocument, PDFRawStream, StandardFonts } from "pdf-lib";
import { millimetersToPercent, pageDimensions, percentToMillimeters } from "../../client/src/lib/page-geometry";
import { createFieldRenderPlan } from "../../shared/renderPlan";

describe("PDF coordinate renderer", () => {
  it("converts millimetres to PDF points", () => {
    expect(mmToPoint(25.4)).toBeCloseTo(72, 8);
  });

  it("applies scale, offset, and top-left document coordinates consistently", () => {
    const pageHeight = mmToPoint(297);
    const position = drawPosition(mmToPoint(210), pageHeight, { xMm: 10, yMm: 20, widthMm: 40, heightMm: 8 }, 1, 1, 1.5, -0.8);
    expect(position.x).toBeCloseTo(mmToPoint(11.5), 8);
    expect(position.y).toBeCloseTo(pageHeight - mmToPoint(19.2) - mmToPoint(8), 8);
    expect(position.width).toBeCloseTo(mmToPoint(40), 8);
  });

  it("preserves the same page-relative field geometry from DOM Preview through PDF output", () => {
    const page = pageDimensions([{ page: 2, widthMm: 297, heightMm: 210 }], 2);
    const xMm = percentToMillimeters(millimetersToPercent(148.5, page.widthMm), page.widthMm);
    const yMm = percentToMillimeters(millimetersToPercent(52.5, page.heightMm), page.heightMm);
    const position = drawPosition(mmToPoint(page.widthMm), mmToPoint(page.heightMm), { xMm, yMm, widthMm: 30, heightMm: 10 }, 1, 1, 0, 0);
    expect(xMm).toBeCloseTo(148.5, 8);
    expect(yMm).toBeCloseTo(52.5, 8);
    expect(position.x).toBeCloseTo(mmToPoint(148.5), 8);
    expect(position.y).toBeCloseTo(mmToPoint(210 - 52.5 - 10), 8);
  });

  it("uses the shared renderer contract for calibrated Preview and PDF geometry", () => {
    const previewBox = createFieldRenderPlan({ pageWidthMm: 210, pageHeightMm: 297, field: { xMm: 20, yMm: 30, widthMm: 40, heightMm: 5 }, calibration: { scaleX: 0.998, scaleY: 1.002, offsetXmm: 1.5, offsetYmm: -0.8 } });
    const pdfBox = drawPosition(mmToPoint(210), mmToPoint(297), { xMm: 20, yMm: 30, widthMm: 40, heightMm: 5 }, 0.998, 1.002, 1.5, -0.8);
    expect(pdfBox.x).toBeCloseTo(mmToPoint(previewBox.xMm), 8);
    expect(pdfBox.width).toBeCloseTo(mmToPoint(previewBox.widthMm), 8);
    expect(pdfBox.y).toBeCloseTo(mmToPoint(297) - mmToPoint(previewBox.yMm) - mmToPoint(previewBox.heightMm), 8);
  });

  it("matches the versioned multi-page render-plan golden", () => {
    const plan = createFieldRenderPlan({ pageWidthMm: 297, pageHeightMm: 210, field: { xMm: 148.5, yMm: 52.5, widthMm: 30, heightMm: 10 }, calibration: { scaleX: 1, scaleY: 1, offsetXmm: 0, offsetYmm: 0 } });
    expect(plan).toMatchObject({ xMm: 148.5, yMm: 52.5, widthMm: 30, heightMm: 10, leftPercent: 50, topPercent: 25, widthPercent: 10.1010101010101, heightPercent: 4.761904761904762 });
  });

  it("renders fixed two-page Full Background and Overlay PDF fixtures with page-specific fields", async () => {
    const source = await PDFDocument.create();
    const font = await source.embedFont(StandardFonts.Helvetica);
    const sourcePage1 = source.addPage([mmToPoint(210), mmToPoint(297)]);
    const sourcePage2 = source.addPage([mmToPoint(297), mmToPoint(210)]);
    sourcePage1.drawText("GOLDEN BACKGROUND PAGE 1", { x: 24, y: 780, size: 12, font });
    sourcePage2.drawText("GOLDEN BACKGROUND PAGE 2", { x: 24, y: 540, size: 12, font });
    const sourceBytes = await source.save();
    const fixture = {
      pages: [{ page: 1, widthMm: 210, heightMm: 297, assetId: "fixture" }, { page: 2, widthMm: 297, heightMm: 210, assetId: "fixture" }],
      fields: [
        { stableFieldId: "page-one", coordinate: { page: 1, xMm: 20, yMm: 30, widthMm: 60, heightMm: 8, fontSizePt: 10 } },
        { stableFieldId: "page-two", coordinate: { page: 2, xMm: 40, yMm: 50, widthMm: 60, heightMm: 8, fontSizePt: 10 } },
      ],
      values: { "page-one": "PAGE-ONE-VALUE", "page-two": "PAGE-TWO-VALUE" },
      printSettings: { xOffsetMm: 1.5, yOffsetMm: -0.8, xScale: 99.8, yScale: 100.2 },
      loadSource: async () => ({ mimeType: "application/pdf", bytes: sourceBytes }),
    } as const;
    const full = await renderVersionPdf({ ...fixture, mode: "full" });
    const overlay = await renderVersionPdf({ ...fixture, mode: "overlay" });
    const fullPages = (await PDFDocument.load(full)).getPages();
    const overlayPages = (await PDFDocument.load(overlay)).getPages();
    expect(fullPages).toHaveLength(2);
    expect(overlayPages).toHaveLength(2);
    expect(fullPages[0].getSize()).toEqual({ width: mmToPoint(210), height: mmToPoint(297) });
    expect(fullPages[1].getSize()).toEqual({ width: mmToPoint(297), height: mmToPoint(210) });
    expect(overlayPages[1].getSize()).toEqual({ width: mmToPoint(297), height: mmToPoint(210) });
    expect(full.length).toBeGreaterThan(sourceBytes.length);
    expect(overlay.length).toBeGreaterThan(300);
  });

  it("renders fixed two-page PNG backgrounds in Full Background and Overlay modes", async () => {
    const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAF/gL+VDoP6QAAAABJRU5ErkJggg==", "base64"));
    const input = {
      pages: [{ page: 1, widthMm: 210, heightMm: 297, assetId: "png-1" }, { page: 2, widthMm: 297, heightMm: 210, assetId: "png-2" }],
      fields: [{ stableFieldId: "page-two", coordinate: { page: 2, xMm: 20, yMm: 30, widthMm: 50, heightMm: 8 } }],
      values: { "page-two": "IMAGE-PAGE-TWO" },
      loadSource: async () => ({ mimeType: "image/png", bytes: png }),
    } as const;
    const full = await renderVersionPdf({ ...input, mode: "full" });
    const overlay = await renderVersionPdf({ ...input, mode: "overlay" });
    const fullPages = (await PDFDocument.load(full)).getPages();
    const overlayPages = (await PDFDocument.load(overlay)).getPages();
    expect(fullPages).toHaveLength(2);
    expect(overlayPages).toHaveLength(2);
    expect(fullPages[0].getSize()).toEqual({ width: mmToPoint(210), height: mmToPoint(297) });
    expect(fullPages[1].getSize()).toEqual({ width: mmToPoint(297), height: mmToPoint(210) });
    expect(full.length).toBeGreaterThan(overlay.length);
  });

  it("embeds an offline CJK font for Traditional Chinese output", async () => {
    const bytes = await renderVersionPdf({
      mode: "overlay",
      pages: [{ page: 1, widthMm: 210, heightMm: 297 }],
      fields: [{ stableFieldId: "name", fieldType: "text", coordinate: { page: 1, xMm: 20, yMm: 30, widthMm: 80, heightMm: 10, fontSizePt: 12 } }],
      values: { name: "陳俊賢—繁體中文" },
      loadSource: async () => { throw new Error("No source expected in Overlay mode."); },
    });
    const rendered = await PDFDocument.load(bytes);
    expect(rendered.getPageCount()).toBe(1);
    expect(bytes.length).toBeGreaterThan(1_000);
  });

  it("keeps checked values and detected radio positions in editable PDFs", async () => {
    const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAF/gL+VDoP6QAAAABJRU5ErkJggg==", "base64"));
    const bytes = await renderVersionPdf({
      mode: "editable",
      pages: [{ page: 1, widthMm: 210, heightMm: 297, assetId: "background" }],
      fields: [
        {
          stableFieldId: "consent",
          fieldType: "checkbox",
          definition: { label: "Consent" },
          coordinate: { page: 1, xMm: 10, yMm: 20, widthMm: 5, heightMm: 5 },
        },
        {
          stableFieldId: "gender",
          fieldType: "radio",
          definition: {
            label: "Gender",
            options: ["Male", "Female"],
            optionMarks: [
              { option: "Male", xRatio: 0, yRatio: 0, widthRatio: 0.1, heightRatio: 1 },
              { option: "Female", xRatio: 0.8, yRatio: 0, widthRatio: 0.1, heightRatio: 1 },
            ],
          },
          coordinate: { page: 1, xMm: 20, yMm: 30, widthMm: 100, heightMm: 10 },
        },
      ],
      values: { consent: "checked", gender: "Female" },
      loadSource: async () => ({ mimeType: "image/png", bytes: png }),
    });
    const rendered = await PDFDocument.load(bytes);
    const form = rendered.getForm();
    expect(form.getCheckBox("consent").isChecked()).toBe(true);
    const radio = form.getRadioGroup("gender");
    expect(radio.getSelected()).toBe("Female");
    const widgets = radio.acroField.getWidgets().map(widget => widget.getRectangle());
    expect(widgets).toHaveLength(2);
    expect(widgets[0]!.x).toBeCloseTo(mmToPoint(20), 5);
    expect(widgets[1]!.x).toBeCloseTo(mmToPoint(100), 5);
    expect(widgets[0]!.width).toBeCloseTo(mmToPoint(10), 5);
  });
});

/**
 * Read back what a flattened page actually draws: each shown glyph with the
 * x position it was placed at. Lets a test prove millimetre placement instead
 * of only checking that some bytes were produced.
 */
async function drawnGlyphs(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  const glyphs: Array<{ text: string; x: number; y: number }> = [];
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    let data = Buffer.from(object.contents);
    try {
      data = zlib.inflateSync(data);
    } catch {
      /* an uncompressed content stream is read as-is */
    }
    const content = data.toString("latin1");
    const pattern = /1 0 0 1 ([\d.-]+) ([\d.-]+) Tm\s*<([0-9a-fA-F]+)> Tj/g;
    for (let match = pattern.exec(content); match; match = pattern.exec(content)) {
      const hex = match[3]!;
      let text = "";
      for (let index = 0; index + 1 < hex.length; index += 2)
        text += String.fromCharCode(Number.parseInt(hex.slice(index, index + 2), 16));
      glyphs.push({ text, x: Number(match[1]), y: Number(match[2]) });
    }
  }
  return glyphs.sort((left, right) => right.y - left.y || left.x - right.x);
}

describe("segmented and table field output", () => {
  const dateBoxes = [
    ...Array.from({ length: 2 }, (_, index) => ({ xRatio: index * 0.09, yRatio: 0, widthRatio: 0.09, heightRatio: 1 })),
    ...Array.from({ length: 2 }, (_, index) => ({ xRatio: 0.25 + index * 0.09, yRatio: 0, widthRatio: 0.09, heightRatio: 1 })),
    ...Array.from({ length: 4 }, (_, index) => ({ xRatio: 0.5 + index * 0.12, yRatio: 0, widthRatio: 0.12, heightRatio: 1 })),
  ];
  const dateField = {
    stableFieldId: "dob",
    fieldType: "characterBox",
    definition: {
      label: "出生日期",
      boxCount: 8,
      maxLength: 8,
      segmentCapacities: [2, 2, 4],
      detectionGroup: dateBoxes,
    },
    coordinate: { page: 1, xMm: 20, yMm: 30, widthMm: 80, heightMm: 8, fontSizePt: 9 },
  };

  it("prints a whole three-segment date instead of truncating it to the segment count", async () => {
    const glyphs = await drawnGlyphs(
      await renderVersionPdf({
        mode: "overlay",
        pages: [{ page: 1, widthMm: 210, heightMm: 297 }],
        fields: [dateField],
        values: { dob: "23/08/2026" },
        loadSource: async () => { throw new Error("No source expected in Overlay mode."); },
      })
    );

    expect(glyphs.map(glyph => glyph.text).join("")).toBe("23082026");
  });

  it("places each date character in its own detected box, matching the Preview ratios", async () => {
    const glyphs = await drawnGlyphs(
      await renderVersionPdf({
        mode: "overlay",
        pages: [{ page: 1, widthMm: 210, heightMm: 297 }],
        fields: [dateField],
        values: { dob: "23/08/2026" },
        loadSource: async () => { throw new Error("No source expected in Overlay mode."); },
      })
    );

    expect(glyphs).toHaveLength(8);
    dateBoxes.forEach((box, index) => {
      // The DOM Preview positions the same character at `xRatio` of the field
      // box; the PDF must land on the identical millimetre.
      const boxLeftMm = 20 + box.xRatio * 80;
      const boxWidthMm = box.widthRatio * 80;
      expect(glyphs[index]!.x).toBeGreaterThanOrEqual(mmToPoint(boxLeftMm) - 0.01);
      expect(glyphs[index]!.x).toBeLessThanOrEqual(mmToPoint(boxLeftMm + boxWidthMm) + 0.01);
    });
  });

  it("keeps the whole date in an editable PDF text field", async () => {
    const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAF/gL+VDoP6QAAAABJRU5ErkJggg==", "base64"));
    const bytes = await renderVersionPdf({
      mode: "editable",
      pages: [{ page: 1, widthMm: 210, heightMm: 297, assetId: "background" }],
      fields: [dateField],
      values: { dob: "23/08/2026" },
      loadSource: async () => ({ mimeType: "image/png", bytes: png }),
    });

    expect((await PDFDocument.load(bytes)).getForm().getTextField("dob").getText()).toBe("23082026");
  });

  it("writes only the blank cells of a detected table", async () => {
    const glyphs = await drawnGlyphs(
      await renderVersionPdf({
        mode: "overlay",
        pages: [{ page: 1, widthMm: 210, heightMm: 297 }],
        fields: [
          {
            stableFieldId: "grid",
            fieldType: "table",
            definition: {
              label: "Grid",
              tableColumns: 3,
              maxRows: 3,
              detectionSource: "local-structure:table",
              tableWritableCells: [{ row: 2, column: 2 }],
            },
            coordinate: { page: 1, xMm: 20, yMm: 40, widthMm: 90, heightMm: 30, fontSizePt: 8 },
          },
        ],
        values: {
          grid: JSON.stringify([
            ["A", "B", "C"],
            ["D", "E", "F"],
            ["G", "H", "Z"],
          ]),
        },
        loadSource: async () => { throw new Error("No source expected in Overlay mode."); },
      })
    );

    expect(glyphs.map(glyph => glyph.text).join("")).toBe("Z");
    // Bottom-right cell of a 3x3 grid: last column, last row.
    expect(glyphs[0]!.x).toBeGreaterThanOrEqual(mmToPoint(20 + 60));
    expect(glyphs[0]!.y).toBeLessThanOrEqual(mmToPoint(297 - 40 - 20));
  });

  it("keeps filling every cell for tables saved before writable-cell masks existed", async () => {
    const glyphs = await drawnGlyphs(
      await renderVersionPdf({
        mode: "overlay",
        pages: [{ page: 1, widthMm: 210, heightMm: 297 }],
        fields: [
          {
            stableFieldId: "grid",
            fieldType: "table",
            definition: { label: "Grid", tableColumns: 2, maxRows: 2 },
            coordinate: { page: 1, xMm: 20, yMm: 40, widthMm: 90, heightMm: 30, fontSizePt: 8 },
          },
        ],
        values: { grid: JSON.stringify([["A", "B"], ["C", "D"]]) },
        loadSource: async () => { throw new Error("No source expected in Overlay mode."); },
      })
    );

    expect(glyphs.map(glyph => glyph.text).sort().join("")).toBe("ABCD");
  });

  it("prints calculated formula cells and excludes fixed cell residuals (TBL-01)", async () => {
    const glyphs = await drawnGlyphs(
      await renderVersionPdf({
        mode: "overlay",
        pages: [{ page: 1, widthMm: 210, heightMm: 297 }],
        fields: [
          {
            stableFieldId: "finance_table",
            fieldType: "table",
            definition: {
              label: "Finance Table",
              tableColumns: 3,
              maxRows: 2,
              tableWritableCells: [{ row: 0, column: 0 }, { row: 0, column: 1 }],
              tableFormulaCells: [{ row: 0, column: 2, expression: "A+B", decimalPlaces: 2 }],
            },
            coordinate: { page: 1, xMm: 20, yMm: 40, widthMm: 90, heightMm: 30, fontSizePt: 8 },
          },
        ],
        values: {
          finance_table: JSON.stringify([
            ["10", "25", "stale_formula_residual"],
            ["stale_fixed_1", "stale_fixed_2", "stale_fixed_3"],
          ]),
        },
        loadSource: async () => { throw new Error("No source expected in Overlay mode."); },
      })
    );

    // Row 0 col 0 is "10", col 1 is "25", col 2 is "35.00". Row 1 is completely fixed, so residuals must NOT be printed.
    const text = glyphs.map(glyph => glyph.text).join("");
    expect(text).toContain("35.00");
    expect(text).not.toContain("stale");
  });

  it("prints nothing when tableWritableCells is explicitly empty [] without formula cells (TBL-01)", async () => {
    const glyphs = await drawnGlyphs(
      await renderVersionPdf({
        mode: "overlay",
        pages: [{ page: 1, widthMm: 210, heightMm: 297 }],
        fields: [
          {
            stableFieldId: "locked_table",
            fieldType: "table",
            definition: {
              label: "Locked Table",
              tableColumns: 2,
              maxRows: 2,
              tableWritableCells: [],
            },
            coordinate: { page: 1, xMm: 20, yMm: 40, widthMm: 90, heightMm: 30, fontSizePt: 8 },
          },
        ],
        values: { locked_table: JSON.stringify([["A", "B"], ["C", "D"]]) },
        loadSource: async () => { throw new Error("No source expected in Overlay mode."); },
      })
    );

    expect(glyphs.length).toBe(0);
  });


  /**
   * A table printed on a real form has uneven rows and columns, and its first
   * writable row rarely begins at the top of the box the detector drew. So a
   * cell has to be positionable on its own: correcting the one square that is
   * off must not disturb the cells that were already landing correctly.
   */
  it("prints a table cell where its guide was placed, leaving the others put", async () => {
    const render = (tableCellGuides?: unknown) =>
      renderVersionPdf({
        mode: "overlay",
        pages: [{ page: 1, widthMm: 210, heightMm: 297 }],
        fields: [
          {
            stableFieldId: "grid",
            fieldType: "table",
            definition: { label: "Grid", tableColumns: 2, maxRows: 2, tableCellGuides },
            coordinate: { page: 1, xMm: 20, yMm: 40, widthMm: 90, heightMm: 30, fontSizePt: 8 },
          },
        ],
        values: { grid: JSON.stringify([["A", "B"], ["C", "D"]]) },
        loadSource: async () => { throw new Error("No source expected in Overlay mode."); },
      });
    const evenGrid = [
      { xRatio: 0, yRatio: 0, widthRatio: 0.5, heightRatio: 0.5 },
      { xRatio: 0.5, yRatio: 0, widthRatio: 0.5, heightRatio: 0.5 },
      { xRatio: 0, yRatio: 0.5, widthRatio: 0.5, heightRatio: 0.5 },
      { xRatio: 0.5, yRatio: 0.5, widthRatio: 0.5, heightRatio: 0.5 },
    ];

    // Guides matching the even division print exactly what a table saved
    // before guides existed prints, so adding them changes nothing by itself.
    const unguided = await drawnGlyphs(await render(undefined));
    const before = await drawnGlyphs(await render(evenGrid));
    expect(before).toEqual(unguided);

    const after = await drawnGlyphs(
      await render(
        evenGrid.map((guide, index) =>
          index === 1
            ? { xRatio: 0.6, yRatio: 0.1, widthRatio: 0.3, heightRatio: 0.3 }
            : guide
        )
      )
    );
    const at = (glyphs: typeof before, text: string) =>
      glyphs.find(glyph => glyph.text === text)!;
    for (const untouched of ["A", "C", "D"])
      expect(at(after, untouched)).toEqual(at(before, untouched));
    // Field box left 20mm + 60% of its 90mm width, plus the cell's own padding.
    expect(at(after, "B").x).toBeCloseTo(mmToPoint(74) + 2, 3);
    // Cell bottom 245mm up the page, plus its 9mm height, less padding and font.
    expect(at(after, "B").y).toBeCloseTo(mmToPoint(254) - 9, 3);
  });
});

/** Vector strokes a flattened page draws, as {x0,y0,x1,y1} in PDF points. */
async function allPdfStreamContents(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  const chunks: string[] = [];
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    let data = Buffer.from(object.contents);
    try { data = zlib.inflateSync(data); } catch { /* uncompressed stream */ }
    chunks.push(data.toString("latin1"));
  }
  return chunks.join("\n");
}

async function drawnLines(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  const lines: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    let data = Buffer.from(object.contents);
    try {
      data = zlib.inflateSync(data);
    } catch {
      /* an uncompressed content stream is read as-is */
    }
    const content = data.toString("latin1");
    const pattern = /([\d.-]+) ([\d.-]+) m\s+([\d.-]+) ([\d.-]+) l/g;
    for (let match = pattern.exec(content); match; match = pattern.exec(content))
      lines.push({
        x0: Number(match[1]),
        y0: Number(match[2]),
        x1: Number(match[3]),
        y1: Number(match[4]),
      });
  }
  return lines;
}

describe("checkbox and radio marks", () => {
  const page = { page: 1, widthMm: 210, heightMm: 297 };
  const overlay = (fields: unknown[], values: Record<string, string>) =>
    renderVersionPdf({
      mode: "overlay",
      pages: [page],
      fields: fields as never,
      values,
      loadSource: async () => { throw new Error("No source expected in Overlay mode."); },
    });

  // A small printed square, the size a real form uses.
  const boxCoordinate = { page: 1, xMm: 40, yMm: 60, widthMm: 4, heightMm: 4 };
  const boxBounds = {
    left: mmToPoint(40),
    right: mmToPoint(44),
    bottom: mmToPoint(297 - 64),
    top: mmToPoint(297 - 60),
  };

  it("draws a tick fully inside a ticked checkbox", async () => {
    const lines = await drawnLines(
      await overlay(
        [{ stableFieldId: "agree", fieldType: "checkbox", definition: { label: "Agree" }, coordinate: boxCoordinate }],
        { agree: "checked" }
      )
    );

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      for (const [x, y] of [[line.x0, line.y0], [line.x1, line.y1]]) {
        expect(x).toBeGreaterThanOrEqual(boxBounds.left - 0.01);
        expect(x).toBeLessThanOrEqual(boxBounds.right + 0.01);
        expect(y).toBeGreaterThanOrEqual(boxBounds.bottom - 0.01);
        expect(y).toBeLessThanOrEqual(boxBounds.top + 0.01);
      }
    }
  });

  it("draws nothing for an unticked checkbox", async () => {
    const lines = await drawnLines(
      await overlay(
        [{ stableFieldId: "agree", fieldType: "checkbox", definition: { label: "Agree" }, coordinate: boxCoordinate }],
        { agree: "" }
      )
    );

    expect(lines).toEqual([]);
  });

  it("marks the detected option box of the chosen radio value", async () => {
    const lines = await drawnLines(
      await overlay(
        [
          {
            stableFieldId: "joined",
            fieldType: "radio",
            definition: {
              label: "其他團體參與",
              options: ["沒有", "有"],
              optionMarks: [
                { option: "沒有", xRatio: 0, yRatio: 0, widthRatio: 0.1, heightRatio: 1 },
                { option: "有", xRatio: 0.5, yRatio: 0, widthRatio: 0.1, heightRatio: 1 },
              ],
            },
            coordinate: { page: 1, xMm: 40, yMm: 60, widthMm: 40, heightMm: 4 },
          },
        ],
        { joined: "有" }
      )
    );

    expect(lines.length).toBeGreaterThan(0);
    // Every stroke sits in the second option box, not the first.
    const secondBoxLeft = mmToPoint(40 + 40 * 0.5);
    const secondBoxRight = mmToPoint(40 + 40 * 0.6);
    for (const line of lines)
      for (const x of [line.x0, line.x1]) {
        expect(x).toBeGreaterThanOrEqual(secondBoxLeft - 0.01);
        expect(x).toBeLessThanOrEqual(secondBoxRight + 0.01);
      }
  });

  it("still marks a chosen radio option when the form gave no option geometry", async () => {
    const lines = await drawnLines(
      await overlay(
        [
          {
            stableFieldId: "joined",
            fieldType: "radio",
            definition: { label: "參與", options: ["沒有", "有"] },
            coordinate: { page: 1, xMm: 40, yMm: 60, widthMm: 40, heightMm: 4 },
          },
        ],
        { joined: "有" }
      )
    );

    // Previously this drew nothing at all; the second slot must be marked.
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines)
      for (const x of [line.x0, line.x1])
        expect(x).toBeGreaterThanOrEqual(mmToPoint(60) - 0.01);
  });

  it("honours the chosen mark style", async () => {
    const cross = await drawnLines(
      await overlay(
        [{ stableFieldId: "agree", fieldType: "checkbox", definition: { markStyle: "cross" }, coordinate: boxCoordinate }],
        { agree: "checked" }
      )
    );
    expect(cross).toHaveLength(2);

    const dot = await drawnLines(
      await overlay(
        [{ stableFieldId: "agree", fieldType: "checkbox", definition: { markStyle: "dot" }, coordinate: boxCoordinate }],
        { agree: "checked" }
      )
    );
    // A dot is a filled circle, drawn with curves rather than straight strokes.
    expect(dot).toEqual([]);
  });

  it("draws an outline around only the selected printed letter", async () => {
    const source = await PDFDocument.create();
    const sourcePage = source.addPage([mmToPoint(210), mmToPoint(297)]);
    const font = await source.embedFont(StandardFonts.Helvetica);
    sourcePage.drawText("A       B       C       D", {
      x: mmToPoint(40), y: mmToPoint(297 - 63), size: 11, font,
    });
    const sourceBytes = await source.save();
    const field = {
      stableFieldId: "answer",
      fieldType: "radio",
      definition: {
        label: "Answer",
        options: ["A", "B", "C", "D"],
        markStyle: "circle",
        optionMarks: [0, 1, 2, 3].map((index) => ({
          option: "ABCD"[index],
          xRatio: index / 4,
          yRatio: 0,
          widthRatio: 0.2,
          heightRatio: 1,
        })),
      },
      coordinate: { page: 1, xMm: 40, yMm: 59, widthMm: 60, heightMm: 7 },
    };
    const common = {
      pages: [{ page: 1, widthMm: 210, heightMm: 297, assetId: "source" }],
      fields: [field],
      values: { answer: "C" },
      loadSource: async () => ({ mimeType: "application/pdf", bytes: sourceBytes }),
    };
    const full = await renderVersionPdf({ ...common, mode: "full" } as never);
    const editable = await renderVersionPdf({ ...common, mode: "editable" } as never);
    const fullContents = await allPdfStreamContents(full);
    expect(fullContents.match(/ c\s/g)).toHaveLength(4);
    expect(fullContents).toMatch(/S\s/);
    const radio = (await PDFDocument.load(editable)).getForm().getRadioGroup("answer");
    expect(radio.getOptions()).toEqual(["A", "B", "C", "D"]);
    expect(radio.getSelected()).toBe("C");
    const widget = radio.acroField.getWidgets()[2]!;
    const normal = widget.getAppearances()?.normal;
    expect(normal).toBeInstanceOf(PDFDict);
    const on = (normal as PDFDict).lookup(widget.getOnValue()!);
    expect(on).toBeInstanceOf(PDFRawStream);
    const onContents = zlib.inflateSync(Buffer.from((on as PDFRawStream).contents)).toString("latin1");
    expect(onContents.match(/ c\s/g)).toHaveLength(4);
    expect(onContents).toMatch(/S\s/);
    expect(onContents).not.toMatch(/(?:^|\s)f\s/);
  });

  it("needs no CJK font to tick a box on an English-only form", async () => {
    // "✓" is outside WinAnsi, so a text glyph would force a font that may
    // not exist. Vector strokes must keep Helvetica sufficient.
    await expect(
      overlay(
        [{ stableFieldId: "agree", fieldType: "checkbox", definition: { label: "Agree" }, coordinate: boxCoordinate }],
        { agree: "checked" }
      )
    ).resolves.toBeInstanceOf(Uint8Array);
  });
});

async function decodedContent(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  const streams: string[] = [];
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    let data = Buffer.from(object.contents);
    try {
      data = zlib.inflateSync(data);
    } catch {
      /* an uncompressed content stream is read as-is */
    }
    streams.push(data.toString("latin1"));
  }
  return streams.join("\n");
}

async function clippingRectangles(bytes: Uint8Array) {
  const content = await decodedContent(bytes);
  return Array.from(content.matchAll(/q\s+([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+) re\s+W\s+n/g), match => ({
    x: Number(match[1]),
    y: Number(match[2]),
    width: Number(match[3]),
    height: Number(match[4]),
  }));
}

describe("editable complex fields and output fidelity", () => {
  const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAF/gL+VDoP6QAAAABJRU5ErkJggg==", "base64"));

  it("uses safe overlays for editable table, image and signature values", async () => {
    const loadedAssets: string[] = [];
    const bytes = await renderVersionPdf({
      mode: "editable",
      pages: [{ page: 1, widthMm: 210, heightMm: 297, assetId: "background" }],
      fields: [
        {
          stableFieldId: "grid",
          fieldType: "table",
          definition: { tableColumns: 2, maxRows: 2, detectionSource: "local-structure:table", tableWritableCells: [{ row: 1, column: 1 }] },
          coordinate: { page: 1, xMm: 20, yMm: 30, widthMm: 80, heightMm: 20, fontSizePt: 8 },
        },
        {
          stableFieldId: "photo",
          fieldType: "image",
          definition: { imageFit: "contain" },
          coordinate: { page: 1, xMm: 20, yMm: 60, widthMm: 20, heightMm: 20 },
        },
        {
          stableFieldId: "signature",
          fieldType: "signature",
          definition: { italic: true },
          coordinate: { page: 1, xMm: 20, yMm: 90, widthMm: 50, heightMm: 10 },
        },
        {
          stableFieldId: "plain",
          fieldType: "text",
          definition: { align: "center" },
          coordinate: { page: 1, xMm: 20, yMm: 110, widthMm: 50, heightMm: 10, align: "center" as const },
        },
      ],
      values: {
        grid: JSON.stringify([["A", "B"], ["C", "Z"]]),
        photo: "asset-test-image",
        signature: "text:TEST_SIGNER",
        plain: "EDITABLE",
      },
      loadSource: async assetId => {
        loadedAssets.push(assetId);
        return { mimeType: "image/png", bytes: png };
      },
    });

    const rendered = await PDFDocument.load(bytes);
    expect(rendered.getForm().getFields().map(field => field.getName())).toEqual(["plain"]);
    expect(rendered.getForm().getTextField("plain").getText()).toBe("EDITABLE");
    expect(loadedAssets.filter(assetId => assetId === "background")).toHaveLength(2);
    expect(loadedAssets.filter(assetId => assetId === "asset-test-image")).toHaveLength(1);
    const shown = (await drawnGlyphs(bytes)).map(glyph => glyph.text).join("");
    expect(shown).toContain("Z");
    expect(shown).toContain("TEST_SIGNER");
    expect(shown).not.toContain("text:");
    expect(shown).not.toContain("asset-test-image");
    expect(shown).not.toContain("[[");
  });

  it("never silently truncates overflow and blocks when configured to block", async () => {
    const base = {
      mode: "overlay" as const,
      pages: [{ page: 1, widthMm: 210, heightMm: 297 }],
      values: { note: "ABCDEFGHIJKLMNO" },
      loadSource: async () => { throw new Error("No source expected in Overlay mode."); },
    };
    const coordinate = { page: 1, xMm: 20, yMm: 30, widthMm: 8, heightMm: 4, fontSizePt: 10 };

    const wrapped = await renderVersionPdf({
      ...base,
      fields: [{ stableFieldId: "note", fieldType: "text", definition: { overflow: "wrap" }, coordinate }],
    });
    expect((await drawnGlyphs(wrapped)).map(glyph => glyph.text).join("")).toBe("ABCDEFGHIJKLMNO");

    await expect(renderVersionPdf({
      ...base,
      fields: [{ stableFieldId: "note", fieldType: "text", definition: { overflow: "block" }, coordinate }],
    })).rejects.toThrow("PDF 欄位內容超出可用範圍");
  });

  it("clips wrapped text to the exact field rectangle without dropping its stored glyphs", async () => {
    const coordinate = { page: 1, xMm: 20, yMm: 30, widthMm: 8, heightMm: 4, fontSizePt: 10 };
    const value = "ABCDEFGHIJKLMNO";
    const bytes = await renderVersionPdf({
      mode: "overlay",
      pages: [{ page: 1, widthMm: 210, heightMm: 297 }],
      fields: [{ stableFieldId: "note", fieldType: "text", definition: { overflow: "wrap" }, coordinate }],
      values: { note: value },
      loadSource: async () => { throw new Error("No source expected in Overlay mode."); },
    });

    expect((await drawnGlyphs(bytes)).map(glyph => glyph.text).join("")).toBe(value);
    expect(await clippingRectangles(bytes)).toContainEqual({
      x: mmToPoint(20),
      y: mmToPoint(297 - 30 - 4),
      width: mmToPoint(8),
      height: mmToPoint(4),
    });
  });

  it("clips cover-fit images to the exact field rectangle", async () => {
    const coordinate = { page: 1, xMm: 20, yMm: 30, widthMm: 20, heightMm: 10 };
    const bytes = await renderVersionPdf({
      mode: "overlay",
      pages: [{ page: 1, widthMm: 210, heightMm: 297 }],
      fields: [{ stableFieldId: "photo", fieldType: "image", definition: { imageFit: "cover" }, coordinate }],
      values: { photo: "square-image" },
      loadSource: async assetId => {
        expect(assetId).toBe("square-image");
        return { mimeType: "image/png", bytes: png };
      },
    });

    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
    expect(await clippingRectangles(bytes)).toContainEqual({
      x: mmToPoint(20),
      y: mmToPoint(297 - 30 - 10),
      width: mmToPoint(20),
      height: mmToPoint(10),
    });
    // A square source covering a 2:1 field is deliberately taller than the
    // field; the clipping path above is what makes the PDF match object-cover.
    expect(await decodedContent(bytes)).toMatch(/56\.6929[^\n]* 0 0 56\.6929/);
  });

  it("shrinks text to fit without dropping characters", async () => {
    const bytes = await renderVersionPdf({
      mode: "overlay",
      pages: [{ page: 1, widthMm: 210, heightMm: 297 }],
      fields: [{
        stableFieldId: "note",
        fieldType: "text",
        definition: { overflow: "shrink", lineHeightPt: 10 },
        coordinate: { page: 1, xMm: 20, yMm: 30, widthMm: 25, heightMm: 10, fontSizePt: 10 },
      }],
      values: { note: "ABCDEFGHIJKLMNO" },
      loadSource: async () => { throw new Error("No source expected in Overlay mode."); },
    });
    expect((await drawnGlyphs(bytes)).map(glyph => glyph.text).join("")).toBe("ABCDEFGHIJKLMNO");
  });

  it("draws fields in ascending zIndex order regardless of input order", async () => {
    const coordinate = { page: 1, xMm: 20, yMm: 30, widthMm: 40, heightMm: 10, fontSizePt: 10 };
    const bytes = await renderVersionPdf({
      mode: "overlay",
      pages: [{ page: 1, widthMm: 210, heightMm: 297 }],
      fields: [
        { stableFieldId: "front", fieldType: "text", definition: { zIndex: 20 }, coordinate },
        { stableFieldId: "back", fieldType: "text", definition: { zIndex: -5 }, coordinate },
      ],
      values: { front: "FRONT", back: "BACK" },
      loadSource: async () => { throw new Error("No source expected in Overlay mode."); },
    });
    expect((await drawnGlyphs(bytes)).map(glyph => glyph.text)).toEqual(["BACK", "FRONT"]);
  });

  it("applies font style, color, spacing, line height, alignment and underline", async () => {
    const bytes = await renderVersionPdf({
      mode: "overlay",
      pages: [{ page: 1, widthMm: 210, heightMm: 297 }],
      fields: [{
        stableFieldId: "styled",
        fieldType: "text",
        definition: {
          bold: true,
          italic: true,
          underline: true,
          color: "#ff0000",
          letterSpacingPt: 4,
          lineHeightPt: 18,
          overflow: "wrap",
          align: "right",
        },
        coordinate: { page: 1, xMm: 20, yMm: 30, widthMm: 60, heightMm: 30, fontSizePt: 12, align: "right" as const },
      }],
      values: { styled: "AB\nCD" },
      loadSource: async () => { throw new Error("No source expected in Overlay mode."); },
    });

    const glyphs = await drawnGlyphs(bytes);
    expect(glyphs.map(glyph => glyph.text)).toEqual(["A", "B", "C", "D"]);
    expect(glyphs[1]!.x - glyphs[0]!.x).toBeGreaterThan(10);
    expect(glyphs[0]!.y - glyphs[2]!.y).toBeCloseTo(18, 2);
    expect(glyphs[0]!.x).toBeGreaterThan(mmToPoint(50));
    expect((await drawnLines(bytes))).toHaveLength(2);
    const content = await decodedContent(bytes);
    expect(content).toMatch(/1 0 0 rg/);
    const rendered = await PDFDocument.load(bytes);
    expect(Array.from(rendered.context.enumerateIndirectObjects()).map(([, object]) => object.toString()).join("\n")).toContain("Helvetica-BoldOblique");
  });
});

describe("multi-select checkbox rows", () => {
  const page = { page: 1, widthMm: 210, heightMm: 297 };
  const options = ["關愛人格", "終身學習", "生涯規劃"];
  // Three printed squares spread across one row, as a real form has them.
  const optionMarks = options.map((option, index) => ({
    option,
    xRatio: index * 0.3,
    yRatio: 0,
    widthRatio: 0.1,
    heightRatio: 1,
  }));
  const coordinate = { page: 1, xMm: 30, yMm: 60, widthMm: 120, heightMm: 5 };
  const field = {
    stableFieldId: "traits",
    fieldType: "checkbox",
    definition: { label: "學生特質", options, optionMarks },
    coordinate,
  };
  const overlay = (values: Record<string, string>) =>
    renderVersionPdf({
      mode: "overlay",
      pages: [page],
      fields: [field] as never,
      values,
      loadSource: async () => { throw new Error("No source expected in Overlay mode."); },
    });

  it("circles both selected choices in printed and editable PDFs", async () => {
    const source = await PDFDocument.create();
    source.addPage([mmToPoint(210), mmToPoint(297)]);
    const sourceBytes = await source.save();
    const circleField = { ...field, definition: { ...field.definition, options: ["A", "B", "C"], markStyle: "circle", optionMarks: optionMarks.map((mark, index) => ({ ...mark, option: "ABC"[index] })) } };
    const common = {
      pages: [{ ...page, assetId: "source" }],
      fields: [circleField] as never,
      values: { traits: "A\nC" },
      loadSource: async () => ({ mimeType: "application/pdf", bytes: sourceBytes }),
    };
    const printed = await renderVersionPdf({ ...common, mode: "overlay" });
    const printedContent = await allPdfStreamContents(printed);
    expect(printedContent.match(/ c\s/g)).toHaveLength(8);
    expect(printedContent).not.toMatch(/(?:^|\s)f\s/);

    const editable = await renderVersionPdf({ ...common, mode: "editable" });
    const editableDocument = await PDFDocument.load(editable);
    const form = editableDocument.getForm();
    expect(form.getCheckBox("traits_0").isChecked()).toBe(true);
    expect(form.getCheckBox("traits_1").isChecked()).toBe(false);
    expect(form.getCheckBox("traits_2").isChecked()).toBe(true);
    for (const index of [0, 2]) {
      const widget = form.getCheckBox(`traits_${index}`).acroField.getWidgets()[0]!;
      const normal = widget.getAppearances()?.normal;
      expect(normal).toBeInstanceOf(PDFDict);
      const on = (normal as PDFDict).lookup(widget.getOnValue()!);
      expect(on).toBeInstanceOf(PDFRawStream);
      const content = zlib.inflateSync(Buffer.from((on as PDFRawStream).contents)).toString("latin1");
      expect(content.match(/ c\s/g)).toHaveLength(4);
      expect(content).toMatch(/S\s/);
      expect(content).not.toMatch(/(?:^|\s)f\s/);
    }
    form.getCheckBox("traits_0").uncheck();
    form.getCheckBox("traits_1").check();
    const changed = (await PDFDocument.load(await editableDocument.save())).getForm();
    expect([0, 1, 2].map(index => changed.getCheckBox(`traits_${index}`).isChecked()))
      .toEqual([false, true, true]);
  });

  it("marks only the ticked squares, each inside its own box", async () => {
    const lines = await drawnLines(
      await overlay({ traits: "生涯規劃\n關愛人格" })
    );
    expect(lines.length).toBeGreaterThan(0);

    const inBox = (index: number) => {
      const left = mmToPoint(30 + 120 * optionMarks[index]!.xRatio);
      const right = left + mmToPoint(120 * 0.1);
      return lines.filter(
        line =>
          line.x0 >= left - 0.01 &&
          line.x1 >= left - 0.01 &&
          line.x0 <= right + 0.01 &&
          line.x1 <= right + 0.01
      );
    };
    expect(inBox(0).length).toBeGreaterThan(0);
    expect(inBox(2).length).toBeGreaterThan(0);
    // The untouched middle square stays empty.
    expect(inBox(1)).toEqual([]);
  });

  it("draws nothing when no option is ticked", async () => {
    expect(await drawnLines(await overlay({ traits: "" }))).toEqual([]);
  });

  it("ignores a stored value that is not one of the options", async () => {
    expect(await drawnLines(await overlay({ traits: "不存在的項目" }))).toEqual(
      []
    );
  });

  it("gives an editable PDF one independent widget per printed square", async () => {
    const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAF/gL+VDoP6QAAAABJRU5ErkJggg==", "base64"));
    const bytes = await renderVersionPdf({
      mode: "editable",
      pages: [{ ...page, assetId: "background" }],
      fields: [field] as never,
      values: { traits: "終身學習" },
      loadSource: async () => ({ mimeType: "image/png", bytes: png }),
    });
    const form = (await PDFDocument.load(bytes)).getForm();
    expect(form.getCheckBox("traits_0").isChecked()).toBe(false);
    expect(form.getCheckBox("traits_1").isChecked()).toBe(true);
    expect(form.getCheckBox("traits_2").isChecked()).toBe(false);
  });

  it("keeps a lone checkbox on its single boolean value", async () => {
    const lone = {
      stableFieldId: "agree",
      fieldType: "checkbox",
      definition: { label: "Agree" },
      coordinate: { page: 1, xMm: 40, yMm: 60, widthMm: 4, heightMm: 4 },
    };
    const ticked = await drawnLines(
      await renderVersionPdf({
        mode: "overlay",
        pages: [page],
        fields: [lone] as never,
        values: { agree: "checked" },
        loadSource: async () => { throw new Error("No source expected in Overlay mode."); },
      })
    );
    expect(ticked.length).toBeGreaterThan(0);
  });
});

/** The embedded Traditional Chinese font program, decompressed. */
async function embeddedCjkProgram(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    const match = String(object).match(/\/FontFile(\d?)\s+(\d+) (\d+) R/);
    if (!match) continue;
    for (const [ref, candidate] of doc.context.enumerateIndirectObjects())
      if (ref.objectNumber === Number(match[2]) && candidate instanceof PDFRawStream) {
        const raw = Buffer.from(candidate.getContents());
        try {
          return zlib.inflateSync(raw);
        } catch {
          return raw;
        }
      }
  }
  return null;
}

describe("Traditional Chinese output", () => {
  /**
   * Windows ships NotoSansTC-VF, a variable font, and it used to be the first
   * one tried. `@pdf-lib/fontkit` writes a corrupt subset for a variable font
   * — 15 of 34 glyphs came out empty or pointing past the end of the embedded
   * program — so an exported form printed a few of its Chinese characters and
   * silently dropped the rest, with correct advance widths left behind as
   * gaps. Nothing in the file said anything was missing.
   */
  it("embeds a real outline for every Chinese character it prints", async () => {
    const value = "玩到反樓社劉啟傑會長";
    const bytes = await renderVersionPdf({
      mode: "overlay",
      pages: [{ page: 1, widthMm: 210, heightMm: 297 }],
      fields: [
        {
          stableFieldId: "org",
          fieldType: "text",
          definition: { label: "Org" },
          coordinate: { page: 1, xMm: 20, yMm: 30, widthMm: 150, heightMm: 10, fontSizePt: 12 },
        },
      ],
      values: { org: value },
      loadSource: async () => { throw new Error("No source expected in Overlay mode."); },
    });

    const program = await embeddedCjkProgram(bytes);
    expect(program).not.toBeNull();
    const font = fontkit.create(program!) as unknown as {
      getGlyph: (id: number) => { path: { commands: unknown[] } };
    };
    // The subset is Identity-ordered, so glyph 1 is the first character drawn.
    // Listing the characters that lost their outline names them on failure.
    const withoutOutline = Array.from(value).filter(
      (_, index) => font.getGlyph(index + 1).path.commands.length === 0
    );
    expect(withoutOutline).toEqual([]);
  });

  /** Renders one value and lists the characters that came out with no outline. */
  const renderValue = async (value: string) => {
    const bytes = await renderVersionPdf({
      mode: "overlay",
      pages: [{ page: 1, widthMm: 210, heightMm: 297 }],
      fields: [
        {
          stableFieldId: "v",
          fieldType: "text",
          definition: { label: "V" },
          coordinate: { page: 1, xMm: 20, yMm: 30, widthMm: 170, heightMm: 10, fontSizePt: 12 },
        },
      ],
      values: { v: value },
      loadSource: async () => { throw new Error("No source expected in Overlay mode."); },
    });
    const program = await embeddedCjkProgram(bytes);
    const font = fontkit.create(program!) as unknown as {
      getGlyph: (id: number) => { path: { commands: unknown[] } };
    };
    return Array.from(value).filter(
      (_, index) => font.getGlyph(index + 1).path.commands.length === 0
    );
  };

  it("names exactly the characters that need an embedded font", () => {
    // Line breaks are structure, not text: the renderer splits on them before
    // encoding anything, and no font has a glyph for one. Counting them made a
    // plain multi-line value demand a Chinese font and then fail to find one.
    const controls = [10, 9, 13].map(code => String.fromCharCode(code)).join("");
    expect(Array.from(requiredCjkCodePoints([`AB${controls}CD`]))).toEqual([]);
    // A euro sign and a curly apostrophe are WinAnsi; the standard fonts draw
    // them, so they must not drag a whole CJK font into the file either.
    expect(Array.from(requiredCjkCodePoints(["€12.50 don’t"]))).toEqual([]);
    expect(Array.from(requiredCjkCodePoints(["abc 123"]))).toEqual([]);
    expect(
      Array.from(requiredCjkCodePoints(["a玩b", "到"])).map(point =>
        String.fromCodePoint(point)
      )
    ).toEqual(["玩", "到"]);
    // Beyond the basic plane counts as one character, not two halves.
    expect(Array.from(requiredCjkCodePoints([String.fromCodePoint(0x20bb6)]))).toEqual([
      0x20bb6,
    ]);
  });

  it("refuses a font that cannot draw the characters, whatever its format", () => {
    const sfnt = (tags: string[]) => {
      const header = Buffer.alloc(12 + tags.length * 16);
      header.writeUInt32BE(0x00010000, 0);
      header.writeUInt16BE(tags.length, 4);
      tags.forEach((tag, index) => header.write(tag, 12 + index * 16, 4, "latin1"));
      return header;
    };
    const wanted = new Set([0x73e9]);
    expect(fontCoversCodePoints(Buffer.from("nope", "latin1"), wanted)).toBe(false);
    expect(fontCoversCodePoints(Buffer.from("ttcf____________", "latin1"), wanted)).toBe(false);
    // Parses far enough to look like a font, but has no glyph to draw.
    expect(fontCoversCodePoints(sfnt(["glyf", "loca", "cmap"]), wanted)).toBe(false);
    // An output with no CJK at all needs no custom font.
    expect(fontCoversCodePoints(sfnt(["glyf"]), new Set())).toBe(true);
  });

  /**
   * A font may answer with a real glyph id whose outline is empty, which
   * reserves the character's width and prints nothing — the same hole in the
   * form that a missing glyph leaves. Checking only for glyph 0 accepted it.
   * A space is legitimately blank, though, and an ideographic space is as
   * ordinary in Chinese as a plain space is in English, so blankness only
   * counts against a character that is supposed to carry ink.
   */
  it("separates a glyph with no ink from a character that is meant to be blank", async () => {
    const covering = await fsp
      .readFile("C:/Windows/Fonts/kaiu.ttf")
      .catch(() => null);
    if (!covering) return;
    // U+02C9 has a non-zero glyph id in this font and no outline at all.
    expect(fontCoversCodePoints(covering, new Set([0x02c9]))).toBe(false);
    // Blank by design, and must not make an ordinary Chinese form unprintable.
    expect(fontCoversCodePoints(covering, new Set([0x3000]))).toBe(true);
    expect(fontCoversCodePoints(covering, new Set([0x73e9]))).toBe(true);
  });

  it("draws the Cantonese characters a Hong Kong form actually carries", async () => {
    expect(await renderValue("邨冇嘅嘢咁啲揸埗氹")).toEqual([]);
  });

  /**
   * No font installed here covers the supplementary plane, so the guarantee is
   * stated as the contract rather than as one machine's outcome: either every
   * character is drawn, or the export is refused. What must never happen is a
   * file that looks complete and is quietly missing a character.
   */
  it("either draws a supplementary-plane character or refuses the export", async () => {
    let missing: string[] | null = null;
    let refusal = "";
    try {
      missing = await renderValue(`劉${String.fromCodePoint(0x20bb6)}傑`);
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    if (missing === null)
      expect(refusal).toContain("找不到可完整輸出本次內容的離線繁體中文字型");
    else expect(missing).toEqual([]);
  });

  it("falls back when FORMDIGITAL_CJK_FONT cannot draw the characters", async () => {
    const unusable = path.join(os.tmpdir(), `formdigital-empty-font-${Date.now()}.ttf`);
    const header = Buffer.alloc(12 + 16);
    header.writeUInt32BE(0x00010000, 0);
    header.writeUInt16BE(1, 4);
    header.write("glyf", 12, 4, "latin1");
    await fsp.writeFile(unusable, header);
    const previous = process.env.FORMDIGITAL_CJK_FONT;
    process.env.FORMDIGITAL_CJK_FONT = unusable;
    try {
      expect(await renderValue("玩到反樓社")).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.FORMDIGITAL_CJK_FONT;
      else process.env.FORMDIGITAL_CJK_FONT = previous;
      await fsp.rm(unusable, { force: true });
    }
  });

  it("rejects the font formats that lose characters when embedded", () => {
    const sfnt = (tags: string[]) => {
      const header = Buffer.alloc(12 + tags.length * 16);
      header.writeUInt32BE(0x00010000, 0);
      header.writeUInt16BE(tags.length, 4);
      tags.forEach((tag, index) => header.write(tag, 12 + index * 16, 4, "latin1"));
      return header;
    };
    expect(unusableFontReason(sfnt(["glyf", "loca", "cmap"]))).toBeNull();
    expect(unusableFontReason(sfnt(["glyf", "fvar", "gvar"]))).toContain("可變字型");
    expect(unusableFontReason(Buffer.from("ttcf____________", "latin1"))).toContain(".ttc");
    expect(unusableFontReason(Buffer.from("nope", "latin1"))).toContain("無法辨識");
  });
});

describe("editable PDF field kinds", () => {
  /** Editable output composes onto the source page, so one must be supplied. */
  const onePixelPng = Uint8Array.from(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAF/gL+VDoP6QAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  const sourcePage = async () => ({ mimeType: "image/png", bytes: onePixelPng });
  /**
   * A dropdown used to become a plain text field, so the exported PDF accepted
   * anything typed into it — including values the Template never offered,
   * which then failed validation when the filled form came back.
   */
  it("keeps a dropdown field a dropdown, with its options and selection", async () => {
    const bytes = await renderVersionPdf({
      mode: "editable",
      pages: [{ page: 1, widthMm: 210, heightMm: 297, assetId: "background" }],
      fields: [
        {
          stableFieldId: "venue",
          fieldType: "select",
          definition: { label: "Venue", options: ["演講廳", "2/F 共享空間", "其他"] },
          coordinate: { page: 1, xMm: 20, yMm: 30, widthMm: 60, heightMm: 8, fontSizePt: 10 },
        },
      ],
      values: { venue: "2/F 共享空間" },
      loadSource: sourcePage,
    });

    const form = (await PDFDocument.load(bytes)).getForm();
    const dropdown = form.getDropdown("venue");
    expect(dropdown.getOptions()).toEqual(["演講廳", "2/F 共享空間", "其他"]);
    expect(dropdown.getSelected()).toEqual(["2/F 共享空間"]);
    // The dropdown replaced the text field rather than sitting beside one.
    expect(form.getFields().map(item => item.getName())).toEqual(["venue"]);
  });

  /**
   * The font is chosen from the values being printed, but a dropdown also
   * carries its options into the file, and a person picks one of them after
   * the export. Choosing on the value alone meant an unanswered Chinese
   * dropdown was written with a Latin font that cannot encode its own options.
   */
  it("embeds a font that covers a dropdown's options, not just its value", async () => {
    const bytes = await renderVersionPdf({
      mode: "editable",
      pages: [{ page: 1, widthMm: 210, heightMm: 297, assetId: "background" }],
      fields: [
        {
          stableFieldId: "venue",
          fieldType: "select",
          definition: { label: "Venue", options: ["演講廳", "2/F 共享空間"] },
          coordinate: { page: 1, xMm: 20, yMm: 30, widthMm: 60, heightMm: 8, fontSizePt: 10 },
        },
      ],
      // Nothing chosen yet: the options are the only Chinese in the document.
      values: { venue: "" },
      loadSource: sourcePage,
    });

    const form = (await PDFDocument.load(bytes)).getForm();
    expect(form.getDropdown("venue").getOptions()).toEqual([
      "演講廳",
      "2/F 共享空間",
    ]);
    // Before the options were counted, no custom font was embedded at all and
    // the dropdown was written with a Latin one that cannot encode them.
    const program = await embeddedCjkProgram(bytes);
    expect(program).not.toBeNull();
    // A subset carries no cmap, so it is measured by how many glyphs came
    // across: one per distinct Chinese character in the options, plus .notdef.
    const distinct = new Set(Array.from("演講廳共享空間"));
    const font = fontkit.create(program!) as unknown as { numGlyphs: number };
    expect(font.numGlyphs).toBeGreaterThanOrEqual(distinct.size + 1);
  });

  it("leaves a dropdown with no options as a fillable text field", async () => {
    const bytes = await renderVersionPdf({
      mode: "editable",
      pages: [{ page: 1, widthMm: 210, heightMm: 297, assetId: "background" }],
      fields: [
        {
          stableFieldId: "venue",
          fieldType: "select",
          definition: { label: "Venue", options: [] },
          coordinate: { page: 1, xMm: 20, yMm: 30, widthMm: 60, heightMm: 8, fontSizePt: 10 },
        },
      ],
      values: { venue: "somewhere" },
      loadSource: sourcePage,
    });
    expect(
      (await PDFDocument.load(bytes)).getForm().getTextField("venue").getText()
    ).toBe("somewhere");
  });

  /**
   * The flattened renderer normalises option text before looking up the box it
   * detected; the editable one did not, so an option carrying a stray space
   * silently lost its printed position and fell back to a stacked slot.
   */
  it("places an editable radio option whose text carries stray whitespace", async () => {
    const optionMarks = [
      { option: "沒有 ", xRatio: 0, yRatio: 0, widthRatio: 0.1, heightRatio: 1 },
      { option: "有", xRatio: 0.8, yRatio: 0, widthRatio: 0.1, heightRatio: 1 },
    ];
    const bytes = await renderVersionPdf({
      mode: "editable",
      pages: [{ page: 1, widthMm: 210, heightMm: 297, assetId: "background" }],
      fields: [
        {
          stableFieldId: "joined",
          fieldType: "radio",
          definition: { label: "Joined", options: ["沒有 ", "有"], optionMarks },
          coordinate: { page: 1, xMm: 20, yMm: 30, widthMm: 100, heightMm: 8 },
        },
      ],
      values: { joined: "沒有" },
      loadSource: sourcePage,
    });

    const form = (await PDFDocument.load(bytes)).getForm();
    const group = form.getRadioGroup("joined");
    expect(group.getOptions()).toEqual(["沒有", "有"]);
    expect(group.getSelected()).toBe("沒有");
    // Both options kept the detected geometry: two widgets 80% of the field
    // box apart, not a stacked fallback in the same column.
    const [first, second] = group.acroField.getWidgets().map(widget => widget.getRectangle());
    expect(second!.x - first!.x).toBeCloseTo(mmToPoint(80), 3);
  });
});
