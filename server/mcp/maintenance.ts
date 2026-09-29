import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { z } from "zod";
import { addTool } from "./catalog";
import { allowedFile, readState } from "./state";
import { callService, owner } from "./service";
import { writeMeta } from "./schema";
import {
  createVerifiedBackup,
  storeOwnedAsset,
} from "../formdigital/assetStore";
import { openLocalStreamingBackup } from "../formdigital/localServiceClient";
import practiceLessons from "../../client/src/lib/template-practice-catalog.json";
import { updateDraftTemplateFields } from "../formdigital/repository";

addTool({
  name: "backup_template",
  description:
    "Create a verified template backup as an owned asset, without sending archive bytes into the conversation.",
  permission: "manage",
  schema: z.object({ templateId: z.string().min(1), ...writeMeta }),
  run: async a => {
    const backup = await createVerifiedBackup(owner, a.templateId);
    const stored = await storeOwnedAsset(owner, {
      bytes: Buffer.from(backup.archiveBase64, "base64"),
      kind: "backup",
      mimeType: "application/zip",
      originalFilename: backup.filename,
    });
    return {
      assetId: stored.asset.id,
      filename: backup.filename,
      manifest: backup.manifest,
      hash: backup.manifestHash,
      sizeBytes: backup.archiveBytes,
    };
  },
});
addTool({
  name: "backup_save",
  description:
    "Stream a verified account backup to an allowed folder without overwriting files.",
  permission: "manage",
  schema: z.object({
    backupId: z.string().regex(/^backup-[\w-]+$/),
    path: z.string().max(1024),
    ...writeMeta,
  }),
  run: async a => {
    const target = await allowedFile(a.path, true),
      source = await openLocalStreamingBackup(owner, a.backupId);
    await pipeline(source.stream, createWriteStream(target, { flags: "wx" }));
    return {
      path: target,
      backupId: a.backupId,
      sizeBytes: source.contentLength,
    };
  },
});
addTool({
  name: "restore_preview",
  description:
    "Verify a backup from an allowed folder and return a short-lived restore session and affected-data summary. Does not restore.",
  permission: "manage",
  schema: z.object({ path: z.string().max(1024), ...writeMeta }),
  run: async (a, ctx) => {
    const file = await allowedFile(a.path),
      stat = await fs.stat(file);
    if (!stat.isFile() || stat.size < 1) throw new Error("INVALID_BACKUP_FILE");
    const response = await fetch(
      `${ctx.origin}/api/local/portable-restore-sessions`,
      {
        method: "POST",
        headers: {
          Origin: ctx.origin,
          "content-type": "application/octet-stream",
          "x-formdigital-portable-restore": "1",
          "sec-fetch-site": "same-origin",
          "content-length": String(stat.size),
        },
        body: createReadStream(file),
        duplex: "half",
      } as any
    );
    const result = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(result));
    return result;
  },
});
addTool({
  name: "restore_apply",
  description:
    "Restore exactly the verified session after local approval. Creates a recovery backup first. Existing workspace data may be replaced.",
  permission: "manage",
  dangerous: true,
  schema: z.object({ sessionId: z.string().uuid(), ...writeMeta }),
  run: async (a, ctx) => {
    const preview = (await readState()).operations.find(
      o =>
        o.clientId === ctx.clientId &&
        o.tool === "restore_preview" &&
        o.state === "done" &&
        o.result?.sessionId === a.sessionId
    );
    if (!preview || Date.parse(preview.result.expiresAt) < Date.now())
      throw new Error("RESTORE_PREVIEW_REQUIRED_OR_EXPIRED");
    const recovery = await callService("backups.createStream");
    const restored = await callService("backups.restoreStream", {
      sessionId: a.sessionId,
    });
    return { restored, recoveryBackup: recovery };
  },
});
addTool({
  name: "data_location_info",
  description:
    "Read local data-folder health and integrity capabilities. Never exposes service credentials.",
  permission: "manage",
  schema: z.object({}),
  run: () => callService("localData.status"),
});
addTool({
  name: "data_location_apply",
  description:
    "Move or reconnect the local data folder, only inside an approved folder and after local approval. Review the current location first.",
  permission: "manage",
  dangerous: true,
  schema: z.object({
    dataFolder: z.string().max(1024),
    mode: z.enum(["move", "reconnect"]),
    ...writeMeta,
  }),
  run: async a => {
    await allowedFile(
      path.join(a.dataFolder, ".formdigital-location-check"),
      true
    );
    return callService(`localData.${a.mode}`, { dataFolder: a.dataFolder });
  },
});
addTool({
  name: "change_revert",
  description:
    "Undo this client's completed instance_patch or draft_patch as a new guarded change. Pass the original operation's after revision; refuses if anyone edited it afterward. Deletion/restore use a recovery backup instead.",
  permission: "write",
  schema: z.object({ originalOperationId: z.string().uuid(), ...writeMeta }),
  run: async (a, ctx) => {
    const op = (await readState()).operations.find(
      o => o.id === a.originalOperationId && o.clientId === ctx.clientId
    );
    if (!op || op.state !== "done" || !op.before || !op.after)
      throw new Error("CHANGE_NOT_REVERSIBLE");
    if (
      !a.expected.some(
        (e: any) =>
          e.collection === op.after.collection &&
          e.id === op.after.id &&
          e.hash === op.after.hash
      )
    )
      throw new Error("REVERT_REQUIRES_UNCHANGED_AFTER_REVISION");
    if (op.tool === "instance_patch")
      return callService("instances.saveValues", {
        instanceId: op.before.instance.id,
        values: op.before.instance.values,
      });
    if (op.tool.startsWith("draft_"))
      return updateDraftTemplateFields(owner, op.before.version.id, {
        fields: op.before.fields.map((f: any) => ({
          stableFieldId: f.stableFieldId,
          fieldType: f.fieldType,
          displayOrder: f.displayOrder,
          definition: f.definition,
          coordinate: f.coordinate,
        })),
        printSettings: op.before.version.printSettings,
        pageManifest: op.before.version.pageManifest,
      });
    throw new Error("CHANGE_NOT_REVERSIBLE");
  },
});
addTool({
  name: "change_preview",
  description:
    "Read before/after revision and changed field IDs for your reversible operation. Full previous field values are not returned.",
  permission: "read",
  schema: z.object({ operationId: z.string().uuid() }),
  run: async (a, ctx) => {
    const op = (await readState()).operations.find(
      o => o.id === a.operationId && o.clientId === ctx.clientId
    );
    if (!op) throw new Error("NOT_FOUND");
    return {
      id: op.id,
      tool: op.tool,
      state: op.state,
      after: op.after,
      reversible: Boolean(op.before && op.after),
      fields: op.args.values
        ? Object.keys(op.args.values)
        : op.args.upsert?.map((f: any) => f.stableFieldId),
    };
  },
});
addTool({
  name: "practice_create",
  description:
    "Create an independent 8-page practice draft using the bundled tutorial form and unconfirmed example fields. Does not mark the user's tutorial as completed.",
  permission: "write",
  schema: z.object({
    name: z.string().min(1).max(255).default("MCP practice"),
    ...writeMeta,
  }),
  run: async a => {
    const file = path.resolve(
      import.meta.dirname,
      "public/practice/template-practice-v1.pdf"
    );
    const stored = await storeOwnedAsset(owner, {
      bytes: await fs.readFile(file),
      kind: "source",
      mimeType: "application/pdf",
      originalFilename: "template-practice-v1.pdf",
    });
    const fields = practiceLessons.map((lesson: any, i: number) => ({
      stableFieldId: `practice-${lesson.id.toLowerCase()}`,
      fieldType: lesson.type,
      displayOrder: i,
      definition: {
        label: lesson.title[0],
        ...lesson.settings,
        confirmed: false,
        aiSuggested: true,
        ...(lesson.marks ? { optionMarks: lesson.marks } : {}),
        ...(lesson.cells ? { tableCellGuides: lesson.cells } : {}),
        ...(lesson.segments ? { detectionGroup: lesson.segments } : {}),
      },
      coordinate: {
        page: lesson.page,
        xMm: lesson.box.x,
        yMm: lesson.box.y,
        widthMm: lesson.box.width,
        heightMm: lesson.box.height,
      },
    }));
    return callService("templates.createDraft", {
      name: a.name,
      description:
        "AI practice copy; does not record human tutorial completion.",
      pageManifest: Array.from({ length: 8 }, (_, i) => ({
        page: i + 1,
        widthMm: 210,
        heightMm: 297,
        rotation: 0,
        assetId: stored.asset.id,
        mimeType: "application/pdf",
      })),
      fields,
      printSettings: { xScale: 100, yScale: 100, xOffsetMm: 0, yOffsetMm: 0 },
    });
  },
});
