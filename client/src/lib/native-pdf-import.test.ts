import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { fileURLToPath } from "node:url";
import { labelFormStructures, type FormStructure, type PositionedWord } from "./form-structure";
import {
  nativePdfDraftFields,
  nativePdfFieldCandidatePlan,
  nativePdfFieldCandidates,
  nativePdfTextPlan,
  removeNativeWidgetDuplicates,
} from "./native-pdf-import";
import type {
  NativePdfPageSnapshot,
  NativePdfTextItem,
  NativePdfWidget,
} from "./native-pdf";
import { extractNativePdfPageSnapshot } from "./native-pdf";
import { toCanvasFields } from "./product-types";

function textItem(
  text: string,
  leftPx: number,
  topPx: number,
  widthPx = 50,
  heightPx = 12,
  overrides: Partial<NativePdfTextItem> = {}
): NativePdfTextItem {
  return {
    text,
    textTruncated: false,
    direction: "ltr",
    fontName: "font-1",
    vertical: false,
    hasEol: false,
    sourceWidth: widthPx / 2,
    sourceHeight: heightPx / 2,
    sourceTransform: [10, 0, 0, 10, leftPx / 2, topPx / 2],
    viewportRect: { leftPx, topPx, widthPx, heightPx },
    viewportRectApproximate: true,
    ...overrides,
  };
}

function widget(
  fieldName: string,
  fieldType: string,
  leftPx: number,
  topPx: number,
  widthPx: number,
  heightPx: number,
  overrides: Partial<NativePdfWidget> = {}
): NativePdfWidget {
  return {
    annotationId: `annotation-${fieldName}-${leftPx}`,
    fieldName,
    alternativeText: "",
    fieldType,
    annotationType: 20,
    annotationFlags: 4,
    fieldFlags: null,
    sourceRect: [leftPx / 2, topPx / 2, (leftPx + widthPx) / 2, (topPx + heightPx) / 2],
    viewportRect: { leftPx, topPx, widthPx, heightPx },
    rotation: 0,
    readOnly: false,
    required: false,
    hidden: false,
    choiceEditable: false,
    multiLine: false,
    comb: false,
    maxLength: null,
    password: false,
    checkBox: false,
    radioButton: false,
    pushButton: false,
    comboBox: false,
    multiSelect: false,
    buttonValue: "",
    exportValue: "",
    metadataTruncated: false,
    options: [],
    optionsTruncated: false,
    ...overrides,
  };
}

function snapshot(
  textItems: NativePdfTextItem[] = [],
  widgets: NativePdfWidget[] = []
): NativePdfPageSnapshot {
  return {
    version: 1,
    geometry: {
      status: "ok",
      viewBox: [0, 0, 100, 150],
      userUnit: 1,
      rotation: 0,
      viewportScale: 2,
      viewportWidthPx: 200,
      viewportHeightPx: 300,
      viewportTransform: [2, 0, 0, -2, 0, 300],
    },
    text: {
      status: "ok",
      totalItems: textItems.length,
      invalidGeometryItems: 0,
      truncated: false,
      items: textItems,
    },
    widgets: {
      status: "ok",
      totalAnnotations: widgets.length,
      totalWidgets: widgets.length,
      invalidGeometryWidgets: 0,
      truncated: false,
      items: widgets,
    },
  };
}

describe("native PDF import planning", () => {
  it("uses sufficiently distributed native text as positioned labels without OCR", () => {
    const plan = nativePdfTextPlan(snapshot([
      textItem("Full Name:", 10, 30, 55, 12),
      textItem("Email Address:", 10, 100, 70, 12),
    ]), 200, 300);

    expect(plan.usableInsteadOfOcr).toBe(true);
    expect(plan.words).toEqual([
      { text: "Full Name:", confidence: 99, left: 10, top: 30, width: 55, height: 12 },
      { text: "Email Address:", confidence: 99, left: 10, top: 100, width: 70, height: 12 },
    ]);
    const [labelled] = labelFormStructures([
      { kind: "text-box", left: 80, top: 28, width: 90, height: 20, confidence: 0.99 },
    ], plan.words);
    expect(labelled?.label).toBe("Full Name");
  });

  it("keeps low-quality, failed, truncated, or mismatched native text on the OCR fallback path", () => {
    const watermark = snapshot([textItem("CONFIDENTIAL", 60, 120, 80, 20)]);
    expect(nativePdfTextPlan(watermark, 200, 300)).toMatchObject({
      usableInsteadOfOcr: false,
      words: [{ text: "CONFIDENTIAL" }],
    });

    const failed = snapshot([textItem("Name", 10, 10)]);
    failed.text.status = "failed";
    expect(nativePdfTextPlan(failed, 200, 300)).toEqual({
      words: [],
      usableInsteadOfOcr: false,
    });

    const truncated = snapshot([
      textItem("First Label", 10, 10),
      textItem("Second Label", 10, 80),
    ]);
    truncated.text.truncated = true;
    expect(nativePdfTextPlan(truncated, 200, 300).usableInsteadOfOcr).toBe(false);
    expect(nativePdfTextPlan(truncated, 200, 300).words).toEqual([]);

    expect(nativePdfTextPlan(snapshot([
      textItem("First Label", 10, 10),
      textItem("Second Label", 10, 80),
    ]), 220, 300)).toEqual({ words: [], usableInsteadOfOcr: false });

    const controlHeavy = snapshot([
      textItem(`Name${"\u0001".repeat(20)}`, 10, 10),
      textItem(`Email${"\u0002".repeat(20)}`, 10, 80),
    ]);
    expect(nativePdfTextPlan(controlHeavy, 200, 300).usableInsteadOfOcr).toBe(false);

    const locallyTruncated = snapshot([
      textItem("First Label", 10, 10),
      textItem("Second Label", 10, 80, 50, 12, { textTruncated: true }),
    ]);
    expect(nativePdfTextPlan(locallyTruncated, 200, 300).usableInsteadOfOcr).toBe(false);
  });

  it("maps supported Widgets to exact unconfirmed draft suggestions", () => {
    const source = snapshot([], [
      widget("Full Name", "Tx", 20, 20, 100, 18, { required: true, maxLength: 60 }),
      widget("Notes", "Tx", 20, 55, 140, 45, { multiLine: true }),
      widget("Reference Code", "Tx", 20, 115, 120, 20, { comb: true, maxLength: 8 }),
      widget("Accept Terms", "Btn", 20, 150, 14, 14, { checkBox: true, exportValue: "Yes" }),
      widget("Department", "Ch", 20, 185, 120, 22, {
        comboBox: true,
        options: [
          { exportValue: "ENG", displayValue: "Engineering" },
          { exportValue: "OPS", displayValue: "Operations" },
        ],
      }),
      widget("Approval Signature", "Sig", 20, 230, 120, 35),
    ]);

    const candidates = nativePdfFieldCandidates(source, 200, 300, []);
    expect(candidates.map(candidate => candidate.fieldType)).toEqual([
      "text",
      "textarea",
      "characterBox",
      "checkbox",
      "select",
      "signature",
    ]);
    expect(candidates[0]).toMatchObject({
      label: "Full Name",
      required: true,
      maxLength: 60,
      left: 20,
      top: 20,
      width: 100,
      height: 18,
    });
    expect(candidates[2]).toMatchObject({ maxLength: 8, boxCount: 8 });
    expect(candidates[4]?.options).toEqual(["Engineering", "Operations"]);

    let nextId = 0;
    const fields = nativePdfDraftFields(
      candidates,
      { page: 1, widthMm: 100, heightMm: 150, pixelWidth: 200, pixelHeight: 300 },
      0,
      () => `field-test-${++nextId}`
    );
    expect(fields[0]).toMatchObject({
      stableFieldId: "field-test-1",
      fieldType: "text",
      definition: {
        confirmed: false,
        aiSuggested: true,
        aiConfidence: 0.99,
        required: true,
        detectionSource: "native-pdf:widget:Tx",
      },
      coordinate: { page: 1, xMm: 10, yMm: 10, widthMm: 50, heightMm: 9 },
    });
    expect(fields[0]?.definition).not.toHaveProperty("defaultValue");
    expect(toCanvasFields(fields, [{ page: 1, widthMm: 100, heightMm: 150, rotation: 0 }])[0])
      .toMatchObject({ status: "needs-review", confirmed: false });
  });

  it("groups radio Widgets, derives human option labels, and never exposes button values", () => {
    const words: PositionedWord[] = [
      { text: "Contact method:", confidence: 99, left: 45, top: 62, width: 95, height: 14 },
      { text: "Email", confidence: 99, left: 68, top: 99, width: 35, height: 12 },
      { text: "Phone", confidence: 99, left: 143, top: 99, width: 40, height: 12 },
    ];
    const source = snapshot([], [
      widget("contact.method", "Btn", 50, 100, 12, 12, {
        radioButton: true,
        buttonValue: "TEST_PRIVATE_VALUE",
      }),
      widget("contact.method", "Btn", 125, 100, 12, 12, {
        radioButton: true,
        buttonValue: "TEST_TOKEN_VALUE",
      }),
    ]);

    const candidates = nativePdfFieldCandidates(source, 200, 300, words);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      fieldType: "radio",
      label: "Contact method",
      options: ["Email", "Phone"],
      left: 50,
      top: 100,
      width: 87,
      height: 12,
    });
    expect(candidates[0]?.detectionGroup).toHaveLength(2);
    expect(candidates[0]?.optionMarks.map(mark => mark.option)).toEqual(["Email", "Phone"]);
    expect(JSON.stringify(candidates)).not.toContain("TEST_PRIVATE_VALUE");
    expect(JSON.stringify(candidates)).not.toContain("TEST_TOKEN_VALUE");
  });

  it("rejects Widgets that cannot be represented faithfully or safely", () => {
    const source = snapshot([], [
      widget("Hidden", "Tx", 10, 10, 80, 20, { hidden: true }),
      widget("Invisible", "Tx", 10, 40, 80, 20, { annotationFlags: 2 }),
      widget("Read only", "Tx", 10, 70, 80, 20, { readOnly: true }),
      widget("Password", "Tx", 10, 100, 80, 20, { password: true }),
      widget("Action", "Btn", 10, 130, 80, 20, { pushButton: true }),
      widget("Editable choice", "Ch", 10, 160, 80, 20, {
        comboBox: true,
        choiceEditable: true,
        options: [{ exportValue: "A", displayValue: "A" }],
      }),
      widget("Multiple choice", "Ch", 10, 190, 80, 20, {
        multiSelect: true,
        options: [{ exportValue: "A", displayValue: "A" }],
      }),
      widget("Truncated", "Tx", 10, 220, 80, 20, { metadataTruncated: true }),
    ]);

    expect(nativePdfFieldCandidates(source, 200, 300, [])).toEqual([]);
    source.widgets.truncated = true;
    expect(nativePdfFieldCandidates(source, 200, 300, [])).toEqual([]);

    const oversizedRadio = snapshot([], Array.from({ length: 201 }, (_, index) =>
      widget("Oversized radio", "Btn", 10 + (index % 20) * 8, 10 + Math.floor(index / 20) * 8, 6, 6, {
        radioButton: true,
      })
    ));
    expect(nativePdfFieldCandidates(oversizedRadio, 200, 300, [])).toEqual([]);
  });

  it("reports the 500-field cap and completes a radio group at the boundary", () => {
    const overLimit = snapshot([], Array.from({ length: 501 }, (_, index) =>
      widget(`Field ${index + 1}`, "Tx", 10, 10, 80, 20)
    ));
    const overLimitPlan = nativePdfFieldCandidatePlan(overLimit, 200, 300, []);
    expect(overLimitPlan.candidates).toHaveLength(500);
    expect(overLimitPlan.truncated).toBe(true);

    const boundaryRadio = snapshot([], [
      ...Array.from({ length: 499 }, (_, index) =>
        widget(`Field ${index + 1}`, "Tx", 10, 10, 80, 20)
      ),
      widget("Boundary radio", "Btn", 20, 80, 12, 12, {
        radioButton: true,
        exportValue: "A",
      }),
      widget("Boundary radio", "Btn", 50, 80, 12, 12, {
        radioButton: true,
        exportValue: "B",
      }),
    ]);
    const boundaryPlan = nativePdfFieldCandidatePlan(boundaryRadio, 200, 300, []);
    expect(boundaryPlan.candidates).toHaveLength(500);
    expect(boundaryPlan.candidates.filter(candidate => candidate.fieldType === "radio"))
      .toHaveLength(1);
    expect(boundaryPlan.truncated).toBe(false);
  });

  it("prefers exact native Widgets over only comparable overlapping image structures", () => {
    const [nativeField] = nativePdfFieldCandidates(snapshot([], [
      widget("Name", "Tx", 80, 40, 90, 22),
    ]), 200, 300, []);
    const structures: FormStructure[] = [
      { kind: "text-box", left: 81, top: 41, width: 88, height: 20, confidence: 0.9 },
      { kind: "checkbox", left: 20, top: 100, width: 14, height: 14, confidence: 0.9 },
      { kind: "table", left: 20, top: 30, width: 160, height: 180, confidence: 0.9 },
    ];

    expect(removeNativeWidgetDuplicates(structures, [nativeField!])).toEqual([
      structures[1],
      structures[2],
    ]);
  });

  it("maps real synthetic radio Widgets using their neighbouring PDF text", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([420, 594]);
    const font = await document.embedFont(StandardFonts.Helvetica);
    const form = document.getForm();
    page.drawText("NATIVE REGISTRATION FORM", { x: 40, y: 550, size: 16, font });
    page.drawText("Contact method:", { x: 40, y: 375, size: 11, font });
    page.drawText("Email", { x: 180, y: 345, size: 10, font });
    page.drawText("Phone", { x: 265, y: 345, size: 10, font });
    const radio = form.createRadioGroup("Contact method");
    radio.addOptionToPage("email", page, { x: 150, y: 338, width: 16, height: 16 });
    radio.addOptionToPage("phone", page, { x: 235, y: 338, width: 16, height: 16 });
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
      const native = await extractNativePdfPageSnapshot(loadedPage, viewport);
      const plan = nativePdfTextPlan(native, Math.ceil(viewport.width), Math.ceil(viewport.height));
      const candidates = nativePdfFieldCandidates(
        native,
        Math.ceil(viewport.width),
        Math.ceil(viewport.height),
        plan.words
      );
      expect(candidates.find(candidate => candidate.fieldType === "radio")?.options)
        .toEqual(["Email", "Phone"]);
    } finally {
      await loaded.destroy();
    }
  });
});
