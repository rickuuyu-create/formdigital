/**
 * Field candidates derived from a page's text layer.
 *
 * Office documents exported to PDF rarely carry real form fields; their blanks
 * are a label followed by empty space or a run of underscores. The text layer
 * already gives both the label and its exact position, so this reads far more
 * reliably than tracing pixels — and the label it produces is the wording a
 * person actually sees on the form.
 */
import type { FormStructure, PositionedWord } from "./form-structure";
import { importCellRects } from "./import-table-geometry";

export type LabelledBlank = FormStructure & {
  label: string;
  labelConfidence: number;
  detectionSource: string;
};

const LABEL_SUFFIX = /[:：]\s*$/;
const UNDERSCORE_RUN = /[_＿]{3,}/;
/** Ignore a "label" that is really a sentence. */
const MAX_LABEL_LENGTH = 24;
/** A label has to say something; numbering and punctuation do not. */
const LABEL_HAS_WORD = /[0-9A-Za-z㐀-鿿豈-﫿]/;
const LABEL_IS_NUMBERING = /^[0-9０-９]+\s*[.)、）]?$/;
const MIN_BLANK_WIDTH_RATIO = 0.05;
const MAX_CANDIDATES = 300;
/** Provenance for the writable space that follows a printed label. */
export const TEXT_BLANK_SOURCE = "local-structure:text-blank";

function sameRow(a: PositionedWord, b: PositionedWord) {
  const aCenter = a.top + a.height / 2;
  const bCenter = b.top + b.height / 2;
  const tolerance = Math.max(4, Math.min(a.height, b.height) * 0.6);
  return Math.abs(aCenter - bCenter) <= tolerance;
}

function cleanLabel(value: string) {
  return value
    .replace(/[_＿]+/g, " ")
    .replace(LABEL_SUFFIX, "")
    .replace(/\s+/g, " ")
    .trim();
}

export type TableBoundary = {
  left: number;
  top: number;
  width: number;
  height: number;
  columns?: number;
  rows?: number;
  writableCells?: Array<{ row: number; column: number }>;
  cellGuides?: FormStructure["cellGuides"];
};

/**
 * Find "label：" runs and the writable gap that follows each one.
 *
 * The gap ends at the next word on the same line, or at the right margin when
 * the label is the last thing on its row.
 */
export function labelBlankCandidates(
  words: PositionedWord[],
  pageWidthPx: number,
  pageHeightPx: number,
  options: { rightMarginPx?: number; tables?: TableBoundary[] } = {}
): LabelledBlank[] {
  if (
    !Array.isArray(words) ||
    !words.length ||
    !Number.isFinite(pageWidthPx) ||
    !Number.isFinite(pageHeightPx) ||
    pageWidthPx <= 0 ||
    pageHeightPx <= 0
  )
    return [];

  const rightMargin =
    options.rightMarginPx ?? Math.round(pageWidthPx * 0.94);
  const minimumWidth = pageWidthPx * MIN_BLANK_WIDTH_RATIO;
  const usable = words.filter(
    word =>
      word.text.trim() &&
      Number.isFinite(word.left) &&
      Number.isFinite(word.top) &&
      word.width > 0 &&
      word.height > 0
  );
  const validTables = (options.tables ?? []).filter(
    t =>
      t &&
      Number.isFinite(t.left) &&
      Number.isFinite(t.top) &&
      Number.isFinite(t.width) &&
      Number.isFinite(t.height) &&
      t.width > 0 &&
      t.height > 0
  );
  const candidates: LabelledBlank[] = [];

  for (const word of usable) {
    const text = word.text.trim();
    const endsWithColon = LABEL_SUFFIX.test(text);
    const hasUnderscores = UNDERSCORE_RUN.test(text);
    if (!endsWithColon && !hasUnderscores) continue;
    const label = cleanLabel(text);
    if (!label || label.length > MAX_LABEL_LENGTH) continue;
    if (!LABEL_HAS_WORD.test(label) || LABEL_IS_NUMBERING.test(label)) continue;

    // Check table boundaries for vertical overlap
    const wordCenterY = word.top + word.height / 2;
    const computeTableBound = (startX: number, currentRight: number): number => {
      let boundedRight = currentRight;
      for (const table of validTables) {
        if (wordCenterY >= table.top && wordCenterY <= table.top + table.height) {
          if (startX <= table.left + 2) {
            // Word is to the left of the table: clamp to table left
            if (boundedRight > table.left) {
              boundedRight = Math.min(boundedRight, table.left);
            }
          } else if (startX >= table.left - 2 && startX < table.left + table.width) {
            // Word is inside the table
            const cells = importCellRects(table);
            const containing = cells?.filter(c => startX >= c.left && startX < c.right && wordCenterY >= c.top && wordCenterY < c.bottom);
            if (containing?.length) {
              boundedRight = Math.min(boundedRight, ...containing.map(c => c.right));
            } else {
              // Missing or invalid cell geometry cannot justify inventing
              // equal-width boundaries. Preserve the outer-table bound only.
              const tableRight = table.left + table.width;
              if (boundedRight > tableRight) {
                boundedRight = Math.min(boundedRight, tableRight);
              }
            }
          }
        }
      }
      return boundedRight;
    };

    // An underscore run inside the same text item is itself the blank.
    if (hasUnderscores && !endsWithColon) {
      const underscoreStart = text.search(UNDERSCORE_RUN);
      if (underscoreStart <= 0) continue;
      const ratio = underscoreStart / text.length;
      const left = word.left + word.width * ratio;
      let right = word.left + word.width;
      right = computeTableBound(left, right);
      const width = right - left;
      if (width < minimumWidth) continue;
      candidates.push({
        kind: "underline",
        left,
        top: word.top,
        width,
        height: word.height,
        confidence: 0.8,
        label,
        labelConfidence: Math.min(0.95, word.confidence / 100),
        detectionSource: TEXT_BLANK_SOURCE,
      });
      continue;
    }

    const labelRight = word.left + word.width;
    const next = usable
      .filter(other => other !== word && sameRow(word, other) && other.left >= labelRight - 1)
      .sort((left, right) => left.left - right.left)[0];
    let blankRight = next ? next.left : rightMargin;
    blankRight = computeTableBound(labelRight, blankRight);
    const width = blankRight - labelRight;
    if (width < minimumWidth) continue;
    candidates.push({
      kind: "underline",
      left: labelRight,
      top: word.top,
      width,
      height: word.height,
      confidence: 0.8,
      label,
      labelConfidence: Math.min(0.95, word.confidence / 100),
      detectionSource: TEXT_BLANK_SOURCE,
    });
  }

  return candidates
    .sort((left, right) => left.top - right.top || left.left - right.left)
    .slice(0, MAX_CANDIDATES);
}

/** Provenance for a last-resort candidate placed beside a recognised word. */
export const OCR_WORD_SOURCE = "local-structure:ocr-word";

/**
 * Last-resort blanks placed next to every confidently recognised word.
 *
 * Used only when a page yields no geometry at all — a scan the tracer cannot
 * read. These are deliberately weak so any real structure outranks them in
 * fusion, and they are still unconfirmed suggestions.
 */
export function ocrWordCandidates(
  words: PositionedWord[],
  pageWidthPx: number,
  pageHeightPx: number,
  confidenceThreshold: number
): LabelledBlank[] {
  if (
    !Array.isArray(words) ||
    !Number.isFinite(pageWidthPx) ||
    !Number.isFinite(pageHeightPx) ||
    pageWidthPx <= 0 ||
    pageHeightPx <= 0
  )
    return [];
  const rightMargin = pageWidthPx * 0.96;
  return words
    .filter(
      word =>
        word.confidence >= confidenceThreshold &&
        word.text.trim().length >= 2 &&
        word.width > 0 &&
        word.height > 0
    )
    .slice(0, 80)
    .flatMap(word => {
      const left = Math.min(
        rightMargin - 8,
        word.left + word.width + pageWidthPx * 0.008
      );
      const width = Math.min(
        pageWidthPx - left,
        pageWidthPx * 0.26,
        Math.max(pageWidthPx * 0.08, rightMargin - left)
      );
      const top = Math.max(0, word.top);
      const height = Math.min(
        pageHeightPx - top,
        Math.max(8, word.height * 1.4)
      );
      if (left < 0 || top >= pageHeightPx || width <= 0 || height <= 0)
        return [];
      return [
        {
          kind: "underline" as const,
          left,
          top,
          width,
          height,
          confidence: 0.45,
          label: cleanLabel(word.text),
          labelConfidence: Math.min(0.95, word.confidence / 100),
          detectionSource: OCR_WORD_SOURCE,
        },
      ];
    })
    .filter(candidate => candidate.label.length > 0);
}
