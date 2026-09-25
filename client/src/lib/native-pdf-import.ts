import type {
  DetectedFieldBox,
  DetectedOptionMark,
  FieldType,
} from "./form-model";
import {
  labelFormStructures,
  type FormStructure,
  type PositionedWord,
} from "./form-structure";
import type {
  NativePdfPageSnapshot,
  NativePdfViewportRect,
  NativePdfWidget,
} from "./native-pdf";

const NATIVE_TEXT_CONFIDENCE = 99;
const NATIVE_WIDGET_CONFIDENCE = 0.99;
const MAX_POSITIONED_WORDS = 2_000;
const MAX_NATIVE_FIELDS_PER_PAGE = 500;
const MAX_RADIO_OPTIONS = 200;
const MAX_TEXT_LENGTH = 10_000;
const MAX_COMB_LENGTH = 128;
const HIDDEN_ANNOTATION_FLAGS = 1 | 2 | 32;

type PixelRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type NativePdfTextPlan = {
  words: PositionedWord[];
  usableInsteadOfOcr: boolean;
};

export type NativePdfFieldCandidate = PixelRect & {
  fieldType: FieldType;
  label: string;
  confidence: number;
  required: boolean;
  options: string[];
  maxLength?: number;
  boxCount?: number;
  detectionSource: string;
  detectionGroup: DetectedFieldBox[];
  optionMarks: DetectedOptionMark[];
};

export type NativePdfFieldCandidatePlan = {
  candidates: NativePdfFieldCandidate[];
  truncated: boolean;
};

export type NativePdfDraftPage = {
  page: number;
  widthMm: number;
  heightMm: number;
  pixelWidth: number;
  pixelHeight: number;
};

function finitePositive(value: number) {
  return Number.isFinite(value) && value > 0;
}

function compatibleViewport(
  snapshot: NativePdfPageSnapshot,
  pixelWidth: number,
  pixelHeight: number
) {
  return (
    snapshot.geometry.status === "ok" &&
    finitePositive(pixelWidth) &&
    finitePositive(pixelHeight) &&
    Math.abs(snapshot.geometry.viewportWidthPx - pixelWidth) <= 2 &&
    Math.abs(snapshot.geometry.viewportHeightPx - pixelHeight) <= 2
  );
}

function clippedRect(
  rect: NativePdfViewportRect,
  pixelWidth: number,
  pixelHeight: number
): PixelRect | null {
  const { leftPx, topPx, widthPx, heightPx } = rect;
  if (
    ![leftPx, topPx, widthPx, heightPx].every(Number.isFinite) ||
    widthPx <= 0 ||
    heightPx <= 0
  )
    return null;
  const right = leftPx + widthPx;
  const bottom = topPx + heightPx;
  const left = Math.max(0, leftPx);
  const top = Math.max(0, topPx);
  const clippedRight = Math.min(pixelWidth, right);
  const clippedBottom = Math.min(pixelHeight, bottom);
  const width = clippedRight - left;
  const height = clippedBottom - top;
  if (width <= 0 || height <= 0) return null;
  const visibleRatio = (width * height) / (widthPx * heightPx);
  return visibleRatio >= 0.5 ? { left, top, width, height } : null;
}

function cleanText(value: string) {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function printableCounts(value: string) {
  let total = 0;
  let printable = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charAt(index);
    if (/\s/.test(character)) continue;
    total += 1;
    const code = value.charCodeAt(index);
    const nonPrintable =
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0xd800 && code <= 0xdfff) ||
      (code >= 0xe000 && code <= 0xf8ff) ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2060 && code <= 0x206f) ||
      code === 0xfeff;
    if (!nonPrintable) printable += 1;
  }
  return { total, printable };
}

function distinctWordKey(word: PositionedWord) {
  const round = (value: number) => Math.round(value * 2) / 2;
  return [
    word.text,
    round(word.left),
    round(word.top),
    round(word.width),
    round(word.height),
  ].join("|");
}

export function nativePdfTextPlan(
  snapshot: NativePdfPageSnapshot | undefined,
  pixelWidth: number,
  pixelHeight: number
): NativePdfTextPlan {
  if (
    !snapshot ||
    !compatibleViewport(snapshot, pixelWidth, pixelHeight) ||
    snapshot.text.status !== "ok" ||
    snapshot.text.truncated
  )
    return { words: [], usableInsteadOfOcr: false };

  const words: PositionedWord[] = [];
  const seen = new Set<string>();
  let totalCharacters = 0;
  let printableCharacters = 0;
  let locallyTruncated = false;
  for (const item of snapshot.text.items) {
    if (words.length >= MAX_POSITIONED_WORDS) {
      locallyTruncated = true;
      break;
    }
    if (item.textTruncated) {
      locallyTruncated = true;
      continue;
    }
    const text = cleanText(item.text);
    if (!text) continue;
    const counts = printableCounts(item.text);
    if (!counts.total || counts.printable / counts.total < 0.9) continue;
    const rect = clippedRect(item.viewportRect, pixelWidth, pixelHeight);
    if (!rect) continue;
    const word = {
      text,
      confidence: NATIVE_TEXT_CONFIDENCE,
      ...rect,
    } satisfies PositionedWord;
    const key = distinctWordKey(word);
    if (seen.has(key)) continue;
    seen.add(key);
    words.push(word);
    totalCharacters += counts.total;
    printableCharacters += counts.printable;
  }
  words.sort((left, right) =>
    left.top - right.top || left.left - right.left || left.text.localeCompare(right.text)
  );

  const totalItems = Math.max(0, snapshot.text.totalItems);
  const validGeometryRatio = totalItems > 0
    ? snapshot.text.items.length / totalItems
    : 0;
  const centers = words.map(word => ({
    x: word.left + word.width / 2,
    y: word.top + word.height / 2,
  }));
  const horizontalSpan = centers.length
    ? Math.max(...centers.map(point => point.x)) - Math.min(...centers.map(point => point.x))
    : 0;
  const verticalSpan = centers.length
    ? Math.max(...centers.map(point => point.y)) - Math.min(...centers.map(point => point.y))
    : 0;
  const spatiallyDistributed =
    Math.max(horizontalSpan, verticalSpan) >= Math.max(6, Math.min(pixelWidth, pixelHeight) * 0.01);
  const usableInsteadOfOcr =
    words.length >= 2 &&
    printableCharacters >= 8 &&
    totalCharacters > 0 &&
    printableCharacters / totalCharacters >= 0.9 &&
    validGeometryRatio >= 0.8 &&
    spatiallyDistributed &&
    !locallyTruncated;

  return { words, usableInsteadOfOcr };
}

function widgetIsHidden(widget: NativePdfWidget) {
  return widget.hidden || (
    widget.annotationFlags !== null &&
    (widget.annotationFlags & HIDDEN_ANNOTATION_FLAGS) !== 0
  );
}

function eligibleWidget(
  widget: NativePdfWidget,
  pixelWidth: number,
  pixelHeight: number
) {
  if (
    widget.readOnly ||
    widget.password ||
    widget.pushButton ||
    widgetIsHidden(widget) ||
    widget.metadataTruncated ||
    widget.optionsTruncated
  )
    return null;
  const rect = clippedRect(widget.viewportRect, pixelWidth, pixelHeight);
  return rect && rect.width >= 1 && rect.height >= 1 ? rect : null;
}

function cleanLabel(value: string) {
  return cleanText(value).replace(/[:：]$/, "").trim().slice(0, 160);
}

function fieldNameLabel(value: string) {
  const cleaned = cleanLabel(value);
  const segments = cleaned.split(/[./\\[\]]+/).filter(Boolean);
  return (segments.at(-1) ?? cleaned).replace(/[_-]+/g, " ").trim();
}

function nearbyLabel(
  rect: PixelRect,
  kind: FormStructure["kind"],
  words: PositionedWord[],
  members?: PixelRect[]
) {
  const [labelled] = labelFormStructures([
    {
      kind,
      ...rect,
      confidence: NATIVE_WIDGET_CONFIDENCE,
      ...(members ? { members } : {}),
    },
  ], words);
  return {
    label: labelled && labelled.labelConfidence > 0
      ? cleanLabel(labelled.label)
      : "",
    options: labelled?.options ?? [],
  };
}

function widgetLabel(
  widget: NativePdfWidget,
  rect: PixelRect,
  words: PositionedWord[],
  kind: FormStructure["kind"] = "text-box"
) {
  const nearby = nearbyLabel(rect, kind, words);
  return {
    label:
      cleanLabel(widget.alternativeText) ||
      nearby.label ||
      fieldNameLabel(widget.fieldName) ||
      "未命名欄位",
    nearbyOptions: nearby.options,
  };
}

function boundedLength(widget: NativePdfWidget) {
  const value = widget.maxLength;
  return value !== null && Number.isInteger(value) && value > 0 && value <= MAX_TEXT_LENGTH
    ? value
    : undefined;
}

function choiceOptions(widget: NativePdfWidget) {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const option of widget.options) {
    const label = cleanLabel(option.displayValue || option.exportValue);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    result.push(label);
  }
  return result;
}

function singleWidgetCandidate(
  widget: NativePdfWidget,
  rect: PixelRect,
  words: PositionedWord[]
): NativePdfFieldCandidate | null {
  let fieldType: FieldType;
  let maxLength: number | undefined;
  let boxCount: number | undefined;
  let options: string[] = [];

  if (widget.fieldType === "Tx") {
    maxLength = boundedLength(widget);
    if (widget.comb && maxLength && maxLength <= MAX_COMB_LENGTH) {
      fieldType = "characterBox";
      boxCount = maxLength;
    } else fieldType = widget.multiLine ? "textarea" : "text";
  } else if (widget.fieldType === "Btn" && widget.checkBox && !widget.radioButton) {
    fieldType = "checkbox";
  } else if (
    widget.fieldType === "Ch" &&
    !widget.multiSelect &&
    !widget.choiceEditable
  ) {
    options = choiceOptions(widget);
    if (!options.length) return null;
    fieldType = "select";
  } else if (widget.fieldType === "Sig") {
    fieldType = "signature";
  } else return null;

  const { label } = widgetLabel(
    widget,
    rect,
    words,
    fieldType === "checkbox" ? "checkbox" : "text-box"
  );
  return {
    ...rect,
    fieldType,
    label,
    confidence: NATIVE_WIDGET_CONFIDENCE,
    required: widget.required,
    options,
    ...(maxLength ? { maxLength } : {}),
    ...(boxCount ? { boxCount } : {}),
    detectionSource: `native-pdf:widget:${widget.fieldType || "unknown"}`,
    detectionGroup: [],
    optionMarks: [],
  };
}

function unionRects(rectangles: PixelRect[]) {
  const left = Math.min(...rectangles.map(rect => rect.left));
  const top = Math.min(...rectangles.map(rect => rect.top));
  const right = Math.max(...rectangles.map(rect => rect.left + rect.width));
  const bottom = Math.max(...rectangles.map(rect => rect.top + rect.height));
  return { left, top, width: right - left, height: bottom - top };
}

function radioOptionLabels(
  widgets: Array<{ widget: NativePdfWidget; rect: PixelRect }>,
  nearbyOptions: string[]
) {
  const labels: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < widgets.length; index += 1) {
    const widget = widgets[index]!.widget;
    const nearby = cleanLabel(nearbyOptions[index] ?? "");
    const exported = cleanLabel(widget.exportValue);
    let label = nearby || exported;
    if (!label || seen.has(label)) label = `選項 ${index + 1}`;
    while (seen.has(label)) label = `${label} ${index + 1}`;
    seen.add(label);
    labels.push(label);
  }
  return labels;
}

function radioCandidate(
  widgets: Array<{ widget: NativePdfWidget; rect: PixelRect }>,
  words: PositionedWord[]
): NativePdfFieldCandidate | null {
  if (widgets.length < 2 || widgets.length > MAX_RADIO_OPTIONS) return null;
  const rect = unionRects(widgets.map(item => item.rect));
  const first = widgets[0]!.widget;
  const nearby = nearbyLabel(rect, "radio", words, widgets.map(item => item.rect));
  const options = radioOptionLabels(widgets, nearby.options);
  const label =
    cleanLabel(first.alternativeText) ||
    nearby.label ||
    fieldNameLabel(first.fieldName) ||
    "未命名單選";
  const detectionGroup = widgets.map(item => ({
    xRatio: (item.rect.left - rect.left) / rect.width,
    yRatio: (item.rect.top - rect.top) / rect.height,
    widthRatio: item.rect.width / rect.width,
    heightRatio: item.rect.height / rect.height,
  }));
  return {
    ...rect,
    fieldType: "radio",
    label,
    confidence: NATIVE_WIDGET_CONFIDENCE,
    required: widgets.some(item => item.widget.required),
    options,
    detectionSource: "native-pdf:widget:Btn-radio",
    detectionGroup,
    optionMarks: detectionGroup.map((mark, index) => ({
      ...mark,
      option: options[index]!,
    })),
  };
}

export function nativePdfFieldCandidatePlan(
  snapshot: NativePdfPageSnapshot | undefined,
  pixelWidth: number,
  pixelHeight: number,
  words: PositionedWord[]
): NativePdfFieldCandidatePlan {
  if (
    !snapshot ||
    !compatibleViewport(snapshot, pixelWidth, pixelHeight) ||
    snapshot.widgets.status !== "ok" ||
    snapshot.widgets.truncated
  )
    return { candidates: [], truncated: false };

  const singles: NativePdfFieldCandidate[] = [];
  const radios = new Map<string, Array<{ widget: NativePdfWidget; rect: PixelRect }>>();
  const seenWidgets = new Set<string>();
  for (const widget of snapshot.widgets.items) {
    const rect = eligibleWidget(widget, pixelWidth, pixelHeight);
    if (!rect) continue;
    const identity = [
      widget.fieldType,
      widget.fieldName,
      rect.left,
      rect.top,
      rect.width,
      rect.height,
    ].join("|");
    if (seenWidgets.has(identity)) continue;
    seenWidgets.add(identity);
    if (widget.fieldType === "Btn" && widget.radioButton && !widget.checkBox) {
      const groupName = cleanLabel(widget.fieldName);
      if (!groupName) continue;
      const group = radios.get(groupName) ?? [];
      group.push({ widget, rect });
      radios.set(groupName, group);
      continue;
    }
    const candidate = singleWidgetCandidate(widget, rect, words);
    if (candidate) singles.push(candidate);
  }
  for (const group of Array.from(radios.values())) {
    const candidate = radioCandidate(group, words);
    if (candidate) singles.push(candidate);
  }
  singles.sort((left, right) => left.top - right.top || left.left - right.left);
  return {
    candidates: singles.slice(0, MAX_NATIVE_FIELDS_PER_PAGE),
    truncated: singles.length > MAX_NATIVE_FIELDS_PER_PAGE,
  };
}

export function nativePdfFieldCandidates(
  snapshot: NativePdfPageSnapshot | undefined,
  pixelWidth: number,
  pixelHeight: number,
  words: PositionedWord[]
) {
  return nativePdfFieldCandidatePlan(snapshot, pixelWidth, pixelHeight, words).candidates;
}

export function nativePdfDraftFields(
  candidates: NativePdfFieldCandidate[],
  page: NativePdfDraftPage,
  pageIndex: number,
  createStableFieldId: () => string = () =>
    `field-${crypto.randomUUID().slice(0, 8)}`
) {
  if (
    !finitePositive(page.widthMm) ||
    !finitePositive(page.heightMm) ||
    !finitePositive(page.pixelWidth) ||
    !finitePositive(page.pixelHeight)
  )
    return [];
  return candidates.slice(0, MAX_NATIVE_FIELDS_PER_PAGE).map((candidate, index) => ({
    stableFieldId: createStableFieldId(),
    fieldType: candidate.fieldType,
    displayOrder: pageIndex * 100 + index,
    definition: {
      label: candidate.label,
      confirmed: false,
      aiSuggested: true,
      aiConfidence: candidate.confidence,
      required: candidate.required,
      placeholder: "",
      options: candidate.options,
      maxLength: candidate.maxLength ?? null,
      boxCount: candidate.boxCount ?? null,
      fontSizePt: 10,
      align: "left" as const,
      overflow: "warn" as const,
      detectionSource: candidate.detectionSource,
      detectionGroup: candidate.detectionGroup,
      optionMarks: candidate.optionMarks,
    },
    coordinate: {
      page: page.page,
      xMm: (candidate.left / page.pixelWidth) * page.widthMm,
      yMm: (candidate.top / page.pixelHeight) * page.heightMm,
      widthMm: Math.max(
        0.5,
        (candidate.width / page.pixelWidth) * page.widthMm
      ),
      heightMm: Math.max(
        0.5,
        (candidate.height / page.pixelHeight) * page.heightMm
      ),
      fontSizePt: 10,
      align: "left" as const,
    },
  }));
}

function intersectionArea(left: PixelRect, right: PixelRect) {
  const width = Math.min(left.left + left.width, right.left + right.width) -
    Math.max(left.left, right.left);
  const height = Math.min(left.top + left.height, right.top + right.height) -
    Math.max(left.top, right.top);
  return Math.max(0, width) * Math.max(0, height);
}

function comparableKinds(structure: FormStructure, field: NativePdfFieldCandidate) {
  if (field.fieldType === "checkbox") return structure.kind === "checkbox";
  if (field.fieldType === "radio") return structure.kind === "radio";
  if (field.fieldType === "characterBox") return structure.kind === "character-box";
  return structure.kind === "text-box" || structure.kind === "underline";
}

export function removeNativeWidgetDuplicates(
  structures: FormStructure[],
  nativeFields: NativePdfFieldCandidate[]
) {
  return structures.filter(structure => !nativeFields.some(field => {
    if (!comparableKinds(structure, field)) return false;
    const structureArea = structure.width * structure.height;
    const fieldArea = field.width * field.height;
    if (structureArea <= 0 || fieldArea <= 0) return false;
    const sizeRatio = Math.max(structureArea, fieldArea) /
      Math.min(structureArea, fieldArea);
    if (sizeRatio > 4) return false;
    return intersectionArea(structure, field) / Math.min(structureArea, fieldArea) >= 0.72;
  }));
}
