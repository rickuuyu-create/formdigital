import { systemRouter } from "./_core/systemRouter";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { z } from "zod";
import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";
import { promisify } from "node:util";
import {
  createInstanceFromPublishedVersion,
  createTemplateDraft,
  addSavedValue,
  cloneTemplateVersionToDraft,
  cloneInstanceForOwner,
  confirmInstanceOutputChecked,
  deleteFolder,
  deleteInstancesForOwner,
  deleteSavedValue,
  deleteMappingTemplate,
  deleteTag,
  deleteTemplateForOwner,
  getInstanceForOwner,
  getTemplateVersionForOwner,
  getTemplateVersionDetailsForOwner,
  hasReviewedOutputForVersion,
  listInstancesForOwner,
  listInstancesPageForOwner,
  listTemplateVersionsForOwner,
  listTemplatesForOwner,
  listWorkspaceCollections,
  migrateInstancesForOwner,
  publishTemplateVersion,
  recordInstanceOutput,
  recordSavedValueUse,
  saveTemplatePrintProfile,
  saveInstanceValues,
  saveWorkspacePreferences,
  searchTemplatesForOwner,
  touchTemplate,
  updateDraftPageManifest,
  updateDraftTemplateFields,
  updateInstanceStatus,
  updateTemplateMetadata,
  upsertFolder,
  upsertMappingTemplate,
  upsertTag,
} from "./formdigital/repository";
import {
  commitVerifiedPortableRestoreSession,
  createBackupImportPreview,
  createStreamingVerifiedBackup,
  createVerifiedBackup,
  deleteOwnedAsset,
  getOwnedAssetUrl,
  listOwnedAssets,
  restoreVerifiedBackup,
  storeOwnedAsset,
  verifyBackupArchive,
} from "./formdigital/assetStore";
import {
  analyzeStoredCsvImport,
  createStoredImportRun,
  previewStoredCsv,
  resumeStoredImportRun,
} from "./formdigital/batch";
import { renderInstancePdf } from "./formdigital/pdfRenderer";
import {
  createBatchPdf,
  exportStructuredInstance,
} from "./formdigital/exportService";
import { createCalibrationTestPage } from "./formdigital/calibrationService";
import type { JsonValue } from "./formdigital/domain";
import { clearGoogleSession } from "./formdigital/googleAuth";
import {
  getLocalHealth,
  moveLocalDataFolder,
  reconnectLocalDataFolder,
  recognizeLocalImage,
  repairLocalIntegrity,
  runLocalIntegrityScan,
} from "./formdigital/localServiceClient";

const LEGACY_PORTABLE_BACKUP_MAX_BYTES = 32 * 1024 * 1024;

function decodeLegacyPortableBackup(base64: string) {
  const bytes = Buffer.from(base64, "base64");
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > LEGACY_PORTABLE_BACKUP_MAX_BYTES ||
    bytes.toString("base64") !== base64
  )
    throw new Error(
      "此備份格式無效或超出舊式匯入上限；大型帳號備份請使用串流還原。"
    );
  return bytes;
}

const execFileAsync = promisify(execFile);

async function getHostOcrCapabilities() {
  try {
    await execFileAsync("tesseract", ["--version"], {
      timeout: 2_000,
      windowsHide: true,
    });
    return { available: true };
  } catch {
    return { available: false };
  }
}

const jsonValueSchema: z.ZodType<unknown> = z.unknown();
const fieldDraftSchema = z.object({
  stableFieldId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z][a-z0-9-]*$/i),
  fieldType: z.string().min(1).max(48),
  displayOrder: z.number().int().min(0),
  definition: jsonValueSchema,
  coordinate: jsonValueSchema,
});

/**
 * Field ceiling for one Template Version. Automatic detection is bounded per
 * page (500 fused candidates) and again per document; this is the persistence
 * side of that second, named ceiling.
 */
const MAX_VERSION_FIELDS = 5_000;

export const appRouter = router({
  // if you need to use socket.io, read and register route in server/_core/index.ts, all api should start with '/api/' so that the gateway can route correctly
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      clearGoogleSession(ctx.req, ctx.res);
      return {
        success: true,
      } as const;
    }),
  }),
  formdigital: router({
    dashboard: protectedProcedure.query(({ ctx }) =>
      Promise.all([
        listTemplatesForOwner(ctx.user.id),
        listInstancesForOwner(ctx.user.id),
        listWorkspaceCollections(ctx.user.id),
      ]).then(([templates, instances, collections]) => ({
        templates,
        instances,
        ...collections,
      }))
    ),
    collections: protectedProcedure.query(({ ctx }) =>
      listWorkspaceCollections(ctx.user.id)
    ),
    preferences: protectedProcedure
      .input(z.record(z.string(), z.unknown()))
      .mutation(({ ctx, input }) =>
        saveWorkspacePreferences(ctx.user.id, input)
      ),
    localData: router({
      status: protectedProcedure.query(() => getLocalHealth()),
      startupIntegrity: protectedProcedure.query(() => runLocalIntegrityScan()),
      integrity: protectedProcedure.mutation(() => runLocalIntegrityScan()),
      repair: protectedProcedure.mutation(() => repairLocalIntegrity()),
      move: protectedProcedure
        .input(z.object({ dataFolder: z.string().trim().min(3).max(1024) }))
        .mutation(({ input }) => moveLocalDataFolder(input.dataFolder)),
      reconnect: protectedProcedure
        .input(z.object({ dataFolder: z.string().trim().min(3).max(1024) }))
        .mutation(({ input }) => reconnectLocalDataFolder(input.dataFolder)),
    }),
    ocr: router({
      capabilities: protectedProcedure.query(() => getHostOcrCapabilities()),
      recognize: protectedProcedure
        .input(
          z.object({
            base64: z.string().min(1).max(21_000_000),
            mimeType: z.enum(["image/png", "image/jpeg"]),
            language: z.enum(["auto", "eng", "chi_tra", "chi_sim"]),
            width: z.number().positive().optional(),
            height: z.number().positive().optional(),
          })
        )
        .mutation(({ input }) => recognizeLocalImage(input)),
    }),
    folders: router({
      upsert: protectedProcedure
        .input(
          z.object({
            id: z.string().optional(),
            name: z.string().trim().min(1).max(120),
            parentId: z.string().nullable().optional(),
          })
        )
        .mutation(({ ctx, input }) => upsertFolder(ctx.user.id, input)),
      delete: protectedProcedure
        .input(z.object({ folderId: z.string().min(1) }))
        .mutation(({ ctx, input }) =>
          deleteFolder(ctx.user.id, input.folderId)
        ),
    }),
    tags: router({
      upsert: protectedProcedure
        .input(
          z.object({
            id: z.string().optional(),
            name: z.string().trim().min(1).max(80),
            color: z.string().regex(/^#[0-9a-f]{6}$/i),
          })
        )
        .mutation(({ ctx, input }) => upsertTag(ctx.user.id, input)),
      delete: protectedProcedure
        .input(z.object({ tagId: z.string().min(1) }))
        .mutation(({ ctx, input }) => deleteTag(ctx.user.id, input.tagId)),
    }),
    savedValues: router({
      add: protectedProcedure
        .input(
          z.object({
            templateId: z.string().min(1),
            stableFieldId: z.string().min(1),
            value: z.string().min(1).max(10000),
          })
        )
        .mutation(({ ctx, input }) => addSavedValue(ctx.user.id, input)),
      use: protectedProcedure
        .input(z.object({ savedValueId: z.string().min(1) }))
        .mutation(({ ctx, input }) =>
          recordSavedValueUse(ctx.user.id, input.savedValueId)
        ),
      delete: protectedProcedure
        .input(z.object({ savedValueId: z.string().min(1) }))
        .mutation(({ ctx, input }) =>
          deleteSavedValue(ctx.user.id, input.savedValueId)
        ),
    }),
    mappingTemplates: router({
      upsert: protectedProcedure
        .input(
          z.object({
            id: z.string().optional(),
            templateVersionId: z.string().min(1),
            name: z.string().trim().min(1).max(255),
            sourceSchemaFingerprint: z.string().length(64),
            mapping: jsonValueSchema,
          })
        )
        .mutation(({ ctx, input }) =>
          upsertMappingTemplate(ctx.user.id, {
            ...input,
            mapping: input.mapping as never,
          })
        ),
      delete: protectedProcedure
        .input(z.object({ mappingTemplateId: z.string().min(1) }))
        .mutation(({ ctx, input }) =>
          deleteMappingTemplate(ctx.user.id, input.mappingTemplateId)
        ),
    }),
    templates: router({
      list: protectedProcedure.query(({ ctx }) =>
        listTemplatesForOwner(ctx.user.id)
      ),
      search: protectedProcedure
        .input(z.object({ query: z.string().max(200) }))
        .query(({ ctx, input }) =>
          searchTemplatesForOwner(ctx.user.id, input.query)
        ),
      touch: protectedProcedure
        .input(z.object({ templateId: z.string().min(1) }))
        .mutation(({ ctx, input }) =>
          touchTemplate(ctx.user.id, input.templateId)
        ),
      createDraft: protectedProcedure
        .input(
          z.object({
            name: z.string().trim().min(1).max(255),
            description: z.string().trim().max(2000).optional(),
            note: z.string().trim().max(2000).optional(),
            pageManifest: jsonValueSchema,
            fields: z.array(fieldDraftSchema).max(MAX_VERSION_FIELDS),
            printSettings: jsonValueSchema,
          })
        )
        .mutation(({ ctx, input }) =>
          createTemplateDraft(ctx.user.id, input as never)
        ),
      getVersion: protectedProcedure
        .input(z.object({ versionId: z.string().min(1).max(52) }))
        .query(({ ctx, input }) =>
          getTemplateVersionForOwner(ctx.user.id, input.versionId)
        ),
      getVersionDetails: protectedProcedure
        .input(z.object({ versionId: z.string().min(1).max(52) }))
        .query(({ ctx, input }) =>
          getTemplateVersionDetailsForOwner(ctx.user.id, input.versionId)
        ),
      outputReviewed: protectedProcedure
        .input(z.object({ versionId: z.string().min(1).max(52) }))
        .query(async ({ ctx, input }) => ({
          reviewed: await hasReviewedOutputForVersion(ctx.user.id, input.versionId),
        })),
      saveDraftFields: protectedProcedure
        .input(
          z.object({
            versionId: z.string().min(1).max(52),
            fields: z.array(fieldDraftSchema).max(MAX_VERSION_FIELDS),
            printSettings: jsonValueSchema.optional(),
          })
        )
        .mutation(({ ctx, input }) =>
          updateDraftTemplateFields(ctx.user.id, input.versionId, {
            fields: input.fields as never,
            printSettings: input.printSettings as never,
          })
        ),
      cloneToDraft: protectedProcedure
        .input(
          z.object({
            versionId: z.string().min(1).max(52),
            note: z.string().trim().max(2000).optional(),
          })
        )
        .mutation(({ ctx, input }) =>
          cloneTemplateVersionToDraft(ctx.user.id, input.versionId, input.note)
        ),
      publish: protectedProcedure
        .input(z.object({ versionId: z.string().min(1).max(52) }))
        .mutation(({ ctx, input }) =>
          publishTemplateVersion(ctx.user.id, input.versionId)
        ),
      versions: protectedProcedure
        .input(z.object({ templateId: z.string().min(1).max(52) }))
        .query(({ ctx, input }) =>
          listTemplateVersionsForOwner(ctx.user.id, input.templateId)
        ),
      updateMetadata: protectedProcedure
        .input(
          z.object({
            templateId: z.string().min(1).max(52),
            name: z.string().trim().min(1).max(255).optional(),
            description: z.string().max(2000).nullable().optional(),
            favorite: z.boolean().optional(),
            pinned: z.boolean().optional(),
            folderIds: z.array(z.string()).max(50).optional(),
            tagIds: z.array(z.string()).max(50).optional(),
            instanceNamePattern: z.string().max(500).optional(),
            keyFieldIds: z.array(z.string()).max(20).optional(),
          })
        )
        .mutation(({ ctx, input }) => {
          const { templateId, ...patch } = input;
          return updateTemplateMetadata(ctx.user.id, templateId, patch);
        }),
      savePrintProfile: protectedProcedure
        .input(
          z.object({
            templateId: z.string().min(1),
            printProfile: z.record(z.string(), z.unknown()),
          })
        )
        .mutation(({ ctx, input }) =>
          saveTemplatePrintProfile(
            ctx.user.id,
            input.templateId,
            input.printProfile
          )
        ),
      savePages: protectedProcedure
        .input(
          z.object({
            versionId: z.string().min(1),
            pageManifest: jsonValueSchema,
          })
        )
        .mutation(({ ctx, input }) =>
          updateDraftPageManifest(
            ctx.user.id,
            input.versionId,
            input.pageManifest as never
          )
        ),
      delete: protectedProcedure
        .input(z.object({ templateId: z.string().min(1) }))
        .mutation(({ ctx, input }) =>
          deleteTemplateForOwner(ctx.user.id, input.templateId)
        ),
    }),
    instances: router({
      list: protectedProcedure.query(({ ctx }) =>
        listInstancesForOwner(ctx.user.id)
      ),
      listPage: protectedProcedure
        .input(
          z.object({
            cursor: z.string().max(4096).nullable().default(null),
            limit: z.number().int().min(1).max(1000).default(250),
          })
        )
        .query(({ ctx, input }) =>
          listInstancesPageForOwner(ctx.user.id, input.cursor, input.limit)
        ),
      get: protectedProcedure
        .input(z.object({ instanceId: z.string().min(1).max(52) }))
        .query(({ ctx, input }) =>
          getInstanceForOwner(ctx.user.id, input.instanceId)
        ),
      create: protectedProcedure
        .input(
          z.object({
            templateVersionId: z.string().min(1).max(52),
            name: z.string().trim().min(1).max(255),
            values: z.record(z.string(), z.string().max(10000)),
          })
        )
        .mutation(({ ctx, input }) =>
          createInstanceFromPublishedVersion(ctx.user.id, input)
        ),
      saveValues: protectedProcedure
        .input(
          z.object({
            instanceId: z.string().min(1).max(52),
            values: z.record(z.string(), z.string().max(10000)),
          })
        )
        .mutation(({ ctx, input }) =>
          saveInstanceValues(ctx.user.id, input.instanceId, input.values)
        ),
      clone: protectedProcedure
        .input(
          z.object({
            instanceId: z.string().min(1),
            clearMedia: z.boolean().default(false),
          })
        )
        .mutation(({ ctx, input }) =>
          cloneInstanceForOwner(ctx.user.id, input.instanceId, input.clearMedia)
        ),
      setStatus: protectedProcedure
        .input(
          z.object({
            instanceId: z.string().min(1),
            status: z.enum(["draft", "completed", "printed"]),
          })
        )
        .mutation(({ ctx, input }) =>
          updateInstanceStatus(ctx.user.id, input.instanceId, input.status)
        ),
      delete: protectedProcedure
        .input(
          z.object({ instanceIds: z.array(z.string().min(1)).min(1).max(5000) })
        )
        .mutation(({ ctx, input }) =>
          deleteInstancesForOwner(ctx.user.id, input.instanceIds)
        ),
      markPrinted: protectedProcedure
        .input(
          z.object({
            instanceIds: z.array(z.string().min(1)).min(1).max(5000),
            output: z.record(z.string(), z.unknown()).optional(),
          })
        )
        .mutation(async ({ ctx, input }) =>
          Promise.all(
            input.instanceIds.map(id =>
              recordInstanceOutput(
                ctx.user.id,
                id,
                { ...(input.output ?? {}), printedAt: Date.now() },
                true
              )
            )
          )
        ),
      confirmOutputChecked: protectedProcedure
        .input(z.object({
          instanceId: z.string().min(1).max(52),
          assetId: z.string().min(1).max(52),
        }))
        .mutation(({ ctx, input }) =>
          confirmInstanceOutputChecked(ctx.user.id, input.instanceId, input.assetId)
        ),
      migrateVersion: protectedProcedure
        .input(
          z.object({
            instanceIds: z.array(z.string().min(1)).min(1).max(5000),
            targetVersionId: z.string().min(1),
            mapping: z.record(z.string(), z.string().nullable()),
            deleteOriginals: z.boolean(),
          })
        )
        .mutation(({ ctx, input }) =>
          migrateInstancesForOwner(ctx.user.id, input)
        ),
    }),
    assets: router({
      list: protectedProcedure.query(({ ctx }) => listOwnedAssets(ctx.user.id)),
      getUrl: protectedProcedure
        .input(z.object({ assetId: z.string().min(1).max(52) }))
        .query(({ ctx, input }) =>
          getOwnedAssetUrl(ctx.user.id, input.assetId)
        ),
      delete: protectedProcedure
        .input(z.object({ assetId: z.string().min(1).max(52) }))
        .mutation(({ ctx, input }) =>
          deleteOwnedAsset(ctx.user.id, input.assetId)
        ),
      upload: protectedProcedure
        .input(
          z.object({
            base64: z.string().min(1).max(21_000_000),
            kind: z.enum(["source", "page", "signature", "image", "export"]),
            mimeType: z.string().min(3).max(128),
            originalFilename: z.string().min(1).max(512).optional(),
            metadata: jsonValueSchema.optional(),
            templateId: z.string().min(1).max(52).optional(),
            templateVersionId: z.string().min(1).max(52).optional(),
            instanceId: z.string().min(1).max(52).optional(),
          })
        )
        .mutation(async ({ ctx, input }) => {
          const bytes = Buffer.from(input.base64, "base64");
          if (bytes.byteLength === 0) throw new Error("上傳檔案不可為空。");
          return storeOwnedAsset(ctx.user.id, {
            ...input,
            metadata: input.metadata as JsonValue | undefined,
            bytes,
          });
        }),
    }),
    backups: router({
      createStream: protectedProcedure.mutation(({ ctx }) =>
        createStreamingVerifiedBackup(ctx.user.id)
      ),
      create: protectedProcedure
        .input(
          z
            .object({ templateId: z.string().min(1).max(52).optional() })
            .optional()
        )
        .mutation(({ ctx, input }) =>
          createVerifiedBackup(ctx.user.id, input?.templateId)
        ),
      verify: protectedProcedure
        .input(z.object({ base64: z.string().min(1).max(49_000_000) }))
        .mutation(({ input }) => {
          const manifest = verifyBackupArchive(
            decodeLegacyPortableBackup(input.base64)
          );
          return { valid: true, manifest: createBackupImportPreview(manifest) };
        }),
      restoreStream: protectedProcedure
        .input(
          z.object({
            sessionId: z
              .string()
              .regex(
                /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
              ),
          })
        )
        .mutation(({ ctx, input }) =>
          commitVerifiedPortableRestoreSession(ctx.user.id, input.sessionId)
        ),
      restore: protectedProcedure
        .input(
          z.object({
            base64: z.string().min(1).max(49_000_000),
            mode: z.enum(["full", "structure", "duplicate"]),
          })
        )
        .mutation(({ ctx, input }) =>
          restoreVerifiedBackup(
            ctx.user.id,
            decodeLegacyPortableBackup(input.base64),
            input.mode
          )
        ),
    }),
    imports: router({
      preview: protectedProcedure
        .input(z.object({ sourceAssetId: z.string().regex(/^asset-[\w-]+$/).max(64) }))
        .mutation(({ ctx, input }) =>
          previewStoredCsv(ctx.user.id, input.sourceAssetId)
        ),
      create: protectedProcedure
        .input(
          z.object({
            templateVersionId: z.string().min(1).max(52),
            sourceAssetId: z.string().regex(/^asset-[\w-]+$/).max(64),
            sourceHash: z.string().length(64),
            originalFilename: z.string().min(1).max(512).optional(),
            mode: z.enum(["strict", "tolerant"]).default("strict"),
            decisions: z
              .array(
                z.object({
                  csvField: z.string().min(1).max(255),
                  templateStableFieldId: z
                    .string()
                    .min(1)
                    .max(128)
                    .nullable()
                    .optional(),
                  confidence: z.enum(["high", "medium", "low"]),
                  decision: z.enum(["accepted", "ignored", "unresolved"]),
                })
              )
              .min(1)
              .max(500),
            duplicateDecisions: z
              .array(
                z.object({
                  rowNumber: z.number().int().min(2),
                  action: z.enum(["skip", "create", "overwrite"]),
                  instanceId: z.string().nullable().optional(),
                  mergedValues: z.record(z.string(), z.string()).optional(),
                })
              )
              .max(5000)
              .optional(),
            rowCorrections: z
              .array(
                z.object({
                  rowNumber: z.number().int().min(2),
                  values: z.record(z.string(), z.string()),
                })
              )
              .max(2000)
              .optional(),
          })
        )
        .mutation(({ ctx, input }) =>
          createStoredImportRun(ctx.user.id, input)
        ),
      analyze: protectedProcedure
        .input(
          z.object({
            templateVersionId: z.string().min(1).max(52),
            sourceAssetId: z.string().regex(/^asset-[\w-]+$/).max(64),
            sourceHash: z.string().length(64),
            decisions: z
              .array(
                z.object({
                  csvField: z.string().min(1).max(255),
                  templateStableFieldId: z
                    .string()
                    .min(1)
                    .max(128)
                    .nullable()
                    .optional(),
                  confidence: z.enum(["high", "medium", "low"]),
                  decision: z.enum(["accepted", "ignored", "unresolved"]),
                })
              )
              .min(1)
              .max(500),
            rowCorrections: z
              .array(
                z.object({
                  rowNumber: z.number().int().min(2),
                  values: z.record(z.string(), z.string()),
                })
              )
              .max(2000)
              .optional(),
            previewPage: z.number().int().min(0).max(100_000_000).optional(),
          })
        )
        .mutation(({ ctx, input }) =>
          analyzeStoredCsvImport(ctx.user.id, input)
        ),
      resume: protectedProcedure
        .input(z.object({ importRunId: z.string().min(1).max(52) }))
        .mutation(({ ctx, input }) =>
          resumeStoredImportRun(ctx.user.id, input.importRunId)
        ),
    }),
    exports: router({
      pdf: protectedProcedure
        .input(
          z.object({
            instanceId: z.string().min(1).max(52),
            mode: z.enum(["full", "overlay", "editable"]),
          })
        )
        .mutation(({ ctx, input }) =>
          renderInstancePdf(ctx.user.id, input.instanceId, input.mode)
        ),
      structured: protectedProcedure
        .input(
          z.object({
            instanceId: z.string().min(1),
            format: z.enum(["json", "csv"]),
          })
        )
        .mutation(({ ctx, input }) =>
          exportStructuredInstance(ctx.user.id, input.instanceId, input.format)
        ),
      batchPdf: protectedProcedure
        .input(
          z.object({
            instanceIds: z.array(z.string().min(1)).min(1).max(1000),
            mode: z.enum(["full", "overlay", "editable"]),
            copies: z.number().int().min(1).max(20).default(1),
            separatorPage: z.boolean().default(false),
            titlePage: z.boolean().default(false),
            pageNumbers: z.array(z.number().int().min(1)).max(100).optional(),
            itemOptions: z
              .record(
                z.string(),
                z.object({
                  copies: z.number().int().min(1).max(20).optional(),
                  pageNumbers: z
                    .array(z.number().int().min(1))
                    .max(100)
                    .optional(),
                })
              )
              .optional(),
          })
        )
        .mutation(({ ctx, input }) => createBatchPdf(ctx.user.id, input)),
      calibrationTest: protectedProcedure
        .input(
          z.object({
            templateId: z.string().min(1),
            xOffsetMm: z.number().min(-50).max(50),
            yOffsetMm: z.number().min(-50).max(50),
            xScale: z.number().min(80).max(120),
            yScale: z.number().min(80).max(120),
          })
        )
        .mutation(({ ctx, input }) =>
          createCalibrationTestPage(ctx.user.id, input)
        ),
    }),
  }),
});

export type AppRouter = typeof appRouter;
