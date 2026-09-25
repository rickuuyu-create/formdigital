import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

type LocalServiceConfig = {
  schemaVersion: number;
  port: number;
  dataFolder: string;
  token: string;
  allowedOrigins: string[];
};

export type LocalAssetManifest = {
  id: string;
  schemaVersion: number;
  ownerKeyHash: string;
  contentHash: string;
  originalFilename: string;
  mimeType: string;
  size: number;
  createdAt: string;
  metadata: Record<string, unknown>;
};

export type LocalWorkspaceEnvelope<T> = {
  revision: number;
  workspace: T;
};

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);
const configPath = process.env.FORMDIGITAL_LOCAL_CONFIG
  ? path.resolve(process.env.FORMDIGITAL_LOCAL_CONFIG)
  : path.join(projectRoot, "local-service-config.json");

let cachedConfig: LocalServiceConfig | null = null;

export class LocalServiceRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "LocalServiceRequestError";
    this.status = status;
    this.code = code;
  }
}

async function readConfig() {
  if (cachedConfig) return cachedConfig;
  const parsed = JSON.parse(
    await fs.readFile(configPath, "utf8")
  ) as Partial<LocalServiceConfig>;
  if (!parsed.token || !parsed.port || !parsed.dataFolder) {
    throw new Error(
      "Local Data Folder 設定不完整；請先執行 setup-local-service.mjs。"
    );
  }
  cachedConfig = {
    schemaVersion: parsed.schemaVersion ?? 1,
    port: parsed.port,
    dataFolder: parsed.dataFolder,
    token: parsed.token,
    allowedOrigins: parsed.allowedOrigins ?? [],
  };
  return cachedConfig;
}

export function clearLocalServiceConfigCache() {
  cachedConfig = null;
}

async function requestLocal<T>(
  pathname: string,
  init: RequestInit = {},
  ownerKey?: string
): Promise<T> {
  const config = await readConfig();
  const response = await fetch(`http://127.0.0.1:${config.port}${pathname}`, {
    ...init,
    headers: {
      authorization: `Bearer ${config.token}`,
      ...(ownerKey ? { "x-formdigital-owner": ownerKey } : {}),
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    throw new LocalServiceRequestError(
      response.status,
      payload?.error?.code || "local_service_request_failed",
      payload?.error?.message || `Local Data Folder request failed (${response.status}).`
    );
  }
  return response.json() as Promise<T>;
}

export async function getLocalHealth() {
  return requestLocal<{
    status: "ok" | "reconnect_required";
    root: string;
    dataFolder: string;
    schemaVersion: number;
    message?: string;
  }>("/health");
}

export async function loadLocalWorkspace<T>(ownerKey: string) {
  return requestLocal<LocalWorkspaceEnvelope<T>>(
    "/api/v1/workspace",
    { method: "GET" },
    ownerKey
  );
}

export async function saveLocalWorkspace<T>(
  ownerKey: string,
  workspace: T,
  expectedRevision: number
) {
  return requestLocal<LocalWorkspaceEnvelope<T>>(
    "/api/v1/workspace",
    {
      method: "PUT",
      body: JSON.stringify({ expectedRevision, workspace }),
    },
    ownerKey
  );
}

export type LocalWorkspaceV2Description = {
  storageSchemaVersion: number;
  schemaVersion: number;
  revision: number;
};

export type LocalWorkspaceV2Collection =
  | "templates" | "templateVersions" | "fields" | "instances"
  | "folders" | "tags" | "savedValues" | "mappingTemplates"
  | "importRuns" | "importRows" | "mappingDecisions"
  | "detectionRuns" | "operationJournal";

export async function describeLocalWorkspaceV2(ownerKey: string) {
  return requestLocal<LocalWorkspaceV2Description>(
    "/api/v2/workspace/describe",
    { method: "GET" },
    ownerKey
  );
}

export async function queryLocalWorkspaceV2<T>(
  ownerKey: string,
  input: {
    collection: LocalWorkspaceV2Collection;
    where?: Partial<Record<"id" | "templateId" | "templateVersionId" | "importRunId" | "rowNumber" | "status" | "valuesHash", string | number | boolean | null>>;
    limit?: number;
    cursor?: string | null;
    order?: "asc" | "desc";
  }
) {
  return requestLocal<{ revision: number; records: T[]; nextCursor: string | null }>(
    "/api/v2/workspace/query",
    { method: "POST", body: JSON.stringify(input) },
    ownerKey
  );
}

export async function queryLocalWorkspaceJournalInternal(
  ownerKey: string,
  input: {
    limit?: number;
    cursor?: string | null;
    order?: "asc" | "desc";
  }
) {
  return requestLocal<{
    revision: number;
    items: Array<{ recordId: string; sequence: number; record: Record<string, unknown> }>;
    nextCursor: string | null;
  }>(
    "/api/v2/workspace/internal-journal-stream",
    { method: "POST", body: JSON.stringify({ collection: "operationJournal", ...input }) },
    ownerKey
  );
}

export async function queryManyLocalWorkspaceV2<T>(
  ownerKey: string,
  input: {
    collection: LocalWorkspaceV2Collection;
    key: "id" | "templateId" | "templateVersionId" | "importRunId" | "rowNumber" | "status" | "valuesHash";
    values: Array<string | number | boolean>;
    where?: Partial<Record<"id" | "templateId" | "templateVersionId" | "importRunId" | "rowNumber" | "status" | "valuesHash", string | number | boolean | null>>;
  }
) {
  return requestLocal<{ revision: number; records: T[] }>(
    "/api/v2/workspace/query-many",
    { method: "POST", body: JSON.stringify(input) },
    ownerKey
  );
}

export type LocalWorkspaceV2Transaction = {
  expectedRevision: number;
  transactionId: string;
  put?: Array<{ collection: LocalWorkspaceV2Collection; id?: string; record: Record<string, unknown> }>;
  deleteIds?: Array<{ collection: LocalWorkspaceV2Collection; ids: string[] }>;
  metaPatch?: Record<string, unknown>;
};

export async function transactLocalWorkspaceV2(
  ownerKey: string,
  input: LocalWorkspaceV2Transaction
) {
  return requestLocal<{
    baseRevision: number;
    revision: number;
    operationCount: number;
    idempotent: boolean;
  }>(
    "/api/v2/workspace/transaction",
    { method: "POST", body: JSON.stringify(input) },
    ownerKey
  );
}

export async function storeLocalAsset(
  ownerKey: string,
  input: {
    bytes: Uint8Array;
    mimeType: string;
    originalFilename?: string;
    metadata?: Record<string, unknown>;
  }
) {
  return requestLocal<{ asset: LocalAssetManifest; deduplicated: boolean }>(
    "/api/v1/assets",
    {
      method: "POST",
      body: JSON.stringify({
        base64: Buffer.from(input.bytes).toString("base64"),
        mimeType: input.mimeType,
        originalFilename: input.originalFilename,
        metadata: input.metadata ?? {},
      }),
    },
    ownerKey
  );
}

export async function loadLocalAsset(ownerKey: string, assetId: string) {
  return requestLocal<{ asset: LocalAssetManifest; base64: string }>(
    `/api/v1/assets/${encodeURIComponent(assetId)}`,
    { method: "GET" },
    ownerKey
  );
}

export async function getLocalAssetMetadata(
  ownerKey: string,
  assetId: string
) {
  const result = await requestLocal<{ asset: LocalAssetManifest }>(
    `/api/v1/assets/${encodeURIComponent(assetId)}/meta`,
    { method: "GET" },
    ownerKey
  );
  return result.asset;
}

export async function openLocalAssetStream(
  ownerKey: string,
  assetId: string
) {
  const config = await readConfig();
  const response = await fetch(
    `http://127.0.0.1:${config.port}/api/v1/assets/${encodeURIComponent(assetId)}/raw`,
    {
      headers: {
        authorization: `Bearer ${config.token}`,
        "x-formdigital-owner": ownerKey,
      },
    }
  );
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new Error(
      payload?.error?.message ||
        `Local Data Folder request failed (${response.status}).`
    );
  }
  if (!response.body) throw new Error("Local Data Folder asset stream unavailable.");
  return Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
}

export function storeLocalAssetFromRequest(
  ownerKey: string,
  source: import("node:http").IncomingMessage,
  input: {
    filename: string;
    metadata?: Record<string, unknown>;
    mimeType?: string;
  }
) {
  return new Promise<{ asset: LocalAssetManifest; deduplicated: boolean }>(
    (resolve, reject) => {
      void (async () => {
        try {
          const config = await readConfig();
          const query = new URLSearchParams({
            filename: input.filename,
            metadata: encodeURIComponent(JSON.stringify(input.metadata ?? {})),
            ...(input.mimeType ? { mimeType: input.mimeType } : {}),
          });
          const upstream = http.request(
            {
              hostname: "127.0.0.1",
              port: config.port,
              path: `/api/v1/assets/raw?${query}`,
              method: "POST",
              headers: {
                authorization: `Bearer ${config.token}`,
                "content-type": "application/octet-stream",
                "x-formdigital-owner": ownerKey,
                ...(source.headers["content-length"]
                  ? { "content-length": String(source.headers["content-length"]) }
                  : {}),
              },
            },
            response => {
              let payload = "";
              response.setEncoding("utf8");
              response.on("data", chunk => {
                payload += chunk;
                if (payload.length > 1024 * 1024) response.destroy();
              });
              response.on("end", () => {
                try {
                  const parsed = JSON.parse(payload) as {
                    asset?: LocalAssetManifest;
                    deduplicated?: boolean;
                    error?: { message?: string };
                  };
                  if (
                    response.statusCode &&
                    response.statusCode >= 200 &&
                    response.statusCode < 300 &&
                    parsed.asset
                  ) {
                    resolve({
                      asset: parsed.asset,
                      deduplicated: Boolean(parsed.deduplicated),
                    });
                  } else {
                    reject(
                      new Error(
                        parsed.error?.message ||
                          `Local Data Folder request failed (${response.statusCode}).`
                      )
                    );
                  }
                } catch (error) {
                  reject(error instanceof Error ? error : new Error("Raw asset transfer failed."));
                }
              });
            }
          );
          upstream.on("error", reject);
          source.on("error", error => {
            upstream.destroy();
            reject(error);
          });
          source.pipe(upstream);
        } catch (error) {
          reject(error instanceof Error ? error : new Error("Raw asset transfer failed."));
        }
      })();
    }
  );
}

export async function listLocalAssets(ownerKey: string) {
  return requestLocal<{ assets: LocalAssetManifest[] }>(
    "/api/v1/assets",
    { method: "GET" },
    ownerKey
  );
}

export async function deleteLocalAsset(ownerKey: string, assetId: string) {
  return requestLocal<{ deleted: true; assetId: string }>(
    `/api/v1/assets/${encodeURIComponent(assetId)}`,
    { method: "DELETE" },
    ownerKey
  );
}

export async function deleteLocalTemplateAssets(
  ownerKey: string,
  templateId: string
) {
  return requestLocal<{ deleted: number; templateId: string }>(
    `/api/v1/templates/${encodeURIComponent(templateId)}/assets`,
    { method: "DELETE" },
    ownerKey
  );
}

export type LocalIntegrityFinding = {
  severity: "error" | "warning";
  code: string;
  manifestId?: string;
  manifestFile?: string;
  objectFile?: string;
  account?: string;
  detail?: string;
};

export type LocalIntegrityScan = {
  scannedAt: string;
  manifestsScanned: number;
  findings: LocalIntegrityFinding[];
  healthy: boolean;
};

export async function runLocalIntegrityScan() {
  return requestLocal<LocalIntegrityScan>("/api/v1/integrity-scan", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function repairLocalIntegrity() {
  return requestLocal<{
    repaired: boolean;
    emergencyBackupId: string | null;
    quarantineId?: string;
    quarantined: string[];
    before: LocalIntegrityScan;
    after: LocalIntegrityScan;
  }>("/api/v1/integrity-repair", { method: "POST", body: JSON.stringify({}) });
}

export async function moveLocalDataFolder(dataFolder: string) {
  const result = await requestLocal<{
    moved: true;
    dataFolder: string;
    previousFolderPreserved: boolean;
  }>("/api/v1/data-folder/move", {
    method: "POST",
    body: JSON.stringify({ dataFolder }),
  });
  cachedConfig = cachedConfig
    ? { ...cachedConfig, dataFolder: result.dataFolder }
    : null;
  return result;
}

export async function reconnectLocalDataFolder(dataFolder: string) {
  const result = await requestLocal<{
    reconnected: true;
    dataFolder: string;
  }>("/api/v1/data-folder/reconnect", {
    method: "POST",
    body: JSON.stringify({ dataFolder }),
  });
  cachedConfig = cachedConfig
    ? { ...cachedConfig, dataFolder: result.dataFolder }
    : null;
  return result;
}

export async function recognizeLocalImage(input: {
  base64: string;
  mimeType: "image/png" | "image/jpeg";
  language: "auto" | "eng" | "chi_tra" | "chi_sim";
  width?: number;
  height?: number;
}) {
  return requestLocal<{
    provider: string;
    cost: string;
    words: Array<{
      text: string;
      confidence: number;
      left: number;
      top: number;
      width: number;
      height: number;
    }>;
    notice: string;
    imageWidth?: number;
    imageHeight?: number;
  }>("/api/v1/ocr/tesseract", { method: "POST", body: JSON.stringify(input) });
}

export async function getHostAccount() {
  return requestLocal<{ googleUserId: string | null; email?: string | null }>(
    "/api/v1/host-account",
    { method: "GET" }
  );
}

export async function setHostAccount(input: {
  googleUserId: string;
  email?: string | null;
}) {
  return requestLocal<{ googleUserId: string; email?: string | null }>(
    "/api/v1/host-account",
    {
      method: "PUT",
      body: JSON.stringify(input),
    }
  );
}

export async function createLocalBackup(ownerKey: string, templateId?: string) {
  return requestLocal<{
    id: string;
    createdAt: string;
    archiveBase64: string;
    manifest: unknown;
  }>(
    "/api/v1/backups",
    { method: "POST", body: JSON.stringify({ portable: true, templateId }) },
    ownerKey
  );
}

export async function restoreLocalBackup(
  ownerKey: string,
  archiveBase64: string,
  preserveExistingAssets = false
) {
  return requestLocal<{
    restored: true;
    emergencyBackupId: string;
    manifest: unknown;
  }>(
    "/api/v1/restore",
    {
      method: "POST",
      body: JSON.stringify({ archiveBase64, preserveExistingAssets }),
    },
    ownerKey
  );
}

export type LocalPortableBackupPreview = {
  id: string;
  schemaVersion: number;
  scope: "account" | "template";
  templateId?: string | null;
  createdAt: string | number;
  summary?: {
    templates: Array<{
      id: string;
      name: string;
      versions: number;
      instances: number;
    }>;
    templateCount: number;
    versionCount: number;
    instanceCount: number;
    mappingTemplateCount: number;
  };
};

const MAX_PORTABLE_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const PORTABLE_SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isLocalPortableBackupPreview(
  value: unknown
): value is LocalPortableBackupPreview {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const preview = value as Record<string, unknown>;
  return (
    typeof preview.id === "string" &&
    /^backup-[A-Za-z0-9_-]{1,240}$/.test(preview.id) &&
    preview.schemaVersion === 2 &&
    preview.scope === "account" &&
    (preview.templateId === null || preview.templateId === undefined) &&
    typeof preview.createdAt === "string" &&
    Number.isFinite(Date.parse(preview.createdAt))
  );
}

export async function createLocalStreamingBackup(ownerKey: string) {
  return requestLocal<{
    id: string;
    createdAt: string;
    filename: string;
    archiveBytes: number;
    archiveHash: string;
    fileCount: number;
    manifest: LocalPortableBackupPreview;
  }>(
    "/api/v1/portable-backups",
    { method: "POST", body: JSON.stringify({}) },
    ownerKey
  );
}

export async function openLocalStreamingBackup(
  ownerKey: string,
  backupId: string
) {
  if (!/^backup-[A-Za-z0-9_-]{1,240}$/.test(backupId))
    throw new LocalServiceRequestError(
      400,
      "portable_backup_id_invalid",
      "Portable Backup identifier is invalid."
    );
  const config = await readConfig();
  const response = await fetch(
    `http://127.0.0.1:${config.port}/api/v1/portable-backups/${encodeURIComponent(backupId)}/archive`,
    {
      headers: {
        authorization: `Bearer ${config.token}`,
        "x-formdigital-owner": ownerKey,
      },
    }
  );
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    const publicCode =
      typeof payload?.error?.code === "string" &&
      /^[a-z0-9_]{1,80}$/.test(payload.error.code)
        ? payload.error.code
        : "portable_backup_download_failed";
    throw new LocalServiceRequestError(
      response.status,
      publicCode,
      "Portable Backup download failed."
    );
  }
  if (!response.body)
    throw new LocalServiceRequestError(
      503,
      "portable_backup_stream_unavailable",
      "Portable Backup stream is unavailable."
    );
  const lengthHeader = response.headers.get("content-length");
  const contentLength = lengthHeader ? Number(lengthHeader) : null;
  if (
    contentLength !== null &&
    (!Number.isSafeInteger(contentLength) ||
      contentLength < 1 ||
      contentLength > MAX_PORTABLE_ARCHIVE_BYTES)
  )
    throw new LocalServiceRequestError(
      502,
      "portable_backup_stream_invalid",
      "Portable Backup stream metadata is invalid."
    );
  return {
    stream: Readable.fromWeb(
      response.body as import("node:stream/web").ReadableStream
    ),
    contentLength,
    filename: `${backupId}.formdigital-backup`,
  };
}

export function createLocalPortableRestoreSessionFromRequest(
  ownerKey: string,
  source: import("node:http").IncomingMessage
) {
  return new Promise<{
    sessionId: string;
    archiveBytes: number;
    expiresAt: string;
    manifest: LocalPortableBackupPreview;
  }>((resolve, reject) => {
    let settled = false;
    const succeed = (value: {
      sessionId: string;
      archiveBytes: number;
      expiresAt: string;
      manifest: LocalPortableBackupPreview;
    }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    void (async () => {
      try {
        const config = await readConfig();
        const upstream = http.request(
          {
            hostname: "127.0.0.1",
            port: config.port,
            path: "/api/v1/portable-restore-sessions",
            method: "POST",
            headers: {
              authorization: `Bearer ${config.token}`,
              "content-type": "application/octet-stream",
              "x-formdigital-owner": ownerKey,
              ...(source.headers["content-length"]
                ? { "content-length": String(source.headers["content-length"]) }
                : {}),
            },
          },
          response => {
            const chunks: Buffer[] = [];
            let size = 0;
            response.on("data", chunk => {
              if (settled) return;
              const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              size += bytes.byteLength;
              if (size > 16 * 1024 * 1024) {
                fail(
                  new LocalServiceRequestError(
                    502,
                    "portable_restore_response_too_large",
                    "Portable Backup verification response is too large."
                  )
                );
                response.destroy();
                return;
              }
              chunks.push(bytes);
            });
            response.on("end", () => {
              if (settled) return;
              try {
                const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
                  sessionId?: string;
                  archiveBytes?: number;
                  expiresAt?: string;
                  manifest?: LocalPortableBackupPreview;
                  error?: { code?: string; message?: string };
                };
                if (
                  response.statusCode &&
                  response.statusCode >= 200 &&
                  response.statusCode < 300 &&
                  typeof parsed.sessionId === "string" &&
                  PORTABLE_SESSION_ID_RE.test(parsed.sessionId) &&
                  Number.isSafeInteger(parsed.archiveBytes) &&
                  (parsed.archiveBytes as number) >= 1 &&
                  (parsed.archiveBytes as number) <= MAX_PORTABLE_ARCHIVE_BYTES &&
                  typeof parsed.expiresAt === "string" &&
                  Number.isFinite(Date.parse(parsed.expiresAt)) &&
                  isLocalPortableBackupPreview(parsed.manifest)
                ) {
                  succeed({
                    sessionId: parsed.sessionId,
                    archiveBytes: parsed.archiveBytes as number,
                    expiresAt: parsed.expiresAt,
                    manifest: parsed.manifest,
                  });
                  return;
                }
                fail(
                  new LocalServiceRequestError(
                    response.statusCode || 502,
                    typeof parsed.error?.code === "string" &&
                    /^[a-z0-9_]{1,80}$/.test(parsed.error.code)
                      ? parsed.error.code
                      : "portable_archive_rejected",
                    "Portable Backup was rejected."
                  )
                );
              } catch {
                fail(
                  new LocalServiceRequestError(
                    502,
                    "portable_restore_response_invalid",
                    "Portable Backup verification response is invalid."
                  )
                );
              }
            });
            response.on("aborted", () =>
              fail(
                new LocalServiceRequestError(
                  502,
                  "portable_restore_response_aborted",
                  "Portable Backup verification response was interrupted."
                )
              )
            );
            response.on("error", () =>
              fail(
                new LocalServiceRequestError(
                  502,
                  "portable_restore_response_failed",
                  "Portable Backup verification response failed."
                )
              )
            );
            response.on("close", () => {
              if (!response.complete)
                fail(
                  new LocalServiceRequestError(
                    502,
                    "portable_restore_response_aborted",
                    "Portable Backup verification response was interrupted."
                  )
                );
            });
          }
        );
        upstream.setTimeout(30 * 60 * 1000, () =>
          upstream.destroy(new Error("Portable Backup upload timed out."))
        );
        upstream.on("error", () =>
          fail(
            new LocalServiceRequestError(
              503,
              "portable_restore_upload_failed",
              "Portable Backup upload failed."
            )
          )
        );
        source.on("aborted", () => {
          upstream.destroy();
          fail(
            new LocalServiceRequestError(
              400,
              "portable_restore_upload_aborted",
              "Portable Backup upload was interrupted."
            )
          );
        });
        source.on("error", () => {
          upstream.destroy();
          fail(
            new LocalServiceRequestError(
              400,
              "portable_restore_upload_failed",
              "Portable Backup upload failed."
            )
          );
        });
        source.on("close", () => {
          if (source.complete || settled) return;
          upstream.destroy();
          fail(
            new LocalServiceRequestError(
              400,
              "portable_restore_upload_aborted",
              "Portable Backup upload was interrupted."
            )
          );
        });
        source.pipe(upstream);
      } catch (error) {
        fail(
          error instanceof Error
            ? error
            : new Error("Portable Backup upload failed.")
        );
      }
    })();
  });
}

export async function commitLocalPortableRestoreSession(
  ownerKey: string,
  sessionId: string
) {
  return requestLocal<{
    restored: true;
    emergencyBackupId: string;
    transactionId: string;
    manifest: LocalPortableBackupPreview & Record<string, unknown>;
  }>(
    `/api/v1/portable-restore-sessions/${encodeURIComponent(sessionId)}/commit`,
    { method: "POST", body: JSON.stringify({}) },
    ownerKey
  );
}

export async function deleteLocalPortableRestoreSession(
  ownerKey: string,
  sessionId: string
) {
  return requestLocal<{ deleted: true }>(
    `/api/v1/portable-restore-sessions/${encodeURIComponent(sessionId)}`,
    { method: "DELETE" },
    ownerKey
  );
}
