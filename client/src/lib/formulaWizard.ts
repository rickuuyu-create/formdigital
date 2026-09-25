import {
  columnIndexToName,
  columnNameToIndex,
  getFormulaReferencedColumns,
  resolveTableGridRoles,
  resolveEffectiveTableGrid,
  validateTableFormulaDefinition,
  type TableRoleDefinition,
  type TableFormulaCell,
  type FormulaLocale,
} from "@shared/tableFormula";

export type WizardKind = "multiply" | "add" | "subtract" | "percent" | "custom";
export type WizardSelection = {
  row: number;
  column: number;
  expression: string;
  decimalPlaces: number;
  wholeColumn: boolean;
};

export type ColumnTotalSelection = {
  sourceColumn: number;
  startRow: number;
  endRow: number;
  targetRow: number;
  targetColumn: number;
  decimalPlaces: number;
};

// Show only writable inputs that can affect the result, following existing
// same-row formula dependencies. Fixed cells are not editable sample inputs.
export function wizardSampleColumns(
  definition: TableRoleDefinition,
  row: number,
  target: number,
  expression: string,
): number[] {
  const columns = Number(definition.tableColumns),
    rows = Number(definition.maxRows);
  const roles = resolveTableGridRoles(definition, rows, columns, true);
  const visited = new Set<number>([target]),
    inputs = new Set<number>();
  const visit = (expr: string) => {
    for (const name of getFormulaReferencedColumns(expr).columns) {
      const c = columnNameToIndex(name);
      if (c < 0 || c >= columns || visited.has(c)) continue;
      visited.add(c);
      if (roles.getRole(row, c) === "writable") inputs.add(c);
      else if (roles.getRole(row, c) === "formula")
        visit(roles.formulaMap.get(`${row}:${c}`)!.expression);
    }
  };
  visit(expression);
  return Array.from(inputs).sort((a, b) => a - b);
}

export function buildWizardExpression(
  kind: WizardKind,
  left: number,
  right: number,
  custom: string,
) {
  if (kind === "custom") return custom.trim();
  const a = columnIndexToName(left),
    b = columnIndexToName(right);
  if (!a || !b) return "";
  switch (kind) {
    case "multiply":
      return `${a}*${b}`;
    case "add":
      return `${a}+${b}`;
    case "subtract":
      return `${a}-${b}`;
    case "percent":
      return `${a}*${b}/100`;
  }
}

// Produces a proposed patch only. No persistence, no second formula evaluator.
export function planFormulaWizard(
  definition: TableRoleDefinition,
  selection: WizardSelection,
  samples: string[][],
  locale: FormulaLocale,
) {
  const columns = Number(definition.tableColumns),
    rows = Number(definition.maxRows);
  const { row, column, decimalPlaces, wholeColumn } = selection;
  if (
    !Number.isInteger(columns) ||
    columns < 1 ||
    columns > 30 ||
    !Number.isInteger(rows) ||
    rows < 1 ||
    rows > 100 ||
    !Number.isInteger(row) ||
    row < 0 ||
    row >= rows ||
    !Number.isInteger(column) ||
    column < 0 ||
    column >= columns ||
    !Number.isInteger(decimalPlaces) ||
    decimalPlaces < 0 ||
    decimalPlaces > 6
  )
    throw new Error("INVALID_WIZARD_TARGET");
  const roles = resolveTableGridRoles(definition, rows, columns, true);
  const writable: Array<{ row: number; column: number }> = [];
  const formulas: TableFormulaCell[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < columns; c++) {
      if (c === column && (wholeColumn || r === row)) {
        formulas.push({
          row: r,
          column: c,
          expression: selection.expression.trim(),
          decimalPlaces,
        });
      } else if (roles.getRole(r, c) === "writable")
        writable.push({ row: r, column: c });
      else if (roles.getRole(r, c) === "formula")
        formulas.push({ ...roles.formulaMap.get(`${r}:${c}`)! });
    }
  const patch = { tableWritableCells: writable, tableFormulaCells: formulas };
  const proposed = { ...definition, ...patch };
  return {
    patch,
    issues: validateTableFormulaDefinition(proposed, locale),
    preview: resolveEffectiveTableGrid(proposed, JSON.stringify(samples)),
  };
}

/**
 * Produces a versioned, bounded cross-row total without exposing formula
 * syntax to the user.  Existing roles and formulas outside the target cell
 * are preserved exactly.
 */
export function planColumnTotal(
  definition: TableRoleDefinition,
  selection: ColumnTotalSelection,
  samples: string[][],
  locale: FormulaLocale,
) {
  const columns = Number(definition.tableColumns);
  const rows = Number(definition.maxRows);
  const { sourceColumn, startRow, endRow, targetRow, targetColumn, decimalPlaces } = selection;
  if (
    !Number.isInteger(columns) || columns < 1 || columns > 30 ||
    !Number.isInteger(rows) || rows < 1 || rows > 100 ||
    !Number.isInteger(sourceColumn) || sourceColumn < 0 || sourceColumn >= columns ||
    !Number.isInteger(startRow) || startRow < 0 || startRow >= rows ||
    !Number.isInteger(endRow) || endRow < startRow || endRow >= rows ||
    !Number.isInteger(targetRow) || targetRow < 0 || targetRow >= rows ||
    !Number.isInteger(targetColumn) || targetColumn < 0 || targetColumn >= columns ||
    !Number.isInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > 6
  ) throw new Error("INVALID_TOTAL_TARGET");

  const roles = resolveTableGridRoles(definition, rows, columns, true);
  const writable: Array<{ row: number; column: number }> = [];
  const formulas: TableFormulaCell[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      if (row === targetRow && column === targetColumn) continue;
      if (roles.getRole(row, column) === "writable") writable.push({ row, column });
      if (roles.getRole(row, column) === "formula") {
        formulas.push({ ...roles.formulaMap.get(`${row}:${column}`)! });
      }
    }
  }
  formulas.push({
    row: targetRow,
    column: targetColumn,
    expression: `SUM(${columnIndexToName(sourceColumn)}${startRow + 1}:${columnIndexToName(sourceColumn)}${endRow + 1})`,
    decimalPlaces,
  });
  const patch = {
    tableFormulaSchemaVersion: 2 as const,
    tableWritableCells: writable,
    tableFormulaCells: formulas,
  };
  const proposed = { ...definition, ...patch };
  return {
    patch,
    issues: validateTableFormulaDefinition(proposed, locale),
    preview: resolveEffectiveTableGrid(proposed, JSON.stringify(samples)),
  };
}
