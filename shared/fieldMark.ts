/**
 * How a ticked checkbox or a selected radio option is drawn.
 *
 * The mark is vector geometry, not a text glyph: "✓" (U+2713) is outside
 * WinAnsi, so drawing it as text would force a CJK font onto every export,
 * including English-only forms. Lines and circles need no font at all and
 * scale exactly to the printed box.
 *
 * Preview and PDF share these ratios so what the editor shows is what prints.
 */

export type FieldMarkStyle = "check" | "cross" | "dot" | "circle";

export const DEFAULT_FIELD_MARK: FieldMarkStyle = "check";

/** Mark size as a fraction of the shorter side of its box. */
export const MARK_SIZE_RATIO = 0.78;
/** Stroke thickness as a fraction of the mark size. */
export const MARK_STROKE_RATIO = 0.16;

export function normalizeFieldMark(value: unknown): FieldMarkStyle {
  return value === "cross" || value === "dot" || value === "circle" || value === "check"
    ? value
    : DEFAULT_FIELD_MARK;
}

/**
 * Mark strokes for a box, in a y-down coordinate system with the box origin at
 * (0, 0). Callers working in PDF space flip `y` through the box height.
 */
export function fieldMarkStrokes(
  style: FieldMarkStyle,
  width: number,
  height: number
) {
  const size = Math.max(1, Math.min(width, height) * MARK_SIZE_RATIO);
  const centerX = width / 2;
  const centerY = height / 2;
  const strokeWidth = Math.max(0.5, size * MARK_STROKE_RATIO);
  if (style === "circle")
    return {
      strokeWidth: Math.max(0.5, Math.min(width, height) * 0.06),
      radius: 0,
      centerX,
      centerY,
      lines: [],
      outline: {
        radiusX: Math.max(0.5, width * 0.42),
        radiusY: Math.max(0.5, height * 0.42),
      },
    };
  if (style === "dot")
    return { strokeWidth, radius: size * 0.3, centerX, centerY, lines: [], outline: undefined };
  const lines =
    style === "cross"
      ? [
          {
            x0: centerX - size * 0.36,
            y0: centerY - size * 0.36,
            x1: centerX + size * 0.36,
            y1: centerY + size * 0.36,
          },
          {
            x0: centerX + size * 0.36,
            y0: centerY - size * 0.36,
            x1: centerX - size * 0.36,
            y1: centerY + size * 0.36,
          },
        ]
      : [
          // Short down-stroke then the long up-stroke of a tick.
          {
            x0: centerX - size * 0.38,
            y0: centerY + size * 0.02,
            x1: centerX - size * 0.1,
            y1: centerY + size * 0.32,
          },
          {
            x0: centerX - size * 0.1,
            y0: centerY + size * 0.32,
            x1: centerX + size * 0.4,
            y1: centerY - size * 0.34,
          },
        ];
  return { strokeWidth, radius: 0, centerX, centerY, lines, outline: undefined };
}
