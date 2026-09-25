import type {
  DetectedFieldBox,
  DetectedOptionMark,
  FieldType,
} from "./form-model";
import type { LabelledFormStructure } from "./form-structure";
import { TEXT_BLANK_SOURCE } from "./label-fields";
import { importCellRects, validImportCellGuides } from "./import-table-geometry";

export type TableCellPosition = { row: number; column: number };

export type FusedDetectionCandidate = {
  tableCellGuides?: DetectedFieldBox[];
  fieldType: FieldType;
  label: string;
  confidence: number;
  /** Label-aware suggestion strength; falls back to `confidence`. */
  aiConfidence?: number;
  required: boolean;
  options: string[];
  maxLength?: number;
  boxCount?: number;
  segmentCapacities?: number[];
  maxRows?: number;
  tableColumns?: number;
  tableWritableCells?: TableCellPosition[];
  detectionSource: string;
  detectionGroup: DetectedFieldBox[];
  optionMarks: DetectedOptionMark[];
  left: number;
  top: number;
  width: number;
  height: number;
};

export type FusionInput = {
  tableCellGuides?: DetectedFieldBox[];
  fieldType: FieldType;
  label: string;
  confidence: number;
  aiConfidence?: number | null;
  required?: boolean;
  options?: string[];
  maxLength?: number | null;
  boxCount?: number | null;
  segmentCapacities?: number[] | null;
  maxRows?: number | null;
  tableColumns?: number | null;
  tableWritableCells?: TableCellPosition[] | null;
  detectionSource: string;
  detectionGroup: DetectedFieldBox[];
  optionMarks: DetectedOptionMark[];
  left: number;
  top: number;
  width: number;
  height: number;
};

/**
 * Per-page ceiling on accepted suggestions. Applied after validation and
 * de-duplication so a page full of duplicates never hides unique fields.
 */
export const MAX_FUSED_CANDIDATES_PER_PAGE = 500;

/**
 * Second, document-wide ceiling. It exists only to bound memory across very
 * long documents; reaching it is reported to the caller so the UI can say the
 * suggestion list is partial instead of dropping later pages silently.
 */
export const MAX_SUGGESTED_FIELDS_PER_DOCUMENT = 5_000;

const TEXT_LIKE: FieldType[] = ["text", "textarea", "number", "date", "time"];

function finiteAt(value: number) {
  return Number.isFinite(value) && value >= 0;
}

function validCandidate(candidate: FusionInput) {
  return (
    finiteAt(candidate.left) &&
    finiteAt(candidate.top) &&
    Number.isFinite(candidate.width) &&
    Number.isFinite(candidate.height) &&
    candidate.width > 0 &&
    candidate.height > 0 &&
    Number.isFinite(candidate.confidence) &&
    candidate.confidence > 0 &&
    candidate.confidence <= 1
  );
}

function positiveInteger(value: number | null | undefined) {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function cellPositions(value: TableCellPosition[] | null | undefined) {
  if (!Array.isArray(value)) return undefined;
  const cells = value.flatMap(cell =>
    cell &&
    Number.isInteger(cell.row) &&
    Number.isInteger(cell.column) &&
    cell.row >= 0 &&
    cell.column >= 0
      ? [{ row: cell.row, column: cell.column }]
      : []
  );
  return cells.length ? cells : undefined;
}

/**
 * Rebuild each accepted candidate from known keys only. Callers may hand in
 * richer objects; nothing unrecognised — a pre-set `confirmed` flag above all
 * — is allowed to ride through into a draft field.
 */
function sanitize(candidate: FusionInput): FusedDetectionCandidate {
  const aiConfidence =
    typeof candidate.aiConfidence === "number" &&
    Number.isFinite(candidate.aiConfidence) &&
    candidate.aiConfidence > 0 &&
    candidate.aiConfidence <= 1
      ? candidate.aiConfidence
      : undefined;
  const segmentCapacities = Array.isArray(candidate.segmentCapacities)
    ? candidate.segmentCapacities.filter(
        count => Number.isInteger(count) && count > 0
      )
    : [];
  const writableCells = cellPositions(candidate.tableWritableCells);
  return {
    fieldType: candidate.fieldType,
    label: candidate.label,
    confidence: candidate.confidence,
    ...(aiConfidence !== undefined ? { aiConfidence } : {}),
    required: candidate.required === true,
    options: Array.isArray(candidate.options)
      ? candidate.options.map(String)
      : [],
    ...(positiveInteger(candidate.maxLength) !== undefined
      ? { maxLength: positiveInteger(candidate.maxLength)! }
      : {}),
    ...(positiveInteger(candidate.boxCount) !== undefined
      ? { boxCount: positiveInteger(candidate.boxCount)! }
      : {}),
    ...(segmentCapacities.length ? { segmentCapacities } : {}),
    ...(positiveInteger(candidate.maxRows) !== undefined
      ? { maxRows: positiveInteger(candidate.maxRows)! }
      : {}),
    ...(positiveInteger(candidate.tableColumns) !== undefined
      ? { tableColumns: positiveInteger(candidate.tableColumns)! }
      : {}),
    ...(writableCells ? { tableWritableCells: writableCells } : {}),
    tableCellGuides: validImportCellGuides(candidate.tableCellGuides, candidate.maxRows, candidate.tableColumns),
    detectionSource: candidate.detectionSource,
    detectionGroup: Array.isArray(candidate.detectionGroup)
      ? candidate.detectionGroup
      : [],
    optionMarks: Array.isArray(candidate.optionMarks)
      ? candidate.optionMarks
      : [],
    left: candidate.left,
    top: candidate.top,
    width: candidate.width,
    height: candidate.height,
  };
}

function intersectionArea(
  left: FusedDetectionCandidate,
  right: FusedDetectionCandidate
) {
  const width =
    Math.min(left.left + left.width, right.left + right.width) -
    Math.max(left.left, right.left);
  const height =
    Math.min(left.top + left.height, right.top + right.height) -
    Math.max(left.top, right.top);
  return Math.max(0, width) * Math.max(0, height);
}

/**
 * Field kinds that describe the same free-text geometry. A box or a rule only
 * becomes "date" or "number" through a label heuristic, so those must not
 * survive twice; a select, signature, checkbox, radio, character box, or table
 * carries different semantics and is always kept.
 */
function sameKind(left: FieldType, right: FieldType) {
  if (left === right) return true;
  return TEXT_LIKE.includes(left) && TEXT_LIKE.includes(right);
}

function sourceFamily(detectionSource: string) {
  return detectionSource.startsWith("native-pdf:") ? "native" : "local";
}

/** The traced shape behind a local candidate, e.g. "text-box" or "checkbox". */
function tracedKind(detectionSource: string) {
  return detectionSource.startsWith("local-structure:")
    ? detectionSource.slice("local-structure:".length)
    : null;
}

/**
 * A plain traced rectangle or rule carries no type information — its field
 * type comes from a label guess — so it describes the same field as whatever
 * widget sits on it. Traced checkboxes, radios, character boxes, and tables do
 * carry shape information and stay separate from unrelated widget types.
 */
function tracedGeometryMatchesWidget(
  left: FusedDetectionCandidate,
  right: FusedDetectionCandidate
) {
  const leftTraced = tracedKind(left.detectionSource);
  const rightTraced = tracedKind(right.detectionSource);
  const traced =
    leftTraced && sourceFamily(right.detectionSource) === "native"
      ? leftTraced
      : rightTraced && sourceFamily(left.detectionSource) === "native"
        ? rightTraced
        : null;
  if (!traced) return false;
  const widget = leftTraced ? right : left;
  if (widget.fieldType === "checkbox") return traced === "checkbox";
  if (widget.fieldType === "radio") return traced === "radio";
  if (widget.fieldType === "characterBox") return traced === "character-box";
  return traced === "text-box" || traced === "underline";
}

function duplicate(
  candidate: FusedDetectionCandidate,
  accepted: FusedDetectionCandidate[]
) {
  // A text-layer blank only says "there is writable space after this label".
  // Once a widget or traced shape is already placed inside that space, the
  // blank adds nothing but a duplicate row.
  if (
    candidate.detectionSource === TEXT_BLANK_SOURCE &&
    accepted.some(existing => {
      // Compare on the writing line: a blank is only as tall as its label
      // text, so a taller widget sitting on the same row still belongs to it.
      const sharedWidth =
        Math.min(candidate.left + candidate.width, existing.left + existing.width) -
        Math.max(candidate.left, existing.left);
      const sharedHeight =
        Math.min(candidate.top + candidate.height, existing.top + existing.height) -
        Math.max(candidate.top, existing.top);
      if (
        existing.width > 0 &&
        sharedHeight > 0 &&
        sharedWidth >= existing.width * 0.5
      )
        return true;
      // A widget that carries the same label but sits on the next line — a
      // radio group under its heading, for example — is the same field.
      const label = candidate.label.trim();
      if (!label || existing.label.trim() !== label) return false;
      const verticalGap = Math.max(
        candidate.top - (existing.top + existing.height),
        existing.top - (candidate.top + candidate.height)
      );
      return verticalGap <= candidate.height * 3;
    })
  )
    return true;

  return accepted.some(existing => {
    // Suppress erroneous text candidates that cross multiple columns of an accepted table
    if (
      existing.fieldType === "table" &&
      TEXT_LIKE.includes(candidate.fieldType)
    ) {
      const cells = importCellRects({ ...existing, rows: existing.maxRows, columns: existing.tableColumns, cellGuides: existing.tableCellGuides });
      const inside = cells?.some(cell => candidate.left >= cell.left - 1 && candidate.left + candidate.width <= cell.right + 1 &&
        candidate.top >= cell.top - 1 && candidate.top + candidate.height <= cell.bottom + 1);
      if (inside) return false;
      if (cells) {
        const overlaps = cells.filter(cell => Math.min(candidate.left + candidate.width, cell.right) - Math.max(candidate.left, cell.left) > 1 &&
          Math.min(candidate.top + candidate.height, cell.bottom) - Math.max(candidate.top, cell.top) > 1);
        const distinct = new Set(overlaps.map(c => `${c.left},${c.top},${c.right},${c.bottom}`));
        if (distinct.size > 1) return true;
        return false;
      }
      // Without real cell geometry, only suppress text spanning the entire table.
      // Inferring internal boundaries from a column count destroys legal wide cells.
      const tableCols =
        existing.tableColumns && existing.tableColumns > 0
          ? existing.tableColumns
          : 1;
      const colWidth = existing.width;
      const overlapW =
        Math.min(candidate.left + candidate.width, existing.left + existing.width) -
        Math.max(candidate.left, existing.left);
      const overlapH =
        Math.min(candidate.top + candidate.height, existing.top + existing.height) -
        Math.max(candidate.top, existing.top);
      if (overlapH > 0 && tableCols > 1 && overlapW >= colWidth * 0.95) {
        return true;
      }
    }

    if (
      !sameKind(existing.fieldType, candidate.fieldType) &&
      !tracedGeometryMatchesWidget(existing, candidate)
    )
      return false;
    const candidateArea = candidate.width * candidate.height;
    const existingArea = existing.width * existing.height;
    if (candidateArea <= 0 || existingArea <= 0) return false;
    const sizeRatio =
      Math.max(candidateArea, existingArea) /
      Math.max(1, Math.min(candidateArea, existingArea));
    // Native widget rectangles and traced geometry describe the same field at
    // noticeably different sizes, so cross-source pairs get a wider allowance.
    const sizeLimit =
      sourceFamily(existing.detectionSource) ===
      sourceFamily(candidate.detectionSource)
        ? 2.2
        : 4;
    if (sizeRatio > sizeLimit) return false;
    return (
      intersectionArea(candidate, existing) /
        Math.min(candidateArea, existingArea) >=
      0.7
    );
  });
}

function byStrength(
  left: FusedDetectionCandidate,
  right: FusedDetectionCandidate
) {
  return (
    right.confidence - left.confidence ||
    left.top - right.top ||
    left.left - right.left ||
    left.width - right.width ||
    left.height - right.height ||
    left.fieldType.localeCompare(right.fieldType) ||
    left.detectionSource.localeCompare(right.detectionSource) ||
    left.label.localeCompare(right.label)
  );
}

function byReadingOrder(
  left: FusedDetectionCandidate,
  right: FusedDetectionCandidate
) {
  return (
    left.top - right.top ||
    left.left - right.left ||
    left.width - right.width ||
    left.height - right.height ||
    left.fieldType.localeCompare(right.fieldType) ||
    left.detectionSource.localeCompare(right.detectionSource) ||
    left.label.localeCompare(right.label)
  );
}

/**
 * Fuse complementary detectors by confidence, then reading order. Stronger
 * overlapping candidates win; local structure fills gaps. Validation and
 * de-duplication run before the page ceiling, so `truncated` only means more
 * than `MAX_FUSED_CANDIDATES_PER_PAGE` distinct, acceptable candidates existed.
 * Every item stays an unconfirmed suggestion.
 */
export function fuseFormDetections(
  primary: FusionInput[],
  secondary: FusionInput[]
) {
  const ordered = [...primary, ...secondary]
    .filter(validCandidate)
    .map(sanitize)
    .sort(byStrength);
  const accepted: FusedDetectionCandidate[] = [];
  let truncated = false;
  for (const candidate of ordered) {
    if (duplicate(candidate, accepted)) continue;
    if (accepted.length >= MAX_FUSED_CANDIDATES_PER_PAGE) {
      truncated = true;
      break;
    }
    accepted.push(candidate);
  }
  accepted.sort(byReadingOrder);
  return { candidates: accepted, truncated };
}

/**
 * Fill a bounded suggestion list. Returns true when at least one candidate had
 * to be left out, so the caller can tell the person the list is partial.
 */
export function appendSuggestedFields<T>(
  target: T[],
  candidates: T[],
  limit = MAX_SUGGESTED_FIELDS_PER_DOCUMENT
) {
  let truncated = false;
  for (const candidate of candidates) {
    if (target.length >= limit) {
      truncated = true;
      break;
    }
    target.push(candidate);
  }
  return truncated;
}

export function suggestedType(label: string): FieldType {
  if (/date|日期|生日/i.test(label)) return "date";
  if (/time|時間/i.test(label)) return "time";
  if (/email|電郵|邮箱/i.test(label)) return "text";
  if (/amount|number|數字|金額/i.test(label)) return "number";
  if (/signature|簽名|签名/i.test(label)) return "signature";
  return "text";
}

function structureFieldType(structure: LabelledFormStructure): FieldType {
  if (structure.kind === "checkbox") return "checkbox";
  if (structure.kind === "radio") return "radio";
  if (structure.kind === "character-box") return "characterBox";
  if (structure.kind === "table") return "table";
  return suggestedType(structure.label);
}

/**
 * Convert traced page geometry into fusion candidates so local structure is
 * compared against native widgets in one pass instead of being appended after
 * an unrelated filter.
 */
export function localStructureCandidates(
  structures: LabelledFormStructure[]
): FusionInput[] {
  return structures.map(structure => {
    const detectionGroup = (structure.members ?? []).map(member => ({
      xRatio: (member.left - structure.left) / Math.max(1, structure.width),
      yRatio: (member.top - structure.top) / Math.max(1, structure.height),
      widthRatio: member.width / Math.max(1, structure.width),
      heightRatio: member.height / Math.max(1, structure.height),
    }));
    const optionMarks =
      structure.kind === "radio"
        ? (structure.options ?? []).flatMap((option, optionIndex) => {
            const mark = detectionGroup[optionIndex];
            return mark ? [{ option, ...mark }] : [];
          })
        : [];
    return {
      fieldType: structureFieldType(structure),
      label: structure.label,
      confidence: structure.confidence,
      aiConfidence:
        structure.labelConfidence > 0
          ? structure.labelConfidence
          : structure.confidence * 0.75,
      required: false,
      options:
        structure.kind === "table"
          ? Array.from(
              { length: structure.columns ?? 1 },
              (_, columnIndex) => `欄位 ${columnIndex + 1}`
            )
          : (structure.options ?? []),
      maxLength: structure.boxCount ?? null,
      boxCount: structure.boxCount ?? null,
      segmentCapacities: structure.segmentCapacities ?? null,
      maxRows: structure.rows ?? null,
      tableColumns: structure.columns ?? null,
      tableWritableCells: structure.writableCells ?? null,
      tableCellGuides: validImportCellGuides(structure.cellGuides, structure.rows, structure.columns),
      detectionSource:
        structure.detectionSource ?? `local-structure:${structure.kind}`,
      detectionGroup,
      optionMarks,
      left: structure.left,
      top: structure.top,
      width: structure.width,
      height: structure.height,
    } satisfies FusionInput;
  });
}

export type DraftPageGeometry = {
  page: number;
  widthMm: number;
  heightMm: number;
  pixelWidth: number;
  pixelHeight: number;
};

function finitePositive(value: number) {
  return Number.isFinite(value) && value > 0;
}

/**
 * Turn fused candidates into unconfirmed draft fields. Both detector families
 * take this one path, so a native widget and traced geometry produce the same
 * field shape and the same millimetre coordinates.
 */
export function fusedDraftFields(
  candidates: FusedDetectionCandidate[],
  page: DraftPageGeometry,
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
  return candidates
    .slice(0, MAX_FUSED_CANDIDATES_PER_PAGE)
    .map((candidate, index) => ({
      stableFieldId: createStableFieldId(),
      fieldType: candidate.fieldType,
      displayOrder: pageIndex * 100 + index,
      definition: {
        label: candidate.label,
        confirmed: false,
        aiSuggested: true,
        aiConfidence: candidate.aiConfidence ?? candidate.confidence,
        required: candidate.required,
        placeholder: "",
        options: candidate.options,
        maxLength: candidate.maxLength ?? null,
        boxCount: candidate.boxCount ?? null,
        segmentCapacities: candidate.segmentCapacities ?? null,
        maxRows: candidate.maxRows ?? null,
        tableColumns: candidate.tableColumns ?? null,
        tableWritableCells: candidate.tableWritableCells ?? null,
        fontSizePt: 10,
        align: "left" as const,
        overflow: "warn" as const,
        detectionSource: candidate.detectionSource,
        detectionGroup: candidate.detectionGroup,
        ...(candidate.fieldType === "table" && validImportCellGuides(candidate.tableCellGuides, candidate.maxRows, candidate.tableColumns)
          ? { tableCellGuides: candidate.tableCellGuides } : {}),
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
