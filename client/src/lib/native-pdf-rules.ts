/**
 * Axis-aligned rules read from a PDF page's own drawing operators.
 *
 * Tracing lines out of a rasterised page is a guess; a vector PDF already
 * records every rule's exact position. This module replays the operator list
 * with a transform stack and keeps only the horizontal and vertical rules a
 * form is built from, in viewport pixels.
 */

export type PdfRuleSegment = {
  leftPx: number;
  topPx: number;
  widthPx: number;
  heightPx: number;
  orientation: "horizontal" | "vertical";
};

export type PdfRuleExtraction = {
  status: "ok" | "unavailable" | "truncated";
  rules: PdfRuleSegment[];
};

/**
 * Operator codes this module understands. They are supplied by the caller so
 * this module stays free of a direct pdf.js import and remains unit-testable.
 */
export type PdfRuleOps = {
  save: number;
  restore: number;
  transform: number;
  constructPath: number;
  setLineWidth: number;
  stroke: number;
  closeStroke: number;
  fill: number;
  eoFill: number;
  fillStroke: number;
  eoFillStroke: number;
  closeFillStroke: number;
  closeEOFillStroke: number;
};

/**
 * Sub-codes used inside a constructPath payload. pdf.js does not export these,
 * so they are pinned here and every payload is validated before use; an
 * unrecognised stream is dropped rather than guessed at.
 */
const DRAW_MOVE_TO = 0;
const DRAW_LINE_TO = 1;
const DRAW_CURVE_TO = 2;
const DRAW_QUADRATIC_CURVE_TO = 3;
const DRAW_CLOSE_PATH = 4;

export type PdfOperatorList = {
  fnArray: ArrayLike<number>;
  argsArray: ArrayLike<unknown>;
};

type Matrix = [number, number, number, number, number, number];

const MAX_OPERATORS = 60_000;
const MAX_RULES = 4_000;
/** A rule is thin; anything squarer is a box, a glyph, or a filled block. */
const MAX_RULE_THICKNESS_PX = 6;
const MIN_RULE_LENGTH_PX = 8;

function multiply(first: Matrix, second: Matrix): Matrix {
  return [
    first[0] * second[0] + first[2] * second[1],
    first[1] * second[0] + first[3] * second[1],
    first[0] * second[2] + first[2] * second[3],
    first[1] * second[2] + first[3] * second[3],
    first[0] * second[4] + first[2] * second[5] + first[4],
    first[1] * second[4] + first[3] * second[5] + first[5],
  ];
}

function apply(matrix: Matrix, x: number, y: number): [number, number] {
  return [
    matrix[0] * x + matrix[2] * y + matrix[4],
    matrix[1] * x + matrix[3] * y + matrix[5],
  ];
}

function finiteMatrix(value: unknown): Matrix | null {
  if (!Array.isArray(value) || value.length !== 6) return null;
  if (!value.every(item => typeof item === "number" && Number.isFinite(item)))
    return null;
  return [...(value as number[])] as Matrix;
}

/** Average absolute scale, used to turn a PDF line width into pixels. */
function scaleOf(matrix: Matrix) {
  const x = Math.hypot(matrix[0], matrix[1]);
  const y = Math.hypot(matrix[2], matrix[3]);
  return (x + y) / 2 || 1;
}

function pushRule(
  rules: PdfRuleSegment[],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  thickness: number,
  width: number,
  height: number
) {
  const left = Math.min(x0, x1);
  const right = Math.max(x0, x1);
  const top = Math.min(y0, y1);
  const bottom = Math.max(y0, y1);
  const spanX = right - left;
  const spanY = bottom - top;
  const stroke = Math.max(0.5, Math.min(MAX_RULE_THICKNESS_PX, thickness));
  const horizontal = spanX >= spanY;
  const length = horizontal ? spanX : spanY;
  if (!Number.isFinite(length) || length < MIN_RULE_LENGTH_PX) return;
  // The other axis must stay thin, otherwise this is a box or a filled block.
  if ((horizontal ? spanY : spanX) > MAX_RULE_THICKNESS_PX) return;
  const rule: PdfRuleSegment = horizontal
    ? {
        leftPx: left,
        topPx: top - (spanY > 0 ? 0 : stroke / 2),
        widthPx: spanX,
        heightPx: Math.max(spanY, stroke),
        orientation: "horizontal",
      }
    : {
        leftPx: left - (spanX > 0 ? 0 : stroke / 2),
        topPx: top,
        widthPx: Math.max(spanX, stroke),
        heightPx: spanY,
        orientation: "vertical",
      };
  if (
    rule.leftPx + rule.widthPx < 0 ||
    rule.topPx + rule.heightPx < 0 ||
    rule.leftPx > width ||
    rule.topPx > height
  )
    return;
  rules.push(rule);
}

/**
 * Replay a page operator list and collect its horizontal and vertical rules.
 *
 * Only straight, axis-aligned geometry is kept: curves and diagonals belong to
 * artwork and glyphs, not to the blanks and grids a form is made of.
 */
export function extractPdfRuleSegments(
  operatorList: PdfOperatorList | null | undefined,
  ops: PdfRuleOps,
  viewportTransform: number[] | null | undefined,
  viewportWidthPx: number,
  viewportHeightPx: number
): PdfRuleExtraction {
  const base = finiteMatrix(viewportTransform);
  if (
    !operatorList ||
    !base ||
    !Number.isFinite(viewportWidthPx) ||
    !Number.isFinite(viewportHeightPx) ||
    viewportWidthPx <= 0 ||
    viewportHeightPx <= 0
  )
    return { status: "unavailable", rules: [] };

  const { fnArray, argsArray } = operatorList;
  if (!fnArray || !argsArray || fnArray.length !== argsArray.length)
    return { status: "unavailable", rules: [] };

  const rules: PdfRuleSegment[] = [];
  const stack: Array<{ matrix: Matrix; lineWidth: number }> = [];
  let matrix: Matrix = base;
  let lineWidth = 1;
  let pending: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
  let truncated = fnArray.length > MAX_OPERATORS;
  const total = Math.min(fnArray.length, MAX_OPERATORS);

  for (let index = 0; index < total; index += 1) {
    const code = fnArray[index]!;
    const args = argsArray[index];
    if (code === ops.save) {
      stack.push({ matrix, lineWidth });
      continue;
    }
    if (code === ops.restore) {
      const previous = stack.pop();
      if (previous) {
        matrix = previous.matrix;
        lineWidth = previous.lineWidth;
      }
      continue;
    }
    if (code === ops.transform) {
      const next = finiteMatrix(Array.isArray(args) ? args : null);
      if (next) matrix = multiply(matrix, next);
      continue;
    }
    if (code === ops.setLineWidth) {
      const value = Array.isArray(args) ? args[0] : args;
      if (typeof value === "number" && Number.isFinite(value)) lineWidth = value;
      continue;
    }
    const paintsHere =
      code === ops.stroke ||
      code === ops.closeStroke ||
      code === ops.fill ||
      code === ops.eoFill ||
      code === ops.fillStroke ||
      code === ops.eoFillStroke ||
      code === ops.closeFillStroke ||
      code === ops.closeEOFillStroke;

    if (code === ops.constructPath) {
      pending = [];
      const path = Array.isArray(args) ? args : null;
      if (!path) continue;
      // pdf.js bakes the paint operation into the path arguments; a clipping
      // path carries a clip code here and must not become a rule.
      const paintOp = typeof path[0] === "number" ? path[0] : null;
      const painted =
        paintOp !== null &&
        (paintOp === ops.stroke ||
          paintOp === ops.closeStroke ||
          paintOp === ops.fill ||
          paintOp === ops.eoFill ||
          paintOp === ops.fillStroke ||
          paintOp === ops.eoFillStroke ||
          paintOp === ops.closeFillStroke ||
          paintOp === ops.closeEOFillStroke);
      if (paintOp !== null && !painted) continue;
      const subpaths = Array.isArray(path[1]) ? path[1] : null;
      if (!subpaths) continue;
      for (const subpath of subpaths) {
        const values = subpath as ArrayLike<number> | null;
        if (!values || typeof values.length !== "number") continue;
        let cursor = 0;
        let currentX = 0;
        let currentY = 0;
        let startX = 0;
        let startY = 0;
        let malformed = false;
        while (cursor < values.length) {
          const drawOp = Number(values[cursor++]);
          if (drawOp === DRAW_MOVE_TO || drawOp === DRAW_LINE_TO) {
            if (cursor + 1 >= values.length) {
              malformed = true;
              break;
            }
            const nextX = Number(values[cursor++]);
            const nextY = Number(values[cursor++]);
            if (!Number.isFinite(nextX) || !Number.isFinite(nextY)) {
              malformed = true;
              break;
            }
            if (drawOp === DRAW_LINE_TO)
              pending.push({ x0: currentX, y0: currentY, x1: nextX, y1: nextY });
            else {
              startX = nextX;
              startY = nextY;
            }
            currentX = nextX;
            currentY = nextY;
          } else if (drawOp === DRAW_CURVE_TO) {
            // Curves are artwork, never a form rule; skip to the end point.
            cursor += 6;
            currentX = Number(values[cursor - 2]);
            currentY = Number(values[cursor - 1]);
          } else if (drawOp === DRAW_QUADRATIC_CURVE_TO) {
            cursor += 4;
            currentX = Number(values[cursor - 2]);
            currentY = Number(values[cursor - 1]);
          } else if (drawOp === DRAW_CLOSE_PATH) {
            pending.push({ x0: currentX, y0: currentY, x1: startX, y1: startY });
            currentX = startX;
            currentY = startY;
          } else {
            malformed = true;
            break;
          }
        }
        if (malformed) pending = [];
        if (malformed) break;
      }
      if (!painted) continue;
    } else if (!paintsHere) continue;

    const thickness = Math.max(0.5, lineWidth * scaleOf(matrix));
    for (const segment of pending) {
      if (rules.length >= MAX_RULES) {
        truncated = true;
        break;
      }
      const [x0, y0] = apply(matrix, segment.x0, segment.y0);
      const [x1, y1] = apply(matrix, segment.x1, segment.y1);
      if (![x0, y0, x1, y1].every(Number.isFinite)) continue;
      // Only axis-aligned geometry survives: a form's blanks and grid lines.
      const horizontal = Math.abs(y1 - y0) <= MAX_RULE_THICKNESS_PX;
      const vertical = Math.abs(x1 - x0) <= MAX_RULE_THICKNESS_PX;
      if (!horizontal && !vertical) continue;
      pushRule(
        rules,
        x0,
        y0,
        x1,
        y1,
        thickness,
        viewportWidthPx,
        viewportHeightPx
      );
    }
    pending = [];
    if (rules.length >= MAX_RULES) {
      truncated = true;
      break;
    }
  }

  return { status: truncated ? "truncated" : "ok", rules };
}
