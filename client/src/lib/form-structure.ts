import { boundedPixelSize } from "./import-runtime";

export type FormStructureKind =
  | "text-box"
  | "checkbox"
  | "underline"
  | "radio"
  | "character-box"
  | "table";

export type FormStructure = {
  kind: FormStructureKind;
  left: number;
  top: number;
  width: number;
  height: number;
  confidence: number;
  members?: Array<{ left: number; top: number; width: number; height: number }>;
  /** Table cells in row-major order; members of a table are RULES, not cells. */
  cellGuides?: Array<{ xRatio: number; yRatio: number; widthRatio: number; heightRatio: number }>;
  boxCount?: number;
  /**
   * Character capacity of each printed segment of a segmented field, in
   * reading order. A DD / MM / YYYY date reports [2, 2, 4] while `members`
   * holds one box per writable character, so nothing is truncated to the
   * segment count.
   */
  segmentCapacities?: number[];
  emptyCells?: number;
  /** Grid positions of the cells a person may write in, in reading order. */
  writableCells?: Array<{ row: number; column: number }>;
  rows?: number;
  columns?: number;
};

export type PositionedWord = {
  text: string;
  confidence: number;
  left: number;
  top: number;
  width: number;
  height: number;
};

export type LabelledFormStructure = FormStructure & {
  label: string;
  labelConfidence: number;
  options?: string[];
  /** Overrides the default `local-structure:<kind>` provenance. */
  detectionSource?: string;
};

type PixelSource = {
  width: number;
  height: number;
  data: Uint8ClampedArray;
};

type Segment = {
  from: number;
  to: number;
  position: number;
  thickness: number;
};

const MAX_STRUCTURE_ANALYSIS_PIXELS = 4_000_000;
const MAX_DATE_SEGMENT_CANDIDATES = 200;

function sourceLuminance(source: PixelSource) {
  const result = new Uint8ClampedArray(source.width * source.height);
  for (let pixel = 0; pixel < result.length; pixel += 1) {
    const offset = pixel * 4;
    result[pixel] =
      source.data[offset + 3]! > 20
        ? Math.round(
            source.data[offset]! * 0.299 +
              source.data[offset + 1]! * 0.587 +
              source.data[offset + 2]! * 0.114
          )
        : 255;
  }
  return result;
}

function thresholdedPixels(
  luminance: Uint8ClampedArray,
  threshold: number | ((mean: number) => number),
  width: number,
  height: number
) {
  const result = new Uint8Array(luminance.length);
  if (typeof threshold === "number") {
    for (let pixel = 0; pixel < result.length; pixel += 1)
      result[pixel] = luminance[pixel]! <= threshold ? 1 : 0;
    return result;
  }

  // An integral image makes local mean thresholding linear in the bounded
  // analysis canvas size, so scans with dim or uneven paper stay affordable.
  const integral = new Uint32Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y += 1) {
    let rowSum = 0;
    for (let x = 0; x < width; x += 1) {
      rowSum += luminance[y * width + x]!;
      integral[(y + 1) * (width + 1) + x + 1]! =
        integral[y * (width + 1) + x + 1]! + rowSum;
    }
  }

  const radius = Math.max(10, Math.round(Math.min(width, height) * 0.032));
  for (let y = 0; y < height; y += 1) {
    const top = Math.max(0, y - radius);
    const bottom = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x += 1) {
      const left = Math.max(0, x - radius);
      const right = Math.min(width - 1, x + radius);
      const area = (bottom - top + 1) * (right - left + 1);
      const sum =
        integral[(bottom + 1) * (width + 1) + right + 1]! -
        integral[top * (width + 1) + right + 1]! -
        integral[(bottom + 1) * (width + 1) + left]! +
        integral[top * (width + 1) + left]!;
      const mean = sum / area;
      result[y * width + x] =
        luminance[y * width + x]! <= threshold(mean) ? 1 : 0;
    }
  }
  return result;
}

function runs(values: Uint8Array, minimum: number, maximumGap = 1) {
  const result: Array<{ from: number; to: number }> = [];
  let start = -1;
  let gap = 0;
  for (let index = 0; index <= values.length; index += 1) {
    const dark = index < values.length && values[index] === 1;
    if (dark) {
      if (start < 0) start = index;
      gap = 0;
    } else if (start >= 0) {
      gap += 1;
      if (gap > maximumGap || index === values.length) {
        const end = index - gap + 1;
        if (end - start >= minimum) result.push({ from: start, to: end });
        start = -1;
        gap = 0;
      }
    }
  }
  return result;
}

function overlapRatio(
  a: { from: number; to: number },
  b: { from: number; to: number }
) {
  const overlap = Math.max(0, Math.min(a.to, b.to) - Math.max(a.from, b.from));
  return overlap / Math.max(1, Math.min(a.to - a.from, b.to - b.from));
}

function mergeAdjacent(rows: Segment[]) {
  const merged: Segment[] = [];
  for (const row of rows) {
    const existing = merged.find(candidate => {
      const rowLength = row.to - row.from;
      const candidateLength = candidate.to - candidate.from;
      return (
        row.position <= candidate.position + candidate.thickness + 2 &&
        overlapRatio(row, candidate) >= 0.72 &&
        Math.min(rowLength, candidateLength) /
          Math.max(1, Math.max(rowLength, candidateLength)) >=
          0.6
      );
    });
    if (!existing) {
      merged.push({ ...row });
      continue;
    }
    existing.from = Math.round((existing.from + row.from) / 2);
    existing.to = Math.round((existing.to + row.to) / 2);
    existing.thickness = Math.max(
      existing.thickness,
      row.position - existing.position + row.thickness
    );
  }
  return merged;
}

function horizontalSegments(
  pixels: Uint8Array,
  width: number,
  height: number,
  maximumGap = 1
) {
  const minimum = Math.max(12, Math.round(width * 0.018));
  const segments: Segment[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = pixels.subarray(y * width, (y + 1) * width);
    for (const run of runs(row, minimum, maximumGap))
      segments.push({ ...run, position: y, thickness: 1 });
  }
  return mergeAdjacent(segments);
}

function verticalSegments(
  pixels: Uint8Array,
  width: number,
  height: number,
  maximumGap = 1
) {
  const minimum = Math.max(8, Math.round(height * 0.012));
  const segments: Segment[] = [];
  const column = new Uint8Array(height);
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) column[y] = pixels[y * width + x]!;
    for (const run of runs(column, minimum, maximumGap))
      segments.push({ ...run, position: x, thickness: 1 });
  }
  return mergeAdjacent(segments);
}

function stitchCollinearSegments(
  segments: Segment[],
  maximumGap: number,
  positionTolerance: number
) {
  const stitched: Segment[] = [];
  const ordered = [...segments].sort(
    (left, right) => left.position - right.position || left.from - right.from
  );
  for (const segment of ordered) {
    const existing = stitched.find(
      candidate =>
        Math.abs(candidate.position - segment.position) <= positionTolerance &&
        segment.from <= candidate.to + maximumGap &&
        segment.to >= candidate.from - maximumGap
    );
    if (!existing) {
      stitched.push({ ...segment });
      continue;
    }
    existing.from = Math.min(existing.from, segment.from);
    existing.to = Math.max(existing.to, segment.to);
    existing.position = Math.round((existing.position + segment.position) / 2);
    existing.thickness = Math.max(existing.thickness, segment.thickness);
  }
  return stitched;
}

function hasSide(vertical: Segment[], x: number, top: number, bottom: number) {
  const tolerance = 4;
  return vertical.some(
    side =>
      Math.abs(side.position - x) <= tolerance &&
      side.from <= top + tolerance &&
      side.to >= bottom - tolerance
  );
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
    return overlap / Math.max(1, smaller) > 0.72;
  });
}

function regionDarkRatio(
  pixels: Uint8Array,
  imageWidth: number,
  imageHeight: number,
  left: number,
  top: number,
  width: number,
  height: number
) {
  const x0 = Math.max(0, Math.floor(left));
  const y0 = Math.max(0, Math.floor(top));
  const x1 = Math.min(imageWidth, Math.ceil(left + width));
  const y1 = Math.min(imageHeight, Math.ceil(top + height));
  let dark = 0;
  let total = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      dark += pixels[y * imageWidth + x]!;
      total += 1;
    }
  }
  return dark / Math.max(1, total);
}

function contains(
  container: FormStructure,
  item: { left: number; top: number; width: number; height: number }
) {
  const tolerance = 5;
  return (
    item.left >= container.left - tolerance &&
    item.top >= container.top - tolerance &&
    item.left + item.width <= container.left + container.width + tolerance &&
    item.top + item.height <= container.top + container.height + tolerance
  );
}

function cellIsBlank(
  pixels: Uint8Array,
  imageWidth: number,
  left: number,
  top: number,
  width: number,
  height: number
) {
  const inset = Math.max(
    1,
    Math.min(6, Math.round(Math.min(width, height) * 0.08))
  );
  const x0 = Math.max(0, left + inset);
  const y0 = Math.max(0, top + inset);
  const x1 = Math.max(x0, Math.min(imageWidth, left + width - inset));
  const probeWidth = x1 - x0;
  if (probeWidth < 4 || height - inset * 2 < 4) return true;

  const probeHeight = height - inset * 2;
  const probe = new Uint8Array(probeWidth * probeHeight);
  for (let y = 0; y < probeHeight; y += 1) {
    for (let x = 0; x < probeWidth; x += 1) {
      probe[y * probeWidth + x] = pixels[(y0 + y) * imageWidth + x0 + x] ?? 0;
    }
  }

  const speckleLimit = Math.max(4, Math.round(probe.length * 0.0006));
  const glyphHeight = Math.max(
    5,
    Math.round(Math.min(probeWidth, probeHeight) * 0.22)
  );
  const glyphArea = Math.max(8, Math.round(probe.length * 0.008));
  // A cell that already carries a short rule, a stroke, or a small printed
  // digit is not writable. Scan speckles stay below all three gates.
  const strokeLength = Math.max(4, Math.round(probeWidth * 0.16));
  const strokeArea = Math.max(6, Math.round(probe.length * 0.0025));
  const smallGlyphHeight = Math.max(3, Math.round(probeHeight * 0.16));
  const smallGlyphArea = Math.max(6, Math.round(probe.length * 0.003));
  let residual = 0;
  for (const component of connectedComponents(probe, probeWidth, probeHeight)) {
    if (component.pixels <= speckleLimit) continue;
    if (component.height >= glyphHeight && component.pixels >= glyphArea)
      return false;
    if (component.pixels >= strokeArea && component.width >= strokeLength)
      return false;
    if (
      component.pixels >= smallGlyphArea &&
      component.height >= smallGlyphHeight &&
      component.width >= 2
    )
      return false;
    residual += component.pixels;
  }
  return residual / probe.length < 0.03;
}

function tableCellRectangles(rows: Segment[], columns: Segment[]) {
  const rectangles: Array<{
    row: number;
    column: number;
    left: number;
    top: number;
    width: number;
    height: number;
  }> = [];
  for (let rowIndex = 0; rowIndex < rows.length - 1; rowIndex += 1) {
    const top = rows[rowIndex]!;
    const bottom = rows[rowIndex + 1]!;
    for (
      let columnIndex = 0;
      columnIndex < columns.length - 1;
      columnIndex += 1
    ) {
      const left = columns[columnIndex]!;
      const right = columns[columnIndex + 1]!;
      rectangles.push({
        row: rowIndex,
        column: columnIndex,
        left: left.position + left.thickness,
        top: top.position + top.thickness,
        width: Math.max(0, right.position - left.position - left.thickness - 1),
        height: Math.max(0, bottom.position - top.position - top.thickness - 1),
      });
    }
  }
  return rectangles;
}

function detectTables(
  pixels: Uint8Array,
  horizontal: Segment[],
  vertical: Segment[],
  imageWidth: number,
  imageHeight: number
) {
  const maximumRuleThickness = Math.max(
    6,
    Math.round(Math.min(imageWidth, imageHeight) * 0.006)
  );
  const maximumStitchGap = Math.min(16, Math.max(12, maximumRuleThickness * 2));
  const horizontalRules = stitchCollinearSegments(
    horizontal.filter(line => line.thickness <= maximumRuleThickness),
    maximumStitchGap,
    Math.max(3, Math.round(maximumRuleThickness / 2))
  );
  const verticalRules = stitchCollinearSegments(
    vertical.filter(line => line.thickness <= maximumRuleThickness),
    maximumStitchGap,
    Math.max(3, Math.round(maximumRuleThickness / 2))
  );
  const candidates = horizontalRules.filter(
    line => line.to - line.from >= Math.max(60, imageWidth * 0.12)
  );
  const tables: FormStructure[] = [];
  for (const seed of candidates) {
    const rows = candidates
      .filter(
        line =>
          Math.abs(line.from - seed.from) <= 6 &&
          Math.abs(line.to - seed.to) <= 6
      )
      .sort((a, b) => a.position - b.position);
    if (rows.length < 2) continue;
    const uniqueRows = rows.filter(
      (line, index) =>
        index === 0 || line.position - rows[index - 1]!.position > 3
    );
    if (uniqueRows.length < 2) continue;
    const top = uniqueRows[0]!.position;
    const bottom = uniqueRows.at(-1)!.position;
    if (bottom - top < Math.max(24, imageHeight * 0.04)) continue;
    const left = Math.round(
      uniqueRows.reduce((sum, line) => sum + line.from, 0) / uniqueRows.length
    );
    const right = Math.round(
      uniqueRows.reduce((sum, line) => sum + line.to, 0) / uniqueRows.length
    );
    const columns = verticalRules
      .filter(
        line =>
          line.position >= left - 6 &&
          line.position <= right + 6 &&
          line.from <= top + 6 &&
          line.to >= bottom - 6
      )
      .sort((a, b) => a.position - b.position)
      .filter(
        (line, index, lines) =>
          index === 0 || line.position - lines[index - 1]!.position > 3
      );
    if (columns.length < 2) continue;
    const rowCount = uniqueRows.length - 1;
    const columnCount = columns.length - 1;
    if (rowCount === 1 && columnCount === 1) continue;
    if (rowCount === 1 && columnCount >= 3) {
      const gaps = columns
        .slice(1)
        .map((line, index) => line.position - columns[index]!.position);
      const smallest = Math.min(...gaps);
      const largest = Math.max(...gaps);
      const average = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
      const rowHeight = bottom - top;
      if (
        smallest >= 5 &&
        largest / smallest <= 1.45 &&
        average / Math.max(1, rowHeight) >= 0.5 &&
        average / Math.max(1, rowHeight) <= 1.6
      )
        continue;
    }
    if (columnCount === 1 && rowCount >= 3) {
      const averageRowHeight = (bottom - top) / rowCount;
      const widthToRowHeight = (right - left) / Math.max(1, averageRowHeight);
      if (widthToRowHeight >= 0.5 && widthToRowHeight <= 1.6) continue;
    }
    const cells = tableCellRectangles(uniqueRows, columns);
    const writableCells = cells
      .filter(cell =>
        cellIsBlank(
          pixels,
          imageWidth,
          cell.left,
          cell.top,
          cell.width,
          cell.height
        )
      )
      .map(cell => ({ row: cell.row, column: cell.column }));
    if (!writableCells.length) continue;
    const table: FormStructure = {
      kind: "table",
      left,
      top,
      width: right - left,
      height: bottom - top,
      confidence: 0.9,
      emptyCells: writableCells.length,
      writableCells,
      rows: rowCount,
      columns: columnCount,
      cellGuides: cells.map(cell => ({
        xRatio: (cell.left - left) / (right - left),
        yRatio: (cell.top - top) / (bottom - top),
        widthRatio: cell.width / (right - left),
        heightRatio: cell.height / (bottom - top),
      })),
      members: [
        ...uniqueRows.map(line => ({
          left: line.from,
          top: line.position,
          width: line.to - line.from,
          height: line.thickness,
        })),
        ...columns.map(line => ({
          left: line.position,
          top: line.from,
          width: line.thickness,
          height: line.to - line.from,
        })),
      ],
    };
    if (!isDuplicate(table, tables)) tables.push(table);
  }
  return tables;
}

function detectCharacterBoxRows(
  horizontal: Segment[],
  vertical: Segment[],
  imageWidth: number,
  imageHeight: number
) {
  const rows: FormStructure[] = [];
  const maximumHeight = Math.max(60, imageHeight * 0.1);
  for (let topIndex = 0; topIndex < horizontal.length; topIndex += 1) {
    const top = horizontal[topIndex]!;
    for (
      let bottomIndex = topIndex + 1;
      bottomIndex < horizontal.length;
      bottomIndex += 1
    ) {
      const bottom = horizontal[bottomIndex]!;
      const height = bottom.position - top.position;
      if (height < 8 || height > maximumHeight) continue;
      if (
        Math.abs(top.from - bottom.from) > 6 ||
        Math.abs(top.to - bottom.to) > 6
      )
        continue;
      const left = Math.round((top.from + bottom.from) / 2);
      const right = Math.round((top.to + bottom.to) / 2);
      const dividers = vertical
        .filter(
          line =>
            line.position >= left - 5 &&
            line.position <= right + 5 &&
            line.from <= top.position + 5 &&
            line.to >= bottom.position - 5
        )
        .sort((a, b) => a.position - b.position)
        .filter(
          (line, index, lines) =>
            index === 0 || line.position - lines[index - 1]!.position > 3
        );
      if (dividers.length < 4) continue;
      const gaps = dividers
        .slice(1)
        .map((line, index) => line.position - dividers[index]!.position);
      const smallest = Math.min(...gaps);
      const largest = Math.max(...gaps);
      const average = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
      if (
        smallest < 5 ||
        largest / smallest > 1.45 ||
        average / height < 0.5 ||
        average / height > 1.6 ||
        right - left > imageWidth * 0.9
      )
        continue;
      const candidate: FormStructure = {
        kind: "character-box",
        left,
        top: top.position,
        width: right - left,
        height,
        confidence: 0.95,
        boxCount: dividers.length - 1,
        members: gaps.map((gap, index) => ({
          left: dividers[index]!.position,
          top: top.position,
          width: gap,
          height,
        })),
      };
      if (!isDuplicate(candidate, rows)) rows.push(candidate);
      break;
    }
  }
  return rows;
}

function consolidateCharacterBoxes(
  structures: FormStructure[],
  vertical: Segment[]
) {
  const subdivided = structures.map(item => {
    if (item.kind !== "text-box") return item;
    const dividers = vertical
      .filter(
        line =>
          line.position >= item.left - 4 &&
          line.position <= item.left + item.width + 4 &&
          line.from <= item.top + 4 &&
          line.to >= item.top + item.height - 4
      )
      .sort((a, b) => a.position - b.position)
      .filter(
        (line, index, lines) =>
          index === 0 || line.position - lines[index - 1]!.position > 3
      );
    if (dividers.length < 4) return item;
    const gaps = dividers
      .slice(1)
      .map((line, index) => line.position - dividers[index]!.position);
    const smallest = Math.min(...gaps);
    const largest = Math.max(...gaps);
    const average = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
    if (
      smallest < 5 ||
      largest / smallest > 1.45 ||
      average / Math.max(1, item.height) < 0.55 ||
      average / Math.max(1, item.height) > 1.55
    )
      return item;
    return {
      ...item,
      kind: "character-box" as const,
      confidence: 0.94,
      boxCount: dividers.length - 1,
      members: gaps.map((gap, index) => ({
        left: dividers[index]!.position,
        top: item.top,
        width: gap,
        height: item.height,
      })),
    };
  });
  const squareBoxes = subdivided.filter(item => {
    if (item.kind !== "checkbox" && item.kind !== "text-box") return false;
    const ratio = item.width / Math.max(1, item.height);
    return ratio >= 0.68 && ratio <= 1.45;
  });
  const consumed = new Set<FormStructure>();
  const groups: FormStructure[] = [];
  for (const seed of squareBoxes) {
    if (consumed.has(seed)) continue;
    const aligned = squareBoxes
      .filter(item => {
        if (consumed.has(item)) return false;
        const heightRatio = item.height / Math.max(1, seed.height);
        const widthRatio = item.width / Math.max(1, seed.width);
        return (
          Math.abs(item.top - seed.top) <= Math.max(4, seed.height * 0.22) &&
          heightRatio >= 0.78 &&
          heightRatio <= 1.28 &&
          widthRatio >= 0.78 &&
          widthRatio <= 1.28
        );
      })
      .sort((a, b) => a.left - b.left);
    const sequence: FormStructure[] = [];
    for (const item of aligned) {
      const previous = sequence.at(-1);
      if (!previous) {
        sequence.push(item);
        continue;
      }
      const gap = item.left - (previous.left + previous.width);
      if (gap >= -4 && gap <= Math.max(7, seed.width * 0.42))
        sequence.push(item);
      else if (sequence.length < 3) sequence.splice(0, sequence.length, item);
    }
    if (sequence.length < 3) continue;
    sequence.forEach(item => consumed.add(item));
    const left = Math.min(...sequence.map(item => item.left));
    const top = Math.min(...sequence.map(item => item.top));
    const right = Math.max(...sequence.map(item => item.left + item.width));
    const bottom = Math.max(...sequence.map(item => item.top + item.height));
    groups.push({
      kind: "character-box",
      left,
      top,
      width: right - left,
      height: bottom - top,
      confidence: 0.92,
      boxCount: sequence.length,
      members: sequence.map(item => ({
        left: item.left,
        top: item.top,
        width: item.width,
        height: item.height,
      })),
    });
  }
  return [...subdivided.filter(item => !consumed.has(item)), ...groups];
}

/**
 * A date separator is a slanted stroke, not "some ink". Dark-pixel ratio alone
 * accepts two vertical rules or a smudge, so each candidate stroke is tested
 * for a consistent diagonal direction before the gap counts as a separator.
 */
function gapHasSlashInk(
  pixels: Uint8Array,
  imageWidth: number,
  imageHeight: number,
  left: number,
  right: number,
  top: number,
  bottom: number
) {
  const x0 = Math.max(0, Math.floor(left));
  const y0 = Math.max(0, Math.floor(top));
  const x1 = Math.min(imageWidth, Math.ceil(right));
  const y1 = Math.min(imageHeight, Math.ceil(bottom));
  const probeWidth = x1 - x0;
  const probeHeight = y1 - y0;
  if (probeWidth < 3 || probeHeight < 4) return false;

  const probe = new Uint8Array(probeWidth * probeHeight);
  for (let y = 0; y < probeHeight; y += 1)
    for (let x = 0; x < probeWidth; x += 1)
      probe[y * probeWidth + x] = pixels[(y0 + y) * imageWidth + x0 + x] ?? 0;

  const minimumPixels = Math.max(4, Math.round(probeHeight * 0.35));
  const minimumHeight = Math.max(3, Math.round(probeHeight * 0.25));
  for (const component of connectedComponents(probe, probeWidth, probeHeight)) {
    if (component.pixels < minimumPixels) continue;
    if (component.height < minimumHeight) continue;
    if (component.width < 2) continue;
    const count = component.pixels;
    const varianceX = component.sumXX - (component.sumX * component.sumX) / count;
    const varianceY = component.sumYY - (component.sumY * component.sumY) / count;
    const covariance =
      component.sumXY - (component.sumX * component.sumY) / count;
    if (varianceX <= 0 || varianceY <= 0) continue;
    // |slope| of x against y: a vertical rule tends to 0, a horizontal rule to
    // infinity, and a printed "/" or "\" sits comfortably between.
    const slope = Math.abs(covariance / varianceY);
    const correlation = Math.abs(
      covariance / Math.sqrt(varianceX * varianceY)
    );
    if (slope < 0.25 || slope > 4) continue;
    if (correlation < 0.75) continue;
    return true;
  }
  return false;
}

const MIN_DATE_SEGMENT_CAPACITY = 1;
const MAX_DATE_SEGMENT_CAPACITY = 8;

/**
 * Printed date rules carry more than one character each: the narrowest segment
 * is a two-digit day or month, so every segment is sized against that unit.
 * A DD / MM / YYYY rule therefore reports [2, 2, 4] instead of one box each.
 */
function dateSegmentCapacities(segments: Segment[]) {
  const widths = segments.map(segment => segment.to - segment.from);
  const unit = Math.max(1, Math.min(...widths) / 2);
  return widths.map(width =>
    Math.max(
      MIN_DATE_SEGMENT_CAPACITY,
      Math.min(MAX_DATE_SEGMENT_CAPACITY, Math.round(width / unit))
    )
  );
}

function detectDateSegmentGroups(
  horizontal: Segment[],
  pixels: Uint8Array,
  source: PixelSource
) {
  const groups: FormStructure[] = [];
  const minimumWidth = Math.max(18, source.width * 0.045);
  const maximumWidth = source.width * 0.16;
  const maximumGap = Math.max(8, source.width * 0.06);
  const rowTolerance = Math.max(4, Math.round(source.height * 0.012));
  const candidates = horizontal
    .filter(
      line =>
        line.thickness <= 2 &&
        line.to - line.from >= minimumWidth &&
        line.to - line.from <= maximumWidth
    )
    .sort(
      (left, right) => left.position - right.position || left.from - right.from
    )
    .slice(0, MAX_DATE_SEGMENT_CANDIDATES);

  for (const first of candidates) {
    const sameRow = candidates.filter(
      candidate =>
        candidate !== first &&
        Math.abs(candidate.position - first.position) <= rowTolerance &&
        candidate.from > first.to &&
        candidate.from - first.to <= maximumGap
    );
    for (const second of sameRow) {
      const thirdCandidates = candidates.filter(
        candidate =>
          candidate !== first &&
          candidate !== second &&
          Math.abs(candidate.position - first.position) <= rowTolerance &&
          candidate.from > second.to &&
          candidate.from - second.to <= maximumGap
      );
      for (const third of thirdCandidates) {
        const widths = [
          first.to - first.from,
          second.to - second.from,
          third.to - third.from,
        ].sort((left, right) => left - right);
        if (widths[0]! / Math.max(1, widths[2]!) < 0.45) continue;
        const slashTop = Math.max(
          0,
          first.position - Math.max(14, Math.round(source.height * 0.05))
        );
        const slashBottom = first.position + first.thickness + 4;
        if (
          !gapHasSlashInk(
            pixels,
            source.width,
            source.height,
            first.to + 1,
            second.from,
            slashTop,
            slashBottom
          ) ||
          !gapHasSlashInk(
            pixels,
            source.width,
            source.height,
            second.to + 1,
            third.from,
            slashTop,
            slashBottom
          )
        )
          continue;

        const left = Math.min(first.from, second.from, third.from);
        const right = Math.max(first.to, second.to, third.to);
        const segments = [first, second, third];
        const boxHeight = Math.max(16, Math.round(widths[2]! * 0.72));
        const top = Math.max(0, first.position - boxHeight + first.thickness);
        const capacities = dateSegmentCapacities(segments);
        const candidate: FormStructure = {
          kind: "character-box",
          left,
          top,
          width: right - left,
          height: boxHeight,
          confidence: 0.88,
          boxCount: capacities.reduce((sum, count) => sum + count, 0),
          segmentCapacities: capacities,
          members: segments.flatMap((segment, segmentIndex) => {
            const capacity = capacities[segmentIndex]!;
            const cellWidth = (segment.to - segment.from) / capacity;
            return Array.from({ length: capacity }, (_, cellIndex) => ({
              left: segment.from + cellIndex * cellWidth,
              top,
              width: cellWidth,
              height: segment.position + segment.thickness - top,
            }));
          }),
        };
        if (!isDuplicate(candidate, groups)) groups.push(candidate);
        break;
      }
    }
  }
  return groups;
}

function connectedComponents(
  pixels: Uint8Array,
  width: number,
  height: number
) {
  const visited = new Uint8Array(pixels.length);
  const components: Array<{
    left: number;
    top: number;
    width: number;
    height: number;
    pixels: number;
    sumX: number;
    sumY: number;
    sumXX: number;
    sumYY: number;
    sumXY: number;
  }> = [];
  const queue = new Int32Array(pixels.length);
  for (let origin = 0; origin < pixels.length; origin += 1) {
    if (!pixels[origin] || visited[origin]) continue;
    let queueLength = 1;
    queue[0] = origin;
    visited[origin] = 1;
    let cursor = 0;
    let left = origin % width;
    let right = left;
    let top = Math.floor(origin / width);
    let bottom = top;
    let count = 0;
    let sumX = 0;
    let sumY = 0;
    let sumXX = 0;
    let sumYY = 0;
    let sumXY = 0;
    while (cursor < queueLength) {
      const current = queue[cursor++]!;
      const x = current % width;
      const y = Math.floor(current / width);
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
      count += 1;
      sumX += x;
      sumY += y;
      sumXX += x * x;
      sumYY += y * y;
      sumXY += x * y;
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          if (!offsetX && !offsetY) continue;
          const nextX = x + offsetX;
          const nextY = y + offsetY;
          if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height)
            continue;
          const next = nextY * width + nextX;
          if (!pixels[next] || visited[next]) continue;
          visited[next] = 1;
          queue[queueLength++] = next;
        }
      }
    }
    components.push({
      left,
      top,
      width: right - left + 1,
      height: bottom - top + 1,
      pixels: count,
      sumX,
      sumY,
      sumXX,
      sumYY,
      sumXY,
    });
  }
  return components;
}

function detectRadioGroups(pixels: Uint8Array, width: number, height: number) {
  const maxDiameter = Math.max(34, width * 0.045);
  const components = connectedComponents(pixels, width, height);
  const circles = components.filter(component => {
    const ratio = component.width / Math.max(1, component.height);
    if (
      component.width < 8 ||
      component.height < 8 ||
      component.width > maxDiameter ||
      component.height > maxDiameter ||
      ratio < 0.72 ||
      ratio > 1.38
    )
      return false;
    const fill = component.pixels / (component.width * component.height);
    const center = regionDarkRatio(
      pixels,
      width,
      height,
      component.left + component.width * 0.34,
      component.top + component.height * 0.34,
      component.width * 0.32,
      component.height * 0.32
    );
    const corner =
      regionDarkRatio(
        pixels,
        width,
        height,
        component.left,
        component.top,
        component.width * 0.24,
        component.height * 0.24
      ) +
      regionDarkRatio(
        pixels,
        width,
        height,
        component.left + component.width * 0.76,
        component.top,
        component.width * 0.24,
        component.height * 0.24
      );
    return fill >= 0.12 && fill <= 0.62 && center < 0.22 && corner < 0.9;
  });
  const consumed = new Set<(typeof circles)[number]>();
  const groups: FormStructure[] = [];
  for (const seed of circles) {
    if (consumed.has(seed)) continue;
    const aligned = circles
      .filter(circle => {
        const sizeRatio = circle.width / Math.max(1, seed.width);
        return (
          !consumed.has(circle) &&
          sizeRatio >= 0.72 &&
          sizeRatio <= 1.38 &&
          Math.abs(circle.top - seed.top) <= Math.max(5, seed.height * 0.45)
        );
      })
      .sort((a, b) => a.left - b.left);
    if (aligned.length < 2) continue;
    const spaced = aligned.filter((circle, index) => {
      if (index === 0) return true;
      const previous = aligned[index - 1]!;
      const distance = circle.left - previous.left;
      return distance >= seed.width * 1.8 && distance <= seed.width * 18;
    });
    if (spaced.length < 2) continue;
    spaced.forEach(circle => consumed.add(circle));
    const left = Math.min(...spaced.map(circle => circle.left));
    const top = Math.min(...spaced.map(circle => circle.top));
    const right = Math.max(...spaced.map(circle => circle.left + circle.width));
    const bottom = Math.max(
      ...spaced.map(circle => circle.top + circle.height)
    );
    groups.push({
      kind: "radio",
      left,
      top,
      width: right - left,
      height: bottom - top,
      confidence: 0.82,
      members: spaced.map(circle => ({
        left: circle.left,
        top: circle.top,
        width: circle.width,
        height: circle.height,
      })),
    });
  }
  return groups;
}

export function detectFormStructuresFromPixels(
  source: PixelSource
): FormStructure[] {
  if (source.width < 20 || source.height < 20) return [];
  if (source.data.length !== source.width * source.height * 4) return [];
  const luminance = sourceLuminance(source);
  const pixels = thresholdedPixels(
    luminance,
    mean => mean - Math.max(18, mean * 0.09),
    source.width,
    source.height
  );
  const strictPixels = thresholdedPixels(
    luminance,
    205,
    source.width,
    source.height
  );
  const horizontal = horizontalSegments(pixels, source.width, source.height);
  const structuralHorizontal = horizontalSegments(
    pixels,
    source.width,
    source.height,
    3
  );
  const structuralVertical = verticalSegments(
    pixels,
    source.width,
    source.height,
    3
  );
  const structures: FormStructure[] = [];
  const maxBoxHeight = Math.max(80, Math.round(source.height * 0.15));
  const tables = detectTables(
    pixels,
    structuralHorizontal,
    structuralVertical,
    source.width,
    source.height
  );
  structures.push(...tables);
  const characterRows = detectCharacterBoxRows(
    structuralHorizontal,
    structuralVertical,
    source.width,
    source.height
  ).filter(row => !tables.some(table => contains(table, row)));
  structures.push(...characterRows);
  for (
    let firstIndex = 0;
    firstIndex < structuralHorizontal.length;
    firstIndex += 1
  ) {
    const top = structuralHorizontal[firstIndex]!;
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < structuralHorizontal.length;
      secondIndex += 1
    ) {
      const bottom = structuralHorizontal[secondIndex]!;
      const height = bottom.position - top.position;
      if (height < 7 || height > maxBoxHeight) continue;
      if (
        Math.abs(top.from - bottom.from) > 5 ||
        Math.abs(top.to - bottom.to) > 5
      )
        continue;
      const width =
        Math.min(top.to, bottom.to) - Math.max(top.from, bottom.from);
      if (width < 8 || width > source.width * 0.985) continue;
      const left = Math.round((top.from + bottom.from) / 2);
      const right = Math.round((top.to + bottom.to) / 2);
      if (
        !hasSide(structuralVertical, left, top.position, bottom.position) ||
        !hasSide(structuralVertical, right, top.position, bottom.position)
      )
        continue;
      const square = width / height >= 0.8 && width / height <= 1.25;
      const kind: FormStructureKind =
        square && width <= Math.max(48, source.width * 0.055)
          ? "checkbox"
          : "text-box";
      if (
        kind === "text-box" &&
        (width < Math.max(30, source.width * 0.045) ||
          height < Math.max(8, source.height * 0.015))
      )
        continue;
      if (kind === "checkbox" && (width < 10 || height < 10)) continue;
      if (kind === "checkbox") {
        const inset = Math.max(3, Math.round(Math.min(width, height) * 0.28));
        const centerDarkness = regionDarkRatio(
          pixels,
          source.width,
          source.height,
          left + inset,
          top.position + inset,
          width - inset * 2,
          height - inset * 2
        );
        if (centerDarkness > 0.12) continue;
        const cornerSize = Math.max(
          3,
          Math.round(Math.min(width, height) * 0.28)
        );
        const cornerDarkness = [
          regionDarkRatio(
            pixels,
            source.width,
            source.height,
            left - 1,
            top.position - 1,
            cornerSize + 2,
            cornerSize + 2
          ),
          regionDarkRatio(
            pixels,
            source.width,
            source.height,
            right - cornerSize + 1,
            top.position - 1,
            cornerSize + 2,
            cornerSize + 2
          ),
          regionDarkRatio(
            pixels,
            source.width,
            source.height,
            left - 1,
            bottom.position - cornerSize + 1,
            cornerSize + 2,
            cornerSize + 2
          ),
          regionDarkRatio(
            pixels,
            source.width,
            source.height,
            right - cornerSize + 1,
            bottom.position - cornerSize + 1,
            cornerSize + 2,
            cornerSize + 2
          ),
        ];
        if (cornerDarkness.filter(value => value >= 0.16).length < 3) continue;
      }
      const candidate: FormStructure = {
        kind,
        left: left + Math.max(1, top.thickness),
        top: top.position + Math.max(1, top.thickness),
        width: Math.max(4, right - left - Math.max(2, top.thickness * 2)),
        height: Math.max(4, height - Math.max(2, top.thickness * 2)),
        confidence: kind === "checkbox" ? 0.91 : 0.94,
      };
      if (
        candidate.kind === "checkbox" &&
        (candidate.width < 8 || candidate.height < 8)
      )
        continue;
      if (
        tables.some(table => contains(table, candidate)) ||
        characterRows.some(row => contains(row, candidate))
      )
        break;
      if (!isDuplicate(candidate, structures)) structures.push(candidate);
      break;
    }
  }

  for (const dateGroup of detectDateSegmentGroups(
    structuralHorizontal,
    pixels,
    source
  )) {
    if (
      tables.some(table => contains(table, dateGroup)) ||
      characterRows.some(row => contains(row, dateGroup)) ||
      isDuplicate(dateGroup, structures)
    )
      continue;
    structures.push(dateGroup);
  }

  const grouped = consolidateCharacterBoxes(structures, structuralVertical);
  structures.splice(0, structures.length, ...grouped);
  const radioGroups = detectRadioGroups(
    strictPixels,
    source.width,
    source.height
  );
  for (const radio of radioGroups) {
    const memberStructures = new Set(
      structures.filter(
        item =>
          item.kind === "checkbox" &&
          radio.members?.some(member =>
            isDuplicate({ ...member, kind: "checkbox", confidence: 1 }, [item])
          )
      )
    );
    if (memberStructures.size)
      structures.splice(
        0,
        structures.length,
        ...structures.filter(item => !memberStructures.has(item))
      );
    if (
      !structures.some(item => contains(item, radio)) &&
      !isDuplicate(radio, structures)
    )
      structures.push(radio);
  }

  for (const line of horizontal) {
    const width = line.to - line.from;
    if (
      structures.some(
        structure =>
          structure.kind !== "underline" &&
          structure.kind !== "radio" &&
          line.position >= structure.top - 6 &&
          line.position <= structure.top + structure.height + 6 &&
          line.from >= structure.left - 8 &&
          line.to <= structure.left + structure.width + 8
      )
    )
      continue;
    if (line.thickness > 2) continue;
    if (width < Math.max(28, source.width * 0.08)) continue;
    // A full-width rule is usually a form blank, not decoration. Decorative
    // rules run margin to margin, so only those starting inside the left
    // margin are still rejected at that length.
    if (width > source.width * 0.92) continue;
    if (width > source.width * 0.65 && line.from <= source.width * 0.08)
      continue;
    if (line.position < 12 || line.position > source.height - 5) continue;
    const height = Math.max(
      12,
      Math.min(42, Math.round(source.height * 0.035))
    );
    if (
      regionDarkRatio(
        pixels,
        source.width,
        source.height,
        line.from,
        line.position - height,
        width,
        height - 3
      ) > 0.025
    )
      continue;
    const belowHeight = Math.max(3, Math.round(source.height * 0.004));
    if (
      line.position + belowHeight < source.height &&
      regionDarkRatio(
        pixels,
        source.width,
        source.height,
        line.from,
        line.position + line.thickness + 1,
        width,
        belowHeight
      ) > 0.08
    )
      continue;
    const candidate: FormStructure = {
      kind: "underline",
      left: line.from,
      top: Math.max(0, line.position - height),
      width,
      height,
      confidence: 0.78,
    };
    if (!isDuplicate(candidate, structures)) structures.push(candidate);
  }

  return structures
    .filter(item => item.width >= 4 && item.height >= 4)
    .sort((a, b) => a.top - b.top || a.left - b.left)
    .slice(0, 160);
}

function labelDistance(structure: FormStructure, word: PositionedWord) {
  const structureCenterY = structure.top + structure.height / 2;
  const wordCenterY = word.top + word.height / 2;
  const wordRight = word.left + word.width;
  const wordBottom = word.top + word.height;
  const leftDistance = structure.left - wordRight;
  const alignedLeft =
    leftDistance >= -3 &&
    leftDistance <= Math.max(180, structure.width * 1.8) &&
    Math.abs(structureCenterY - wordCenterY) <= Math.max(18, structure.height);
  if (alignedLeft)
    return leftDistance + Math.abs(structureCenterY - wordCenterY) * 2;

  const aboveDistance = structure.top - wordBottom;
  const overlapsHorizontally =
    wordRight >= structure.left - 12 &&
    word.left <= structure.left + structure.width + 12;
  if (aboveDistance >= -3 && aboveDistance <= 35 && overlapsHorizontally)
    return 100 + aboveDistance + Math.abs(word.left - structure.left) * 0.25;

  if (structure.kind === "checkbox") {
    const rightDistance = word.left - (structure.left + structure.width);
    if (
      rightDistance >= -3 &&
      rightDistance <= 90 &&
      Math.abs(structureCenterY - wordCenterY) <= Math.max(16, structure.height)
    )
      return 50 + rightDistance + Math.abs(structureCenterY - wordCenterY) * 2;
  }
  return Number.POSITIVE_INFINITY;
}

function radioOptions(structure: FormStructure, words: PositionedWord[]) {
  if (structure.kind !== "radio" || !structure.members?.length) return [];
  const options: PositionedWord[] = [];
  for (const member of structure.members) {
    const centerY = member.top + member.height / 2;
    const right = member.left + member.width;
    const best = words
      .filter(word => {
        const value = word.text
          .replace(/[^a-zA-Z0-9\u3400-\u9fff]/g, "")
          .trim();
        const distance = word.left - right;
        const wordCenterY = word.top + word.height / 2;
        return (
          value.length > 0 &&
          !/^[oO0]$/.test(value) &&
          distance >= -3 &&
          distance <= 150 &&
          Math.abs(centerY - wordCenterY) <= Math.max(18, member.height)
        );
      })
      .sort((a, b) => a.left - b.left)[0];
    if (best && !options.includes(best)) options.push(best);
  }
  return options;
}

export function labelFormStructures(
  structures: FormStructure[],
  words: PositionedWord[]
): LabelledFormStructure[] {
  const printableStructures = structures.filter(structure => {
    if (structure.kind !== "checkbox") return true;
    const structureArea = Math.max(1, structure.width * structure.height);
    return !words.some(word => {
      if (word.confidence < 30 || !word.text.trim()) return false;
      const left = Math.max(structure.left, word.left);
      const top = Math.max(structure.top, word.top);
      const right = Math.min(
        structure.left + structure.width,
        word.left + word.width
      );
      const bottom = Math.min(
        structure.top + structure.height,
        word.top + word.height
      );
      const overlapArea = Math.max(0, right - left) * Math.max(0, bottom - top);
      const wordArea = Math.max(1, word.width * word.height);
      return (
        overlapArea / structureArea >= 0.72 && wordArea / structureArea >= 1.8
      );
    });
  });
  return printableStructures.map((structure, index) => {
    const optionWords = radioOptions(structure, words);
    let best: PositionedWord | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const word of words) {
      if (!word.text.trim() || word.confidence < 5) continue;
      if (optionWords.includes(word)) continue;
      const distance = labelDistance(structure, word);
      if (distance < bestDistance) {
        best = word;
        bestDistance = distance;
      }
    }
    const fallbackLabel =
      structure.kind === "radio"
        ? `未命名單選 ${index + 1}`
        : structure.kind === "table"
          ? `未命名表格 ${index + 1}`
          : structure.kind === "character-box"
            ? `未命名逐格欄位 ${index + 1}`
            : `未命名欄位 ${index + 1}`;
    return {
      ...structure,
      label: best?.text.replace(/[:：]$/, "").trim() || fallbackLabel,
      labelConfidence: best
        ? Math.min(structure.confidence, best.confidence / 100)
        : 0,
      options: optionWords.map(word => word.text.replace(/[:：]$/, "").trim()),
    };
  });
}

export async function detectFormStructures(blob: Blob) {
  const bitmap = await createImageBitmap(blob);
  try {
    const { width: analysisWidth, height: analysisHeight } = boundedPixelSize(
      bitmap.width,
      bitmap.height,
      MAX_STRUCTURE_ANALYSIS_PIXELS
    );
    const canvas = document.createElement("canvas");
    canvas.width = analysisWidth;
    canvas.height = analysisHeight;
    const context = canvas.getContext("2d", {
      alpha: false,
      willReadFrequently: true,
    });
    if (!context) return [];
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, analysisWidth, analysisHeight);
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const structures = detectFormStructuresFromPixels({
      width: image.width,
      height: image.height,
      data: image.data,
    });
    if (analysisWidth === bitmap.width && analysisHeight === bitmap.height)
      return structures;
    const xScale = bitmap.width / analysisWidth;
    const yScale = bitmap.height / analysisHeight;
    return structures.map(structure => ({
      ...structure,
      left: structure.left * xScale,
      top: structure.top * yScale,
      width: structure.width * xScale,
      height: structure.height * yScale,
      members: structure.members?.map(member => ({
        left: member.left * xScale,
        top: member.top * yScale,
        width: member.width * xScale,
        height: member.height * yScale,
      })),
    }));
  } finally {
    bitmap.close();
  }
}
