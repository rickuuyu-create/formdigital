/**
 * Form structures built from a PDF's own vector rules.
 *
 * The pixel detector has to infer where a line is and guess whether faint ink
 * is a rule or a glyph. When the source is a vector PDF those rules are already
 * exact, so underlines, boxes, and grids can be derived without any of that
 * uncertainty. Everything produced here is still an unconfirmed suggestion.
 */
import type { FormStructure } from "./form-structure";
import type { PdfRuleSegment } from "./native-pdf-rules";

type Line = { from: number; to: number; position: number; thickness: number };

const MERGE_POSITION_TOLERANCE_PX = 2.5;
const MERGE_GAP_PX = 6;
const MAX_STRUCTURES = 600;

function toLines(
  rules: PdfRuleSegment[],
  orientation: "horizontal" | "vertical"
): Line[] {
  const lines = rules
    .filter(rule => rule.orientation === orientation)
    .map(rule =>
      orientation === "horizontal"
        ? {
            from: rule.leftPx,
            to: rule.leftPx + rule.widthPx,
            position: rule.topPx + rule.heightPx / 2,
            thickness: Math.max(0.5, rule.heightPx),
          }
        : {
            from: rule.topPx,
            to: rule.topPx + rule.heightPx,
            position: rule.leftPx + rule.widthPx / 2,
            thickness: Math.max(0.5, rule.widthPx),
          }
    )
    .sort((left, right) => left.position - right.position || left.from - right.from);

  // A single printed rule is often emitted as several collinear pieces.
  const merged: Line[] = [];
  for (const line of lines) {
    const previous = merged.at(-1);
    if (
      previous &&
      Math.abs(previous.position - line.position) <= MERGE_POSITION_TOLERANCE_PX &&
      line.from <= previous.to + MERGE_GAP_PX
    ) {
      previous.to = Math.max(previous.to, line.to);
      previous.thickness = Math.max(previous.thickness, line.thickness);
      continue;
    }
    merged.push({ ...line });
  }
  return merged;
}

function overlaps(a: Line, b: Line) {
  return Math.min(a.to, b.to) - Math.max(a.from, b.from);
}

function isDuplicate(candidate: FormStructure, existing: FormStructure[]) {
  return existing.some(item => {
    const left = Math.max(candidate.left, item.left);
    const top = Math.max(candidate.top, item.top);
    const right = Math.min(
      candidate.left + candidate.width,
      item.left + item.width
    );
    const bottom = Math.min(
      candidate.top + candidate.height,
      item.top + item.height
    );
    const overlap = Math.max(0, right - left) * Math.max(0, bottom - top);
    const smaller = Math.min(
      candidate.width * candidate.height,
      item.width * item.height
    );
    return overlap / Math.max(1, smaller) > 0.6;
  });
}

type Zone = { left: number; top: number; right: number; bottom: number };

/**
 * Ruled rectangles, collected only so their edges are not mistaken for blanks.
 *
 * Tables, character-box combs, and checkboxes are deliberately left to the
 * pixel detector, which already classifies them and is covered by its own
 * regressions. Emitting them from here as well produced competing, worse
 * classifications for the same geometry.
 */
function gridZones(
  horizontal: Line[],
  vertical: Line[],
  zones: Zone[]
) {
  const used = new Set<Line>();
  for (let index = 0; index < horizontal.length; index += 1) {
    const top = horizontal[index]!;
    if (used.has(top)) continue;
    const rows = horizontal.filter(
      line =>
        line.position >= top.position &&
        Math.abs(line.from - top.from) <= 6 &&
        Math.abs(line.to - top.to) <= 6
    );
    if (rows.length < 2) continue;
    const bottom = rows.at(-1)!;
    const height = bottom.position - top.position;
    if (height < 12) continue;
    const columns = vertical.filter(
      line =>
        line.position >= top.from - 6 &&
        line.position <= top.to + 6 &&
        line.from <= top.position + 6 &&
        line.to >= bottom.position - 6
    );
    if (columns.length < 2) continue;
    rows.forEach(line => used.add(line));
    zones.push({
      left: top.from,
      top: top.position,
      right: top.to,
      bottom: bottom.position,
    });
  }
}

/**
 * A rule with nothing directly under it is a writable blank. Vector data makes
 * this reliable: there is no faint-ink ambiguity to guard against, so a rule
 * spanning most of the page is just a long blank rather than a suspected
 * decorative line.
 */
function detectUnderlines(
  horizontal: Line[],
  vertical: Line[],
  zones: Zone[],
  structures: FormStructure[],
  pageWidth: number,
  pageHeight: number
) {
  const minimumWidth = Math.max(28, pageWidth * 0.08);
  const rowHeight = Math.max(12, Math.min(40, Math.round(pageHeight * 0.022)));
  for (const line of horizontal) {
    const width = line.to - line.from;
    if (width < minimumWidth) continue;
    if (line.thickness > 3) continue;
    // A rule inside a ruled rectangle is a cell edge, not a blank.
    if (
      zones.some(
        zone =>
          line.position >= zone.top - 4 &&
          line.position <= zone.bottom + 4 &&
          line.from >= zone.left - 8 &&
          line.to <= zone.right + 8
      )
    )
      continue;
    // Verticals rising from both ends make this the side of a box.
    const endpointColumn = (x: number) =>
      vertical.some(
        column =>
          Math.abs(column.position - x) <= 3 &&
          column.to >= line.position - 3 &&
          column.from <= line.position + 3
      );
    if (endpointColumn(line.from) && endpointColumn(line.to)) continue;
    // A rule closely shadowed by another is a box edge or a double rule.
    if (
      horizontal.some(
        other =>
          other !== line &&
          Math.abs(other.position - line.position) <= rowHeight * 0.45 &&
          overlaps(other, line) > width * 0.7
      )
    )
      continue;
    const structure: FormStructure = {
      kind: "underline",
      left: line.from,
      top: Math.max(0, line.position - rowHeight),
      width,
      height: rowHeight,
      confidence: 0.86,
    };
    if (!isDuplicate(structure, structures)) structures.push(structure);
  }
}

/**
 * Turn a page's vector rules into unconfirmed field structures.
 */
export function vectorFormStructures(
  rules: PdfRuleSegment[],
  pageWidthPx: number,
  pageHeightPx: number
): FormStructure[] {
  if (
    !Array.isArray(rules) ||
    !rules.length ||
    !Number.isFinite(pageWidthPx) ||
    !Number.isFinite(pageHeightPx) ||
    pageWidthPx <= 0 ||
    pageHeightPx <= 0
  )
    return [];
  const horizontal = toLines(rules, "horizontal");
  const vertical = toLines(rules, "vertical");
  const zones: Zone[] = [];
  const structures: FormStructure[] = [];
  gridZones(horizontal, vertical, zones);
  detectUnderlines(
    horizontal,
    vertical,
    zones,
    structures,
    pageWidthPx,
    pageHeightPx
  );
  return structures
    .filter(item => item.width >= 4 && item.height >= 4)
    .slice(0, MAX_STRUCTURES);
}
