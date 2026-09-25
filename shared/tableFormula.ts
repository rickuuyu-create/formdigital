/**
 * Safe, restricted formula engine and table cell role manager for repeating row fields.
 *
 * Designed according to TBL-01 specifications:
 * - Pure functions, zero eval / new Function / dynamic dependencies.
 * - Restricted tokenizer / parser / AST with strict depth, token, and length bounds.
 * - Same-row column references A to AD (columns 0..29).
 * - Supported: +, -, *, /, ^ (right-associative), sqrt(...), parentheses, optional leading =.
 * - Rejects cross-row (e.g. A1), Excel functions (SUM, IF, etc.), assignment, JS syntax.
 * - Deterministic decimal string formatting with -0 normalization.
 * - Shared across TemplateEditor, InstanceStudio, FormCanvas, pdfRenderer, exportService.
 */

export type TableCellPosition = { row: number; column: number };

export type TableFormulaCell = {
  row: number;
  column: number;
  expression: string;
  decimalPlaces?: number; // 0..6, default 2
};

export type TableCellRole = "writable" | "formula" | "fixed";

export type TableRoleDefinition = {
  maxRows?: unknown;
  tableColumns?: unknown;
  tableWritableCells?: TableCellPosition[] | null;
  tableFormulaCells?: TableFormulaCell[] | null;
  /** Missing/1 keeps the original same-row contract. Version 2 additionally permits bounded SUM(A1:A6). */
  tableFormulaSchemaVersion?: unknown;
  options?: unknown;
  detectionSource?: unknown;
  tableCellGuides?: unknown;
};

export type TableAggregateReference = {
  column: number;
  startRow: number;
  endRow: number;
};

/** Parse the only cross-row construct supported by schema v2. Rows are 1-based in the expression. */
export function parseTableAggregateExpression(expression: string): {
  reference?: TableAggregateReference;
  error?: string;
} {
  if (typeof expression !== "string" || expression.length > MAX_EXPRESSION_LENGTH) {
    return { error: "EXPRESSION_TOO_LONG" };
  }
  const cleaned = expression.trim().replace(/^=/, "").trim();
  const match = /^SUM\(\s*([A-Za-z]{1,2})(\d{1,3})\s*:\s*([A-Za-z]{1,2})(\d{1,3})\s*\)$/i.exec(cleaned);
  if (!match) return { error: "UNSUPPORTED_AGGREGATE_FORMULA" };
  const startColumn = columnNameToIndex(match[1]!);
  const endColumn = columnNameToIndex(match[3]!);
  const startRow = Number(match[2]) - 1;
  const endRow = Number(match[4]) - 1;
  if (startColumn < 0 || endColumn < 0 || startColumn !== endColumn) {
    return { error: "AGGREGATE_RANGE_MUST_USE_ONE_COLUMN" };
  }
  if (!Number.isInteger(startRow) || !Number.isInteger(endRow) || startRow < 0 || endRow < startRow) {
    return { error: "INVALID_AGGREGATE_RANGE" };
  }
  return { reference: { column: startColumn, startRow, endRow } };
}

export type FormulaEvaluationResult = {
  value: number | null;
  formatted: string;
  error?: string;
};

export type TableCellCalculationResult = {
  row: number;
  column: number;
  role: TableCellRole;
  value: string;
  raw: string;
  formula?: TableFormulaCell;
  error?: string;
};

export type TableGridResolution = {
  rowSlots: number;
  columns: number;
  cells: TableCellCalculationResult[][];
  effectiveRows: string[][];
  effectiveJson: string;
  hasErrors: boolean;
  errors: Array<{ row: number; column: number; code: string; message: string }>;
};

const MAX_EXPRESSION_LENGTH = 256;
const MAX_TOKENS = 128;
const MAX_AST_NODES = 128;
const MAX_RECURSION_DEPTH = 16;
const MAX_EXPONENT = 100;
const MAX_COLUMN_INDEX = 29; // AD is column 29 (30 columns total)

/**
 * Convert 0-indexed column number to column name (A..AD).
 * Supports up to 30 columns (A=0, ..., Z=25, AA=26, ..., AD=29).
 */
export function columnIndexToName(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > MAX_COLUMN_INDEX) {
    return "";
  }
  if (index < 26) {
    return String.fromCharCode(65 + index);
  }
  return "A" + String.fromCharCode(65 + (index - 26));
}

/**
 * Convert column name (A..AD, case-insensitive) to 0-indexed column number.
 * Returns -1 if invalid or beyond AD.
 */
export function columnNameToIndex(name: string): number {
  if (typeof name !== "string") return -1;
  const upper = name.trim().toUpperCase();
  if (!/^[A-Z]{1,2}$/.test(upper)) return -1;
  let index: number;
  if (upper.length === 1) {
    index = upper.charCodeAt(0) - 65;
  } else {
    index = (upper.charCodeAt(0) - 64) * 26 + (upper.charCodeAt(1) - 65);
  }
  return index >= 0 && index <= MAX_COLUMN_INDEX ? index : -1;
}

/**
 * Normalizes an array of cell positions:
 * - validates row and column are integers >= 0
 * - filters out-of-bounds cells if maxRows / tableColumns are provided
 * - deduplicates coordinates
 * - sorts row-major (row ascending, column ascending)
 */
export function normalizeTableCellPositions(
  cells: unknown,
  maxRows?: number,
  tableColumns?: number
): TableCellPosition[] {
  if (!Array.isArray(cells)) return [];
  const seen = new Set<string>();
  const result: TableCellPosition[] = [];
  for (const item of cells) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = Number((item as Record<string, unknown>).row);
    const column = Number((item as Record<string, unknown>).column);
    if (!Number.isInteger(row) || !Number.isInteger(column)) continue;
    if (row < 0 || column < 0) continue;
    if (maxRows !== undefined && row >= maxRows) continue;
    if (tableColumns !== undefined && column >= tableColumns) continue;
    const key = `${row}:${column}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ row, column });
  }
  result.sort((a, b) => a.row - b.row || a.column - b.column);
  return result;
}

/**
 * Normalizes an array of formula cells:
 * - validates row, column, expression
 * - validates decimalPlaces (0..6) if present
 * - deduplicates coordinates (first valid entry wins)
 * - sorts row-major
 */
export function normalizeTableFormulaCells(
  cells: unknown,
  maxRows?: number,
  tableColumns?: number,
  allowEmpty = false
): TableFormulaCell[] {
  if (!Array.isArray(cells)) return [];
  const seen = new Set<string>();
  const result: TableFormulaCell[] = [];
  for (const item of cells) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const cell = item as Record<string, unknown>;
    const row = Number(cell.row);
    const column = Number(cell.column);
    if (!Number.isInteger(row) || !Number.isInteger(column)) continue;
    if (row < 0 || column < 0) continue;
    if (maxRows !== undefined && row >= maxRows) continue;
    if (tableColumns !== undefined && column >= tableColumns) continue;
    if (typeof cell.expression !== "string") continue;
    const expression = cell.expression.trim();
    if (!allowEmpty && !expression) continue;
    let decimalPlaces: number | undefined = undefined;
    if (cell.decimalPlaces !== undefined && cell.decimalPlaces !== null) {
      const dp = Number(cell.decimalPlaces);
      if (!Number.isInteger(dp) || dp < 0 || dp > 6) {
        continue;
      }
      decimalPlaces = dp;
    }
    const key = `${row}:${column}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      row,
      column,
      expression,
      ...(decimalPlaces !== undefined ? { decimalPlaces } : {}),
    });
  }
  result.sort((a, b) => a.row - b.row || a.column - b.column);
  return result;
}

/**
 * Resolves cell roles across the grid according to TBL-01 rules:
 * 1. tableWritableCells === undefined / null: legacy mode, all cells writable (except formula cells)
 * 2. tableWritableCells === []: explicit empty, NO cells are writable (all fixed unless formula)
 * 3. tableFormulaCells: formula cells take precedence over writable mask
 * 4. explicit writable mask: cells in mask are writable, rest are fixed
 */
export function resolveTableGridRoles(
  definition: TableRoleDefinition,
  rowSlots: number,
  columns: number,
  allowDraftFormulas = false
) {
  const normalizedFormulas = normalizeTableFormulaCells(
    definition.tableFormulaCells,
    rowSlots,
    columns,
    allowDraftFormulas
  );
  const formulaMap = new Map<string, TableFormulaCell>();
  for (const f of normalizedFormulas) {
    formulaMap.set(`${f.row}:${f.column}`, f);
  }

  let writableSet: Set<string> | null = null;
  if (Array.isArray(definition.tableWritableCells)) {
    const normalizedWritable = normalizeTableCellPositions(
      definition.tableWritableCells,
      rowSlots,
      columns
    );
    writableSet = new Set(
      normalizedWritable.map(cell => `${cell.row}:${cell.column}`)
    );
  }

  const getRole = (row: number, column: number): TableCellRole => {
    const key = `${row}:${column}`;
    if (formulaMap.has(key)) return "formula";
    if (writableSet === null) return "writable"; // legacy mode
    if (writableSet.has(key)) return "writable";
    return "fixed";
  };

  return {
    getRole,
    formulaMap,
    writableSet,
    isWritable: (row: number, column: number) => getRole(row, column) === "writable",
    isFormula: (row: number, column: number) => getRole(row, column) === "formula",
    isFixed: (row: number, column: number) => getRole(row, column) === "fixed",
  };
}

// ---------------------------------------------------------------------------
// Formula Tokenizer & Parser
// ---------------------------------------------------------------------------

type TokenType =
  | "NUMBER"
  | "COLUMN"
  | "SQRT"
  | "PLUS"
  | "MINUS"
  | "STAR"
  | "SLASH"
  | "CARET"
  | "LPAREN"
  | "RPAREN";

type Token = {
  type: TokenType;
  value: string;
  columnIndex?: number;
};

type ASTNode =
  | { type: "number"; value: number }
  | { type: "column"; name: string; column: number }
  | { type: "unary"; op: "+" | "-"; operand: ASTNode }
  | { type: "binary"; op: "+" | "-" | "*" | "/" | "^"; left: ASTNode; right: ASTNode }
  | { type: "sqrt"; operand: ASTNode };

function tokenizeFormula(expression: string): { tokens?: Token[]; error?: string } {
  let cleaned = expression.trim();
  if (cleaned.length > MAX_EXPRESSION_LENGTH) {
    return { error: "EXPRESSION_TOO_LONG" };
  }
  if (cleaned.startsWith("=")) {
    cleaned = cleaned.slice(1).trim();
  }
  if (!cleaned) {
    return { error: "EMPTY_EXPRESSION" };
  }

  const tokens: Token[] = [];
  let i = 0;

  while (i < cleaned.length) {
    const ch = cleaned[i]!;

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    if (tokens.length >= MAX_TOKENS) {
      return { error: "EXPRESSION_TOO_COMPLEX" };
    }

    if (ch === "+") {
      tokens.push({ type: "PLUS", value: "+" });
      i += 1;
      continue;
    }
    if (ch === "-") {
      tokens.push({ type: "MINUS", value: "-" });
      i += 1;
      continue;
    }
    if (ch === "*") {
      tokens.push({ type: "STAR", value: "*" });
      i += 1;
      continue;
    }
    if (ch === "/") {
      tokens.push({ type: "SLASH", value: "/" });
      i += 1;
      continue;
    }
    if (ch === "^") {
      tokens.push({ type: "CARET", value: "^" });
      i += 1;
      continue;
    }
    if (ch === "(") {
      tokens.push({ type: "LPAREN", value: "(" });
      i += 1;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "RPAREN", value: ")" });
      i += 1;
      continue;
    }

    // Number (including decimal and properly grouped thousand commas)
    if (/\d/.test(ch) || (ch === "." && /\d/.test(cleaned[i + 1] ?? ""))) {
      const rest = cleaned.slice(i);
      const numberMatch = rest.match(/^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+/);
      if (!numberMatch) {
        return { error: "INVALID_NUMBER_SYNTAX" };
      }
      const rawNum = numberMatch[0]!;
      // Validate comma grouping: if commas present, must match ^\d{1,3}(,\d{3})+(\.\d+)?$
      if (rawNum.includes(",")) {
        if (!/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(rawNum)) {
          return { error: "INVALID_THOUSAND_SEPARATOR" };
        }
      }
      const cleanedNum = rawNum.replace(/,/g, "");
      const parsed = Number(cleanedNum);
      if (!Number.isFinite(parsed)) {
        return { error: "INVALID_NUMBER_VALUE" };
      }
      tokens.push({ type: "NUMBER", value: rawNum });
      i += rawNum.length;
      continue;
    }

    // Identifiers: sqrt, column references A..AD, or reject unsupported
    if (/[a-zA-Z]/.test(ch)) {
      const rest = cleaned.slice(i);
      const identMatch = rest.match(/^[a-zA-Z0-9_]+/);
      if (!identMatch) {
        return { error: "SYNTAX_ERROR" };
      }
      const rawIdent = identMatch[0]!;
      const upper = rawIdent.toUpperCase();

      // Check for cross-row reference: letter followed by digits (e.g. A1, B2)
      if (/^[a-zA-Z]+\d+$/.test(rawIdent)) {
        return { error: "CROSS_ROW_NOT_ALLOWED" };
      }

      if (upper === "SQRT") {
        tokens.push({ type: "SQRT", value: "sqrt" });
        i += rawIdent.length;
        continue;
      }

      const colIndex = columnNameToIndex(upper);
      if (colIndex >= 0) {
        tokens.push({ type: "COLUMN", value: upper, columnIndex: colIndex });
        i += rawIdent.length;
        continue;
      }

      // Any other identifier (SUM, IF, etc.)
      return { error: `UNSUPPORTED_FUNCTION: ${rawIdent}` };
    }

    // Any unrecognized character ($, &, =, etc.)
    return { error: `UNEXPECTED_CHARACTER: ${ch}` };
  }

  return { tokens };
}

class Parser {
  private tokens: Token[];
  private pos = 0;
  private nodeCount = 0;
  private depth = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++]!;
  }

  private checkNodeCount(): void {
    this.nodeCount += 1;
    if (this.nodeCount > MAX_AST_NODES) {
      throw new Error("EXPRESSION_TOO_COMPLEX");
    }
  }

  private enterDepth(): void {
    this.depth += 1;
    if (this.depth > MAX_RECURSION_DEPTH) {
      throw new Error("EXPRESSION_TOO_DEEP");
    }
  }

  private leaveDepth(): void {
    this.depth -= 1;
  }

  parse(): ASTNode {
    const node = this.parseExpression();
    if (this.pos < this.tokens.length) {
      throw new Error("UNEXPECTED_TOKEN");
    }
    return node;
  }

  private parseExpression(): ASTNode {
    return this.parseAdditive();
  }

  private parseAdditive(): ASTNode {
    this.enterDepth();
    try {
      let left = this.parseMultiplicative();
      while (this.peek()?.type === "PLUS" || this.peek()?.type === "MINUS") {
        const op = this.next().type === "PLUS" ? "+" : "-";
        const right = this.parseMultiplicative();
        this.checkNodeCount();
        left = { type: "binary", op, left, right };
      }
      return left;
    } finally {
      this.leaveDepth();
    }
  }

  private parseMultiplicative(): ASTNode {
    this.enterDepth();
    try {
      let left = this.parsePower();
      while (this.peek()?.type === "STAR" || this.peek()?.type === "SLASH") {
        const op = this.next().type === "STAR" ? "*" : "/";
        const right = this.parsePower();
        this.checkNodeCount();
        left = { type: "binary", op, left, right };
      }
      return left;
    } finally {
      this.leaveDepth();
    }
  }

  // Right-associative exponentiation: 2^3^2 = 2^(3^2)
  private parsePower(): ASTNode {
    this.enterDepth();
    try {
      const left = this.parseUnary();
      if (this.peek()?.type === "CARET") {
        this.next(); // consume ^
        const right = this.parsePower(); // recurse for right-associativity
        this.checkNodeCount();
        return { type: "binary", op: "^", left, right };
      }
      return left;
    } finally {
      this.leaveDepth();
    }
  }

  private parseUnary(): ASTNode {
    this.enterDepth();
    try {
      if (this.peek()?.type === "PLUS" || this.peek()?.type === "MINUS") {
        const op = this.next().type === "PLUS" ? "+" : "-";
        const operand = this.parseUnary();
        this.checkNodeCount();
        return { type: "unary", op, operand };
      }
      return this.parsePrimary();
    } finally {
      this.leaveDepth();
    }
  }

  private parsePrimary(): ASTNode {
    const token = this.peek();
    if (!token) {
      throw new Error("UNEXPECTED_END_OF_EXPRESSION");
    }

    if (token.type === "NUMBER") {
      this.next();
      this.checkNodeCount();
      const num = Number(token.value.replace(/,/g, ""));
      return { type: "number", value: num };
    }

    if (token.type === "COLUMN") {
      this.next();
      this.checkNodeCount();
      return {
        type: "column",
        name: token.value,
        column: token.columnIndex ?? columnNameToIndex(token.value),
      };
    }

    if (token.type === "SQRT") {
      this.next();
      if (this.peek()?.type !== "LPAREN") {
        throw new Error("EXPECTED_LPAREN_AFTER_SQRT");
      }
      this.next(); // consume (
      const operand = this.parseExpression();
      if (this.peek()?.type !== "RPAREN") {
        throw new Error("EXPECTED_RPAREN");
      }
      this.next(); // consume )
      this.checkNodeCount();
      return { type: "sqrt", operand };
    }

    if (token.type === "LPAREN") {
      this.next(); // consume (
      const expr = this.parseExpression();
      if (this.peek()?.type !== "RPAREN") {
        throw new Error("EXPECTED_RPAREN");
      }
      this.next(); // consume )
      return expr;
    }

    throw new Error(`UNEXPECTED_TOKEN: ${token.value}`);
  }
}

/**
 * Parses a formula expression into an AST.
 */
export function parseFormula(expression: string): { ast?: ASTNode; error?: string } {
  const tokenized = tokenizeFormula(expression);
  if (tokenized.error || !tokenized.tokens) {
    return { error: tokenized.error ?? "TOKENIZE_FAILED" };
  }
  try {
    const parser = new Parser(tokenized.tokens);
    const ast = parser.parse();
    return { ast };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "PARSE_ERROR" };
  }
}

/**
 * Extracts referenced column names from an expression.
 */
export function getFormulaReferencedColumns(
  expression: string
): { columns: string[]; error?: string } {
  const tokenized = tokenizeFormula(expression);
  if (tokenized.error || !tokenized.tokens) {
    return { columns: [], error: tokenized.error };
  }
  const set = new Set<string>();
  for (const t of tokenized.tokens) {
    if (t.type === "COLUMN") {
      set.add(t.value);
    }
  }
  return { columns: Array.from(set).sort() };
}

function evaluateAST(
  node: ASTNode,
  getColumnValue: (colName: string, colIndex: number) => number
): number {
  switch (node.type) {
    case "number":
      return node.value;
    case "column":
      return getColumnValue(node.name, node.column);
    case "unary": {
      const val = evaluateAST(node.operand, getColumnValue);
      return node.op === "+" ? val : -val;
    }
    case "binary": {
      const left = evaluateAST(node.left, getColumnValue);
      const right = evaluateAST(node.right, getColumnValue);
      switch (node.op) {
        case "+":
          return left + right;
        case "-":
          return left - right;
        case "*":
          return left * right;
        case "/":
          if (right === 0) throw new Error("DIVISION_BY_ZERO");
          return left / right;
        case "^":
          if (Math.abs(right) > MAX_EXPONENT) throw new Error("EXPONENT_TOO_LARGE");
          const res = Math.pow(left, right);
          if (!Number.isFinite(res)) throw new Error("OVERFLOW");
          return res;
      }
      break;
    }
    case "sqrt": {
      const operand = evaluateAST(node.operand, getColumnValue);
      if (operand < 0) throw new Error("NEGATIVE_SQRT");
      return Math.sqrt(operand);
    }
  }
}

function toPlainDecimalString(num: number): string {
  const str = String(num);
  const eIdx = str.search(/[eE]/);
  if (eIdx === -1) return str;
  const mantissa = str.slice(0, eIdx);
  const exp = parseInt(str.slice(eIdx + 1), 10);
  const [intPart = "0", decPart = ""] = mantissa.split(".");
  if (exp > 0) {
    if (decPart.length <= exp) {
      return intPart + decPart + "0".repeat(exp - decPart.length);
    }
    return intPart + decPart.slice(0, exp) + "." + decPart.slice(exp);
  }
  const absExp = -exp;
  if (intPart.length <= absExp) {
    return "0." + "0".repeat(absExp - intPart.length) + intPart + decPart;
  }
  return (
    intPart.slice(0, intPart.length - absExp) +
    "." +
    intPart.slice(intPart.length - absExp) +
    decPart
  );
}

/**
 * Formats a numeric result to a deterministic decimal string:
 * - rounds to decimalPlaces (0..6, default 2) using deterministic half-away-from-zero decimal rounding
 * - eliminates -0 (outputs "0.00" or "0")
 * - guarantees output matches /^-?\d+(?:\.\d+)?$/ without scientific notation corruption
 */
export function formatFormulaNumber(num: number, decimalPlaces = 2): string {
  const dp = Math.min(6, Math.max(0, Math.floor(decimalPlaces)));
  if (!Number.isFinite(num)) return "";
  const sign = num < 0 || Object.is(num, -0) ? "-" : "";
  const abs = Math.abs(num);
  const plain = toPlainDecimalString(abs);
  const dotIdx = plain.indexOf(".");
  let intPart = dotIdx === -1 ? plain : plain.slice(0, dotIdx);
  let decPart = dotIdx === -1 ? "" : plain.slice(dotIdx + 1);

  if (dp === 0) {
    if (decPart.length > 0 && decPart.charCodeAt(0) >= 53 /* '5' */) {
      intPart = (BigInt(intPart) + BigInt(1)).toString();
    }
    if (intPart === "0") return "0";
    return sign === "-" && intPart !== "0" ? "-" + intPart : intPart;
  }

  if (decPart.length <= dp) {
    const paddedDec = decPart.padEnd(dp, "0");
    if (intPart === "0" && /^0+$/.test(paddedDec)) return "0." + "0".repeat(dp);
    return sign + intPart + "." + paddedDec;
  }

  const roundDigit = decPart.charCodeAt(dp);
  let keptDec = decPart.slice(0, dp);
  if (roundDigit >= 53 /* '5' */) {
    const combined = BigInt(intPart + keptDec) + BigInt(1);
    const combinedStr = combined.toString().padStart(dp + 1, "0");
    intPart = combinedStr.slice(0, combinedStr.length - dp);
    keptDec = combinedStr.slice(combinedStr.length - dp);
  }

  if (intPart === "0" && /^0+$/.test(keptDec)) {
    return "0." + "0".repeat(dp);
  }
  return sign + intPart + "." + keptDec;
}

/**
 * Evaluates a single formula expression with a provided column lookup callback.
 */
export function evaluateFormulaExpression(
  expression: string,
  getColumnValue: (colName: string, colIndex: number) => number,
  options: { decimalPlaces?: number } = {}
): FormulaEvaluationResult {
  const parsed = parseFormula(expression);
  if (parsed.error || !parsed.ast) {
    return { value: null, formatted: "", error: parsed.error };
  }
  try {
    const rawVal = evaluateAST(parsed.ast, getColumnValue);
    if (!Number.isFinite(rawVal) || Math.abs(rawVal) > Number.MAX_SAFE_INTEGER) {
      return { value: null, formatted: "", error: "OVERFLOW" };
    }
    const dp = options.decimalPlaces ?? 2;
    const formatted = formatFormulaNumber(rawVal, dp);
    if (!formatted || !/^-?\d+(?:\.\d+)?$/.test(formatted)) {
      return { value: null, formatted: "", error: "CALCULATION_ERROR" };
    }
    return { value: rawVal, formatted };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "CALCULATION_ERROR";
    return { value: null, formatted: "", error: msg };
  }
}

/**
 * Validates a table formula definition directly against raw definition entries:
 * - Checks for empty expression
 * - Checks that decimalPlaces is integer between 0 and 6
 * - Checks that coordinates are within tableColumns and maxRows
 * - Checks for duplicate coordinates
 * - Checks syntax, unknown column references, self-reference, and circular dependencies
 */
/**
 * The product UI locale is `zh-Hant` / `zh-Hans` / `en` (see
 * `client/src/lib/i18n.tsx`). Older code in this module still used the
 * internal `zh-TW` / `zh-CN` spelling. This adapter is the single, explicit
 * and unambiguous mapping between the two so no call site has to guess.
 */
export type FormulaLocale = "zh-Hant" | "zh-Hans" | "en";

export function normalizeFormulaLocale(value: unknown): FormulaLocale {
  if (value === "zh-Hans" || value === "zh-CN") return "zh-Hans";
  if (value === "en") return "en";
  return "zh-Hant";
}

/**
 * Single trilingual catalog for every stable validation issue.
 *
 * Only safe, bounded values may be interpolated: row numbers, column letters
 * and fixed numeric bounds. Messages must never echo the full expression,
 * raw table JSON, an unknown function name, a token suffix, a path or a stack.
 *
 * Keys may carry a `::<variant>` suffix when one stable issue code covers
 * several concrete situations; the wire/issue `code` stays the base code.
 */
export const FORMULA_ISSUE_CATALOG = {
  table_columns_bounds: {
    "zh-Hant": "表格欄數必須介於 1 至 30 之間",
    "zh-Hans": "表格列数必须介于 1 至 30 之间",
    en: "Table column count must be between 1 and 30",
  },
  table_rows_bounds: {
    "zh-Hant": "表格最大列數必須介於 1 至 100 之間",
    "zh-Hans": "表格最大行数必须介于 1 至 100 之间",
    en: "Table maximum row count must be between 1 and 100",
  },
  "table_formula_malformed": {
    "zh-Hant": "表格公式設定格式錯誤",
    "zh-Hans": "表格公式设置格式错误",
    en: "Table formula settings are malformed",
  },
  "table_formula_malformed_array": {
    "zh-Hant": "表格公式設定必須為陣列",
    "zh-Hans": "表格公式设置必须为数组",
    en: "Table formula settings must be an array",
  },
  "table_formula_malformed_missing": {
    "zh-Hant": "第 {index} 個公式設定缺少必要屬性（row, column, expression）",
    "zh-Hans": "第 {index} 个公式设置缺少必要属性（row, column, expression）",
    en: "Formula setting {index} is missing required properties (row, column, expression)",
  },
  table_formula_bounds: {
    "zh-Hant": "第 {row} 列 {column} 欄超出表格行列範圍",
    "zh-Hans": "第 {row} 行 {column} 列超出表格行列范围",
    en: "Row {row} column {column} is outside the table grid",
  },
  table_formula_duplicate: {
    "zh-Hant": "第 {row} 列 {column} 欄公式重複定義",
    "zh-Hans": "第 {row} 行 {column} 列公式重复定义",
    en: "Row {row} column {column} has a duplicate formula definition",
  },
  table_formula_empty: {
    "zh-Hant": "第 {row} 列 {column} 欄公式不可為空",
    "zh-Hans": "第 {row} 行 {column} 列公式不可为空",
    en: "Row {row} column {column} formula cannot be empty",
  },
  table_formula_decimal_places: {
    "zh-Hant": "第 {row} 列 {column} 欄小數位數必須介於 0 至 6",
    "zh-Hans": "第 {row} 行 {column} 列小数位数必须介于 0 至 6",
    en: "Row {row} column {column} decimal places must be between 0 and 6",
  },
  table_formula_schema_version: {
    "zh-Hant": "跨列總額格式版本無效",
    "zh-Hans": "跨行总额格式版本无效",
    en: "The cross-row total formula version is invalid",
  },
  table_formula_aggregate_range: {
    "zh-Hant": "第 {row} 列 {column} 欄的總額範圍無效",
    "zh-Hans": "第 {row} 行 {column} 列的总额范围无效",
    en: "Row {row} column {column} has an invalid total range",
  },
  table_formula_aggregate_self_reference: {
    "zh-Hant": "第 {row} 列 {column} 欄的總額不可包含自己",
    "zh-Hans": "第 {row} 行 {column} 列的总额不可包含自己",
    en: "Row {row} column {column} total cannot include itself",
  },
  table_formula_aggregate_dependency: {
    "zh-Hant": "第 {row} 列 {column} 欄公式不可引用總額格；請直接加總明細列",
    "zh-Hans": "第 {row} 行 {column} 列公式不可引用总额单元格；请直接汇总明细行",
    en: "Row {row} column {column} cannot depend on a total cell; sum the detail rows instead",
  },
  table_formula_syntax: {
    "zh-Hant": "第 {row} 列 {column} 欄公式語法錯誤：{detail}",
    "zh-Hans": "第 {row} 行 {column} 列公式语法错误：{detail}",
    en: "Row {row} column {column} formula syntax error: {detail}",
  },
  table_formula_unknown_column: {
    "zh-Hant": "第 {row} 列 {column} 欄公式引用了不存在的欄位 {reference}",
    "zh-Hans": "第 {row} 行 {column} 列公式引用了不存在的列 {reference}",
    en: "Row {row} column {column} formula references column {reference}, which does not exist",
  },
  table_formula_self_reference: {
    "zh-Hant": "第 {row} 列 {column} 欄公式不可引用自身",
    "zh-Hans": "第 {row} 行 {column} 列公式不可引用自身",
    en: "Row {row} column {column} formula cannot reference itself",
  },
  table_formula_circular_reference: {
    "zh-Hant": "第 {row} 列公式存在循環引用（涉及 {column} 欄）",
    "zh-Hans": "第 {row} 行公式存在循环引用（涉及 {column} 列）",
    en: "Row {row} formulas contain a circular reference (involving column {column})",
  },
  table_invalid_json: {
    "zh-Hant": "表格資料格式無效（JSON 解析失敗）",
    "zh-Hans": "表格数据格式无效（JSON 解析失败）",
    en: "Table data is invalid (the JSON could not be parsed)",
  },
  table_not_array: {
    "zh-Hant": "表格資料格式無效（必須為陣列）",
    "zh-Hans": "表格数据格式无效（必须为数组）",
    en: "Table data is invalid (an array is required)",
  },
  table_malformed_row: {
    "zh-Hant": "表格列格式無效（每一列必須為陣列）",
    "zh-Hans": "表格行格式无效（每一行必须为数组）",
    en: "Table row is invalid (every row must be an array)",
  },
  table_malformed_cell: {
    "zh-Hant": "表格儲存格格式無效（儲存格不可為物件或陣列）",
    "zh-Hans": "表格单元格格式无效（单元格不可为对象或数组）",
    en: "Table cell is invalid (a cell cannot be an object or an array)",
  },
  table_structure_invalid: {
    "zh-Hant": "表格資料結構無效",
    "zh-Hans": "表格数据结构无效",
    en: "Table data structure is invalid",
  },

  // ----- General field validation issues (status / printed blocking) -----
  // Only safe, bounded values are interpolated: {max}/{min} are fixed numeric
  // bounds and {detail} is a safe, already-localized parser/runtime message.
  // User-controlled labels are intentionally NOT echoed to the client.
  required: {
    "zh-Hant": "此欄位為必填",
    "zh-Hans": "此字段为必填",
    en: "This field is required",
  },
  max_length: {
    "zh-Hant": "不可超過 {max} 字",
    "zh-Hans": "不可超过 {max} 字",
    en: "Must not exceed {max} characters",
  },
  number: {
    "zh-Hant": "必須是有效數字",
    "zh-Hans": "必须是有效数字",
    en: "Must be a valid number",
  },
  min: {
    "zh-Hant": "不可小於 {min}",
    "zh-Hans": "不可小于 {min}",
    en: "Must be at least {min}",
  },
  max: {
    "zh-Hant": "不可大於 {max}",
    "zh-Hans": "不可大于 {max}",
    en: "Must be at most {max}",
  },
  date: {
    "zh-Hant": "不是有效日期",
    "zh-Hans": "不是有效日期",
    en: "Must be a valid date",
  },
  time: {
    "zh-Hant": "必須使用 24 小時 HH:mm 格式",
    "zh-Hans": "必须使用 24 小时 HH:mm 格式",
    en: "Must use 24-hour HH:mm format",
  },
  email: {
    "zh-Hant": "不是有效 Email",
    "zh-Hans": "不是有效 Email",
    en: "Must be a valid email address",
  },
  phone: {
    "zh-Hant": "不是有效電話號碼",
    "zh-Hans": "不是有效电话号码",
    en: "Must be a valid phone number",
  },
  regex: {
    "zh-Hant": "格式不符合規則",
    "zh-Hans": "格式不符合规则",
    en: "Does not match the required format",
  },
  regex_config: {
    "zh-Hant": "的 Regex 設定無效",
    "zh-Hans": "的 Regex 设置无效",
    en: "has an invalid regex configuration",
  },
  option: {
    "zh-Hant": "的值不屬於可選項目",
    "zh-Hans": "的值不属于可选项目",
    en: "is not one of the allowed options",
  },
  checkbox: {
    "zh-Hant": "含有不屬於選項的值",
    "zh-Hans": "含有不属于选项的值",
    en: "contains a value that is not an allowed option",
  },
  asset: {
    "zh-Hant": "必須使用已保存的本機圖片或文字簽名",
    "zh-Hans": "必须使用已保存的本地图片或文字签名",
    en: "Must use a saved local image or text signature",
  },
  table_rows: {
    "zh-Hant": "最多只可有 {max} 列",
    "zh-Hans": "最多只可有 {max} 行",
    en: "May have at most {max} rows",
  },
  table_formula: {
    "zh-Hant": "公式無法計算：{detail}",
    "zh-Hans": "公式无法计算：{detail}",
    en: "Formula could not be calculated: {detail}",
  },

  // ----- Workspace v2 transport ambiguity / busy -----
  v2_transport_unconfirmed: {
    "zh-Hant": "本機資料服務連線中斷，交易結果無法確認；請稍後再試。",
    "zh-Hans": "本地数据服务连接中断，交易结果无法确认；请稍后再试。",
    en: "The local data service connection was interrupted and the transaction result could not be confirmed. Please try again later.",
  },
  v2_busy: {
    "zh-Hant": "工作區資料忙碌中，請稍後再試。",
    "zh-Hans": "工作区数据忙碌中，请稍后再试。",
    en: "The workspace data is busy. Please try again later.",
  },
} as const;

export type FormulaIssueTemplateCode = keyof typeof FORMULA_ISSUE_CATALOG;

/** Template codes of the catalog, including `::<variant>` keys. */
export const FORMULA_ISSUE_CODES = Object.keys(FORMULA_ISSUE_CATALOG) as FormulaIssueTemplateCode[];

const FORMULA_GENERIC_MESSAGE: Record<FormulaLocale, string> = {
  "zh-Hant": "公式無法處理",
  "zh-Hans": "公式无法处理",
  en: "Formula could not be processed",
};

/**
 * Generic, value-free message for an *unknown wire validation code*. An unknown
 * code is not necessarily a formula problem, so it must not be mislabeled as a
 * "formula could not be processed" error. Used only by `localizeServerIssueMarkers`
 * for codes that are absent from `FORMULA_ISSUE_CATALOG`; the formula parser/
 * evaluator path (`formatFormulaErrorMessage`) keeps its own formula-specific generic.
 */
const VALIDATION_GENERIC_MESSAGE: Record<FormulaLocale, string> = {
  "zh-Hant": "資料驗證失敗",
  "zh-Hans": "数据验证失败",
  en: "Data validation failed",
};

/**
 * Renders a stable issue code in the requested locale. Unknown codes always
 * degrade to a generic, value-free message so no internal code or suffix
 * can ever reach the user.
 */
export function formatFormulaIssueMessage(
  code: string,
  locale: FormulaLocale | "zh-TW" | "zh-CN" | undefined,
  params: Record<string, string | number> = {}
): string {
  const target = normalizeFormulaLocale(locale);
  const effectiveParams: Record<string, string | number> = { ...params };
  // `table_formula` carries a stable runtime error code (e.g. DIVISION_BY_ZERO).
  // Derive the localized detail per locale so the message stays trilingual even
  // though the server has no UI locale of its own.
  if (String(code ?? "") === "table_formula" && params.code != null && params.code !== "") {
    effectiveParams.detail = formatFormulaErrorMessage(String(params.code), target);
  }
  const template = (FORMULA_ISSUE_CATALOG as Record<string, Record<FormulaLocale, string>>)[String(code ?? "")];
  if (!template) return FORMULA_GENERIC_MESSAGE[target];
  const text = template[target] ?? template["zh-Hant"] ?? FORMULA_GENERIC_MESSAGE[target];
  return text.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(effectiveParams, key) ? String(effectiveParams[key]) : match
  );
}

export function validateTableFormulaDefinition(
  definition: TableRoleDefinition,
  lang: FormulaLocale | "zh-TW" | "zh-CN" = "zh-Hant"
): Array<{ code: string; message: string; params: Record<string, string | number> }> {
  const locale = normalizeFormulaLocale(lang);
  const issue = (code: string, params: Record<string, string | number> = {}) =>
    ({ code, params, message: formatFormulaIssueMessage(code, locale, params) });
  const issues: Array<{ code: string; message: string; params: Record<string, string | number> }> = [];
  const formulaSchemaVersion = definition.tableFormulaSchemaVersion == null
    ? 1
    : Number(definition.tableFormulaSchemaVersion);
  if (formulaSchemaVersion !== 1 && formulaSchemaVersion !== 2) {
    issues.push(issue("table_formula_schema_version", {}));
  }

  if (definition.tableColumns !== undefined && definition.tableColumns !== null) {
    const cols = Number(definition.tableColumns);
    if (!Number.isInteger(cols) || cols < 1 || cols > 30) {
      issues.push(issue("table_columns_bounds", {}));
    }
  }

  if (definition.maxRows !== undefined && definition.maxRows !== null) {
    const rows = Number(definition.maxRows);
    if (!Number.isInteger(rows) || rows < 1 || rows > 100) {
      issues.push(issue("table_rows_bounds", {}));
    }
  }

  if (definition.tableFormulaCells !== undefined && definition.tableFormulaCells !== null) {
    if (!Array.isArray(definition.tableFormulaCells)) {
      issues.push(issue("table_formula_malformed_array", {}));
    }
  }

  const formalColumns = Number(definition.tableColumns);
  const maxColumns = Number.isInteger(formalColumns) && formalColumns > 0 ? formalColumns : 3;
  const formalMaxRows = Number(definition.maxRows);
  const maxRows = Number.isInteger(formalMaxRows) && formalMaxRows > 0 ? formalMaxRows : 100;

  const rawFormulas = Array.isArray(definition.tableFormulaCells)
    ? definition.tableFormulaCells
    : [];

  const seenCoords = new Set<string>();
  const validFormulaCells: TableFormulaCell[] = [];
  const aggregateCells = new Map<string, TableAggregateReference>();
  const aggregateCandidates = new Set<string>();

  for (let idx = 0; idx < rawFormulas.length; idx++) {
    const item = rawFormulas[idx];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      issues.push(issue("table_formula_malformed", { index: idx + 1 }));
      continue;
    }
    const f = item as Record<string, unknown>;
    if (!("row" in f) || !("column" in f) || !("expression" in f)) {
      issues.push(issue("table_formula_malformed_missing", { index: idx + 1 }));
      continue;
    }
    const row = Number(f.row);
    const column = Number(f.column);
    const colName = columnIndexToName(column) || `[${column}]`;

    // Bounds and integer check
    if (
      !Number.isInteger(row) ||
      !Number.isInteger(column) ||
      row < 0 ||
      column < 0 ||
      row >= maxRows ||
      column >= maxColumns ||
      column >= 30
    ) {
      issues.push(issue("table_formula_bounds", { row: row + 1, column: colName }));
      continue;
    }

    const coordKey = `${row}:${column}`;
    if (seenCoords.has(coordKey)) {
      issues.push(issue("table_formula_duplicate", { row: row + 1, column: colName }));
      continue;
    }
    seenCoords.add(coordKey);

    // Empty expression check
    const rawExpr = typeof f.expression === "string" ? f.expression.trim() : "";
    if (!rawExpr) {
      issues.push(issue("table_formula_empty", { row: row + 1, column: colName }));
      continue;
    }

    // Decimal places check
    let decimalPlaces: number | undefined = undefined;
    if (f.decimalPlaces !== undefined && f.decimalPlaces !== null) {
      const dp = Number(f.decimalPlaces);
      if (!Number.isInteger(dp) || dp < 0 || dp > 6) {
        issues.push(issue("table_formula_decimal_places", { row: row + 1, column: colName }));
        continue;
      }
      decimalPlaces = dp;
    }

    validFormulaCells.push({
      row,
      column,
      expression: rawExpr,
      ...(decimalPlaces !== undefined ? { decimalPlaces } : {}),
    });

    if (/^=?\s*SUM\s*\(/i.test(rawExpr)) {
      aggregateCandidates.add(coordKey);
      if (formulaSchemaVersion !== 2) {
        issues.push(issue("table_formula_syntax", {
          row: row + 1,
          column: colName,
          detail: formatFormulaErrorMessage("UNSUPPORTED_FUNCTION: SUM", locale),
        }));
        continue;
      }
      const aggregate = parseTableAggregateExpression(rawExpr);
      const ref = aggregate.reference;
      if (!ref || ref.column >= maxColumns || ref.endRow >= maxRows) {
        issues.push(issue("table_formula_aggregate_range", { row: row + 1, column: colName }));
        continue;
      }
      if (ref.column === column && row >= ref.startRow && row <= ref.endRow) {
        issues.push(issue("table_formula_aggregate_self_reference", { row: row + 1, column: colName }));
        continue;
      }
      aggregateCells.set(coordKey, ref);
    }
  }

  for (const [coord, ref] of Array.from(aggregateCells.entries())) {
    const [targetRow, targetColumn] = coord.split(":").map(Number);
    for (const otherCoord of Array.from(aggregateCells.keys())) {
      if (otherCoord === coord) continue;
      const [otherRow, otherColumn] = otherCoord.split(":").map(Number);
      if (otherColumn === ref.column && otherRow >= ref.startRow && otherRow <= ref.endRow) {
        issues.push(issue("table_formula_aggregate_dependency", {
          row: targetRow! + 1,
          column: columnIndexToName(targetColumn!),
        }));
        break;
      }
    }
  }

  // Group valid formulas by row
  const rowFormulas = new Map<number, TableFormulaCell[]>();
  for (const f of validFormulaCells) {
    const list = rowFormulas.get(f.row) ?? [];
    list.push(f);
    rowFormulas.set(f.row, list);
  }

  Array.from(rowFormulas.entries()).forEach(([row, fCells]) => {
    const formulaColSet = new Set(fCells.map((f: TableFormulaCell) => f.column));
    const dependencyMap = new Map<number, Set<number>>();

    for (const f of fCells) {
      const colName = columnIndexToName(f.column);
      // SUM-looking expressions are handled exclusively by the versioned
      // aggregate validator.  Invalid aggregates must not fall through to the
      // legacy same-row parser and create a second, misleading error.
      if (aggregateCandidates.has(`${f.row}:${f.column}`)) continue;
      const parsed = parseFormula(f.expression);
      if (parsed.error) {
        issues.push(issue("table_formula_syntax", {
          row: row + 1,
          column: colName,
          detail: formatFormulaErrorMessage(parsed.error, locale),
        }));
        continue;
      }

      const refs = getFormulaReferencedColumns(f.expression);
      if (refs.error) {
        issues.push(issue("table_formula_syntax", {
          row: row + 1,
          column: colName,
          detail: formatFormulaErrorMessage(refs.error, locale),
        }));
        continue;
      }

      const depCols = new Set<number>();
      for (const refName of refs.columns) {
        const refIndex = columnNameToIndex(refName);
        if (refIndex < 0 || refIndex >= maxColumns) {
          issues.push(issue("table_formula_unknown_column", {
            row: row + 1,
            column: colName,
            reference: refName,
          }));
          continue;
        }

        if (refIndex === f.column) {
          issues.push(issue("table_formula_self_reference", { row: row + 1, column: colName }));
          continue;
        }

        if (formulaColSet.has(refIndex)) {
          if (aggregateCells.has(`${row}:${refIndex}`)) {
            issues.push(issue("table_formula_aggregate_dependency", { row: row + 1, column: colName }));
          }
          depCols.add(refIndex);
        }
      }
      dependencyMap.set(f.column, depCols);
    }

    // Check for circular dependency among formulas in the same row
    const visited = new Set<number>();
    const recStack = new Set<number>();

    const hasCycle = (col: number): boolean => {
      visited.add(col);
      recStack.add(col);

      const deps = dependencyMap.get(col) ?? new Set<number>();
      const depList = Array.from(deps);
      for (let di = 0; di < depList.length; di += 1) {
        const dep = depList[di]!;
        if (!visited.has(dep)) {
          if (hasCycle(dep)) return true;
        } else if (recStack.has(dep)) {
          return true;
        }
      }

      recStack.delete(col);
      return false;
    };

    const colList = Array.from(formulaColSet);
    for (let ci = 0; ci < colList.length; ci += 1) {
      const col = colList[ci]!;
      if (!visited.has(col)) {
        if (hasCycle(col)) {
          issues.push(issue("table_formula_circular_reference", {
            row: row + 1,
            column: columnIndexToName(col),
          }));
          break;
        }
      }
    }
  });

  return issues;
}

/**
 * Parses a cell value into a number. Accepts integers, decimals, and properly thousand-grouped numbers.
 * Strictly rejects hex (0x10), octal (0o10), binary (0b10), scientific notation (1e3), Infinity, NaN, bare +/-.
 * Returns null if string is empty / blank.
 * Returns NaN if string is non-empty but not a valid strict decimal number.
 */
export function parseCellNumber(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const str = String(value).trim();
  if (!str) return null;
  const strictPattern = /^[+-]?(?:\d+(?:\.\d+)?|\d{1,3}(?:,\d{3})+(?:\.\d+)?)$/;
  if (!strictPattern.test(str)) {
    return NaN;
  }
  const clean = str.replace(/,/g, "");
  const num = Number(clean);
  return Number.isFinite(num) ? num : NaN;
}

/**
 * Single source of truth calculation:
 * Resolves effective values for every cell in a table grid.
 * - fixed cells always receive "" (ignoring stale residuals)
 * - writable cells receive user input
 * - formula cells are evaluated deterministically:
 *   * all referenced inputs blank -> result is "" (no error, keeps unused rows clean)
 *   * at least one input has number -> blank inputs treated as 0
 *   * non-empty invalid number -> error
 *   * division by zero, negative sqrt, exponent > 100, overflow -> error
 * - Formal grid boundary enforced: raw JSON cannot expand defined columns or rows.
 */
export function resolveEffectiveTableGrid(
  definition: TableRoleDefinition,
  rawValue: string
): TableGridResolution {
  let parsedRows: unknown[] = [];
  try {
    const data = JSON.parse(rawValue);
    if (Array.isArray(data)) {
      parsedRows = data;
    }
  } catch {}

  // Formal grid boundary:
  const formalColumns = Number(definition.tableColumns);
  const columns = Number.isInteger(formalColumns) && formalColumns > 0
    ? Math.min(30, formalColumns)
    : Math.max(
        1,
        Array.isArray(definition.options) ? definition.options.length : 0,
        ...parsedRows.map(r => (Array.isArray(r) ? r.length : 0))
      );

  const formalMaxRows = Number(definition.maxRows);
  const rowSlots = Number.isInteger(formalMaxRows) && formalMaxRows > 0
    ? formalMaxRows
    : Math.max(1, parsedRows.length);

  const roles = resolveTableGridRoles(definition, rowSlots, columns);
  const formulaSchemaVersion = Number(definition.tableFormulaSchemaVersion ?? 1);
  const errors: Array<{ row: number; column: number; code: string; message: string }> = [];

  const rawRows: string[][] = Array.from({ length: rowSlots }, (_, r) => {
    const rowData = parsedRows[r];
    if (Array.isArray(rowData)) {
      return Array.from({ length: columns }, (_, c) =>
        rowData[c] !== undefined && rowData[c] !== null ? String(rowData[c]) : ""
      );
    }
    return Array.from({ length: columns }, () => "");
  });

  const effectiveRows: string[][] = Array.from({ length: rowSlots }, () =>
    Array.from({ length: columns }, () => "")
  );

  const cellResults: TableCellCalculationResult[][] = Array.from(
    { length: rowSlots },
    (_, r) =>
      Array.from({ length: columns }, (_, c) => {
        const role = roles.getRole(r, c);
        const raw = rawRows[r]![c] ?? "";
        const formula = role === "formula" ? roles.formulaMap.get(`${r}:${c}`) : undefined;
        return {
          row: r,
          column: c,
          role,
          value: role === "writable" ? raw : "",
          raw,
          formula,
        };
      })
  );

  // Process row by row
  for (let r = 0; r < rowSlots; r += 1) {
    const formulaCellsInRow = cellResults[r]!.filter(c =>
      c.role === "formula" &&
      c.formula &&
      !(formulaSchemaVersion === 2 && /^=?\s*SUM\s*\(/i.test(c.formula.expression))
    );

    // Initial writable values set
    for (let c = 0; c < columns; c += 1) {
      if (roles.getRole(r, c) === "writable") {
        effectiveRows[r]![c] = rawRows[r]![c] ?? "";
        cellResults[r]![c]!.value = rawRows[r]![c] ?? "";
      } else {
        effectiveRows[r]![c] = "";
        cellResults[r]![c]!.value = "";
      }
    }

    if (!formulaCellsInRow.length) continue;

    // Build dependency graph among formula cells in this row
    const formulaColMap = new Map<number, TableCellCalculationResult>();
    for (const fc of formulaCellsInRow) {
      formulaColMap.set(fc.column, fc);
    }

    const inDegree = new Map<number, number>();
    const adj = new Map<number, number[]>();
    for (const fc of formulaCellsInRow) {
      inDegree.set(fc.column, 0);
      adj.set(fc.column, []);
    }

    for (const fc of formulaCellsInRow) {
      const refs = getFormulaReferencedColumns(fc.formula!.expression);
      if (refs.columns) {
        for (const refName of refs.columns) {
          const refIndex = columnNameToIndex(refName);
          if (formulaColMap.has(refIndex)) {
            // refIndex must be evaluated before fc.column
            adj.get(refIndex)!.push(fc.column);
            inDegree.set(fc.column, (inDegree.get(fc.column) ?? 0) + 1);
          }
        }
      }
    }

    // Topological sort (Kahn's algorithm)
    const queue: number[] = [];
    Array.from(inDegree.entries()).forEach(([col, deg]) => {
      if (deg === 0) queue.push(col);
    });

    const evalOrder: number[] = [];
    while (queue.length > 0) {
      const curr = queue.shift()!;
      evalOrder.push(curr);
      for (const nxt of adj.get(curr) ?? []) {
        const d = (inDegree.get(nxt) ?? 1) - 1;
        inDegree.set(nxt, d);
        if (d === 0) queue.push(nxt);
      }
    }

    // If topological sort didn't include all formula cells, cycle detected
    if (evalOrder.length < formulaCellsInRow.length) {
      for (const fc of formulaCellsInRow) {
        if (!evalOrder.includes(fc.column)) {
          const colName = columnIndexToName(fc.column);
          const errItem = {
            row: r,
            column: fc.column,
            code: "CIRCULAR_REFERENCE",
            message: `第 ${r + 1} 列 ${colName} 欄公式循環引用`,
          };
          errors.push(errItem);
          fc.error = "CIRCULAR_REFERENCE";
        }
      }
    }

    // Evaluate in topological order
    for (const col of evalOrder) {
      const fc = formulaColMap.get(col)!;
      const formula = fc.formula!;
      const colName = columnIndexToName(col);

      const parsed = parseFormula(formula.expression);
      if (parsed.error || !parsed.ast) {
        const errItem = {
          row: r,
          column: col,
          code: "SYNTAX_ERROR",
          message: `第 ${r + 1} 列 ${colName} 欄公式語法錯誤：${parsed.error}`,
        };
        errors.push(errItem);
        fc.error = parsed.error;
        continue;
      }

      const refs = getFormulaReferencedColumns(formula.expression);
      if (refs.error) {
        const errItem = {
          row: r,
          column: col,
          code: "SYNTAX_ERROR",
          message: `第 ${r + 1} 列 ${colName} 欄公式語法錯誤：${refs.error}`,
        };
        errors.push(errItem);
        fc.error = refs.error;
        continue;
      }

      // SUM totals are calculated after same-row expressions. Reject a later
      // total dependency explicitly rather than treating it as blank/zero.
      if (formulaSchemaVersion === 2 && refs.columns.some(name => {
        const source = cellResults[r]?.[columnNameToIndex(name)]?.formula;
        return source && /^=?\s*SUM\s*\(/i.test(source.expression);
      })) {
        fc.error = "AGGREGATE_DEPENDENCY";
        errors.push({ row: r, column: col, code: "AGGREGATE_DEPENDENCY", message: `第 ${r + 1} 列 ${colName} 欄公式不可引用總額格` });
        continue;
      }

      // Check referenced columns
      let hasUnknownColumn = false;
      let selfRef = false;
      for (const refName of refs.columns) {
        const refIndex = columnNameToIndex(refName);
        if (refIndex < 0 || refIndex >= columns) {
          hasUnknownColumn = true;
          const errItem = {
            row: r,
            column: col,
            code: "UNKNOWN_COLUMN",
            message: `第 ${r + 1} 列 ${colName} 欄公式引用未知欄位 ${refName}`,
          };
          errors.push(errItem);
          fc.error = "UNKNOWN_COLUMN";
          break;
        }
        if (refIndex === col) {
          selfRef = true;
          const errItem = {
            row: r,
            column: col,
            code: "CIRCULAR_REFERENCE",
            message: `第 ${r + 1} 列 ${colName} 欄公式不可引用自身`,
          };
          errors.push(errItem);
          fc.error = "CIRCULAR_REFERENCE";
          break;
        }
      }
      if (hasUnknownColumn || selfRef) continue;

      // Check values of referenced columns in row r
      let allBlank = true;
      let hasInvalidNumber = false;
      let invalidColName = "";

      for (const refName of refs.columns) {
        const refIndex = columnNameToIndex(refName);
        const rawCellVal = effectiveRows[r]![refIndex];
        const num = parseCellNumber(rawCellVal);
        if (num !== null) {
          allBlank = false;
          if (Number.isNaN(num)) {
            hasInvalidNumber = true;
            invalidColName = refName;
            break;
          }
        }
      }

      // Rule: If all referenced inputs are blank -> result is blank (no error)
      if (refs.columns.length > 0 && allBlank) {
        effectiveRows[r]![col] = "";
        fc.value = "";
        continue;
      }

      if (hasInvalidNumber) {
        const errItem = {
          row: r,
          column: col,
          code: "INVALID_NUMBER",
          message: `第 ${r + 1} 列 ${colName} 欄公式引用的 ${invalidColName} 欄非有效數字`,
        };
        errors.push(errItem);
        fc.error = "INVALID_NUMBER";
        continue;
      }

      // Evaluate formula
      // Blank referenced cells default to 0 when at least one input has a number
      const evalResult = evaluateFormulaExpression(
        formula.expression,
        (cName, cIndex) => {
          const rawCellVal = effectiveRows[r]![cIndex];
          const parsedNum = parseCellNumber(rawCellVal);
          return parsedNum === null || Number.isNaN(parsedNum) ? 0 : parsedNum;
        },
        { decimalPlaces: formula.decimalPlaces ?? 2 }
      );

      if (evalResult.error) {
        const errItem = {
          row: r,
          column: col,
          code: evalResult.error,
          message: `第 ${r + 1} 列 ${colName} 欄公式無法計算：${evalResult.error}`,
        };
        errors.push(errItem);
        fc.error = evalResult.error;
      } else {
        effectiveRows[r]![col] = evalResult.formatted;
        fc.value = evalResult.formatted;
      }
    }
  }

  // Schema v2 adds one deliberately narrow cross-row operation: SUM(A1:A6).
  // It runs only after every original same-row formula, so totals may safely sum
  // calculated amount cells without changing the legacy evaluation order.
  if (formulaSchemaVersion === 2) {
    const aggregateTargets = cellResults.flat().filter(cell =>
      cell.role === "formula" && cell.formula && /^=?\s*SUM\s*\(/i.test(cell.formula.expression)
    );
    const aggregateTargetKeys = new Set(
      aggregateTargets.map(cell => `${cell.row}:${cell.column}`)
    );
    for (const target of aggregateTargets) {
      const ref = parseTableAggregateExpression(target.formula!.expression).reference;
      const targetName = columnIndexToName(target.column);
      if (
        !ref ||
        ref.column >= columns ||
        ref.endRow >= rowSlots ||
        (ref.column === target.column && target.row >= ref.startRow && target.row <= ref.endRow)
      ) {
        target.error = "INVALID_AGGREGATE_RANGE";
        errors.push({
          row: target.row,
          column: target.column,
          code: "INVALID_AGGREGATE_RANGE",
          message: `第 ${target.row + 1} 列 ${targetName} 欄總額範圍無效`,
        });
        continue;
      }
      let hasValue = false;
      let sum = 0;
      let sourceError = false;
      for (let sourceRow = ref.startRow; sourceRow <= ref.endRow; sourceRow += 1) {
        if (aggregateTargetKeys.has(`${sourceRow}:${ref.column}`)) {
          sourceError = true;
          break;
        }
        const sourceCell = cellResults[sourceRow]![ref.column]!;
        if (sourceCell.error) {
          sourceError = true;
          break;
        }
        const parsed = parseCellNumber(effectiveRows[sourceRow]![ref.column]);
        if (parsed === null) continue;
        if (Number.isNaN(parsed)) {
          sourceError = true;
          break;
        }
        hasValue = true;
        sum += parsed;
      }
      if (sourceError || !Number.isFinite(sum) || Math.abs(sum) > Number.MAX_SAFE_INTEGER) {
        target.error = sourceError ? "INVALID_NUMBER" : "OVERFLOW";
        errors.push({
          row: target.row,
          column: target.column,
          code: target.error,
          message: `第 ${target.row + 1} 列 ${targetName} 欄總額無法計算`,
        });
        continue;
      }
      const value = hasValue ? formatFormulaNumber(sum, target.formula!.decimalPlaces ?? 2) : "";
      target.value = value;
      effectiveRows[target.row]![target.column] = value;
    }
  }

  return {
    rowSlots,
    columns,
    cells: cellResults,
    effectiveRows,
    effectiveJson: JSON.stringify(effectiveRows),
    hasErrors: errors.length > 0,
    errors,
  };
}

export type TableStructureValidationResult = {
  valid: boolean;
  code?: "table" | "table_malformed_row" | "table_malformed_cell";
  /** Stable catalog key; used by the client to localize the message. */
  stableCode?: string;
  message?: string;
};

/**
 * Validates the raw JSON / array structure of a table value.
 * Fails closed on:
 * - Invalid JSON string
 * - Top-level non-array (e.g. object, number, boolean)
 * - Row non-array (e.g. object, number, null)
 * - Cell object, array, function, symbol
 *
 * Primitive cell values (string, number, boolean, null, undefined) are allowed and converted to string.
 */
export function checkTableRawStructure(rawValue: unknown): TableStructureValidationResult {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return { valid: true };
  }

  let parsed: unknown;
  if (typeof rawValue === "string") {
    const trimmed = rawValue.trim();
    if (trimmed === "") {
      return { valid: true };
    }
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return {
        valid: false,
        code: "table",
        stableCode: "table_invalid_json",
        message: formatFormulaIssueMessage("table_invalid_json", "zh-Hant"),
      };
    }
  } else {
    parsed = rawValue;
  }

  if (!Array.isArray(parsed)) {
    return {
      valid: false,
      code: "table",
      stableCode: "table_not_array",
      message: formatFormulaIssueMessage("table_not_array", "zh-Hant"),
    };
  }

  for (let r = 0; r < parsed.length; r++) {
    const row = parsed[r];
    if (!Array.isArray(row)) {
      return {
        valid: false,
        code: "table_malformed_row",
        stableCode: "table_malformed_row",
        message: formatFormulaIssueMessage("table_malformed_row", "zh-Hant"),
      };
    }
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (
        cell !== null &&
        cell !== undefined &&
        (typeof cell === "object" || typeof cell === "function" || typeof cell === "symbol")
      ) {
        return {
          valid: false,
          code: "table_malformed_cell",
          stableCode: "table_malformed_cell",
          message: formatFormulaIssueMessage("table_malformed_cell", "zh-Hant"),
        };
      }
    }
  }

  return { valid: true };
}

export function assertValidTableRawStructure(rawValue: unknown): void {
  const result = checkTableRawStructure(rawValue);
  if (!result.valid) {
    throw new Error(result.message || formatFormulaIssueMessage("table_structure_invalid", "zh-Hant"));
  }
}

/**
 * Normalizes a table field value for raw storage (raw authority):
 * - Fixed cells and formula cells are stored as "" (empty string)
 * - Only writable cell inputs are kept
 * - Enforces grid dimensions strictly: rows <= maxRows, columns <= tableColumns
 * - Drops out-of-bounds rows or cells
 * - Ensures every row is an array
 * - Returns a JSON string representing string[][]
 */
export function normalizeTableRawAuthority(
  definition: TableRoleDefinition,
  rawValue: unknown
): string {
  assertValidTableRawStructure(rawValue);

  let parsed: unknown[] = [];
  if (typeof rawValue === "string") {
    const trimmed = rawValue.trim();
    if (trimmed !== "") {
      parsed = JSON.parse(trimmed);
    }
  } else if (Array.isArray(rawValue)) {
    parsed = rawValue;
  }

  const formalColumns = Number(definition.tableColumns);
  const columns = Number.isInteger(formalColumns) && formalColumns > 0
    ? Math.min(30, formalColumns)
    : Math.max(
        1,
        Array.isArray(definition.options) ? definition.options.length : 0,
        ...parsed.map(r => (Array.isArray(r) ? r.length : 0))
      );

  const formalMaxRows = Number(definition.maxRows);
  const rowSlots = Number.isInteger(formalMaxRows) && formalMaxRows > 0
    ? formalMaxRows
    : Math.max(1, parsed.length);

  const roles = resolveTableGridRoles(definition, rowSlots, columns);

  const normalizedRows: string[][] = Array.from({ length: rowSlots }, (_, r) => {
    const rawRow = parsed[r];
    const isRowArray = Array.isArray(rawRow);
    return Array.from({ length: columns }, (_, c) => {
      if (roles.getRole(r, c) !== "writable") {
        return "";
      }
      if (!isRowArray) return "";
      const val = rawRow[c];
      return val !== undefined && val !== null ? String(val) : "";
    });
  });

  return JSON.stringify(normalizedRows);
}

/**
 * Normalizes an instance values record before storage and before hashing:
 * - Table fields are processed via normalizeTableRawAuthority
 * - Non-table fields remain unchanged
 */
export function normalizeInstanceValuesForStorage(
  values: Record<string, string>,
  fields: Array<{ stableFieldId: string; fieldType: string; definition?: unknown }>
): Record<string, string> {
  const normalized: Record<string, string> = { ...values };
  for (const f of fields) {
    if (f.fieldType === "table") {
      const def = (f.definition && typeof f.definition === "object" && !Array.isArray(f.definition))
        ? f.definition as TableRoleDefinition
        : {};
      const rawVal = values[f.stableFieldId];
      if (rawVal !== undefined) {
        normalized[f.stableFieldId] = normalizeTableRawAuthority(def, rawVal);
      }
    }
  }
  return normalized;
}

/**
 * Trilingual user-readable message mapping for formula errors.
 */
export function formatFormulaErrorMessage(
  code: string,
  lang: FormulaLocale | "zh-TW" | "zh-CN" = "zh-Hant"
): string {
  const map: Record<string, { "zh-Hant": string; "zh-Hans": string; en: string }> = {
    EMPTY_EXPRESSION: {
      "zh-Hant": "公式不可為空",
      "zh-Hans": "公式不可为空",
      en: "Formula expression cannot be empty",
    },
    UNEXPECTED_CHARACTER: {
      "zh-Hant": "公式包含未允許的字元",
      "zh-Hans": "公式包含未允许的字符",
      en: "Formula contains disallowed characters",
    },
    INVALID_NUMBER_SYNTAX: {
      "zh-Hant": "數字格式錯誤",
      "zh-Hans": "数字格式错误",
      en: "Invalid number syntax",
    },
    INVALID_THOUSAND_SEPARATOR: {
      "zh-Hant": "千分位逗號分組錯誤",
      "zh-Hans": "千分位逗号分组错误",
      en: "Invalid thousand separator grouping",
    },
    EXPRESSION_TOO_COMPLEX: {
      "zh-Hant": "表達式超出複雜度上限（最多 128 個節點）",
      "zh-Hans": "表达式超出复杂度上限（最多 128 个节点）",
      en: "Expression too complex (max 128 nodes)",
    },
    EXPRESSION_TOO_DEEP: {
      "zh-Hant": "括號或計算深度過深（最多 16 層）",
      "zh-Hans": "括号或计算深度过深（最多 16 层）",
      en: "Expression depth exceeded (max 16 levels)",
    },
    UNEXPECTED_TOKEN: {
      "zh-Hant": "公式語法不符合規則",
      "zh-Hans": "公式语法不符合规则",
      en: "Unexpected token in formula syntax",
    },
    EXPECTED_LPAREN_AFTER_SQRT: {
      "zh-Hant": "sqrt 後方必須緊隨左括號 (",
      "zh-Hans": "sqrt 后方必须紧随左括号 (",
      en: "Expected '(' immediately after sqrt",
    },
    EXPECTED_RPAREN: {
      "zh-Hant": "缺少對應的右括號 )",
      "zh-Hans": "缺少对应的右括号 )",
      en: "Missing closing parenthesis ')'",
    },
    UNEXPECTED_END_OF_EXPRESSION: {
      "zh-Hant": "公式表達式未完成",
      "zh-Hans": "公式表达式未完成",
      en: "Incomplete formula expression",
    },
    DIVISION_BY_ZERO: {
      "zh-Hant": "除以零錯誤",
      "zh-Hans": "除以零错误",
      en: "Division by zero",
    },
    NEGATIVE_SQRT: {
      "zh-Hant": "不可對負數計算平方根",
      "zh-Hans": "不可对负数计算平方根",
      en: "Cannot compute square root of negative number",
    },
    EXPONENT_TOO_LARGE: {
      "zh-Hant": "指數絕對值超過 100",
      "zh-Hans": "指数绝对值超过 100",
      en: "Exponent too large (absolute value > 100)",
    },
    OVERFLOW: {
      "zh-Hant": "數值超出安全上限",
      "zh-Hans": "数值超出安全上限",
      en: "Numeric overflow",
    },
    INVALID_NUMBER: {
      "zh-Hant": "參照的儲存格包含無效數字",
      "zh-Hans": "参照的单元格包含无效数字",
      en: "Referenced cell contains invalid number",
    },
    AGGREGATE_DEPENDENCY: {
      "zh-Hant": "公式不可引用總額格，請直接加總明細列",
      "zh-Hans": "公式不可引用总额单元格，请直接汇总明细行",
      en: "A formula cannot depend on a total cell; sum the detail rows instead",
    },
    CIRCULAR_REFERENCE: {
      "zh-Hant": "公式存在循環引用",
      "zh-Hans": "公式存在循环引用",
      en: "Circular reference detected",
    },
    UNKNOWN_COLUMN: {
      "zh-Hant": "引用未知的欄位",
      "zh-Hans": "引用未知的列",
      en: "Referenced column does not exist",
    },
    CALCULATION_ERROR: {
      "zh-Hant": "計算發生錯誤",
      "zh-Hans": "计算发生错误",
      en: "Calculation error",
    },
    SYNTAX_ERROR: {
      "zh-Hant": "公式語法錯誤",
      "zh-Hans": "公式语法错误",
      en: "Formula syntax error",
    },
    PARSE_ERROR: {
      "zh-Hant": "公式解析失敗",
      "zh-Hans": "公式解析失败",
      en: "Failed to parse formula",
    },
    TOKENIZE_FAILED: {
      "zh-Hant": "公式分析失敗",
      "zh-Hans": "公式分析失败",
      en: "Failed to tokenize formula",
    },
    EXPRESSION_TOO_LONG: {
      "zh-Hant": "表達式長度超出上限（最多 200 個字元）",
      "zh-Hans": "表达式长度超出上限（最多 200 个字符）",
      en: "Expression too long (max 200 characters)",
    },
    INVALID_NUMBER_VALUE: {
      "zh-Hant": "數值無效或超出範圍",
      "zh-Hans": "数值无效或超出范围",
      en: "Invalid or out of range number value",
    },
    CROSS_ROW_NOT_ALLOWED: {
      "zh-Hant": "公式不允許跨列引用",
      "zh-Hans": "公式不允许跨行引用",
      en: "Cross-row cell references are not allowed",
    },
    UNSUPPORTED_FUNCTION: {
      "zh-Hant": "不支援的函數名稱（僅支援 sqrt）",
      "zh-Hans": "不支持的函数名称（仅支持 sqrt）",
      en: "Unsupported function (only sqrt is supported)",
    },
  };

  if (!code) return "";
  const target = normalizeFormulaLocale(lang);
  const baseCode = code.split(":")[0]?.trim() || code;
  const entry = map[baseCode];
  if (entry) return entry[target] ?? entry["zh-Hant"] ?? FORMULA_GENERIC_MESSAGE[target];
  return FORMULA_GENERIC_MESSAGE[target];
}

/**
 * Wire format for a stable, structured validation issue.
 *
 * The server has no UI locale, so it returns the stable code plus safe
 * parameters; the client renders it with `localizeServerIssueMarkers()` in the
 * active locale. `fallbackText` keeps the pre-existing Traditional Chinese
 * diagnostics inside the marker for server logs and for any consumer that has
 * not been updated yet; the client always replaces the whole marker, so it is
 * never shown to a user in another language.
 */
const SERVER_ISSUE_PREFIX = "[[FD_ISSUE:";

function sanitizeIssueValue(value: string) {
  return String(value).replace(/[\[\]|]/g, " ").replace(/\s+/g, " ").trim();
}

export function renderServerIssue(
  code: string,
  params: Record<string, string | number> = {},
  fallbackText = ""
): string {
  const safeCode = sanitizeIssueValue(String(code ?? "")).replace(/[^a-zA-Z0-9_]/g, "");
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    const safeKey = sanitizeIssueValue(key).replace(/[^a-zA-Z0-9_]/g, "");
    if (!safeKey) continue;
    parts.push(`${safeKey}=${sanitizeIssueValue(String(value))}`);
  }
  if (fallbackText) parts.push(`msg=${sanitizeIssueValue(fallbackText)}`);
  return `${SERVER_ISSUE_PREFIX}${safeCode}${parts.length ? `|${parts.join("|")}` : ""}]]`;
}

const SERVER_ISSUE_PATTERN = /\[\[FD_ISSUE:([a-zA-Z0-9_]*)((?:\|[^[\]]*)?)\]\]/g;

/**
 * Replaces every stable issue marker with the localized message. An unknown or
 * malformed marker degrades to the generic safe message, so a raw code, a
 * token suffix or internal text can never reach the page.
 */
export function localizeServerIssueMarkers(
  message: string,
  locale: FormulaLocale | "zh-TW" | "zh-CN" | undefined
): string {
  const target = normalizeFormulaLocale(locale);
  return String(message ?? "").replace(SERVER_ISSUE_PATTERN, (_full, rawCode: string, rawParams: string) => {
    const params: Record<string, string | number> = {};
    for (const segment of rawParams.split("|").filter(Boolean)) {
      const separator = segment.indexOf("=");
      if (separator <= 0) continue;
      const key = segment.slice(0, separator);
      // `msg` is the legacy Traditional Chinese fallback; it must never be
      // echoed verbatim in another locale.
      if (key === "msg") continue;
      params[key] = segment.slice(separator + 1);
    }
    const code = String(rawCode ?? "");
    // Unknown wire validation codes are not necessarily formula errors, so they
    // must not be mislabeled with the formula-specific generic. Fall back to a
    // generic data-validation message in the active locale instead.
    // Membership must be checked with hasOwnProperty: the `in` operator would
    // also match Object.prototype keys (constructor / toString / __proto__ / ...)
    // and wrongly degrade them to a formula error.
    if (!code || !Object.prototype.hasOwnProperty.call(FORMULA_ISSUE_CATALOG, code)) {
      return VALIDATION_GENERIC_MESSAGE[target];
    }
    return formatFormulaIssueMessage(code, target, params);
  });
}
