import { describe, expect, it } from "vitest";
import { degrees, PDFDocument, PDFName, PDFNumber, StandardFonts } from "pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { fileURLToPath } from "node:url";
import {
  createNativePdfExtractionBudget,
  extractNativePdfPageSnapshot,
  type NativePdfPageSource,
  type NativePdfViewportSource,
} from "./native-pdf";

function expectRectClose(
  actual: { leftPx: number; topPx: number; widthPx: number; heightPx: number },
  expected: { leftPx: number; topPx: number; widthPx: number; heightPx: number }
) {
  expect(actual.leftPx).toBeCloseTo(expected.leftPx, 6);
  expect(actual.topPx).toBeCloseTo(expected.topPx, 6);
  expect(actual.widthPx).toBeCloseTo(expected.widthPx, 6);
  expect(actual.heightPx).toBeCloseTo(expected.heightPx, 6);
}

function mockViewport(): NativePdfViewportSource {
  return {
    scale: 2,
    width: 200,
    height: 400,
    rotation: 0,
    transform: [2, 0, 0, -2, 0, 400],
    convertToViewportPoint(x, y) {
      return [x * 2, 400 - y * 2];
    },
    convertToViewportRectangle(rect) {
      return [rect[0]! * 2, 400 - rect[1]! * 2, rect[2]! * 2, 400 - rect[3]! * 2];
    },
  };
}

function mockPage(overrides: Partial<NativePdfPageSource> = {}): NativePdfPageSource {
  return {
    view: [0, 0, 100, 200],
    userUnit: 1,
    rotate: 0,
    async getTextContent() {
      return { items: [] };
    },
    async getAnnotations() {
      return [];
    },
    ...overrides,
  };
}

describe("native PDF page snapshot", () => {
  it("copies text and Widget geometry into the raster viewport without retaining values or actions", async () => {
    const page = mockPage({
      async getTextContent() {
        return {
          items: [
            {
              str: "Name",
              dir: "ltr",
              transform: [10, 0, 0, 10, 10, 180],
              width: 24,
              height: 10,
              fontName: "font-1",
              hasEOL: false,
            },
            { type: "beginMarkedContent", id: "ignored" },
          ],
        };
      },
      async getAnnotations() {
        return [
          {
            subtype: "Widget",
            id: "widget-1",
            fieldName: "profile.name",
            alternativeText: "Name",
            fieldType: "Tx",
            rect: [10, 20, 30, 40],
            annotationType: 20,
            annotationFlags: 4,
            fieldFlags: 2,
            rotation: 0,
            readOnly: false,
            required: true,
            hidden: false,
            isEditable: true,
            multiLine: false,
            comb: true,
            maxLen: 20,
            password: false,
            checkBox: false,
            radioButton: false,
            pushButton: false,
            comboBox: false,
            multiSelect: false,
            fieldValue: "TEST_PRIVATE_VALUE",
            actions: { MouseUp: "TEST_PRIVATE_VALUE" },
          },
          { subtype: "Link", rect: [0, 0, 10, 10] },
        ];
      },
    });

    const snapshot = await extractNativePdfPageSnapshot(page, mockViewport());

    expect(snapshot.geometry).toEqual({
      status: "ok",
      viewBox: [0, 0, 100, 200],
      userUnit: 1,
      rotation: 0,
      viewportScale: 2,
      viewportWidthPx: 200,
      viewportHeightPx: 400,
      viewportTransform: [2, 0, 0, -2, 0, 400],
    });
    expect(snapshot.text).toMatchObject({
      status: "ok",
      totalItems: 1,
      invalidGeometryItems: 0,
      truncated: false,
    });
    expect(snapshot.text.items[0]).toMatchObject({
      text: "Name",
      sourceTransform: [10, 0, 0, 10, 10, 180],
      viewportRect: { leftPx: 20, topPx: 24, widthPx: 48, heightPx: 20 },
      viewportRectApproximate: true,
    });
    expect(snapshot.widgets).toMatchObject({
      status: "ok",
      totalAnnotations: 2,
      totalWidgets: 1,
      invalidGeometryWidgets: 0,
      truncated: false,
    });
    expect(snapshot.widgets.items[0]).toMatchObject({
      annotationId: "widget-1",
      fieldName: "profile.name",
      fieldType: "Tx",
      required: true,
      comb: true,
      maxLength: 20,
      viewportRect: { leftPx: 20, topPx: 320, widthPx: 40, heightPx: 40 },
    });
    expect(JSON.stringify(snapshot)).not.toContain("TEST_PRIVATE_VALUE");
    expect(snapshot.widgets.items[0]).not.toHaveProperty("actions");
    expect(snapshot.widgets.items[0]).not.toHaveProperty("fieldValue");
  });

  it("keeps rasterization-compatible metadata when text or annotation extraction fails", async () => {
    const page = mockPage({
      getTextContent() {
        throw new Error("TEST_PRIVATE_VALUE");
      },
      async getAnnotations() {
        throw new Error("TEST_PATH_VALUE");
      },
    });

    const snapshot = await extractNativePdfPageSnapshot(page, mockViewport());

    expect(snapshot.geometry.status).toBe("ok");
    expect(snapshot.text).toMatchObject({ status: "failed", totalItems: 0, items: [] });
    expect(snapshot.widgets).toMatchObject({
      status: "failed",
      totalAnnotations: 0,
      totalWidgets: 0,
      items: [],
    });
    expect(JSON.stringify(snapshot)).not.toContain("TEST_PRIVATE_VALUE");
    expect(JSON.stringify(snapshot)).not.toContain("TEST_PATH_VALUE");
  });

  it("times out stalled native readers without waiting forever or starting the next reader", async () => {
    let annotationReads = 0;
    const page = mockPage({
      getTextContent() {
        return new Promise(() => {});
      },
      async getAnnotations() {
        annotationReads += 1;
        return [];
      },
    });
    const budget = createNativePdfExtractionBudget({
      maxReadMillisecondsPerPage: 20,
      maxReadMillisecondsPerDocument: 20,
    });
    const startedAt = Date.now();

    const snapshot = await extractNativePdfPageSnapshot(page, mockViewport(), budget);

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(snapshot.text.status).toBe("failed");
    expect(snapshot.widgets.status).toBe("failed");
    expect(annotationReads).toBe(0);
    expect(snapshot.geometry.status).toBe("ok");
  });

  it("counts malformed native geometry without consuming it as a usable field", async () => {
    const page = mockPage({
      async getTextContent() {
        return {
          items: [{
            str: "Invalid",
            dir: "ltr",
            transform: [10, 0, 0, Number.NaN, 10, 20],
            width: 20,
            height: 10,
            fontName: "font-1",
            hasEOL: false,
          }],
        };
      },
      async getAnnotations() {
        return [
          { subtype: "Widget", fieldName: "invalid", rect: [0, 0, Number.POSITIVE_INFINITY, 10] },
          { subtype: "Text", rect: [0, 0, 10, 10] },
        ];
      },
    });

    const snapshot = await extractNativePdfPageSnapshot(page, mockViewport());

    expect(snapshot.text).toMatchObject({ totalItems: 1, invalidGeometryItems: 1, items: [] });
    expect(snapshot.widgets).toMatchObject({
      totalAnnotations: 2,
      totalWidgets: 1,
      invalidGeometryWidgets: 1,
      items: [],
    });
  });

  it("isolates malformed text and Widget conversion failures without exposing their messages", async () => {
    let pointCalls = 0;
    let rectangleCalls = 0;
    const viewport: NativePdfViewportSource = {
      ...mockViewport(),
      convertToViewportPoint(x, y) {
        if (pointCalls++ === 0) throw new Error("TEST_PRIVATE_VALUE");
        return [x * 2, 400 - y * 2];
      },
      convertToViewportRectangle(rect) {
        if (rectangleCalls++ === 0) throw new Error("TEST_PATH_VALUE");
        return [rect[0]! * 2, 400 - rect[1]! * 2, rect[2]! * 2, 400 - rect[3]! * 2];
      },
    };
    const textItem = (text: string, x: number) => ({
      str: text,
      dir: "ltr",
      transform: [10, 0, 0, 10, x, 180],
      width: 20,
      height: 10,
      fontName: "font-1",
      hasEOL: false,
    });
    const widget = (fieldName: string, x: number) => ({
      subtype: "Widget",
      fieldName,
      fieldType: "Tx",
      rect: [x, 20, x + 20, 40],
    });
    const page = mockPage({
      async getTextContent() {
        return {
          items: [
            {
              ...textItem("First", 10),
              get transform() {
                throw new Error("TEST_PRIVATE_VALUE");
              },
            },
            textItem("Second", 40),
          ],
        };
      },
      async getAnnotations() {
        return [widget("first", 10), widget("second", 40)];
      },
    });

    const snapshot = await extractNativePdfPageSnapshot(page, viewport);

    expect(snapshot.text).toMatchObject({
      status: "ok",
      totalItems: 2,
      invalidGeometryItems: 1,
    });
    expect(snapshot.text.items).toHaveLength(1);
    expect(pointCalls).toBe(0);
    expect(snapshot.widgets).toMatchObject({
      status: "ok",
      totalWidgets: 2,
      invalidGeometryWidgets: 1,
    });
    expect(snapshot.widgets.items).toHaveLength(1);
    expect(JSON.stringify(snapshot)).not.toContain("TEST_PRIVATE_VALUE");
    expect(JSON.stringify(snapshot)).not.toContain("TEST_PATH_VALUE");
  });

  it("uses vertical font metrics when estimating a vertical text viewport rectangle", async () => {
    const page = mockPage({
      async getTextContent() {
        return {
          styles: {
            "font-v": { vertical: true, ascent: 0.8, descent: -0.2 },
          },
          items: [{
            str: "直排",
            dir: "ttb",
            transform: [10, 0, 0, 10, 10, 180],
            width: 20,
            height: 40,
            fontName: "font-v",
            hasEOL: false,
          }],
        };
      },
    });

    const snapshot = await extractNativePdfPageSnapshot(page, mockViewport());

    expect(snapshot.text.items[0]).toMatchObject({
      text: "直排",
      vertical: true,
      viewportRectApproximate: true,
    });
    expectRectClose(snapshot.text.items[0]!.viewportRect, {
      leftPx: 16,
      topPx: 40,
      widthPx: 20,
      heightPx: 80,
    });
  });

  it("stops before consuming entries beyond per-page limits and bounds choice data", async () => {
    let thirdTextGetterReads = 0;
    let secondWidgetGetterReads = 0;
    const thirdTextItem = {
      get str() {
        thirdTextGetterReads += 1;
        return "CC";
      },
      dir: "ltr",
      transform: [10, 0, 0, 10, 50, 180],
      width: 20,
      height: 10,
      fontName: "font-1",
      hasEOL: false,
    };
    const secondWidget = {
      get subtype() {
        secondWidgetGetterReads += 1;
        return "Widget";
      },
      fieldName: "second",
      fieldType: "Tx",
      rect: [40, 20, 60, 40],
    };
    const page = mockPage({
      async getTextContent() {
        return {
          items: [
            { str: "AA", dir: "ltr", transform: [10, 0, 0, 10, 10, 180], width: 20, height: 10, fontName: "font-1", hasEOL: false },
            { str: "BB", dir: "ltr", transform: [10, 0, 0, 10, 30, 180], width: 20, height: 10, fontName: "font-1", hasEOL: false },
            thirdTextItem,
          ],
        };
      },
      async getAnnotations() {
        return [
          {
            subtype: "Widget",
            fieldName: "choice",
            fieldType: "Ch",
            rect: [10, 20, 30, 40],
            options: [
              { exportValue: "A", displayValue: "Alpha" },
              { exportValue: "B", displayValue: "Beta" },
              { exportValue: "C", displayValue: "Gamma" },
            ],
          },
          secondWidget,
        ];
      },
    });
    const budget = createNativePdfExtractionBudget({
      maxTextItemsPerPage: 2,
      maxWidgetsPerPage: 1,
      maxChoiceOptionsPerWidget: 2,
    });

    const snapshot = await extractNativePdfPageSnapshot(page, mockViewport(), budget);

    expect(snapshot.text.items.map(item => item.text)).toEqual(["AA", "BB"]);
    expect(snapshot.text.truncated).toBe(true);
    expect(thirdTextGetterReads).toBe(0);
    expect(snapshot.widgets.items).toHaveLength(1);
    expect(snapshot.widgets.truncated).toBe(true);
    expect(secondWidgetGetterReads).toBe(0);
    expect(snapshot.widgets.items[0]!.options).toEqual([
      { exportValue: "A", displayValue: "Alpha" },
      { exportValue: "B", displayValue: "Beta" },
    ]);
    expect(snapshot.widgets.items[0]!.optionsTruncated).toBe(true);
  });

  it("shares document-wide limits across pages and skips readers after exhaustion", async () => {
    const budget = createNativePdfExtractionBudget({
      maxTextItemsPerDocument: 1,
      maxTextCharsPerDocument: 10,
      maxWidgetsPerDocument: 1,
      maxChoiceOptionsPerDocument: 1,
    });
    const first = mockPage({
      async getTextContent() {
        return {
          items: [{
            str: "A",
            dir: "ltr",
            transform: [10, 0, 0, 10, 10, 180],
            width: 10,
            height: 10,
            fontName: "font-1",
            hasEOL: false,
          }],
        };
      },
      async getAnnotations() {
        return [{ subtype: "Widget", fieldName: "first", fieldType: "Tx", rect: [10, 20, 30, 40] }];
      },
    });
    let textReads = 0;
    let annotationReads = 0;
    const second = mockPage({
      async getTextContent() {
        textReads += 1;
        throw new Error("TEST_PRIVATE_VALUE");
      },
      async getAnnotations() {
        annotationReads += 1;
        throw new Error("TEST_PATH_VALUE");
      },
    });

    await extractNativePdfPageSnapshot(first, mockViewport(), budget);
    const snapshot = await extractNativePdfPageSnapshot(second, mockViewport(), budget);

    expect(textReads).toBe(0);
    expect(annotationReads).toBe(0);
    expect(snapshot.text).toMatchObject({
      status: "budget-exhausted",
      truncated: true,
      items: [],
    });
    expect(snapshot.widgets).toMatchObject({
      status: "budget-exhausted",
      truncated: true,
      items: [],
    });
    expect(snapshot.geometry.status).toBe("ok");
    expect(JSON.stringify(snapshot)).not.toContain("TEST_PRIVATE_VALUE");
    expect(JSON.stringify(snapshot)).not.toContain("TEST_PATH_VALUE");
  });

  it("enforces the aggregate text-character limit without exceeding it", async () => {
    const budget = createNativePdfExtractionBudget({ maxTextCharsPerPage: 5 });
    const page = mockPage({
      async getTextContent() {
        return {
          items: ["ABCD", "EFGH"].map((str, index) => ({
            str,
            dir: "ltr",
            transform: [10, 0, 0, 10, 10 + index * 30, 180],
            width: 20,
            height: 10,
            fontName: "font-1",
            hasEOL: false,
          })),
        };
      },
    });

    const snapshot = await extractNativePdfPageSnapshot(page, mockViewport(), budget);

    expect(snapshot.text.items.map(item => item.text)).toEqual(["ABCD", "E"]);
    expect(snapshot.text.items[1]!.textTruncated).toBe(true);
    expect(snapshot.text.truncated).toBe(true);
    expect(snapshot.text.items.reduce((sum, item) => sum + item.text.length, 0)).toBe(5);
  });

  it("preserves exact viewport geometry for CropBox, UserUnit and all right-angle rotations", async () => {
    const expectations = [
      { rotation: 0, width: 1_100, height: 1_500, transform: [5, 0, 0, -5, -125, 1_675], rect: { leftPx: 122.5, topPx: 1_072.5, widthPx: 205, heightPx: 105 }, textRect: { leftPx: 125, topPx: 379.736328125, widthPx: 33.35, heightPx: 50 } },
      { rotation: 90, width: 1_500, height: 1_100, transform: [0, 5, 5, 0, -175, -125], rect: { leftPx: 322.5, topPx: 122.5, widthPx: 105, heightPx: 205 }, textRect: { leftPx: 1_070.263671875, topPx: 125, widthPx: 50, heightPx: 33.35 } },
      { rotation: 180, width: 1_100, height: 1_500, transform: [-5, 0, 0, 5, 1_225, -175], rect: { leftPx: 772.5, topPx: 322.5, widthPx: 205, heightPx: 105 }, textRect: { leftPx: 941.65, topPx: 1_070.263671875, widthPx: 33.35, heightPx: 50 } },
      { rotation: 270, width: 1_500, height: 1_100, transform: [0, -5, -5, 0, 1_675, 1_225], rect: { leftPx: 1_072.5, topPx: 772.5, widthPx: 105, heightPx: 205 }, textRect: { leftPx: 379.736328125, topPx: 941.65, widthPx: 50, heightPx: 33.35 } },
    ];
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    const form = document.getForm();
    for (const expected of expectations) {
      const page = document.addPage([300, 400]);
      page.setCropBox(25, 35, 220, 300);
      page.setRotation(degrees(expected.rotation));
      page.node.set(PDFName.of("UserUnit"), PDFNumber.of(2.5));
      page.drawText("X", { x: 50, y: 250, size: 10, font });
      form.createTextField(`field-${expected.rotation}`).addToPage(page, {
        x: 50,
        y: 100,
        width: 40,
        height: 20,
        font,
      });
    }
    const bytes = await document.save();
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      standardFontDataUrl: fileURLToPath(new URL(
        "../../../node_modules/pdfjs-dist/standard_fonts/",
        import.meta.url
      )).replaceAll("\\", "/"),
    });
    const loaded = await loadingTask.promise;
    try {
      for (let index = 0; index < expectations.length; index += 1) {
        const expected = expectations[index]!;
        const loadedPage = await loaded.getPage(index + 1);
        const viewport = loadedPage.getViewport({ scale: 2 });
        const snapshot = await extractNativePdfPageSnapshot(loadedPage, viewport);
        const widget = snapshot.widgets.items.find(item => item.fieldName === `field-${expected.rotation}`);
        const text = snapshot.text.items.find(item => item.text === "X");

        expect(snapshot.geometry).toMatchObject({
          status: "ok",
          viewBox: [25, 35, 245, 335],
          userUnit: 2.5,
          rotation: expected.rotation,
          viewportScale: 2,
          viewportWidthPx: expected.width,
          viewportHeightPx: expected.height,
        });
        expect(snapshot.geometry.viewportTransform).toEqual(expected.transform);
        expect(widget?.sourceRect).toEqual([49.5, 99.5, 90.5, 120.5]);
        expect(widget).toBeDefined();
        expectRectClose(widget!.viewportRect, expected.rect);
        expect(text).toBeDefined();
        expectRectClose(text!.viewportRect, expected.textRect);
      }
    } finally {
      await loaded.destroy();
    }
  });

  it("reads text, CropBox-derived view geometry, rotation and AcroForm Widgets from a real synthetic PDF", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([200, 300]);
    page.setCropBox(10, 20, 180, 250);
    page.setRotation(degrees(90));
    const font = await document.embedFont(StandardFonts.Helvetica);
    page.drawText("Native PDF", { x: 30, y: 245, size: 12, font });
    const form = document.getForm();
    form.createTextField("profile.name").addToPage(page, {
      x: 30,
      y: 190,
      width: 80,
      height: 18,
      font,
    });
    form.createCheckBox("consent").addToPage(page, {
      x: 30,
      y: 160,
      width: 12,
      height: 12,
    });
    const radio = form.createRadioGroup("choice.radio");
    radio.addOptionToPage("alpha", page, { x: 50, y: 130, width: 12, height: 12 });
    radio.addOptionToPage("beta", page, { x: 80, y: 130, width: 12, height: 12 });
    radio.select("beta");
    const dropdown = form.createDropdown("choice.dropdown");
    dropdown.addOptions(["One", "Two"]);
    dropdown.enableEditing();
    dropdown.select("Two");
    dropdown.addToPage(page, { x: 30, y: 100, width: 100, height: 18, font });
    const list = form.createOptionList("choice.list");
    list.addOptions(["A", "B", "C"]);
    list.enableMultiselect();
    list.select(["A", "C"]);
    list.addToPage(page, { x: 30, y: 45, width: 100, height: 40, font });
    const bytes = await document.save();
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      standardFontDataUrl: fileURLToPath(new URL(
        "../../../node_modules/pdfjs-dist/standard_fonts/",
        import.meta.url
      )).replaceAll("\\", "/"),
    });
    const loaded = await loadingTask.promise;
    try {
      const loadedPage = await loaded.getPage(1);
      const viewport = loadedPage.getViewport({ scale: 2 });
      const snapshot = await extractNativePdfPageSnapshot(loadedPage, viewport);

      expect(snapshot.geometry.status).toBe("ok");
      expect(snapshot.geometry.rotation).toBe(90);
      expect(snapshot.geometry.viewBox).toEqual([10, 20, 190, 270]);
      expect(snapshot.geometry.viewportWidthPx).toBeCloseTo(viewport.width, 8);
      expect(snapshot.geometry.viewportHeightPx).toBeCloseTo(viewport.height, 8);
      expect(snapshot.text.status).toBe("ok");
      expect(snapshot.text.items.some(item => item.text.includes("Native PDF"))).toBe(true);
      expect(snapshot.widgets.status).toBe("ok");
      expect(snapshot.widgets.items.map(item => item.fieldName)).toEqual(
        expect.arrayContaining([
          "profile.name",
          "consent",
          "choice.radio",
          "choice.dropdown",
          "choice.list",
        ])
      );
      const radioWidgets = snapshot.widgets.items.filter(item => item.fieldName === "choice.radio");
      expect(radioWidgets).toHaveLength(2);
      expect(radioWidgets.every(item => item.radioButton && !item.checkBox)).toBe(true);
      expect(radioWidgets.map(item => item.buttonValue)).toEqual(["0", "1"]);
      expect(snapshot.widgets.items.find(item => item.fieldName === "consent")).toMatchObject({
        fieldType: "Btn",
        checkBox: true,
        radioButton: false,
        exportValue: "Yes",
      });
      expect(snapshot.widgets.items.find(item => item.fieldName === "choice.dropdown")).toMatchObject({
        fieldType: "Ch",
        comboBox: true,
        choiceEditable: true,
        multiSelect: false,
        options: [
          { exportValue: "One", displayValue: "One" },
          { exportValue: "Two", displayValue: "Two" },
        ],
      });
      expect(snapshot.widgets.items.find(item => item.fieldName === "choice.list")).toMatchObject({
        fieldType: "Ch",
        comboBox: false,
        choiceEditable: false,
        multiSelect: true,
        options: [
          { exportValue: "A", displayValue: "A" },
          { exportValue: "B", displayValue: "B" },
          { exportValue: "C", displayValue: "C" },
        ],
      });
      for (const item of [...snapshot.text.items, ...snapshot.widgets.items]) {
        expect(Number.isFinite(item.viewportRect.leftPx)).toBe(true);
        expect(Number.isFinite(item.viewportRect.topPx)).toBe(true);
        expect(item.viewportRect.widthPx).toBeGreaterThanOrEqual(0);
        expect(item.viewportRect.heightPx).toBeGreaterThanOrEqual(0);
      }
      for (const widget of snapshot.widgets.items) {
        expect(widget).not.toHaveProperty("fieldValue");
        expect(widget).not.toHaveProperty("defaultFieldValue");
        expect(widget).not.toHaveProperty("actions");
      }
    } finally {
      await loaded.destroy();
    }
  });
});
