import type { DetectedFieldBox } from "./form-model";

/** Import-only validation; line segments must never become cell rectangles. */
export function validImportCellGuides(value: unknown, rows: unknown, columns: unknown): DetectedFieldBox[] | undefined {
  if (!Number.isInteger(rows) || !Number.isInteger(columns) || Number(rows) < 1 || Number(rows) > 100 || Number(columns) < 1 || Number(columns) > 30 ||
      !Array.isArray(value) || value.length !== Number(rows) * Number(columns)) return undefined;
  const result: DetectedFieldBox[] = [];
  for (const g of value) {
    if (!g || ![g.xRatio, g.yRatio, g.widthRatio, g.heightRatio].every(v => typeof v === "number" && Number.isFinite(v)) ||
        g.xRatio < 0 || g.yRatio < 0 || g.widthRatio <= 0 || g.heightRatio <= 0 ||
        g.xRatio + g.widthRatio > 1 + 1e-9 || g.yRatio + g.heightRatio > 1 + 1e-9) return undefined;
    result.push({ xRatio: g.xRatio, yRatio: g.yRatio, widthRatio: g.widthRatio, heightRatio: g.heightRatio });
  }
  return result;
}

export function importCellRects(table: { left: number; top: number; width: number; height: number; rows?: number; columns?: number; cellGuides?: unknown }) {
  const guides = validImportCellGuides(table.cellGuides, table.rows, table.columns);
  return guides?.map(g => ({ left: table.left + g.xRatio * table.width, top: table.top + g.yRatio * table.height,
    right: table.left + (g.xRatio + g.widthRatio) * table.width, bottom: table.top + (g.yRatio + g.heightRatio) * table.height }));
}
