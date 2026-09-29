import { PDFDocument, rgb } from "pdf-lib";
import { embedOutputFonts } from "../formdigital/pdfRenderer";
import { storeOwnedAsset, deleteOwnedAsset } from "../formdigital/assetStore";
import { validateTemplateFields } from "../../shared/fieldValidation";
import { designSchema } from "./schema";
import { callService, owner } from "./service";

const pt = (mm: number) => (mm * 72) / 25.4;
export async function createDesign(raw: unknown) {
  const input = designSchema.parse(raw);
  const ids = new Set<string>();
  for (const f of input.fields) {
    if (ids.has(f.stableFieldId)) throw new Error("DUPLICATE_FIELD_ID");
    ids.add(f.stableFieldId);
    const page = input.pages[f.coordinate.page - 1],
      c = f.coordinate;
    if (
      !page ||
      c.xMm + c.widthMm > page.widthMm ||
      c.yMm + c.heightMm > page.heightMm
    )
      throw new Error(`FIELD_OUTSIDE_PAGE: ${f.stableFieldId}`);
  }
  const issues = validateTemplateFields(input.fields);
  if (issues.some(i => i.blocking))
    throw new Error(`INVALID_FIELDS: ${JSON.stringify(issues)}`);
  const warnings: string[] = [];
  for (let i = 0; i < input.fields.length; i++)
    for (let j = i + 1; j < input.fields.length; j++) {
      const a = input.fields[i].coordinate,
        b = input.fields[j].coordinate;
      if (
        a.page === b.page &&
        a.xMm < b.xMm + b.widthMm &&
        b.xMm < a.xMm + a.widthMm &&
        a.yMm < b.yMm + b.heightMm &&
        b.yMm < a.yMm + a.heightMm
      )
        warnings.push(
          `OVERLAP: ${input.fields[i].stableFieldId}, ${input.fields[j].stableFieldId}`
        );
    }
  const pdf = await PDFDocument.create();
  const texts = input.pages
    .flatMap(p => [p.title, ...p.texts.map(t => t.text)])
    .concat(
      input.fields.flatMap(f => [
        f.definition.label,
        ...(f.definition.options ?? []),
      ])
    );
  const fonts = await embedOutputFonts(pdf, texts);
  const font = fonts.cjk ?? fonts.sans.regular;
  for (const [index, spec] of Array.from(input.pages.entries())) {
    const p = pdf.addPage([pt(spec.widthMm), pt(spec.heightMm)]);
    const draw = (text: string, x: number, y: number, size: number) => {
      if (!text) return;
      if (
        x < 0 ||
        y < 0 ||
        x + font.widthOfTextAtSize(text, size) / pt(1) > spec.widthMm ||
        y + size / pt(1) > spec.heightMm
      )
        throw new Error(`TEXT_OUTSIDE_PAGE: ${index + 1}`);
      p.drawText(text, {
        x: pt(x),
        y: pt(spec.heightMm - y) - size,
        font,
        size,
        color: rgb(0.08, 0.19, 0.27),
      });
    };
    draw(spec.title, 12, 10, 17);
    for (const t of spec.texts) draw(t.text, t.xMm, t.yMm, t.fontSizePt);
    for (const f of input.fields.filter(f => f.coordinate.page === index + 1)) {
      const c = f.coordinate,
        d = f.definition;
      draw(d.label, c.xMm, Math.max(0, c.yMm - 5), 9);
      p.drawRectangle({
        x: pt(c.xMm),
        y: pt(spec.heightMm - c.yMm - c.heightMm),
        width: pt(c.widthMm),
        height: pt(c.heightMm),
        borderWidth: 0.5,
        borderColor: rgb(0.5, 0.6, 0.65),
      });
      if (["radio", "checkbox"].includes(f.fieldType) && d.options?.length) {
        const count = d.options.length;
        if (!d.optionMarks?.length)
          d.optionMarks = d.options.map((option, i) => {
            const width = Math.min(
              (c.widthMm / count) * 0.9,
              Math.max(6, font.widthOfTextAtSize(option, 10) / pt(1) + 4)
            );
            const height = Math.min(c.heightMm * 0.8, 8);
            return {
              option,
              xRatio: (((i + 0.5) * c.widthMm) / count - width / 2) / c.widthMm,
              yRatio: (c.heightMm - height) / 2 / c.heightMm,
              widthRatio: width / c.widthMm,
              heightRatio: height / c.heightMm,
            };
          });
        for (const mark of d.optionMarks) {
          const width = font.widthOfTextAtSize(mark.option, 10) / pt(1);
          if (width > c.widthMm * mark.widthRatio)
            throw new Error("OPTION_LABEL_TOO_WIDE");
          draw(
            mark.option,
            c.xMm + c.widthMm * (mark.xRatio + mark.widthRatio / 2) - width / 2,
            c.yMm +
              c.heightMm * (mark.yRatio + mark.heightRatio / 2) -
              10 / pt(1) / 2,
            10
          );
        }
      }
      if (f.fieldType === "table" || f.fieldType === "characterBox") {
        const columns =
            f.fieldType === "table" ? (d.tableColumns ?? 3) : (d.boxCount ?? 8),
          rows = f.fieldType === "table" ? (d.maxRows ?? 3) : 1;
        for (let col = 1; col < columns; col++)
          p.drawLine({
            start: {
              x: pt(c.xMm + (c.widthMm * col) / columns),
              y: pt(spec.heightMm - c.yMm),
            },
            end: {
              x: pt(c.xMm + (c.widthMm * col) / columns),
              y: pt(spec.heightMm - c.yMm - c.heightMm),
            },
            thickness: 0.4,
            color: rgb(0.6, 0.6, 0.6),
          });
        for (let row = 1; row < rows; row++)
          p.drawLine({
            start: {
              x: pt(c.xMm),
              y: pt(spec.heightMm - c.yMm - (c.heightMm * row) / rows),
            },
            end: {
              x: pt(c.xMm + c.widthMm),
              y: pt(spec.heightMm - c.yMm - (c.heightMm * row) / rows),
            },
            thickness: 0.4,
            color: rgb(0.6, 0.6, 0.6),
          });
      }
    }
  }
  const stored = await storeOwnedAsset(owner, {
    bytes: await pdf.save(),
    kind: "source",
    mimeType: "application/pdf",
    originalFilename: `${input.name}.pdf`,
  });
  try {
    const draft = await callService("templates.createDraft", {
      name: input.name,
      pageManifest: input.pages.map((p, i) => ({
        page: i + 1,
        widthMm: p.widthMm,
        heightMm: p.heightMm,
        rotation: 0,
        assetId: stored.asset.id,
        mimeType: "application/pdf",
      })),
      fields: input.fields,
      printSettings: {
        paper: "A4",
        xScale: 100,
        yScale: 100,
        xOffsetMm: 0,
        yOffsetMm: 0,
      },
    });
    return {
      ...draft,
      warnings,
      backgroundAssetId: stored.asset.id,
      review: "AI-created draft; inspect page previews before publishing.",
    };
  } catch (error) {
    if (!stored.deduplicated) await deleteOwnedAsset(owner, stored.asset.id);
    throw error;
  }
}
