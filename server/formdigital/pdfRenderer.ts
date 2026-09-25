/**
 * Version-pinned PDF renderer. All source assets are read from localhost and
 * calibration is applied through the same millimetre render plan as Preview.
 */
import fs from "node:fs/promises";
import fontkit from "@pdf-lib/fontkit";
import {
  PDFDocument,
  StandardFonts,
  TextAlignment,
  drawEllipse,
  clip,
  degrees,
  endPath,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  rgb,
  type Color,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";
import { createFieldRenderPlan } from "../../shared/renderPlan";
import { fieldMarkStrokes, normalizeFieldMark } from "../../shared/fieldMark";
import {
  knownOptions,
  normalizeOption,
  selectedCheckboxOptions,
  selectedSingleOption,
} from "../../shared/checkboxSelection";
import { tableCellRect, tableGridSize } from "../../shared/tableGeometry";
import { resolveEffectiveTableGrid, type TableRoleDefinition } from "../../shared/tableFormula";
import { getOwnedAssetBytes, storeOwnedAsset } from "./assetStore";
import { getInstanceForOwner, recordInstanceOutput } from "./repository";
import { validateFieldValues } from "../../shared/fieldValidation";

const MM_TO_POINT = 72 / 25.4;

type FieldCoordinate = {
  page?: number;
  xMm?: number;
  yMm?: number;
  widthMm?: number;
  heightMm?: number;
  fontSizePt?: number;
  align?: "left" | "center" | "right";
};
type PageManifestItem = { page?: number; widthMm?: number; heightMm?: number; assetId?: string };
type VersionField = { stableFieldId: string; fieldType?: string; definition?: unknown; coordinate: unknown };
type DefinitionBox = { xRatio: number; yRatio: number; widthRatio: number; heightRatio: number };
type DefinitionOptionMark = DefinitionBox & { option: string };
type OutputFonts = {
  sans: { regular: PDFFont; bold: PDFFont; italic: PDFFont; boldItalic: PDFFont };
  mono: { regular: PDFFont; bold: PDFFont; italic: PDFFont; boldItalic: PDFFont };
  cjk: PDFFont | null;
};
export type RenderPageSource = { mimeType: string; bytes: Uint8Array };
export type PdfOutputMode = "full" | "overlay" | "editable";

export function mmToPoint(mm: number) { return mm * MM_TO_POINT; }

export function drawPosition(pageWidth: number, pageHeight: number, coordinate: FieldCoordinate, scaleX: number, scaleY: number, offsetX: number, offsetY: number) {
  const renderPlan = createFieldRenderPlan({ pageWidthMm: pageWidth / MM_TO_POINT, pageHeightMm: pageHeight / MM_TO_POINT, field: coordinate, calibration: { scaleX, scaleY, offsetXmm: offsetX, offsetYmm: offsetY } });
  const width = mmToPoint(renderPlan.widthMm);
  const height = mmToPoint(renderPlan.heightMm);
  return { x: mmToPoint(renderPlan.xMm), y: pageHeight - mmToPoint(renderPlan.yMm) - height, width, height, pageWidth };
}

/** Field types whose printed options are part of the exported document. */
const optionBearingFieldTypes = new Set(["select", "radio", "checkbox"]);

/**
 * The characters WinAnsiEncoding can actually represent.
 *
 * "Above 255" was never this question. It forced a CJK font for a euro sign or
 * a curly apostrophe, which the standard fonts encode perfectly well, and it
 * waved through the handful of bytes below 256 that WinAnsi leaves undefined.
 * With the font now required to cover everything it prints, guessing wrongly
 * in either direction either refuses an exportable form or accepts one that
 * cannot be drawn.
 */
const WIN_ANSI_HIGH_RANGE = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030,
  0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022,
  0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

export function isWinAnsiCodePoint(codePoint: number) {
  if (codePoint >= 0x20 && codePoint <= 0x7e) return true;
  if (codePoint >= 0xa0 && codePoint <= 0xff) return true;
  return WIN_ANSI_HIGH_RANGE.has(codePoint);
}

/**
 * Whether a character forces a custom font.
 *
 * Control characters are excluded: the renderer splits a value into lines
 * before it encodes anything, so a newline is never drawn and has no glyph to
 * look for. Counting it as unencodable made a plain "AB
CD" demand a Chinese
 * font and then fail because no font has a glyph for a line break.
 */
function needsCustomFont(codePoint: number) {
  if (codePoint < 0x20 || codePoint === 0x7f) return false;
  return !isWinAnsiCodePoint(codePoint);
}

function isNonWinAnsi(value: string) {
  return Array.from(value).some((character) =>
    needsCustomFont(character.codePointAt(0)!)
  );
}

/**
 * Fonts this build can embed without losing characters.
 *
 * `@pdf-lib/fontkit` writes a corrupt subset for a variable font: roughly half
 * the glyphs come out empty or point past the end of the embedded program, so
 * the PDF prints some characters and silently drops the rest — measured at 15
 * of 34 on Windows' bundled NotoSansTC-VF, which used to be the first font
 * tried here. It cannot subset a font collection (.ttc) at all. Both are
 * rejected up front so a font that would quietly lose text is never chosen.
 */
function sfntTableTags(bytes: Buffer) {
  if (bytes.length < 12) return null;
  if (bytes.toString("latin1", 0, 4) === "ttcf") return ["ttcf"];
  const tableCount = bytes.readUInt16BE(4);
  if (12 + tableCount * 16 > bytes.length) return null;
  const tags: string[] = [];
  for (let index = 0; index < tableCount; index += 1)
    tags.push(bytes.toString("latin1", 12 + index * 16, 16 + index * 16));
  return tags;
}

export function unusableFontReason(bytes: Buffer) {
  const tags = sfntTableTags(bytes);
  if (!tags) return "無法辨識的字型格式";
  if (tags.includes("ttcf")) return "字型集合（.ttc）無法嵌入";
  if (tags.includes("fvar")) return "可變字型（variable font）嵌入後會遺失字符";
  return null;
}

/** Forward slashes throughout: Node accepts them on Windows too. */
const CJK_FONT_CANDIDATES = [
  // Traditional Chinese first — these carry the shapes a Hong Kong form expects.
  "C:/Windows/Fonts/kaiu.ttf",
  "/usr/share/fonts/opentype/noto/NotoSansTC-Regular.otf",
  "/usr/share/fonts/truetype/noto/NotoSansTC-Regular.otf",
  "/System/Library/Fonts/Supplemental/BiauKai.ttf",
  // Then anything else carrying the glyphs, so output is never left blank.
  "C:/Windows/Fonts/Deng.ttf",
  "C:/Windows/Fonts/simhei.ttf",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "/System/Library/Fonts/PingFang.ttc",
];

/** The characters an output needs a custom font for, as code points. */
export function requiredCjkCodePoints(values: string[]) {
  const required = new Set<number>();
  for (const value of values)
    for (const character of value) {
      const codePoint = character.codePointAt(0)!;
      if (needsCustomFont(codePoint)) required.add(codePoint);
    }
  return required;
}

/**
 * Whether a font can actually draw every one of these characters.
 *
 * Rejecting variable fonts and collections is not enough on its own: a static
 * font that embeds cleanly can still have no glyph for a character, and a font
 * is free to map an unknown character onto .notdef, which occupies its width
 * and prints nothing. Both produce the same silent gap in the exported form
 * that a broken subset produced, so a mapping to glyph 0 counts as missing.
 */
/**
 * Characters that are meant to have no outline.
 *
 * An ideographic space is as ordinary in Chinese text as a plain space is in
 * English, and like every space it draws nothing. Treating "no outline" as
 * "missing" on its own would refuse almost every Chinese form, so blankness is
 * only a fault for a character that is supposed to carry ink. Listed by code
 * point rather than by Unicode property so the check does not depend on the
 * regular-expression features available to this build.
 */
const BLANK_BY_DESIGN = new Set([
  0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
  0x2008, 0x2009, 0x200a, 0x200b, 0x200c, 0x200d, 0x2028, 0x2029, 0x202f,
  0x205f, 0x3000, 0xfeff,
]);

export function fontCoversCodePoints(bytes: Buffer, codePoints: ReadonlySet<number>) {
  type ProbedFont = {
    fonts?: unknown;
    hasGlyphForCodePoint: (codePoint: number) => boolean;
    glyphForCodePoint: (
      codePoint: number
    ) => { id: number; path?: { commands: unknown[] } } | null;
  };
  // A file that is not really a font may still parse far enough to be handed
  // back, and only fail when a glyph is asked for, so every probe is guarded
  // rather than just the parse.
  try {
    const font = (
      fontkit as unknown as { create: (data: Buffer) => ProbedFont }
    ).create(bytes);
    if (!font || font.fonts) return false;
    for (const codePoint of Array.from(codePoints)) {
      if (!font.hasGlyphForCodePoint(codePoint)) return false;
      const glyph = font.glyphForCodePoint(codePoint);
      // A font is free to answer with .notdef, which reserves the width and
      // prints nothing, and it can also carry a real glyph id whose outline is
      // empty. Both put a hole in the exported form, so both count as missing.
      if (!glyph || glyph.id === 0) return false;
      if (
        (glyph.path?.commands.length ?? 0) === 0 &&
        !BLANK_BY_DESIGN.has(codePoint)
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function readFirstUsableFont(paths: string[], required: Set<number>) {
  const rejected: string[] = [];
  for (const fontPath of paths) {
    if (!fontPath) continue;
    let bytes: Buffer;
    try { bytes = await fs.readFile(fontPath); } catch { continue; }
    const reason = unusableFontReason(bytes);
    if (reason) {
      rejected.push(`${fontPath}（${reason}）`);
      continue;
    }
    if (!fontCoversCodePoints(bytes, required)) {
      rejected.push(`${fontPath}（缺少輸出所需字符）`);
      continue;
    }
    return { bytes, rejected };
  }
  return { bytes: null, rejected };
}

async function embedOutputFonts(pdf: PDFDocument, values: string[]): Promise<OutputFonts> {
  const [sansRegular, sansBold, sansItalic, sansBoldItalic, monoRegular, monoBold, monoItalic, monoBoldItalic] = await Promise.all([
    pdf.embedFont(StandardFonts.Helvetica),
    pdf.embedFont(StandardFonts.HelveticaBold),
    pdf.embedFont(StandardFonts.HelveticaOblique),
    pdf.embedFont(StandardFonts.HelveticaBoldOblique),
    pdf.embedFont(StandardFonts.Courier),
    pdf.embedFont(StandardFonts.CourierBold),
    pdf.embedFont(StandardFonts.CourierOblique),
    pdf.embedFont(StandardFonts.CourierBoldOblique),
  ]);
  let cjk: PDFFont | null = null;
  if (values.some(isNonWinAnsi)) {
    // Pick a font by what this particular output needs, not by what merely
    // embeds: a form is refused rather than exported with characters missing.
    const required = requiredCjkCodePoints(values);
    const { bytes: customBytes, rejected } = await readFirstUsableFont(
      [process.env.FORMDIGITAL_CJK_FONT ?? "", ...CJK_FONT_CANDIDATES],
      required,
    );
    if (!customBytes) {
      // The count is shape; the characters themselves are the person's own
      // data and never appear in the message or the log.
      console.error(
        `[pdf-renderer] no offline font covers all ${required.size} non-WinAnsi characters in this output; refused. Skipped: ${rejected.length}`,
      );
      throw new Error(
        "找不到可完整輸出本次內容的離線繁體中文字型；請設定 FORMDIGITAL_CJK_FONT 指向一款靜態（非 variable、非 .ttc）且包含所有所需字符的 TTF/OTF 字型。"
      );
    }
    pdf.registerFontkit(fontkit);
    try {
      cjk = await pdf.embedFont(customBytes, { subset: true });
    } catch (error) {
      // Fixed and value-free: the underlying message can carry a font path.
      throw new Error("無法載入繁體中文字型；請確認 FORMDIGITAL_CJK_FONT 指向可用的靜態 TTF/OTF 字型。");
    }
  }
  return {
    sans: { regular: sansRegular, bold: sansBold, italic: sansItalic, boldItalic: sansBoldItalic },
    mono: { regular: monoRegular, bold: monoBold, italic: monoItalic, boldItalic: monoBoldItalic },
    cjk,
  };
}

function outputFont(fonts: OutputFonts, value: string, definition: Record<string, unknown>) {
  if (isNonWinAnsi(value)) return fonts.cjk ?? fonts.sans.regular;
  const family = typeof definition.fontFamily === "string" ? definition.fontFamily.toLowerCase() : "";
  const variants = family.includes("mono") ? fonts.mono : fonts.sans;
  if (definition.bold === true && definition.italic === true) return variants.boldItalic;
  if (definition.bold === true) return variants.bold;
  if (definition.italic === true) return variants.italic;
  return variants.regular;
}

function fieldDefinition(field: VersionField) {
  return field.definition && typeof field.definition === "object" && !Array.isArray(field.definition)
    ? field.definition as Record<string, unknown>
    : {};
}

function definitionBoxes(value: unknown): DefinitionBox[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const candidate = item as Record<string, unknown>;
    const box = {
      xRatio: Number(candidate.xRatio),
      yRatio: Number(candidate.yRatio),
      widthRatio: Number(candidate.widthRatio),
      heightRatio: Number(candidate.heightRatio),
    };
    if (!Object.values(box).every(Number.isFinite)) return [];
    if (box.widthRatio <= 0 || box.heightRatio <= 0) return [];
    return [box];
  });
}

function definitionOptionMarks(value: unknown): DefinitionOptionMark[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const candidate = item as Record<string, unknown>;
    const option = typeof candidate.option === "string" ? candidate.option : "";
    const box = definitionBoxes([candidate])[0];
    return option && box ? [{ option, ...box }] : [];
  });
}

function checkedValue(value: string, options?: unknown) {
  return knownOptions(options).length
    ? selectedCheckboxOptions(value, options).length > 0
    : /^(checked|true|1|yes|是)$/i.test(value.trim());
}

function formatOutputValue(value: string, fieldType: string | undefined, definition: Record<string, unknown>) {
  if (fieldType === "date" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-");
    if (definition.dateFormat === "dd-mm-yyyy") return `${day}-${month}-${year}`;
    if (definition.dateFormat === "mm-dd-yyyy") return `${month}-${day}-${year}`;
  }
  if (fieldType === "time" && definition.timeFormat === "hhmm") return value.replace(":", "");
  if (fieldType === "characterBox") {
    // Same rule as the fill UI and the preview: printed separators belong to
    // the form, so "23/08/2026" fills eight boxes instead of being cut to three.
    const cleaned = value.replace(/[^a-zA-Z0-9一-鿿]/g, "");
    const boxCount = Number(definition.boxCount);
    return Number.isInteger(boxCount) && boxCount > 0
      ? Array.from(cleaned).slice(0, boxCount).join("")
      : cleaned;
  }
  return value;
}

function safePdfFieldName(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 120) || "field";
}

function textWidth(font: PDFFont, value: string, size: number) {
  try { return font.widthOfTextAtSize(value, size); } catch { return value.length * size * 0.55; }
}

function letterSpacing(definition: Record<string, unknown>) {
  const value = Number(definition.letterSpacingPt);
  return Number.isFinite(value) ? Math.max(-10, Math.min(100, value)) : 0;
}

function spacedTextWidth(font: PDFFont, value: string, size: number, spacing: number) {
  return textWidth(font, value, size) + Math.max(0, Array.from(value).length - 1) * spacing;
}

function wrapText(value: string, font: PDFFont, size: number, maxWidth: number, spacing = 0) {
  const logicalLines = value.replace(/\r/g, "").split("\n");
  const result: string[] = [];
  for (const logicalLine of logicalLines) {
    if (!logicalLine || maxWidth <= 0) { result.push(logicalLine); continue; }
    let current = "";
    for (const character of Array.from(logicalLine)) {
      if (current && spacedTextWidth(font, current + character, size, spacing) > maxWidth) {
        result.push(current);
        current = character;
      } else current += character;
    }
    result.push(current);
  }
  return result;
}

function alignedX(x: number, width: number, text: string, font: PDFFont, size: number, align?: "left" | "center" | "right") {
  const measured = textWidth(font, text, size);
  if (align === "right") return x + Math.max(0, width - measured);
  if (align === "center") return x + Math.max(0, (width - measured) / 2);
  return x;
}

function textColor(value: unknown): Color {
  if (typeof value !== "string") return rgb(0.05, 0.09, 0.14);
  const shorthand = /^#([0-9a-f]{3})$/i.exec(value.trim());
  const full = /^#([0-9a-f]{6})$/i.exec(value.trim());
  const hex = full?.[1] ?? (shorthand?.[1] ? Array.from(shorthand[1]).map(character => character + character).join("") : "");
  if (!hex) return rgb(0.05, 0.09, 0.14);
  return rgb(Number.parseInt(hex.slice(0, 2), 16) / 255, Number.parseInt(hex.slice(2, 4), 16) / 255, Number.parseInt(hex.slice(4, 6), 16) / 255);
}

function drawTextLine(page: PDFPage, value: string, font: PDFFont, x: number, y: number, size: number, definition: Record<string, unknown>) {
  const spacing = letterSpacing(definition);
  const color = textColor(definition.color);
  const italicSimulation = definition.italic === true && isNonWinAnsi(value);
  const boldSimulation = definition.bold === true && isNonWinAnsi(value);
  let cursor = x;
  for (const character of spacing === 0 ? [value] : Array.from(value)) {
    page.drawText(character, { x: cursor, y, size, font, color, ...(italicSimulation ? { xSkew: degrees(-12) } : {}) });
    if (boldSimulation) page.drawText(character, { x: cursor + 0.18, y, size, font, color, ...(italicSimulation ? { xSkew: degrees(-12) } : {}) });
    cursor += textWidth(font, character, size) + spacing;
  }
  const width = spacedTextWidth(font, value, size, spacing);
  if (definition.underline === true && width > 0)
    page.drawLine({ start: { x, y: y - Math.max(0.5, size * 0.08) }, end: { x: x + width, y: y - Math.max(0.5, size * 0.08) }, thickness: Math.max(0.35, size * 0.055), color });
}

/**
 * PDF drawing is not clipped by a field's geometry automatically. Keep the
 * graphics-state pair local to one field so oversized text/images cannot
 * cover a neighbouring field or escape the page-sized preview box.
 */
function withFieldClip(page: PDFPage, position: ReturnType<typeof drawPosition>, draw: () => void) {
  if (position.width <= 0 || position.height <= 0) return;
  page.pushOperators(
    pushGraphicsState(),
    rectangle(position.x, position.y, position.width, position.height),
    clip(),
    endPath(),
  );
  try {
    draw();
  } finally {
    page.pushOperators(popGraphicsState());
  }
}

function drawPlainText(page: PDFPage, value: string, font: PDFFont, coordinate: FieldCoordinate, position: ReturnType<typeof drawPosition>, definition: Record<string, unknown>) {
  const initialSize = Math.max(1, coordinate.fontSizePt ?? (typeof definition.fontSizePt === "number" ? definition.fontSizePt : 10));
  const initialLineHeight = typeof definition.lineHeightPt === "number" && definition.lineHeightPt > 0 ? definition.lineHeightPt : initialSize * 1.2;
  const spacing = letterSpacing(definition);
  const overflow = definition.overflow === "block" || definition.overflow === "shrink" || definition.overflow === "wrap" ? definition.overflow : "warn";
  let fontSize = initialSize;
  let lineHeight = initialLineHeight;
  let lines = wrapText(value, font, fontSize, position.width, spacing);
  const fits = () => lines.every(line => spacedTextWidth(font, line, fontSize, spacing) <= position.width + 0.01) && lines.length * lineHeight <= position.height + 0.01;
  if (overflow === "shrink") {
    while (!fits() && fontSize > 4) {
      fontSize = Math.max(4, fontSize - 0.25);
      lineHeight = initialLineHeight * (fontSize / initialSize);
      lines = wrapText(value, font, fontSize, position.width, spacing);
    }
    if (!fits()) throw new Error("PDF 欄位內容即使縮小後仍超出可用範圍。");
  } else if (overflow === "block" && !fits()) {
    throw new Error("PDF 欄位內容超出可用範圍，已停止輸出。");
  }
  withFieldClip(page, position, () => {
    lines.forEach((line, index) => {
      const y = position.y + position.height - fontSize - index * lineHeight;
      const measured = spacedTextWidth(font, line, fontSize, spacing);
      const align = coordinate.align ?? (definition.align === "center" || definition.align === "right" ? definition.align : "left");
      const x = align === "right" ? position.x + Math.max(0, position.width - measured) : align === "center" ? position.x + Math.max(0, (position.width - measured) / 2) : position.x;
      drawTextLine(page, line, font, x, y, fontSize, definition);
    });
  });
}

function drawCharacterBoxes(page: PDFPage, value: string, font: PDFFont, coordinate: FieldCoordinate, position: ReturnType<typeof drawPosition>, definition: Record<string, unknown>, detectedPositions: Array<ReturnType<typeof drawPosition>>) {
  const characters = Array.from(value);
  const count = Math.max(1, Number(definition.boxCount) || characters.length || 1);
  const boxWidth = position.width / count;
  const hasDetectedBoxes = detectedPositions.length === count;
  for (let index = 0; index < count; index += 1) {
    const target = hasDetectedBoxes
      ? detectedPositions[index]!
      : { ...position, x: position.x + index * boxWidth, width: boxWidth };
    const fontSize = coordinate.fontSizePt ?? Math.min(12, target.height * 0.6);
    if (!hasDetectedBoxes) page.drawRectangle({ x: target.x, y: target.y, width: target.width, height: target.height, borderColor: rgb(0.55, 0.58, 0.62), borderWidth: 0.5 });
    const character = characters[index];
    if (character) drawTextLine(page, character, font, alignedX(target.x, target.width, character, font, fontSize, "center"), target.y + Math.max(0, (target.height - fontSize) / 2), fontSize, definition);
  }
}

/**
 * Draw a tick, cross, or dot centred inside `position`.
 *
 * Text would sit on the box's top edge (drawPlainText anchors to the baseline)
 * and needs a font that can encode the glyph; vector strokes always land in the
 * middle of the printed square and never depend on a font.
 */
function drawFieldMark(page: PDFPage, style: unknown, position: ReturnType<typeof drawPosition>, color: Color = rgb(0.05, 0.09, 0.14)) {
  const mark = fieldMarkStrokes(normalizeFieldMark(style), position.width, position.height);
  if (mark.outline) {
    page.drawEllipse({
      x: position.x + mark.centerX,
      y: position.y + position.height - mark.centerY,
      xScale: mark.outline.radiusX,
      yScale: mark.outline.radiusY,
      borderColor: color,
      borderWidth: mark.strokeWidth,
    });
    return;
  }
  if (mark.radius > 0) {
    page.drawCircle({ x: position.x + mark.centerX, y: position.y + position.height - mark.centerY, size: mark.radius, color });
    return;
  }
  for (const line of mark.lines)
    page.drawLine({
      // The shared geometry is y-down; PDF space is y-up.
      start: { x: position.x + line.x0, y: position.y + position.height - line.y0 },
      end: { x: position.x + line.x1, y: position.y + position.height - line.y1 },
      thickness: mark.strokeWidth,
      color,
    });
}

/**
 * Where a radio option is marked when the source form gave no per-option
 * geometry: split the field box along its longer axis, one slot per option.
 */
function radioSlot(position: ReturnType<typeof drawPosition>, index: number, total: number) {
  const count = Math.max(1, total);
  if (position.width >= position.height) {
    const slot = position.width / count;
    return { ...position, x: position.x + index * slot, width: slot };
  }
  const slot = position.height / count;
  return { ...position, y: position.y + position.height - (index + 1) * slot, height: slot };
}

function drawTable(
  page: PDFPage,
  value: string,
  font: PDFFont,
  position: ReturnType<typeof drawPosition>,
  coordinate: FieldCoordinate,
  definition: Record<string, unknown>
) {
  const grid = resolveEffectiveTableGrid(definition as TableRoleDefinition, value);
  const { rowSlots, columns, cells } = grid;
  const size = coordinate.fontSizePt ?? Math.min(9, (position.height / rowSlots) * 0.55);

  for (let rowIndex = 0; rowIndex < rowSlots; rowIndex += 1) {
    for (let columnIndex = 0; columnIndex < columns; columnIndex += 1) {
      const cellResult = cells[rowIndex]?.[columnIndex];
      if (!cellResult || cellResult.role === "fixed") continue;
      const cell = cellResult.value;
      const rect = tableCellRect(definition.tableCellGuides, rowSlots, columns, rowIndex, columnIndex);
      const width = rect.widthRatio * position.width;
      const height = rect.heightRatio * position.height;
      const x = position.x + rect.xRatio * position.width;
      const y = position.y + position.height - (rect.yRatio + rect.heightRatio) * position.height;
      if (typeof definition.detectionSource !== "string") {
        page.drawRectangle({ x, y, width, height, borderColor: rgb(0.6, 0.62, 0.66), borderWidth: 0.4 });
      }
      if (cell) {
        drawPlainText(page, cell, font, { ...coordinate, fontSizePt: size }, { ...position, x: x + 2, y: y + 1, width: Math.max(0, width - 4), height: Math.max(0, height - 2) }, definition);
      }
    }
  }
}


async function drawImageValue(pdf: PDFDocument, page: PDFPage, value: string, position: ReturnType<typeof drawPosition>, loadSource: (assetId: string) => Promise<RenderPageSource>, fit: "contain" | "cover" | "stretch" = "contain") {
  const source = await loadSource(value);
  if (source.mimeType !== "image/png" && source.mimeType !== "image/jpeg") throw new Error("圖片／簽名欄位必須指向 PNG 或 JPG 本機資產。");
  const image = source.mimeType === "image/png" ? await pdf.embedPng(source.bytes) : await pdf.embedJpg(source.bytes);
  const ratio = fit === "cover" ? Math.max(position.width / image.width, position.height / image.height) : Math.min(position.width / image.width, position.height / image.height);
  const width = fit === "stretch" ? position.width : image.width * ratio;
  const height = fit === "stretch" ? position.height : image.height * ratio;
  withFieldClip(page, position, () => {
    page.drawImage(image, { x: position.x + (position.width - width) / 2, y: position.y + (position.height - height) / 2, width, height });
  });
}

function addEditableField(pdf: PDFDocument, page: PDFPage, field: VersionField, value: string, position: ReturnType<typeof drawPosition>, font: PDFFont, optionPositions: Map<string, ReturnType<typeof drawPosition>>) {
  const form = pdf.getForm();
  const name = safePdfFieldName(field.stableFieldId);
  const definition = fieldDefinition(field);
  const options = { x: position.x, y: position.y, width: Math.max(position.width, 8), height: Math.max(position.height, 8), borderWidth: 0, textColor: textColor(definition.color), font };
  if (field.fieldType === "checkbox") {
    const checkboxOptions = knownOptions(definition.options);
    if (checkboxOptions.length && optionPositions.size) {
      // One independently tickable widget per printed square in the row.
      const selected = new Set(selectedCheckboxOptions(value, checkboxOptions));
      checkboxOptions.forEach((option, index) => {
        const box = optionPositions.get(option);
        if (!box) return;
        const checkbox = form.createCheckBox(`${name}_${index}`);
        checkbox.addToPage(page, { x: box.x, y: box.y, width: Math.max(box.width, 8), height: Math.max(box.height, 8), borderWidth: 0 });
        if (selected.has(option)) checkbox.check();
        if (normalizeFieldMark(definition.markStyle) === "circle") {
          checkbox.updateAppearances((_field, widget) => {
            const rect = widget.getRectangle();
            const mark = fieldMarkStrokes("circle", rect.width, rect.height);
            const ring = drawEllipse({
              x: mark.centerX,
              y: rect.height - mark.centerY,
              xScale: mark.outline!.radiusX,
              yScale: mark.outline!.radiusY,
              color: undefined,
              borderColor: textColor(definition.color),
              borderWidth: mark.strokeWidth,
            });
            return { normal: { on: ring, off: [] }, down: { on: ring, off: [] } };
          });
        }
      });
      return;
    }
    const checkbox = form.createCheckBox(name);
    checkbox.addToPage(page, { x: position.x, y: position.y, width: Math.max(position.width, 10), height: Math.max(position.height, 10), borderWidth: 0 });
    if (checkedValue(value, definition.options)) checkbox.check();
    if (normalizeFieldMark(definition.markStyle) === "circle") {
      checkbox.updateAppearances((_field, widget) => {
        const rect = widget.getRectangle();
        const mark = fieldMarkStrokes("circle", rect.width, rect.height);
        const ring = drawEllipse({
          x: mark.centerX,
          y: rect.height - mark.centerY,
          xScale: mark.outline!.radiusX,
          yScale: mark.outline!.radiusY,
          color: undefined,
          borderColor: textColor(definition.color),
          borderWidth: mark.strokeWidth,
        });
        return { normal: { on: ring, off: [] }, down: { on: ring, off: [] } };
      });
    }
    return;
  }
  if (field.fieldType === "select" && knownOptions(definition.options).length) {
    // A dropdown on the form stays a dropdown in the editable PDF. As a plain
    // text field it accepted anything typed into it, including values the
    // Template never offered, which then failed validation on re-import.
    const choices = knownOptions(definition.options);
    const dropdown = form.createDropdown(name);
    dropdown.addOptions(choices);
    // Only glyphs the font is asked to encode reach the embedded subset, and
    // an unanswered dropdown draws none of its options. Registering them here
    // is what puts them in the file, so the list a person opens after the
    // export actually has letters in it.
    font.encodeText(choices.join(""));
    const chosen = normalizeOption(value);
    if (choices.includes(chosen)) dropdown.select(chosen);
    dropdown.addToPage(page, options);
    dropdown.setFontSize(Math.max(4, (field.coordinate as FieldCoordinate).fontSizePt ?? 10));
    dropdown.updateAppearances(font);
    return;
  }
  if (field.fieldType === "radio" && Array.isArray(definition.options)) {
    const group = form.createRadioGroup(name);
    // Normalised the same way as the option marks this looks positions up in,
    // so an option carrying stray whitespace still finds its printed box.
    const choices = knownOptions(definition.options);
    const choiceHeight = position.height / Math.max(1, choices.length);
    choices.forEach((choice, index) => {
      const detected = optionPositions.get(choice);
      group.addOptionToPage(choice, page, detected
        ? { x: detected.x, y: detected.y, width: detected.width, height: detected.height, borderWidth: 0 }
        : { x: position.x, y: position.y + position.height - (index + 1) * choiceHeight, width: Math.min(choiceHeight, 12), height: Math.min(choiceHeight, 12), borderWidth: 0 });
    });
    if (choices.includes(normalizeOption(value))) group.select(normalizeOption(value));
    if (normalizeFieldMark(definition.markStyle) === "circle") {
      // The default PDF radio appearance is a filled dot. For a printed
      // A/B/C/D line the on-state must instead be an unfilled ring around the
      // existing letter, including when the reader changes the choice later.
      group.updateAppearances((_radio, widget) => {
        const rect = widget.getRectangle();
        const mark = fieldMarkStrokes("circle", rect.width, rect.height);
        const ring = drawEllipse({
          x: mark.centerX,
          y: rect.height - mark.centerY,
          xScale: mark.outline!.radiusX,
          yScale: mark.outline!.radiusY,
          color: undefined,
          borderColor: textColor(definition.color),
          borderWidth: mark.strokeWidth,
        });
        return {
          normal: { on: ring, off: [] },
          down: { on: ring, off: [] },
        };
      });
    }
    return;
  }
  const textField = form.createTextField(name);
  textField.addToPage(page, options);
  if (definition.multiline === true || field.fieldType === "textarea") textField.enableMultiline();
  const align = (field.coordinate as FieldCoordinate).align ?? definition.align;
  textField.setAlignment(align === "center" ? TextAlignment.Center : align === "right" ? TextAlignment.Right : TextAlignment.Left);
  textField.setFontSize(Math.max(4, (field.coordinate as FieldCoordinate).fontSizePt ?? 10));
  textField.setText(value);
  textField.updateAppearances(font);
}

async function createPdfPages(mode: PdfOutputMode, pages: PageManifestItem[], loadSource: (assetId: string) => Promise<RenderPageSource>) {
  if (!Array.isArray(pages) || pages.length === 0) throw new Error("Template Version 缺少頁面 manifest。");
  if (mode === "full" || mode === "editable") {
    const firstAssetId = pages[0]?.assetId;
    if (!firstAssetId) throw new Error("完整背景輸出缺少第一頁來源資產。");
    const firstSource = await loadSource(firstAssetId);
    if (firstSource.mimeType === "application/pdf") {
      const pdf = await PDFDocument.load(firstSource.bytes);
      if (pdf.getPageCount() < pages.length) throw new Error("PDF 來源頁數少於 Template Version 的頁面 manifest。");
      return pdf;
    }
    if (firstSource.mimeType === "image/png" || firstSource.mimeType === "image/jpeg") {
      const pdf = await PDFDocument.create();
      for (const pageManifest of pages) {
        if (!pageManifest.assetId) throw new Error(`完整背景輸出缺少第 ${pageManifest.page} 頁來源資產。`);
        const source = await loadSource(pageManifest.assetId);
        if (source.mimeType !== "image/png" && source.mimeType !== "image/jpeg") throw new Error("影像背景 Template 的每一頁都必須是 PNG 或 JPG 資產。");
        const page = pdf.addPage([mmToPoint(pageManifest.widthMm ?? 210), mmToPoint(pageManifest.heightMm ?? 297)]);
        const image = source.mimeType === "image/png" ? await pdf.embedPng(source.bytes) : await pdf.embedJpg(source.bytes);
        const ratio = Math.min(page.getWidth() / image.width, page.getHeight() / image.height);
        const width = image.width * ratio;
        const height = image.height * ratio;
        page.drawImage(image, { x: (page.getWidth() - width) / 2, y: (page.getHeight() - height) / 2, width, height });
      }
      return pdf;
    }
    throw new Error("來源資產格式不支援完整背景輸出。");
  }
  const pdf = await PDFDocument.create();
  for (const page of pages) pdf.addPage([mmToPoint(page.widthMm ?? 210), mmToPoint(page.heightMm ?? 297)]);
  return pdf;
}

export async function renderVersionPdf(input: {
  mode: PdfOutputMode;
  pages: PageManifestItem[];
  fields: VersionField[];
  values: Record<string, string>;
  printSettings?: { xOffsetMm?: number; yOffsetMm?: number; xScale?: number; yScale?: number };
  loadSource: (assetId: string) => Promise<RenderPageSource>;
}) {
  const { mode, pages, fields: versionFields, values, printSettings = {}, loadSource } = input;
  const scaleX = (printSettings.xScale ?? 100) / 100;
  const scaleY = (printSettings.yScale ?? 100) / 100;
  const offsetX = printSettings.xOffsetMm ?? 0;
  const offsetY = printSettings.yOffsetMm ?? 0;
  const pdf = await createPdfPages(mode, pages, loadSource);
  const fonts = await embedOutputFonts(pdf, [
    ...Object.values(values),
    // Options travel into the file whether or not they are the current answer.
    ...versionFields.flatMap((field: VersionField) =>
      optionBearingFieldTypes.has(String(field.fieldType))
        ? knownOptions(fieldDefinition(field).options)
        : [],
    ),
  ]);
  const pdfPages = pdf.getPages();
  const orderedFields = versionFields.map((field, index) => ({ field, index })).sort((left, right) => {
    const leftPage = Number((left.field.coordinate as FieldCoordinate).page) || 1;
    const rightPage = Number((right.field.coordinate as FieldCoordinate).page) || 1;
    if (leftPage !== rightPage) return leftPage - rightPage;
    const leftZ = Number(fieldDefinition(left.field).zIndex);
    const rightZ = Number(fieldDefinition(right.field).zIndex);
    const safeLeftZ = Number.isFinite(leftZ) ? leftZ : left.index + 1;
    const safeRightZ = Number.isFinite(rightZ) ? rightZ : right.index + 1;
    return safeLeftZ - safeRightZ || left.index - right.index;
  });
  for (const { field } of orderedFields) {
    const rawValue = values[field.stableFieldId] ?? "";
    const definition = fieldDefinition(field);
    const value = formatOutputValue(rawValue, field.fieldType, definition);
    const editableOverlay = mode === "editable" && (field.fieldType === "table" || field.fieldType === "image" || field.fieldType === "signature");
    if (!value && (mode !== "editable" || editableOverlay)) continue;
    const coordinate = field.coordinate as FieldCoordinate;
    const pageIndex = Math.max(0, (coordinate.page ?? 1) - 1);
    const page = pdfPages[pageIndex];
    if (!page) throw new Error(`欄位 ${field.stableFieldId} 指向不存在的頁面。`);
    const position = drawPosition(page.getWidth(), page.getHeight(), coordinate, scaleX, scaleY, offsetX, offsetY);
    const detectedPositions = definitionBoxes(definition.detectionGroup).map((box) =>
      drawPosition(page.getWidth(), page.getHeight(), {
        page: coordinate.page,
        xMm: (coordinate.xMm ?? 0) + box.xRatio * (coordinate.widthMm ?? 0),
        yMm: (coordinate.yMm ?? 0) + box.yRatio * (coordinate.heightMm ?? 0),
        widthMm: box.widthRatio * (coordinate.widthMm ?? 0),
        heightMm: box.heightRatio * (coordinate.heightMm ?? 0),
      }, scaleX, scaleY, offsetX, offsetY)
    );
    const optionPositions = new Map(
      definitionOptionMarks(definition.optionMarks).map((mark) => [
        normalizeOption(mark.option),
        drawPosition(page.getWidth(), page.getHeight(), {
          page: coordinate.page,
          xMm: (coordinate.xMm ?? 0) + mark.xRatio * (coordinate.widthMm ?? 0),
          yMm: (coordinate.yMm ?? 0) + mark.yRatio * (coordinate.heightMm ?? 0),
          widthMm: mark.widthRatio * (coordinate.widthMm ?? 0),
          heightMm: mark.heightRatio * (coordinate.heightMm ?? 0),
        }, scaleX, scaleY, offsetX, offsetY),
      ])
    );
    // A dropdown or an option row carries its choices into the file and a
    // person picks one after the export, so the font has to cover the options
    // and not only whatever is answered right now.
    const fontText = optionBearingFieldTypes.has(String(field.fieldType))
      ? [value, ...knownOptions(definition.options)].join("")
      : field.fieldType === "signature" && value.startsWith("text:")
        ? value.slice(5)
        : value;
    const font = outputFont(fonts, fontText, definition);
    if (mode === "editable" && !editableOverlay) {
      addEditableField(pdf, page, field, value, position, font, optionPositions);
      continue;
    }
    if (field.fieldType === "signature" && value.startsWith("text:")) drawPlainText(page, value.slice(5), font, coordinate, position, { ...definition, italic: true });
    else if (field.fieldType === "image" || field.fieldType === "signature") await drawImageValue(pdf, page, value, position, loadSource, definition.imageFit === "cover" || definition.imageFit === "stretch" ? definition.imageFit : "contain");
    else if (field.fieldType === "checkbox") {
      // A checkbox covering a printed row marks each ticked option in its own
      // box; a lone square keeps the single centred mark.
      const checkboxOptions = knownOptions(definition.options);
      if (checkboxOptions.length && optionPositions.size)
        for (const option of selectedCheckboxOptions(value, checkboxOptions)) {
          const box = optionPositions.get(option);
          if (box) drawFieldMark(page, definition.markStyle, box, textColor(definition.color));
        }
      else if (checkedValue(value, definition.options)) drawFieldMark(page, definition.markStyle, position, textColor(definition.color));
    } else if (field.fieldType === "radio") {
      // Prefer the option box detected on the source form; otherwise fall back
      // to a slot of the field box so a chosen option is never left unmarked.
      const detected = optionPositions.get(normalizeOption(value));
      const choices = knownOptions(definition.options);
      const index = choices.indexOf(normalizeOption(value));
      if (detected) drawFieldMark(page, definition.markStyle, detected, textColor(definition.color));
      else if (index >= 0) drawFieldMark(page, definition.markStyle, radioSlot(position, index, choices.length), textColor(definition.color));
    } else if (field.fieldType === "select") {
      // The same normalisation the fill control and the editable PDF use, so
      // one stored value cannot print differently in the three of them.
      const choices = knownOptions(definition.options);
      drawPlainText(page, choices.length ? selectedSingleOption(value, choices) : value, font, coordinate, position, definition);
    } else if (field.fieldType === "characterBox") drawCharacterBoxes(page, value, font, coordinate, position, definition, detectedPositions);
    else if (field.fieldType === "table") drawTable(page, value, font, position, coordinate, definition);
    else drawPlainText(page, value, font, coordinate, position, definition);
  }
  return pdf.save();
}

export async function renderInstancePdf(ownerId: string | number, instanceId: string, mode: PdfOutputMode) {
  const { instance, template, version, fields: versionFields } = await getInstanceForOwner(ownerId, instanceId);
  const validationIssues = validateFieldValues(instance.values, versionFields);
  if (validationIssues.some((issue) => issue.blocking)) throw new Error(`Instance 尚有 ${validationIssues.filter((issue) => issue.blocking).length} 項驗證錯誤，修正後才可預覽、列印或匯出。`);
  const pages = (version.pageManifest as PageManifestItem[]) || [];
  const printSettings = { ...((version.printSettings ?? {}) as Record<string, unknown>), ...(template.printProfile ?? {}) } as { xOffsetMm?: number; yOffsetMm?: number; xScale?: number; yScale?: number };
  const bytes = await renderVersionPdf({ mode, pages, fields: versionFields, values: instance.values, printSettings, loadSource: async (assetId) => {
    const source = await getOwnedAssetBytes(ownerId, assetId);
    return { mimeType: source.asset.mimeType, bytes: source.bytes };
  } });
  const stored = await storeOwnedAsset(ownerId, { bytes, kind: "export", mimeType: "application/pdf", originalFilename: `${instance.name.replace(/[\\/:*?"<>|]/g, "_")}-${mode}.pdf`, instanceId: instance.id, templateVersionId: version.id, metadata: { instanceId: instance.id, templateVersionHash: instance.templateVersionHash, mode, printSettings } });
  await recordInstanceOutput(ownerId, instance.id, { assetId: stored.asset.id, mode, createdAt: Date.now(), templateVersionHash: instance.templateVersionHash }, false);
  return { assetId: stored.asset.id, url: stored.url, mode, instanceId: instance.id, templateVersionHash: instance.templateVersionHash };
}
