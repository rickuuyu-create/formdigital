const DEFAULT_LIMITS = Object.freeze({
  maxTextCandidatesPerPage: 10_000,
  maxTextItemsPerPage: 5_000,
  maxTextCharsPerPage: 250_000,
  maxAnnotationsPerPage: 5_000,
  maxWidgetsPerPage: 2_000,
  maxWidgetMetadataCharsPerPage: 100_000,
  maxChoiceOptionsPerWidget: 200,
  maxChoiceOptionsPerPage: 2_000,
  maxChoiceCharsPerPage: 100_000,
  maxPagesPerDocument: 500,
  maxTextCandidatesPerDocument: 50_000,
  maxTextItemsPerDocument: 20_000,
  maxTextCharsPerDocument: 1_000_000,
  maxAnnotationsPerDocument: 20_000,
  maxWidgetsPerDocument: 5_000,
  maxWidgetMetadataCharsPerDocument: 500_000,
  maxChoiceOptionsPerDocument: 10_000,
  maxChoiceCharsPerDocument: 500_000,
  maxReadMillisecondsPerPage: 5_000,
  maxReadMillisecondsPerDocument: 15_000,
  maxTextItemLength: 2_048,
  maxMetadataValueLength: 512,
});

const PDF_FIELD_FLAG_EDIT = 1 << 18;

type ExtractionStatus = "ok" | "failed" | "budget-exhausted";
type Tuple4 = [number, number, number, number];
type Tuple6 = [number, number, number, number, number, number];
type NativePdfExtractionLimits = {
  [Key in keyof typeof DEFAULT_LIMITS]: number;
};

export type NativePdfExtractionBudget = {
  readonly limits: NativePdfExtractionLimits;
  remaining: {
    pages: number;
    textCandidates: number;
    textItems: number;
    textChars: number;
    annotations: number;
    widgets: number;
    widgetMetadataChars: number;
    choiceOptions: number;
    choiceChars: number;
    readMilliseconds: number;
  };
};

export type NativePdfViewportRect = {
  leftPx: number;
  topPx: number;
  widthPx: number;
  heightPx: number;
};

export type NativePdfTextItem = {
  text: string;
  textTruncated: boolean;
  direction: string;
  fontName: string;
  vertical: boolean;
  hasEol: boolean;
  sourceWidth: number;
  sourceHeight: number;
  sourceTransform: Tuple6;
  viewportRect: NativePdfViewportRect;
  viewportRectApproximate: true;
};

export type NativePdfChoiceOption = {
  exportValue: string;
  displayValue: string;
};

export type NativePdfWidget = {
  annotationId: string;
  fieldName: string;
  alternativeText: string;
  fieldType: string;
  annotationType: number | null;
  annotationFlags: number | null;
  fieldFlags: number | null;
  sourceRect: Tuple4;
  viewportRect: NativePdfViewportRect;
  rotation: number;
  readOnly: boolean;
  required: boolean;
  hidden: boolean;
  choiceEditable: boolean;
  multiLine: boolean;
  comb: boolean;
  maxLength: number | null;
  password: boolean;
  checkBox: boolean;
  radioButton: boolean;
  pushButton: boolean;
  comboBox: boolean;
  multiSelect: boolean;
  buttonValue: string;
  exportValue: string;
  metadataTruncated: boolean;
  options: NativePdfChoiceOption[];
  optionsTruncated: boolean;
};

export type NativePdfPageSnapshot = {
  version: 1;
  geometry: {
    status: "ok" | "invalid";
    viewBox: Tuple4;
    userUnit: number;
    rotation: number;
    viewportScale: number;
    viewportWidthPx: number;
    viewportHeightPx: number;
    viewportTransform: Tuple6;
  };
  text: {
    status: ExtractionStatus;
    totalItems: number;
    invalidGeometryItems: number;
    truncated: boolean;
    items: NativePdfTextItem[];
  };
  widgets: {
    status: ExtractionStatus;
    totalAnnotations: number;
    totalWidgets: number;
    invalidGeometryWidgets: number;
    truncated: boolean;
    items: NativePdfWidget[];
  };
};

export type NativePdfPageSource = {
  readonly view: number[];
  readonly userUnit: number;
  readonly rotate: number;
  getTextContent(): Promise<{ items: unknown[]; styles?: unknown }>;
  getAnnotations(options?: { intent?: string }): Promise<unknown[]>;
};

export type NativePdfViewportSource = {
  readonly scale: number;
  readonly width: number;
  readonly height: number;
  readonly rotation: number;
  readonly transform: number[];
  convertToViewportPoint(x: number, y: number): unknown;
  convertToViewportRectangle(rect: number[]): unknown;
};

function limitedOverride(value: unknown, defaultValue: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(defaultValue, Math.floor(value)))
    : defaultValue;
}

export function createNativePdfExtractionBudget(
  overrides: Partial<Record<keyof NativePdfExtractionLimits, number>> = {}
): NativePdfExtractionBudget {
  const limits = Object.freeze(Object.fromEntries(
    Object.entries(DEFAULT_LIMITS).map(([key, defaultValue]) => [
      key,
      limitedOverride(overrides[key as keyof NativePdfExtractionLimits], defaultValue),
    ])
  )) as NativePdfExtractionLimits;
  return {
    limits,
    remaining: {
      pages: limits.maxPagesPerDocument,
      textCandidates: limits.maxTextCandidatesPerDocument,
      textItems: limits.maxTextItemsPerDocument,
      textChars: limits.maxTextCharsPerDocument,
      annotations: limits.maxAnnotationsPerDocument,
      widgets: limits.maxWidgetsPerDocument,
      widgetMetadataChars: limits.maxWidgetMetadataCharsPerDocument,
      choiceOptions: limits.maxChoiceOptionsPerDocument,
      choiceChars: limits.maxChoiceCharsPerDocument,
      readMilliseconds: limits.maxReadMillisecondsPerDocument,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function finiteTuple(value: unknown, length: 4): Tuple4 | null;
function finiteTuple(value: unknown, length: 6): Tuple6 | null;
function finiteTuple(value: unknown, length: 4 | 6): Tuple4 | Tuple6 | null {
  if (!Array.isArray(value) || value.length !== length) return null;
  const numbers = value.map(finiteNumber);
  if (numbers.some(number => number === null)) return null;
  return numbers as Tuple4 | Tuple6;
}

function boundedString(value: unknown, maximum: number) {
  if (typeof value !== "string") return { value: "", truncated: false, consumed: 0 };
  const boundedMaximum = Math.max(0, Math.floor(maximum));
  const result = value.slice(0, boundedMaximum);
  return {
    value: result,
    truncated: value.length > boundedMaximum,
    consumed: result.length,
  };
}

function safeArray(value: unknown): unknown[] | null {
  try {
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function viewportRect(value: unknown): NativePdfViewportRect | null {
  const coordinates = finiteTuple(value, 4);
  if (!coordinates) return null;
  const [x1, y1, x2, y2] = coordinates;
  return {
    leftPx: Math.min(x1, x2),
    topPx: Math.min(y1, y2),
    widthPx: Math.abs(x2 - x1),
    heightPx: Math.abs(y2 - y1),
  };
}

function finitePoint(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const x = finiteNumber(value[0]);
  const y = finiteNumber(value[1]);
  return x === null || y === null ? null : [x, y];
}

function multiplyTransforms(first: Tuple6, second: Tuple6): Tuple6 {
  return [
    first[0] * second[0] + first[2] * second[1],
    first[1] * second[0] + first[3] * second[1],
    first[0] * second[2] + first[2] * second[3],
    first[1] * second[2] + first[3] * second[3],
    first[0] * second[4] + first[2] * second[5] + first[4],
    first[1] * second[4] + first[3] * second[5] + first[5],
  ];
}

function convertTextRect(
  sourceTransform: Tuple6,
  sourceWidth: number,
  sourceHeight: number,
  viewport: NativePdfViewportSource,
  vertical: boolean,
  ascentRatio: number
): NativePdfViewportRect | null {
  try {
    const viewportTransform = finiteTuple(viewport.transform, 6);
    if (!viewportTransform) return null;
    const transformed = multiplyTransforms(viewportTransform, sourceTransform);
    const sourceInlineMagnitude = vertical
      ? Math.hypot(sourceTransform[2], sourceTransform[3])
      : Math.hypot(sourceTransform[0], sourceTransform[1]);
    const viewportInlineMagnitude = vertical
      ? Math.hypot(transformed[2], transformed[3])
      : Math.hypot(transformed[0], transformed[1]);
    const fontHeight = Math.hypot(transformed[2], transformed[3]);
    if (sourceInlineMagnitude <= 0 || viewportInlineMagnitude <= 0 || fontHeight <= 0) return null;
    let angle = Math.atan2(transformed[1], transformed[0]);
    if (vertical) angle += Math.PI / 2;
    const inlineSourceLength = vertical ? Math.abs(sourceHeight) : Math.abs(sourceWidth);
    const inlineLength = inlineSourceLength * viewportInlineMagnitude / sourceInlineMagnitude;
    const safeAscentRatio = Math.max(0, Math.min(1, ascentRatio));
    const fontAscent = fontHeight * safeAscentRatio;
    const originX = transformed[4] + fontAscent * Math.sin(angle);
    const originY = transformed[5] - fontAscent * Math.cos(angle);
    const inlineX = Math.cos(angle) * inlineLength;
    const inlineY = Math.sin(angle) * inlineLength;
    const blockX = -Math.sin(angle) * fontHeight;
    const blockY = Math.cos(angle) * fontHeight;
    const points = [
      [originX, originY],
      [originX + inlineX, originY + inlineY],
      [originX + blockX, originY + blockY],
      [originX + inlineX + blockX, originY + inlineY + blockY],
    ];
    if (points.some(point => !finitePoint(point))) return null;
    const xs = points.map(point => point[0]!);
    const ys = points.map(point => point[1]!);
    const leftPx = Math.min(...xs);
    const topPx = Math.min(...ys);
    return {
      leftPx,
      topPx,
      widthPx: Math.max(...xs) - leftPx,
      heightPx: Math.max(...ys) - topPx,
    };
  } catch {
    return null;
  }
}

function snapshotTextItem(
  value: unknown,
  viewport: NativePdfViewportSource,
  styles: unknown,
  maximumTextChars: number,
  maximumItemLength: number
): { item: NativePdfTextItem; consumedTextChars: number; truncated: boolean } | null {
  try {
    const item = asRecord(value);
    if (!item || typeof item.str !== "string") return null;
    const sourceTransform = finiteTuple(item.transform, 6);
    const sourceWidth = finiteNumber(item.width);
    const sourceHeight = finiteNumber(item.height);
    if (!sourceTransform || sourceWidth === null || sourceHeight === null) return null;
    const direction = boundedString(item.dir, 16).value;
    const fontName = boundedString(item.fontName, 128).value;
    let vertical = direction === "ttb";
    const styleMap = asRecord(styles);
    const fontStyle = styleMap && fontName ? asRecord(styleMap[fontName]) : null;
    if (fontStyle?.vertical === true) vertical = true;
    const styleAscent = finiteNumber(fontStyle?.ascent);
    const styleDescent = finiteNumber(fontStyle?.descent);
    const ascentRatio = styleAscent !== null && styleAscent > 0
      ? styleAscent
      : styleDescent !== null && styleDescent < 0
        ? 1 + styleDescent
        : 0.8;
    const rect = convertTextRect(
      sourceTransform,
      sourceWidth,
      sourceHeight,
      viewport,
      vertical,
      ascentRatio
    );
    if (!rect) return null;
    const text = boundedString(item.str, Math.min(maximumItemLength, maximumTextChars));
    return {
      item: {
        text: text.value,
        textTruncated: text.truncated,
        direction,
        fontName,
        vertical,
        hasEol: item.hasEOL === true,
        sourceWidth,
        sourceHeight,
        sourceTransform,
        viewportRect: rect,
        viewportRectApproximate: true,
      },
      consumedTextChars: text.consumed,
      truncated: text.truncated,
    };
  } catch {
    return null;
  }
}

type PageWidgetBudget = {
  metadataChars: number;
  choiceOptions: number;
  choiceChars: number;
};

function takeWidgetString(
  value: unknown,
  maximum: number,
  pageBudget: PageWidgetBudget,
  documentBudget: NativePdfExtractionBudget
) {
  const available = Math.min(
    maximum,
    pageBudget.metadataChars,
    documentBudget.remaining.widgetMetadataChars
  );
  const result = boundedString(value, available);
  pageBudget.metadataChars -= result.consumed;
  documentBudget.remaining.widgetMetadataChars -= result.consumed;
  return result;
}

function takeChoiceString(
  value: unknown,
  maximum: number,
  pageBudget: PageWidgetBudget,
  documentBudget: NativePdfExtractionBudget
) {
  const available = Math.min(
    maximum,
    pageBudget.choiceChars,
    documentBudget.remaining.choiceChars
  );
  const result = boundedString(value, available);
  pageBudget.choiceChars -= result.consumed;
  documentBudget.remaining.choiceChars -= result.consumed;
  return result;
}

function snapshotChoiceOptions(
  value: unknown,
  pageBudget: PageWidgetBudget,
  documentBudget: NativePdfExtractionBudget
) {
  const candidates = safeArray(value);
  if (!candidates) return { options: [], truncated: false };
  const options: NativePdfChoiceOption[] = [];
  let inspected = 0;
  let truncated = false;
  while (
    inspected < candidates.length &&
    inspected < documentBudget.limits.maxChoiceOptionsPerWidget &&
    pageBudget.choiceOptions > 0 &&
    documentBudget.remaining.choiceOptions > 0
  ) {
    const candidate = candidates[inspected];
    inspected += 1;
    pageBudget.choiceOptions -= 1;
    documentBudget.remaining.choiceOptions -= 1;
    try {
      if (typeof candidate === "string") {
        const exportValue = takeChoiceString(
          candidate,
          documentBudget.limits.maxMetadataValueLength,
          pageBudget,
          documentBudget
        );
        const displayValue = takeChoiceString(
          candidate,
          documentBudget.limits.maxMetadataValueLength,
          pageBudget,
          documentBudget
        );
        truncated ||= exportValue.truncated || displayValue.truncated;
        options.push({ exportValue: exportValue.value, displayValue: displayValue.value });
        continue;
      }
      const record = asRecord(candidate);
      if (!record) continue;
      const exportValue = takeChoiceString(
        record.exportValue,
        documentBudget.limits.maxMetadataValueLength,
        pageBudget,
        documentBudget
      );
      const displayValue = takeChoiceString(
        record.displayValue,
        documentBudget.limits.maxMetadataValueLength,
        pageBudget,
        documentBudget
      );
      truncated ||= exportValue.truncated || displayValue.truncated;
      options.push({ exportValue: exportValue.value, displayValue: displayValue.value });
    } catch {
      truncated = true;
    }
  }
  return {
    options,
    truncated: truncated || inspected < candidates.length,
  };
}

function snapshotWidget(
  value: unknown,
  viewport: NativePdfViewportSource,
  pageBudget: PageWidgetBudget,
  documentBudget: NativePdfExtractionBudget
) {
  try {
    const annotation = asRecord(value);
    if (!annotation || annotation.subtype !== "Widget") return null;
    const sourceRect = finiteTuple(annotation.rect, 4);
    if (!sourceRect) return { invalidGeometry: true as const };
    const rect = viewportRect(viewport.convertToViewportRectangle(sourceRect));
    if (!rect) return { invalidGeometry: true as const };
    const takeMetadata = (
      candidate: unknown,
      maximum: number = documentBudget.limits.maxMetadataValueLength
    ) =>
      takeWidgetString(candidate, maximum, pageBudget, documentBudget);
    const annotationId = takeMetadata(annotation.id);
    const fieldName = takeMetadata(annotation.fieldName);
    const alternativeText = takeMetadata(annotation.alternativeText);
    const fieldType = takeMetadata(annotation.fieldType, 32);
    const buttonValue = takeMetadata(annotation.buttonValue);
    const exportValue = takeMetadata(annotation.exportValue);
    const options = snapshotChoiceOptions(annotation.options, pageBudget, documentBudget);
    const fieldFlags = finiteNumber(annotation.fieldFlags);
    return {
      invalidGeometry: false as const,
      widget: {
        annotationId: annotationId.value,
        fieldName: fieldName.value,
        alternativeText: alternativeText.value,
        fieldType: fieldType.value,
        annotationType: finiteNumber(annotation.annotationType),
        annotationFlags: finiteNumber(annotation.annotationFlags),
        fieldFlags,
        sourceRect,
        viewportRect: rect,
        rotation: finiteNumber(annotation.rotation) ?? 0,
        readOnly: annotation.readOnly === true,
        required: annotation.required === true,
        hidden: annotation.hidden === true,
        choiceEditable: annotation.isEditable === true ||
          (fieldFlags !== null && (fieldFlags & PDF_FIELD_FLAG_EDIT) !== 0),
        multiLine: annotation.multiLine === true,
        comb: annotation.comb === true,
        maxLength: finiteNumber(annotation.maxLen),
        password: annotation.password === true,
        checkBox: annotation.checkBox === true,
        radioButton: annotation.radioButton === true,
        pushButton: annotation.pushButton === true,
        comboBox: annotation.combo === true || annotation.comboBox === true,
        multiSelect: annotation.multiSelect === true,
        buttonValue: buttonValue.value,
        exportValue: exportValue.value,
        metadataTruncated: [
          annotationId,
          fieldName,
          alternativeText,
          fieldType,
          buttonValue,
          exportValue,
        ].some(result => result.truncated),
        options: options.options,
        optionsTruncated: options.truncated,
      } satisfies NativePdfWidget,
    };
  } catch {
    return { invalidGeometry: true as const };
  }
}

async function safelyRead<T>(reader: () => Promise<T>, timeoutMilliseconds: number) {
  if (timeoutMilliseconds <= 0) return { status: "failed" as const, value: null };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(reader)
        .then(value => ({ status: "ok" as const, value }))
        .catch(() => ({ status: "failed" as const, value: null })),
      new Promise<{ status: "failed"; value: null }>(resolve => {
        timeout = setTimeout(
          () => resolve({ status: "failed", value: null }),
          timeoutMilliseconds
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function geometrySnapshot(page: NativePdfPageSource, viewport: NativePdfViewportSource) {
  try {
    const viewBox = finiteTuple(page.view, 4);
    const viewportTransform = finiteTuple(viewport.transform, 6);
    const userUnit = finiteNumber(page.userUnit);
    const rotation = finiteNumber(page.rotate);
    const viewportScale = finiteNumber(viewport.scale);
    const viewportWidthPx = finiteNumber(viewport.width);
    const viewportHeightPx = finiteNumber(viewport.height);
    const valid = viewBox && viewportTransform && userUnit !== null && userUnit > 0 &&
      rotation !== null && viewportScale !== null && viewportScale > 0 &&
      viewportWidthPx !== null && viewportWidthPx >= 0 &&
      viewportHeightPx !== null && viewportHeightPx >= 0;
    return {
      status: valid ? "ok" as const : "invalid" as const,
      viewBox: viewBox ?? [0, 0, 0, 0] as Tuple4,
      userUnit: userUnit ?? 1,
      rotation: rotation ?? 0,
      viewportScale: viewportScale ?? 1,
      viewportWidthPx: viewportWidthPx ?? 0,
      viewportHeightPx: viewportHeightPx ?? 0,
      viewportTransform: viewportTransform ?? [1, 0, 0, 1, 0, 0] as Tuple6,
    };
  } catch {
    return {
      status: "invalid" as const,
      viewBox: [0, 0, 0, 0] as Tuple4,
      userUnit: 1,
      rotation: 0,
      viewportScale: 1,
      viewportWidthPx: 0,
      viewportHeightPx: 0,
      viewportTransform: [1, 0, 0, 1, 0, 0] as Tuple6,
    };
  }
}

function failedPageSnapshot(
  page: NativePdfPageSource,
  viewport: NativePdfViewportSource
): NativePdfPageSnapshot {
  return {
    version: 1,
    geometry: geometrySnapshot(page, viewport),
    text: {
      status: "failed",
      totalItems: 0,
      invalidGeometryItems: 0,
      truncated: false,
      items: [],
    },
    widgets: {
      status: "failed",
      totalAnnotations: 0,
      totalWidgets: 0,
      invalidGeometryWidgets: 0,
      truncated: false,
      items: [],
    },
  };
}

function emptyTextSnapshot(status: ExtractionStatus, truncated = false) {
  return {
    status,
    totalItems: 0,
    invalidGeometryItems: 0,
    truncated,
    items: [] as NativePdfTextItem[],
  };
}

function emptyWidgetSnapshot(status: ExtractionStatus, truncated = false) {
  return {
    status,
    totalAnnotations: 0,
    totalWidgets: 0,
    invalidGeometryWidgets: 0,
    truncated,
    items: [] as NativePdfWidget[],
  };
}

async function extractTextSnapshot(
  page: NativePdfPageSource,
  viewport: NativePdfViewportSource,
  documentBudget: NativePdfExtractionBudget,
  deadlineMilliseconds: number
): Promise<NativePdfPageSnapshot["text"]> {
  const canRead = documentBudget.remaining.textCandidates > 0 &&
    documentBudget.remaining.textItems > 0 &&
    documentBudget.remaining.textChars > 0;
  if (!canRead) return emptyTextSnapshot("budget-exhausted", true);
  const result = await safelyRead(
    () => page.getTextContent(),
    Math.max(0, deadlineMilliseconds - Date.now())
  );
  if (result.status === "failed") return emptyTextSnapshot("failed");
  try {
    const textContent = asRecord(result.value);
    const sourceItems = textContent ? safeArray(textContent.items) : null;
    if (!sourceItems) return emptyTextSnapshot("failed");
    const textStyles = textContent?.styles;
    const items: NativePdfTextItem[] = [];
    let totalItems = 0;
    let invalidGeometryItems = 0;
    let truncated = false;
    let inspectedCandidates = 0;
    let remainingPageTextChars = documentBudget.limits.maxTextCharsPerPage;
    while (
      inspectedCandidates < sourceItems.length &&
      inspectedCandidates < documentBudget.limits.maxTextCandidatesPerPage &&
      documentBudget.remaining.textCandidates > 0 &&
      items.length < documentBudget.limits.maxTextItemsPerPage &&
      documentBudget.remaining.textItems > 0 &&
      remainingPageTextChars > 0 &&
      documentBudget.remaining.textChars > 0
    ) {
      const candidate = sourceItems[inspectedCandidates];
      inspectedCandidates += 1;
      documentBudget.remaining.textCandidates -= 1;
      let isTextItem = false;
      try {
        const record = asRecord(candidate);
        isTextItem = Boolean(record && typeof record.str === "string");
      } catch {
        invalidGeometryItems += 1;
        continue;
      }
      if (!isTextItem) continue;
      totalItems += 1;
      const item = snapshotTextItem(
        candidate,
        viewport,
        textStyles,
        Math.min(remainingPageTextChars, documentBudget.remaining.textChars),
        documentBudget.limits.maxTextItemLength
      );
      if (!item) {
        invalidGeometryItems += 1;
        continue;
      }
      items.push(item.item);
      documentBudget.remaining.textItems -= 1;
      remainingPageTextChars -= item.consumedTextChars;
      documentBudget.remaining.textChars -= item.consumedTextChars;
      truncated ||= item.truncated;
    }
    return {
      status: "ok",
      totalItems,
      invalidGeometryItems,
      truncated: truncated || inspectedCandidates < sourceItems.length,
      items,
    };
  } catch {
    return emptyTextSnapshot("failed");
  }
}

async function extractWidgetSnapshot(
  page: NativePdfPageSource,
  viewport: NativePdfViewportSource,
  documentBudget: NativePdfExtractionBudget,
  deadlineMilliseconds: number
): Promise<NativePdfPageSnapshot["widgets"]> {
  const canRead = documentBudget.remaining.annotations > 0 &&
    documentBudget.remaining.widgets > 0;
  if (!canRead) return emptyWidgetSnapshot("budget-exhausted", true);
  const result = await safelyRead(
    () => page.getAnnotations({ intent: "display" }),
    Math.max(0, deadlineMilliseconds - Date.now())
  );
  if (result.status === "failed") return emptyWidgetSnapshot("failed");
  try {
    const annotations = safeArray(result.value);
    if (!annotations) return emptyWidgetSnapshot("failed");
    const items: NativePdfWidget[] = [];
    let inspectedAnnotations = 0;
    let totalWidgets = 0;
    let invalidGeometryWidgets = 0;
    let truncated = false;
    const pageWidgetBudget: PageWidgetBudget = {
      metadataChars: documentBudget.limits.maxWidgetMetadataCharsPerPage,
      choiceOptions: documentBudget.limits.maxChoiceOptionsPerPage,
      choiceChars: documentBudget.limits.maxChoiceCharsPerPage,
    };
    while (
      inspectedAnnotations < annotations.length &&
      inspectedAnnotations < documentBudget.limits.maxAnnotationsPerPage &&
      documentBudget.remaining.annotations > 0 &&
      items.length < documentBudget.limits.maxWidgetsPerPage &&
      documentBudget.remaining.widgets > 0
    ) {
      const candidate = annotations[inspectedAnnotations];
      inspectedAnnotations += 1;
      documentBudget.remaining.annotations -= 1;
      let isWidget = false;
      try {
        const record = asRecord(candidate);
        isWidget = Boolean(record && record.subtype === "Widget");
      } catch {
        invalidGeometryWidgets += 1;
        continue;
      }
      if (!isWidget) continue;
      totalWidgets += 1;
      const item = snapshotWidget(candidate, viewport, pageWidgetBudget, documentBudget);
      if (!item || item.invalidGeometry) {
        invalidGeometryWidgets += 1;
        continue;
      }
      items.push(item.widget);
      documentBudget.remaining.widgets -= 1;
      truncated ||= item.widget.metadataTruncated || item.widget.optionsTruncated;
    }
    return {
      status: "ok",
      totalAnnotations: annotations.length,
      totalWidgets,
      invalidGeometryWidgets,
      truncated: truncated || inspectedAnnotations < annotations.length,
      items,
    };
  } catch {
    return emptyWidgetSnapshot("failed");
  }
}

export async function extractNativePdfPageSnapshot(
  page: NativePdfPageSource,
  viewport: NativePdfViewportSource,
  documentBudget = createNativePdfExtractionBudget()
): Promise<NativePdfPageSnapshot> {
  try {
    const geometry = geometrySnapshot(page, viewport);
    if (
      documentBudget.remaining.pages <= 0 ||
      documentBudget.remaining.readMilliseconds <= 0
    ) {
      return {
        version: 1,
        geometry,
        text: emptyTextSnapshot("budget-exhausted", true),
        widgets: emptyWidgetSnapshot("budget-exhausted", true),
      };
    }
    documentBudget.remaining.pages -= 1;
    const startedAt = Date.now();
    const pageReadMilliseconds = Math.min(
      documentBudget.limits.maxReadMillisecondsPerPage,
      documentBudget.remaining.readMilliseconds
    );
    const deadline = startedAt + pageReadMilliseconds;
    const text = await extractTextSnapshot(page, viewport, documentBudget, deadline);
    const widgets = await extractWidgetSnapshot(page, viewport, documentBudget, deadline);
    documentBudget.remaining.readMilliseconds = Math.max(
      0,
      documentBudget.remaining.readMilliseconds - Math.max(0, Date.now() - startedAt)
    );
    return { version: 1, geometry, text, widgets };
  } catch {
    return failedPageSnapshot(page, viewport);
  }
}
