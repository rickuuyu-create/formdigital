/** Local Data Folder asset and portable-backup adapter. No cloud object storage is used. */
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import {
  commitLocalPortableRestoreSession,
  createLocalBackup,
  createLocalStreamingBackup,
  deleteLocalAsset,
  listLocalAssets,
  loadLocalAsset,
  restoreLocalBackup,
  saveLocalWorkspace,
  storeLocalAsset,
} from "./localServiceClient";
import { sha256, type JsonValue } from "./domain";
import { createStableId } from "./domain";
import { readWorkspace } from "./workspaceStore";

export type AssetKind =
  | "source"
  | "page"
  | "signature"
  | "image"
  | "export"
  | "backup"
  | "emergency-backup";

export type BackupArchiveManifest = {
  format: "formdigital-backup" | "formdigital-portable-backup";
  schemaVersion: number;
  createdAt: number | string;
  ownerId?: number;
  ownerKeyHash?: string;
  scope?: "account" | "template";
  templateId?: string | null;
  records?: Record<
    string,
    { path: string; contentHash: string; count: number }
  >;
  files?: Array<{ path: string; contentHash: string; size: number }>;
  assets?: Array<{
    id: string;
    path: string;
    contentHash: string;
    mimeType: string;
    sizeBytes: number;
  }>;
  summary?: {
    templates: Array<{ id: string; name: string; versions: number; instances: number }>;
    templateCount: number;
    versionCount: number;
    instanceCount: number;
    mappingTemplateCount: number;
  };
  [key: string]: unknown;
};

/** 匯入前預覽：只含 UI 真正需要的欄位，絕不洩漏 ownerKeyHash、files、hash、路徑或 token。 */
export type BackupImportPreview = {
  schemaVersion: number;
  createdAt: number | string;
  scope?: "account" | "template";
  templateId?: string | null;
  summary?: {
    templates: Array<{ id: string; name: string; versions: number; instances: number }>;
    templateCount: number;
    versionCount: number;
    instanceCount: number;
    mappingTemplateCount: number;
  };
};

export function createBackupArchive(
  manifest: BackupArchiveManifest,
  records: Record<string, unknown>,
  assetBytes: Record<string, Uint8Array>
) {
  const entries: Record<string, Uint8Array> = {};
  for (const [recordName, data] of Object.entries(records))
    entries[`records/${recordName}.json`] = strToU8(JSON.stringify(data));
  for (const [path, bytes] of Object.entries(assetBytes)) entries[path] = bytes;
  entries["backup-manifest.json"] = strToU8(JSON.stringify(manifest));
  return zipSync(entries, { level: 6 });
}

// Local Data Service emits lowercase SHA-256 values and compares the owner
// hash byte-for-byte during restore. Accepting uppercase here would make the
// Web preview approve an archive that the restore boundary later rejects.
const PORTABLE_HASH_RE = /^[a-f0-9]{64}$/;
const PORTABLE_NAME_RE = /^[A-Za-z0-9_.-]{1,200}$/;

/** Reject unsafe entry paths: absolute, drive, UNC, traversal, backslash, empty
 *  segment, URL scheme or NUL, plus any top-level directory other than
 *  account / manifests / objects. */
function parsePortableEntryPath(rawPath: string): boolean {
  if (typeof rawPath !== "string" || rawPath.length === 0) return false;
  if (rawPath.includes("\\")) return false;
  if (rawPath.includes("..")) return false;
  if (/\0/.test(rawPath)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rawPath)) return false;
  if (/^[a-z]:[\\/]/i.test(rawPath)) return false;
  if (rawPath.startsWith("//") || rawPath.startsWith("\\\\")) return false;
  if (rawPath.startsWith("/")) return false;
  const parts = rawPath.split("/");
  if (parts.some(part => part.length === 0)) return false;
  const top = parts[0];
  return top === "account" || top === "manifests" || top === "objects";
}

/** Portable Backup v1 only permits exactly the three supported entry shapes. */
function isAllowedPortableFile(path: string): boolean {
  const parts = path.split("/");
  if (parts.length !== 2) return false;
  const [top, name] = parts;
  if (top === "account") return name === "workspace.json";
  if (top === "manifests") {
    if (!name.endsWith(".json")) return false;
    const stem = name.slice(0, -".json".length);
    return stem.length >= 1 && PORTABLE_NAME_RE.test(stem);
  }
  if (top === "objects") return PORTABLE_HASH_RE.test(name);
  return false;
}

function validatePortableFileDescriptor(file: unknown): void {
  if (!file || typeof file !== "object" || Array.isArray(file))
    throw new Error("備份檔案描述無效。");
  const f = file as Record<string, unknown>;
  if (typeof f.path !== "string") throw new Error("備份檔案路徑無效。");
  if (typeof f.contentHash !== "string" || !PORTABLE_HASH_RE.test(f.contentHash))
    throw new Error("備份檔案雜湊無效。");
  if (
    typeof f.size !== "number" ||
    !Number.isSafeInteger(f.size) ||
    f.size < 0
  )
    throw new Error("備份檔案大小無效。");
}

function validatePortableSummary(summary: unknown): void {
  if (!summary || typeof summary !== "object" || Array.isArray(summary))
    throw new Error("備份摘要結構無效。");
  const s = summary as Record<string, unknown>;
  if (!Array.isArray(s.templates)) throw new Error("備份摘要缺少 templates。");
  for (const item of s.templates) {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("Template 摘要項目無效。");
    const t = item as Record<string, unknown>;
    if (
      typeof t.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(t.id)
    )
      throw new Error("Template 摘要 id 無效。");
    if (typeof t.name !== "string") throw new Error("Template 摘要 name 無效。");
    if (!Number.isSafeInteger(t.versions) || (t.versions as number) < 0)
      throw new Error("Template 摘要 versions 無效。");
    if (!Number.isSafeInteger(t.instances) || (t.instances as number) < 0)
      throw new Error("Template 摘要 instances 無效。");
  }
  for (const key of [
    "templateCount",
    "versionCount",
    "instanceCount",
    "mappingTemplateCount",
  ]) {
    const v = s[key];
    if (typeof v !== "number" || !Number.isSafeInteger(v) || (v as number) < 0)
      throw new Error("備份摘要計數無效。");
  }
}

function derivePortableSummary(
  workspace: Record<string, unknown>
): NonNullable<BackupArchiveManifest["summary"]> {
  for (const key of [
    "templates",
    "templateVersions",
    "instances",
    "mappingTemplates",
  ])
    if (!Array.isArray(workspace[key]))
      throw new Error("Workspace 預覽資料結構無效。");

  const templates = workspace.templates as Array<unknown>;
  const versions = workspace.templateVersions as Array<unknown>;
  const instances = workspace.instances as Array<unknown>;
  const mappings = workspace.mappingTemplates as Array<unknown>;
  const readRelationId = (item: unknown, field: string) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("Workspace 預覽資料結構無效。");
    const value = (item as Record<string, unknown>)[field];
    if (typeof value !== "string" || value.length === 0)
      throw new Error("Workspace 預覽資料結構無效。");
    return value;
  };
  const versionTemplateIds = versions.map(item =>
    readRelationId(item, "templateId")
  );
  const instanceTemplateIds = instances.map(item =>
    readRelationId(item, "templateId")
  );
  for (const mapping of mappings) readRelationId(mapping, "templateVersionId");

  const previewTemplates = templates.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("Workspace 預覽資料結構無效。");
    const template = item as Record<string, unknown>;
    if (
      typeof template.id !== "string" ||
      template.id.length === 0 ||
      typeof template.name !== "string"
    )
      throw new Error("Workspace 預覽資料結構無效。");
    return {
      id: template.id,
      name: template.name,
      versions: versionTemplateIds.filter(id => id === template.id).length,
      instances: instanceTemplateIds.filter(id => id === template.id).length,
    };
  });
  return {
    templates: previewTemplates,
    templateCount: templates.length,
    versionCount: versions.length,
    instanceCount: instances.length,
    mappingTemplateCount: mappings.length,
  };
}

function verifyPortableBackup(
  entries: Record<string, Uint8Array>,
  manifest: BackupArchiveManifest
): BackupArchiveManifest {
  if (manifest.format !== "formdigital-portable-backup")
    throw new Error("不支援的 Portable Backup 格式。");
  if (manifest.schemaVersion !== 1)
    throw new Error("不支援的 Portable Backup 版本。");
  const scope = manifest.scope;
  if (scope !== "account" && scope !== "template")
    throw new Error("備份 scope 不支援。");
  if (
    scope === "account" &&
    manifest.templateId !== null &&
    manifest.templateId !== undefined
  )
    throw new Error("帳號備份不得指定 templateId。");
  if (
    scope === "template" &&
    !(
      typeof manifest.templateId === "string" &&
      /^[A-Za-z0-9_-]{1,200}$/.test(manifest.templateId)
    )
  )
    throw new Error("Template 備份必須指定非空 templateId。");
  const validCreatedAt =
    (typeof manifest.createdAt === "number" &&
      Number.isFinite(manifest.createdAt) &&
      manifest.createdAt >= 0) ||
    (typeof manifest.createdAt === "string" &&
      manifest.createdAt.length > 0 &&
      manifest.createdAt.length <= 64 &&
      Number.isFinite(Date.parse(manifest.createdAt)));
  if (!validCreatedAt)
    throw new Error("備份建立時間無效。");
  if (
    typeof manifest.ownerKeyHash !== "string" ||
    !PORTABLE_HASH_RE.test(manifest.ownerKeyHash)
  )
    throw new Error("備份 ownerKeyHash 格式無效。");
  if (!Array.isArray(manifest.files))
    throw new Error("備份檔案清單無效。");

  const seen = new Set<string>();
  for (const file of manifest.files) {
    validatePortableFileDescriptor(file);
    if (!parsePortableEntryPath(file.path))
      throw new Error("備份檔案路徑不被支援。");
    if (!isAllowedPortableFile(file.path))
      throw new Error("備份檔案路徑不被支援。");
    if (seen.has(file.path))
      throw new Error("備份檔案清單含重複路徑。");
    seen.add(file.path);
  }

  const workspaceFiles = manifest.files.filter(
    f => f.path === "account/workspace.json"
  );
  if (workspaceFiles.length !== 1)
    throw new Error("Portable Backup 必須恰含一份 account/workspace.json。");

  for (const key of Object.keys(entries)) {
    if (key === "backup-manifest.json") continue;
    if (!seen.has(key))
      throw new Error("備份含有未列於 manifest 的額外檔案。");
  }

  for (const file of manifest.files) {
    const data = entries[file.path];
    if (!data) throw new Error("備份檔案缺失。");
    if (data.byteLength !== file.size)
      throw new Error("備份檔案大小不符。");
    if (sha256(data) !== file.contentHash)
      throw new Error("備份檔案內容雜湊不符。");
  }

  const workspaceBytes = entries["account/workspace.json"];
  let workspaceEnvelope: unknown;
  try {
    workspaceEnvelope = JSON.parse(strFromU8(workspaceBytes));
  } catch {
    throw new Error("Workspace 資料無法解析。");
  }
  if (
    !workspaceEnvelope ||
    typeof workspaceEnvelope !== "object" ||
    Array.isArray(workspaceEnvelope) ||
    typeof (workspaceEnvelope as Record<string, unknown>).workspace !== "object" ||
    (workspaceEnvelope as Record<string, unknown>).workspace === null ||
    Array.isArray((workspaceEnvelope as Record<string, unknown>).workspace)
  )
    throw new Error("Workspace 資料結構無效。");

  for (const file of manifest.files) {
    if (!file.path.startsWith("manifests/")) continue;
    const mBytes = entries[file.path];
    let m: unknown;
    try {
      m = JSON.parse(strFromU8(mBytes));
    } catch {
      throw new Error("資產 manifest 無法解析。");
    }
    if (!m || typeof m !== "object" || Array.isArray(m))
      throw new Error("資產 manifest 結構無效。");
    const am = m as Record<string, unknown>;
    for (const field of [
      "schemaVersion",
      "id",
      "ownerKeyHash",
      "contentHash",
      "size",
    ])
      if (!(field in am)) throw new Error("資產 manifest 缺少必要欄位。");
    if (am.schemaVersion !== 1)
      throw new Error("資產 manifest 版本不支援。");
    if (am.ownerKeyHash !== manifest.ownerKeyHash)
      throw new Error("資產 owner 與備份不一致。");
    const objPath = `objects/${am.contentHash}`;
    if (!seen.has(objPath)) throw new Error("資產指向的 object 未列入備份。");
    const objData = entries[objPath];
    if (!objData) throw new Error("資產指向的 object 缺失。");
    if (
      typeof am.size !== "number" ||
      !Number.isSafeInteger(am.size) ||
      am.size < 0 ||
      am.size !== objData.byteLength ||
      am.contentHash !== sha256(objData)
    )
      throw new Error("資產 manifest 與 object 不一致。");
    const base = file.path.slice("manifests/".length).replace(/\.json$/, "");
    if (base !== am.id)
      throw new Error("資產 manifest 檔名與 id 不一致。");
  }

  for (const file of manifest.files) {
    if (!file.path.startsWith("objects/")) continue;
    const base = file.path.slice("objects/".length);
    if (base !== sha256(entries[file.path]))
      throw new Error("object 路徑與內容雜湊不一致。");
  }

  validatePortableSummary(manifest.summary);
  const workspace = (workspaceEnvelope as Record<string, unknown>)
    .workspace as Record<string, unknown>;
  const derivedSummary = derivePortableSummary(workspace);
  if (JSON.stringify(manifest.summary) !== JSON.stringify(derivedSummary))
    throw new Error("備份摘要與 Workspace 內容不一致。");
  if (
    scope === "template" &&
    (derivedSummary.templates.length !== 1 ||
      derivedSummary.templates[0]?.id !== manifest.templateId)
  )
    throw new Error("Template 備份 scope 與 Workspace 內容不一致。");
  return manifest;
}

export function verifyBackupArchive(bytes: Uint8Array): BackupArchiveManifest {
  const entries = unzipSync(bytes);
  const manifestBytes = entries["backup-manifest.json"];
  if (!manifestBytes) throw new Error("備份缺少 backup-manifest.json。");
  let manifest: BackupArchiveManifest;
  try {
    manifest = JSON.parse(strFromU8(manifestBytes)) as BackupArchiveManifest;
  } catch {
    throw new Error("備份 manifest 無法解析。");
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    throw new Error("備份 manifest 格式無效。");
  if (manifest.format === "formdigital-portable-backup")
    return verifyPortableBackup(entries, manifest);
  if (manifest.format !== "formdigital-backup" || manifest.schemaVersion !== 1)
    throw new Error("不支援的 Backup 格式版本。");
  for (const record of Object.values(manifest.records ?? {})) {
    const data = entries[record.path];
    if (!data || sha256(data) !== record.contentHash)
      throw new Error(`備份記錄驗證失敗：${record.path}`);
  }
  for (const asset of manifest.assets ?? []) {
    const data = entries[asset.path];
    if (!data || sha256(data) !== asset.contentHash)
      throw new Error(`備份資產驗證失敗：${asset.id}`);
  }
  return manifest;
}

export function createBackupImportPreview(
  manifest: BackupArchiveManifest
): BackupImportPreview {
  const summary = manifest.summary;
  const previewSummary =
    summary &&
    typeof summary === "object" &&
    !Array.isArray(summary) &&
    Array.isArray(summary.templates)
      ? {
          templates: summary.templates
            .filter((t) => !!t && typeof t === "object" && !Array.isArray(t))
            .map((t) => {
              const item = t as Record<string, unknown>;
              return {
                id: typeof item.id === "string" ? item.id : "",
                name: typeof item.name === "string" ? item.name : "",
                versions:
                  typeof item.versions === "number" &&
                  Number.isSafeInteger(item.versions) &&
                  item.versions >= 0
                    ? item.versions
                    : 0,
                instances:
                  typeof item.instances === "number" &&
                  Number.isSafeInteger(item.instances) &&
                  item.instances >= 0
                    ? item.instances
                    : 0,
              };
            }),
          templateCount:
            typeof summary.templateCount === "number" &&
            Number.isSafeInteger(summary.templateCount) &&
            summary.templateCount >= 0
              ? summary.templateCount
              : 0,
          versionCount:
            typeof summary.versionCount === "number" &&
            Number.isSafeInteger(summary.versionCount) &&
            summary.versionCount >= 0
              ? summary.versionCount
              : 0,
          instanceCount:
            typeof summary.instanceCount === "number" &&
            Number.isSafeInteger(summary.instanceCount) &&
            summary.instanceCount >= 0
              ? summary.instanceCount
              : 0,
          mappingTemplateCount:
            typeof summary.mappingTemplateCount === "number" &&
            Number.isSafeInteger(summary.mappingTemplateCount) &&
            summary.mappingTemplateCount >= 0
              ? summary.mappingTemplateCount
              : 0,
        }
      : undefined;
  return {
    schemaVersion: manifest.schemaVersion,
    createdAt: manifest.createdAt,
    scope: manifest.scope,
    templateId: manifest.templateId ?? null,
    summary: previewSummary,
  };
}

export async function storeOwnedAsset(
  ownerId: string | number,
  input: {
    bytes: Uint8Array;
    kind: AssetKind;
    mimeType: string;
    originalFilename?: string;
    metadata?: JsonValue;
    templateId?: string;
    templateVersionId?: string;
    instanceId?: string;
  }
) {
  const result = await storeLocalAsset(String(ownerId), {
    bytes: input.bytes,
    mimeType: input.mimeType,
    originalFilename: input.originalFilename,
    metadata: {
      ...(input.metadata &&
      typeof input.metadata === "object" &&
      !Array.isArray(input.metadata)
        ? input.metadata
        : {}),
      kind: input.kind,
      templateId: input.templateId ?? null,
      templateVersionId: input.templateVersionId ?? null,
      instanceId: input.instanceId ?? null,
    },
  });
  const asset = {
    id: result.asset.id,
    ownerId: String(ownerId),
    templateId: input.templateId ?? null,
    templateVersionId: input.templateVersionId ?? null,
    instanceId: input.instanceId ?? null,
    kind: input.kind,
    storageKey: result.asset.contentHash,
    contentHash: result.asset.contentHash,
    mimeType: result.asset.mimeType,
    originalFilename: result.asset.originalFilename,
    sizeBytes: result.asset.size,
    metadata: result.asset.metadata,
    createdAt: Date.parse(result.asset.createdAt),
  };
  return {
    asset,
    deduplicated: result.deduplicated,
    url: `/api/local/assets/${asset.id}`,
  };
}

export async function getOwnedAssetUrl(
  ownerId: string | number,
  assetId: string
) {
  const result = await loadLocalAsset(String(ownerId), assetId);
  return {
    asset: {
      id: result.asset.id,
      ownerId: String(ownerId),
      contentHash: result.asset.contentHash,
      mimeType: result.asset.mimeType,
      originalFilename: result.asset.originalFilename,
      sizeBytes: result.asset.size,
      metadata: result.asset.metadata,
      kind: String(result.asset.metadata?.kind ?? "source"),
      createdAt: Date.parse(result.asset.createdAt),
    },
    url: `/api/local/assets/${result.asset.id}`,
  };
}

export async function getOwnedAssetBytes(
  ownerId: string | number,
  assetId: string
) {
  const result = await loadLocalAsset(String(ownerId), assetId);
  const bytes = new Uint8Array(Buffer.from(result.base64, "base64"));
  if (sha256(bytes) !== result.asset.contentHash)
    throw new Error("本機資產完整性驗證失敗。");
  return { asset: result.asset, bytes };
}

export async function listOwnedAssets(ownerId: string | number) {
  return (await listLocalAssets(String(ownerId))).assets;
}

export async function deleteOwnedAsset(
  ownerId: string | number,
  assetId: string
) {
  return deleteLocalAsset(String(ownerId), assetId);
}

export async function createVerifiedBackup(
  ownerId: string | number,
  templateId?: string
) {
  const backup = await createLocalBackup(String(ownerId), templateId);
  const bytes = new Uint8Array(Buffer.from(backup.archiveBase64, "base64"));
  verifyBackupArchive(bytes);
  return {
    manifestId: backup.id,
    manifestHash: sha256(bytes),
    archiveBytes: bytes.byteLength,
    archiveBase64: backup.archiveBase64,
    filename: `${backup.id}.formdigital-backup`,
    manifest: backup.manifest,
  };
}

export async function createStreamingVerifiedBackup(
  ownerId: string | number
) {
  const backup = await createLocalStreamingBackup(String(ownerId));
  return {
    manifestId: backup.id,
    archiveBytes: backup.archiveBytes,
    filename: backup.filename,
    downloadUrl: `/api/local/portable-backups/${encodeURIComponent(backup.id)}`,
    manifest: {
      schemaVersion: backup.manifest.schemaVersion,
      createdAt: backup.manifest.createdAt,
      scope: backup.manifest.scope,
      templateId: backup.manifest.templateId,
      summary: backup.manifest.summary,
    },
  };
}

export async function commitVerifiedPortableRestoreSession(
  ownerId: string | number,
  sessionId: string
) {
  return commitLocalPortableRestoreSession(String(ownerId), sessionId);
}

export async function restoreVerifiedBackup(
  ownerId: string | number,
  bytes: Uint8Array,
  mode: "full" | "structure" | "duplicate" = "full"
) {
  const backupManifest = verifyBackupArchive(bytes);
  if (mode === "full" && backupManifest.scope === "template")
    throw new Error(
      "單一 Template 備份不能取代整個帳號；請選擇匯入／覆蓋或建立副本。"
    );
  const owner = String(ownerId);
  if (mode === "full")
    return restoreLocalBackup(owner, Buffer.from(bytes).toString("base64"));
  const archive = unzipSync(bytes);
  const incomingEnvelopeBytes = archive["account/workspace.json"];
  if (!incomingEnvelopeBytes)
    throw new Error("Structure Backup 缺少 Workspace 資料。");
  const incomingEnvelope = JSON.parse(strFromU8(incomingEnvelopeBytes)) as {
    workspace?: Record<string, unknown>;
  };
  const incoming = incomingEnvelope.workspace;
  if (!incoming) throw new Error("Structure Backup Workspace 格式無效。");
  const current = await readWorkspace(owner);
  const incomingInstances = Array.isArray(incoming.instances)
    ? (incoming.instances as Array<Record<string, unknown>>)
    : [];
  const projectionPreferences = current.workspace.preferences;
  const usesProjectedWorkspaceV2 =
    projectionPreferences !== null &&
    typeof projectionPreferences === "object" &&
    Object.prototype.hasOwnProperty.call(
      projectionPreferences,
      "__formdigitalWorkspaceV2"
    );
  // Legacy duplicate mode historically writes imported Instances through the
  // v1 Workspace PUT after installing assets. A projected Workspace rejects
  // that write because Instances are authoritative in v2, which used to leave
  // the just-installed assets behind. Fail before the restore route mutates
  // anything until a cross-store, crash-recoverable duplicate transaction is
  // available; structure-only imports remain supported.
  if (mode === "duplicate" && incomingInstances.length && usesProjectedWorkspaceV2)
    throw new Error(
      "此備份包含 Instance，無法以舊式建立副本流程匯入目前 Workspace；請使用完整串流備份還原，或只匯入 Template 結構。"
    );
  const restored = await restoreLocalBackup(
    owner,
    Buffer.from(bytes).toString("base64"),
    true
  );
  const afterRestore = await readWorkspace(owner);
  const merged = structuredClone(current.workspace);
  const incomingTemplates = Array.isArray(incoming.templates)
    ? (incoming.templates as Array<Record<string, unknown>>)
    : [];
  const incomingVersions = Array.isArray(incoming.templateVersions)
    ? (incoming.templateVersions as Array<Record<string, unknown>>)
    : [];
  const incomingFields = Array.isArray(incoming.fields)
    ? (incoming.fields as Array<Record<string, unknown>>)
    : [];
  const versionIdMap = new Map<string, string>();
  const templateIdMap = new Map<string, string>();
  for (const sourceTemplate of incomingTemplates) {
    const sourceTemplateId = String(sourceTemplate.id);
    const conflict =
      mode === "structure"
        ? merged.templates.find(
            template => template.name === sourceTemplate.name
          )
        : undefined;
    const targetTemplateId =
      conflict?.id ??
      (merged.templates.some(template => template.id === sourceTemplateId)
        ? createStableId("tpl")
        : sourceTemplateId);
    templateIdMap.set(sourceTemplateId, targetTemplateId);
    const sourceTemplateVersions = incomingVersions.filter(
      version => version.templateId === sourceTemplateId
    );
    for (const sourceVersion of sourceTemplateVersions) {
      const sameHash = merged.templateVersions.find(
        version =>
          version.templateId === targetTemplateId &&
          version.contentHash === sourceVersion.contentHash
      );
      const sourceVersionId = String(sourceVersion.id);
      const targetVersionId =
        sameHash?.id ??
        (merged.templateVersions.some(version => version.id === sourceVersionId)
          ? createStableId("ver")
          : sourceVersionId);
      versionIdMap.set(sourceVersionId, targetVersionId);
      if (!sameHash)
        merged.templateVersions.push({
          ...sourceVersion,
          id: targetVersionId,
          templateId: targetTemplateId,
        } as never);
      for (const sourceField of incomingFields.filter(
        field => field.templateVersionId === sourceVersionId
      )) {
        if (
          !merged.fields.some(
            field =>
              field.templateVersionId === targetVersionId &&
              field.stableFieldId === sourceField.stableFieldId
          )
        )
          merged.fields.push({
            ...sourceField,
            id: createStableId("fld"),
            templateVersionId: targetVersionId,
          } as never);
      }
    }
    const mappedPublished = sourceTemplate.currentPublishedVersionId
      ? (versionIdMap.get(String(sourceTemplate.currentPublishedVersionId)) ??
        null)
      : null;
    const mappedDraft = sourceTemplate.currentDraftVersionId
      ? (versionIdMap.get(String(sourceTemplate.currentDraftVersionId)) ?? null)
      : null;
    if (conflict)
      Object.assign(conflict, {
        ...sourceTemplate,
        id: conflict.id,
        ownerId: owner,
        currentPublishedVersionId:
          mappedPublished ?? conflict.currentPublishedVersionId,
        currentDraftVersionId: mappedDraft ?? conflict.currentDraftVersionId,
        updatedAt: Date.now(),
      });
    else
      merged.templates.push({
        ...sourceTemplate,
        id: targetTemplateId,
        ownerId: owner,
        name:
          mode === "duplicate"
            ? `${String(sourceTemplate.name)}（匯入副本）`
            : sourceTemplate.name,
        currentPublishedVersionId: mappedPublished,
        currentDraftVersionId: mappedDraft,
      } as never);
  }
  const incomingSavedValues = Array.isArray(incoming.savedValues)
    ? (incoming.savedValues as Array<Record<string, unknown>>)
    : [];
  for (const value of incomingSavedValues) {
    const mappedTemplateId = templateIdMap.get(String(value.templateId));
    if (
      mappedTemplateId &&
      !merged.savedValues.some(
        item =>
          item.templateId === mappedTemplateId &&
          item.stableFieldId === value.stableFieldId &&
          item.value === value.value
      )
    )
      merged.savedValues.push({
        ...value,
        id: createStableId("value"),
        templateId: mappedTemplateId,
      });
  }
  const incomingMappings = Array.isArray(incoming.mappingTemplates)
    ? (incoming.mappingTemplates as Array<Record<string, unknown>>)
    : [];
  for (const mapping of incomingMappings) {
    const mappedVersionId = versionIdMap.get(String(mapping.templateVersionId));
    if (mappedVersionId)
      merged.mappingTemplates.push({
        ...mapping,
        id: createStableId("mapping"),
        templateVersionId: mappedVersionId,
        templateId:
          templateIdMap.get(String(mapping.templateId)) ?? mapping.templateId,
      });
  }
  if (mode === "duplicate") {
    for (const instance of incomingInstances) {
      const mappedTemplateId = templateIdMap.get(String(instance.templateId));
      const mappedVersionId = versionIdMap.get(
        String(instance.templateVersionId)
      );
      if (!mappedTemplateId || !mappedVersionId) continue;
      merged.instances.push({
        ...instance,
        id: createStableId("ins"),
        ownerId: owner,
        templateId: mappedTemplateId,
        templateVersionId: mappedVersionId,
        name: `${String(instance.name || "Instance")}（匯入副本）`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as never);
    }
  }
  await saveLocalWorkspace(owner, merged, afterRestore.revision);
  return {
    ...restored,
    mode,
    preservedInstances: merged.instances.length,
    importedTemplates: incomingTemplates.length,
  };
}
