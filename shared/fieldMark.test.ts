import { describe, expect, it } from "vitest";
import {
  DEFAULT_FIELD_MARK,
  fieldMarkStrokes,
  normalizeFieldMark,
} from "./fieldMark";

describe("field mark geometry", () => {
  it("defaults to a tick and rejects unknown styles", () => {
    expect(DEFAULT_FIELD_MARK).toBe("check");
    expect(normalizeFieldMark(undefined)).toBe("check");
    expect(normalizeFieldMark("wingding")).toBe("check");
    expect(normalizeFieldMark(null)).toBe("check");
    expect(normalizeFieldMark("cross")).toBe("cross");
    expect(normalizeFieldMark("dot")).toBe("dot");
    expect(normalizeFieldMark("circle")).toBe("circle");
  });

  it("keeps every stroke inside the printed box", () => {
    for (const style of ["check", "cross", "dot"] as const) {
      for (const [width, height] of [
        [12, 12],
        [40, 10],
        [10, 40],
        [7, 7],
      ]) {
        const mark = fieldMarkStrokes(style, width, height);
        const points = mark.lines.flatMap(line => [
          { x: line.x0, y: line.y0 },
          { x: line.x1, y: line.y1 },
        ]);
        if (mark.radius > 0)
          points.push(
            { x: mark.centerX - mark.radius, y: mark.centerY - mark.radius },
            { x: mark.centerX + mark.radius, y: mark.centerY + mark.radius }
          );
        for (const point of points) {
          expect(point.x).toBeGreaterThanOrEqual(0);
          expect(point.y).toBeGreaterThanOrEqual(0);
          expect(point.x).toBeLessThanOrEqual(width);
          expect(point.y).toBeLessThanOrEqual(height);
        }
      }
    }
  });

  it("centres the mark in its box", () => {
    const mark = fieldMarkStrokes("dot", 30, 18);
    expect(mark.centerX).toBe(15);
    expect(mark.centerY).toBe(9);
  });

  it("scales with the box so a small printed square still gets a full mark", () => {
    const small = fieldMarkStrokes("check", 10, 10);
    const large = fieldMarkStrokes("check", 40, 40);
    expect(large.strokeWidth).toBeCloseTo(small.strokeWidth * 4, 6);
    const span = (mark: ReturnType<typeof fieldMarkStrokes>) =>
      Math.max(...mark.lines.map(line => Math.max(line.x0, line.x1))) -
      Math.min(...mark.lines.map(line => Math.min(line.x0, line.x1)));
    expect(span(large)).toBeCloseTo(span(small) * 4, 6);
  });

  it("draws a tick as a short down-stroke followed by a long up-stroke", () => {
    const [first, second] = fieldMarkStrokes("check", 100, 100).lines;
    // y grows downward here, so the first stroke descends and the second rises.
    expect(first!.y1).toBeGreaterThan(first!.y0);
    expect(second!.y1).toBeLessThan(second!.y0);
    // The strokes join at a single vertex.
    expect(second!.x0).toBeCloseTo(first!.x1, 6);
    expect(second!.y0).toBeCloseTo(first!.y1, 6);
    // The tail reaches higher than the start, as a tick does.
    expect(second!.y1).toBeLessThan(first!.y0);
  });

  it("draws a cross as two crossing diagonals and a dot as a filled circle", () => {
    const cross = fieldMarkStrokes("cross", 100, 100);
    expect(cross.lines).toHaveLength(2);
    expect(cross.radius).toBe(0);
    const dot = fieldMarkStrokes("dot", 100, 100);
    expect(dot.lines).toEqual([]);
    expect(dot.radius).toBeGreaterThan(0);
  });

  it("draws an unfilled oval around a printed A/B/C/D letter", () => {
    const mark = fieldMarkStrokes("circle", 16, 12);
    expect(mark.lines).toEqual([]);
    expect(mark.radius).toBe(0);
    expect(mark.outline).toMatchObject({ radiusX: 6.72, radiusY: 5.04 });
    expect(mark.strokeWidth).toBeGreaterThan(0);
    expect(mark.outline!.radiusX + mark.strokeWidth / 2).toBeLessThan(8);
    expect(mark.outline!.radiusY + mark.strokeWidth / 2).toBeLessThan(6);
  });

  it("never produces a zero-size mark for a degenerate box", () => {
    const mark = fieldMarkStrokes("check", 0, 0);
    expect(mark.strokeWidth).toBeGreaterThan(0);
    expect(mark.lines.length).toBeGreaterThan(0);
  });
});
