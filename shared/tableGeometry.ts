/**
 * Where a repeating-row field's cells sit inside its box.
 *
 * A table printed on a real form is rarely an even grid: row heights differ,
 * columns are not equal widths, and the first writable row usually starts
 * below the top of the box the detector drew around the table. Dividing the
 * box into equal parts therefore prints every value a little out of place,
 * and no amount of moving or resizing the whole field can correct it because
 * every cell shares that one box.
 *
 * A guide per cell records where that cell actually is, as ratios of the
 * field box, so a person can drag one cell onto the printed square without
 * disturbing its neighbours. The preview on screen and the PDF renderer read
 * the same guides, and the same grid size, so what is positioned is what
 * prints. With no guides stored the result is the plain even division these
 * two used before, which is what keeps older templates printing unchanged.
 */

export type TableCellRect = {
  xRatio: number;
  yRatio: number;
  widthRatio: number;
  heightRatio: number;
};

type TableDefinition = {
  tableColumns?: unknown;
  maxRows?: unknown;
  options?: unknown;
};

function positiveCount(value: unknown) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

/**
 * The grid size, decided identically for the preview and the PDF.
 *
 * Row slots grow past `maxRows` when more rows were actually entered: the
 * value is already stored and dropping rows here would print an incomplete
 * table. Validation reports the overflow separately.
 */
export function tableGridSize(definition: TableDefinition, rows: unknown[]) {
  const rowLengths = rows.map(row => (Array.isArray(row) ? row.length : 0));
  const columns = Math.max(
    1,
    positiveCount(definition.tableColumns),
    Array.isArray(definition.options) ? definition.options.length : 0,
    ...rowLengths
  );
  const rowSlots = Math.max(
    1,
    positiveCount(definition.maxRows),
    rows.length
  );
  return { rowSlots, columns };
}

/** The even division used wherever a cell has no guide of its own. */
export function uniformCellRect(
  rowSlots: number,
  columns: number,
  row: number,
  column: number
): TableCellRect {
  return {
    xRatio: column / columns,
    yRatio: row / rowSlots,
    widthRatio: 1 / columns,
    heightRatio: 1 / rowSlots,
  };
}

/** A stored guide, only if it is geometry that can actually be drawn. */
export function tableCellGuideAt(
  guides: unknown,
  index: number
): TableCellRect | null {
  if (!Array.isArray(guides)) return null;
  const guide = guides[index];
  if (!guide || typeof guide !== "object" || Array.isArray(guide)) return null;
  const box = guide as Record<string, unknown>;
  const xRatio = Number(box.xRatio);
  const yRatio = Number(box.yRatio);
  const widthRatio = Number(box.widthRatio);
  const heightRatio = Number(box.heightRatio);
  if (![xRatio, yRatio, widthRatio, heightRatio].every(Number.isFinite))
    return null;
  if (widthRatio <= 0 || heightRatio <= 0) return null;
  return { xRatio, yRatio, widthRatio, heightRatio };
}

/**
 * Guides are stored row by row, so the index of a cell depends on how many
 * columns the grid has. Anything the person has not positioned — including
 * rows entered beyond the grid the guides were made for — falls back to the
 * even division.
 */
export function tableCellIndex(columns: number, row: number, column: number) {
  return row * columns + column;
}

export function tableCellRect(
  guides: unknown,
  rowSlots: number,
  columns: number,
  row: number,
  column: number
): TableCellRect {
  return (
    tableCellGuideAt(guides, tableCellIndex(columns, row, column)) ??
    uniformCellRect(rowSlots, columns, row, column)
  );
}
