/**
 * Local-first repository. Every record is read from and atomically committed to the
 * account Workspace hosted by the localhost Local Data Folder service.
 */
import {
  createStableId,
  hashVersionSnapshot,
  requireVersionTransition,
  sha256,
  type JsonValue,
} from "./domain";
import {
  mutateWorkspace,
  readWorkspace,
  type LocalField,
  type LocalInstance,
  type LocalTemplateVersion,
} from "./workspaceStore";
import {
  validateFieldValues,
  validateTemplateFields,
  type ValidatableField,
} from "../../shared/fieldValidation";
import { normalizeInstanceValuesForStorage, renderServerIssue } from "../../shared/tableFormula";

import {
  deleteLocalAsset,
  deleteLocalTemplateAssets,
  describeLocalWorkspaceV2,
  listLocalAssets,
  LocalServiceRequestError,
  queryLocalWorkspaceV2,
  queryLocalWorkspaceJournalInternal,
  queryManyLocalWorkspaceV2,
  transactLocalWorkspaceV2,
  type LocalWorkspaceV2Collection,
  type LocalWorkspaceV2Transaction,
} from "./localServiceClient";

export type FieldDraft = {
  stableFieldId: string;
  fieldType: string;
  displayOrder: number;
  definition: JsonValue;
  coordinate: JsonValue;
};

export type TemplateDraft = {
  name: string;
  description?: string;
  note?: string;
  pageManifest: JsonValue;
  fields: FieldDraft[];
  printSettings: JsonValue;
};

const ownerKey = (ownerId: string | number) => String(ownerId);
const now = () => Date.now();

/**
 * Revision conflicts are retried by rebuilding the request against the newest
 * Instance snapshot. A transport failure (connection reset, socket close, a
 * response lost after the transaction was already committed) is *ambiguous*:
 * the mutation may or may not have happened. Those are resolved by re-sending
 * the byte-identical request and relying on v2 applied-transaction
 * idempotency -- never by rebuilding, which would mint a new transactionId,
 * updatedAt and payload and could apply the mutation twice.
 */
const V2_REVISION_CONFLICT_ATTEMPT_LIMIT = 5;
const V2_TRANSPORT_AMBIGUITY_REPLAY_LIMIT = 2;
// Stable, trilingual safe codes: the client resolves them from the catalog so
// no raw Traditional Chinese is ever leaked into an English or Simplified UI.
const V2_TRANSPORT_UNCONFIRMED_CODE = "v2_transport_unconfirmed";
const V2_BUSY_CODE = "v2_busy";

function isV2RevisionConflict(error: unknown) {
  return (
    error instanceof LocalServiceRequestError &&
    error.code === "workspace_v2_revision_conflict"
  );
}

async function v2TransactionWithRetry(
  owner: string,
  build: (attempt: number) => Promise<LocalWorkspaceV2Transaction>
) {
  let sawTransportAmbiguity = false;
  for (let attempt = 0; attempt < V2_REVISION_CONFLICT_ATTEMPT_LIMIT; attempt += 1) {
    const request = await build(attempt);
    try {
      return await transactLocalWorkspaceV2(owner, request);
    } catch (error) {
      // Explicit Local Service / HTTP business errors are never retried blindly.
      if (error instanceof LocalServiceRequestError) {
        if (error.code === "workspace_v2_revision_conflict") continue;
        throw error;
      }
      sawTransportAmbiguity = true;
      let conflictOnReplay = false;
      for (let replay = 0; replay < V2_TRANSPORT_AMBIGUITY_REPLAY_LIMIT; replay += 1) {
        try {
          return await transactLocalWorkspaceV2(owner, request);
        } catch (replayError) {
          if (replayError instanceof LocalServiceRequestError) {
            if (replayError.code === "workspace_v2_revision_conflict") {
              // The byte-identical request was not applied; someone else moved
              // the workspace forward. Fall back to the CAS rebuild path.
              conflictOnReplay = true;
              break;
            }
            throw replayError;
          }
        }
      }
      // Bounded: never loop forever on an unresolvable transport failure.
      // The Traditional Chinese fallback keeps the historical server-side message
      // (contains "無法確認") for any consumer that has not been updated yet; the
      // structured code lets the client render a fully localized message instead.
      if (!conflictOnReplay) throw new Error(renderServerIssue(V2_TRANSPORT_UNCONFIRMED_CODE, {}, "本機資料服務連線中斷，交易結果無法確認；請稍後再試。"));
    }
  }
  const transportCode = sawTransportAmbiguity ? V2_TRANSPORT_UNCONFIRMED_CODE : V2_BUSY_CODE;
  const transportFallback =
    sawTransportAmbiguity
      ? "本機資料服務連線中斷，交易結果無法確認；請稍後再試。"
      : "工作區資料忙碌中，請稍後再試。";
  throw new Error(renderServerIssue(transportCode, {}, transportFallback));
}

async function v2InstanceWithRevision(owner: string, instanceId: string) {
  const result = await queryLocalWorkspaceV2<LocalInstance>(owner, {
    collection: "instances", where: { id: instanceId }, limit: 1,
  });
  return { instance: result.records[0], revision: result.revision };
}

async function v2Instance(owner: string, instanceId: string) {
  const { instance } = await v2InstanceWithRevision(owner, instanceId);
  return instance;
}

async function v2RecordsByIds<T>(
  owner: string,
  collection: LocalWorkspaceV2Collection,
  ids: string[]
) {
  const records: T[] = [];
  const unique = Array.from(new Set(ids));
  for (let offset = 0; offset < unique.length; offset += 1_000) {
    const page = await queryManyLocalWorkspaceV2<T>(owner, {
      collection,
      key: "id",
      values: unique.slice(offset, offset + 1_000),
    });
    records.push(...page.records);
  }
  return records;
}

function collectRecordAssetIds(value: unknown, output: Set<string>, depth = 0) {
  if (depth > 12 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectRecordAssetIds(item, output, depth + 1);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/assetId$/i.test(key) && typeof child === "string" && /^asset-[\w-]+$/.test(child))
      output.add(child);
    else collectRecordAssetIds(child, output, depth + 1);
  }
}

type PendingAssetCleanup = {
  id: string;
  type: "asset-cleanup";
  status: "pending";
  assetIds: string[];
  deletedInstanceIds: string[];
  discoveryPending: boolean;
  createdAt: number;
  updatedAt: number;
};

function cleanupFailureIsResolved(error: unknown) {
  return (
    error instanceof LocalServiceRequestError &&
    (error.code === "asset_in_use" || error.code === "asset_not_found")
  );
}

async function processPendingAssetCleanup(owner: string, record: PendingAssetCleanup) {
  const candidates = new Set(record.assetIds);
  let discoveryPending = record.discoveryPending;
  try {
    const assets = await listLocalAssets(owner);
    const deletedInstanceIds = new Set(record.deletedInstanceIds);
    for (const asset of assets.assets)
      if (
        typeof asset.metadata?.instanceId === "string" &&
        deletedInstanceIds.has(asset.metadata.instanceId)
      )
        candidates.add(asset.id);
    discoveryPending = false;
  } catch {
    discoveryPending = true;
  }

  const pendingAssetIds: string[] = [];
  let deletedAssets = 0;
  for (const assetId of Array.from(candidates)) {
    try {
      await deleteLocalAsset(owner, assetId);
      deletedAssets += 1;
    } catch (error) {
      if (!cleanupFailureIsResolved(error)) pendingAssetIds.push(assetId);
    }
  }
  await v2TransactionWithRetry(owner, async () => ({
    expectedRevision: (await describeLocalWorkspaceV2(owner)).revision,
    transactionId: `asset-cleanup-${record.id}-${crypto.randomUUID()}`,
    ...(pendingAssetIds.length || discoveryPending
      ? {
          put: [{
            collection: "operationJournal" as const,
            record: {
              ...record,
              assetIds: pendingAssetIds,
              discoveryPending,
              updatedAt: now(),
            } as unknown as Record<string, unknown>,
          }],
        }
      : {
          deleteIds: [{ collection: "operationJournal" as const, ids: [record.id] }],
        }),
    metaPatch: { updatedAt: new Date().toISOString() },
  }));
  return {
    deletedAssets,
    assetCleanupPending: pendingAssetIds.length + (discoveryPending ? 1 : 0),
  };
}

async function retryPendingAssetCleanup(owner: string, onlyId?: string) {
  const page = await queryLocalWorkspaceV2<PendingAssetCleanup>(owner, {
    collection: "operationJournal",
    where: onlyId ? { id: onlyId } : { status: "pending" },
    limit: 100,
    order: "asc",
  });
  const records = page.records.filter(
    record => record.type === "asset-cleanup" && (!onlyId || record.id === onlyId)
  );
  let deletedAssets = 0;
  let assetCleanupPending = 0;
  for (const record of records) {
    try {
      const result = await processPendingAssetCleanup(owner, record);
      deletedAssets += result.deletedAssets;
      assetCleanupPending += result.assetCleanupPending;
    } catch {
      assetCleanupPending += record.assetIds.length + (record.discoveryPending ? 1 : 0);
    }
  }
  return { deletedAssets, assetCleanupPending };
}

export async function listInstancesPageForOwner(
  ownerId: string | number,
  cursor: string | null = null,
  limit = 500
) {
  const owner = ownerKey(ownerId);
  await describeLocalWorkspaceV2(owner);
  return queryLocalWorkspaceV2<LocalInstance>(owner, {
    collection: "instances",
    limit: Math.max(1, Math.min(1_000, limit)),
    cursor,
    order: "desc",
  });
}

export async function listTemplatesForOwner(ownerId: string | number) {
  const { workspace } = await readWorkspace(ownerKey(ownerId));
  return [...workspace.templates].sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function listInstancesForOwner(ownerId: string | number) {
  // Compatibility view for the current UI. It is deliberately bounded; new
  // large-data callers use listInstancesPageForOwner and its authenticated
  // cursor instead of materialising the full account.
  const page = await listInstancesPageForOwner(ownerId, null, 1_000);
  return page.records.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function searchTemplatesForOwner(
  ownerId: string | number,
  query: string
) {
  const { workspace } = await readWorkspace(ownerKey(ownerId));
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return workspace.templates;
  const matchedIds = new Set<string>();
  for (const template of workspace.templates)
    if (
      `${template.name} ${template.description ?? ""}`
        .toLocaleLowerCase()
        .includes(needle)
    )
      matchedIds.add(template.id);
  for (const version of workspace.templateVersions)
    if ((version.note ?? "").toLocaleLowerCase().includes(needle))
      matchedIds.add(version.templateId);
  for (const field of workspace.fields) {
    const definition =
      field.definition &&
      typeof field.definition === "object" &&
      !Array.isArray(field.definition)
        ? (field.definition as Record<string, unknown>)
        : {};
    if (
      String(definition.label ?? field.stableFieldId)
        .toLocaleLowerCase()
        .includes(needle)
    ) {
      const version = workspace.templateVersions.find(
        item => item.id === field.templateVersionId
      );
      if (version) matchedIds.add(version.templateId);
    }
  }
  return workspace.templates.filter(template => matchedIds.has(template.id));
}

export async function touchTemplate(
  ownerId: string | number,
  templateId: string
) {
  return mutateWorkspace(ownerKey(ownerId), "template.open", workspace => {
    const template = workspace.templates.find(item => item.id === templateId);
    if (!template) throw new Error("找不到指定 Template。");
    template.lastOpenedAt = now();
    return { lastOpenedAt: template.lastOpenedAt };
  });
}

export async function createTemplateDraft(
  ownerId: string | number,
  input: TemplateDraft
) {
  const owner = ownerKey(ownerId);
  return mutateWorkspace(owner, "template.create-draft", workspace => {
    const createdAt = now();
    const templateId = createStableId("tpl");
    const versionId = createStableId("ver");
    const snapshot = {
      schemaVersion: 2,
      templateId,
      pageManifest: input.pageManifest,
      fieldSnapshot: input.fields as unknown as JsonValue,
      printSettings: input.printSettings,
    };
    const contentHash = hashVersionSnapshot(snapshot);
    workspace.templates.push({
      id: templateId,
      ownerId: owner,
      name: input.name,
      description: input.description ?? null,
      lifecycle: "draft",
      currentPublishedVersionId: null,
      currentDraftVersionId: versionId,
      schemaVersion: 2,
      folderIds: [],
      tagIds: [],
      favorite: false,
      pinned: false,
      printProfile: {},
      instanceNamePattern: "{Template名稱}_{日期}_{時間}",
      keyFieldIds: [],
      createdAt,
      updatedAt: createdAt,
      lastOpenedAt: createdAt,
    });
    workspace.templateVersions.push({
      id: versionId,
      templateId,
      versionNumber: 1,
      state: "draft",
      schemaVersion: 2,
      contentHash,
      note: input.note ?? null,
      pageManifest: input.pageManifest,
      fieldSnapshot: input.fields,
      printSettings: input.printSettings,
      publishedAt: null,
      createdAt,
      updatedAt: createdAt,
    });
    workspace.fields.push(
      ...input.fields.map(field => ({
        id: createStableId("fld"),
        templateVersionId: versionId,
        stableFieldId: field.stableFieldId,
        fieldType: field.fieldType,
        displayOrder: field.displayOrder,
        definition: field.definition,
        coordinate: field.coordinate,
        createdAt,
      }))
    );
    return { templateId, versionId, contentHash };
  });
}

export async function getTemplateVersionForOwner(
  ownerId: string | number,
  versionId: string
) {
  const { workspace } = await readWorkspace(ownerKey(ownerId));
  const version = workspace.templateVersions.find(
    item => item.id === versionId
  );
  if (!version) throw new Error("找不到指定版本。");
  const template = workspace.templates.find(
    item => item.id === version.templateId
  );
  if (!template) throw new Error("無權存取此 Template Version。");
  return { template, version };
}

export async function getTemplateVersionDetailsForOwner(
  ownerId: string | number,
  versionId: string
) {
  const { workspace } = await readWorkspace(ownerKey(ownerId));
  const version = workspace.templateVersions.find(
    item => item.id === versionId
  );
  if (!version) throw new Error("找不到指定版本。");
  const template = workspace.templates.find(
    item => item.id === version.templateId
  );
  if (!template) throw new Error("無權存取此 Template Version。");
  const versionFields = workspace.fields
    .filter(field => field.templateVersionId === version.id)
    .sort((a, b) => a.displayOrder - b.displayOrder);
  return { template, version, fields: versionFields };
}

export async function getInstanceForOwner(
  ownerId: string | number,
  instanceId: string
) {
  const owner = ownerKey(ownerId);
  const { workspace } = await readWorkspace(owner);
  const instance = await v2Instance(owner, instanceId);
  if (!instance) throw new Error("找不到指定 Instance，或您沒有存取權限。");
  const version = workspace.templateVersions.find(
    item => item.id === instance.templateVersionId
  );
  const template = workspace.templates.find(
    item => item.id === instance.templateId
  );
  if (
    !version ||
    !template ||
    version.contentHash !== instance.templateVersionHash
  )
    throw new Error("Instance 綁定的 Template Version hash 不一致。");
  const versionFields = workspace.fields
    .filter(field => field.templateVersionId === version.id)
    .sort((a, b) => a.displayOrder - b.displayOrder);
  return { instance, template, version, fields: versionFields };
}

export async function updateDraftTemplateFields(
  ownerId: string | number,
  versionId: string,
  input: { fields: FieldDraft[]; printSettings?: JsonValue }
) {
  const owner = ownerKey(ownerId);
  return mutateWorkspace(owner, "template.save-draft", workspace => {
    const version = workspace.templateVersions.find(
      item => item.id === versionId
    );
    if (!version) throw new Error("找不到指定版本。");
    if (version.state !== "draft")
      throw new Error(
        "已發佈或取代的 Template Version 不可修改；請建立新的 Draft Version。"
      );
    const updatedAt = now();
    const printSettings = input.printSettings ?? version.printSettings;
    const contentHash = hashVersionSnapshot({
      schemaVersion: version.schemaVersion,
      templateId: version.templateId,
      pageManifest: version.pageManifest as JsonValue,
      fieldSnapshot: input.fields as unknown as JsonValue,
      printSettings: printSettings as JsonValue,
    });
    workspace.fields = workspace.fields.filter(
      field => field.templateVersionId !== version.id
    );
    workspace.fields.push(
      ...input.fields.map(field => ({
        id: createStableId("fld"),
        templateVersionId: version.id,
        stableFieldId: field.stableFieldId,
        fieldType: field.fieldType,
        displayOrder: field.displayOrder,
        definition: field.definition,
        coordinate: field.coordinate,
        createdAt: updatedAt,
      }))
    );
    version.fieldSnapshot = input.fields;
    version.printSettings = printSettings;
    version.contentHash = contentHash;
    version.updatedAt = updatedAt;
    const template = workspace.templates.find(
      item => item.id === version.templateId
    );
    if (template) template.updatedAt = updatedAt;
    return { versionId: version.id, contentHash, updatedAt };
  });
}

export async function cloneTemplateVersionToDraft(
  ownerId: string | number,
  sourceVersionId: string,
  note?: string
) {
  const owner = ownerKey(ownerId);
  return mutateWorkspace(owner, "template.clone-to-draft", workspace => {
    const version = workspace.templateVersions.find(
      item => item.id === sourceVersionId
    );
    if (!version) throw new Error("找不到指定版本。");
    if (version.state === "draft")
      throw new Error("Draft Version 已可直接修改，不需要複製。");
    const template = workspace.templates.find(
      item => item.id === version.templateId
    );
    if (!template) throw new Error("找不到 Template。");
    if (template.currentDraftVersionId)
      throw new Error(
        "此 Template 已有未完成的 Draft；請先開啟或處理該 Draft。"
      );
    const sourceFields = workspace.fields
      .filter(field => field.templateVersionId === version.id)
      .sort((a, b) => a.displayOrder - b.displayOrder);
    const nextVersionNumber =
      Math.max(
        0,
        ...workspace.templateVersions
          .filter(item => item.templateId === template.id)
          .map(item => item.versionNumber)
      ) + 1;
    const versionId = createStableId("ver");
    const createdAt = now();
    const fieldDrafts: FieldDraft[] = sourceFields.map(field => ({
      stableFieldId: field.stableFieldId,
      fieldType: field.fieldType,
      displayOrder: field.displayOrder,
      definition: field.definition as JsonValue,
      coordinate: field.coordinate as JsonValue,
    }));
    const contentHash = hashVersionSnapshot({
      schemaVersion: version.schemaVersion,
      templateId: template.id,
      pageManifest: version.pageManifest as JsonValue,
      fieldSnapshot: fieldDrafts as unknown as JsonValue,
      printSettings: version.printSettings as JsonValue,
    });
    workspace.templateVersions.push({
      id: versionId,
      templateId: template.id,
      versionNumber: nextVersionNumber,
      state: "draft",
      schemaVersion: version.schemaVersion,
      contentHash,
      note: note ?? `Copied from v${version.versionNumber}`,
      pageManifest: version.pageManifest,
      fieldSnapshot: fieldDrafts,
      printSettings: version.printSettings,
      publishedAt: null,
      createdAt,
      updatedAt: createdAt,
    });
    workspace.fields.push(
      ...fieldDrafts.map(field => ({
        id: createStableId("fld"),
        templateVersionId: versionId,
        stableFieldId: field.stableFieldId,
        fieldType: field.fieldType,
        displayOrder: field.displayOrder,
        definition: field.definition,
        coordinate: field.coordinate,
        createdAt,
      }))
    );
    template.lifecycle = "draft";
    template.currentDraftVersionId = versionId;
    template.updatedAt = createdAt;
    return {
      templateId: template.id,
      versionId,
      versionNumber: nextVersionNumber,
      contentHash,
    };
  });
}

export async function publishTemplateVersion(
  ownerId: string | number,
  versionId: string
) {
  const owner = ownerKey(ownerId);
  return mutateWorkspace(owner, "template.publish", workspace => {
    const version = workspace.templateVersions.find(
      item => item.id === versionId
    );
    if (!version) throw new Error("找不到指定版本。");
    requireVersionTransition(version.state, "published");
    const versionFields = workspace.fields.filter(
      field => field.templateVersionId === version.id
    );
    if (!versionFields.length)
      throw new Error("Template 至少需要一個已確認欄位才可發佈。");
    const incomplete = versionFields.filter(field => {
      const definition = field.definition as {
        label?: string;
        confirmed?: boolean;
      } | null;
      return !definition?.label?.trim() || definition.confirmed === false;
    });
    if (incomplete.length)
      throw new Error(`仍有 ${incomplete.length} 個欄位未命名或未經人工確認。`);
    const templateValidationIssues = validateTemplateFields(versionFields);
    if (templateValidationIssues.some(issue => issue.blocking)) {
      // The server has no UI locale: return the stable code + safe params so the
      // client can render the message in the active language from the catalog,
      // without reverse-parsing the Traditional Chinese diagnostic.
      const first = templateValidationIssues.find(issue => issue.blocking)!;
      throw new Error(`Template 發佈失敗：${renderServerIssue(first.code, first.params ?? {}, first.message)}`);
    }
    const template = workspace.templates.find(
      item => item.id === version.templateId
    );
    if (!template) throw new Error("找不到 Template。");
    const publishedAt = now();
    for (const previous of workspace.templateVersions.filter(
      item => item.templateId === template.id && item.state === "published"
    )) {
      previous.state = "superseded";
      previous.updatedAt = publishedAt;
    }
    version.state = "published";
    version.publishedAt = publishedAt;
    version.updatedAt = publishedAt;
    template.lifecycle = "published";
    template.currentPublishedVersionId = version.id;
    template.currentDraftVersionId = null;
    template.updatedAt = publishedAt;
    return { versionId: version.id, publishedAt };
  });
}

export async function createInstanceFromPublishedVersion(
  ownerId: string | number,
  input: {
    templateVersionId: string;
    name: string;
    values: Record<string, string>;
  }
) {
  const owner = ownerKey(ownerId);
  const { workspace } = await readWorkspace(owner);
  const version = workspace.templateVersions.find(
      item => item.id === input.templateVersionId
  );
  if (!version || (version.state !== "published" && version.state !== "superseded"))
    throw new Error("只能從已發佈的 Template Version 建立 Instance。");
  const template = workspace.templates.find(
      item => item.id === version.templateId
  );
  if (!template) throw new Error("找不到 Template。");
  const versionFields = workspace.fields.filter(
    field => field.templateVersionId === version.id
  );
  const normalizedValues = normalizeInstanceValuesForStorage(input.values, versionFields);
  const createdAt = now();
  const valuesHash = sha256(normalizedValues);
  const instanceId = createStableId("ins");
  const instance: LocalInstance = {
    id: instanceId, ownerId: owner, templateId: template.id,
    templateVersionId: version.id, templateVersionHash: version.contentHash,
    schemaVersion: 2, name: input.name, status: "draft", values: normalizedValues,
    valuesHash, printCount: 0, createdAt, updatedAt: createdAt,
    completedAt: null, lastPrintedAt: null, outputHistory: [],
  };
  await v2TransactionWithRetry(owner, async attempt => ({
    expectedRevision: (await describeLocalWorkspaceV2(owner)).revision,
    transactionId: `instance-create-${instanceId}-${attempt}`,
    put: [{ collection: "instances", record: instance as unknown as Record<string, unknown> }],
    metaPatch: { updatedAt: new Date(createdAt).toISOString() },
  }));
  return { instanceId, valuesHash };
}

export async function saveInstanceValues(
  ownerId: string | number,
  instanceId: string,
  values: Record<string, string>
) {
  const owner = ownerKey(ownerId);
  let result = { instanceId, valuesHash: "", updatedAt: 0 };
  await v2TransactionWithRetry(owner, async () => {
    const { instance, revision } = await v2InstanceWithRevision(owner, instanceId);
    if (!instance) throw new Error("找不到指定 Instance，或您沒有存取權限。");
    const { workspace } = await readWorkspace(owner);
    const versionFields = workspace.fields.filter(
      field => field.templateVersionId === instance.templateVersionId
    );
    const normalizedValues = normalizeInstanceValuesForStorage(values, versionFields);
    const updatedAt = now();
    const valuesHash = sha256(normalizedValues);
    result = { instanceId, valuesHash, updatedAt };
    return {
      expectedRevision: revision,
      transactionId: `instance-save-${instanceId}-${crypto.randomUUID()}`,
      put: [{ collection: "instances", record: {
        ...instance, values: normalizedValues, valuesHash, updatedAt,
      } as unknown as Record<string, unknown> }],
      metaPatch: { updatedAt: new Date(updatedAt).toISOString() },
    };
  });
  return result;
}

function assertInstanceCanBeCompletedOrPrinted(
  instance: LocalInstance,
  versionFields: LocalField[],
  targetStatus: "completed" | "printed"
) {
  const issues = validateFieldValues(instance.values, versionFields as ValidatableField[]);
  const blockingIssues = issues.filter(i => i.blocking);
  if (blockingIssues.length > 0) {
    const first = blockingIssues[0]!;
    throw new Error(
      `無法將狀態更新為 ${targetStatus}，表單包含 ${blockingIssues.length} 項驗證錯誤：${renderServerIssue(first.code, first.params ?? {}, first.message)}`
    );
  }
}

/**
 * A single output/print invocation is one logical event. The same asset can
 * legitimately be reused by a later event with a different mode, format or
 * printedAt, so `assetId` alone is not an event identity -- using it as one
 * both swallows legitimate events and makes v2 reject the second call with
 * TRANSACTION_ID_REUSE (same transactionId, different request hash).
 *
 * The operation id is created once per public invocation and is reused by
 * every CAS rebuild and every byte-identical transport replay, so a replay
 * can never double-count history or printCount.
 */
function createOutputOperationId() {
  return crypto.randomUUID().replace(/-/g, "");
}

function outputEventIdentityKey(event: unknown): string {
  if (event === null || typeof event !== "object") return `v:${String(event)}`;
  if (Array.isArray(event)) return `a:${event.map(outputEventIdentityKey).join("|")}`;
  const source = event as Record<string, unknown>;
  const operationId = source.operationId;
  if (typeof operationId === "string" && operationId.length > 0) return `op:${operationId}`;
  // Legacy entries written before operationId existed fall back to a full
  // canonical comparison of the stored event.
  return `c:${Object.keys(source)
    .sort()
    .map(key => `${key}=${outputEventIdentityKey(source[key])}`)
    .join("\u0000")}`;
}

export async function recordInstanceOutput(
  ownerId: string | number,
  instanceId: string,
  output: Record<string, unknown>,
  printed = false
) {
  const owner = ownerKey(ownerId);
  const operationId = createOutputOperationId();
  const outputEvent: Record<string, unknown> = { ...output, operationId };
  let result: LocalInstance | undefined;
  await v2TransactionWithRetry(owner, async attempt => {
    const { instance, revision } = await v2InstanceWithRevision(owner, instanceId);
    if (!instance) throw new Error("找不到指定 Instance。");

    if (printed) {
      const { workspace } = await readWorkspace(owner);
      const versionFields = workspace.fields.filter(
        f => f.templateVersionId === instance.templateVersionId
      );
      assertInstanceCanBeCompletedOrPrinted(instance, versionFields, "printed");
    }

    const existingHistory = Array.isArray(instance.outputHistory) ? instance.outputHistory : [];
    const eventKey = outputEventIdentityKey(outputEvent);
    const alreadyRecorded = existingHistory.some(
      (item: unknown) => outputEventIdentityKey(item) === eventKey
    );
    const outputHistory = alreadyRecorded ? existingHistory : [...existingHistory, outputEvent];

    const updatedAt = now();
    const updated: LocalInstance = {
      ...instance,
      outputHistory,
      updatedAt,
    };
    // printCount must stay consistent with history: replaying the same logical
    // event must not inflate the count.
    if (printed && !alreadyRecorded) {
      updated.printCount = (instance.printCount ?? 0) + 1;
      updated.lastPrintedAt = updatedAt;
      updated.status = "printed";
    } else if (printed) {
      updated.status = "printed";
    }
    result = updated;
    return {
      expectedRevision: revision,
      transactionId: `instance-output-${instanceId}-${operationId}-${attempt}`,
      put: [{ collection: "instances", record: updated as unknown as Record<string, unknown> }],
      metaPatch: { updatedAt: new Date(updatedAt).toISOString() },
    };
  });
  return result!;
}

/** The guide only counts a review when it belongs to a real saved output. */
export async function hasReviewedOutputForVersion(
  ownerId: string | number,
  versionId: string
): Promise<boolean> {
  const { version } = await getTemplateVersionForOwner(ownerId, versionId);
  if (version.state === "draft") return false;
  const owner = ownerKey(ownerId);
  let cursor: string | null = null;
  do {
    // A single Instance can hold a sizeable output history. Keep each page
    // below the service response limit while still checking every Instance.
    const page: { records: LocalInstance[]; nextCursor: string | null } = await queryLocalWorkspaceV2<LocalInstance>(owner, {
      collection: "instances",
      where: { templateVersionId: versionId },
      cursor,
      limit: 5,
      order: "desc",
    });
    if (page.records.some(instance =>
      instance.templateVersionHash === version.contentHash &&
      Array.isArray(instance.outputHistory) &&
      instance.outputHistory.some(event => event !== null && typeof event === "object" &&
        typeof event.assetId === "string" && event.assetId.length > 0 &&
        typeof event.checkedAt === "number" && Number.isFinite(event.checkedAt) && event.checkedAt > 0
      )
    )) return true;
    cursor = page.nextCursor;
  } while (cursor);
  return false;
}

export async function confirmInstanceOutputChecked(
  ownerId: string | number,
  instanceId: string,
  assetId: string
): Promise<LocalInstance> {
  const owner = ownerKey(ownerId);
  const checkedAt = now();
  const operationId = createOutputOperationId();
  class AlreadyChecked extends Error {
    constructor(readonly instance: LocalInstance) { super("already checked"); }
  }
  let result: LocalInstance | undefined;
  try {
    await v2TransactionWithRetry(owner, async attempt => {
      const { instance, revision } = await v2InstanceWithRevision(owner, instanceId);
      if (!instance) throw new Error("找不到指定 Instance。");
      const { version } = await getTemplateVersionForOwner(ownerId, instance.templateVersionId);
      if (version.contentHash !== instance.templateVersionHash)
        throw new Error("Instance 綁定的 Template Version hash 不一致。");
      const history = Array.isArray(instance.outputHistory) ? instance.outputHistory : [];
      let index = -1;
      for (let i = history.length - 1; i >= 0; i -= 1) {
        if (history[i]?.assetId === assetId) { index = i; break; }
      }
      if (index < 0) throw new Error("找不到這份已產生的輸出，請重新輸出後再檢查。");
      if (typeof history[index]?.checkedAt === "number") throw new AlreadyChecked(instance);
      const outputHistory = history.map((event, i) => i === index ? { ...event, checkedAt } : event);
      const updated: LocalInstance = { ...instance, outputHistory, updatedAt: checkedAt };
      result = updated;
      return {
        expectedRevision: revision,
        transactionId: `instance-output-check-${instanceId}-${operationId}-${attempt}`,
        put: [{ collection: "instances", record: updated as unknown as Record<string, unknown> }],
        metaPatch: { updatedAt: new Date(checkedAt).toISOString() },
      };
    });
  } catch (error) {
    if (error instanceof AlreadyChecked) return error.instance;
    throw error;
  }
  return result!;
}

export async function listTemplateVersionsForOwner(
  ownerId: string | number,
  templateId: string
) {
  const { workspace } = await readWorkspace(ownerKey(ownerId));
  const template = workspace.templates.find(item => item.id === templateId);
  if (!template) throw new Error("找不到指定 Template。");
  return workspace.templateVersions
    .filter(item => item.templateId === template.id)
    .sort((a, b) => b.versionNumber - a.versionNumber);
}

export async function updateTemplateMetadata(
  ownerId: string | number,
  templateId: string,
  patch: {
    name?: string;
    description?: string | null;
    favorite?: boolean;
    pinned?: boolean;
    folderIds?: string[];
    tagIds?: string[];
    instanceNamePattern?: string;
    keyFieldIds?: string[];
  }
) {
  return mutateWorkspace(
    ownerKey(ownerId),
    "template.update-metadata",
    workspace => {
      const template = workspace.templates.find(item => item.id === templateId);
      if (!template) throw new Error("找不到指定 Template。");
      if (patch.name !== undefined) template.name = patch.name.trim();
      if (patch.description !== undefined)
        template.description = patch.description;
      if (patch.favorite !== undefined) template.favorite = patch.favorite;
      if (patch.pinned !== undefined) template.pinned = patch.pinned;
      if (patch.folderIds !== undefined)
        template.folderIds = Array.from(new Set(patch.folderIds));
      if (patch.tagIds !== undefined)
        template.tagIds = Array.from(new Set(patch.tagIds));
      if (patch.instanceNamePattern !== undefined)
        template.instanceNamePattern = patch.instanceNamePattern;
      if (patch.keyFieldIds !== undefined)
        template.keyFieldIds = Array.from(new Set(patch.keyFieldIds));
      template.updatedAt = now();
      return template;
    }
  );
}

export async function saveTemplatePrintProfile(
  ownerId: string | number,
  templateId: string,
  printProfile: Record<string, unknown>
) {
  return mutateWorkspace(
    ownerKey(ownerId),
    "template.save-print-profile",
    workspace => {
      const template = workspace.templates.find(item => item.id === templateId);
      if (!template) throw new Error("找不到指定 Template。");
      template.printProfile = { ...printProfile, updatedAt: now() };
      template.updatedAt = now();
      return template.printProfile;
    }
  );
}

export async function updateDraftPageManifest(
  ownerId: string | number,
  versionId: string,
  pageManifest: JsonValue
) {
  return mutateWorkspace(
    ownerKey(ownerId),
    "template.save-pages",
    workspace => {
      const version = workspace.templateVersions.find(
        item => item.id === versionId
      );
      if (!version || version.state !== "draft")
        throw new Error("只有 Draft Version 可修改頁面。");
      version.pageManifest = pageManifest;
      version.contentHash = hashVersionSnapshot({
        schemaVersion: version.schemaVersion,
        templateId: version.templateId,
        pageManifest,
        fieldSnapshot: version.fieldSnapshot as JsonValue,
        printSettings: version.printSettings as JsonValue,
      });
      version.updatedAt = now();
      const template = workspace.templates.find(
        item => item.id === version.templateId
      );
      if (template) template.updatedAt = version.updatedAt;
      return {
        versionId,
        contentHash: version.contentHash,
        updatedAt: version.updatedAt,
      };
    }
  );
}

export async function deleteTemplateForOwner(
  ownerId: string | number,
  templateId: string
) {
  const owner = ownerKey(ownerId);
  const { workspace: currentWorkspace } = await readWorkspace(owner);
  const currentTemplate = currentWorkspace.templates.find(item => item.id === templateId);
  if (!currentTemplate) throw new Error("找不到指定 Template。");
  // Templates remain in the small v1 metadata domain while Instances and CSV
  // runs are authoritative in v2. Refuse a cross-store cascade instead of
  // risking a crash between two independent commits. The user can delete the
  // dependent records first; once none remain, the template delete is atomic.
  const relatedInstance = await queryLocalWorkspaceV2<LocalInstance>(owner, {
    collection: "instances",
    where: { templateId },
    limit: 1,
  });
  let hasRelatedImport = false;
  for (const version of currentWorkspace.templateVersions.filter(item => item.templateId === templateId)) {
    const runs = await queryLocalWorkspaceV2<Record<string, unknown>>(owner, {
      collection: "importRuns",
      where: { templateVersionId: version.id },
      limit: 1,
    });
    if (runs.records.length) {
      hasRelatedImport = true;
      break;
    }
  }
  if (relatedInstance.records.length || hasRelatedImport)
    throw new Error("此 Template 尚有 Instance 或 CSV 匯入紀錄；請先刪除相關資料，避免跨儲存層的不完整刪除。");
  const result = await mutateWorkspace(owner, "template.delete", workspace => {
    const template = workspace.templates.find(item => item.id === templateId);
    if (!template) throw new Error("找不到指定 Template。");
    const versionIds = new Set(
      workspace.templateVersions
        .filter(item => item.templateId === templateId)
        .map(item => item.id)
    );
    const instanceIds = new Set(
      workspace.instances
        .filter(item => item.templateId === templateId)
        .map(item => item.id)
    );
    const mappingIds = new Set(
      workspace.mappingTemplates
        .filter(item => versionIds.has(String(item.templateVersionId)))
        .map(item => String(item.id))
    );
    const runIds = new Set(
      workspace.importRuns
        .filter(item => versionIds.has(String(item.templateVersionId)))
        .map(item => String(item.id))
    );
    workspace.templates = workspace.templates.filter(
      item => item.id !== templateId
    );
    workspace.templateVersions = workspace.templateVersions.filter(
      item => !versionIds.has(item.id)
    );
    workspace.fields = workspace.fields.filter(
      item => !versionIds.has(item.templateVersionId)
    );
    workspace.instances = workspace.instances.filter(
      item => !instanceIds.has(item.id)
    );
    workspace.savedValues = workspace.savedValues.filter(
      item => item.templateId !== templateId
    );
    workspace.mappingTemplates = workspace.mappingTemplates.filter(
      item => !mappingIds.has(String(item.id))
    );
    workspace.importRuns = workspace.importRuns.filter(
      item => !runIds.has(String(item.id))
    );
    workspace.importRows = workspace.importRows.filter(
      item => !runIds.has(String(item.importRunId))
    );
    workspace.mappingDecisions = workspace.mappingDecisions.filter(
      item => !runIds.has(String(item.importRunId))
    );
    return { deleted: true, templateId };
  });
  const assets = await deleteLocalTemplateAssets(owner, templateId);
  return { ...result, deletedAssets: assets.deleted };
}

export async function cloneInstanceForOwner(
  ownerId: string | number,
  instanceId: string,
  clearMedia: boolean
) {
  const owner = ownerKey(ownerId);
  const { workspace } = await readWorkspace(owner);
  const source = await v2Instance(owner, instanceId);
  if (!source) throw new Error("找不到指定 Instance。");
  const versionFields = workspace.fields.filter(
    field => field.templateVersionId === source.templateVersionId
  );
  const mediaIds = new Set(
    versionFields
      .filter(
        field => field.fieldType === "image" || field.fieldType === "signature"
      )
      .map(field => field.stableFieldId)
  );
  const rawValues = Object.fromEntries(
    Object.entries(source.values).map(([key, value]) => [
      key,
      clearMedia && mediaIds.has(key) ? "" : value,
    ])
  );
  const values = normalizeInstanceValuesForStorage(rawValues, versionFields);
  const createdAt = now();
  const id = createStableId("ins");
  const clone: LocalInstance = {
    ...source,
    id,
    name: `${source.name}（副本）`,
    status: "draft",
    values,
    valuesHash: sha256(values),
    printCount: 0,
    outputHistory: [],
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
    lastPrintedAt: null,
  };
  await v2TransactionWithRetry(owner, async attempt => ({
    expectedRevision: (await describeLocalWorkspaceV2(owner)).revision,
    transactionId: `instance-clone-${id}-${attempt}`,
    put: [{ collection: "instances", record: clone as unknown as Record<string, unknown> }],
    metaPatch: { updatedAt: new Date(createdAt).toISOString() },
  }));
  return { instanceId: id };
}

export async function updateInstanceStatus(
  ownerId: string | number,
  instanceId: string,
  status: "draft" | "completed" | "printed"
) {
  const owner = ownerKey(ownerId);
  let result: LocalInstance | undefined;
  await v2TransactionWithRetry(owner, async () => {
    const { instance, revision } = await v2InstanceWithRevision(owner, instanceId);
    if (!instance) throw new Error("找不到指定 Instance。");

    if (status === "completed" || status === "printed") {
      const { workspace } = await readWorkspace(owner);
      const versionFields = workspace.fields.filter(
        f => f.templateVersionId === instance.templateVersionId
      );
      assertInstanceCanBeCompletedOrPrinted(instance, versionFields, status);
    }

    const updatedAt = now();
    result = {
      ...instance,
      status,
      updatedAt,
      completedAt:
        status === "completed" && !instance.completedAt
          ? updatedAt
          : instance.completedAt,
    };
    return {
      expectedRevision: revision,
      transactionId: `instance-status-${instanceId}-${crypto.randomUUID()}`,
      put: [{ collection: "instances", record: result as unknown as Record<string, unknown> }],
      metaPatch: { updatedAt: new Date(updatedAt).toISOString() },
    };
  });
  return result!;
}

export async function deleteInstancesForOwner(
  ownerId: string | number,
  instanceIds: string[]
) {
  const owner = ownerKey(ownerId);
  const requested = Array.from(new Set(instanceIds));
  const existing = await v2RecordsByIds<LocalInstance>(owner, "instances", requested);
  if (existing.length !== requested.length)
    throw new Error("部分 Instance 不存在或無權存取。");
  const { workspace } = await readWorkspace(owner);
  const mediaFieldsByVersion = new Map<string, Set<string>>();
  for (const field of workspace.fields) {
    if (field.fieldType !== "image" && field.fieldType !== "signature") continue;
    const fields = mediaFieldsByVersion.get(field.templateVersionId) ?? new Set<string>();
    fields.add(field.stableFieldId);
    mediaFieldsByVersion.set(field.templateVersionId, fields);
  }
  const cleanupAssetIds = new Set<string>();
  for (const instance of existing) {
    const mediaFields = mediaFieldsByVersion.get(instance.templateVersionId);
    for (const stableFieldId of Array.from(mediaFields ?? [])) {
      const value = instance.values[stableFieldId];
      if (typeof value === "string" && /^asset-[\w-]+$/.test(value))
        cleanupAssetIds.add(value);
    }
    collectRecordAssetIds(instance.outputHistory, cleanupAssetIds);
  }
  const cleanupId = `cleanup-${crypto.randomUUID()}`;
  const cleanupRecord: PendingAssetCleanup = {
    id: cleanupId,
    type: "asset-cleanup",
    status: "pending",
    assetIds: Array.from(cleanupAssetIds),
    deletedInstanceIds: requested,
    discoveryPending: true,
    createdAt: now(),
    updatedAt: now(),
  };
  await v2TransactionWithRetry(owner, async () => ({
    expectedRevision: (await describeLocalWorkspaceV2(owner)).revision,
    transactionId: `instance-delete-${crypto.randomUUID()}`,
    put: [{
      collection: "operationJournal",
      record: cleanupRecord as unknown as Record<string, unknown>,
    }],
    deleteIds: [{ collection: "instances", ids: requested }],
    metaPatch: { updatedAt: new Date().toISOString() },
  }));
  const cleanup = await retryPendingAssetCleanup(owner, cleanupId).catch(() => ({
    deletedAssets: 0,
    assetCleanupPending: cleanupRecord.assetIds.length + 1,
  }));
  return {
    deleted: existing.length,
    deletedAssets: cleanup.deletedAssets,
    assetCleanupPending: cleanup.assetCleanupPending,
  };
}

export async function migrateInstancesForOwner(
  ownerId: string | number,
  input: {
    instanceIds: string[];
    targetVersionId: string;
    mapping: Record<string, string | null>;
    deleteOriginals: boolean;
  }
) {
  const owner = ownerKey(ownerId);
  const requested = Array.from(new Set(input.instanceIds));
  const sources = await v2RecordsByIds<LocalInstance>(owner, "instances", requested);
  if (sources.length !== requested.length)
    throw new Error("部分來源 Instance 不存在或無權存取。");
  const { workspace } = await readWorkspace(owner);
  const target = workspace.templateVersions.find(
    version => version.id === input.targetVersionId
  );
  if (
    !target ||
    (target.state !== "published" && target.state !== "superseded")
  )
    throw new Error("目標必須是已發佈 Version。");
  if (sources.some(source => source.templateId !== target.templateId))
    throw new Error("只可在同一 Template 的 Version 之間遷移。");
  if (sources.some(source => source.templateVersionId === target.id))
    throw new Error("來源已綁定目標 Version。");
  const targetFieldsList = workspace.fields.filter(
    field => field.templateVersionId === target.id
  );
  const targetFields = new Set(targetFieldsList.map(field => field.stableFieldId));
  const createdAt = now();
  const created = sources.map(source => {
    const rawValues: Record<string, string> = {};
    for (const [sourceFieldId, targetFieldId] of Object.entries(input.mapping))
      if (targetFieldId && targetFields.has(targetFieldId))
        rawValues[targetFieldId] = source.values[sourceFieldId] ?? "";
    for (const fieldId of Array.from(targetFields))
      if (!(fieldId in rawValues)) rawValues[fieldId] = "";
    const values = normalizeInstanceValuesForStorage(rawValues, targetFieldsList);
    return {
      ...source,
      id: createStableId("ins"),
      templateVersionId: target.id,
      templateVersionHash: target.contentHash,
      name: `${source.name} · v${target.versionNumber}`,
      status: "draft" as const,
      values,
      valuesHash: sha256(values),
      printCount: 0,
      outputHistory: [
        {
          migratedFromInstanceId: source.id,
          migratedFromVersionId: source.templateVersionId,
          createdAt,
        },
      ],
      createdAt,
      updatedAt: createdAt,
      completedAt: null,
      lastPrintedAt: null,
    } satisfies LocalInstance;
  });
  await v2TransactionWithRetry(owner, async () => ({
    expectedRevision: (await describeLocalWorkspaceV2(owner)).revision,
    transactionId: `instance-migrate-${crypto.randomUUID()}`,
    put: created.map(instance => ({
      collection: "instances" as const,
      record: instance as unknown as Record<string, unknown>,
    })),
    ...(input.deleteOriginals
      ? { deleteIds: [{ collection: "instances" as const, ids: requested }] }
      : {}),
    metaPatch: { updatedAt: new Date(createdAt).toISOString() },
  }));
  return {
    created: created.length,
    instanceIds: created.map(instance => instance.id),
    deletedOriginals: input.deleteOriginals ? sources.length : 0,
  };
}

export const JOURNAL_ARCHIVE_RECORD_TYPE = "formdigital.operation-journal-archive";
export const JOURNAL_ARCHIVE_SCHEMA_VERSION = 1;
const MAX_SAFE_EPOCH = 8.64e15;
const MAX_JOURNAL_PAGES = 1_000;
const TOP_N_CANDIDATE_CAPACITY = 200;

export function parseTimestampValue(value: unknown): number | null {
  if (typeof value === "number") {
    if (Number.isFinite(value) && Math.abs(value) <= MAX_SAFE_EPOCH) {
      return value;
    }
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      const num = Number(trimmed);
      if (Number.isFinite(num) && Math.abs(num) <= MAX_SAFE_EPOCH) return num;
      return null;
    }
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed) && Math.abs(parsed) <= MAX_SAFE_EPOCH) return parsed;
  }
  return null;
}

export function getJournalTimestamp(entry: Record<string, unknown>): number {
  if (!entry || typeof entry !== "object") return 0;
  const candidates = [entry.at, entry.createdAt, entry.archivedAt, entry.updatedAt];
  for (const candidate of candidates) {
    const ts = parseTimestampValue(candidate);
    if (ts !== null) return ts;
  }
  return 0;
}

export function canonicalJsonString(value: unknown): string {
  const active = new WeakSet();
  function visit(input: unknown): string {
    if (input === null || typeof input !== "object") {
      return JSON.stringify(input);
    }
    if (active.has(input)) {
      return JSON.stringify(null);
    }
    active.add(input);
    try {
      if (Array.isArray(input)) {
        return "[" + input.map(visit).join(",") + "]";
      }
      const keys = Object.keys(input as Record<string, unknown>).sort();
      return (
        "{" +
        keys
          .map(k => JSON.stringify(k) + ":" + visit((input as Record<string, unknown>)[k]))
          .join(",") +
        "}"
      );
    } finally {
      active.delete(input);
    }
  }
  return visit(value);
}

export function unwrapJournalRecord(raw: Record<string, unknown>): {
  isWrapper: boolean;
  entry: Record<string, unknown>;
  wrapperId?: string;
} {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { isWrapper: false, entry: raw };
  }

  // 1. New format with explicit discriminator
  if (raw.recordType === JOURNAL_ARCHIVE_RECORD_TYPE) {
    if (raw.schemaVersion !== JOURNAL_ARCHIVE_SCHEMA_VERSION) {
      return { isWrapper: false, entry: raw };
    }
    if (
      typeof raw.id === "string" &&
      /^journal-archive-r\d+-i\d+-[a-f0-9]+$/i.test(raw.id) &&
      typeof raw.archivedAt === "string" &&
      raw.archivedAt.length > 0 &&
      raw.archivedEntry &&
      typeof raw.archivedEntry === "object" &&
      !Array.isArray(raw.archivedEntry)
    ) {
      return {
        isWrapper: true,
        entry: raw.archivedEntry as Record<string, unknown>,
        wrapperId: raw.id,
      };
    }
    return { isWrapper: false, entry: raw };
  }

  // 2. Legacy format without discriminator
  if (raw.recordType === undefined) {
    if (
      typeof raw.id === "string" &&
      (raw.id.startsWith("journal-archive-") || raw.id.startsWith("archive-wrap")) &&
      typeof raw.archivedAt === "string" &&
      raw.archivedAt.length > 0 &&
      raw.archivedEntry &&
      typeof raw.archivedEntry === "object" &&
      !Array.isArray(raw.archivedEntry)
    ) {
      const knownKeys = new Set(["id", "archivedAt", "archivedEntry"]);
      const hasExtraKeys = Object.keys(raw).some(k => !knownKeys.has(k));
      if (!hasExtraKeys) {
        return {
          isWrapper: true,
          entry: raw.archivedEntry as Record<string, unknown>,
          wrapperId: raw.id,
        };
      }
    }
  }

  return { isWrapper: false, entry: raw };
}

export interface JournalCandidate {
  timestamp: number;
  identity: string;
  digest: string;
  entry: Record<string, unknown>;
}

export interface V1Occurrence {
  entry: Record<string, unknown>;
  canonicalPayload: string;
  occurrence: number;
  identity: string;
  cutoverRecordId: string;
}

/**
 * Reserved id namespace minted by the legacy -> v2 migration
 * (`legacyRecordId()` in workspace-storage-v2.mjs) for records that carried no
 * id of their own. A v2 record id in this namespace can only have been produced
 * by that migration.
 */
export const JOURNAL_CUTOVER_ID_PREFIX = "@legacy:";

/**
 * The reliable cutover provenance id for the v1 entry at `index`.
 *
 * DECISIONS D-004: provenance may only be inferred from a signal that could
 * not have been produced by anything other than the legacy migration. The
 * reserved `@legacy:` namespace is exactly that — `legacyRecordId()` in
 * workspace-storage-v2.mjs is the *only* place that mints it, and it does so
 * strictly for records that carried no id of their own.
 *
 * A pre-existing business id is NOT a verifiable cutover marker: a native v2
 * record can legitimately reuse the same id with identical content as an
 * independent event. Deriving provenance from it would risk deleting a legal
 * event (D-004), so we never do. When a v1 entry carries its own id we therefore
 * fall back to the positional `@legacy:` id; the collector then cannot match it
 * against a v2 record whose storage id is that ordinary business id, and keeps
 * both occurrences. This is the conservative, no-data-loss behaviour required
 * by the re-review: no broad v2 migration is performed, and legacy journal
 * records are never silently dropped.
 */
export function journalCutoverRecordId(entry: Record<string, unknown>, index: number): string {
  return `${JOURNAL_CUTOVER_ID_PREFIX}${String(index).padStart(12, "0")}`;
}

export interface JournalCollectorStats {
  candidateCount: number;
  v1UnmatchedOccurrenceCount: number;
  v1DigestCount: number;
  logicalRetainedKeyBytes: number;
  logicalRetainedCanonicalPayloadBytes: number;
  totalRetainedEntries: number;
}

export function compareStringsDescending(a: string, b: string): number {
  return a === b ? 0 : (a > b ? -1 : 1);
}

export function compareCandidatesDescending(a: JournalCandidate, b: JournalCandidate): number {
  if (b.timestamp !== a.timestamp) {
    return b.timestamp - a.timestamp;
  }
  const idCmp = compareStringsDescending(a.identity, b.identity);
  if (idCmp !== 0) return idCmp;
  return compareStringsDescending(a.digest, b.digest);
}

function extractComparablePayload(record: Record<string, unknown>): Record<string, unknown> {
  if (typeof record.id === "string" && record.id.startsWith("@legacy:")) {
    const copy = { ...record };
    delete copy.id;
    return copy;
  }
  return record;
}

export class BoundedJournalCollector {
  readonly capacity: number;
  private candidates: JournalCandidate[] = [];
  private v1Multiset = new Map<string, { unmatched: V1Occurrence[] }>();
  private v1TotalUnmatched = 0;
  private v1CanonicalPayloadBytes = 0;
  private _highWaterMark = 0;

  constructor(capacity = TOP_N_CANDIDATE_CAPACITY) {
    this.capacity = capacity;
  }

  get highWaterMark(): number {
    return this._highWaterMark;
  }

  get count(): number {
    return this.candidates.length;
  }

  private addCandidate(candidate: JournalCandidate) {
    if (this.candidates.length === this.capacity) {
      const worst = this.candidates[this.candidates.length - 1];
      if (compareCandidatesDescending(candidate, worst) >= 0) {
        return;
      }
      this.candidates.pop();
    }

    let low = 0;
    let high = this.candidates.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (compareCandidatesDescending(candidate, this.candidates[mid]) < 0) {
        high = mid;
      } else {
        low = mid + 1;
      }
    }
    this.candidates.splice(low, 0, candidate);
    if (this.candidates.length > this._highWaterMark) {
      this._highWaterMark = this.candidates.length;
    }
  }

  loadV1Records(records: Record<string, unknown>[]) {
    if (!Array.isArray(records)) return;
    const occurrenceCounts = new Map<string, number>();

    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (!record || typeof record !== "object" || Array.isArray(record)) continue;
      if (this.v1TotalUnmatched >= 5_000) break;

      const comparable = extractComparablePayload(record);
      const canonicalPayload = canonicalJsonString(comparable);
      const digest = sha256(canonicalPayload);

      const occurrence = (occurrenceCounts.get(digest) ?? 0) + 1;
      occurrenceCounts.set(digest, occurrence);

      const identity = `v1:${record.id ? String(record.id) : digest}:${occurrence}`;
      const occurrenceItem: V1Occurrence = {
        entry: record,
        canonicalPayload,
        occurrence,
        identity,
        cutoverRecordId: journalCutoverRecordId(record, index),
      };

      let bucket = this.v1Multiset.get(digest);
      if (!bucket) {
        bucket = { unmatched: [] };
        this.v1Multiset.set(digest, bucket);
      }
      bucket.unmatched.push(occurrenceItem);
      this.v1TotalUnmatched += 1;
      this.v1CanonicalPayloadBytes += Buffer.byteLength(canonicalPayload, "utf8");
    }
  }

  processV2JournalItems(items: Array<{ recordId: string; sequence: number; record: Record<string, unknown> }>) {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (!item?.record || typeof item.record !== "object" || Array.isArray(item.record)) continue;
      const unwrapped = unwrapJournalRecord(item.record);
      let entry: Record<string, unknown>;
      let identity: string;
      let isLegacy = false;

      if (unwrapped.isWrapper) {
        // An archive wrapper holds history that was evicted from v1. It is
        // never a cutover copy of a live v1 occurrence, even when the archived
        // entry is byte-identical to one.
        entry = unwrapped.entry;
        identity = `archive:${unwrapped.wrapperId ?? item.recordId ?? sha256(canonicalJsonString(item.record))}`;
        isLegacy = false;
      } else {
        entry = item.record;
        identity = `v2:${item.recordId || (typeof item.record.id === "string" ? item.record.id : sha256(canonicalJsonString(item.record)))}`;
        isLegacy = true;
      }

      const comparable = extractComparablePayload(entry);
      const canonicalPayload = canonicalJsonString(comparable);
      const digest = sha256(canonicalPayload);

      // Only a non-wrapped v2 item holding the exact id that the migration
      // would have assigned to a specific v1 occurrence may consume it. This
      // keeps native v2 records (for example asset-cleanup rows) and archive
      // wrappers from swallowing independent, legal v1 events.
      if (isLegacy && typeof item.recordId === "string" && item.recordId.length > 0) {
        const bucket = this.v1Multiset.get(digest);
        if (bucket && bucket.unmatched.length > 0) {
          const matchIndex = bucket.unmatched.findIndex(
            u => u.canonicalPayload === canonicalPayload && u.cutoverRecordId === item.recordId
          );
          if (matchIndex !== -1) {
            const [removed] = bucket.unmatched.splice(matchIndex, 1);
            this.v1TotalUnmatched -= 1;
            this.v1CanonicalPayloadBytes -= Buffer.byteLength(removed.canonicalPayload, "utf8");
            if (bucket.unmatched.length === 0) {
              this.v1Multiset.delete(digest);
            }
          }
        }
      }

      const timestamp = getJournalTimestamp(entry);
      const entryDigest = sha256(canonicalJsonString(entry));

      this.addCandidate({
        timestamp,
        identity,
        digest: entryDigest,
        entry,
      });
    }
  }

  processV1Remaining() {
    this.v1Multiset.forEach((bucket, digest) => {
      for (const occurrence of bucket.unmatched) {
        const timestamp = getJournalTimestamp(occurrence.entry);
        this.addCandidate({
          timestamp,
          identity: occurrence.identity,
          digest,
          entry: occurrence.entry,
        });
      }
    });
  }

  processV2Records(records: Record<string, unknown>[]) {
    if (!Array.isArray(records)) return;
    this.processV2JournalItems(
      records.map((r, i) => ({
        recordId: typeof r?.id === "string" ? r.id : "",
        sequence: i,
        record: r,
      }))
    );
  }

  processV1Records(records: Record<string, unknown>[]) {
    if (!Array.isArray(records)) return;
    this.loadV1Records(records);
    this.processV1Remaining();
  }

  getStats(): JournalCollectorStats {
    const v1DigestCount = this.v1Multiset.size;
    return {
      candidateCount: this.candidates.length,
      v1UnmatchedOccurrenceCount: this.v1TotalUnmatched,
      v1DigestCount,
      logicalRetainedKeyBytes: v1DigestCount * 64,
      logicalRetainedCanonicalPayloadBytes: this.v1CanonicalPayloadBytes,
      totalRetainedEntries: this.candidates.length + this.v1TotalUnmatched,
    };
  }

  getTop(limit = 100): Record<string, unknown>[] {
    return this.candidates.slice(0, limit).map(c => c.entry);
  }
}

// Module-level test hook to inspect collector statistics
let lastJournalCollectorHighWaterMark = 0;
let lastJournalCollectorStats: JournalCollectorStats = {
  candidateCount: 0,
  v1UnmatchedOccurrenceCount: 0,
  v1DigestCount: 0,
  logicalRetainedKeyBytes: 0,
  logicalRetainedCanonicalPayloadBytes: 0,
  totalRetainedEntries: 0,
};

export function getLastJournalCollectorHighWaterMark(): number {
  return lastJournalCollectorHighWaterMark;
}

export function getLastJournalCollectorStats(): JournalCollectorStats {
  return lastJournalCollectorStats;
}

export async function listWorkspaceCollections(ownerId: string | number) {
  const owner = ownerKey(ownerId);
  await retryPendingAssetCleanup(owner).catch(() => {});
  const [{ workspace }, importRuns] = await Promise.all([
    readWorkspace(owner),
    queryLocalWorkspaceV2<Record<string, unknown>>(owner, {
      collection: "importRuns",
      limit: 1_000,
      order: "desc",
    }),
  ]);

  const collector = new BoundedJournalCollector(TOP_N_CANDIDATE_CAPACITY);

  if (Array.isArray(workspace?.operationJournal)) {
    collector.loadV1Records(workspace.operationJournal);
  }

  let journalCursor: string | null = null;
  const seenCursors = new Set<string>();
  let initialRevision: number | null = null;
  let pageCount = 0;

  do {
    pageCount += 1;
    if (pageCount > MAX_JOURNAL_PAGES) {
      throw new Error("OPERATION_JOURNAL_PAGINATION_LIMIT_EXCEEDED");
    }

    const page = await queryLocalWorkspaceJournalInternal(owner, {
      limit: 1_000,
      cursor: journalCursor,
      order: "desc",
    });

    if (initialRevision === null) {
      initialRevision = page?.revision ?? 0;
    } else if (page?.revision !== undefined && page.revision !== initialRevision) {
      throw new Error("OPERATION_JOURNAL_REVISION_DRIFT");
    }

    if (page?.nextCursor) {
      if (seenCursors.has(page.nextCursor)) {
        throw new Error("OPERATION_JOURNAL_CURSOR_LOOP");
      }
      seenCursors.add(page.nextCursor);
    }
    journalCursor = page?.nextCursor ?? null;

    if (Array.isArray(page?.items)) {
      collector.processV2JournalItems(page.items);
    } else if (Array.isArray((page as any)?.records)) {
      collector.processV2Records((page as any).records);
    }
  } while (journalCursor);

  collector.processV1Remaining();

  lastJournalCollectorHighWaterMark = collector.highWaterMark;
  lastJournalCollectorStats = collector.getStats();

  return {
    folders: workspace.folders,
    tags: workspace.tags,
    savedValues: workspace.savedValues,
    mappingTemplates: workspace.mappingTemplates,
    importRuns: importRuns.records,
    preferences: workspace.preferences,
    operationJournal: collector.getTop(100),
  };
}

export async function saveWorkspacePreferences(
  ownerId: string | number,
  patch: Record<string, unknown>
) {
  return mutateWorkspace(
    ownerKey(ownerId),
    "workspace.save-preferences",
    workspace => {
      workspace.preferences = { ...workspace.preferences, ...patch };
      return workspace.preferences;
    }
  );
}

export async function upsertFolder(
  ownerId: string | number,
  input: { id?: string; name: string; parentId?: string | null }
) {
  return mutateWorkspace(ownerKey(ownerId), "folder.upsert", workspace => {
    if (
      input.parentId &&
      !workspace.folders.some(folder => folder.id === input.parentId)
    )
      throw new Error("上層資料夾不存在。");
    if (input.id && input.parentId === input.id)
      throw new Error("資料夾不可成為自己的子資料夾。");
    if (input.id && input.parentId) {
      let cursor: string | null | undefined = input.parentId;
      const visited = new Set<string>();
      while (cursor && !visited.has(cursor)) {
        if (cursor === input.id) throw new Error("資料夾層級不可形成循環。");
        visited.add(cursor);
        cursor = workspace.folders.find(folder => folder.id === cursor)
          ?.parentId as string | null | undefined;
      }
    }
    const existing = input.id
      ? workspace.folders.find(folder => folder.id === input.id)
      : undefined;
    if (existing)
      Object.assign(existing, {
        name: input.name.trim(),
        parentId: input.parentId ?? null,
        updatedAt: now(),
      });
    else
      workspace.folders.push({
        id: createStableId("folder"),
        name: input.name.trim(),
        parentId: input.parentId ?? null,
        createdAt: now(),
        updatedAt: now(),
      });
    return existing ?? workspace.folders[workspace.folders.length - 1];
  });
}

export async function deleteFolder(ownerId: string | number, folderId: string) {
  return mutateWorkspace(ownerKey(ownerId), "folder.delete", workspace => {
    workspace.folders = workspace.folders.filter(
      folder => folder.id !== folderId
    );
    for (const folder of workspace.folders)
      if (folder.parentId === folderId) folder.parentId = null;
    for (const template of workspace.templates)
      template.folderIds = template.folderIds.filter(id => id !== folderId);
    return { deleted: true };
  });
}

export async function upsertTag(
  ownerId: string | number,
  input: { id?: string; name: string; color: string }
) {
  return mutateWorkspace(ownerKey(ownerId), "tag.upsert", workspace => {
    const existing = input.id
      ? workspace.tags.find(tag => tag.id === input.id)
      : undefined;
    if (existing)
      Object.assign(existing, {
        name: input.name.trim(),
        color: input.color,
        updatedAt: now(),
      });
    else
      workspace.tags.push({
        id: createStableId("tag"),
        name: input.name.trim(),
        color: input.color,
        createdAt: now(),
        updatedAt: now(),
      });
    return existing ?? workspace.tags[workspace.tags.length - 1];
  });
}

export async function deleteTag(ownerId: string | number, tagId: string) {
  return mutateWorkspace(ownerKey(ownerId), "tag.delete", workspace => {
    workspace.tags = workspace.tags.filter(tag => tag.id !== tagId);
    for (const template of workspace.templates)
      template.tagIds = template.tagIds.filter(id => id !== tagId);
    return { deleted: true };
  });
}

export async function addSavedValue(
  ownerId: string | number,
  input: { templateId: string; stableFieldId: string; value: string }
) {
  return mutateWorkspace(ownerKey(ownerId), "saved-value.add", workspace => {
    const existing = workspace.savedValues.find(
      item =>
        item.templateId === input.templateId &&
        item.stableFieldId === input.stableFieldId &&
        item.value === input.value
    );
    if (existing) {
      existing.useCount = Number(existing.useCount ?? 0) + 1;
      existing.lastUsedAt = now();
      return existing;
    }
    const record = {
      id: createStableId("value"),
      ...input,
      useCount: 0,
      createdAt: now(),
      lastUsedAt: null,
    };
    workspace.savedValues.push(record);
    return record;
  });
}

export async function deleteSavedValue(
  ownerId: string | number,
  savedValueId: string
) {
  return mutateWorkspace(ownerKey(ownerId), "saved-value.delete", workspace => {
    workspace.savedValues = workspace.savedValues.filter(
      item => item.id !== savedValueId
    );
    return { deleted: true };
  });
}

export async function recordSavedValueUse(
  ownerId: string | number,
  savedValueId: string
) {
  return mutateWorkspace(ownerKey(ownerId), "saved-value.use", workspace => {
    const savedValue = workspace.savedValues.find(
      item => item.id === savedValueId
    );
    if (!savedValue) throw new Error("常用值不存在。");
    savedValue.useCount = Number(savedValue.useCount ?? 0) + 1;
    savedValue.lastUsedAt = now();
    return savedValue;
  });
}

export async function upsertMappingTemplate(
  ownerId: string | number,
  input: {
    id?: string;
    templateVersionId: string;
    name: string;
    sourceSchemaFingerprint: string;
    mapping: JsonValue;
  }
) {
  return mutateWorkspace(
    ownerKey(ownerId),
    "mapping-template.upsert",
    workspace => {
      const version = workspace.templateVersions.find(
        item => item.id === input.templateVersionId
      );
      if (!version) throw new Error("找不到 Mapping 對應的 Template Version。");
      const timestamp = now();
      const existing = input.id
        ? workspace.mappingTemplates.find(item => item.id === input.id)
        : undefined;
      const record = {
        id: input.id ?? createStableId("mapping"),
        templateVersionId: input.templateVersionId,
        templateId: version.templateId,
        name: input.name.trim(),
        sourceSchemaFingerprint: input.sourceSchemaFingerprint,
        mapping: input.mapping,
        mappingHash: sha256(input.mapping),
        columnCount: Array.isArray(input.mapping) ? input.mapping.length : 0,
        createdAt: Number(existing?.createdAt ?? timestamp),
        updatedAt: timestamp,
        lastUsedAt: timestamp,
      };
      if (existing) Object.assign(existing, record);
      else workspace.mappingTemplates.push(record);
      return record;
    }
  );
}

export async function deleteMappingTemplate(
  ownerId: string | number,
  mappingTemplateId: string
) {
  return mutateWorkspace(
    ownerKey(ownerId),
    "mapping-template.delete",
    workspace => {
      workspace.mappingTemplates = workspace.mappingTemplates.filter(
        item => item.id !== mappingTemplateId
      );
      return { deleted: true };
    }
  );
}

export type { LocalField, LocalInstance, LocalTemplateVersion };
