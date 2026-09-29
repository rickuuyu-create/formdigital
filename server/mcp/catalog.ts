import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { callService, owner, serviceSchema, withRevisions } from "./service";
import { fieldSchema, fieldTypes, writeMeta, designSchema } from "./schema";
import { governed } from "./governance";
import {
  allowedFile,
  changeState,
  readState,
  requireClient,
  type Permission,
} from "./state";
import { editContext, recordHash } from "../formdigital/editGuard";
import { readWorkspace } from "../formdigital/workspaceStore";
import { getOwnedAssetBytes, storeOwnedAsset } from "../formdigital/assetStore";
import {
  validateFieldValues,
  validateTemplateFields,
} from "../../shared/fieldValidation";
import { createDesign } from "./design";

export type ToolContext = { clientId: string; origin: string };
type Entry = {
  name: string;
  description: string;
  schema: z.ZodType;
  permission: Permission;
  dangerous?: boolean | ((args: any) => boolean);
  targets?: (args: any) => Array<{ collection: string; id: string }>;
  run: (args: any, ctx: ToolContext) => Promise<any>;
};
export const catalog: Entry[] = [];
export function addTool(entry: Entry) {
  catalog.push(entry);
}
const nameSchema = z.string().min(1).max(128);
const id = nameSchema;
const target = (collection: string, key: string) => (a: any) =>
  a[key] ? [{ collection, id: a[key] }] : [];
const many = (collection: string, key: string) => (a: any) =>
  (a[key] ?? []).map((id: string) => ({ collection, id }));
const services: Array<
  [string, string, Permission, Entry["targets"]?, Entry["dangerous"]?]
> = [
  [
    "collections",
    "Read folders, tags, saved values and mapping templates.",
    "read",
  ],
  [
    "templates.versions",
    "List versions. Each record includes revision hash.",
    "read",
  ],
  [
    "templates.getVersionDetails",
    "Read page manifest and all field definitions for a version.",
    "read",
  ],
  [
    "templates.cloneToDraft",
    "Copy a published version into its next editable draft.",
    "write",
    target("templateVersions", "versionId"),
  ],
  [
    "templates.publish",
    "Publish a reviewed draft. Published versions remain immutable.",
    "write",
    target("templateVersions", "versionId"),
  ],
  [
    "templates.updateMetadata",
    "Patch name, description, favorites, folders, tags and key fields.",
    "write",
    target("templates", "templateId"),
  ],
  [
    "templates.savePrintProfile",
    "Save printer offsets and scale. Does not print.",
    "write",
    target("templates", "templateId"),
  ],
  [
    "templates.delete",
    "Delete a template and related records. Requires approval in Settings.",
    "manage",
    target("templates", "templateId"),
    true,
  ],
  [
    "instances.get",
    "Read an instance, its revision, bound version and rules.",
    "read",
  ],
  [
    "instances.listPage",
    "Page through filled instances. Cursor is opaque.",
    "read",
  ],
  [
    "instances.create",
    "Create a filled instance from a published version. Values use stable field IDs; encode tables as JSON strings and multiple choices as newline-separated options.",
    "write",
  ],
  [
    "instances.clone",
    "Copy an instance, optionally clearing signature and image values.",
    "write",
  ],
  [
    "instances.setStatus",
    "Set draft/completed. Printed status requires local user approval; PDF generation is not proof of printing.",
    "write",
    target("instances", "instanceId"),
    (a: any) => a.status === "printed",
  ],
  [
    "instances.delete",
    "Delete selected instances after approval. Create a backup first.",
    "manage",
    many("instances", "instanceIds"),
    true,
  ],
  [
    "instances.migrateVersion",
    "Migrate by explicit field mapping. Review mapping and data loss first.",
    "manage",
    many("instances", "instanceIds"),
    true,
  ],
  [
    "assets.getUrl",
    "Get metadata and local viewing URL for an owned asset.",
    "read",
  ],
  [
    "assets.delete",
    "Delete an asset after local approval.",
    "manage",
    undefined,
    true,
  ],
  [
    "folders.upsert",
    "Create or rename a folder.",
    "write",
    target("folders", "id"),
  ],
  [
    "folders.delete",
    "Remove a folder after approval.",
    "manage",
    target("folders", "folderId"),
    true,
  ],
  ["tags.upsert", "Create or change a tag.", "write", target("tags", "id")],
  [
    "tags.delete",
    "Remove a tag after approval.",
    "manage",
    target("tags", "tagId"),
    true,
  ],
  ["savedValues.add", "Add a commonly used field value.", "write"],
  [
    "savedValues.use",
    "Record use of a saved value.",
    "write",
    target("savedValues", "savedValueId"),
  ],
  [
    "savedValues.delete",
    "Delete a saved value after approval.",
    "manage",
    target("savedValues", "savedValueId"),
    true,
  ],
  [
    "mappingTemplates.upsert",
    "Save CSV field mapping.",
    "write",
    target("mappingTemplates", "id"),
  ],
  [
    "mappingTemplates.delete",
    "Remove saved mapping after approval.",
    "manage",
    target("mappingTemplates", "mappingTemplateId"),
    true,
  ],
  [
    "imports.preview",
    "Read CSV columns and sample rows from an imported CSV asset.",
    "read",
  ],
  [
    "imports.analyze",
    "Preview CSV mapping, validation and duplicates without filling forms.",
    "read",
  ],
  [
    "imports.create",
    "Apply reviewed CSV mapping and row corrections. Bulk overwrites require approval.",
    "write",
    undefined,
    (a: any) =>
      a.duplicateDecisions?.some((d: any) => d.action === "overwrite") ?? false,
  ],
  [
    "imports.resume",
    "Resume an existing persistent CSV import. Never create another run for a retry.",
    "write",
  ],
  [
    "exports.pdf",
    "Generate full background, overlay, or editable PDF. Does not mark user review or printing complete.",
    "export",
  ],
  [
    "exports.batchPdf",
    "Generate batch PDF with copies, selected pages and separators.",
    "export",
  ],
  [
    "exports.structured",
    "Export filled data as JSON or CSV, preserving leading zeros.",
    "export",
  ],
  ["exports.calibrationTest", "Generate a printer calibration PDF.", "export"],
  [
    "backups.createStream",
    "Create and verify a streaming account backup.",
    "manage",
  ],
  ["localData.integrity", "Scan data integrity without repairing.", "manage"],
  [
    "localData.repair",
    "Repair data after inspecting integrity results and approving locally.",
    "manage",
    undefined,
    true,
  ],
];
for (const [service, description, permission, targets, dangerous] of services) {
  const input = serviceSchema(service) ?? z.object({});
  addTool({
    name: service.replaceAll(".", "_"),
    description,
    permission,
    targets,
    dangerous,
    schema:
      permission === "read"
        ? z.object({ input: input.optional() })
        : z.object({ input: input.optional(), ...writeMeta }),
    run: a => callService(service, a.input),
  });
  // Targets/danger checks operate on the service input, not the metadata envelope.
  const entry = catalog[catalog.length - 1];
  if (targets) entry.targets = a => targets(a.input ?? {});
  if (typeof dangerous === "function")
    entry.dangerous = a => dangerous(a.input ?? {});
  if (service === "instances.create") {
    entry.schema = z.object({
      input,
      timeZone: z.string().max(100).optional(),
      ...writeMeta,
    });
    entry.description +=
      " Omitted values use fixed/dynamic defaults; specify timeZone for today/now, otherwise the local OS zone is used.";
    entry.run = async a => {
      const detail = await callService("templates.getVersionDetails", {
        versionId: a.input.templateVersionId,
      });
      const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: a.timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
      const parts = Object.fromEntries(
        formatter.formatToParts(new Date()).map(p => [p.type, p.value])
      );
      const values: Record<string, string> = {};
      for (const field of detail.fields) {
        const d = field.definition ?? {};
        values[field.stableFieldId] =
          d.dynamicDefault === "today"
            ? `${parts.year}-${parts.month}-${parts.day}`
            : d.dynamicDefault === "now"
              ? `${parts.hour}:${parts.minute}`
              : (d.defaultValue ?? "");
      }
      for (const key of Object.keys(a.input.values))
        if (!detail.fields.some((f: any) => f.stableFieldId === key))
          throw new Error(`UNKNOWN_FIELD: ${key}`);
      return callService(service, {
        ...a.input,
        values: { ...values, ...a.input.values },
      });
    };
  }
}

addTool({
  name: "system_status",
  description: "MCP status, compatibility, fields and workflow limits.",
  permission: "read",
  schema: z.object({}),
  run: async (_, ctx) => ({
    version: "2026.09.30.1",
    enabled: true,
    localOnly: true,
    googleLogin: false,
    clientId: ctx.clientId,
    fieldTypes,
    transports: ["stdio", "streamable-http"],
    links: {
      settings: `${ctx.origin}/?view=settings`,
      library: `${ctx.origin}/?view=library`,
    },
    limits: {
      physicalPrinting:
        "Use the website print dialog; generating a PDF does not prove printing.",
      humanReview: "Only the user can confirm output review in the website.",
      camera: "Open the website and let the user take a picture.",
      formula: "Bounded arithmetic and SUM; not full Excel.",
    },
  }),
});
addTool({
  name: "templates_search",
  description: "Search templates without returning all fields or filled data.",
  permission: "read",
  schema: z.object({
    query: z.string().max(200).default(""),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(30),
  }),
  run: async a => {
    const rows = await callService("templates.search", { query: a.query });
    return {
      total: rows.length,
      items: rows.slice(a.offset, a.offset + a.limit),
    };
  },
});
addTool({
  name: "form_design_create",
  description:
    "Create a multi-page blank form with fixed labels, text, borders and all 12 field types. Coordinates are millimetres from page top-left; layout bounds are checked. Review the draft before publishing.",
  permission: "write",
  schema: designSchema.extend(writeMeta),
  run: createDesign,
});
addTool({
  name: "draft_patch",
  description:
    "Add/replace fields by stable ID and remove only explicitly named fields; omitted fields are retained. Supply the templateVersions revision read by templates_getVersionDetails. Each upsert contains a complete field definition.",
  permission: "write",
  targets: target("templateVersions", "versionId"),
  schema: z.object({
    versionId: id,
    upsert: z.array(fieldSchema).max(5000).default([]),
    remove: z.array(id).max(5000).default([]),
    ...writeMeta,
  }),
  run: async a => {
    const detail = await callService("templates.getVersionDetails", {
      versionId: a.versionId,
    });
    const fields = new Map<string, any>(
      detail.fields.map((f: any) => [
        f.stableFieldId,
        {
          stableFieldId: f.stableFieldId,
          fieldType: f.fieldType,
          displayOrder: f.displayOrder,
          definition: f.definition,
          coordinate: f.coordinate,
        },
      ])
    );
    for (const id of a.remove) {
      if (!fields.has(id)) throw new Error(`UNKNOWN_FIELD: ${id}`);
      fields.delete(id);
    }
    for (const f of a.upsert) fields.set(f.stableFieldId, f);
    for (const f of Array.from(fields.values())) {
      const p = detail.version.pageManifest.find(
        (p: any) => p.page === f.coordinate.page
      );
      if (
        !p ||
        f.coordinate.xMm + f.coordinate.widthMm > p.widthMm ||
        f.coordinate.yMm + f.coordinate.heightMm > p.heightMm
      )
        throw new Error(`FIELD_OUTSIDE_PAGE: ${f.stableFieldId}`);
    }
    const next = Array.from(fields.values());
    const issues = validateTemplateFields(next);
    if (issues.some(i => i.blocking))
      throw new Error(`INVALID_FIELDS: ${JSON.stringify(issues)}`);
    const result = await callService("templates.saveDraftFields", {
      versionId: a.versionId,
      fields: next,
    });
    return { ...result, issues };
  },
});
addTool({
  name: "instance_patch",
  description:
    "Patch only named values; omitted values remain unchanged. Use empty string to clear. Requires current instance revision. Never fabricate a signature.",
  permission: "write",
  targets: target("instances", "instanceId"),
  schema: z.object({
    instanceId: id,
    values: z.record(z.string(), z.string().max(10000)),
    ...writeMeta,
  }),
  run: async a => {
    const detail = await callService("instances.get", {
      instanceId: a.instanceId,
    });
    for (const key of Object.keys(a.values))
      if (!detail.fields.some((f: any) => f.stableFieldId === key))
        throw new Error(`UNKNOWN_FIELD: ${key}`);
    const values = { ...detail.instance.values, ...a.values };
    return callService("instances.saveValues", {
      instanceId: a.instanceId,
      values,
    });
  },
});
addTool({
  name: "template_validate",
  description: "Check template field rules without publishing.",
  permission: "read",
  schema: z.object({ versionId: id }),
  run: async a => {
    const d = await callService("templates.getVersionDetails", a);
    return {
      issues: validateTemplateFields(d.fields),
      revision: recordHash(d.version),
    };
  },
});
addTool({
  name: "instance_validate",
  description: "Check required fields, selections, formats and formulas.",
  permission: "read",
  schema: z.object({ instanceId: id }),
  run: async a => {
    const d = await callService("instances.get", a);
    return {
      issues: validateFieldValues(d.instance.values, d.fields, {
        requiredIsBlocking: true,
      }),
      revision: recordHash(d.instance),
    };
  },
});
addTool({
  name: "template_diff",
  description: "Compare two versions by stable field IDs and page layout.",
  permission: "read",
  schema: z.object({ fromVersionId: id, toVersionId: id }),
  run: async a => {
    const [from, to] = await Promise.all([
      callService("templates.getVersionDetails", {
        versionId: a.fromVersionId,
      }),
      callService("templates.getVersionDetails", { versionId: a.toVersionId }),
    ]);
    const map = (d: any) =>
      new Map<string, any>(
        d.fields.map((f: any) => [
          f.stableFieldId,
          {
            fieldType: f.fieldType,
            definition: f.definition,
            coordinate: f.coordinate,
          },
        ])
      );
    const x = map(from),
      y = map(to);
    return {
      removed: Array.from(x.keys()).filter(k => !y.has(k)),
      added: Array.from(y.keys()).filter(k => !x.has(k)),
      changed: Array.from(x.keys())
        .filter(k => y.has(k) && recordHash(x.get(k)) !== recordHash(y.get(k)))
        .map(k => ({ id: k, before: x.get(k), after: y.get(k) })),
      pagesChanged:
        recordHash(from.version.pageManifest) !==
        recordHash(to.version.pageManifest),
    };
  },
});
addTool({
  name: "asset_import",
  description:
    "Import a source, CSV, image or signature file only from folders allowed in Settings. The file must be explicitly supplied by the user.",
  permission: "write",
  schema: z.object({
    path: z.string().max(1024),
    kind: z.enum(["source", "image", "signature"]).default("source"),
    ...writeMeta,
  }),
  run: async a => {
    const file = await allowedFile(a.path),
      stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 50 * 1024 * 1024)
      throw new Error("FILE_TOO_LARGE_OR_NOT_FILE");
    const mime: Record<string, string> = {
      ".pdf": "application/pdf",
      ".docx":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".csv": "text/csv",
    };
    const mimeType = mime[path.extname(file).toLowerCase()];
    if (!mimeType || (a.kind !== "source" && !mimeType.startsWith("image/")))
      throw new Error("UNSUPPORTED_FILE_TYPE");
    return storeOwnedAsset(owner, {
      bytes: await fs.readFile(file),
      kind: a.kind,
      mimeType,
      originalFilename: path.basename(file),
    });
  },
});
addTool({
  name: "asset_save",
  description:
    "Save an owned output or backup to an allowed folder. Never overwrites an existing file.",
  permission: "export",
  schema: z.object({ assetId: id, path: z.string().max(1024), ...writeMeta }),
  run: async a => {
    const file = await allowedFile(a.path, true),
      data = await getOwnedAssetBytes(owner, a.assetId);
    await fs.writeFile(file, data.bytes, { flag: "wx" });
    return { path: file, assetId: a.assetId, sizeBytes: data.bytes.length };
  },
});
addTool({
  name: "preferences_update",
  description:
    "Set interface language; does not translate existing form contents.",
  permission: "write",
  schema: z.object({
    locale: z.enum(["zh-Hant", "zh-Hans", "en"]),
    ...writeMeta,
  }),
  run: a => callService("preferences", { locale: a.locale }),
});
addTool({
  name: "history_list",
  description:
    "Read this client's operation outcomes, including uncertain operations. Does not expose other clients' inputs.",
  permission: "read",
  schema: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
  run: async (a, ctx) =>
    (await readState()).operations
      .filter(o => o.clientId === ctx.clientId)
      .slice(-a.limit)
      .map(({ id, tool, state, at, error }) => ({
        id,
        tool,
        state,
        at,
        error,
      })),
});
addTool({
  name: "approval_status",
  description:
    "Check a pending approval. Only a person in the website can approve it.",
  permission: "read",
  schema: z.object({ operationId: id }),
  run: async (a, ctx) => {
    const op = (await readState()).operations.find(
      o => o.id === a.operationId && o.clientId === ctx.clientId
    );
    if (!op) throw new Error("NOT_FOUND");
    return { id: op.id, state: op.state, error: op.error };
  },
});

export async function executeTool(
  name: string,
  raw: unknown,
  ctx: ToolContext
) {
  const entry = catalog.find(t => t.name === name);
  if (!entry) throw new Error("UNKNOWN_TOOL");
  const args: any = entry.schema.parse(raw ?? {});
  await requireClient(ctx.clientId, entry.permission);
  const dangerous =
    typeof entry.dangerous === "function"
      ? entry.dangerous(args)
      : entry.dangerous;
  return governed({
    clientId: ctx.clientId,
    tool: name,
    args,
    permission: entry.permission,
    dangerous,
    expected: args.expected,
    run: async operationId => {
      for (const target of entry.targets?.(args) ?? [])
        if (
          !args.expected?.some(
            (e: any) => e.collection === target.collection && e.id === target.id
          )
        )
          throw new Error(
            `EXPECTED_REVISION_REQUIRED: ${target.collection}/${target.id}`
          );
      for (const e of args.expected ?? []) {
        const record =
          e.collection === "instances"
            ? (await callService("instances.get", { instanceId: e.id }))
                .instance
            : (await readWorkspace(owner)).workspace[
                e.collection as "templates"
              ].find((r: any) => r.id === e.id);
        if (!record || recordHash(record) !== e.hash)
          throw new Error(
            "EDIT_CONFLICT: Read the current record and retry with a new operationKey."
          );
      }
      const draftEdit = name.startsWith("draft_");
      const reversible = draftEdit || name === "instance_patch";
      const readTarget = () =>
        draftEdit
          ? callService("templates.getVersionDetails", {
              versionId: args.versionId,
            })
          : callService("instances.get", { instanceId: args.instanceId });
      if (reversible && operationId) {
        const before = await readTarget();
        await changeState(s => {
          s.operations.find(o => o.id === operationId)!.before = before;
        });
      }
      const result = await entry.run(args, ctx);
      if (reversible && operationId) {
        const after = await editContext.run([], readTarget);
        const record = draftEdit ? after.version : after.instance;
        await changeState(s => {
          s.operations.find(o => o.id === operationId)!.after = {
            collection: draftEdit ? "templateVersions" : "instances",
            id: record.id,
            hash: recordHash(record),
          };
        });
      }
      return withRevisions(result);
    },
  });
}
