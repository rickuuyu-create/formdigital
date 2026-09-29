import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { addTool, type ToolContext } from "./catalog";
import { callService, owner } from "./service";
import { changeState, readState, requireClient } from "./state";
import { writeMeta } from "./schema";
import {
  getOwnedAssetBytes,
  storeOwnedAsset,
  deleteOwnedAsset,
  listOwnedAssets,
} from "../formdigital/assetStore";

const active = new Map<string, () => Promise<void>>();
let queue: Promise<unknown> = Promise.resolve();
async function openWorker(origin: string) {
  const runtime = path.resolve(import.meta.dirname, "mcp-runtime"),
    entry = path.join(runtime, "playwright-core/index.mjs");
  let module: any, executablePath: string | undefined;
  try {
    await fs.access(entry);
    module = await import(pathToFileURL(entry).href);
    executablePath = path.join(runtime, "chromium/chrome.exe");
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
    const dependency = "@playwright/test";
    module = await import(dependency);
  }
  const browser = await module.chromium.launch({
    headless: true,
    executablePath,
    args: [
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--no-first-run",
    ],
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1100 },
      serviceWorkers: "block",
    });
    await context.route("**/*", async (route: any) => {
      const url = new URL(route.request().url());
      if (
        ["blob:", "data:"].includes(url.protocol) ||
        (url.origin === origin &&
          /^\/(mcp-worker\.html|assets\/|ocr-runtime\/|pdfjs\/|src\/|@|node_modules\/)/.test(
            url.pathname
          ))
      )
        await route.continue();
      else await route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    await page.goto(`${origin}/mcp-worker.html`);
    await page.waitForFunction(() => Boolean((window as any).fdWorker), {
      timeout: 30000,
    });
    return { browser, page };
  } catch (e) {
    await browser.close();
    throw e;
  }
}
async function setJob(id: string, patch: any) {
  await changeState(s => {
    const job = s.jobs.find(j => j.id === id);
    if (!job) throw new Error("JOB_NOT_FOUND");
    Object.assign(job, patch);
  });
}
async function runImport(id: string, args: any, ctx: ToolContext) {
  let session: Awaited<ReturnType<typeof openWorker>> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined,
    monitor: ReturnType<typeof setInterval> | undefined;
  const templates = new Set<string>(),
    assets = new Set<string>();
  let cancelled = false;
  try {
    await requireClient(ctx.clientId, "write");
    if ((await readState()).jobs.find(j => j.id === id)?.status === "cancelled")
      return;
    await setJob(id, {
      status: "running",
      progress: "Opening offline document converter",
    });
    const files = [];
    for (const assetId of args.assetIds) {
      const source = await getOwnedAssetBytes(owner, assetId);
      if (source.bytes.length > 50 * 1024 * 1024)
        throw new Error("SOURCE_TOO_LARGE");
      if (
        ![
          "application/pdf",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "image/png",
          "image/jpeg",
        ].includes(source.asset.mimeType)
      )
        throw new Error("UNSUPPORTED_SOURCE");
      files.push({
        name: source.asset.originalFilename ?? "source",
        mimeType: source.asset.mimeType,
        base64: Buffer.from(source.bytes).toString("base64"),
      });
    }
    if (files.length > 1 && files.some(f => !f.mimeType.startsWith("image/")))
      throw new Error("MULTIPLE_FILES_MUST_BE_IMAGES");
    session = await openWorker(ctx.origin);
    const cancel = async () => {
      cancelled = true;
      await session?.page
        .evaluate(() => (window as any).fdWorker.cancel())
        .catch(() => undefined);
    };
    active.set(id, cancel);
    timer = setTimeout(() => {
      void cancel();
    }, 10 * 60_000);
    monitor = setInterval(() => {
      void requireClient(ctx.clientId, "write").catch(() => cancel());
    }, 1000);
    await session.page.exposeFunction(
      "fdBridge",
      async (method: string, a: any) => {
        const cleanup = [
          "deleteTemplate",
          "deleteAsset",
          "listTemplateIds",
          "listAssetIds",
          "progress",
        ].includes(method);
        if (!cleanup) {
          await requireClient(ctx.clientId, "write");
          if (cancelled) throw new Error("CANCELLED");
        }
        switch (method) {
          case "createDraft": {
            const result = await callService("templates.createDraft", {
              name: a.name,
              pageManifest: [
                { page: 1, widthMm: 210, heightMm: 297, rotation: 0 },
              ],
              fields: [],
              printSettings: {
                xScale: 100,
                yScale: 100,
                xOffsetMm: 0,
                yOffsetMm: 0,
              },
            });
            templates.add(result.templateId);
            await setJob(id, { result: { ...result } });
            return result;
          }
          case "uploadAsset": {
            if (!templates.has(a.templateId)) throw new Error("IMPORT_SCOPE");
            const stored = await storeOwnedAsset(owner, {
              bytes: Buffer.from(a.base64, "base64"),
              kind: a.kind,
              mimeType: a.mimeType,
              originalFilename: a.filename,
              templateId: a.templateId,
              templateVersionId: a.versionId,
              metadata: {
                purpose: a.purpose ?? "mcp-import",
                preprocessing: a.preprocessing ?? {},
              },
            });
            if (!stored.deduplicated) assets.add(stored.asset.id);
            return {
              assetId: stored.asset.id,
              mimeType: stored.asset.mimeType,
            };
          }
          case "savePages":
          case "saveFields": {
            const d = await callService("templates.getVersionDetails", {
              versionId: a.versionId,
            });
            if (!templates.has(d.template.id)) throw new Error("IMPORT_SCOPE");
            return callService(
              method === "savePages"
                ? "templates.savePages"
                : "templates.saveDraftFields",
              a
            );
          }
          case "deleteTemplate":
            if (!templates.has(a.id)) throw new Error("IMPORT_SCOPE");
            return callService("templates.delete", { templateId: a.id });
          case "deleteAsset":
            if (assets.has(a.id)) return deleteOwnedAsset(owner, a.id);
            return { skipped: true };
          case "listTemplateIds":
            return (await callService("templates.list")).map((t: any) => t.id);
          case "listAssetIds":
            return (await listOwnedAssets(owner)).map(a => a.id);
          case "progress":
            await setJob(id, { progress: String(a.message).slice(0, 500) });
            return {};
          case "review":
            await setJob(id, {
              result: {
                templateId: a.templateId,
                versionId: a.versionId,
                pages: a.pages,
                candidateCount: a.suggestedFields.length,
                truncation: a.truncation,
              },
            });
            return {};
          default:
            throw new Error("UNKNOWN_WORKER_ACTION");
        }
      }
    );
    const result = await session.page.evaluate(
      (input: any) => (window as any).fdWorker.import(input),
      { ...args, files }
    );
    const job = (await readState()).jobs.find(j => j.id === id)!;
    await setJob(id, {
      status:
        result.status === "created"
          ? "review"
          : result.status === "cancelled"
            ? "cancelled"
            : "failed",
      progress:
        result.status === "created"
          ? "Review candidates and page previews; no human review has been recorded."
          : result.status,
      result: { ...job.result, ...result },
    });
  } catch (e: any) {
    await setJob(id, {
      status: cancelled ? "cancelled" : "failed",
      error: String(e.message).slice(0, 2000),
      progress: "Inspect retained draft and assets before retrying.",
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (monitor) clearInterval(monitor);
    active.delete(id);
    await session?.browser.close();
  }
}
addTool({
  name: "source_import_start",
  description:
    "Import owned PDF/DOCX/images via the same offline converter and OCR as the website. Returns a persistent job ID. Poll job_get; then review unconfirmed candidates and page previews. No automatic human approval.",
  permission: "write",
  schema: z.object({
    assetIds: z.array(z.string().min(1)).min(1).max(20),
    name: z.string().min(1).max(255),
    detect: z.boolean().default(true),
    language: z.enum(["auto", "eng", "chi_tra", "chi_sim"]).default("auto"),
    preprocessing: z
      .object({
        rotation: z.number().min(-180).max(180).default(0),
        contrast: z.number().min(0.1).max(3).default(1),
        grayscale: z.boolean().default(false),
        autoCrop: z.boolean().default(false),
      })
      .default({ rotation: 0, contrast: 1, grayscale: false, autoCrop: false }),
    ...writeMeta,
  }),
  run: async (a, ctx) => {
    const id = randomUUID();
    await changeState(s => {
      if (
        s.jobs.filter(j => ["queued", "running"].includes(j.status)).length >= 8
      )
        throw new Error("JOB_QUEUE_FULL");
      s.jobs.push({
        id,
        clientId: ctx.clientId,
        kind: "source-import",
        status: "queued",
        progress: "Queued",
        at: new Date().toISOString(),
      });
    });
    setTimeout(() => {
      queue = queue.then(() => runImport(id, a, ctx)).catch(() => undefined);
    }, 0);
    return { jobId: id };
  },
});
addTool({
  name: "job_get",
  description:
    "Read progress, retained draft, review needs and cleanup result for your job.",
  permission: "read",
  schema: z.object({ jobId: z.string().uuid() }),
  run: async (a, ctx) => {
    const job = (await readState()).jobs.find(
      j => j.id === a.jobId && j.clientId === ctx.clientId
    );
    if (!job) throw new Error("JOB_NOT_FOUND");
    return job;
  },
});
addTool({
  name: "job_cancel",
  description:
    "Cancel your queued or running import at a safe boundary. Read job_get for cleanup status.",
  permission: "write",
  schema: z.object({ jobId: z.string().uuid(), ...writeMeta }),
  run: async (a, ctx) => {
    const job = (await readState()).jobs.find(
      j => j.id === a.jobId && j.clientId === ctx.clientId
    );
    if (!job) throw new Error("JOB_NOT_FOUND");
    if (job.status === "queued")
      await setJob(job.id, {
        status: "cancelled",
        progress: "Cancelled before starting",
      });
    else if (active.has(job.id)) await active.get(job.id)!();
    return { jobId: job.id, cancellationRequested: true };
  },
});

const crop = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  })
  .refine(c => c.x + c.width <= 1 && c.y + c.height <= 1, "Crop outside page")
  .optional();
async function preview(args: any, ctx: ToolContext, template: boolean) {
  let fields: any[] | undefined,
    widthMm: number | undefined,
    heightMm: number | undefined,
    assetId = args.assetId,
    pageNumber = args.page;
  if (template) {
    const d = await callService("templates.getVersionDetails", {
        versionId: args.versionId,
      }),
      p = d.version.pageManifest.find((p: any) => p.page === args.page);
    if (!p) throw new Error("PAGE_NOT_FOUND");
    assetId = p.assetId;
    widthMm = p.widthMm;
    heightMm = p.heightMm;
    fields = args.overlay
      ? d.fields.filter((f: any) => f.coordinate.page === args.page)
      : undefined;
  }
  const source = await getOwnedAssetBytes(owner, assetId);
  if (
    !["application/pdf", "image/png", "image/jpeg"].includes(
      source.asset.mimeType
    )
  )
    throw new Error("UNSUPPORTED_PREVIEW_TYPE");
  if (source.bytes.length > 60 * 1024 * 1024)
    throw new Error("PREVIEW_TOO_LARGE");
  const session = await openWorker(ctx.origin);
  try {
    const result = await session.page.evaluate(
      (input: any) => (window as any).fdWorker.preview(input),
      {
        base64: Buffer.from(source.bytes).toString("base64"),
        mimeType: source.asset.mimeType,
        page: pageNumber,
        crop: args.crop,
        fields,
        widthMm,
        heightMm,
      }
    );
    const { base64, ...details } = result;
    return {
      _mcpContent: [
        { type: "image", data: base64, mimeType: "image/png" },
        {
          type: "text",
          text: JSON.stringify({
            ...details,
            assetId,
            review:
              "AI preview only; human output confirmation remains separate.",
          }),
        },
      ],
      details: { ...details, assetId },
    };
  } finally {
    await session.browser.close();
  }
}
addTool({
  name: "page_preview",
  description:
    "View one template page, optionally with field boxes. Crop uses fractions (0..1). Preview is not human review.",
  permission: "read",
  schema: z.object({
    versionId: z.string().min(1),
    page: z.number().int().positive(),
    overlay: z.boolean().default(true),
    crop,
  }),
  run: (a, c) => preview(a, c, true),
});
addTool({
  name: "output_preview",
  description:
    "Render an actual PDF output page or image and return extracted page text. Does not mark it manually checked.",
  permission: "read",
  schema: z.object({
    assetId: z.string().min(1),
    page: z.number().int().positive().default(1),
    crop,
  }),
  run: (a, c) => preview(a, c, false),
});
