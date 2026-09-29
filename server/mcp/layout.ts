import { z } from "zod";
import { addTool } from "./catalog";
import { callService, owner } from "./service";
import { writeMeta } from "./schema";
import { updateDraftTemplateFields } from "../formdigital/repository";
import {
  getOwnedAssetBytes,
  storeOwnedAsset,
  deleteOwnedAsset,
} from "../formdigital/assetStore";
import { PDFDocument } from "pdf-lib";

const target = (a: any) => [
  { collection: "templateVersions", id: a.versionId },
];
const drafts = (fields: any[]) =>
  fields.map(f => ({
    stableFieldId: f.stableFieldId,
    fieldType: f.fieldType,
    displayOrder: f.displayOrder,
    definition: f.definition,
    coordinate: f.coordinate,
  }));
function bounds(fields: any[], pages: any[]) {
  for (const f of fields) {
    const c = f.coordinate,
      p = pages.find(p => p.page === c.page);
    if (
      !p ||
      c.xMm < 0 ||
      c.yMm < 0 ||
      c.xMm + c.widthMm > p.widthMm ||
      c.yMm + c.heightMm > p.heightMm
    )
      throw new Error(`FIELD_OUTSIDE_PAGE: ${f.stableFieldId}`);
  }
}
addTool({
  name: "draft_layout",
  description:
    "Move, align or distribute chosen fields on one page. Uses millimetres and preserves rules and values. Requires current version revision.",
  permission: "write",
  targets: target,
  schema: z.object({
    versionId: z.string().min(1),
    fieldIds: z.array(z.string().min(1)).min(1).max(5000),
    action: z.enum([
      "move",
      "left",
      "right",
      "center",
      "top",
      "bottom",
      "middle",
      "distribute-horizontal",
      "distribute-vertical",
    ]),
    dxMm: z.number().default(0),
    dyMm: z.number().default(0),
    ...writeMeta,
  }),
  run: async a => {
    const detail = await callService("templates.getVersionDetails", {
        versionId: a.versionId,
      }),
      fields = drafts(detail.fields),
      selected = fields.filter(f => a.fieldIds.includes(f.stableFieldId));
    if (
      selected.length !== new Set(a.fieldIds).size ||
      new Set(selected.map(f => f.coordinate.page)).size !== 1
    )
      throw new Error("SELECT_FIELDS_ON_ONE_PAGE");
    const left = Math.min(...selected.map(f => f.coordinate.xMm)),
      right = Math.max(
        ...selected.map(f => f.coordinate.xMm + f.coordinate.widthMm)
      ),
      top = Math.min(...selected.map(f => f.coordinate.yMm)),
      bottom = Math.max(
        ...selected.map(f => f.coordinate.yMm + f.coordinate.heightMm)
      );
    for (const f of selected) {
      const c = f.coordinate;
      switch (a.action) {
        case "move":
          c.xMm += a.dxMm;
          c.yMm += a.dyMm;
          break;
        case "left":
          c.xMm = left;
          break;
        case "right":
          c.xMm = right - c.widthMm;
          break;
        case "center":
          c.xMm = (left + right - c.widthMm) / 2;
          break;
        case "top":
          c.yMm = top;
          break;
        case "bottom":
          c.yMm = bottom - c.heightMm;
          break;
        case "middle":
          c.yMm = (top + bottom - c.heightMm) / 2;
      }
    }
    if (a.action.startsWith("distribute")) {
      if (selected.length < 3) throw new Error("SELECT_AT_LEAST_THREE_FIELDS");
      const horizontal = a.action.endsWith("horizontal"),
        position = horizontal ? "xMm" : "yMm",
        size = horizontal ? "widthMm" : "heightMm";
      selected.sort((x, y) => x.coordinate[position] - y.coordinate[position]);
      const first = selected[0].coordinate[position],
        last = selected[selected.length - 1].coordinate;
      const gap =
        (last[position] +
          last[size] -
          first -
          selected.reduce((s, f) => s + f.coordinate[size], 0)) /
        (selected.length - 1);
      if (gap < 0) throw new Error("NOT_ENOUGH_SPACE_TO_DISTRIBUTE");
      let cursor = first;
      for (const f of selected) {
        f.coordinate[position] = cursor;
        cursor += f.coordinate[size] + gap;
      }
    }
    bounds(fields, detail.version.pageManifest);
    return updateDraftTemplateFields(owner, a.versionId, { fields });
  },
});
addTool({
  name: "draft_pages",
  description:
    "Reorder, duplicate or remove draft pages atomically with their fields. pageOrder lists existing page numbers in the desired order; a repeated page duplicates its fields with new stable IDs. Requires local approval because omitted pages are removed.",
  permission: "write",
  dangerous: true,
  targets: target,
  schema: z.object({
    versionId: z.string().min(1),
    pageOrder: z.array(z.number().int().positive()).min(1).max(50),
    ...writeMeta,
  }),
  run: async a => {
    const detail = await callService("templates.getVersionDetails", {
        versionId: a.versionId,
      }),
      fields: any[] = [],
      pages: any[] = [],
      seen = new Set<number>();
    const background = await PDFDocument.create();
    for (const [i, oldPage] of Array.from(a.pageOrder.entries()) as [
      number,
      number,
    ][]) {
      const p = detail.version.pageManifest.find(
        (p: any) => p.page === oldPage
      );
      if (!p) throw new Error("PAGE_NOT_FOUND");
      const original = await getOwnedAssetBytes(owner, p.assetId);
      if (original.asset.mimeType === "application/pdf") {
        const source = await PDFDocument.load(original.bytes),
          copied = await background.copyPages(source, [oldPage - 1]);
        background.addPage(copied[0]);
      } else {
        const image =
          original.asset.mimeType === "image/png"
            ? await background.embedPng(original.bytes)
            : await background.embedJpg(original.bytes);
        const page = background.addPage([
          (p.widthMm * 72) / 25.4,
          (p.heightMm * 72) / 25.4,
        ]);
        page.drawImage(image, {
          x: 0,
          y: 0,
          width: page.getWidth(),
          height: page.getHeight(),
        });
      }
      pages.push({ ...p, page: i + 1 });
      for (const f of drafts(detail.fields).filter(
        f => f.coordinate.page === oldPage
      ))
        fields.push({
          ...f,
          stableFieldId: seen.has(oldPage)
            ? `${f.stableFieldId.slice(0, 100)}-page-${i + 1}`
            : f.stableFieldId,
          displayOrder: fields.length,
          coordinate: { ...f.coordinate, page: i + 1 },
        });
      seen.add(oldPage);
    }
    if (new Set(fields.map(f => f.stableFieldId)).size !== fields.length)
      throw new Error("DUPLICATE_FIELD_ID");
    const stored = await storeOwnedAsset(owner, {
      bytes: await background.save(),
      kind: "source",
      mimeType: "application/pdf",
      originalFilename: "reordered-pages.pdf",
    });
    try {
      return await updateDraftTemplateFields(owner, a.versionId, {
        fields,
        pageManifest: pages.map(p => ({
          ...p,
          assetId: stored.asset.id,
          mimeType: "application/pdf",
        })),
      });
    } catch (e) {
      if (!stored.deduplicated) await deleteOwnedAsset(owner, stored.asset.id);
      throw e;
    }
  },
});
addTool({
  name: "instances_search",
  description:
    "Search one bounded page of instances by name/status/template without returning form values. Continue using nextCursor.",
  permission: "read",
  schema: z.object({
    query: z.string().max(200).default(""),
    status: z.enum(["draft", "completed", "printed"]).optional(),
    templateId: z.string().optional(),
    cursor: z.string().nullable().default(null),
    limit: z.number().int().min(1).max(100).default(50),
  }),
  run: async a => {
    const result = await callService("instances.listPage", {
      cursor: a.cursor,
      limit: a.limit,
    });
    const rows = result.items ?? result.instances ?? [];
    return {
      ...result,
      items: rows
        .filter(
          (r: any) =>
            (!a.query ||
              r.name.toLowerCase().includes(a.query.toLowerCase())) &&
            (!a.status || r.status === a.status) &&
            (!a.templateId || r.templateId === a.templateId)
        )
        .map(({ values, outputHistory, ...r }: any) => r),
      instances: undefined,
    };
  },
});
