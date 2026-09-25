/**
 * Formdigital Local Data Folder service.
 * Binds only to 127.0.0.1 and requires a bearer token supplied by the local config.
 * Never exposes a writable LAN or public HTTP endpoint.
 */
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import {
  constants as fsConstants,
  createReadStream,
  createWriteStream,
  existsSync,
} from "node:fs";
import { isDeepStrictEqual, promisify } from "node:util";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import {
  canonicalJson,
  inspectWorkspaceStorageV2File,
  WorkspaceStorageError,
  WorkspaceStorageV2,
  migrateLegacyWorkspaceV2,
  ownerWorkspaceV2Paths,
  calculateCanonicalTransactionBytes,
  formatJournalArchiveTransactionId,
  planJournalArchiveBatches,
  JOURNAL_ARCHIVE_MAX_BATCH_COUNT,
  JOURNAL_ARCHIVE_MAX_BATCH_BYTES,
} from "./server/formdigital/workspace-storage-v2.mjs";
import {
  extractPortableZip,
  hashPortableFile,
  PORTABLE_STREAM_LIMITS,
  PortableArchiveStreamError,
  writePortableStoredZip,
} from "./server/formdigital/portable-archive-stream.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const configPath =
  process.env.FORMDIGITAL_LOCAL_CONFIG ||
  path.join(here, "local-service-config.json");
const config = JSON.parse(await fs.readFile(configPath, "utf8"));
// Build marker for the launcher: the modification time of this file when the
// process started. A long-running service whose marker no longer matches the
// file on disk is executing older code, which would otherwise fail silently.
const SOURCE_MODIFIED_AT_MS = await fs
  .stat(fileURLToPath(import.meta.url))
  .then(stat => Math.round(stat.mtimeMs))
  .catch(() => null);
const RAW_ASSET_MAX_BYTES = Number.parseInt(
  process.env.FORMDIGITAL_MAX_RAW_ASSET_BYTES || "",
  10,
) || 1024 * 1024 * 1024;
let root = path.resolve(config.dataFolder);
const directoriesFor = folder => ({
  root: folder,
  objects: path.join(folder, "objects"),
  manifests: path.join(folder, "manifests"),
  backups: path.join(folder, "backups"),
  journal: path.join(folder, "journal"),
  staging: path.join(folder, "staging"),
  metadata: path.join(folder, "metadata"),
  accounts: path.join(folder, "accounts"),
  "workspace-v2": path.join(folder, "workspace-v2"),
  quarantine: path.join(folder, "quarantine"),
});
let dirs = directoriesFor(root);
let rootAvailable = false;
try {
  await fs.access(root);
  rootAvailable = true;
} catch {
  // Start in reconnect-only mode. Never silently create an empty replacement.
}
if (rootAvailable)
  for (const value of Object.values(dirs))
    await fs.mkdir(value, { recursive: true });

const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
const execFileAsync = promisify(execFile);
const safeFilename = name =>
  path
    .basename(String(name || "upload.bin"))
    .replace(/[^\w.\-\u4e00-\u9fff]/g, "_")
    .slice(0, 180) || "upload.bin";
const now = () => new Date().toISOString();
const ownerKeyHash = ownerKey => sha256(Buffer.from(String(ownerKey), "utf8"));
const isErrnoCode = (error, code) =>
  !!error &&
  typeof error === "object" &&
  "code" in error &&
  String(error.code) === code;

// A Portable Backup restore must never surface an internal filesystem error to
// the caller: raw errors can carry absolute paths, temporary staging names or
// owner hashes. Every restore rejection is therefore re-thrown as a curated
// error carrying a `safeMessage` that the HTTP layer is allowed to echo.
const PORTABLE_RESTORE_REJECTED = "PORTABLE_RESTORE_REJECTED";
const SAFE_PORTABLE_RESTORE_FAILURE =
  "Portable Backup restore was aborted and the previous state was restored. The pre-restore Emergency Backup is preserved.";
function portableRestoreRejection(safeMessage) {
  const error = new Error(safeMessage);
  error.code = PORTABLE_RESTORE_REJECTED;
  error.safeMessage = safeMessage;
  return error;
}

function requireOwner(request) {
  const ownerKey = String(request.headers["x-formdigital-owner"] || "").trim();
  if (!ownerKey || ownerKey.length > 512)
    throw new Error("A valid x-formdigital-owner header is required.");
  return { ownerKey, ownerKeyHash: ownerKeyHash(ownerKey) };
}

function accountPaths(hash) {
  const accountRoot = path.join(dirs.accounts, hash);
  return { accountRoot, workspace: path.join(accountRoot, "workspace.json") };
}

async function atomicWrite(target, bytes) {
  const transactionId = crypto.randomUUID();
  const temp = `${target}.formdigital-atomic-${transactionId}.tmp`;
  const previous = `${target}.formdigital-atomic-${transactionId}.previous`;
  const descriptor = path.join(
    dirs.staging,
    `.formdigital-atomic-${transactionId}.json`,
  );
  await fs.mkdir(path.dirname(target), { recursive: true });
  const handle = await fs.open(temp, "wx");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  let previousCreated = false;
  try {
    try {
      await fs.copyFile(target, previous, fsConstants.COPYFILE_EXCL);
      const previousHandle = await fs.open(previous, "r+");
      try {
        await previousHandle.sync();
      } finally {
        await previousHandle.close();
      }
      previousCreated = true;
    } catch (error) {
      if (!isErrnoCode(error, "ENOENT")) throw error;
    }
    const descriptorHandle = await fs.open(descriptor, "wx");
    try {
      await descriptorHandle.writeFile(
        JSON.stringify({ schemaVersion: 1, target, temp, previous }),
        "utf8",
      );
      await descriptorHandle.sync();
    } finally {
      await descriptorHandle.close();
    }
    await syncDirectory(dirs.staging);

    // Node's same-filesystem rename replaces a regular-file destination
    // atomically. Unlike the old target->staging->target sequence, the
    // canonical path is never deliberately removed. If Windows cannot replace
    // an open destination it fails closed and leaves the old target in place.
    await fs.rename(temp, target);
    await syncDirectory(path.dirname(target));
    if (previousCreated)
      await fs.rm(previous, { force: true }).catch(() => {});
    await fs.rm(descriptor, { force: true }).catch(() => {});
    await syncDirectory(dirs.staging);
  } catch (error) {
    await fs.rm(temp, { force: true });
    if (previousCreated) await fs.rm(previous, { force: true });
    await fs.rm(descriptor, { force: true });
    throw error;
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch {
    // Directory fsync is unavailable on some Windows/filesystem combinations.
    // Best effort by design: file fsync above is mandatory, but parent-folder
    // fsync is not supported consistently by Node on Windows/network filesystems.
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function atomicReplaceExternalFile(target, bytes) {
  const temp = `${target}.formdigital-replace-${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(temp, "wx");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    // Same-directory rename is the commit point. The canonical config path is
    // never deliberately removed, so a Windows sharing violation leaves the
    // previously committed config readable.
    await fs.rename(temp, target);
    await syncDirectory(path.dirname(target));
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function atomicCopyPortableFile(source, target, expected) {
  const temp = `${target}.formdigital-copy-${crypto.randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  const hash = crypto.createHash("sha256");
  let size = 0;
  try {
    await pipeline(
      createReadStream(source, { highWaterMark: 256 * 1024 }),
      new Transform({
        transform(chunk, _encoding, callback) {
          size += chunk.length;
          hash.update(chunk);
          callback(null, chunk);
        },
      }),
      createWriteStream(temp, { flags: "wx" }),
    );
    const durableHandle = await fs.open(temp, "r+");
    try {
      await durableHandle.sync();
    } finally {
      await durableHandle.close();
    }
    const contentHash = hash.digest("hex");
    if (
      expected &&
      (size !== expected.size || contentHash !== expected.contentHash)
    )
      throw new PortableArchiveStreamError("PORTABLE_SOURCE_CHANGED");
    await fs.rename(temp, target);
    await syncDirectory(path.dirname(target));
    return Object.freeze({ size, contentHash });
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function openVerifiedPortableArchive(filePath, expected) {
  let handle;
  try {
    handle = await fs.open(filePath, "r");
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      !Number.isSafeInteger(stat.size) ||
      stat.size < 1 ||
      stat.size > PORTABLE_STREAM_LIMITS.archiveBytes
    )
      throw new PortableArchiveStreamError("PORTABLE_SOURCE_INVALID");
    const hash = crypto.createHash("sha256");
    let size = 0;
    const verificationStream = handle.createReadStream({
      autoClose: false,
      start: 0,
      highWaterMark: 256 * 1024,
    });
    for await (const chunk of verificationStream) {
      size += chunk.length;
      if (size > PORTABLE_STREAM_LIMITS.archiveBytes)
        throw new PortableArchiveStreamError("PORTABLE_SOURCE_TOO_LARGE");
      hash.update(chunk);
    }
    const contentHash = hash.digest("hex");
    if (
      size !== stat.size ||
      size !== expected.size ||
      contentHash !== expected.contentHash
    )
      throw new PortableArchiveStreamError("PORTABLE_SOURCE_CHANGED");
    return Object.freeze({ handle, size, contentHash });
  } catch (error) {
    await handle?.close().catch(() => {});
    throw error;
  }
}

function isPathInsideRoot(candidate) {
  const relative = path.relative(root, path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function recoverAtomicTransactions() {
  const names = await fs.readdir(dirs.staging).catch(() => []);
  for (const name of names.filter(value =>
    /^\.formdigital-atomic-[0-9a-f-]+\.json$/i.test(value)
  )) {
    const descriptor = path.join(dirs.staging, name);
    const transactionId = name.slice(
      ".formdigital-atomic-".length,
      -".json".length,
    );
    let transaction;
    try {
      transaction = JSON.parse(await fs.readFile(descriptor, "utf8"));
      if (
        transaction?.schemaVersion !== 1 ||
        ![transaction.target, transaction.temp, transaction.previous].every(
          value => typeof value === "string" && isPathInsideRoot(value),
        ) ||
        transaction.temp !==
          `${transaction.target}.formdigital-atomic-${transactionId}.tmp` ||
        transaction.previous !==
          `${transaction.target}.formdigital-atomic-${transactionId}.previous`
      )
        throw new Error("invalid atomic transaction descriptor");
    } catch {
      // An untrusted or torn descriptor cannot safely name a recovery target.
      // Quarantine it instead of following paths from malformed JSON.
      await fs.rename(
        descriptor,
        path.join(dirs.quarantine, `atomic-descriptor-${crypto.randomUUID()}.json`),
      ).catch(() => fs.rm(descriptor, { force: true }));
      continue;
    }
    const targetExists = await fs.stat(transaction.target).then(
      stat => stat.isFile(),
      () => false,
    );
    if (!targetExists) {
      const previousExists = await fs.stat(transaction.previous).then(
        stat => stat.isFile(),
        () => false,
      );
      const tempExists = await fs.stat(transaction.temp).then(
        stat => stat.isFile(),
        () => false,
      );
      if (previousExists) await fs.rename(transaction.previous, transaction.target);
      else if (tempExists) await fs.rename(transaction.temp, transaction.target);
    }
    await fs.rm(transaction.temp, { force: true });
    await fs.rm(transaction.previous, { force: true });
    await fs.rm(descriptor, { force: true });
    await syncDirectory(path.dirname(transaction.target));
  }
  await syncDirectory(dirs.staging);
}

const LEGACY_RESTORE_DOMAINS = [
  "objects",
  "manifests",
  "accounts",
  "metadata",
  "journal",
  "workspace-v2",
];

async function writeLegacyRestoreDescriptor(transactionId, state) {
  await atomicWrite(
    path.join(dirs.staging, `.formdigital-restore-${transactionId}.json`),
    Buffer.from(JSON.stringify({ schemaVersion: 1, transactionId, ...state })),
  );
}

async function recoverLegacyRestoreTransactions() {
  const names = await fs.readdir(dirs.staging).catch(() => []);
  for (const name of names.filter(value =>
    /^\.formdigital-restore-[0-9a-f-]+\.json$/i.test(value)
  )) {
    const transactionId = name.slice(
      ".formdigital-restore-".length,
      -".json".length,
    );
    const descriptorPath = path.join(dirs.staging, name);
    let descriptor;
    try {
      descriptor = JSON.parse(await fs.readFile(descriptorPath, "utf8"));
      if (
        descriptor?.schemaVersion !== 1 ||
        descriptor?.transactionId !== transactionId ||
        !["swapping", "committed"].includes(descriptor?.phase)
      )
        throw new Error("invalid restore descriptor");
    } catch {
      // Starting without a trustworthy generation marker could expose a mixed
      // five-domain state. Fail closed and leave every recovery artefact in
      // place for a subsequent repair/retry.
      throw new Error("Local restore recovery descriptor is invalid.");
    }
    const candidate = path.join(dirs.staging, `restore-${transactionId}`);
    const previous = Object.fromEntries(
      LEGACY_RESTORE_DOMAINS.map(domain => [
        domain,
        path.join(dirs.staging, `previous-${domain}-${transactionId}`),
      ]),
    );
    if (descriptor.phase === "swapping") {
      // A swap has no committed generation until the marker says otherwise.
      // The existence of each previous directory is the durable fact, so this
      // also covers a crash between rename and descriptor update.
      for (const domain of [...LEGACY_RESTORE_DOMAINS].reverse()) {
        const previousExists = await fs.lstat(previous[domain]).then(
          stat => stat.isDirectory(),
          () => false,
        );
        if (!previousExists) continue;
        await fs.rm(dirs[domain], { recursive: true, force: true });
        await fs.rename(previous[domain], dirs[domain]);
      }
    } else {
      // Commit marker is authoritative: never resurrect the old generation.
      const liveGenerationComplete = await Promise.all(
        LEGACY_RESTORE_DOMAINS.map(domain =>
          fs.lstat(dirs[domain]).then(stat => stat.isDirectory(), () => false)
        ),
      );
      if (!liveGenerationComplete.every(Boolean))
        throw new Error("Committed Local restore generation is incomplete.");
      for (const domain of LEGACY_RESTORE_DOMAINS)
        await fs.rm(previous[domain], { recursive: true, force: true });
    }
    await fs.rm(candidate, { recursive: true, force: true });
    await fs.rm(descriptorPath, { force: true });
    await syncDirectory(dirs.staging);
  }
}

async function appendJournalDirect(entry) {
  const handle = await fs.open(path.join(dirs.journal, "operations.ndjson"), "a");
  try {
    await handle.writeFile(`${JSON.stringify(entry)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function appendJournal(operation, manifest) {
  const entry = { at: now(), operation, manifest };
  try {
    await appendJournalDirect(entry);
  } catch {
    // Journal is post-commit audit data. A failure must not turn an already
    // durable mutation into an API error. Preserve a replayable record when
    // staging remains writable; if the whole volume is unavailable, the
    // primary mutation result is still the authoritative outcome.
    try {
      await atomicWrite(
        path.join(dirs.staging, `.formdigital-pending-journal-${crypto.randomUUID()}.json`),
        Buffer.from(JSON.stringify({ schemaVersion: 1, entry })),
      );
    } catch {
      // Best effort only after the primary commit point.
    }
  }
}

async function recoverPendingJournals() {
  const names = await fs.readdir(dirs.staging).catch(() => []);
  for (const name of names.filter(value =>
    /^\.formdigital-pending-journal-[0-9a-f-]+\.json$/i.test(value)
  )) {
    const pendingPath = path.join(dirs.staging, name);
    let pending;
    try {
      pending = JSON.parse(await fs.readFile(pendingPath, "utf8"));
      if (
        pending?.schemaVersion !== 1 ||
        !pending.entry ||
        typeof pending.entry !== "object" ||
        typeof pending.entry.operation !== "string" ||
        pending.entry.operation.length < 1 ||
        pending.entry.operation.length > 120
      )
        throw new Error("invalid pending journal");
    } catch {
      await fs.rename(
        pendingPath,
        path.join(dirs.quarantine, `journal-descriptor-${crypto.randomUUID()}.json`),
      ).catch(() => {});
      continue;
    }
    await appendJournalDirect(pending.entry);
    await fs.rm(pendingPath, { force: true });
  }
}

function parseRawMetadata(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(decodeURIComponent(String(value)));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("invalid");
    return parsed;
  } catch {
    throw Object.assign(new Error("Invalid asset metadata."), {
      statusCode: 400,
      publicCode: "invalid_asset_metadata",
    });
  }
}

// Raw (streamed) assets started out as CSV imports only. Template sources and
// rasterised pages use the same streamed path now, so the stored type comes
// from a fixed allow-list and still defaults to text/csv for older callers.
const RAW_ASSET_MIME_TYPES = new Set([
  "text/csv",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/png",
  "image/jpeg",
  "application/octet-stream",
]);

function parseRawMimeType(value) {
  if (!value) return "text/csv";
  const mimeType = String(value).trim().toLowerCase();
  if (RAW_ASSET_MIME_TYPES.has(mimeType)) return mimeType;
  throw Object.assign(new Error("Unsupported raw asset type."), {
    statusCode: 400,
    publicCode: "invalid_asset_mime_type",
  });
}

async function requireLiveAssetRelations(ownerHash, metadata) {
  const templateId =
    typeof metadata?.templateId === "string" && metadata.templateId.trim()
      ? metadata.templateId.trim()
      : null;
  const versionId =
    typeof metadata?.templateVersionId === "string" &&
    metadata.templateVersionId.trim()
      ? metadata.templateVersionId.trim()
      : null;
  const instanceId =
    typeof metadata?.instanceId === "string" && metadata.instanceId.trim()
      ? metadata.instanceId.trim()
      : null;
  if (!templateId && !versionId && !instanceId) return;
  const { workspace } = await loadWorkspace(ownerHash);
  const templates = Array.isArray(workspace.templates) ? workspace.templates : [];
  const versions = Array.isArray(workspace.templateVersions)
    ? workspace.templateVersions
    : [];
  const template = templateId
    ? templates.find(item => item?.id === templateId)
    : null;
  const version = versionId
    ? versions.find(item => item?.id === versionId)
    : null;
  let instance = null;
  if (instanceId) {
    const workspaceOwnerKey = typeof workspace.ownerKey === "string" && workspace.ownerKey
      ? workspace.ownerKey
      : null;
    if (workspaceOwnerKey) {
      const storage = await ensureWorkspaceStorageV2({
        ownerKey: workspaceOwnerKey,
        ownerKeyHash: ownerHash,
      });
      try {
        instance = storage.query({
          collection: "instances",
          where: { id: instanceId },
          limit: 1,
        }).records[0] ?? null;
      } finally {
        storage.close();
      }
    }
  }
  if (
    (templateId && !template) ||
    (versionId && !version) ||
    (templateId && versionId && version?.templateId !== templateId) ||
    (instanceId && !instance) ||
    (instance && templateId && instance.templateId !== templateId) ||
    (instance && versionId && instance.templateVersionId !== versionId)
  )
    throw Object.assign(new Error("Asset relation no longer exists."), {
      statusCode: 409,
      publicCode: "asset_relation_missing",
    });
}

async function hashFileSha256(filePath) {
  const verifier = crypto.createHash("sha256");
  await pipeline(
    createReadStream(filePath),
    new Transform({
      transform(chunk, _encoding, callback) {
        verifier.update(chunk);
        callback();
      },
    }),
  );
  return verifier.digest("hex");
}

async function requireStoredObjectMatch(objectPath, expectedHash, expectedSize) {
  const stat = await fs.lstat(objectPath);
  if (
    !stat.isFile() ||
    (expectedSize !== undefined && stat.size !== expectedSize) ||
    await hashFileSha256(objectPath) !== expectedHash
  )
    throw Object.assign(new Error("stored object verification failed"), {
      statusCode: 409,
      publicCode: "asset_object_conflict",
    });
}

async function storeRawAsset(request, response, owner) {
  const url = new URL(request.url, "http://localhost");
  if (!/application\/octet-stream/i.test(String(request.headers["content-type"] || ""))) {
    reject(response, 400, "invalid_content_type", "Raw assets require application/octet-stream.");
    return;
  }
  const metadata = parseRawMetadata(url.searchParams.get("metadata"));
  const rawMimeType = parseRawMimeType(url.searchParams.get("mimeType"));
  const hash = crypto.createHash("sha256");
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      this.size = (this.size ?? 0) + chunk.length;
      if (this.size > RAW_ASSET_MAX_BYTES) {
        callback(Object.assign(new Error("raw asset too large"), {
          statusCode: 413,
          publicCode: "asset_too_large",
          safeMessage: "Asset exceeds the local size limit.",
        }));
        return;
      }
      callback(null, chunk);
    },
  });
  const temporaryPath = path.join(
    dirs.staging,
    `raw-asset-${crypto.randomUUID()}.tmp`,
  );
  const output = createWriteStream(temporaryPath, { flags: "wx" });
  try {
    await pipeline(request, counter, output);
    if (!counter.size)
      throw Object.assign(new Error("empty asset"), {
        statusCode: 400,
        publicCode: "empty_asset",
      });
    const contentHash = hash.digest("hex");
    // createWriteStream closing only means the kernel accepted the bytes. A
    // manifest must never make them durable-by-reference before the staging
    // file itself has been flushed.
    const stagedHandle = await fs.open(temporaryPath, "r+");
    try {
      await stagedHandle.sync();
    } finally {
      await stagedHandle.close();
    }
    // This check is deliberately immediately before the object/manifest commit.
    // The service-wide mutation gate prevents a Template rollback/delete from
    // interleaving between this validation and the manifest write.
    await requireLiveAssetRelations(owner.ownerKeyHash, metadata);
    const objectPath = path.join(dirs.objects, contentHash);
    let objectExisted = await fs.lstat(objectPath).then(
      stat => stat.isFile(),
      error => {
        if (isErrnoCode(error, "ENOENT")) return false;
        throw error;
      },
    );
    if (!objectExisted) {
      try {
        await fs.rename(temporaryPath, objectPath);
        await syncDirectory(dirs.objects);
      } catch (error) {
        if (!isErrnoCode(error, "EEXIST") && !isErrnoCode(error, "EPERM")) throw error;
        // Windows can report EPERM for several unrelated conditions. Treating
        // it as de-duplication without proving the target would let a directory
        // or corrupt object receive a valid manifest.
        objectExisted = true;
      }
    }
    if (objectExisted) {
      await requireStoredObjectMatch(objectPath, contentHash, counter.size);
    }
    // Object bytes are content-addressed and shared, but every upload receives
    // its own manifest. A manifest is a lifecycle reference carrying the
    // current Template/version metadata; reusing an older manifest would let a
    // later rollback or Template deletion remove another Template's asset.
    const id = `asset-${crypto.randomUUID()}`;
    const manifest = {
      id,
      schemaVersion: 1,
      ownerKeyHash: owner.ownerKeyHash,
      contentHash,
      originalFilename: safeFilename(url.searchParams.get("filename")),
      mimeType: rawMimeType,
      size: counter.size,
      createdAt: now(),
      metadata,
    };
    await atomicWrite(
      path.join(dirs.manifests, `${id}.json`),
      Buffer.from(JSON.stringify(manifest, null, 2)),
    );
    await appendJournal("asset.put.raw", {
      id,
      ownerKeyHash: owner.ownerKeyHash,
      contentHash,
      size: manifest.size,
    });
    response.writeHead(objectExisted ? 200 : 201, {
      "content-type": "application/json; charset=utf-8",
    });
    response.end(JSON.stringify({ asset: manifest, deduplicated: objectExisted }));
  } catch (error) {
    request.destroy();
    const status = Number(error?.statusCode) || 503;
    const code = String(error?.publicCode) ||
      (status === 413 ? "raw_asset_too_large" : status === 400 ? "invalid_raw_asset" : "raw_asset_unavailable");
    const message =
      status === 413
        ? `Raw asset exceeds the configured ${RAW_ASSET_MAX_BYTES} byte safety limit.`
        : status === 400
          ? "The raw asset could not be accepted."
          : "The raw asset transfer was interrupted.";
    if (!response.headersSent) reject(response, status, code, message);
    else response.destroy();
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

const DATA_SCHEMA_VERSION = 1;
const dataSchemaPath = () => path.join(dirs.metadata, "data-schema.json");

async function ensureDataFolderSchema() {
  let state = { schemaVersion: 0, appliedMigrations: [] };
  try {
    state = JSON.parse(await fs.readFile(dataSchemaPath(), "utf8"));
  } catch (error) {
    if (
      !(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
    )
      throw error;
  }
  if (!Number.isInteger(state.schemaVersion) || state.schemaVersion < 0)
    throw new Error("Local Data Folder schema metadata is invalid.");
  if (state.schemaVersion > DATA_SCHEMA_VERSION)
    throw new Error(
      "Local Data Folder was created by a newer service version; refusing unsafe downgrade."
    );
  while (state.schemaVersion < DATA_SCHEMA_VERSION) {
    const fromVersion = state.schemaVersion;
    const toVersion = fromVersion + 1;
    const migrationId = `data-schema-v${fromVersion}-to-v${toVersion}`;
    const next = {
      schemaVersion: toVersion,
      appliedMigrations: [
        ...(Array.isArray(state.appliedMigrations)
          ? state.appliedMigrations
          : []),
        { id: migrationId, appliedAt: now() },
      ],
    };
    await atomicWrite(
      dataSchemaPath(),
      Buffer.from(JSON.stringify(next, null, 2))
    );
    await appendJournal("data-schema.migrate", {
      migrationId,
      fromVersion,
      toVersion,
    });
    state = next;
  }
  return state;
}

if (rootAvailable) {
  await recoverAtomicTransactions();
  await recoverLegacyRestoreTransactions();
  await recoverPendingJournals();
  await ensureDataFolderSchema();
}

function allowedOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return undefined;
  return config.allowedOrigins.includes(origin) ? origin : undefined;
}

function reject(response, status, code, message) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify({ error: { code, message } }));
}

function secure(request, response) {
  const origin = allowedOrigin(request);
  if (request.headers.origin && !origin) {
    reject(
      response,
      403,
      "origin_not_allowed",
      "This website origin is not allowed by the local service configuration."
    );
    return false;
  }
  if (origin) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "Origin");
  }
  response.setHeader(
    "access-control-allow-headers",
    "authorization, content-type, x-formdigital-owner"
  );
  response.setHeader(
    "access-control-allow-methods",
    "GET, POST, PUT, DELETE, OPTIONS"
  );
  response.setHeader("access-control-allow-private-network", "true");
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return false;
  }
  if (request.url === "/health") return true;
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  const tokenBytes = Buffer.from(token || "");
  const expectedBytes = Buffer.from(String(config.token || ""));
  if (
    !token ||
    tokenBytes.length !== expectedBytes.length ||
    !crypto.timingSafeEqual(tokenBytes, expectedBytes)
  ) {
    reject(
      response,
      401,
      "local_token_required",
      "A valid Local Data Folder bearer token is required."
    );
    return false;
  }
  return true;
}

async function loadWorkspace(ownerHash) {
  const account = accountPaths(ownerHash);
  try {
    const envelope = JSON.parse(await fs.readFile(account.workspace, "utf8"));
    if (
      !Number.isSafeInteger(envelope.revision) ||
      envelope.revision < 0 ||
      !envelope.workspace
    )
      throw new Error("Workspace envelope is invalid.");
    return envelope;
  } catch (error) {
    if (
      !(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
    )
      throw error;
    return {
      revision: 0,
      workspace: { schemaVersion: 1, createdAt: now(), updatedAt: now() },
    };
  }
}

// Workspace v2 is authoritative for these high-growth record families.  The
// v1 JSON envelope remains the compatibility store for bounded Template and UI
// metadata, but retaining duplicate copies of these records eventually makes
// even a one-field preference update exceed the v1 50 MiB request ceiling.
const V2_AUTHORITATIVE_LEGACY_COLLECTIONS = Object.freeze([
  "instances",
  "importRuns",
  "importRows",
  "mappingDecisions",
]);
const LEGACY_WORKSPACE_COMPACT_MAX_BYTES = 32 * 1024 * 1024;
// Start the cutover before the compact-envelope ceiling. This margin lets a
// normal v1 save cross the trigger and be migrated on the next operation
// without creating an unreachable 32-40 MiB band.
const LEGACY_WORKSPACE_COMPACTION_TRIGGER_BYTES = 28 * 1024 * 1024;
const LEGACY_WORKSPACE_MIGRATION_MAX_BYTES = 64 * 1024 * 1024;
const LEGACY_WORKSPACE_PROJECTION_KEY = "__formdigitalWorkspaceV2";
/**
 * Bounds on the v1 envelope's operation journal.
 *
 * The application layer already trims this array to 5,000 entries
 * (server/formdigital/workspaceStore.ts), so these are a backstop against a
 * caller that is not the application, not a second retention policy: the
 * service refuses an oversized journal rather than trimming it, because the
 * entries older than the cutover are the only copy of that history for an
 * account that has never migrated, and dropping them here would delete
 * authoritative data with nothing said about it.
 *
 * A count on its own is not a bound. One record carrying a megabyte of text
 * passes a 5,000-entry check and still pushes the envelope past the
 * compatibility ceiling, so the total and the individual record are bounded
 * too.
 */
const LEGACY_WORKSPACE_JOURNAL_MAX_ENTRIES = 5_000;
const LEGACY_WORKSPACE_JOURNAL_MAX_BYTES = 8 * 1024 * 1024;
const LEGACY_WORKSPACE_JOURNAL_MAX_RECORD_BYTES = 64 * 1024;
const legacyWorkspaceCompactionChecks = new Set();
const pendingV2HistoryOwners = new Set();

function workspaceProjectionMarker(workspace) {
  const marker = workspace?.preferences?.[LEGACY_WORKSPACE_PROJECTION_KEY];
  if (
    !marker ||
    typeof marker !== "object" ||
    Array.isArray(marker) ||
    marker.schemaVersion !== 1 ||
    marker.layout !== "v2-authoritative-high-growth" ||
    !Number.isSafeInteger(marker.sourceRevision) ||
    marker.sourceRevision < 0 ||
    typeof marker.sourceHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(marker.sourceHash) ||
    typeof marker.safetyBackupId !== "string" ||
    !/^backup-[A-Za-z0-9_-]{1,240}$/.test(marker.safetyBackupId) ||
    typeof marker.compactedAt !== "string" ||
    !Array.isArray(marker.collections) ||
    marker.collections.length !== V2_AUTHORITATIVE_LEGACY_COLLECTIONS.length ||
    !V2_AUTHORITATIVE_LEGACY_COLLECTIONS.every(
      (collection, index) => marker.collections[index] === collection,
    )
  )
    return null;
  return marker;
}

function hasNonEmptyV2AuthoritativeLegacyCollections(workspace) {
  return V2_AUTHORITATIVE_LEGACY_COLLECTIONS.some(
    collection => Array.isArray(workspace?.[collection]) && workspace[collection].length > 0,
  );
}

function hasOnlyEmptyV2AuthoritativeLegacyCollections(workspace) {
  return V2_AUTHORITATIVE_LEGACY_COLLECTIONS.every(
    collection => Array.isArray(workspace?.[collection]) && workspace[collection].length === 0,
  );
}

/**
 * Why a Workspace v2 parity check failed, in shape only.
 *
 * A record's values are the person's own form data and are never written to a
 * log. Collection names, counts and key names are schema, and without them a
 * parity failure is indistinguishable from any other fault.
 */
function reportV2ParityMismatch(collection, reason) {
  console.error(
    `[local-data-service] workspace v2 parity mismatch in "${collection}": ${reason}`,
  );
}

function describeRecordDifference(stored, legacy) {
  if (!stored || typeof stored !== "object" || Array.isArray(stored))
    return "stored record is not an object";
  if (!legacy || typeof legacy !== "object" || Array.isArray(legacy))
    return "legacy record is not an object";
  const storedKeys = Object.keys(stored);
  const legacyKeys = Object.keys(legacy);
  const onlyStored = storedKeys.filter(key => !legacyKeys.includes(key));
  const onlyLegacy = legacyKeys.filter(key => !storedKeys.includes(key));
  if (onlyStored.length || onlyLegacy.length)
    return `keys only in storage [${onlyStored.join(", ")}], keys only in legacy [${onlyLegacy.join(", ")}]`;
  const changed = storedKeys.filter(
    key => !isDeepStrictEqual(stored[key], legacy[key]),
  );
  return `same keys, differing values in [${changed.join(", ")}]`;
}

async function v2AuthoritativeCollectionsMatchStorage(workspace, storage) {
  for (const collection of V2_AUTHORITATIVE_LEGACY_COLLECTIONS) {
    const stored = workspace?.[collection];
    // A Workspace saved before one of these collections existed simply holds
    // no records of it — which is exactly what the projection writes, and what
    // hasNonEmpty/Equal already assume. Counting "absent" as invalid made such
    // a Workspace permanently unreadable once it crossed the cutover trigger:
    // the safety backup verified its own output, rejected it, and every read
    // failed with a detail-free 500. A present-but-wrong type is still refused.
    if (stored !== undefined && !Array.isArray(stored)) {
      reportV2ParityMismatch(collection, "legacy value is not an array");
      return false;
    }
    const legacyRecords = stored ?? [];
    let index = 0;
    for await (const { record } of storage.exportRecords({ collection })) {
      if (index >= legacyRecords.length) {
        reportV2ParityMismatch(
          collection,
          `storage holds more than the legacy ${legacyRecords.length} records`,
        );
        return false;
      }
      if (!isDeepStrictEqual(record, legacyRecords[index])) {
        reportV2ParityMismatch(
          collection,
          `record ${index} differs: ${describeRecordDifference(record, legacyRecords[index])}`,
        );
        return false;
      }
      index += 1;
    }
    if (index !== legacyRecords.length) {
      reportV2ParityMismatch(
        collection,
        `storage holds ${index} records, legacy holds ${legacyRecords.length}`,
      );
      return false;
    }
  }
  return true;
}

function projectLegacyWorkspaceForV2(workspace, marker) {
  const projected = {
    ...workspace,
    preferences: {
      ...(workspace?.preferences &&
      typeof workspace.preferences === "object" &&
      !Array.isArray(workspace.preferences)
        ? workspace.preferences
        : {}),
      [LEGACY_WORKSPACE_PROJECTION_KEY]: marker,
    },
  };
  for (const collection of V2_AUTHORITATIVE_LEGACY_COLLECTIONS)
    projected[collection] = [];
  return projected;
}

/**
 * Split the journal into what the envelope keeps and what has to be archived.
 *
 * Pure: it decides, it does not write. The decision has to be made before the
 * size guards run so they judge the envelope that will actually be stored, and
 * the writing has to happen after they pass so a refused save never changes
 * the history on its way to being refused.
 *
 * A single entry too large to be an operation record is a malformed payload
 * rather than history, and is refused outright.
 */
function planOperationJournalBound(workspace) {
  const journal = workspace?.operationJournal;
  if (journal === undefined) return { workspace, overflow: [] };
  if (!Array.isArray(journal))
    throw workspaceProjectionRejection(
      "WORKSPACE_V1_JOURNAL_INVALID",
      422,
      "Workspace operation journal must be a list.",
    );

  const sizes = journal.map(entry => {
    const size = Buffer.byteLength(JSON.stringify(entry ?? null), "utf8");
    if (size > LEGACY_WORKSPACE_JOURNAL_MAX_RECORD_BYTES)
      throw workspaceProjectionRejection(
        "WORKSPACE_V1_JOURNAL_RECORD_TOO_LARGE",
        413,
        "A Workspace operation journal entry exceeds the bounded size limit.",
      );
    return size;
  });

  // Keep the newest entries that fit both bounds; everything older overflows.
  let kept = 0;
  let bytes = 0;
  for (let index = journal.length - 1; index >= 0; index -= 1) {
    if (kept + 1 > LEGACY_WORKSPACE_JOURNAL_MAX_ENTRIES) break;
    if (bytes + sizes[index] > LEGACY_WORKSPACE_JOURNAL_MAX_BYTES) break;
    kept += 1;
    bytes += sizes[index];
  }
  if (kept === journal.length) return { workspace, overflow: [] };
  const boundary = journal.length - kept;
  return {
    workspace: { ...workspace, operationJournal: journal.slice(boundary) },
    overflow: journal.slice(0, boundary),
  };
}

export const JOURNAL_ARCHIVE_RECORD_TYPE = "formdigital.operation-journal-archive";
export const JOURNAL_ARCHIVE_SCHEMA_VERSION = 1;
const MAX_SAFE_EPOCH = 8.64e15;

export function parseSafeJournalTimestamp(value) {
  const FALLBACK_ISO = "1970-01-01T00:00:00.000Z";
  if (value === null || value === undefined) return FALLBACK_ISO;

  let date;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.abs(value) > MAX_SAFE_EPOCH) {
      return FALLBACK_ISO;
    }
    date = new Date(value);
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return FALLBACK_ISO;
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      const num = Number(trimmed);
      if (!Number.isFinite(num) || Math.abs(num) > MAX_SAFE_EPOCH) {
        return FALLBACK_ISO;
      }
      date = new Date(num);
    } else {
      date = new Date(trimmed);
    }
  } else {
    return FALLBACK_ISO;
  }

  const time = date.getTime();
  if (!Number.isFinite(time) || Math.abs(time) > MAX_SAFE_EPOCH) {
    return FALLBACK_ISO;
  }
  try {
    return date.toISOString();
  } catch {
    return FALLBACK_ISO;
  }
}

async function atomicWriteMarker(markerPath) {
  const dir = path.dirname(markerPath);
  await fs.mkdir(dir, { recursive: true });
  const tempPath = path.join(
    dir,
    `.tmp-marker-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
  );
  try {
    const handle = await fs.open(tempPath, "w");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tempPath, markerPath);
    try {
      const dirHandle = await fs.open(dir, "r");
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    } catch {}
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
}

function isStrictlyInside(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function areJournalTestHooksEnabled() {
  if (process.env.NODE_ENV !== "test") return false;
  if (process.env.FORMDIGITAL_ENABLE_TEST_HOOKS !== "1") return false;

  try {
    const realRoot = await fs.realpath(root);
    const realTmp = await fs.realpath(os.tmpdir());
    if (!isStrictlyInside(realTmp, realRoot)) return false;

    const sentinelFile = process.env.FORMDIGITAL_TEST_SENTINEL_FILE;
    const token = process.env.FORMDIGITAL_TEST_TOKEN;
    if (!sentinelFile || !token) return false;

    const stat = await fs.lstat(sentinelFile);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;

    const realSentinel = await fs.realpath(sentinelFile);
    if (!isStrictlyInside(realRoot, realSentinel)) return false;

    const content = await fs.readFile(realSentinel, "utf8");
    const tokenBuf = Buffer.from(token, "utf8");
    const contentBuf = Buffer.from(content.trim(), "utf8");
    if (tokenBuf.length !== contentBuf.length) return false;
    if (!crypto.timingSafeEqual(tokenBuf, contentBuf)) return false;

    return true;
  } catch {
    return false;
  }
}

async function removeHistoryInitMarkerSafely(initMarkerPath) {
  if (await areJournalTestHooksEnabled()) {
    if (process.env.FORMDIGITAL_TEST_FAIL_MARKER_UNLINK === "1") {
      console.error("[local-data-service] Failed to unlink init marker.");
      return false;
    }
  }
  try {
    await fs.unlink(initMarkerPath);
    return true;
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) {
      return true;
    }
    console.error("[local-data-service] Failed to unlink init marker.");
    return false;
  }
}

async function pauseAtJournalArchiveTestPoint(point) {
  if (!(await areJournalTestHooksEnabled())) {
    return;
  }
  if (process.env.FORMDIGITAL_TEST_JOURNAL_ARCHIVE_PAUSE_AT !== point) {
    return;
  }
  const marker = path.join(
    dirs.staging,
    ".formdigital-journal-archive-test-checkpoint",
  );
  await fs.mkdir(dirs.staging, { recursive: true });
  await fs.writeFile(marker, "");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await fs.access(marker);
    } catch {
      break;
    }
    await new Promise(r => setTimeout(r, 50));
  }
}

/**
 * Move the overflow into Workspace v2, which is where it survives.
 *
 * The append-only log this used to write to is not carried by the account's
 * Portable Backup, so history archived there was lost on the next machine
 * move — the exact loss the archiving was meant to prevent. The v2 database is
 * carried, so the entries travel with the account.
 *
 * Each record's id is derived from its own index, content, and the base revision,
 * so multiple occurrences within a save and across saves remain distinct, while a
 * retried save rewrites the exact same rows instead of adding copies. The transaction
 * id is derived deterministically from the batch contents, and replay validates
 * idempotency against prior applied transactions without TRANSACTION_ID_REUSE.
 */
async function archiveOperationJournalOverflow(owner, overflow, options = {}) {
  if (!overflow.length) return;
  if (!(await workspaceV2DatabaseExists(owner))) {
    const paths = ownerWorkspaceV2Paths(root, owner.ownerKey);
    await fs.mkdir(paths.ownerDirectory, { recursive: true });
    await atomicWriteMarker(path.join(paths.ownerDirectory, ".history-init-required"));
    pendingV2HistoryOwners.add(owner.ownerKeyHash);
    legacyWorkspaceCompactionChecks.delete(owner.ownerKeyHash);
    throw workspaceProjectionRejection(
      "WORKSPACE_V1_JOURNAL_ARCHIVE_UNAVAILABLE",
      409,
      "Workspace history storage is unavailable; open the Workspace once before retrying.",
    );
  }

  const expectedRevision = Number.isSafeInteger(options?.expectedRevision)
    ? options.expectedRevision
    : 0;
  // Stable archivedAt: derived purely from the entry itself (or fixed fallback),
  // completely immune to changes in caller/workspace updatedAt across retries!
  const records = overflow.map((entry, index) => {
    const digest = sha256(Buffer.from(canonicalJson(entry ?? null), "utf8"));
    const entryTimestamp = parseSafeJournalTimestamp(entry?.at ?? entry?.createdAt);
    return {
      collection: "operationJournal",
      record: {
        recordType: JOURNAL_ARCHIVE_RECORD_TYPE,
        schemaVersion: JOURNAL_ARCHIVE_SCHEMA_VERSION,
        id: `journal-archive-r${expectedRevision}-i${index}-${digest.slice(0, 24)}`,
        archivedAt: entryTimestamp,
        archivedEntry: entry,
      },
    };
  });

  const batches = planJournalArchiveBatches(records, { expectedRevision });

  const storage = await ensureWorkspaceStorageV2(owner);
  try {
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      const batch = batches[batchIndex];
      const put = batch.puts;
      const transactionId = batch.transactionId;

      const prior = storage.getAppliedTransaction(transactionId);
      const transactionInput = {
        expectedRevision: prior ? prior.baseRevision : storage.describe().revision,
        transactionId,
        put,
      };

      const txBytes = calculateCanonicalTransactionBytes(transactionInput);
      if (txBytes > JOURNAL_ARCHIVE_MAX_BATCH_BYTES) {
        throw workspaceProjectionRejection(
          "WORKSPACE_V1_JOURNAL_ARCHIVE_INVARIANT_VIOLATION",
          500,
          "Journal archive batch exceeded canonical transaction size limit.",
        );
      }

      storage.transaction(transactionInput);

      if (batchIndex === 0 && batches.length > 1) {
        await pauseAtJournalArchiveTestPoint("after_batch_0");
      }
    }
  } finally {
    storage.close();
  }
}

async function workspaceV2DatabaseExists(owner) {
  const paths = ownerWorkspaceV2Paths(root, owner.ownerKey);
  return fs.stat(paths.databasePath).then(
    stat => stat.isFile(),
    error => (isErrnoCode(error, "ENOENT") ? false : Promise.reject(error)),
  );
}

function v2AuthoritativeCollectionsEqual(left, right) {
  return V2_AUTHORITATIVE_LEGACY_COLLECTIONS.every(collection =>
    JSON.stringify(Array.isArray(left?.[collection]) ? left[collection] : []) ===
    JSON.stringify(Array.isArray(right?.[collection]) ? right[collection] : []),
  );
}

async function requireUsableProjectedWorkspaceV2(owner) {
  const paths = ownerWorkspaceV2Paths(root, owner.ownerKey);
  const exists = await workspaceV2DatabaseExists(owner);
  if (!exists)
    throw workspaceProjectionRejection(
      "WORKSPACE_V2_RESTORE_REQUIRED",
      409,
      "Workspace v2 data is unavailable. Restore a complete streaming Backup before continuing.",
    );
  try {
    const inspected = inspectWorkspaceStorageV2File({
      databasePath: paths.databasePath,
      ownerHash: owner.ownerKeyHash,
    });
    if (inspected.schemaVersion !== 2)
      throw new WorkspaceStorageError("UNSUPPORTED_WORKSPACE_SCHEMA");
    return inspected;
  } catch {
    throw workspaceProjectionRejection(
      "WORKSPACE_V2_RESTORE_REQUIRED",
      409,
      "Workspace v2 data is unavailable. Restore a complete streaming Backup before continuing.",
    );
  }
}

async function requireProjectedLegacySource(owner, marker) {
  const paths = ownerWorkspaceV2Paths(root, owner.ownerKey);
  try {
    const stat = await fs.stat(paths.legacyCopyPath);
    if (
      !stat.isFile() ||
      stat.size < 1 ||
      stat.size > LEGACY_WORKSPACE_MIGRATION_MAX_BYTES
    )
      throw new Error("invalid retained source");
    const bytes = await fs.readFile(paths.legacyCopyPath);
    if (bytes.byteLength !== stat.size || sha256(bytes) !== marker.sourceHash)
      throw new Error("retained source changed");
    const envelope = JSON.parse(bytes.toString("utf8"));
    if (
      !envelope ||
      typeof envelope !== "object" ||
      Array.isArray(envelope) ||
      envelope.revision !== marker.sourceRevision ||
      !envelope.workspace ||
      typeof envelope.workspace !== "object" ||
      Array.isArray(envelope.workspace) ||
      (typeof envelope.workspace.ownerKey === "string" &&
        ownerKeyHash(envelope.workspace.ownerKey) !== owner.ownerKeyHash)
    )
      throw new Error("invalid retained source");
    return Object.freeze({
      size: bytes.byteLength,
      contentHash: marker.sourceHash,
    });
  } catch {
    throw workspaceProjectionRejection(
      "WORKSPACE_V2_RESTORE_REQUIRED",
      409,
      "Workspace v2 data is unavailable. Restore a complete streaming Backup before continuing.",
    );
  }
}

async function requireUndivergedLegacyProjectionSource(owner, currentWorkspace) {
  const paths = ownerWorkspaceV2Paths(root, owner.ownerKey);
  let retainedBytes;
  try {
    const retainedStat = await fs.stat(paths.legacyCopyPath);
    if (
      !retainedStat.isFile() ||
      retainedStat.size > LEGACY_WORKSPACE_MIGRATION_MAX_BYTES
    )
      throw new Error("invalid retained source");
    retainedBytes = await fs.readFile(paths.legacyCopyPath);
    if (retainedBytes.byteLength !== retainedStat.size)
      throw new Error("retained source changed");
  } catch {
    throw workspaceProjectionRejection(
      "WORKSPACE_V1_V2_DIVERGED",
      409,
      "Workspace storage generations do not match. Restore a complete streaming Backup before continuing.",
    );
  }
  let retained;
  try {
    retained = JSON.parse(retainedBytes.toString("utf8"));
  } catch {
    retained = null;
  }
  if (
    !retained ||
    typeof retained !== "object" ||
    !retained.workspace ||
    typeof retained.workspace !== "object" ||
    Array.isArray(retained.workspace) ||
    !v2AuthoritativeCollectionsEqual(currentWorkspace, retained.workspace)
  )
    throw workspaceProjectionRejection(
      "WORKSPACE_V1_V2_DIVERGED",
      409,
      "Workspace storage generations do not match. Restore a complete streaming Backup before continuing.",
    );
}

function workspaceProjectionRejection(code, statusCode, safeMessage) {
  const error = new Error(code);
  error.statusCode = statusCode;
  error.publicCode = code.toLowerCase();
  error.safeMessage = safeMessage;
  return error;
}

/**
 * Whether an unpublished v2 database can still be used to finish the cutover.
 *
 * Reached only after the caller has established that the v1 envelope carries
 * no projection marker, so v1 is the authority and the database is an attempt
 * that never completed. Unreadable, truncated and merely-diverged all mean the
 * same thing here — the attempt cannot be trusted — and all three are
 * recoverable by setting it aside and rebuilding from v1. Letting the checks
 * throw instead left the account at a permanent 409 asking for a Backup
 * restore that could not be reached, because the Workspace would not open.
 */
async function workspaceV2UsableForLegacyCutover(owner, workspace) {
  try {
    await requireUsableProjectedWorkspaceV2(owner);
    await requireUndivergedLegacyProjectionSource(owner, workspace);
  } catch {
    return false;
  }
  return workspaceV2MatchesLegacy(owner, workspace);
}

/** Whether the published v2 database still agrees with the v1 envelope. */
async function workspaceV2MatchesLegacy(owner, workspace) {
  const paths = ownerWorkspaceV2Paths(root, owner.ownerKey);
  let storage;
  try {
    storage = WorkspaceStorageV2.openFileReadOnly({
      databasePath: paths.databasePath,
      ownerHash: owner.ownerKeyHash,
    });
  } catch {
    return false;
  }
  try {
    return await v2AuthoritativeCollectionsMatchStorage(workspace, storage);
  } catch {
    return false;
  } finally {
    storage.close();
  }
}

/**
 * Set aside a v2 database that no longer matches the v1 envelope.
 *
 * Until the projection marker is written into v1, v1 is still the authority
 * and any v2 database is an unpublished migration attempt. One that has
 * stopped matching — a crash between publishing the database and compacting
 * the envelope, or a Backup restore that replaced v1 underneath it — otherwise
 * makes every Workspace read fail permanently, with no way for the person to
 * recover and nothing said about why. The files are moved into quarantine
 * rather than deleted, and the database is rebuilt from the v1 envelope, which
 * still holds every record.
 */
async function quarantineStaleWorkspaceV2(owner) {
  const paths = ownerWorkspaceV2Paths(root, owner.ownerKey);
  const quarantineId = `workspace-v2-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
  await fs.mkdir(dirs.quarantine, { recursive: true });
  await fs.rename(paths.ownerDirectory, path.join(dirs.quarantine, quarantineId));
  workspaceV2Initializations.delete(owner.ownerKeyHash);
  legacyWorkspaceCompactionChecks.delete(owner.ownerKeyHash);
  await appendJournal("workspace.v2.diverged-quarantined", {
    ownerKeyHash: owner.ownerKeyHash,
    quarantineId,
  });
  console.error(
    `[local-data-service] workspace v2 database diverged from the authoritative v1 envelope; moved to quarantine/${quarantineId} and rebuilt from v1.`,
  );
}

async function prepareLegacyWorkspaceForV2(owner) {
  const ownerHash = owner.ownerKeyHash;
  if (legacyWorkspaceCompactionChecks.has(ownerHash)) return;
  const account = accountPaths(ownerHash);
  let sourceStat;
  try {
    sourceStat = await fs.stat(account.workspace);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      legacyWorkspaceCompactionChecks.add(ownerHash);
      return;
    }
    throw error;
  }
  if (!sourceStat.isFile())
    throw workspaceProjectionRejection(
      "WORKSPACE_V1_PROJECTION_FAILED",
      500,
      "Workspace compatibility data could not be prepared safely.",
    );
  if (sourceStat.size > LEGACY_WORKSPACE_MIGRATION_MAX_BYTES)
    throw workspaceProjectionRejection(
      "WORKSPACE_V1_PROJECTION_TOO_LARGE",
      413,
      "Workspace compatibility data is too large for the bounded migration path.",
    );

  // A committed marker is part of the compact v1 envelope itself, so it is
  // restored together with the SQLite file by schema-v2 backups.  Validate the
  // invariant on every process lifetime before permitting ordinary v1 writes.
  const currentBytes = await fs.readFile(account.workspace);
  if (currentBytes.byteLength !== sourceStat.size)
    throw workspaceProjectionRejection(
      "WORKSPACE_V1_PROJECTION_FAILED",
      500,
      "Workspace compatibility data could not be prepared safely.",
    );
  let current;
  try {
    current = JSON.parse(currentBytes.toString("utf8"));
  } catch {
    throw workspaceProjectionRejection(
      "WORKSPACE_V1_PROJECTION_FAILED",
      500,
      "Workspace compatibility data could not be prepared safely.",
    );
  }
  if (
    !current ||
    typeof current !== "object" ||
    !Number.isSafeInteger(current.revision) ||
    current.revision < 0 ||
    !current.workspace ||
    typeof current.workspace !== "object" ||
    Array.isArray(current.workspace)
  )
    throw workspaceProjectionRejection(
      "WORKSPACE_V1_PROJECTION_FAILED",
      500,
      "Workspace compatibility data could not be prepared safely.",
    );
  const existingMarker = workspaceProjectionMarker(current.workspace);
  if (existingMarker) {
    if (hasNonEmptyV2AuthoritativeLegacyCollections(current.workspace))
      throw workspaceProjectionRejection(
        "WORKSPACE_V1_PROJECTION_FAILED",
        500,
        "Workspace compatibility data could not be prepared safely.",
      );
    await requireUsableProjectedWorkspaceV2(owner);
    await requireProjectedLegacySource(owner, existingMarker);
    const v2Paths = ownerWorkspaceV2Paths(root, owner.ownerKey);
    await removeHistoryInitMarkerSafely(path.join(v2Paths.ownerDirectory, ".history-init-required"));
    legacyWorkspaceCompactionChecks.add(ownerHash);
    return;
  }
  const v2Paths = ownerWorkspaceV2Paths(root, owner.ownerKey);
  const initMarkerPath = path.join(v2Paths.ownerDirectory, ".history-init-required");
  const initMarkerExists = await fs.stat(initMarkerPath).then(
    stat => stat.isFile(),
    error => (isErrnoCode(error, "ENOENT") ? false : Promise.reject(error)),
  );
  const hasLegacyJournalOverflow =
    Array.isArray(current?.workspace?.operationJournal) &&
    current.workspace.operationJournal.length > LEGACY_WORKSPACE_JOURNAL_MAX_ENTRIES;
  const needsHistoryInit =
    pendingV2HistoryOwners.has(ownerHash) ||
    initMarkerExists ||
    hasLegacyJournalOverflow;
  const hasLegacyCopy = await fs.stat(v2Paths.legacyCopyPath).then(
    stat => stat.isFile(),
    error => (isErrnoCode(error, "ENOENT") ? false : Promise.reject(error)),
  );
  const databaseExistedBefore = await workspaceV2DatabaseExists(owner);
  if (sourceStat.size < LEGACY_WORKSPACE_COMPACTION_TRIGGER_BYTES && !hasLegacyCopy) {
    if (needsHistoryInit) {
      // 1. Verify existing v2 database if present
      let v2Usable = false;
      if (databaseExistedBefore) {
        try {
          const inspected = inspectWorkspaceStorageV2File({
            databasePath: v2Paths.databasePath,
            ownerHash: owner.ownerKeyHash,
          });
          if (inspected.schemaVersion === 2) {
            const checkStorage = WorkspaceStorageV2.openByOwnerHash({
              rootDir: root,
              ownerHash: owner.ownerKeyHash,
              readOnly: true,
            });
            try {
              checkStorage.integrityCheck();
              v2Usable = true;
            } finally {
              checkStorage.close();
            }
          }
        } catch {
          v2Usable = false;
        }
      }

      if (v2Usable) {
        // v2 database is already healthy and complete!
        await removeHistoryInitMarkerSafely(initMarkerPath);
        pendingV2HistoryOwners.delete(ownerHash);
      } else {
        // v2 does not exist, or is damaged/corrupt/truncated.
        // v1 has no projection marker, so v1 is the authority.
        if (databaseExistedBefore) {
          // Quarantine corrupt/truncated v2
          await quarantineStaleWorkspaceV2(owner);
        }
        // Ensure marker exists on disk during initialization so failure leaves marker intact
        await atomicWriteMarker(initMarkerPath);

        try {
          if (
            (await areJournalTestHooksEnabled()) &&
            process.env.FORMDIGITAL_TEST_FAIL_WORKSPACE_V2_INIT === "1"
          ) {
            throw new Error("TEST_INJECTED_V2_INIT_FAILURE");
          }

          const storage = await ensureWorkspaceStorageV2(owner);
          try {
            storage.integrityCheck();
            const desc = storage.describe();
            if (desc.schemaVersion !== 2) {
              throw new WorkspaceStorageError("UNSUPPORTED_WORKSPACE_SCHEMA");
            }
          } finally {
            storage.close();
          }

          // ONLY after successful creation and verification, unlink marker
          await removeHistoryInitMarkerSafely(initMarkerPath);
          pendingV2HistoryOwners.delete(ownerHash);
        } catch (initError) {
          // Failure leaves marker intact! Does not touch v1 workspace!
          throw workspaceProjectionRejection(
            "WORKSPACE_V2_INIT_FAILED",
            503,
            "Workspace storage initialization failed; retry opening the Workspace.",
          );
        }
      }
    } else if (initMarkerExists) {
      await removeHistoryInitMarkerSafely(initMarkerPath);
    }
    legacyWorkspaceCompactionChecks.add(ownerHash);
    return;
  }
  // Migration verifies canonical record parity and SQLite integrity before it
  // publishes the database.  Re-open and check it here because compaction is
  // irreversible for the active v1 view (the exact source remains retained).
  let hasPublishedDatabase = databaseExistedBefore;
  // A Workspace carrying a projection marker returned above, fail-closed, so
  // everything from here has v1 as its authority. That makes a published-but-
  // unusable database recoverable rather than fatal: set it aside and rebuild
  // from the v1 envelope, which still holds every record.
  if (
    hasPublishedDatabase &&
    !(await workspaceV2UsableForLegacyCutover(owner, current.workspace))
  ) {
    await quarantineStaleWorkspaceV2(owner);
    hasPublishedDatabase = false;
  }
  const storage = await ensureWorkspaceStorageV2(owner);
  try {
    storage.integrityCheck();
    const description = storage.describe();
    if (description.schemaVersion !== 2)
      throw new WorkspaceStorageError("UNSUPPORTED_WORKSPACE_SCHEMA");
    const relationFindings = [];
    const manifestById = new Map(
      (await ownerManifests(ownerHash)).map(({ manifest }) => [manifest.id, manifest]),
    );
    await addWorkspaceV2RelationFindings(
      storage,
      current.workspace,
      "workspace-v2-cutover",
      manifestById,
      relationFindings,
    );
    if (relationFindings.some(finding => finding.severity === "error"))
      throw new WorkspaceStorageError("MIGRATION_VERIFICATION_FAILED");
  } finally {
    storage.close();
  }

  const sourceHash = sha256(currentBytes);
  if (!hasPublishedDatabase) {
    const retainedSource = await hashPortableFile(
      v2Paths.legacyCopyPath,
      LEGACY_WORKSPACE_MIGRATION_MAX_BYTES,
    );
    if (
      retainedSource.size !== currentBytes.byteLength ||
      retainedSource.contentHash !== sourceHash
    )
      throw new WorkspaceStorageError("MIGRATION_VERIFICATION_FAILED");
  }
  const previewMarker = {
    schemaVersion: 1,
    layout: "v2-authoritative-high-growth",
    collections: [...V2_AUTHORITATIVE_LEGACY_COLLECTIONS],
    sourceRevision: current.revision,
    sourceHash,
    safetyBackupId: "pending",
    compactedAt: now(),
  };
  const previewEnvelope = {
    revision: current.revision + 1,
    workspace: projectLegacyWorkspaceForV2(current.workspace, previewMarker),
  };
  if (
    Buffer.byteLength(JSON.stringify(previewEnvelope, null, 2), "utf8") >
    LEGACY_WORKSPACE_COMPACT_MAX_BYTES
  )
    throw workspaceProjectionRejection(
      "WORKSPACE_V1_METADATA_TOO_LARGE",
      413,
      "Workspace metadata remains too large after safe high-growth migration.",
    );

  // This backup contains the byte-exact pre-compaction v1 envelope plus the
  // verified v2 database.  If power is lost before the atomic rewrite, the old
  // envelope stays live; if it is lost afterwards, the new envelope contains
  // the durable marker and this backup id.
  const safetyBackup = await createStreamingPortableBackup(
    owner,
    "pre-workspace-v2-compaction",
  );
  const marker = {
    ...previewMarker,
    safetyBackupId: safetyBackup.id,
  };
  const compactEnvelope = {
    revision: current.revision + 1,
    workspace: projectLegacyWorkspaceForV2(current.workspace, marker),
  };
  const compactBytes = Buffer.from(JSON.stringify(compactEnvelope, null, 2));
  if (compactBytes.byteLength > LEGACY_WORKSPACE_COMPACT_MAX_BYTES)
    throw workspaceProjectionRejection(
      "WORKSPACE_V1_METADATA_TOO_LARGE",
      413,
      "Workspace metadata remains too large after safe high-growth migration.",
    );
  await atomicWrite(account.workspace, compactBytes);
  await appendJournal("workspace.v1.compact-after-v2", {
    ownerKeyHash: ownerHash,
    sourceRevision: current.revision,
    revision: compactEnvelope.revision,
    sourceHash,
    safetyBackupId: safetyBackup.id,
    collections: [...V2_AUTHORITATIVE_LEGACY_COLLECTIONS],
  });
  if (initMarkerExists) {
    await removeHistoryInitMarkerSafely(initMarkerPath);
  }
  pendingV2HistoryOwners.delete(ownerHash);
  legacyWorkspaceCompactionChecks.add(ownerHash);
}

async function saveWorkspace(owner, expectedRevision, workspace) {
  const ownerHash = owner.ownerKeyHash;
  const current = await loadWorkspace(ownerHash);
  if (current.revision !== expectedRevision) {
    const conflict = new Error(
      `Workspace revision conflict: expected ${expectedRevision}, current ${current.revision}.`
    );
    conflict.code = "WORKSPACE_REVISION_CONFLICT";
    throw conflict;
  }
  if (!workspace || typeof workspace !== "object" || Array.isArray(workspace))
    throw new Error("Workspace payload must be an object.");
  const currentProjection = workspaceProjectionMarker(current.workspace);
  if (
    !currentProjection &&
    workspace?.preferences &&
    typeof workspace.preferences === "object" &&
    !Array.isArray(workspace.preferences) &&
    Object.prototype.hasOwnProperty.call(
      workspace.preferences,
      LEGACY_WORKSPACE_PROJECTION_KEY,
    )
  )
    throw workspaceProjectionRejection(
      "WORKSPACE_V1_RESERVED_METADATA_REJECTED",
      409,
      "Reserved Workspace storage metadata cannot be supplied by a caller.",
    );
  if (
    currentProjection &&
    hasNonEmptyV2AuthoritativeLegacyCollections(workspace)
  )
    throw workspaceProjectionRejection(
      "WORKSPACE_V2_COLLECTION_REJECTED",
      409,
      "High-growth Workspace records must be saved through bounded Workspace v2 operations.",
    );
  const projected = currentProjection
    ? projectLegacyWorkspaceForV2(workspace, currentProjection)
    : workspace;
  // Decided now, written later: the size guards below have to judge the
  // envelope that will actually be stored, and nothing may be archived until
  // they have all passed.
  const journalPlan = planOperationJournalBound(projected);
  const workspaceToSave = journalPlan.workspace;
  const account = accountPaths(ownerHash);
  const envelope = {
    revision: current.revision + 1,
    workspace: { ...workspaceToSave, updatedAt: now() },
  };
  const serialized = Buffer.from(JSON.stringify(envelope, null, 2));
  // Never publish a v1 envelope that cannot stay inside the bounded
  // compatibility path.  For an already-projected Workspace this is the
  // actual compact envelope.  Before the first cutover, estimate the exact
  // post-cutover metadata shape by removing only the collections that v2 is
  // authoritative for.  This permits a large high-growth write to trigger the
  // next-request migration, while rejecting metadata-only growth before it
  // can leave the account in the former 50 MiB dead-end.
  let projectedMetadataBytes = serialized.byteLength;
  if (!currentProjection && serialized.byteLength >= LEGACY_WORKSPACE_COMPACTION_TRIGGER_BYTES) {
    const preflightMarker = {
      schemaVersion: 1,
      layout: "v2-authoritative-high-growth",
      collections: [...V2_AUTHORITATIVE_LEGACY_COLLECTIONS],
      sourceRevision: envelope.revision,
      sourceHash: "0".repeat(64),
      safetyBackupId: "backup-metadata-preflight",
      compactedAt: now(),
    };
    projectedMetadataBytes = Buffer.byteLength(
      JSON.stringify({
        revision: envelope.revision + 1,
        workspace: projectLegacyWorkspaceForV2(envelope.workspace, preflightMarker),
      }, null, 2),
      "utf8",
    );
  }
  if (projectedMetadataBytes > LEGACY_WORKSPACE_COMPACT_MAX_BYTES)
    throw workspaceProjectionRejection(
      "WORKSPACE_V1_METADATA_TOO_LARGE",
      413,
      "Workspace metadata exceeds the bounded compatibility limit. Remove unused Template metadata before retrying.",
    );
  // Judge the size on the bytes that will actually reach the disk, never on
  // the size of the request. A request arrives as compact JSON under a 50 MiB
  // ceiling and is stored pretty-printed, which is far larger, so a payload
  // comfortably inside the request limit could be published past the 64 MiB
  // ceiling that migration and the retained copy both enforce. That file saved
  // once and could then never be read or migrated again: the Workspace was
  // gone with nothing to explain it. Refusing here, before atomicWrite and
  // before any other file is touched, leaves the stored Workspace, the v2
  // database, the journal, the backups and the assets exactly as they were.
  if (serialized.byteLength > LEGACY_WORKSPACE_MIGRATION_MAX_BYTES)
    throw workspaceProjectionRejection(
      "WORKSPACE_V1_ENVELOPE_TOO_LARGE",
      413,
      "Workspace exceeds the bounded local storage limit. Remove unused records before retrying.",
    );
  // Every guard has passed, so the save is going to happen. The overflow is
  // archived first: if this throws, nothing has been published and nothing has
  // been dropped, and if the write below fails, a retry rewrites the same rows
  // rather than adding copies.
  await archiveOperationJournalOverflow(owner, journalPlan.overflow, {
    expectedRevision,
    workspace: current.workspace,
    incomingWorkspace: workspace,
  });
  await atomicWrite(
    account.workspace,
    serialized,
  );
  if (serialized.byteLength >= LEGACY_WORKSPACE_COMPACTION_TRIGGER_BYTES)
    legacyWorkspaceCompactionChecks.delete(ownerHash);
  await appendJournal("workspace.commit", {
    ownerKeyHash: ownerHash,
    revision: envelope.revision,
  });
  return envelope;
}

async function hostAccount() {
  const target = path.join(dirs.metadata, "host-account.json");
  try {
    return JSON.parse(await fs.readFile(target, "utf8"));
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return { googleUserId: null };
    throw error;
  }
}

async function updateHostAccount(input) {
  const googleUserId = String(input.googleUserId || "").trim();
  if (!googleUserId || googleUserId.length > 255)
    throw new Error("A valid Google User ID is required.");
  const record = {
    googleUserId,
    email: input.email ? String(input.email).slice(0, 320) : null,
    updatedAt: now(),
  };
  await atomicWrite(
    path.join(dirs.metadata, "host-account.json"),
    Buffer.from(JSON.stringify(record, null, 2))
  );
  await appendJournal("host-account.activate", {
    googleUserIdHash: sha256(Buffer.from(googleUserId)),
  });
  return record;
}

async function verifyFolderCandidate(candidateDirs) {
  const scan = await integrityScanAt(candidateDirs);
  return scan.findings
    .filter(finding => finding.severity === "error")
    .map(finding => String(finding.code || "integrity_error"));
}

async function reconnectDataFolder(input) {
  const requested = String(input.dataFolder || "").trim();
  if (!requested || !path.isAbsolute(requested))
    throw new Error("Data Folder must be an absolute path.");
  const target = path.resolve(requested);
  if (target === path.parse(target).root)
    throw new Error(
      "A drive root cannot be used as the Formdigital Data Folder."
    );
  const candidateDirs = directoriesFor(target);
  await Promise.all(
    [
      candidateDirs.objects,
      candidateDirs.manifests,
      candidateDirs.accounts,
    ].map(directory => fs.access(directory))
  ).catch(() => {
    throw new Error(
      "Selected folder is not an existing Formdigital Data Folder (objects, manifests and accounts are required)."
    );
  });
  const findings = await verifyFolderCandidate(candidateDirs);
  if (findings.length)
    throw new Error(
      `Selected Data Folder failed verification: ${findings.slice(0, 3).join("; ")}`
    );
  const nextConfig = { ...config, dataFolder: target };
  await atomicReplaceExternalFile(
    configPath,
    Buffer.from(JSON.stringify(nextConfig, null, 2)),
  );
  Object.assign(config, nextConfig);
  root = target;
  dirs = candidateDirs;
  legacyWorkspaceCompactionChecks.clear();
  pendingV2HistoryOwners.clear();
  for (const value of Object.values(dirs))
    await fs.mkdir(value, { recursive: true });
  rootAvailable = true;
  await recoverAtomicTransactions();
  await recoverLegacyRestoreTransactions();
  await recoverPortableRestoreTransactions();
  await cleanupExpiredPortableSessions();
  await recoverPendingJournals();
  await ensureDataFolderSchema();
  await appendJournal("data-folder.reconnect", { to: target, verified: true });
  return { reconnected: true, dataFolder: root };
}

async function moveDataFolder(input) {
  const requested = String(input.dataFolder || "").trim();
  if (!requested || !path.isAbsolute(requested))
    throw new Error("Data Folder must be an absolute path.");
  const target = path.resolve(requested);
  const parsed = path.parse(target);
  if (target === parsed.root)
    throw new Error(
      "A drive root cannot be used as the Formdigital Data Folder."
    );
  const relativeToCurrent = path.relative(root, target);
  if (
    !relativeToCurrent ||
    (!relativeToCurrent.startsWith("..") && !path.isAbsolute(relativeToCurrent))
  )
    throw new Error(
      "Choose a different folder that is not inside the current Data Folder."
    );
  let targetExists = false;
  try {
    const children = await fs.readdir(target);
    targetExists = true;
    if (children.length)
      throw new Error("The selected destination must be empty.");
  } catch (error) {
    if (
      !(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
    )
      throw error;
  }
  const parent = path.dirname(target);
  await fs.mkdir(parent, { recursive: true });
  const candidate = path.join(
    parent,
    `.formdigital-move-${crypto.randomUUID()}`
  );
  try {
    await fs.cp(root, candidate, { recursive: true, errorOnExist: true });
    const candidateDirs = directoriesFor(candidate);
    const findings = await verifyFolderCandidate(candidateDirs);
    if (findings.length)
      throw new Error(
        `Copied Data Folder failed verification: ${findings.slice(0, 3).join("; ")}`
      );
    if (targetExists) await fs.rmdir(target);
    await fs.rename(candidate, target);
    const nextConfig = { ...config, dataFolder: target };
    await atomicReplaceExternalFile(
      configPath,
      Buffer.from(JSON.stringify(nextConfig, null, 2)),
    );
    Object.assign(config, nextConfig);
    root = target;
    dirs = directoriesFor(root);
    legacyWorkspaceCompactionChecks.clear();
    await appendJournal("data-folder.move", {
      from: input.previousLabel || "previous-data-folder",
      to: target,
      verified: true,
    });
    return { moved: true, dataFolder: root, previousFolderPreserved: true };
  } catch (error) {
    await fs.rm(candidate, { recursive: true, force: true });
    throw error;
  }
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 50 * 1024 * 1024)
      throw workspaceProjectionRejection(
        "REQUEST_TOO_LARGE",
        413,
        "Local data request exceeds the bounded safety limit.",
      );
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw workspaceProjectionRejection(
      "INVALID_JSON",
      400,
      "Local data request is not valid JSON.",
    );
  }
}

async function readJsonBounded(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("REQUEST_TOO_LARGE");
      error.code = "REQUEST_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("INVALID_JSON");
    error.code = "INVALID_JSON";
    throw error;
  }
}

const PORTABLE_LEGACY_BINARY_MAX_BYTES = 32 * 1024 * 1024;

// Schema-v1 Portable Backups travel through a Base64 JSON response and the
// matching restore endpoint deliberately refuses more than 32 MiB of decoded
// archive bytes.  Creation must enforce the same boundary before publication;
// otherwise the service could hand the caller an archive it cannot restore.
// The override is intentionally available only to isolated regression
// processes so the boundary can be exercised without allocating tens of MiB.
const PORTABLE_LEGACY_CREATE_MAX_BYTES = (() => {
  if (process.env.FORMDIGITAL_ENABLE_TEST_HOOKS !== "1")
    return PORTABLE_LEGACY_BINARY_MAX_BYTES;
  const parsed = Number.parseInt(
    process.env.FORMDIGITAL_TEST_PORTABLE_LEGACY_CREATE_MAX_BYTES || "",
    10,
  );
  return Number.isSafeInteger(parsed) &&
    parsed >= 256 &&
    parsed <= PORTABLE_LEGACY_BINARY_MAX_BYTES
    ? parsed
    : PORTABLE_LEGACY_BINARY_MAX_BYTES;
})();

function legacyPortableBackupCreationTooLarge() {
  const error = new Error("PORTABLE_BACKUP_REQUIRES_STREAMING");
  error.statusCode = 413;
  error.publicCode = "portable_backup_requires_streaming";
  error.safeMessage =
    "This backup is too large for the legacy transport. Create a complete account backup to use bounded streaming.";
  return error;
}

function decodeLegacyPortableBase64(value) {
  if (
    typeof value !== "string" ||
    value.length < 4 ||
    value.length > Math.ceil(PORTABLE_LEGACY_BINARY_MAX_BYTES / 3) * 4 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    const error = new Error("PORTABLE_BACKUP_REQUIRES_STREAMING");
    error.statusCode = 413;
    error.publicCode = "portable_backup_requires_streaming";
    error.safeMessage =
      "This Portable Backup must be restored through the bounded streaming upload.";
    throw error;
  }
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > PORTABLE_LEGACY_BINARY_MAX_BYTES ||
    bytes.toString("base64") !== value
  ) {
    const error = new Error("PORTABLE_BACKUP_REQUIRES_STREAMING");
    error.statusCode = 413;
    error.publicCode = "portable_backup_requires_streaming";
    error.safeMessage =
      "This Portable Backup must be restored through the bounded streaming upload.";
    throw error;
  }
  return bytes;
}

const workspaceV2Initializations = new Map();

async function ensureWorkspaceStorageV2(owner) {
  let pending = workspaceV2Initializations.get(owner.ownerKeyHash);
  if (!pending) {
    pending = (async () => {
      const paths = ownerWorkspaceV2Paths(root, owner.ownerKey);
      const databaseExists = await fs.stat(paths.databasePath).then(
        stat => stat.isFile(),
        error => isErrnoCode(error, "ENOENT") ? false : Promise.reject(error),
      );
      if (!databaseExists) {
        const legacyPath = accountPaths(owner.ownerKeyHash).workspace;
        const legacyExists = await fs.stat(legacyPath).then(
          stat => stat.isFile(),
          error => isErrnoCode(error, "ENOENT") ? false : Promise.reject(error),
        );
        if (legacyExists) {
          let legacyEnvelope = null;
          try {
            const legacyStat = await fs.stat(legacyPath);
            if (
              legacyStat.isFile() &&
              legacyStat.size <= LEGACY_WORKSPACE_MIGRATION_MAX_BYTES
            )
              legacyEnvelope = JSON.parse(await fs.readFile(legacyPath, "utf8"));
          } catch {
            legacyEnvelope = null;
          }
          if (workspaceProjectionMarker(legacyEnvelope?.workspace))
            throw new WorkspaceStorageError("WORKSPACE_V2_RESTORE_REQUIRED");
          await migrateLegacyWorkspaceV2({
            rootDir: root,
            ownerKey: owner.ownerKey,
            legacyPath,
          });
          // A prior small-v1 GET may have cached "no compaction needed".
          // Creating v2 changes the authority boundary, so the next operation
          // must publish the durable projection marker before any v1 write.
          legacyWorkspaceCompactionChecks.delete(owner.ownerKeyHash);
        } else throw new WorkspaceStorageError("STORAGE_NOT_FOUND");
      }
      const storage = WorkspaceStorageV2.open({ rootDir: root, ownerKey: owner.ownerKey });
      try {
        const meta = storage.readMeta();
        if (meta.ownerKey !== undefined && meta.ownerKey !== owner.ownerKey)
          throw new WorkspaceStorageError("OWNER_MISMATCH");
        if (meta.schemaVersion === undefined || Number(meta.schemaVersion) < 2) {
          const description = storage.describe();
          const timestamp = now();
          storage.transaction({
            expectedRevision: description.revision,
            transactionId: "workspace-v2-schema-2-bootstrap",
            metaPatch: {
              schemaVersion: 2,
              ownerKey: owner.ownerKey,
              createdAt: meta.createdAt ?? timestamp,
              updatedAt: timestamp,
              preferences: meta.preferences ?? {},
            },
          });
        }
      } finally {
        storage.close();
      }
    })();
    workspaceV2Initializations.set(owner.ownerKeyHash, pending);
    void pending.finally(() => {
      if (workspaceV2Initializations.get(owner.ownerKeyHash) === pending)
        workspaceV2Initializations.delete(owner.ownerKeyHash);
    }).catch(() => {});
  }
  await pending;
  return WorkspaceStorageV2.open({ rootDir: root, ownerKey: owner.ownerKey });
}

function workspaceV2PublicError(response, error) {
  if (
    error &&
    typeof error === "object" &&
    Number.isInteger(error.statusCode) &&
    error.statusCode >= 400 &&
    error.statusCode <= 599 &&
    typeof error.publicCode === "string" &&
    /^[a-z0-9_]{1,80}$/.test(error.publicCode)
  )
    return reject(
      response,
      error.statusCode,
      error.publicCode,
      typeof error.safeMessage === "string"
        ? error.safeMessage
        : "Workspace v2 request was rejected.",
    );
  const code = error instanceof WorkspaceStorageError
    ? error.code
    : error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "STORAGE_FAILURE";
  if (code === "REVISION_CONFLICT")
    return reject(response, 409, "workspace_v2_revision_conflict", "Workspace data changed; retry with the current revision.");
  if (code === "STALE_CURSOR")
    return reject(response, 409, "workspace_v2_stale_cursor", "Workspace data changed; restart the paged query.");
  if (code === "REQUEST_TOO_LARGE")
    return reject(response, 413, "workspace_v2_request_too_large", "Workspace v2 request exceeds the bounded safety limit.");
  if (["UNSUPPORTED_STORAGE_SCHEMA", "UNSUPPORTED_WORKSPACE_SCHEMA"].includes(code))
    return reject(response, 409, "workspace_v2_schema_unsupported", "Workspace storage was created by an unsupported newer schema.");
  if (code === "WORKSPACE_V2_RESTORE_REQUIRED")
    return reject(
      response,
      409,
      "workspace_v2_restore_required",
      "Workspace v2 data is unavailable. Restore a complete streaming Backup before continuing.",
    );
  return reject(response, 422, "workspace_v2_request_rejected", "Workspace v2 request was rejected.");
}

async function handleWorkspaceV2Request(request, response) {
  const owner = requireOwner(request);
  let storage;
  try {
    const url = new URL(String(request.url), "http://127.0.0.1");
    const isReadRoute =
      (request.method === "GET" &&
        (url.pathname === "/api/v2/workspace/describe" ||
          url.pathname === "/api/v2/workspace/export")) ||
      (request.method === "POST" &&
        (url.pathname === "/api/v2/workspace/query" ||
          url.pathname === "/api/v2/workspace/query-many" ||
          url.pathname === "/api/v2/workspace/internal-journal-stream"));
    const isTransactionRoute =
      request.method === "POST" &&
      url.pathname === "/api/v2/workspace/transaction";
    if (!isReadRoute && !isTransactionRoute) return false;
    const paths = ownerWorkspaceV2Paths(root, owner.ownerKey);
    const [databaseExists, legacyExists] = await Promise.all([
      fs.stat(paths.databasePath).then(
        stat => stat.isFile(),
        error => isErrnoCode(error, "ENOENT") ? false : Promise.reject(error),
      ),
      fs.stat(accountPaths(owner.ownerKeyHash).workspace).then(
        stat => stat.isFile(),
        error => isErrnoCode(error, "ENOENT") ? false : Promise.reject(error),
      ),
    ]);
    // When v2 already exists, validate and publish the durable cutover before
    // opening it for the requested operation. A corrupt/missing projected DB
    // therefore cannot fall through to a generic open or an empty migration.
    if (databaseExists && legacyExists)
      await prepareLegacyWorkspaceForV2(owner);
    if (isReadRoute) {
      storage = !databaseExists && !legacyExists
        ? WorkspaceStorageV2.openEphemeral({
            rootDir: root,
            ownerKey: owner.ownerKey,
          })
        : await ensureWorkspaceStorageV2(owner);
    } else storage = await ensureWorkspaceStorageV2(owner);
    // If this request created v2 from a legacy file, finish the cutover in the
    // same writer-gated request before any response is published.
    if (!databaseExists && legacyExists)
      await prepareLegacyWorkspaceForV2(owner);
    if (request.method === "GET" && url.pathname === "/api/v2/workspace/describe") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(storage.describe()));
      return true;
    }
    if (request.method === "POST" && url.pathname === "/api/v2/workspace/query") {
      const result = storage.query(await readJsonBounded(request, 256 * 1024));
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(result));
      return true;
    }
    if (request.method === "POST" && url.pathname === "/api/v2/workspace/internal-journal-stream") {
      const input = await readJsonBounded(request, 256 * 1024);
      if (!input || typeof input !== "object" || input.collection !== "operationJournal") {
        throw new WorkspaceStorageError("INVALID_QUERY");
      }
      const result = storage.queryJournalInternal(input);
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(result));
      return true;
    }
    if (request.method === "POST" && url.pathname === "/api/v2/workspace/query-many") {
      const result = storage.queryMany(await readJsonBounded(request, 1024 * 1024));
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(result));
      return true;
    }
    if (request.method === "POST" && url.pathname === "/api/v2/workspace/transaction") {
      const result = storage.transaction(await readJsonBounded(request, 16 * 1024 * 1024));
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(result));
      return true;
    }
    if (request.method === "GET" && url.pathname === "/api/v2/workspace/export") {
      const collection = url.searchParams.get("collection") ?? undefined;
      response.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
      });
      if (!response.write(`${JSON.stringify({ type: "description", ...storage.describe() })}\n`))
        await once(response, "drain");
      for await (const entry of storage.exportRecords({ collection })) {
        if (!response.write(`${JSON.stringify({ type: "record", ...entry })}\n`))
          await once(response, "drain");
      }
      response.end();
      return true;
    }
    return false;
  } catch (error) {
    workspaceV2PublicError(response, error);
    return true;
  } finally {
    storage?.close();
  }
}

function collectNestedAssetIds(value, output, depth = 0, seen = new Set()) {
  if (depth > 12 || value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value)
      collectNestedAssetIds(item, output, depth + 1, seen);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (/assetId$/i.test(key) && typeof child === "string" && child)
      output.add(child);
    else collectNestedAssetIds(child, output, depth + 1, seen);
  }
}

// Text signatures are inline values, not asset IDs. Keep invalid image and
// uploaded-signature references visible to integrity checks and backup validation.
function isMediaAssetReference(fieldType, value) {
  return typeof value === "string" && value.length > 0 &&
    !(fieldType === "signature" && value.startsWith("text:"));
}

function workspaceAssetReferences(workspace) {
  const references = [];
  const versions = Array.isArray(workspace.templateVersions)
    ? workspace.templateVersions
    : [];
  const versionById = new Map(versions.map(item => [item?.id, item]));
  for (const version of versions) {
    const ids = new Set();
    collectNestedAssetIds(version?.pageManifest, ids);
    for (const assetId of ids)
      references.push({
        assetId,
        templateId: version?.templateId ?? null,
        templateVersionId: version?.id ?? null,
        location: "templateVersion.pageManifest",
      });
  }
  for (const instance of Array.isArray(workspace.instances)
    ? workspace.instances
    : []) {
    const ids = new Set();
    collectNestedAssetIds(instance?.outputHistory, ids);
    for (const assetId of ids)
      references.push({
        assetId,
        templateId: instance?.templateId ?? null,
        templateVersionId: instance?.templateVersionId ?? null,
        instanceId: instance?.id ?? null,
        location: "instance.outputHistory",
      });
    const mediaStableIds = new Map(
      (Array.isArray(workspace.fields) ? workspace.fields : [])
        .filter(
          field =>
            field?.templateVersionId === instance?.templateVersionId &&
            (field?.fieldType === "image" || field?.fieldType === "signature"),
        )
        .filter(field => field?.stableFieldId)
        .map(field => [field.stableFieldId, field.fieldType]),
    );
    for (const [stableFieldId, fieldType] of mediaStableIds) {
      const assetId = instance?.values?.[stableFieldId];
      if (!isMediaAssetReference(fieldType, assetId)) continue;
      references.push({
        assetId,
        templateId: instance?.templateId ?? null,
        templateVersionId: instance?.templateVersionId ?? null,
        instanceId: instance?.id ?? null,
        location: "instance.values",
      });
    }
  }
  for (const run of Array.isArray(workspace.importRuns)
    ? workspace.importRuns
    : []) {
    if (typeof run?.sourceAssetId !== "string" || !run.sourceAssetId) continue;
    const version = versionById.get(run.templateVersionId);
    references.push({
      assetId: run.sourceAssetId,
      templateId: version?.templateId ?? null,
      templateVersionId: run.templateVersionId ?? null,
      location: "importRun.sourceAssetId",
    });
  }
  return references;
}

async function* workspaceV2AssetReferencesFromStorage(storage, legacyWorkspace) {
  const mediaStableIds = new Map();
  for (const field of Array.isArray(legacyWorkspace.fields) ? legacyWorkspace.fields : []) {
    if (field?.fieldType !== "image" && field?.fieldType !== "signature") continue;
    const ids = mediaStableIds.get(field.templateVersionId) ?? new Map();
    if (typeof field.stableFieldId === "string" && field.stableFieldId)
      ids.set(field.stableFieldId, field.fieldType);
    mediaStableIds.set(field.templateVersionId, ids);
  }
  const versionById = new Map(
    (Array.isArray(legacyWorkspace.templateVersions) ? legacyWorkspace.templateVersions : [])
      .map(version => [version?.id, version]),
  );
  for await (const { record: instance } of storage.exportRecords({ collection: "instances" })) {
      const outputIds = new Set();
      collectNestedAssetIds(instance?.outputHistory, outputIds);
      for (const assetId of outputIds)
        yield {
          assetId,
          templateId: instance?.templateId ?? null,
          templateVersionId: instance?.templateVersionId ?? null,
          instanceId: instance?.id ?? null,
          location: "instance.outputHistory",
        };
      for (const [stableFieldId, fieldType] of mediaStableIds.get(instance?.templateVersionId) ?? []) {
        const assetId = instance?.values?.[stableFieldId];
        if (!isMediaAssetReference(fieldType, assetId)) continue;
        yield {
          assetId,
          templateId: instance?.templateId ?? null,
          templateVersionId: instance?.templateVersionId ?? null,
          instanceId: instance?.id ?? null,
          location: "instance.values",
        };
      }
  }
  for await (const { record: run } of storage.exportRecords({ collection: "importRuns" })) {
      if (typeof run?.sourceAssetId !== "string" || !run.sourceAssetId) continue;
      const version = versionById.get(run.templateVersionId);
      yield {
        assetId: run.sourceAssetId,
        templateId: version?.templateId ?? null,
        templateVersionId: run.templateVersionId ?? null,
        location: "importRun.sourceAssetId",
      };
  }
}

async function* workspaceV2AssetReferences(owner, legacyWorkspace) {
  const storage = await ensureWorkspaceStorageV2(owner);
  try {
    yield* workspaceV2AssetReferencesFromStorage(storage, legacyWorkspace);
  } finally {
    storage.close();
  }
}

async function workspaceV2ReferencesAsset(owner, legacyWorkspace, assetId) {
  for await (const reference of workspaceV2AssetReferences(owner, legacyWorkspace))
    if (reference.assetId === assetId) return true;
  return false;
}

function addWorkspaceAssetFinding(
  reference,
  accountName,
  manifestById,
  versionById,
  findings,
) {
  const manifest = manifestById.get(reference.assetId);
  if (!manifest) {
    findings.push({
      account: accountName,
      severity: "error",
      code: "workspace_asset_missing",
      assetId: reference.assetId,
      location: reference.location,
    });
    return;
  }
  const metadata = manifest.metadata && typeof manifest.metadata === "object"
    ? manifest.metadata
    : {};
  const metadataVersion = metadata.templateVersionId ?? null;
  const metadataTemplate = metadata.templateId ?? null;
  const metadataInstance = metadata.instanceId ?? null;
  const metadataVersionTemplate = metadataVersion
    ? versionById.get(metadataVersion)?.templateId ?? null
    : null;
  if (
    (reference.templateId && metadataTemplate && metadataTemplate !== reference.templateId) ||
    (reference.templateId && metadataVersion && metadataVersionTemplate !== reference.templateId) ||
    (reference.instanceId && metadataInstance && metadataInstance !== reference.instanceId)
  )
    findings.push({
      account: accountName,
      severity: "error",
      code: "workspace_asset_metadata_mismatch",
      assetId: reference.assetId,
      location: reference.location,
    });
}

async function* workspaceV2RecordBatches(storage, collection, batchSize = 500) {
  let batch = [];
  for await (const { record } of storage.exportRecords({ collection })) {
    batch.push(record);
    if (batch.length === batchSize) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length) yield batch;
}

function queriedRecordsById(storage, collection, values) {
  const ids = [...new Set(values.filter(value => typeof value === "string" && value))];
  if (!ids.length) return new Map();
  const records = storage.queryMany({ collection, key: "id", values: ids }).records;
  return new Map(records.map(record => [record?.id, record]));
}

async function addWorkspaceV2RelationFindings(
  storage,
  workspace,
  accountName,
  manifestById,
  findings,
) {
  const arrays = name => (Array.isArray(workspace[name]) ? workspace[name] : []);
  const templates = arrays("templates");
  const versions = arrays("templateVersions");
  const fields = arrays("fields");
  const templateIds = new Set(templates.map(item => item?.id).filter(Boolean));
  const versionById = new Map(versions.map(item => [item?.id, item]));
  const fieldsByVersion = new Map();
  const mediaStableIds = new Map();
  for (const field of fields) {
    const stableIds = fieldsByVersion.get(field?.templateVersionId) ?? new Set();
    if (field?.stableFieldId) stableIds.add(field.stableFieldId);
    fieldsByVersion.set(field?.templateVersionId, stableIds);
    if (field?.fieldType === "image" || field?.fieldType === "signature") {
      const mediaIds = mediaStableIds.get(field?.templateVersionId) ?? new Map();
      if (typeof field?.stableFieldId === "string" && field.stableFieldId)
        mediaIds.set(field.stableFieldId, field.fieldType);
      mediaStableIds.set(field?.templateVersionId, mediaIds);
    }
  }
  const relationError = (code, recordType, recordId) =>
    findings.push({ account: accountName, severity: "error", code, recordType, recordId });

  await storage.readSnapshot(async snapshot => {
    snapshot.integrityCheck();
    for await (const batch of workspaceV2RecordBatches(snapshot, "instances")) {
      for (const instance of batch) {
        const version = versionById.get(instance?.templateVersionId);
        if (
          typeof instance?.id !== "string" ||
          !instance.id ||
          !templateIds.has(instance?.templateId) ||
          !version ||
          version.templateId !== instance.templateId
        )
          relationError("workspace_instance_relation_invalid", "instance", instance?.id ?? null);

        const outputIds = new Set();
        collectNestedAssetIds(instance?.outputHistory, outputIds);
        for (const assetId of outputIds)
          addWorkspaceAssetFinding({
            assetId,
            templateId: instance?.templateId ?? null,
            templateVersionId: instance?.templateVersionId ?? null,
            instanceId: instance?.id ?? null,
            location: "instance.outputHistory",
          }, accountName, manifestById, versionById, findings);
        for (const [stableFieldId, fieldType] of mediaStableIds.get(instance?.templateVersionId) ?? []) {
          const assetId = instance?.values?.[stableFieldId];
          if (!isMediaAssetReference(fieldType, assetId)) continue;
          addWorkspaceAssetFinding({
            assetId,
            templateId: instance?.templateId ?? null,
            templateVersionId: instance?.templateVersionId ?? null,
            instanceId: instance?.id ?? null,
            location: "instance.values",
          }, accountName, manifestById, versionById, findings);
        }
      }
    }

    for await (const batch of workspaceV2RecordBatches(snapshot, "importRuns")) {
      for (const run of batch) {
        if (!versionById.has(run?.templateVersionId))
          relationError("workspace_import_run_version_missing", "import_run", run?.id ?? null);
        if (typeof run?.sourceAssetId !== "string" || !run.sourceAssetId) continue;
        addWorkspaceAssetFinding({
          assetId: run.sourceAssetId,
          templateId: versionById.get(run?.templateVersionId)?.templateId ?? null,
          templateVersionId: run?.templateVersionId ?? null,
          location: "importRun.sourceAssetId",
        }, accountName, manifestById, versionById, findings);
      }
    }

    for await (const batch of workspaceV2RecordBatches(snapshot, "importRows")) {
      const runById = queriedRecordsById(
        snapshot,
        "importRuns",
        batch.map(row => row?.importRunId),
      );
      const instanceById = queriedRecordsById(
        snapshot,
        "instances",
        batch.map(row => row?.instanceId),
      );
      for (const row of batch) {
        if (!runById.has(row?.importRunId))
          relationError("workspace_import_row_run_missing", "import_row", row?.id ?? null);
        if (row?.instanceId != null && !instanceById.has(row.instanceId))
          relationError("workspace_import_row_instance_missing", "import_row", row?.id ?? null);
      }
    }

    for await (const batch of workspaceV2RecordBatches(snapshot, "mappingDecisions")) {
      const runById = queriedRecordsById(
        snapshot,
        "importRuns",
        batch.map(decision => decision?.importRunId),
      );
      for (const decision of batch) {
        const run = runById.get(decision?.importRunId);
        if (!run)
          relationError(
            "workspace_mapping_decision_run_missing",
            "mapping_decision",
            decision?.id ?? null,
          );
        if (decision?.decision !== "accepted") continue;
        const stableId = decision?.templateStableFieldId;
        if (
          typeof stableId !== "string" ||
          !fieldsByVersion.get(run?.templateVersionId)?.has(stableId)
        )
          relationError(
            "workspace_mapping_decision_field_missing",
            "mapping_decision",
            decision?.id ?? null,
          );
      }
    }
  });
}

function addWorkspaceRelationFindings(workspace, accountName, manifestById, findings) {
  const arrays = name => (Array.isArray(workspace[name]) ? workspace[name] : []);
  const templates = arrays("templates");
  const versions = arrays("templateVersions");
  const fields = arrays("fields");
  const instances = arrays("instances");
  const folders = arrays("folders");
  const tags = arrays("tags");
  const importRuns = arrays("importRuns");
  const ids = records => new Set(records.map(item => item?.id).filter(Boolean));
  const templateIds = ids(templates);
  const versionIds = ids(versions);
  const folderIds = ids(folders);
  const tagIds = ids(tags);
  const importRunIds = ids(importRuns);
  const instanceIds = ids(instances);
  const versionById = new Map(versions.map(item => [item?.id, item]));
  const fieldsByVersion = new Map();
  for (const field of fields) {
    const set = fieldsByVersion.get(field?.templateVersionId) ?? new Set();
    if (field?.stableFieldId) set.add(field.stableFieldId);
    fieldsByVersion.set(field?.templateVersionId, set);
  }
  const relationError = (code, recordType, recordId) =>
    findings.push({ account: accountName, severity: "error", code, recordType, recordId });

  for (const [collection, records] of [
    ["template", templates],
    ["template_version", versions],
    ["field", fields],
    ["instance", instances],
    ["folder", folders],
    ["tag", tags],
    ["import_run", importRuns],
  ]) {
    const seen = new Set();
    for (const record of records) {
      if (typeof record?.id !== "string" || !record.id || seen.has(record.id))
        relationError("workspace_duplicate_or_invalid_id", collection, record?.id ?? null);
      else seen.add(record.id);
    }
  }
  for (const version of versions)
    if (!templateIds.has(version?.templateId))
      relationError("workspace_version_template_missing", "template_version", version?.id);
  for (const template of templates) {
    for (const pointer of [
      template?.currentPublishedVersionId,
      template?.currentDraftVersionId,
    ])
      if (pointer != null) {
        const version = versionById.get(pointer);
        if (!version || version.templateId !== template.id)
          relationError("workspace_template_version_pointer_invalid", "template", template?.id);
      }
    for (const folderId of Array.isArray(template?.folderIds) ? template.folderIds : [])
      if (!folderIds.has(folderId))
        relationError("workspace_template_folder_missing", "template", template?.id);
    for (const tagId of Array.isArray(template?.tagIds) ? template.tagIds : [])
      if (!tagIds.has(tagId))
        relationError("workspace_template_tag_missing", "template", template?.id);
  }
  for (const field of fields)
    if (!versionIds.has(field?.templateVersionId))
      relationError("workspace_field_version_missing", "field", field?.id);
  for (const instance of instances) {
    const version = versionById.get(instance?.templateVersionId);
    if (!templateIds.has(instance?.templateId) || !version || version.templateId !== instance.templateId)
      relationError("workspace_instance_relation_invalid", "instance", instance?.id);
  }
  for (const folder of folders)
    if (folder?.parentId != null && !folderIds.has(folder.parentId))
      relationError("workspace_folder_parent_missing", "folder", folder?.id);
  for (const value of arrays("savedValues"))
    if (!templateIds.has(value?.templateId))
      relationError("workspace_saved_value_template_missing", "saved_value", value?.id);
  for (const mapping of arrays("mappingTemplates"))
    if (!versionIds.has(mapping?.templateVersionId))
      relationError("workspace_mapping_version_missing", "mapping_template", mapping?.id);
  for (const run of importRuns)
    if (!versionIds.has(run?.templateVersionId))
      relationError("workspace_import_run_version_missing", "import_run", run?.id);
  for (const row of arrays("importRows")) {
    if (!importRunIds.has(row?.importRunId))
      relationError("workspace_import_row_run_missing", "import_row", row?.id);
    if (row?.instanceId != null && !instanceIds.has(row.instanceId))
      relationError("workspace_import_row_instance_missing", "import_row", row?.id);
  }
  const importRunById = new Map(importRuns.map(item => [item?.id, item]));
  for (const decision of arrays("mappingDecisions")) {
    if (!importRunIds.has(decision?.importRunId))
      relationError("workspace_mapping_decision_run_missing", "mapping_decision", decision?.id);
    if (decision?.decision === "accepted") {
      const run = importRunById.get(decision?.importRunId);
      const stableId = decision?.templateStableFieldId;
      if (
        typeof stableId !== "string" ||
        !fieldsByVersion.get(run?.templateVersionId)?.has(stableId)
      )
        relationError(
          "workspace_mapping_decision_field_missing",
          "mapping_decision",
          decision?.id,
        );
    }
  }
  for (const run of arrays("detectionRuns"))
    if (!versionIds.has(run?.templateVersionId))
      relationError("workspace_detection_version_missing", "detection_run", run?.id);

  for (const reference of workspaceAssetReferences(workspace))
    addWorkspaceAssetFinding(
      reference,
      accountName,
      manifestById,
      versionById,
      findings,
    );
}

const integrityTestLimitsEnabled =
  process.env.FORMDIGITAL_ENABLE_TEST_HOOKS === "1";

function integrityLimit(name, fallback, minimum, maximum) {
  if (!integrityTestLimitsEnabled) return fallback;
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

const INTEGRITY_LIMITS = Object.freeze({
  manifests: integrityLimit(
    "FORMDIGITAL_TEST_INTEGRITY_MAX_MANIFESTS",
    200_000,
    1,
    200_000,
  ),
  objects: integrityLimit(
    "FORMDIGITAL_TEST_INTEGRITY_MAX_OBJECTS",
    200_000,
    1,
    200_000,
  ),
  owners: integrityLimit(
    "FORMDIGITAL_TEST_INTEGRITY_MAX_OWNERS",
    10_000,
    1,
    10_000,
  ),
  findings: integrityLimit(
    "FORMDIGITAL_TEST_INTEGRITY_MAX_FINDINGS",
    10_000,
    1,
    10_000,
  ),
  manifestBytes: integrityLimit(
    "FORMDIGITAL_TEST_INTEGRITY_MAX_MANIFEST_BYTES",
    2 * 1024 * 1024,
    64,
    2 * 1024 * 1024,
  ),
  workspaceBytes: 64 * 1024 * 1024,
});

function boundedIntegrityFindings(limit) {
  const findings = [];
  const append = Array.prototype.push.bind(findings);
  let limitReported = false;
  Object.defineProperty(findings, "push", {
    enumerable: false,
    value: (...entries) => {
      for (const entry of entries) {
        if (findings.length < limit - 1) append(entry);
        else if (!limitReported) {
          append({
            severity: "error",
            code: "integrity_scan_limit_exceeded",
            scope: "findings",
          });
          limitReported = true;
        }
      }
      return findings.length;
    },
  });
  return findings;
}

async function* boundedIntegrityDirectory(directoryPath, limit, scope, findings) {
  let directory;
  try {
    directory = await fs.opendir(directoryPath);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return;
    throw error;
  }
  let count = 0;
  try {
    for await (const entry of directory) {
      count += 1;
      if (count > limit) {
        findings.push({
          severity: "error",
          code: "integrity_scan_limit_exceeded",
          scope,
        });
        break;
      }
      yield entry;
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
}

async function integrityScanAt(scanDirs) {
  const findings = boundedIntegrityFindings(INTEGRITY_LIMITS.findings);
  const referencedObjects = new Set();
  const manifestsByOwner = new Map();
  let manifestsScanned = 0;
  for await (const entry of boundedIntegrityDirectory(
    scanDirs.manifests,
    INTEGRITY_LIMITS.manifests,
    "manifests",
    findings,
  )) {
    const name = entry.name;
    if (!name.endsWith(".json")) continue;
    manifestsScanned += 1;
    try {
      const manifestPath = path.join(scanDirs.manifests, name);
      const manifestStat = await fs.lstat(manifestPath);
      if (
        !manifestStat.isFile() ||
        manifestStat.size > INTEGRITY_LIMITS.manifestBytes
      ) {
        findings.push({
          manifestFile: name,
          severity: "error",
          code: "manifest_size_limit_exceeded",
        });
        continue;
      }
      const manifest = JSON.parse(
        await fs.readFile(manifestPath, "utf8")
      );
      if (
        !manifest.id ||
        !/^[a-z0-9_-]+$/i.test(String(manifest.id)) ||
        !/^[a-f0-9]{64}$/i.test(String(manifest.ownerKeyHash)) ||
        !/^[a-f0-9]{64}$/i.test(String(manifest.contentHash))
      ) {
        findings.push({
          manifestFile: name,
          severity: "error",
          code: "manifest_invalid",
        });
        continue;
      }
      referencedObjects.add(manifest.contentHash);
      if (name !== `${manifest.id}.json`)
        findings.push({ manifestFile: name, severity: "error", code: "manifest_filename_mismatch" });
      if (!manifestsByOwner.has(manifest.ownerKeyHash))
        manifestsByOwner.set(manifest.ownerKeyHash, new Map());
      manifestsByOwner.get(manifest.ownerKeyHash).set(manifest.id, manifest);
      const objectPath = path.join(scanDirs.objects, manifest.contentHash);
      const stat = await fs.lstat(objectPath);
      if (
        !stat.isFile() ||
        !Number.isSafeInteger(manifest.size) ||
        manifest.size < 0 ||
        stat.size !== manifest.size ||
        await hashFileSha256(objectPath) !== manifest.contentHash
      )
        findings.push({
          manifestId: manifest.id,
          manifestFile: name,
          severity: "error",
          code: "content_hash_mismatch",
        });
    } catch {
      findings.push({
        manifestFile: name,
        severity: "error",
        code: "manifest_or_object_unreadable",
      });
    }
  }
  for await (const entry of boundedIntegrityDirectory(
    scanDirs.objects,
    INTEGRITY_LIMITS.objects,
    "objects",
    findings,
  )) {
    const name = entry.name;
    if (!referencedObjects.has(name))
      findings.push({
        objectFile: name,
        severity: "warning",
        code: "orphan_object",
      });
  }
  const accountNames = new Set();
  const workspaceV2Owners = new Set();
  const addOwner = (entry, isWorkspaceV2) => {
    if (!entry.isDirectory()) return;
    if (!accountNames.has(entry.name) && accountNames.size >= INTEGRITY_LIMITS.owners) {
      findings.push({
        severity: "error",
        code: "integrity_scan_limit_exceeded",
        scope: "owners",
      });
      return;
    }
    accountNames.add(entry.name);
    if (isWorkspaceV2) workspaceV2Owners.add(entry.name);
  };
  for await (const entry of boundedIntegrityDirectory(
    scanDirs.accounts,
    INTEGRITY_LIMITS.owners,
    "owners",
    findings,
  )) addOwner(entry, false);
  for await (const entry of boundedIntegrityDirectory(
    scanDirs["workspace-v2"],
    INTEGRITY_LIMITS.owners,
    "owners",
    findings,
  )) addOwner(entry, true);
  for (const accountName of accountNames) {
    const workspacePath = path.join(
      scanDirs.accounts,
      accountName,
      "workspace.json"
    );
    let envelope = null;
    try {
      const workspaceStat = await fs.lstat(workspacePath);
      if (!workspaceStat.isFile() || workspaceStat.size > INTEGRITY_LIMITS.workspaceBytes) {
        findings.push({
          account: accountName,
          severity: "error",
          code: "workspace_size_limit_exceeded",
        });
        continue;
      }
      envelope = JSON.parse(await fs.readFile(workspacePath, "utf8"));
      if (
        !Number.isInteger(envelope.revision) ||
        !envelope.workspace ||
        typeof envelope.workspace !== "object"
      ) {
        findings.push({
          account: accountName,
          severity: "error",
          code: "workspace_invalid",
        });
      }
    } catch (error) {
      findings.push({
        account: accountName,
        severity: "error",
        code: isErrnoCode(error, "ENOENT")
          ? "workspace_missing"
          : "workspace_unreadable",
      });
    }

    const v2DatabasePath = path.join(
      scanDirs["workspace-v2"],
      accountName,
      "workspace-v2.sqlite",
    );
    const v2Stat = await fs.lstat(v2DatabasePath).catch(() => null);
    const hasWorkspaceV2 = !!v2Stat?.isFile();
    if (workspaceV2Owners.has(accountName) && !hasWorkspaceV2)
      findings.push({
        account: accountName,
        severity: "error",
        code: "workspace_v2_missing",
      });

    if (
      envelope?.workspace &&
      typeof envelope.workspace === "object" &&
      !Array.isArray(envelope.workspace)
    ) {
      const relationWorkspace = hasWorkspaceV2
        ? {
            ...envelope.workspace,
            instances: [],
            importRuns: [],
            importRows: [],
            mappingDecisions: [],
            operationJournal: [],
          }
        : envelope.workspace;
      addWorkspaceRelationFindings(
        relationWorkspace,
        accountName,
        manifestsByOwner.get(accountName) ?? new Map(),
        findings,
      );
    }

    if (!hasWorkspaceV2) continue;
    let storage = null;
    try {
      storage = WorkspaceStorageV2.openExistingReadOnly({
        rootDir: scanDirs.root,
        ownerHash: accountName,
      });
      storage.integrityCheck();
      if (
        envelope?.workspace &&
        typeof envelope.workspace === "object" &&
        !Array.isArray(envelope.workspace)
      )
        await addWorkspaceV2RelationFindings(
          storage,
          envelope.workspace,
          accountName,
          manifestsByOwner.get(accountName) ?? new Map(),
          findings,
        );
    } catch {
      findings.push({
        account: accountName,
        severity: "error",
        code: "workspace_v2_unreadable",
      });
    } finally {
      storage?.close();
    }
  }
  return {
    scannedAt: now(),
    manifestsScanned,
    findings,
    healthy: !findings.some(finding => finding.severity === "error"),
  };
}

async function integrityScan() {
  return integrityScanAt(dirs);
}

async function repairIntegrity() {
  const before = await integrityScan();
  if (before.healthy)
    return {
      repaired: false,
      emergencyBackupId: null,
      before,
      after: before,
      quarantined: [],
    };
  // A byte-for-byte emergency snapshot is mandatory. If this fails, no repair is attempted.
  const emergency = await createBackup("emergency-repair");
  const quarantineId = `repair-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
  const quarantineRoot = path.join(dirs.quarantine, quarantineId, "manifests");
  await fs.mkdir(quarantineRoot, { recursive: true });
  const quarantined = [];
  for (const finding of before.findings) {
    if (
      finding.severity !== "error" ||
      !finding.manifestFile ||
      !/^[\w.-]+\.json$/.test(String(finding.manifestFile))
    )
      continue;
    const source = path.join(
      dirs.manifests,
      path.basename(String(finding.manifestFile))
    );
    const destination = path.join(
      quarantineRoot,
      path.basename(String(finding.manifestFile))
    );
    try {
      await fs.rename(source, destination);
      quarantined.push(path.basename(String(finding.manifestFile)));
    } catch (error) {
      if (
        !(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        )
      )
        throw error;
    }
  }
  const after = await integrityScan();
  await atomicWrite(
    path.join(dirs.quarantine, quarantineId, "repair-report.json"),
    Buffer.from(
      JSON.stringify(
        {
          repairedAt: now(),
          emergencyBackupId: emergency.id,
          before,
          after,
          quarantined,
        },
        null,
        2
      )
    )
  );
  await appendJournal("integrity.repair", {
    emergencyBackupId: emergency.id,
    quarantineId,
    quarantined: quarantined.length,
    healthy: after.healthy,
  });
  return {
    repaired: true,
    emergencyBackupId: emergency.id,
    quarantineId,
    quarantined,
    before,
    after,
  };
}

async function createBackup(kind = "manual") {
  const id = `backup-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
  const emergency = kind.startsWith("emergency");
  const destination = path.join(
    emergency ? path.join(dirs.backups, "emergency") : dirs.backups,
    id
  );
  let destinationCreated = false;
  let snapshotCompleted = false;
  try {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.mkdir(destination);
    destinationCreated = true;
    // Byte-for-byte snapshot of the core Local Data Folder state taken BEFORE
    // any repair/restore mutation. Never copies backups/quarantine/staging so
    // the snapshot can never nest itself or pull in quarantine/staging data.
    await fs.cp(dirs.objects, path.join(destination, "objects"), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    await fs.cp(dirs.manifests, path.join(destination, "manifests"), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    await fs.cp(dirs.accounts, path.join(destination, "accounts"), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    await fs.cp(dirs.metadata, path.join(destination, "metadata"), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    await fs.cp(dirs.journal, path.join(destination, "journal"), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    await fs.cp(dirs["workspace-v2"], path.join(destination, "workspace-v2"), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    const scan = await integrityScanAt(directoriesFor(destination));
    await atomicWrite(
      path.join(destination, "backup-manifest.json"),
      Buffer.from(
        JSON.stringify(
          { id, kind, createdAt: now(), scan, schemaVersion: 1 },
          null,
          2
        )
      )
    );
    snapshotCompleted = true;
    await appendJournal("backup.create", {
      id,
      kind,
      healthyAtCreation: scan.healthy,
    });
    return { id, path: destination, scan };
  } catch (error) {
    // Clear only a destination created by this call, and only until both the
    // core copies and backup manifest form a complete snapshot. A collision
    // can therefore never remove a pre-existing successful backup.
    if (destinationCreated && !snapshotCompleted)
      await fs.rm(destination, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function isStoredManifestRecord(manifest) {
  return (
    manifest &&
    typeof manifest === "object" &&
    !Array.isArray(manifest) &&
    typeof manifest.id === "string" &&
    /^asset-[\w-]+$/.test(manifest.id) &&
    typeof manifest.ownerKeyHash === "string" &&
    /^[a-f0-9]{64}$/.test(manifest.ownerKeyHash) &&
    typeof manifest.contentHash === "string" &&
    /^[a-f0-9]{64}$/.test(manifest.contentHash)
  );
}

async function ownerManifests(ownerHash) {
  const result = [];
  for (const name of (await fs.readdir(dirs.manifests)).filter(file =>
    file.endsWith(".json")
  )) {
    const target = path.join(dirs.manifests, name);
    const stat = await fs.lstat(target);
    if (!stat.isFile()) throw new Error("Stored asset manifest is unreadable.");
    let manifest;
    try {
      manifest = JSON.parse(await fs.readFile(target, "utf8"));
    } catch {
      throw new Error("Stored asset manifest is unreadable.");
    }
    if (!isStoredManifestRecord(manifest))
      throw new Error("Stored asset manifest is unreadable.");
    if (manifest.ownerKeyHash === ownerHash) result.push({ name, manifest });
  }
  return result;
}

async function allManifestsStrict() {
  const result = [];
  for (const name of (await fs.readdir(dirs.manifests)).filter(file =>
    file.endsWith(".json")
  )) {
    const target = path.join(dirs.manifests, name);
    const stat = await fs.lstat(target);
    if (!stat.isFile()) throw new Error("Stored asset manifest is unreadable.");
    let manifest;
    try {
      manifest = JSON.parse(await fs.readFile(target, "utf8"));
    } catch {
      throw new Error("Stored asset manifest is unreadable.");
    }
    if (!isStoredManifestRecord(manifest))
      throw new Error("Stored asset manifest is unreadable.");
    result.push({ name, manifest });
  }
  return result;
}

function scopeWorkspaceEnvelope(envelope, templateId) {
  if (!templateId) return envelope;
  const workspace = envelope.workspace ?? {};
  const templates = (workspace.templates ?? []).filter(
    item => item.id === templateId
  );
  if (!templates.length)
    throw new Error("Template not found for portable Backup.");
  const versions = (workspace.templateVersions ?? []).filter(
    item => item.templateId === templateId
  );
  const versionIds = new Set(versions.map(item => item.id));
  const instances = (workspace.instances ?? []).filter(
    item => item.templateId === templateId
  );
  const importRuns = (workspace.importRuns ?? []).filter(item =>
    versionIds.has(item.templateVersionId)
  );
  const importRunIds = new Set(importRuns.map(item => item.id));
  const folderIds = new Set(templates.flatMap(item => item.folderIds ?? []));
  const tagIds = new Set(templates.flatMap(item => item.tagIds ?? []));
  return {
    ...envelope,
    workspace: {
      ...workspace,
      templates,
      templateVersions: versions,
      fields: (workspace.fields ?? []).filter(item =>
        versionIds.has(item.templateVersionId)
      ),
      instances,
      folders: (workspace.folders ?? []).filter(item => folderIds.has(item.id)),
      tags: (workspace.tags ?? []).filter(item => tagIds.has(item.id)),
      savedValues: (workspace.savedValues ?? []).filter(
        item => item.templateId === templateId
      ),
      mappingTemplates: (workspace.mappingTemplates ?? []).filter(item =>
        versionIds.has(item.templateVersionId)
      ),
      importRuns,
      importRows: (workspace.importRows ?? []).filter(item =>
        importRunIds.has(item.importRunId)
      ),
      mappingDecisions: (workspace.mappingDecisions ?? []).filter(
        item =>
          importRunIds.has(item.importRunId) ||
          versionIds.has(item.templateVersionId)
      ),
      detectionRuns: (workspace.detectionRuns ?? []).filter(item =>
        versionIds.has(item.templateVersionId)
      ),
      operationJournal: [],
      preferences: {},
    },
  };
}

const LEGACY_TEMPLATE_V2_RECORD_BUDGET_BYTES = 24 * 1024 * 1024;

function collectScopedWorkspaceV2Records(
  storage,
  collection,
  where,
  output,
  seen,
  budget,
) {
  let cursor = null;
  do {
    const page = storage.query({
      collection,
      where,
      limit: 500,
      cursor,
    });
    for (const record of page.records) {
      const id = typeof record?.id === "string" ? record.id : JSON.stringify(record);
      if (seen.has(id)) continue;
      const bytes = Buffer.byteLength(JSON.stringify(record), "utf8");
      budget.bytes += bytes;
      if (budget.bytes > LEGACY_TEMPLATE_V2_RECORD_BUDGET_BYTES)
        throw legacyPortableBackupCreationTooLarge();
      seen.add(id);
      output.push(record);
    }
    cursor = page.nextCursor;
  } while (cursor);
}

function scopeProjectedWorkspaceEnvelope(envelope, templateId, storage) {
  const scoped = scopeWorkspaceEnvelope(envelope, templateId);
  const workspace = scoped.workspace;
  const versionIds = new Set(
    (workspace.templateVersions ?? []).map(item => item.id).filter(Boolean),
  );
  const budget = {
    bytes: Buffer.byteLength(JSON.stringify(workspace), "utf8"),
  };
  if (budget.bytes > LEGACY_TEMPLATE_V2_RECORD_BUDGET_BYTES)
    throw legacyPortableBackupCreationTooLarge();
  const instances = [];
  const importRuns = [];
  const importRows = [];
  const mappingDecisions = [];
  const instanceIds = new Set();
  const importRunIds = new Set();
  const importRowIds = new Set();
  const mappingDecisionIds = new Set();
  collectScopedWorkspaceV2Records(
    storage,
    "instances",
    { templateId },
    instances,
    instanceIds,
    budget,
  );
  for (const templateVersionId of versionIds) {
    collectScopedWorkspaceV2Records(
      storage,
      "importRuns",
      { templateVersionId },
      importRuns,
      importRunIds,
      budget,
    );
    collectScopedWorkspaceV2Records(
      storage,
      "mappingDecisions",
      { templateVersionId },
      mappingDecisions,
      mappingDecisionIds,
      budget,
    );
  }
  for (const run of importRuns) {
    if (typeof run?.id !== "string" || !run.id) continue;
    collectScopedWorkspaceV2Records(
      storage,
      "importRows",
      { importRunId: run.id },
      importRows,
      importRowIds,
      budget,
    );
    collectScopedWorkspaceV2Records(
      storage,
      "mappingDecisions",
      { importRunId: run.id },
      mappingDecisions,
      mappingDecisionIds,
      budget,
    );
  }
  return {
    ...scoped,
    workspace: {
      ...workspace,
      instances,
      importRuns,
      importRows,
      mappingDecisions,
    },
  };
}

async function createPortableBackup(
  ownerOrHash,
  kind = "manual",
  templateId = null
) {
  const owner =
    ownerOrHash && typeof ownerOrHash === "object" ? ownerOrHash : null;
  const ownerHash = owner ? owner.ownerKeyHash : String(ownerOrHash);
  const id = `backup-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
  const entries = {};
  const account = accountPaths(ownerHash);
  try {
    const envelope = JSON.parse(await fs.readFile(account.workspace, "utf8"));
    const projection = workspaceProjectionMarker(envelope?.workspace);
    let scopedEnvelope;
    if (projection) {
      if (!templateId || !owner)
        throw legacyPortableBackupCreationTooLarge();
      await requireUsableProjectedWorkspaceV2(owner);
      const storage = await ensureWorkspaceStorageV2(owner);
      try {
        storage.integrityCheck();
        scopedEnvelope = scopeProjectedWorkspaceEnvelope(
          envelope,
          templateId,
          storage,
        );
      } finally {
        storage.close();
      }
    } else scopedEnvelope = scopeWorkspaceEnvelope(envelope, templateId);
    entries["account/workspace.json"] = strToU8(
      JSON.stringify(scopedEnvelope, null, 2)
    );
    if (
      entries["account/workspace.json"].byteLength >
      LEGACY_TEMPLATE_V2_RECORD_BUDGET_BYTES
    )
      throw legacyPortableBackupCreationTooLarge();
  } catch (error) {
    if (
      !(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
    )
      throw error;
    entries["account/workspace.json"] = strToU8(
      JSON.stringify(
        scopeWorkspaceEnvelope(await loadWorkspace(ownerHash), templateId),
        null,
        2
      )
    );
  }
  const manifests = await ownerManifests(ownerHash);
  const scopedEnvelope = JSON.parse(
    strFromU8(entries["account/workspace.json"])
  );
  const scopedWorkspace = scopedEnvelope.workspace ?? {};
  const scopedVersionIds = new Set(
    (scopedWorkspace.templateVersions ?? []).map(item => item.id)
  );
  const scopedInstanceIds = new Set(
    (scopedWorkspace.instances ?? []).map(item => item.id)
  );
  const includedManifestIds = new Set();
  for (const { name, manifest } of manifests) {
    if (
      templateId &&
      manifest.metadata?.templateId !== templateId &&
      !scopedVersionIds.has(manifest.metadata?.templateVersionId) &&
      !scopedInstanceIds.has(manifest.metadata?.instanceId)
    )
      continue;
    entries[`manifests/${name}`] = strToU8(JSON.stringify(manifest, null, 2));
    includedManifestIds.add(manifest.id);
    const objectPath = `objects/${manifest.contentHash}`;
    if (!entries[objectPath])
      entries[objectPath] = new Uint8Array(
        await fs.readFile(path.join(dirs.objects, manifest.contentHash))
      );
  }
  for (const reference of workspaceAssetReferences(scopedWorkspace))
    if (!includedManifestIds.has(reference.assetId))
      throw new Error(
        "Portable Backup Workspace references an asset that cannot be included.",
      );
  const files = Object.entries(entries).map(([filePath, bytes]) => ({
    path: filePath,
    contentHash: sha256(bytes),
    size: bytes.byteLength,
  }));
  let summary = {
    templates: [],
    templateCount: 0,
    versionCount: 0,
    instanceCount: 0,
    mappingTemplateCount: 0,
  };
  try {
    const envelope = JSON.parse(strFromU8(entries["account/workspace.json"]));
    const workspace = envelope.workspace ?? {};
    summary = {
      templates: (workspace.templates ?? []).map(template => ({
        id: template.id,
        name: template.name,
        versions: (workspace.templateVersions ?? []).filter(
          version => version.templateId === template.id
        ).length,
        instances: (workspace.instances ?? []).filter(
          instance => instance.templateId === template.id
        ).length,
      })),
      templateCount: (workspace.templates ?? []).length,
      versionCount: (workspace.templateVersions ?? []).length,
      instanceCount: (workspace.instances ?? []).length,
      mappingTemplateCount: (workspace.mappingTemplates ?? []).length,
    };
  } catch {}
  const manifest = {
    format: "formdigital-portable-backup",
    schemaVersion: 1,
    id,
    kind,
    scope: templateId ? "template" : "account",
    templateId,
    ownerKeyHash: ownerHash,
    createdAt: now(),
    files,
    summary,
  };
  entries["backup-manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));
  const archive = zipSync(entries, { level: 6 });
  // Publication is the trust boundary: exercise the same strict verifier used
  // by restore against the exact bytes that will be persisted.
  verifyPortableBackup(archive, ownerHash);
  // Keep creation and restore limits symmetric. This check must remain before
  // mkdir, atomicWrite, the journal entry and the Base64 response conversion.
  if (archive.byteLength > PORTABLE_LEGACY_CREATE_MAX_BYTES)
    throw legacyPortableBackupCreationTooLarge();
  const backupFolder =
    kind.startsWith("pre-") || kind.startsWith("emergency")
      ? path.join(dirs.backups, "emergency")
      : dirs.backups;
  await fs.mkdir(backupFolder, { recursive: true });
  await atomicWrite(
    path.join(backupFolder, `${id}.formdigital-backup`),
    archive
  );
  await appendJournal("backup.portable.create", {
    id,
    kind,
    ownerKeyHash: ownerHash,
    files: files.length,
    contentHash: sha256(archive),
  });
  return {
    id,
    createdAt: manifest.createdAt,
    archiveBase64: Buffer.from(archive).toString("base64"),
    manifest,
  };
}

async function deriveWorkspaceV2PortableSummary(storage, workspace) {
  const summary = derivePortableSummary({ ...workspace, instances: [] });
  const instancesByTemplate = new Map();
  await storage.readSnapshot(async snapshot => {
    snapshot.integrityCheck();
    for await (const { record } of snapshot.exportRecords({ collection: "instances" })) {
      const templateId = record?.templateId;
      if (typeof templateId !== "string" || !templateId) continue;
      instancesByTemplate.set(
        templateId,
        (instancesByTemplate.get(templateId) ?? 0) + 1,
      );
    }
  });
  summary.templates = summary.templates.map(template => ({
    ...template,
    instances: instancesByTemplate.get(template.id) ?? 0,
  }));
  summary.instanceCount = [...instancesByTemplate.values()].reduce(
    (total, count) => total + count,
    0,
  );
  return summary;
}

async function createStreamingPortableBackup(owner, kind = "manual") {
  const id = `backup-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
  const createdAt = now();
  const account = accountPaths(owner.ownerKeyHash);
  const workspaceInfo = await hashPortableFile(
    account.workspace,
    PORTABLE_STREAM_LIMITS.workspaceBytes,
  );
  let envelope;
  try {
    envelope = JSON.parse(await fs.readFile(account.workspace, "utf8"));
  } catch {
    throw new PortableArchiveStreamError("PORTABLE_WORKSPACE_INVALID");
  }
  if (
    !envelope ||
    typeof envelope !== "object" ||
    !Number.isInteger(envelope.revision) ||
    !envelope.workspace ||
    typeof envelope.workspace !== "object" ||
    Array.isArray(envelope.workspace)
  )
    throw new PortableArchiveStreamError("PORTABLE_WORKSPACE_INVALID");

  const storage = await ensureWorkspaceStorageV2(owner);
  let workspaceV2;
  let summary;
  try {
    storage.integrityCheck();
    workspaceV2 = storage.describe();
    summary = await deriveWorkspaceV2PortableSummary(storage, envelope.workspace);
  } finally {
    storage.close();
  }
  const workspaceV2Paths = ownerWorkspaceV2Paths(root, owner.ownerKey);
  const workspaceV2Path = workspaceV2Paths.databasePath;
  const workspaceV2Info = await hashPortableFile(
    workspaceV2Path,
    PORTABLE_STREAM_LIMITS.workspaceV2Bytes,
  );
  const inspectedWorkspaceV2 = inspectWorkspaceStorageV2File({
    databasePath: workspaceV2Path,
    ownerHash: owner.ownerKeyHash,
  });
  if (
    inspectedWorkspaceV2.revision !== workspaceV2.revision ||
    inspectedWorkspaceV2.schemaVersion !== workspaceV2.schemaVersion ||
    inspectedWorkspaceV2.storageSchemaVersion !== workspaceV2.storageSchemaVersion
  )
    throw new PortableArchiveStreamError("PORTABLE_SOURCE_CHANGED");

  const sources = [
    {
      archivePath: "account/workspace.json",
      sourcePath: account.workspace,
      ...workspaceInfo,
    },
    {
      archivePath: "account/workspace-v2.sqlite",
      sourcePath: workspaceV2Path,
      ...workspaceV2Info,
    },
  ];
  const projectionMarker = workspaceProjectionMarker(envelope.workspace);
  if (projectionMarker) {
    // The compact v1 envelope intentionally no longer contains the records
    // that were migrated into SQLite. Preserve the byte-exact migration
    // source as a separate, bounded archive entry so a restore does not turn
    // the compact projection into a false historical source.
    const retainedLegacyInfo = await requireProjectedLegacySource(
      owner,
      projectionMarker,
    );
    sources.push({
      archivePath: "account/legacy-workspace.json",
      sourcePath: workspaceV2Paths.legacyCopyPath,
      ...retainedLegacyInfo,
    });
  }
  const includedObjects = new Set();
  for (const { name, manifest } of await ownerManifests(owner.ownerKeyHash)) {
    if (name !== `${manifest.id}.json`)
      throw new PortableArchiveStreamError("PORTABLE_MANIFEST_INVALID");
    const manifestPath = path.join(dirs.manifests, name);
    const manifestInfo = await hashPortableFile(
      manifestPath,
      PORTABLE_STREAM_LIMITS.assetManifestBytes,
    );
    sources.push({
      archivePath: `manifests/${name}`,
      sourcePath: manifestPath,
      ...manifestInfo,
    });
    if (includedObjects.has(manifest.contentHash)) continue;
    const objectPath = path.join(dirs.objects, manifest.contentHash);
    await requireStoredObjectMatch(objectPath, manifest.contentHash, manifest.size);
    const objectInfo = await hashPortableFile(objectPath, RAW_ASSET_MAX_BYTES);
    if (
      objectInfo.contentHash !== manifest.contentHash ||
      objectInfo.size !== manifest.size
    )
      throw new PortableArchiveStreamError("PORTABLE_OBJECT_INVALID");
    includedObjects.add(manifest.contentHash);
    sources.push({
      archivePath: `objects/${manifest.contentHash}`,
      sourcePath: objectPath,
      ...objectInfo,
    });
  }
  if (sources.length + 1 > PORTABLE_STREAM_LIMITS.entryCount)
    throw new PortableArchiveStreamError("PORTABLE_ENTRY_LIMIT_EXCEEDED");

  const files = sources.map(source => ({
    path: source.archivePath,
    contentHash: source.contentHash,
    size: source.size,
  }));
  const manifest = {
    format: "formdigital-portable-backup",
    schemaVersion: 2,
    id,
    kind,
    scope: "account",
    templateId: null,
    ownerKeyHash: owner.ownerKeyHash,
    createdAt,
    files,
    workspaceV2,
    summary,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
  if (manifestBytes.byteLength > PORTABLE_STREAM_LIMITS.backupManifestBytes)
    throw new PortableArchiveStreamError("PORTABLE_MANIFEST_TOO_LARGE");
  const portableSourceBytes = sources.reduce(
    (total, source) => total + BigInt(source.size),
    BigInt(manifestBytes.byteLength),
  );
  if (portableSourceBytes > BigInt(PORTABLE_STREAM_LIMITS.expandedBytes))
    throw new PortableArchiveStreamError("PORTABLE_EXPANDED_LIMIT_EXCEEDED");
  await enforcePortableBackupCapacity(portableSourceBytes);

  const backupFolder =
    kind.startsWith("pre-") || kind.startsWith("emergency")
      ? path.join(dirs.backups, "emergency")
      : dirs.backups;
  await fs.mkdir(backupFolder, { recursive: true });
  const temporaryPath = path.join(
    backupFolder,
    `.${id}-${crypto.randomUUID()}.formdigital-pending`,
  );
  const finalPath = path.join(backupFolder, `${id}.formdigital-backup`);
  const verificationRoot = path.join(
    dirs.staging,
    `verify-portable-${crypto.randomUUID()}`,
  );
  const backupMetadataFolder = path.join(dirs.metadata, "portable-backups");
  const metadataPath = path.join(backupMetadataFolder, `${id}.json`);
  async function* archiveEntries() {
    yield {
      archivePath: "backup-manifest.json",
      bytes: manifestBytes,
      size: manifestBytes.byteLength,
    };
    for (const source of sources) yield source;
  }
  try {
    const { archiveBytes } = await writePortableStoredZip(
      temporaryPath,
      archiveEntries(),
    );
    const archiveInfo = await hashPortableFile(
      temporaryPath,
      PORTABLE_STREAM_LIMITS.archiveBytes,
    );
    if (archiveInfo.size !== archiveBytes)
      throw new PortableArchiveStreamError("PORTABLE_SOURCE_CHANGED");
    try {
      const extraction = await extractPortableZip(
        temporaryPath,
        verificationRoot,
        {
          singleObjectBytes: RAW_ASSET_MAX_BYTES,
          validateEntryName: isAllowedPortableStreamEntry,
        },
      );
      const verified = await verifyExtractedPortableBackup(
        extraction,
        owner.ownerKeyHash,
      );
      if (verified.manifest.id !== id)
        throw new PortableArchiveStreamError("PORTABLE_MANIFEST_INVALID");
    } finally {
      await fs.rm(verificationRoot, { recursive: true, force: true }).catch(() => {});
    }
    await fs.rename(temporaryPath, finalPath);
    await syncDirectory(backupFolder);
    await fs.mkdir(backupMetadataFolder, { recursive: true });
    await atomicWrite(
      metadataPath,
      Buffer.from(JSON.stringify({
        schemaVersion: 1,
        id,
        ownerKeyHash: owner.ownerKeyHash,
        filename: `${id}.formdigital-backup`,
        archiveBytes,
        archiveHash: archiveInfo.contentHash,
        createdAt,
        emergency: backupFolder !== dirs.backups,
      })),
    );
    await appendJournal("backup.portable.stream.create", {
      id,
      kind,
      ownerKeyHash: owner.ownerKeyHash,
      files: files.length,
      contentHash: archiveInfo.contentHash,
      archiveBytes,
    }).catch(() => {});
    return {
      id,
      createdAt,
      filename: `${id}.formdigital-backup`,
      archiveBytes,
      archiveHash: archiveInfo.contentHash,
      manifest,
    };
  } catch (error) {
    await fs.rm(verificationRoot, { recursive: true, force: true }).catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    await fs.rm(finalPath, { force: true }).catch(() => {});
    await fs.rm(metadataPath, { force: true }).catch(() => {});
    throw error;
  }
}

// Local Data Service emits lowercase SHA-256 values and compares the owner
// hash byte-for-byte during restore. Accepting uppercase here would let an
// archive that the Web preview rejects slip through the local restore gate.
const PORTABLE_HASH_RE = /^[a-f0-9]{64}$/;
const PORTABLE_NAME_RE = /^[A-Za-z0-9_.-]{1,200}$/;

/** Reject unsafe entry paths: absolute, drive, UNC, traversal, backslash,
 *  empty segment, URL scheme or NUL, plus any top-level directory other than
 *  account / manifests / objects. */
function parsePortableEntryPath(rawPath) {
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
function isAllowedPortableFile(p) {
  const parts = p.split("/");
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

function validatePortableFileDescriptor(file) {
  if (!file || typeof file !== "object" || Array.isArray(file))
    throw new Error("Portable Backup file descriptor is invalid.");
  if (typeof file.path !== "string")
    throw new Error("Portable Backup file path is invalid.");
  if (
    typeof file.contentHash !== "string" ||
    !PORTABLE_HASH_RE.test(file.contentHash)
  )
    throw new Error("Portable Backup file hash is invalid.");
  if (
    typeof file.size !== "number" ||
    !Number.isSafeInteger(file.size) ||
    file.size < 0
  )
    throw new Error("Portable Backup file size is invalid.");
}

function validatePortableSummary(summary) {
  if (!summary || typeof summary !== "object" || Array.isArray(summary))
    throw new Error("Portable Backup summary structure is invalid.");
  const s = summary;
  if (!Array.isArray(s.templates))
    throw new Error("Portable Backup summary is missing templates.");
  for (const item of s.templates) {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("Portable Backup template summary item is invalid.");
    const t = item;
    if (typeof t.id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(t.id))
      throw new Error("Portable Backup template summary id is invalid.");
    if (typeof t.name !== "string")
      throw new Error("Portable Backup template summary name is invalid.");
    if (!Number.isSafeInteger(t.versions) || t.versions < 0)
      throw new Error("Portable Backup template summary versions is invalid.");
    if (!Number.isSafeInteger(t.instances) || t.instances < 0)
      throw new Error("Portable Backup template summary instances is invalid.");
  }
  for (const key of [
    "templateCount",
    "versionCount",
    "instanceCount",
    "mappingTemplateCount",
  ]) {
    const v = s[key];
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0)
      throw new Error("Portable Backup summary count is invalid.");
  }
}

function derivePortableSummary(workspace) {
  for (const key of [
    "templates",
    "templateVersions",
    "instances",
    "mappingTemplates",
  ])
    if (!Array.isArray(workspace[key]))
      throw new Error("Portable Backup Workspace preview structure is invalid.");
  const templates = workspace.templates;
  const versions = workspace.templateVersions;
  const instances = workspace.instances;
  const mappings = workspace.mappingTemplates;
  const readRelationId = (item, field) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("Portable Backup Workspace preview structure is invalid.");
    const value = item[field];
    if (typeof value !== "string" || value.length === 0)
      throw new Error("Portable Backup Workspace preview structure is invalid.");
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
      throw new Error("Portable Backup Workspace preview structure is invalid.");
    const template = item;
    if (
      typeof template.id !== "string" ||
      template.id.length === 0
    )
      throw new Error("Portable Backup Workspace preview structure is invalid.");
    if (typeof template.name !== "string")
      throw new Error("Portable Backup Workspace preview structure is invalid.");
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

function isAllowedPortableStreamEntry(entryPath) {
  if (entryPath === "backup-manifest.json") return true;
  if (entryPath === "account/workspace-v2.sqlite") return true;
  if (entryPath === "account/legacy-workspace.json") return true;
  return parsePortableEntryPath(entryPath) && isAllowedPortableFile(entryPath);
}

async function readPortableJsonFile(filePath, maxBytes, code) {
  const stat = await fs.lstat(filePath).catch(() => null);
  if (!stat?.isFile() || stat.size < 1 || stat.size > maxBytes)
    throw new PortableArchiveStreamError(code);
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    throw new PortableArchiveStreamError(code);
  }
}

function canonicalPortableSummary(summary) {
  return {
    templates: (summary.templates ?? []).map(item => ({
      id: item.id,
      name: item.name,
      versions: item.versions,
      instances: item.instances,
    })),
    templateCount: summary.templateCount,
    versionCount: summary.versionCount,
    instanceCount: summary.instanceCount,
    mappingTemplateCount: summary.mappingTemplateCount,
  };
}

async function verifyExtractedPortableBackup(extraction, ownerHash) {
  const manifestEntry = extraction.entries.get("backup-manifest.json");
  if (!manifestEntry)
    throw new PortableArchiveStreamError("PORTABLE_MANIFEST_MISSING");
  const manifest = await readPortableJsonFile(
    manifestEntry.path,
    PORTABLE_STREAM_LIMITS.backupManifestBytes,
    "PORTABLE_MANIFEST_INVALID",
  );
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    manifest.format !== "formdigital-portable-backup" ||
    manifest.schemaVersion !== 2 ||
    manifest.scope !== "account" ||
    (manifest.templateId !== null && manifest.templateId !== undefined) ||
    typeof manifest.id !== "string" ||
    !/^backup-[A-Za-z0-9_-]{1,240}$/.test(manifest.id) ||
    typeof manifest.ownerKeyHash !== "string" ||
    !PORTABLE_HASH_RE.test(manifest.ownerKeyHash) ||
    manifest.ownerKeyHash !== ownerHash ||
    !Array.isArray(manifest.files)
  )
    throw new PortableArchiveStreamError("PORTABLE_MANIFEST_INVALID");
  const validCreatedAt =
    typeof manifest.createdAt === "string" &&
    manifest.createdAt.length > 0 &&
    manifest.createdAt.length <= 64 &&
    Number.isFinite(Date.parse(manifest.createdAt));
  if (!validCreatedAt)
    throw new PortableArchiveStreamError("PORTABLE_MANIFEST_INVALID");
  validatePortableSummary(manifest.summary);

  const declared = new Map();
  for (const file of manifest.files) {
    validatePortableFileDescriptor(file);
    if (
      file.path === "backup-manifest.json" ||
      !isAllowedPortableStreamEntry(file.path) ||
      declared.has(file.path)
    )
      throw new PortableArchiveStreamError("PORTABLE_MANIFEST_INVALID");
    declared.set(file.path, file);
  }
  for (const required of [
    "account/workspace.json",
    "account/workspace-v2.sqlite",
  ])
    if (!declared.has(required))
      throw new PortableArchiveStreamError("PORTABLE_MANIFEST_INVALID");
  if (declared.size + 1 !== extraction.entries.size)
    throw new PortableArchiveStreamError("PORTABLE_ENTRY_SET_MISMATCH");
  for (const [entryPath, entry] of extraction.entries) {
    if (entryPath === "backup-manifest.json") continue;
    const descriptor = declared.get(entryPath);
    if (
      !descriptor ||
      descriptor.size !== entry.size ||
      descriptor.contentHash !== entry.contentHash
    )
      throw new PortableArchiveStreamError("PORTABLE_ENTRY_SET_MISMATCH");
  }

  const workspaceEntry = extraction.entries.get("account/workspace.json");
  const workspaceEnvelope = await readPortableJsonFile(
    workspaceEntry.path,
    PORTABLE_STREAM_LIMITS.workspaceBytes,
    "PORTABLE_WORKSPACE_INVALID",
  );
  if (
    !workspaceEnvelope ||
    typeof workspaceEnvelope !== "object" ||
    Array.isArray(workspaceEnvelope) ||
    !Number.isInteger(workspaceEnvelope.revision) ||
    !workspaceEnvelope.workspace ||
    typeof workspaceEnvelope.workspace !== "object" ||
    Array.isArray(workspaceEnvelope.workspace)
  )
    throw new PortableArchiveStreamError("PORTABLE_WORKSPACE_INVALID");
  if (
    typeof workspaceEnvelope.workspace.ownerKey === "string" &&
    ownerKeyHash(workspaceEnvelope.workspace.ownerKey) !== ownerHash
  )
    throw new PortableArchiveStreamError("PORTABLE_OWNER_MISMATCH");

  const projectionMarker = workspaceProjectionMarker(workspaceEnvelope.workspace);
  if (
    projectionMarker &&
    !hasOnlyEmptyV2AuthoritativeLegacyCollections(workspaceEnvelope.workspace)
  )
    throw new PortableArchiveStreamError("PORTABLE_WORKSPACE_INVALID");
  const retainedLegacyEntry = extraction.entries.get(
    "account/legacy-workspace.json",
  );
  let retainedWorkspace = null;
  if (retainedLegacyEntry) {
    if (!projectionMarker)
      throw new PortableArchiveStreamError("PORTABLE_WORKSPACE_INVALID");
    const retainedDescriptor = declared.get("account/legacy-workspace.json");
    if (retainedDescriptor?.contentHash !== projectionMarker.sourceHash)
      throw new PortableArchiveStreamError("PORTABLE_WORKSPACE_INVALID");
    const retainedEnvelope = await readPortableJsonFile(
      retainedLegacyEntry.path,
      PORTABLE_STREAM_LIMITS.workspaceBytes,
      "PORTABLE_WORKSPACE_INVALID",
    );
    if (
      !retainedEnvelope ||
      typeof retainedEnvelope !== "object" ||
      Array.isArray(retainedEnvelope) ||
      retainedEnvelope.revision !== projectionMarker.sourceRevision ||
      !retainedEnvelope.workspace ||
      typeof retainedEnvelope.workspace !== "object" ||
      Array.isArray(retainedEnvelope.workspace) ||
      (typeof retainedEnvelope.workspace.ownerKey === "string" &&
        ownerKeyHash(retainedEnvelope.workspace.ownerKey) !== ownerHash)
    )
      throw new PortableArchiveStreamError("PORTABLE_WORKSPACE_INVALID");
    retainedWorkspace = retainedEnvelope.workspace;
  }

  const workspaceV2Entry = extraction.entries.get("account/workspace-v2.sqlite");
  const inspected = inspectWorkspaceStorageV2File({
    databasePath: workspaceV2Entry.path,
    ownerHash,
  });
  if (
    !manifest.workspaceV2 ||
    typeof manifest.workspaceV2 !== "object" ||
    inspected.storageSchemaVersion !== manifest.workspaceV2.storageSchemaVersion ||
    inspected.schemaVersion !== manifest.workspaceV2.schemaVersion ||
    inspected.revision !== manifest.workspaceV2.revision
  )
    throw new PortableArchiveStreamError("PORTABLE_WORKSPACE_V2_INVALID");

  const archiveManifests = new Map();
  const referencedObjectPaths = new Set();
  for (const [entryPath, entry] of extraction.entries) {
    if (!entryPath.startsWith("manifests/")) continue;
    const assetManifest = await readPortableJsonFile(
      entry.path,
      PORTABLE_STREAM_LIMITS.assetManifestBytes,
      "PORTABLE_ASSET_MANIFEST_INVALID",
    );
    if (
      !isStoredManifestRecord(assetManifest) ||
      assetManifest.schemaVersion !== 1 ||
      assetManifest.ownerKeyHash !== ownerHash ||
      entryPath !== `manifests/${assetManifest.id}.json` ||
      !Number.isSafeInteger(assetManifest.size) ||
      assetManifest.size < 0
    )
      throw new PortableArchiveStreamError("PORTABLE_ASSET_MANIFEST_INVALID");
    const objectPath = `objects/${assetManifest.contentHash}`;
    const objectEntry = extraction.entries.get(objectPath);
    if (
      !objectEntry ||
      objectEntry.size !== assetManifest.size ||
      objectEntry.contentHash !== assetManifest.contentHash
    )
      throw new PortableArchiveStreamError("PORTABLE_OBJECT_INVALID");
    archiveManifests.set(assetManifest.id, assetManifest);
    referencedObjectPaths.add(objectPath);
  }
  for (const entryPath of extraction.entries.keys())
    if (entryPath.startsWith("objects/") && !referencedObjectPaths.has(entryPath))
      throw new PortableArchiveStreamError("PORTABLE_OBJECT_UNREFERENCED");

  const legacyForReferences = {
    ...workspaceEnvelope.workspace,
    instances: [],
    importRuns: [],
  };
  for (const reference of workspaceAssetReferences(legacyForReferences))
    if (!archiveManifests.has(reference.assetId))
      throw new PortableArchiveStreamError("PORTABLE_WORKSPACE_ASSET_MISSING");
  const candidateStorage = WorkspaceStorageV2.openFileReadOnly({
    databasePath: workspaceV2Entry.path,
    ownerHash,
  });
  try {
    candidateStorage.integrityCheck();
    // A schema-v2 archive must describe one coherent generation before it is
    // allowed to create a restore session. For projected archives the compact
    // v1 arrays are intentionally empty, so compare SQLite with the retained
    // migration source when present. Older archives without a marker carry
    // their authoritative records directly in workspace.json.
    const parityWorkspace = projectionMarker
      ? retainedWorkspace
      : workspaceEnvelope.workspace;
    if (
      parityWorkspace &&
      !(await v2AuthoritativeCollectionsMatchStorage(
        parityWorkspace,
        candidateStorage,
      ))
    )
      throw new PortableArchiveStreamError("PORTABLE_WORKSPACE_V2_INVALID");
    for await (const reference of workspaceV2AssetReferencesFromStorage(
      candidateStorage,
      workspaceEnvelope.workspace,
    ))
      if (!archiveManifests.has(reference.assetId))
        throw new PortableArchiveStreamError("PORTABLE_WORKSPACE_ASSET_MISSING");
    const derivedSummary = await deriveWorkspaceV2PortableSummary(
      candidateStorage,
      workspaceEnvelope.workspace,
    );
    if (
      JSON.stringify(canonicalPortableSummary(manifest.summary)) !==
      JSON.stringify(canonicalPortableSummary(derivedSummary))
    )
      throw new PortableArchiveStreamError("PORTABLE_SUMMARY_INVALID");
  } finally {
    candidateStorage.close();
  }
  return Object.freeze({ manifest, workspaceEnvelope, extraction });
}

const PORTABLE_SESSION_TTL_MS = 30 * 60 * 1000;
const PORTABLE_MAX_SESSIONS = 4;
const PORTABLE_MAX_CONCURRENT_UPLOADS = 2;
const PORTABLE_MAX_STAGED_ARCHIVE_BYTES = 3 * 1024 * 1024 * 1024;
const PORTABLE_DISK_RESERVE_BYTES = 512 * 1024 * 1024;
let activePortableSessionUploads = 0;
const PORTABLE_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function portableAvailableBytes(folder) {
  try {
    const stat = await fs.statfs(folder, { bigint: true });
    return stat.bavail * stat.bsize;
  } catch {
    throw new PortableArchiveStreamError("PORTABLE_SPACE_CHECK_FAILED");
  }
}

async function enforcePortableBackupCapacity(sourceBytes) {
  const availableBytes = await portableAvailableBytes(root);
  // At peak, backup creation holds the stored archive and its complete
  // verification extraction at the same time. Keep a fixed reserve for the
  // live Workspace, SQLite journals and unrelated operating-system writes.
  const requiredBytes =
    sourceBytes * 2n + BigInt(PORTABLE_DISK_RESERVE_BYTES);
  if (availableBytes < requiredBytes)
    throw new PortableArchiveStreamError("PORTABLE_SPACE_INSUFFICIENT");
}

function portableSessionRoot(sessionId) {
  if (!PORTABLE_SESSION_ID_RE.test(String(sessionId)))
    throw new PortableArchiveStreamError("PORTABLE_SESSION_INVALID");
  return path.join(dirs.staging, `portable-session-${sessionId}`);
}

function portableDeclaredArchiveBytes(request) {
  const raw = request.headers["content-length"];
  if (raw === undefined) return null;
  const declared = Number(raw);
  if (
    !Number.isSafeInteger(declared) ||
    declared < 1 ||
    declared > PORTABLE_STREAM_LIMITS.archiveBytes
  )
    throw new PortableArchiveStreamError("PORTABLE_ARCHIVE_TOO_LARGE");
  return declared;
}

async function enforcePortableSessionCapacity(request) {
  const declared = portableDeclaredArchiveBytes(request);
  const entries = await fs.readdir(dirs.staging, { withFileTypes: true });
  const sessions = entries.filter(
    entry =>
      entry.isDirectory() &&
      /^portable-session-[0-9a-f-]{36}$/i.test(entry.name),
  );
  if (sessions.length >= PORTABLE_MAX_SESSIONS)
    throw new PortableArchiveStreamError("PORTABLE_SESSION_LIMIT_REACHED");
  let stagedArchiveBytes = 0;
  for (const entry of sessions) {
    const stat = await fs.lstat(
      path.join(dirs.staging, entry.name, "archive.formdigital-backup"),
    ).catch(() => null);
    if (stat?.isFile()) stagedArchiveBytes += stat.size;
  }
  const incomingBytes = declared ?? PORTABLE_STREAM_LIMITS.archiveBytes;
  if (
    stagedArchiveBytes + incomingBytes >
    PORTABLE_MAX_STAGED_ARCHIVE_BYTES
  )
    throw new PortableArchiveStreamError("PORTABLE_STAGING_LIMIT_REACHED");
  const availableBytes = await portableAvailableBytes(dirs.staging);
  const requiredBytes =
    BigInt(incomingBytes) * 5n + BigInt(PORTABLE_DISK_RESERVE_BYTES);
  if (availableBytes < requiredBytes)
    throw new PortableArchiveStreamError("PORTABLE_SPACE_INSUFFICIENT");
}

async function writeRawPortableArchive(request, target) {
  const declared = portableDeclaredArchiveBytes(request);
  let size = 0;
  await pipeline(
    request,
    new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length;
        if (size > PORTABLE_STREAM_LIMITS.archiveBytes)
          callback(new PortableArchiveStreamError("PORTABLE_ARCHIVE_TOO_LARGE"));
        else callback(null, chunk);
      },
    }),
    createWriteStream(target, { flags: "wx" }),
  );
  if (size < 1)
    throw new PortableArchiveStreamError("PORTABLE_ARCHIVE_INVALID");
  if (declared !== null && declared !== size)
    throw new PortableArchiveStreamError("PORTABLE_ARCHIVE_INVALID");
  const durableHandle = await fs.open(target, "r+");
  try {
    await durableHandle.sync();
  } finally {
    await durableHandle.close();
  }
  return size;
}

async function createPortableRestoreSessionInSlot(owner, request) {
  const sessionId = crypto.randomUUID();
  const sessionRoot = portableSessionRoot(sessionId);
  await fs.mkdir(sessionRoot);
  const archivePath = path.join(sessionRoot, "archive.formdigital-backup");
  const extractedRoot = path.join(sessionRoot, "extracted");
  try {
    const archiveBytes = await writeRawPortableArchive(request, archivePath);
    const extraction = await extractPortableZip(archivePath, extractedRoot, {
      singleObjectBytes: RAW_ASSET_MAX_BYTES,
      validateEntryName: isAllowedPortableStreamEntry,
    });
    const verified = await verifyExtractedPortableBackup(
      extraction,
      owner.ownerKeyHash,
    );
    const createdAt = now();
    const expiresAt = new Date(Date.now() + PORTABLE_SESSION_TTL_MS).toISOString();
    await atomicWrite(
      path.join(sessionRoot, "session.json"),
      Buffer.from(JSON.stringify({
        schemaVersion: 1,
        sessionId,
        ownerKeyHash: owner.ownerKeyHash,
        sourceBackupId: verified.manifest.id,
        createdAt,
        expiresAt,
        state: "verified",
      })),
    );
    return {
      sessionId,
      archiveBytes,
      expiresAt,
      manifest: {
        id: verified.manifest.id,
        schemaVersion: verified.manifest.schemaVersion,
        scope: verified.manifest.scope,
        templateId: verified.manifest.templateId,
        createdAt: verified.manifest.createdAt,
        summary: verified.manifest.summary,
      },
    };
  } catch (error) {
    await fs.rm(sessionRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function createPortableRestoreSession(owner, request) {
  if (activePortableSessionUploads >= PORTABLE_MAX_CONCURRENT_UPLOADS)
    throw new PortableArchiveStreamError("PORTABLE_UPLOAD_LIMIT_REACHED");
  activePortableSessionUploads += 1;
  try {
    await cleanupExpiredPortableSessions();
    await enforcePortableSessionCapacity(request);
    return await createPortableRestoreSessionInSlot(owner, request);
  } finally {
    activePortableSessionUploads -= 1;
  }
}

async function loadPortableRestoreSession(ownerHash, sessionId) {
  const sessionRoot = portableSessionRoot(sessionId);
  let descriptor;
  try {
    descriptor = JSON.parse(
      await fs.readFile(path.join(sessionRoot, "session.json"), "utf8"),
    );
  } catch {
    throw new PortableArchiveStreamError("PORTABLE_SESSION_INVALID");
  }
  if (
    descriptor?.schemaVersion !== 1 ||
    descriptor?.sessionId !== sessionId ||
    descriptor?.ownerKeyHash !== ownerHash ||
    descriptor?.state !== "verified" ||
    typeof descriptor?.sourceBackupId !== "string" ||
    !/^backup-[A-Za-z0-9_-]{1,240}$/.test(descriptor.sourceBackupId) ||
    !Number.isFinite(Date.parse(descriptor?.expiresAt)) ||
    Date.parse(descriptor.expiresAt) <= Date.now()
  )
    throw new PortableArchiveStreamError("PORTABLE_SESSION_INVALID");
  return { sessionRoot, descriptor };
}

async function deletePortableRestoreSession(ownerHash, sessionId) {
  const { sessionRoot } = await loadPortableRestoreSession(ownerHash, sessionId);
  await fs.rm(sessionRoot, { recursive: true, force: true });
  return { deleted: true };
}

async function cleanupExpiredPortableSessions() {
  const entries = await fs.readdir(dirs.staging, { withFileTypes: true }).catch(() => []);
  const currentTime = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^portable-session-[0-9a-f-]{36}$/i.test(entry.name))
      continue;
    const sessionRoot = path.join(dirs.staging, entry.name);
    let expired = false;
    try {
      const descriptor = JSON.parse(
        await fs.readFile(path.join(sessionRoot, "session.json"), "utf8"),
      );
      expired =
        !Number.isFinite(Date.parse(descriptor?.expiresAt)) ||
        Date.parse(descriptor.expiresAt) <= currentTime;
    } catch {
      const stat = await fs.lstat(sessionRoot).catch(() => null);
      expired = !!stat && currentTime - stat.mtimeMs > PORTABLE_SESSION_TTL_MS;
    }
    if (expired)
      await fs.rm(sessionRoot, { recursive: true, force: true }).catch(() => {});
  }
}

const PORTABLE_RESTORE_DESCRIPTOR_RE =
  /^\.formdigital-portable-restore-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/i;
const PORTABLE_RESTORE_TEST_POINTS = new Set([
  "after_descriptor_swapping",
  "after_first_object",
  "after_manifests",
  "after_workspace",
  "after_workspace_v2",
  "after_descriptor_committed",
]);

async function pauseAtPortableRestoreTestPoint(point) {
  if (
    process.env.FORMDIGITAL_ENABLE_TEST_HOOKS !== "1" ||
    process.env.FORMDIGITAL_TEST_PORTABLE_RESTORE_PAUSE_AT !== point ||
    !PORTABLE_RESTORE_TEST_POINTS.has(point)
  )
    return;
  const marker = path.join(
    dirs.staging,
    ".formdigital-portable-restore-test-checkpoint",
  );
  const handle = await fs.open(marker, "wx");
  try {
    await handle.writeFile(point);
    await handle.sync();
  } finally {
    await handle.close();
  }
  // Test-only deliberate suspension. The parent regression process terminates
  // this child to simulate an abrupt power/process loss at a durable boundary.
  await new Promise(() => {});
}

function portableRestorePaths(transactionId) {
  if (!PORTABLE_SESSION_ID_RE.test(String(transactionId)))
    throw new PortableArchiveStreamError("PORTABLE_TRANSACTION_INVALID");
  return {
    descriptor: path.join(
      dirs.staging,
      `.formdigital-portable-restore-${transactionId}.json`,
    ),
    transactionRoot: path.join(dirs.staging, `restore-portable-${transactionId}`),
  };
}

async function writePortableRestoreDescriptor(transactionId, descriptor) {
  const paths = portableRestorePaths(transactionId);
  await atomicWrite(
    paths.descriptor,
    Buffer.from(JSON.stringify({
      schemaVersion: 1,
      transactionId,
      ...descriptor,
    })),
  );
  return paths;
}

function validatePortableRestoreState(state, ownerHash) {
  const validFile = item =>
    item &&
    typeof item === "object" &&
    Number.isSafeInteger(item.size) &&
    item.size >= 0 &&
    typeof item.contentHash === "string" &&
    PORTABLE_HASH_RE.test(item.contentHash);
  const validManifest = item =>
    validFile(item) &&
    typeof item.name === "string" &&
    /^asset-[\w-]+\.json$/.test(item.name);
  const validSafetyBackup = item =>
    validFile(item) &&
    typeof item.id === "string" &&
    /^backup-[A-Za-z0-9_-]{1,240}$/.test(item.id) &&
    typeof item.createdArchive === "boolean" &&
    typeof item.createdMetadata === "boolean";
  const previousLegacyWorkspace = state?.previousLegacyWorkspace ?? null;
  if (
    !state ||
    typeof state !== "object" ||
    state.schemaVersion !== 1 ||
    state.ownerKeyHash !== ownerHash ||
    typeof state.workspaceExisted !== "boolean" ||
    typeof state.workspaceV2Existed !== "boolean" ||
    !Array.isArray(state.previousManifests) ||
    !state.previousManifests.every(validManifest) ||
    !Array.isArray(state.incomingManifests) ||
    !state.incomingManifests.every(validManifest) ||
    !validFile(state.newWorkspace) ||
    !validFile(state.newWorkspaceV2) ||
    !validFile(state.newLegacyWorkspace) ||
    !validSafetyBackup(state.restoredSafetyBackup) ||
    (state.workspaceExisted
      ? !validFile(state.previousWorkspace)
      : state.previousWorkspace !== null) ||
    (state.previousWorkspaceV2 !== null &&
      !validFile(state.previousWorkspaceV2)) ||
    (previousLegacyWorkspace !== null &&
      !validFile(previousLegacyWorkspace)) ||
    (!state.workspaceV2Existed &&
      (state.previousWorkspaceV2 !== null || previousLegacyWorkspace !== null))
  )
    throw new PortableArchiveStreamError("PORTABLE_TRANSACTION_INVALID");
  return { ...state, previousLegacyWorkspace };
}

async function readPortableRestoreState(transactionRoot, ownerHash) {
  const state = await readPortableJsonFile(
    path.join(transactionRoot, "rollback", "state.json"),
    16 * 1024 * 1024,
    "PORTABLE_TRANSACTION_INVALID",
  );
  return validatePortableRestoreState(state, ownerHash);
}

async function cleanupRestoredSafetyBackup(restoredSafetyBackup) {
  if (!restoredSafetyBackup) return;
  if (restoredSafetyBackup.createdArchive)
    await fs.rm(
      path.join(
        dirs.backups,
        "emergency",
        `${restoredSafetyBackup.id}.formdigital-backup`,
      ),
      { force: true },
    ).catch(() => {});
  if (restoredSafetyBackup.createdMetadata)
    await fs.rm(
      path.join(
        dirs.metadata,
        "portable-backups",
        `${restoredSafetyBackup.id}.json`,
      ),
      { force: true },
    ).catch(() => {});
}

async function restorePortableRollback(transactionId, descriptor) {
  const { descriptor: descriptorPath, transactionRoot } =
    portableRestorePaths(transactionId);
  const rollbackRoot = path.join(transactionRoot, "rollback");
  const state = await readPortableRestoreState(
    transactionRoot,
    descriptor.ownerKeyHash,
  );
  const account = accountPaths(descriptor.ownerKeyHash);
  if (state.workspaceExisted)
    await atomicCopyPortableFile(
      path.join(rollbackRoot, "workspace.json"),
      account.workspace,
      state.previousWorkspace,
    );
  else await fs.rm(account.workspace, { force: true });

  const previousNames = new Set(state.previousManifests.map(item => item.name));
  const incomingNames = new Set(state.incomingManifests.map(item => item.name));
  for (const name of await fs.readdir(dirs.manifests).catch(() => [])) {
    if (!name.endsWith(".json")) continue;
    let belongsToOwner = false;
    try {
      const manifest = JSON.parse(
        await fs.readFile(path.join(dirs.manifests, name), "utf8"),
      );
      belongsToOwner = manifest?.ownerKeyHash === descriptor.ownerKeyHash;
    } catch {}
    if (belongsToOwner || (incomingNames.has(name) && !previousNames.has(name)))
      await fs.rm(path.join(dirs.manifests, name), { force: true });
  }
  for (const item of state.previousManifests)
    await atomicCopyPortableFile(
      path.join(rollbackRoot, "manifests", item.name),
      path.join(dirs.manifests, item.name),
      item,
    );

  const liveV2 = path.join(dirs["workspace-v2"], descriptor.ownerKeyHash);
  await fs.rm(liveV2, { recursive: true, force: true });
  if (state.workspaceV2Existed) {
    const temporaryV2 = `${liveV2}.recovery-${crypto.randomUUID()}`;
    await fs.cp(path.join(rollbackRoot, "workspace-v2"), temporaryV2, {
      recursive: true,
      errorOnExist: true,
    });
    await fs.rename(temporaryV2, liveV2);
    await syncDirectory(dirs["workspace-v2"]);
    if (state.previousWorkspaceV2)
      await hashPortableFile(
        path.join(liveV2, "workspace-v2.sqlite"),
        PORTABLE_STREAM_LIMITS.workspaceV2Bytes,
      ).then(info => {
        if (
          info.size !== state.previousWorkspaceV2.size ||
          info.contentHash !== state.previousWorkspaceV2.contentHash
        )
          throw new PortableArchiveStreamError("PORTABLE_ROLLBACK_FAILED");
      });
    if (state.previousLegacyWorkspace)
      await hashPortableFile(
        path.join(liveV2, "legacy-workspace.json"),
        PORTABLE_STREAM_LIMITS.workspaceBytes,
      ).then(info => {
        if (
          info.size !== state.previousLegacyWorkspace.size ||
          info.contentHash !== state.previousLegacyWorkspace.contentHash
        )
          throw new PortableArchiveStreamError("PORTABLE_ROLLBACK_FAILED");
      });
  }
  await cleanupRestoredSafetyBackup(state.restoredSafetyBackup);
  await fs.rm(transactionRoot, { recursive: true, force: true });
  await fs.rm(descriptorPath, { force: true });
  await syncDirectory(dirs.staging);
}

async function recoverPortableRestoreTransactions() {
  const entries = await fs.readdir(dirs.staging).catch(() => []);
  for (const name of entries) {
    const match = PORTABLE_RESTORE_DESCRIPTOR_RE.exec(name);
    if (!match) continue;
    const transactionId = match[1];
    const { descriptor: descriptorPath, transactionRoot } =
      portableRestorePaths(transactionId);
    let descriptor;
    try {
      descriptor = JSON.parse(await fs.readFile(descriptorPath, "utf8"));
    } catch {
      throw new Error("Portable restore recovery descriptor is invalid.");
    }
    if (
      descriptor?.schemaVersion !== 1 ||
      descriptor?.transactionId !== transactionId ||
      !PORTABLE_HASH_RE.test(String(descriptor?.ownerKeyHash ?? "")) ||
      (descriptor?.sessionId !== undefined &&
        !PORTABLE_SESSION_ID_RE.test(String(descriptor.sessionId))) ||
      !["prepared", "swapping", "committed"].includes(descriptor?.phase)
    )
      throw new Error("Portable restore recovery descriptor is invalid.");
    if (descriptor.phase === "prepared") {
      const state = await readPortableRestoreState(
        transactionRoot,
        descriptor.ownerKeyHash,
      );
      await cleanupRestoredSafetyBackup(state.restoredSafetyBackup);
      await fs.rm(transactionRoot, { recursive: true, force: true });
      await fs.rm(descriptorPath, { force: true });
      continue;
    }
    if (descriptor.phase === "swapping") {
      await restorePortableRollback(transactionId, descriptor);
      continue;
    }
    const state = await readPortableRestoreState(
      transactionRoot,
      descriptor.ownerKeyHash,
    );
    const account = accountPaths(descriptor.ownerKeyHash);
    const workspaceInfo = await hashPortableFile(
      account.workspace,
      PORTABLE_STREAM_LIMITS.workspaceBytes,
    );
    const liveV2Path = path.join(
      dirs["workspace-v2"],
      descriptor.ownerKeyHash,
      "workspace-v2.sqlite",
    );
    const workspaceV2Info = await hashPortableFile(
      liveV2Path,
      PORTABLE_STREAM_LIMITS.workspaceV2Bytes,
    );
    const legacyWorkspaceInfo = await hashPortableFile(
      path.join(
        dirs["workspace-v2"],
        descriptor.ownerKeyHash,
        "legacy-workspace.json",
      ),
      PORTABLE_STREAM_LIMITS.workspaceBytes,
    );
    const restoredSafetyBackupInfo = await hashPortableFile(
      path.join(
        dirs.backups,
        "emergency",
        `${state.restoredSafetyBackup.id}.formdigital-backup`,
      ),
      PORTABLE_STREAM_LIMITS.archiveBytes,
    );
    if (
      workspaceInfo.size !== state.newWorkspace.size ||
      workspaceInfo.contentHash !== state.newWorkspace.contentHash ||
      workspaceV2Info.size !== state.newWorkspaceV2.size ||
      workspaceV2Info.contentHash !== state.newWorkspaceV2.contentHash ||
      legacyWorkspaceInfo.size !== state.newLegacyWorkspace.size ||
      legacyWorkspaceInfo.contentHash !== state.newLegacyWorkspace.contentHash ||
      restoredSafetyBackupInfo.size !== state.restoredSafetyBackup.size ||
      restoredSafetyBackupInfo.contentHash !==
        state.restoredSafetyBackup.contentHash
    )
      throw new Error("Committed Portable restore generation is incomplete.");
    const incomingNames = new Set(state.incomingManifests.map(item => item.name));
    const committedNames = await ownerManifestNameSet(descriptor.ownerKeyHash);
    if (
      incomingNames.size !== committedNames.size ||
      [...incomingNames].some(name => !committedNames.has(name))
    )
      throw new Error("Committed Portable restore generation is incomplete.");
    for (const item of state.incomingManifests) {
      const manifestPath = path.join(dirs.manifests, item.name);
      const manifestInfo = await hashPortableFile(
        manifestPath,
        PORTABLE_STREAM_LIMITS.assetManifestBytes,
      );
      if (
        manifestInfo.size !== item.size ||
        manifestInfo.contentHash !== item.contentHash
      )
        throw new Error("Committed Portable restore generation is incomplete.");
      let manifest;
      try {
        manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      } catch {
        throw new Error("Committed Portable restore generation is incomplete.");
      }
      if (
        manifest?.ownerKeyHash !== descriptor.ownerKeyHash ||
        !PORTABLE_HASH_RE.test(String(manifest?.contentHash ?? "")) ||
        !Number.isSafeInteger(manifest?.size) ||
        manifest.size < 0
      )
        throw new Error("Committed Portable restore generation is incomplete.");
      await requireStoredObjectMatch(
        path.join(dirs.objects, manifest.contentHash),
        manifest.contentHash,
        manifest.size,
      );
    }
    await fs.rm(transactionRoot, { recursive: true, force: true });
    await fs.rm(descriptorPath, { force: true });
    if (descriptor.sessionId)
      await fs.rm(portableSessionRoot(descriptor.sessionId), {
        recursive: true,
        force: true,
      });
  }
  await syncDirectory(dirs.staging);
}

async function snapshotPortableRollback(
  transactionRoot,
  ownerHash,
  incomingManifests,
  newWorkspace,
  newWorkspaceV2,
  newLegacyWorkspace,
  restoredSafetyBackup,
) {
  const rollbackRoot = path.join(transactionRoot, "rollback");
  const rollbackManifests = path.join(rollbackRoot, "manifests");
  await fs.mkdir(rollbackManifests, { recursive: true });
  const account = accountPaths(ownerHash);
  const workspaceStat = await fs.lstat(account.workspace).catch(() => null);
  let previousWorkspace = null;
  if (workspaceStat?.isFile()) {
    previousWorkspace = await hashPortableFile(
      account.workspace,
      PORTABLE_STREAM_LIMITS.workspaceBytes,
    );
    await atomicCopyPortableFile(
      account.workspace,
      path.join(rollbackRoot, "workspace.json"),
      previousWorkspace,
    );
  }

  const previousManifests = [];
  for (const { name } of await ownerManifests(ownerHash)) {
    const source = path.join(dirs.manifests, name);
    const info = await hashPortableFile(
      source,
      PORTABLE_STREAM_LIMITS.assetManifestBytes,
    );
    await atomicCopyPortableFile(
      source,
      path.join(rollbackManifests, name),
      info,
    );
    previousManifests.push({ name, ...info });
  }

  const liveV2 = path.join(dirs["workspace-v2"], ownerHash);
  const liveV2Database = path.join(liveV2, "workspace-v2.sqlite");
  const liveV2Legacy = path.join(liveV2, "legacy-workspace.json");
  const liveV2DirectoryStat = await fs.lstat(liveV2).catch(error =>
    isErrnoCode(error, "ENOENT") ? null : Promise.reject(error),
  );
  if (liveV2DirectoryStat && !liveV2DirectoryStat.isDirectory())
    throw new PortableArchiveStreamError("PORTABLE_ROLLBACK_FAILED");
  const liveV2Stat = await fs.lstat(liveV2Database).catch(() => null);
  let previousWorkspaceV2 = null;
  let previousLegacyWorkspace = null;
  if (liveV2Stat && !liveV2Stat.isFile())
    throw new PortableArchiveStreamError("PORTABLE_ROLLBACK_FAILED");
  if (liveV2Stat?.isFile())
    previousWorkspaceV2 = await hashPortableFile(
      liveV2Database,
      PORTABLE_STREAM_LIMITS.workspaceV2Bytes,
    );
  const liveV2LegacyStat = await fs.lstat(liveV2Legacy).catch(() => null);
  if (liveV2LegacyStat && !liveV2LegacyStat.isFile())
    throw new PortableArchiveStreamError("PORTABLE_ROLLBACK_FAILED");
  if (liveV2LegacyStat?.isFile())
    previousLegacyWorkspace = await hashPortableFile(
      liveV2Legacy,
      PORTABLE_STREAM_LIMITS.workspaceBytes,
    );
  if (liveV2DirectoryStat) {
    await fs.cp(liveV2, path.join(rollbackRoot, "workspace-v2"), {
      recursive: true,
      errorOnExist: true,
    });
    if (previousWorkspaceV2) {
      const copied = await hashPortableFile(
        path.join(rollbackRoot, "workspace-v2", "workspace-v2.sqlite"),
        PORTABLE_STREAM_LIMITS.workspaceV2Bytes,
      );
      if (
        copied.size !== previousWorkspaceV2.size ||
        copied.contentHash !== previousWorkspaceV2.contentHash
      )
        throw new PortableArchiveStreamError("PORTABLE_ROLLBACK_FAILED");
    }
    if (previousLegacyWorkspace) {
      const copied = await hashPortableFile(
        path.join(rollbackRoot, "workspace-v2", "legacy-workspace.json"),
        PORTABLE_STREAM_LIMITS.workspaceBytes,
      );
      if (
        copied.size !== previousLegacyWorkspace.size ||
        copied.contentHash !== previousLegacyWorkspace.contentHash
      )
        throw new PortableArchiveStreamError("PORTABLE_ROLLBACK_FAILED");
    }
  }
  const state = {
    schemaVersion: 1,
    ownerKeyHash: ownerHash,
    workspaceExisted: !!workspaceStat?.isFile(),
    previousWorkspace,
    workspaceV2Existed: !!liveV2DirectoryStat,
    previousWorkspaceV2,
    previousLegacyWorkspace,
    previousManifests,
    incomingManifests,
    newWorkspace,
    newWorkspaceV2,
    newLegacyWorkspace,
    restoredSafetyBackup,
  };
  await atomicWrite(
    path.join(rollbackRoot, "state.json"),
    Buffer.from(JSON.stringify(state)),
  );
  return state;
}

async function preservePortableRestoreSource(owner, sessionRoot, manifest) {
  const sourcePath = path.join(sessionRoot, "archive.formdigital-backup");
  const archiveInfo = await hashPortableFile(
    sourcePath,
    PORTABLE_STREAM_LIMITS.archiveBytes,
  );
  const emergencyFolder = path.join(dirs.backups, "emergency");
  const finalPath = path.join(
    emergencyFolder,
    `${manifest.id}.formdigital-backup`,
  );
  const metadataFolder = path.join(dirs.metadata, "portable-backups");
  const metadataPath = path.join(metadataFolder, `${manifest.id}.json`);
  const existingArchive = await fs.lstat(finalPath).catch(error =>
    isErrnoCode(error, "ENOENT") ? null : Promise.reject(error),
  );
  if (existingArchive) {
    if (!existingArchive.isFile())
      throw new PortableArchiveStreamError("PORTABLE_BACKUP_COLLISION");
    const existingInfo = await hashPortableFile(
      finalPath,
      PORTABLE_STREAM_LIMITS.archiveBytes,
    );
    if (
      existingInfo.size !== archiveInfo.size ||
      existingInfo.contentHash !== archiveInfo.contentHash
    )
      throw new PortableArchiveStreamError("PORTABLE_BACKUP_COLLISION");
  }
  const existingMetadata = await fs.lstat(metadataPath).catch(error =>
    isErrnoCode(error, "ENOENT") ? null : Promise.reject(error),
  );
  if (existingMetadata) {
    const metadata = await readPortableJsonFile(
      metadataPath,
      64 * 1024,
      "PORTABLE_BACKUP_COLLISION",
    );
    if (
      metadata?.schemaVersion !== 1 ||
      metadata.id !== manifest.id ||
      metadata.ownerKeyHash !== owner.ownerKeyHash ||
      metadata.archiveBytes !== archiveInfo.size ||
      metadata.archiveHash !== archiveInfo.contentHash ||
      typeof metadata.emergency !== "boolean"
    )
      throw new PortableArchiveStreamError("PORTABLE_BACKUP_COLLISION");
  }
  let createdArchive = false;
  let createdMetadata = false;
  try {
    await fs.mkdir(emergencyFolder, { recursive: true });
    if (!existingArchive) {
      await atomicCopyPortableFile(sourcePath, finalPath, archiveInfo);
      createdArchive = true;
    }
    await fs.mkdir(metadataFolder, { recursive: true });
    if (!existingMetadata) {
      await atomicWrite(
        metadataPath,
        Buffer.from(JSON.stringify({
          schemaVersion: 1,
          id: manifest.id,
          ownerKeyHash: owner.ownerKeyHash,
          filename: `${manifest.id}.formdigital-backup`,
          archiveBytes: archiveInfo.size,
          archiveHash: archiveInfo.contentHash,
          createdAt: manifest.createdAt,
          emergency: true,
        })),
      );
      createdMetadata = true;
    }
  } catch (error) {
    await cleanupRestoredSafetyBackup({
      id: manifest.id,
      createdArchive,
      createdMetadata,
    });
    throw error;
  }
  return Object.freeze({
    id: manifest.id,
    size: archiveInfo.size,
    contentHash: archiveInfo.contentHash,
    createdArchive,
    createdMetadata,
  });
}

async function preparePortableRestoreWorkspace(
  verified,
  extraction,
  declared,
  transactionRoot,
) {
  const archivedWorkspace = declared.get("account/workspace.json");
  const archivedWorkspacePath = extraction.entries.get(
    "account/workspace.json",
  ).path;
  const marker = workspaceProjectionMarker(verified.workspaceEnvelope.workspace);
  const retainedDescriptor = declared.get("account/legacy-workspace.json");
  const retainedEntry = extraction.entries.get("account/legacy-workspace.json");
  let workspacePath = archivedWorkspacePath;
  let workspaceInfo = archivedWorkspace;
  let legacyWorkspacePath = retainedEntry?.path ?? archivedWorkspacePath;
  let legacyWorkspaceInfo = retainedDescriptor ?? archivedWorkspace;

  if (marker) {
    // New archives carry the byte-exact retained migration source. Older
    // projected schema-v2 archives did not; rebase those to their compact
    // envelope so the restored marker describes bytes that actually exist.
    const installedMarker = {
      ...marker,
      ...(retainedEntry
        ? {}
        : {
            sourceRevision: verified.workspaceEnvelope.revision,
            sourceHash: archivedWorkspace.contentHash,
          }),
      safetyBackupId: verified.manifest.id,
    };
    const installedEnvelope = {
      ...verified.workspaceEnvelope,
      workspace: {
        ...verified.workspaceEnvelope.workspace,
        preferences: {
          ...verified.workspaceEnvelope.workspace.preferences,
          [LEGACY_WORKSPACE_PROJECTION_KEY]: installedMarker,
        },
      },
    };
    const installedBytes = Buffer.from(JSON.stringify(installedEnvelope, null, 2));
    if (installedBytes.byteLength > PORTABLE_STREAM_LIMITS.workspaceBytes)
      throw new PortableArchiveStreamError("PORTABLE_WORKSPACE_INVALID");
    workspacePath = path.join(transactionRoot, "prepared-workspace.json");
    await atomicWrite(workspacePath, installedBytes);
    workspaceInfo = await hashPortableFile(
      workspacePath,
      PORTABLE_STREAM_LIMITS.workspaceBytes,
    );
  }
  return Object.freeze({
    workspacePath,
    workspaceInfo,
    legacyWorkspacePath,
    legacyWorkspaceInfo,
  });
}

async function restoreStreamingPortableBackup(owner, sessionId) {
  const { sessionRoot, descriptor: session } = await loadPortableRestoreSession(
    owner.ownerKeyHash,
    sessionId,
  );
  const transactionId = crypto.randomUUID();
  const { descriptor: descriptorPath, transactionRoot } =
    portableRestorePaths(transactionId);
  await fs.mkdir(transactionRoot);
  const candidateRoot = path.join(transactionRoot, "candidate");
  let descriptorWritten = false;
  let emergency = null;
  let restoredSafetyBackup = null;
  try {
    const extraction = await extractPortableZip(
      path.join(sessionRoot, "archive.formdigital-backup"),
      candidateRoot,
      {
        singleObjectBytes: RAW_ASSET_MAX_BYTES,
        validateEntryName: isAllowedPortableStreamEntry,
      },
    );
    const verified = await verifyExtractedPortableBackup(
      extraction,
      owner.ownerKeyHash,
    );
    if (verified.manifest.id !== session.sourceBackupId)
      throw new PortableArchiveStreamError("PORTABLE_SESSION_INVALID");

    const declared = new Map(
      verified.manifest.files.map(file => [file.path, file]),
    );
    const incomingManifests = verified.manifest.files
      .filter(file => file.path.startsWith("manifests/"))
      .map(file => ({ name: path.basename(file.path), ...file }));
    const incomingManifestNames = new Set(
      incomingManifests.map(item => item.name),
    );
    for (const item of incomingManifests) {
      const target = path.join(dirs.manifests, item.name);
      const stat = await fs.lstat(target).catch(() => null);
      if (!stat) continue;
      if (!stat.isFile())
        throw new PortableArchiveStreamError("PORTABLE_MANIFEST_COLLISION");
      let existing;
      try {
        existing = JSON.parse(await fs.readFile(target, "utf8"));
      } catch {
        throw new PortableArchiveStreamError("PORTABLE_MANIFEST_COLLISION");
      }
      if (existing?.ownerKeyHash !== owner.ownerKeyHash)
        throw new PortableArchiveStreamError("PORTABLE_MANIFEST_COLLISION");
    }
    for (const file of verified.manifest.files.filter(item =>
      item.path.startsWith("objects/"))) {
      const target = path.join(dirs.objects, path.basename(file.path));
      const stat = await fs.lstat(target).catch(() => null);
      if (stat)
        await requireStoredObjectMatch(target, file.contentHash, file.size);
    }

    try {
      emergency = await createStreamingPortableBackup(owner, "pre-restore");
    } catch {
      // A verified complete archive is also the repair path when the current
      // v1 projection is unreadable. Preserve the complete current Local Data
      // Folder byte-for-byte before replacing it; if that snapshot also fails,
      // the restore aborts before any live mutation.
      emergency = await createBackup("emergency-portable-stream-restore");
    }
    restoredSafetyBackup = await preservePortableRestoreSource(
      owner,
      sessionRoot,
      verified.manifest,
    );
    const preparedWorkspace = await preparePortableRestoreWorkspace(
      verified,
      extraction,
      declared,
      transactionRoot,
    );
    const newWorkspace = preparedWorkspace.workspaceInfo;
    const newWorkspaceV2 = declared.get("account/workspace-v2.sqlite");
    const newLegacyWorkspace = preparedWorkspace.legacyWorkspaceInfo;
    await snapshotPortableRollback(
      transactionRoot,
      owner.ownerKeyHash,
      incomingManifests.map(item => ({
        name: item.name,
        size: item.size,
        contentHash: item.contentHash,
      })),
      { size: newWorkspace.size, contentHash: newWorkspace.contentHash },
      { size: newWorkspaceV2.size, contentHash: newWorkspaceV2.contentHash },
      {
        size: newLegacyWorkspace.size,
        contentHash: newLegacyWorkspace.contentHash,
      },
      restoredSafetyBackup,
    );

    const candidateV2 = path.join(transactionRoot, "candidate-workspace-v2");
    await fs.mkdir(candidateV2);
    await atomicCopyPortableFile(
      extraction.entries.get("account/workspace-v2.sqlite").path,
      path.join(candidateV2, "workspace-v2.sqlite"),
      newWorkspaceV2,
    );
    await atomicCopyPortableFile(
      preparedWorkspace.legacyWorkspacePath,
      path.join(candidateV2, "legacy-workspace.json"),
      newLegacyWorkspace,
    );

    await writePortableRestoreDescriptor(transactionId, {
      ownerKeyHash: owner.ownerKeyHash,
      sessionId,
      sourceBackupId: verified.manifest.id,
      emergencyBackupId: emergency.id,
      phase: "prepared",
    });
    descriptorWritten = true;
    await writePortableRestoreDescriptor(transactionId, {
      ownerKeyHash: owner.ownerKeyHash,
      sessionId,
      sourceBackupId: verified.manifest.id,
      emergencyBackupId: emergency.id,
      phase: "swapping",
    });
    await pauseAtPortableRestoreTestPoint("after_descriptor_swapping");

    let objectIndex = 0;
    for (const file of verified.manifest.files.filter(item =>
      item.path.startsWith("objects/"))) {
      const target = path.join(dirs.objects, path.basename(file.path));
      const stat = await fs.lstat(target).catch(() => null);
      if (!stat)
        await atomicCopyPortableFile(
          extraction.entries.get(file.path).path,
          target,
          file,
        );
      if (objectIndex === 0)
        await pauseAtPortableRestoreTestPoint("after_first_object");
      objectIndex += 1;
    }
    for (const item of incomingManifests)
      await atomicCopyPortableFile(
        extraction.entries.get(item.path).path,
        path.join(dirs.manifests, item.name),
        item,
      );
    for (const { name } of await ownerManifests(owner.ownerKeyHash))
      if (!incomingManifestNames.has(name))
        await fs.rm(path.join(dirs.manifests, name), { force: true });
    await pauseAtPortableRestoreTestPoint("after_manifests");

    await atomicCopyPortableFile(
      preparedWorkspace.workspacePath,
      accountPaths(owner.ownerKeyHash).workspace,
      newWorkspace,
    );
    await pauseAtPortableRestoreTestPoint("after_workspace");
    const liveV2 = path.join(dirs["workspace-v2"], owner.ownerKeyHash);
    await fs.rm(liveV2, { recursive: true, force: true });
    await fs.rename(candidateV2, liveV2);
    await syncDirectory(dirs["workspace-v2"]);
    await pauseAtPortableRestoreTestPoint("after_workspace_v2");

    const committedWorkspace = await hashPortableFile(
      accountPaths(owner.ownerKeyHash).workspace,
      PORTABLE_STREAM_LIMITS.workspaceBytes,
    );
    const committedV2 = await hashPortableFile(
      path.join(liveV2, "workspace-v2.sqlite"),
      PORTABLE_STREAM_LIMITS.workspaceV2Bytes,
    );
    const committedLegacyWorkspace = await hashPortableFile(
      path.join(liveV2, "legacy-workspace.json"),
      PORTABLE_STREAM_LIMITS.workspaceBytes,
    );
    const committedSafetyBackup = await hashPortableFile(
      path.join(
        dirs.backups,
        "emergency",
        `${restoredSafetyBackup.id}.formdigital-backup`,
      ),
      PORTABLE_STREAM_LIMITS.archiveBytes,
    );
    if (
      committedWorkspace.size !== newWorkspace.size ||
      committedWorkspace.contentHash !== newWorkspace.contentHash ||
      committedV2.size !== newWorkspaceV2.size ||
      committedV2.contentHash !== newWorkspaceV2.contentHash ||
      committedLegacyWorkspace.size !== newLegacyWorkspace.size ||
      committedLegacyWorkspace.contentHash !== newLegacyWorkspace.contentHash ||
      committedSafetyBackup.size !== restoredSafetyBackup.size ||
      committedSafetyBackup.contentHash !== restoredSafetyBackup.contentHash
    )
      throw new PortableArchiveStreamError("PORTABLE_COMMIT_VERIFY_FAILED");
    inspectWorkspaceStorageV2File({
      databasePath: path.join(liveV2, "workspace-v2.sqlite"),
      ownerHash: owner.ownerKeyHash,
    });
    const committedManifestNames = await ownerManifestNameSet(owner.ownerKeyHash);
    if (
      committedManifestNames.size !== incomingManifestNames.size ||
      [...incomingManifestNames].some(name => !committedManifestNames.has(name))
    )
      throw new PortableArchiveStreamError("PORTABLE_COMMIT_VERIFY_FAILED");
    for (const item of incomingManifests)
      await hashPortableFile(
        path.join(dirs.manifests, item.name),
        PORTABLE_STREAM_LIMITS.assetManifestBytes,
      ).then(info => {
        if (info.size !== item.size || info.contentHash !== item.contentHash)
          throw new PortableArchiveStreamError("PORTABLE_COMMIT_VERIFY_FAILED");
      });
    for (const file of verified.manifest.files.filter(item =>
      item.path.startsWith("objects/")))
      await requireStoredObjectMatch(
        path.join(dirs.objects, path.basename(file.path)),
        file.contentHash,
        file.size,
      );

    await writePortableRestoreDescriptor(transactionId, {
      ownerKeyHash: owner.ownerKeyHash,
      sessionId,
      sourceBackupId: verified.manifest.id,
      emergencyBackupId: emergency.id,
      phase: "committed",
    });
    await pauseAtPortableRestoreTestPoint("after_descriptor_committed");
    const result = {
      restored: true,
      emergencyBackupId: emergency.id,
      transactionId,
      manifest: verified.manifest,
    };
    await appendJournal("backup.portable.stream.restore", {
      sourceBackupId: verified.manifest.id,
      emergencyBackupId: emergency.id,
      transactionId,
      ownerKeyHash: owner.ownerKeyHash,
      restored: true,
      verified: true,
    }).catch(() => {});
    await fs.rm(transactionRoot, { recursive: true, force: true }).catch(() => {});
    await fs.rm(descriptorPath, { force: true }).catch(() => {});
    await fs.rm(sessionRoot, { recursive: true, force: true }).catch(() => {});
    return result;
  } catch (error) {
    if (descriptorWritten) {
      let descriptor = null;
      try {
        descriptor = JSON.parse(await fs.readFile(descriptorPath, "utf8"));
      } catch {}
      if (descriptor?.phase === "swapping") {
        try {
          await restorePortableRollback(transactionId, descriptor);
        } catch {
          throw portableRestoreRejection(
            "Portable Backup restore failed and the previous state could not be fully restored. The pre-restore Emergency Backup is preserved.",
          );
        }
      } else {
        if (descriptor?.phase !== "committed")
          await cleanupRestoredSafetyBackup(restoredSafetyBackup);
        await fs.rm(transactionRoot, { recursive: true, force: true }).catch(() => {});
        await fs.rm(descriptorPath, { force: true }).catch(() => {});
      }
    } else {
      await cleanupRestoredSafetyBackup(restoredSafetyBackup);
      await fs.rm(transactionRoot, { recursive: true, force: true }).catch(() => {});
    }
    if (error?.code === PORTABLE_RESTORE_REJECTED) throw error;
    throw portableRestoreRejection(SAFE_PORTABLE_RESTORE_FAILURE);
  }
}

function verifyPortableBackup(archive, ownerHash) {
  const entries = unzipSync(archive);
  const manifestBytes = entries["backup-manifest.json"];
  if (!manifestBytes)
    throw new Error("Portable Backup is missing backup-manifest.json.");
  let manifest;
  try {
    manifest = JSON.parse(strFromU8(manifestBytes));
  } catch {
    throw new Error("Portable Backup manifest is not valid JSON.");
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    throw new Error("Portable Backup manifest format is invalid.");
  if (manifest.format !== "formdigital-portable-backup")
    throw new Error("Unsupported portable Backup format.");
  if (manifest.schemaVersion !== 1)
    throw new Error("Unsupported portable Backup schema version.");
  const scope = manifest.scope;
  if (scope !== "account" && scope !== "template")
    throw new Error("Portable Backup scope is not supported.");
  if (
    scope === "account" &&
    manifest.templateId !== null &&
    manifest.templateId !== undefined
  )
    throw new Error("Account-scoped Backup must not specify a templateId.");
  if (
    scope === "template" &&
    !(
      typeof manifest.templateId === "string" &&
      /^[A-Za-z0-9_-]{1,200}$/.test(manifest.templateId)
    )
  )
    throw new Error("Template-scoped Backup requires a non-empty templateId.");
  if (
    typeof manifest.ownerKeyHash !== "string" ||
    !PORTABLE_HASH_RE.test(manifest.ownerKeyHash)
  )
    throw new Error("Portable Backup owner hash format is invalid.");
  if (manifest.ownerKeyHash !== ownerHash)
    throw new Error(
      "Portable Backup belongs to a different account workspace."
    );
  const validCreatedAt =
    (typeof manifest.createdAt === "number" &&
      Number.isFinite(manifest.createdAt) &&
      manifest.createdAt >= 0) ||
    (typeof manifest.createdAt === "string" &&
      manifest.createdAt.length > 0 &&
      manifest.createdAt.length <= 64 &&
      Number.isFinite(Date.parse(manifest.createdAt)));
  if (!validCreatedAt)
    throw new Error("Portable Backup createdAt is invalid.");
  if (!Array.isArray(manifest.files))
    throw new Error("Portable Backup file manifest is invalid.");

  const seen = new Set();
  const archiveManifests = new Map();
  for (const file of manifest.files) {
    validatePortableFileDescriptor(file);
    if (!parsePortableEntryPath(file.path))
      throw new Error("Portable Backup file path is not supported.");
    if (!isAllowedPortableFile(file.path))
      throw new Error("Portable Backup file path is not supported.");
    if (seen.has(file.path))
      throw new Error("Portable Backup file manifest has a duplicate path.");
    seen.add(file.path);
  }

  const workspaceFiles = manifest.files.filter(
    f => f.path === "account/workspace.json"
  );
  if (workspaceFiles.length !== 1)
    throw new Error(
      "Portable Backup must contain exactly one account/workspace.json."
    );

  for (const key of Object.keys(entries)) {
    if (key === "backup-manifest.json") continue;
    if (!seen.has(key))
      throw new Error(
        "Portable Backup contains an undeclared archive entry."
      );
  }

  for (const file of manifest.files) {
    const data = entries[file.path];
    if (!data)
      throw new Error("Portable Backup file is missing from the archive.");
    if (data.byteLength !== file.size)
      throw new Error("Portable Backup file size does not match.");
    if (sha256(data) !== file.contentHash)
      throw new Error("Portable Backup file content hash does not match.");
  }

  const workspaceBytes = entries["account/workspace.json"];
  let workspaceEnvelope;
  try {
    workspaceEnvelope = JSON.parse(strFromU8(workspaceBytes));
  } catch {
    throw new Error("Portable Backup Workspace data is not parseable.");
  }
  if (
    !workspaceEnvelope ||
    typeof workspaceEnvelope !== "object" ||
    Array.isArray(workspaceEnvelope) ||
    typeof workspaceEnvelope.workspace !== "object" ||
    workspaceEnvelope.workspace === null ||
    Array.isArray(workspaceEnvelope.workspace)
  )
    throw new Error("Portable Backup Workspace structure is invalid.");

  for (const file of manifest.files) {
    if (!file.path.startsWith("manifests/")) continue;
    const mBytes = entries[file.path];
    let m;
    try {
      m = JSON.parse(strFromU8(mBytes));
    } catch {
      throw new Error("Portable Backup asset manifest is not parseable.");
    }
    if (!m || typeof m !== "object" || Array.isArray(m))
      throw new Error("Portable Backup asset manifest structure is invalid.");
    for (const field of [
      "schemaVersion",
      "id",
      "ownerKeyHash",
      "contentHash",
      "size",
    ])
      if (!(field in m))
        throw new Error(
          "Portable Backup asset manifest is missing a required field."
        );
    if (m.schemaVersion !== 1)
      throw new Error("Portable Backup asset manifest version is not supported.");
    if (m.ownerKeyHash !== manifest.ownerKeyHash)
      throw new Error("Portable Backup asset owner does not match the archive.");
    const objPath = `objects/${m.contentHash}`;
    if (!seen.has(objPath))
      throw new Error("Portable Backup asset references an unlisted object.");
    const objData = entries[objPath];
    if (!objData)
      throw new Error("Portable Backup asset references a missing object.");
    if (
      typeof m.size !== "number" ||
      !Number.isSafeInteger(m.size) ||
      m.size < 0 ||
      m.size !== objData.byteLength ||
      m.contentHash !== sha256(objData)
    )
      throw new Error("Portable Backup asset manifest does not match its object.");
    const base = file.path.slice("manifests/".length).replace(/\.json$/, "");
    if (base !== m.id)
      throw new Error("Portable Backup asset manifest filename does not match its id.");
    archiveManifests.set(m.id, m);
  }

  for (const reference of workspaceAssetReferences(workspaceEnvelope.workspace))
    if (!archiveManifests.has(reference.assetId))
      throw new Error(
        "Portable Backup Workspace references an asset that is missing from the archive.",
      );

  for (const file of manifest.files) {
    if (!file.path.startsWith("objects/")) continue;
    const base = file.path.slice("objects/".length);
    if (base !== sha256(entries[file.path]))
      throw new Error("Portable Backup object path does not match its content hash.");
  }

  validatePortableSummary(manifest.summary);
  const workspace = workspaceEnvelope.workspace;
  const derivedSummary = derivePortableSummary(workspace);
  // Rebuild both summaries in one explicit key order so harmless JSON property
  // ordering differences do not affect semantic comparison.
  const canonicalSummary = summary => ({
    templates: (summary.templates ?? []).map(t => ({
      id: t.id,
      name: t.name,
      versions: t.versions,
      instances: t.instances,
    })),
    templateCount: summary.templateCount,
    versionCount: summary.versionCount,
    instanceCount: summary.instanceCount,
    mappingTemplateCount: summary.mappingTemplateCount,
  });
  if (
    JSON.stringify(canonicalSummary(manifest.summary)) !==
    JSON.stringify(canonicalSummary(derivedSummary))
  ) {
    throw new Error("Portable Backup summary does not match the Workspace content.");
  }
  if (
    scope === "template" &&
    (derivedSummary.templates.length !== 1 ||
      derivedSummary.templates[0]?.id !== manifest.templateId)
  )
    throw new Error("Template-scoped Backup does not match the Workspace content.");

  return { entries, manifest };
}

// Read every asset manifest currently stored for `ownerHash` and return the
// exact on-disk names. Directories and unparseable files are not attributable
// to an owner and are therefore not reported.
async function ownerManifestNameSet(ownerHash) {
  const names = new Set();
  for (const name of (await fs.readdir(dirs.manifests)).filter(file =>
    file.endsWith(".json")
  )) {
    const target = path.join(dirs.manifests, name);
    const stat = await fs.lstat(target).catch(() => null);
    if (!stat || !stat.isFile()) continue;
    try {
      const parsed = JSON.parse(await fs.readFile(target, "utf8"));
      if (parsed && parsed.ownerKeyHash === ownerHash) names.add(name);
    } catch {}
  }
  return names;
}

async function restorePortableBackup(ownerHash, archive, options = {}) {
  // The strict verifier contract is unchanged. Its rejection reasons are not
  // echoed to the caller (VI-G): the response only states that verification
  // failed.
  let verified;
  try {
    verified = verifyPortableBackup(archive, ownerHash);
  } catch {
    throw portableRestoreRejection(
      "Portable Backup restore was rejected because the archive failed verification. No change was made."
    );
  }

  // A direct full restore (preserveExistingAssets !== true) replaces the
  // request owner's Workspace and asset manifests. Template-scoped archives are
  // only valid for the structure/duplicate merge path (preserveExistingAssets),
  // so reject them here BEFORE any Emergency Backup or mutation.
  if (verified.manifest.scope === "template" && !options.preserveExistingAssets)
    throw portableRestoreRejection(
      "Portable Backup restore was rejected because a Template-scoped archive cannot replace a whole account. No change was made."
    );

  const workspaceBytes = verified.entries["account/workspace.json"];
  if (!workspaceBytes)
    throw portableRestoreRejection(
      "Portable Backup restore was rejected because the archive has no Workspace envelope. No change was made."
    );
  const workspaceBuffer = Buffer.from(workspaceBytes);
  let incomingEnvelope;
  try {
    incomingEnvelope = JSON.parse(workspaceBuffer.toString("utf8"));
  } catch {
    throw portableRestoreRejection(
      "Portable Backup restore was rejected because the Workspace envelope is invalid. No change was made.",
    );
  }
  if (workspaceProjectionMarker(incomingEnvelope?.workspace))
    throw portableRestoreRejection(
      "Portable Backup restore was rejected because this archive requires its Workspace v2 database. Use the bounded streaming restore. No change was made.",
    );
  let currentProjection = null;
  if (!options.preserveExistingAssets) {
    try {
      currentProjection = workspaceProjectionMarker(
        (await loadWorkspace(ownerHash)).workspace,
      );
    } catch {
      // A verified restore is also the repair path for an unreadable current
      // Workspace.  Failure to inspect the damaged file must not prevent that
      // repair; only a positively validated projection marker blocks v1 full
      // replacement.
    }
  }
  if (!options.preserveExistingAssets && currentProjection)
    throw portableRestoreRejection(
      "Portable Backup restore was rejected because this Workspace requires a complete schema-v2 archive. Use the bounded streaming restore. No change was made.",
    );

  // Incoming owner manifests / objects, in the order declared by the verified
  // Backup manifest. addedObjectNames is declared here (not inside the try) so
  // the rollback catch block can read it.
  const incomingManifestNames = new Set();
  const incomingManifests = [];
  const incomingObjects = [];
  const addedObjectNames = [];
  for (const file of verified.manifest.files) {
    const bytes = Buffer.from(verified.entries[file.path]);
    if (file.path.startsWith("manifests/")) {
      const name = path.basename(file.path);
      incomingManifestNames.add(name);
      incomingManifests.push({ name, bytes });
    } else if (file.path.startsWith("objects/")) {
      incomingObjects.push({ name: path.basename(file.path), bytes });
    }
  }

  // ---- (VI-A) Cross-owner manifest collision preflight -------------------
  // Runs BEFORE the Emergency Backup and BEFORE any mutation. An incoming
  // manifest may only ever overwrite a manifest that already belongs to the
  // request owner. A directory, an unreadable file, a non-manifest file or a
  // manifest owned by another account aborts the restore with no side effect,
  // so another account's manifest can never be overwritten (and can therefore
  // never be silently lost by a rollback that only knows the request owner).
  for (const m of incomingManifests) {
    const target = path.join(dirs.manifests, m.name);
    let stat = null;
    try {
      stat = await fs.lstat(target);
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) continue;
      throw portableRestoreRejection(
        "Portable Backup restore was rejected because an existing asset manifest could not be inspected. No change was made."
      );
    }
    if (!stat.isFile())
      throw portableRestoreRejection(
        "Portable Backup restore was rejected because an asset manifest target is not a regular file. No change was made."
      );
    let existing = null;
    try {
      existing = JSON.parse(await fs.readFile(target, "utf8"));
    } catch {
      throw portableRestoreRejection(
        "Portable Backup restore was rejected because an existing asset manifest is unreadable. No change was made."
      );
    }
    if (
      !existing ||
      typeof existing !== "object" ||
      typeof existing.ownerKeyHash !== "string" ||
      typeof existing.id !== "string"
    )
      throw portableRestoreRejection(
        "Portable Backup restore was rejected because an existing asset manifest is not a valid manifest. No change was made."
      );
    if (existing.ownerKeyHash !== ownerHash)
      throw portableRestoreRejection(
        "Portable Backup restore was rejected because an asset manifest name is already owned by another account. No change was made."
      );
  }

  // ---- (VI-B) Existing stored object preflight ---------------------------
  // The object store is content addressed and shared by every account, so an
  // incoming object whose target already exists is only safe to reuse when the
  // stored bytes really hash to the target filename. Verified BEFORE the
  // Emergency Backup and BEFORE any mutation.
  for (const o of incomingObjects) {
    const target = path.join(dirs.objects, o.name);
    let stat = null;
    try {
      stat = await fs.lstat(target);
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) continue;
      throw portableRestoreRejection(
        "Portable Backup restore was rejected because a stored object could not be inspected. No change was made."
      );
    }
    if (!stat.isFile())
      throw portableRestoreRejection(
        "Portable Backup restore was rejected because a stored object target is not a regular file. No change was made."
      );
    let existingBytes = null;
    try {
      existingBytes = await fs.readFile(target);
    } catch {
      throw portableRestoreRejection(
        "Portable Backup restore was rejected because a stored object could not be read. No change was made."
      );
    }
    if (sha256(existingBytes) !== o.name)
      throw portableRestoreRejection(
        "Portable Backup restore was rejected because a stored object does not match its content hash. No change was made."
      );
  }

  // 1. Create the pre-restore Emergency Backup. Every rejection above happens
  //    before this point, so a rejected restore never leaves an Emergency
  //    Backup behind. If it fails, no mutation has started.
  let emergency;
  try {
    emergency = await createPortableBackup(ownerHash, "pre-restore");
  } catch {
    // A repair restore is most needed when the current Workspace or an object
    // is already damaged. Preserve a byte-exact five-domain legacy snapshot in
    // that case; portable verification must not prevent the incoming verified
    // archive from repairing the account.
    emergency = await createBackup("emergency-portable-restore");
  }
  const transactionId = crypto.randomUUID();

  // Capture rollback state BEFORE any mutation.
  const account = accountPaths(ownerHash);
  let previousWorkspace = null;
  try {
    previousWorkspace = await fs.readFile(account.workspace);
  } catch {}
  const previousOwnerManifests = [];
  for (const { name } of await ownerManifests(ownerHash))
    previousOwnerManifests.push({
      name,
      bytes: await fs.readFile(path.join(dirs.manifests, name)),
    });
  const previousOwnerManifestNames = new Set(
    previousOwnerManifests.map(m => m.name)
  );
  const removedManifestNames = [];

  // ---- (VI-C) Unique, collision-safe staging transaction root ------------
  // The transaction root is created exclusively (no recursive mkdir): a
  // pre-existing directory raises EEXIST instead of being silently reused or
  // shared by two concurrent restores.
  const candidate = path.join(dirs.staging, `restore-portable-${transactionId}`);
  let candidateCreated = false;
  try {
    await fs.mkdir(candidate);
    candidateCreated = true;
    await fs.mkdir(path.join(candidate, "objects"));
    await fs.mkdir(path.join(candidate, "manifests"));
  } catch {
    if (candidateCreated)
      await fs.rm(candidate, { recursive: true, force: true }).catch(() => {});
    throw portableRestoreRejection(
      "Portable Backup restore was rejected because a private staging area could not be created. No change was made."
    );
  }

  try {
    // Stage the candidate.
    for (const o of incomingObjects)
      await fs.writeFile(path.join(candidate, "objects", o.name), o.bytes);
    for (const m of incomingManifests)
      await fs.writeFile(path.join(candidate, "manifests", m.name), m.bytes);
    await fs.writeFile(path.join(candidate, "workspace.json"), workspaceBuffer);

    // ---- (VI-D) Re-verify the staged candidate from disk before commit ----
    for (const o of incomingObjects) {
      const staged = await fs.readFile(path.join(candidate, "objects", o.name));
      if (sha256(staged) !== o.name || !staged.equals(o.bytes))
        throw new Error("Staged object does not match the verified archive.");
    }
    for (const m of incomingManifests) {
      const staged = await fs.readFile(
        path.join(candidate, "manifests", m.name)
      );
      if (!staged.equals(m.bytes))
        throw new Error(
          "Staged asset manifest does not match the verified archive."
        );
    }
    const stagedWorkspace = await fs.readFile(
      path.join(candidate, "workspace.json")
    );
    if (!stagedWorkspace.equals(workspaceBuffer))
      throw new Error("Staged Workspace does not match the verified archive.");

    // ---- Commit phase. Objects first (content-addressed, idempotent), then
    //      owner manifests, then the Workspace LAST so it is never partially
    //      written. ----
    for (const o of incomingObjects) {
      const target = path.join(dirs.objects, o.name);
      let exists = true;
      try {
        await fs.lstat(target);
      } catch {
        exists = false;
      }
      if (!exists) {
        await atomicWrite(target, o.bytes);
        addedObjectNames.push(o.name);
      }
    }
    for (const m of incomingManifests)
      await atomicWrite(path.join(dirs.manifests, m.name), m.bytes);
    if (!options.preserveExistingAssets)
      for (const { name } of previousOwnerManifests)
        if (!incomingManifestNames.has(name)) {
          await fs.rm(path.join(dirs.manifests, name), { force: true });
          removedManifestNames.push(name);
        }

    // A structure/duplicate import uses this route only to install verified
    // assets; the caller merges the verified Workspace separately.  Never
    // replace the live v1 compatibility envelope in that mode, especially
    // after its high-growth records have moved to Workspace v2.
    if (!options.preserveExistingAssets)
      await atomicWrite(account.workspace, workspaceBuffer);

    // ---- (VI-E) Exact commit verification --------------------------------
    // Re-read the live Data Folder and prove it now equals the archive. Any
    // mismatch triggers the rollback below.
    // 1. Workspace raw bytes.
    const committedWorkspace = await fs.readFile(account.workspace);
    if (
      options.preserveExistingAssets
        ? previousWorkspace !== null && !committedWorkspace.equals(previousWorkspace)
        : !committedWorkspace.equals(workspaceBuffer)
    )
      throw new Error("Committed Workspace bytes do not match the intended restore mode.");
    // 2. Workspace still parses as an envelope.
    let parsedWorkspace = null;
    try {
      parsedWorkspace = JSON.parse(committedWorkspace.toString("utf8"));
    } catch {
      parsedWorkspace = null;
    }
    if (
      !parsedWorkspace ||
      typeof parsedWorkspace !== "object" ||
      !parsedWorkspace.workspace ||
      typeof parsedWorkspace.workspace !== "object"
    )
      throw new Error("Committed Workspace is not a valid envelope.");
    // 3. The request owner's manifest set is EXACTLY the incoming set.
    const committedOwnerNames = await ownerManifestNameSet(ownerHash);
    for (const name of incomingManifestNames)
      if (!committedOwnerNames.has(name))
        throw new Error(
          "Committed owner manifest set is missing an archive manifest."
        );
    if (!options.preserveExistingAssets)
      for (const name of committedOwnerNames)
        if (!incomingManifestNames.has(name))
          throw new Error(
            "Committed owner manifest set contains a manifest the archive does not declare."
          );
    // 4. Every incoming manifest is present with exact raw bytes.
    for (const m of incomingManifests) {
      const live = await fs.readFile(path.join(dirs.manifests, m.name));
      if (!live.equals(m.bytes))
        throw new Error(
          "Committed asset manifest bytes do not match the archive."
        );
    }
    // 5. Every incoming object is present with exact raw bytes and hash.
    for (const o of incomingObjects) {
      const target = path.join(dirs.objects, o.name);
      const stat = await fs.lstat(target).catch(() => null);
      if (!stat || !stat.isFile())
        throw new Error("Committed object is missing after commit.");
      const live = await fs.readFile(target);
      if (sha256(live) !== o.name || !live.equals(o.bytes))
        throw new Error("Committed object bytes do not match their hash.");
    }
    // 6. Every manifest this transaction removed is really gone.
    for (const name of removedManifestNames) {
      const stat = await fs.lstat(path.join(dirs.manifests, name)).catch(
        () => null
      );
      if (stat)
        throw new Error("A removed asset manifest is still present on disk.");
    }

    // ---- (VI-F) Staging cleanup completes BEFORE the success state --------
    // The transaction directory must be gone before the success Journal entry
    // is appended and before the caller is told the restore succeeded, so a
    // failed cleanup can still be rolled back instead of leaving an
    // inconsistent "successful" restore behind.
    await fs.rm(candidate, { recursive: true, force: true });
    const stagingResidue = (
      await fs.readdir(dirs.staging).catch(() => [])
    ).filter(name => name === path.basename(candidate));
    if (stagingResidue.length)
      throw new Error("Restore staging transaction directory was not removed.");

    await appendJournal("backup.portable.restore", {
      sourceBackupId: verified.manifest.id,
      emergencyBackupId: emergency.id,
      transactionId,
      ownerKeyHash: ownerHash,
      restored: true,
      verified: true,
    });
    return {
      restored: true,
      emergencyBackupId: emergency.id,
      transactionId,
      manifest: verified.manifest,
    };
  } catch {
    // ---- Rollback: precisely restore captured state. ----
    try {
      // Workspace: restore previous bytes, or remove if it did not exist.
      if (previousWorkspace) {
        const live = await fs.readFile(account.workspace).catch(() => null);
        if (!live || !live.equals(previousWorkspace))
          await atomicWrite(account.workspace, previousWorkspace);
      } else await fs.rm(account.workspace, { force: true });

      // Owner manifests: restore every previously-existing manifest, then
      // remove any manifest this transaction added that was not present before.
      // A byte-identical manifest is left untouched so a rollback never needs
      // write access it did not already need.
      for (const pm of previousOwnerManifests) {
        const target = path.join(dirs.manifests, pm.name);
        const stat = await fs.lstat(target).catch(() => null);
        if (stat && !stat.isFile())
          await fs.rm(target, { force: true, recursive: true });
        else if (stat) {
          const live = await fs.readFile(target).catch(() => null);
          if (live && live.equals(pm.bytes)) continue;
        }
        await atomicWrite(target, pm.bytes);
      }
      for (const name of await fs.readdir(dirs.manifests)) {
        if (!name.endsWith(".json")) continue;
        if (!previousOwnerManifestNames.has(name)) {
          // Only remove manifests this transaction would have ADDED (an incoming
          // manifest name that was not part of the request owner's previous set).
          // Manifests owned by OTHER accounts must never be touched.
          if (incomingManifestNames.has(name))
            await fs.rm(path.join(dirs.manifests, name), {
              force: true,
              recursive: true,
            });
        }
      }

      // Objects: only remove those this transaction newly added and that no
      // manifest (any owner) references after rollback. Uncertain references
      // are kept as orphans (never risk deleting a shared object).
      const referencedObjects = new Set();
      for (const name of await fs.readdir(dirs.manifests)) {
        if (!name.endsWith(".json")) continue;
        try {
          const m = JSON.parse(
            await fs.readFile(path.join(dirs.manifests, name), "utf8")
          );
          if (m && typeof m.contentHash === "string")
            referencedObjects.add(m.contentHash);
        } catch {}
      }
      for (const name of addedObjectNames)
        if (!referencedObjects.has(name))
          await fs.rm(path.join(dirs.objects, name), {
            force: true,
            recursive: true,
          });

      // Prove the rollback really reproduced the captured state before the
      // caller is told the previous state was restored.
      const rolledBackWorkspace = await fs
        .readFile(account.workspace)
        .catch(() => null);
      if (previousWorkspace) {
        if (!rolledBackWorkspace || !rolledBackWorkspace.equals(previousWorkspace))
          throw new Error("Rollback did not restore the previous Workspace.");
      } else if (rolledBackWorkspace)
        throw new Error("Rollback left a Workspace that did not exist before.");
      for (const pm of previousOwnerManifests) {
        const live = await fs
          .readFile(path.join(dirs.manifests, pm.name))
          .catch(() => null);
        if (!live || !live.equals(pm.bytes))
          throw new Error(
            "Rollback did not restore a previous asset manifest byte for byte."
          );
      }
    } catch {
      // Staging is still cleaned so a failed rollback cannot leave a partial
      // candidate behind for a later transaction to trip over.
      await fs.rm(candidate, { recursive: true, force: true }).catch(() => {});
      await appendJournal("backup.portable.restore.rollback.failed", {
        sourceBackupId: verified.manifest.id,
        emergencyBackupId: emergency.id,
        transactionId,
        ownerKeyHash: ownerHash,
        reason: "rollback_failed",
        rolledBack: false,
      });
      throw portableRestoreRejection(
        "Portable Backup restore failed and the previous state could not be fully restored. The pre-restore Emergency Backup is preserved."
      );
    }
    // (VI-F) Staging is removed before the rollback is journalled/returned.
    await fs.rm(candidate, { recursive: true, force: true });
    await appendJournal("backup.portable.restore.rollback", {
      sourceBackupId: verified.manifest.id,
      emergencyBackupId: emergency.id,
      transactionId,
      ownerKeyHash: ownerHash,
      reason: "mid_commit_failure",
      rolledBack: true,
    });
    // (VI-G) The original error is never surfaced: it can carry absolute paths,
    // staging filenames or owner hashes.
    throw portableRestoreRejection(SAFE_PORTABLE_RESTORE_FAILURE);
  }
}

async function restoreBackup(backupId) {
  if (!/^backup-[\w-]+$/.test(String(backupId)))
    throw workspaceProjectionRejection(
      "BACKUP_NOT_FOUND",
      404,
      "Requested Backup was not found.",
    );
  const source = path.join(dirs.backups, backupId);
  const sourceManifest = path.join(source, "backup-manifest.json");
  try {
    await fs.access(sourceManifest);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT"))
      throw workspaceProjectionRejection(
        "BACKUP_NOT_FOUND",
        404,
        "Requested Backup was not found.",
      );
    throw error;
  }
  const domains = LEGACY_RESTORE_DOMAINS;
  for (const domain of domains) await fs.access(path.join(source, domain));
  const transactionId = crypto.randomUUID();
  const candidate = path.join(dirs.staging, `restore-${transactionId}`);
  try {
    for (const domain of domains)
      await fs.cp(path.join(source, domain), path.join(candidate, domain), {
        recursive: true,
        errorOnExist: true,
      });
    const candidateScan = await integrityScanAt(directoriesFor(candidate));
    if (!candidateScan.healthy)
      throw new Error("Backup data failed integrity verification.");
  } catch (error) {
    await fs.rm(candidate, { recursive: true, force: true });
    throw error;
  }
  const emergencyBackup = await createBackup("emergency-restore");
  const previous = Object.fromEntries(
    domains.map(domain => [
      domain,
      path.join(dirs.staging, `previous-${domain}-${transactionId}`),
    ]),
  );
  const descriptorPath = path.join(
    dirs.staging,
    `.formdigital-restore-${transactionId}.json`,
  );
  await writeLegacyRestoreDescriptor(transactionId, { phase: "swapping", backupId });
  let committed = false;
  try {
    for (const domain of domains) {
      await fs.rename(dirs[domain], previous[domain]);
      await fs.rename(path.join(candidate, domain), dirs[domain]);
      await syncDirectory(root);
    }
    const scan = await integrityScan();
    if (!scan.healthy)
      throw new Error(
        "Restored data failed integrity verification; rolling back."
      );
    // The durable marker is the generation commit point. From here on cleanup
    // failures must never enter rollback and delete the live new generation.
    await writeLegacyRestoreDescriptor(transactionId, {
      phase: "committed",
      backupId,
    });
    committed = true;
    await appendJournal("backup.restore", {
      backupId,
      emergencyBackupId: emergencyBackup.id,
      healthy: true,
    });
    let cleanupPending = false;
    try {
      if (process.env.FORMDIGITAL_TEST_LEGACY_RESTORE_CLEANUP_FAIL === "1")
        throw new Error("synthetic cleanup failure");
      for (const domain of domains)
        await fs.rm(previous[domain], { recursive: true, force: true });
      await fs.rm(candidate, { recursive: true, force: true });
      await fs.rm(descriptorPath, { force: true });
      await syncDirectory(dirs.staging);
    } catch {
      cleanupPending = true;
    }
    return {
      backupId,
      emergencyBackupId: emergencyBackup.id,
      scan,
      cleanupPending,
    };
  } catch (error) {
    if (committed) throw error;
    for (const domain of [...domains].reverse()) {
      const previousExists = await fs.lstat(previous[domain]).then(
        stat => stat.isDirectory(),
        () => false,
      );
      if (!previousExists) continue;
      await fs.rm(dirs[domain], { recursive: true, force: true });
      await fs.rename(previous[domain], dirs[domain]);
    }
    await fs.rm(candidate, { recursive: true, force: true });
    await fs.rm(descriptorPath, { force: true });
    await appendJournal("backup.restore.rollback", {
      backupId,
      reason: "restore_failed",
    });
    throw error;
  }
}

let localTesseractActive = false;

function acquireLocalTesseractSlot() {
  if (localTesseractActive)
    throw Object.assign(new Error("local OCR is busy"), {
      statusCode: 503,
      publicCode: "ocr_busy",
      safeMessage: "Local OCR is busy; retry this page or use the browser fallback.",
    });
  localTesseractActive = true;
  return () => { localTesseractActive = false; };
}

async function runLocalTesseract(input) {
  const mimeType = String(input.mimeType || "");
  const extension =
    mimeType === "image/png" ? "png" : mimeType === "image/jpeg" ? "jpg" : null;
  if (!extension)
    throw Object.assign(new Error("invalid OCR input type"), {
      statusCode: 400,
      publicCode: "ocr_input_type_invalid",
      safeMessage: "Local OCR accepts PNG or JPEG input.",
    });
  const bytes = Buffer.from(String(input.base64 || ""), "base64");
  if (!bytes.length)
    throw Object.assign(new Error("empty OCR input"), {
      statusCode: 400,
      publicCode: "ocr_input_empty",
      safeMessage: "OCR input is empty.",
    });
  const id = crypto.randomUUID();
  const inputPath = path.join(dirs.staging, `ocr-${id}.${extension}`);
  const outputBase = path.join(dirs.staging, `ocr-${id}`);
  const releaseSlot = acquireLocalTesseractSlot();
  try {
    await fs.writeFile(inputPath, bytes, { flag: "wx" });
    await execFileAsync(
      "tesseract",
      [
        inputPath,
        outputBase,
        "-l",
        input.language === "auto"
          ? "chi_tra+chi_sim+eng"
          : String(input.language || "eng"),
        "tsv",
      ],
      { timeout: 120_000, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }
    );
    const tsv = await fs.readFile(`${outputBase}.tsv`, "utf8");
    const rows = tsv
      .trim()
      .split(/\r?\n/)
      .slice(1)
      .map(line => {
        const [
          level,
          page,
          block,
          paragraph,
          lineNumber,
          wordNumber,
          left,
          top,
          width,
          height,
          confidence,
          ...text
        ] = line.split("\t");
        return {
          level: Number(level),
          page: Number(page),
          block: Number(block),
          paragraph: Number(paragraph),
          line: Number(lineNumber),
          word: Number(wordNumber),
          left: Number(left),
          top: Number(top),
          width: Number(width),
          height: Number(height),
          confidence: Number(confidence),
          text: text.join("\t"),
        };
      })
      .filter(row => row.text && row.confidence >= 0);
    await appendJournal("ocr.tesseract", {
      language:
        input.language === "auto"
          ? "chi_tra+chi_sim+eng"
          : input.language || "eng",
      words: rows.length,
      inputHash: sha256(bytes),
    });
    return {
      provider: "tesseract",
      cost: "free-local",
      words: rows,
      imageWidth: Number(input.width) || undefined,
      imageHeight: Number(input.height) || undefined,
      notice:
        "OCR output is a suggestion only; confirm fields before saving a Template Draft.",
    };
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      throw Object.assign(new Error("local OCR provider unavailable"), {
        statusCode: 503,
        publicCode: "ocr_provider_unavailable",
        safeMessage: "Local OCR is unavailable; use the browser fallback or configure Tesseract.",
      });
    if (error && typeof error === "object" && "killed" in error && error.killed)
      throw Object.assign(new Error("local OCR timed out"), {
        statusCode: 504,
        publicCode: "ocr_timeout",
        safeMessage: "Local OCR timed out; use the browser fallback for this page.",
      });
    throw Object.assign(new Error("local OCR failed"), {
      statusCode: 500,
      publicCode: "ocr_failed",
      safeMessage: "Local OCR failed; use the browser fallback for this page.",
    });
  } finally {
    await Promise.all(
      [inputPath, `${outputBase}.tsv`].map(file => fs.rm(file, { force: true }))
    );
    releaseSlot();
  }
}

const dataGate = {
  readers: 0,
  writer: false,
  waiters: [],
};

function pumpDataGate() {
  if (dataGate.writer || dataGate.waiters.length === 0) return;
  if (dataGate.waiters[0].write) {
    if (dataGate.readers !== 0) return;
    const waiter = dataGate.waiters.shift();
    dataGate.writer = true;
    waiter.resolve(() => {
      dataGate.writer = false;
      pumpDataGate();
    });
    return;
  }
  while (dataGate.waiters.length && !dataGate.waiters[0].write) {
    const waiter = dataGate.waiters.shift();
    dataGate.readers += 1;
    waiter.resolve(() => {
      dataGate.readers -= 1;
      pumpDataGate();
    });
  }
}

function acquireDataGate(write) {
  return new Promise(resolve => {
    dataGate.waiters.push({ write, resolve });
    pumpDataGate();
  });
}

async function withDataGate(write, operation) {
  const release = await acquireDataGate(write);
  try {
    return await operation();
  } finally {
    release();
  }
}

async function handleRequest(request, response) {
  try {
    if (!secure(request, response)) return;
    if (request.method === "GET" && request.url === "/health") {
      // Re-verify the current root and required directories on every health
      // check so a Data Folder lost (or restored) while the service is running
      // is reflected immediately. This intentionally does NOT mkdir, ensure
      // schema, create files, repair data, or modify config here.
      let live = false;
      try {
        const required = await Promise.all(
          [root, dirs.objects, dirs.manifests, dirs.accounts].map(value =>
            fs.stat(value)
          )
        );
        live = required.every(value => value.isDirectory());
      } catch {}
      if (live && !rootAvailable) rootAvailable = true;
      else if (!live && rootAvailable) rootAvailable = false;
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
      });
      response.end(
        JSON.stringify({
          status: rootAvailable ? "ok" : "reconnect_required",
          service: "formdigital-local-data-folder",
          sourceModifiedAtMs: SOURCE_MODIFIED_AT_MS,
          root,
          dataFolder: root,
          schemaVersion: 1,
          message: rootAvailable
            ? undefined
            : "Configured Local Data Folder is missing or inaccessible; no empty replacement was created.",
        })
      );
      return;
    }
    if (
      request.method === "POST" &&
      request.url === "/api/v1/data-folder/reconnect"
    ) {
      let result;
      try {
        result = await reconnectDataFolder(await readJson(request));
      } catch {
        return reject(
          response,
          422,
          "data_folder_reconnect_failed",
          "The selected Local Data Folder could not be reconnected safely.",
        );
      }
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify(result));
      return;
    }
    if (!rootAvailable)
      return reject(
        response,
        409,
        "data_folder_reconnect_required",
        "Configured Local Data Folder is missing or inaccessible. Reconnect the original folder before using Formdigital."
      );
    if (request.method === "GET" && request.url === "/api/v1/host-account") {
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify(await hostAccount()));
      return;
    }
    if (request.method === "PUT" && request.url === "/api/v1/host-account") {
      const account = await updateHostAccount(await readJson(request));
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify(account));
      return;
    }
    if (
      request.method === "POST" &&
      request.url === "/api/v1/data-folder/move"
    ) {
      let result;
      try {
        result = await moveDataFolder(await readJson(request));
      } catch {
        return reject(
          response,
          422,
          "data_folder_move_failed",
          "The Local Data Folder could not be moved safely.",
        );
      }
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify(result));
      return;
    }
    if (String(request.url).startsWith("/api/v2/workspace/")) {
      if (await handleWorkspaceV2Request(request, response)) return;
      return reject(response, 404, "not_found", "Local service route not found.");
    }
    if (request.url === "/api/v1/workspace" && request.method === "GET") {
      const owner = requireOwner(request);
      await prepareLegacyWorkspaceForV2(owner);
      const envelope = await loadWorkspace(owner.ownerKeyHash);
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        etag: `\"${envelope.revision}\"`,
      });
      response.end(JSON.stringify(envelope));
      return;
    }
    if (request.url === "/api/v1/workspace" && request.method === "PUT") {
      const owner = requireOwner(request);
      await prepareLegacyWorkspaceForV2(owner);
      const input = await readJson(request);
      const envelope = await saveWorkspace(
        owner,
        Number(input.expectedRevision),
        input.workspace
      );
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        etag: `\"${envelope.revision}\"`,
      });
      response.end(JSON.stringify(envelope));
      return;
    }
    if (request.method === "POST" && request.url === "/api/v1/assets") {
      const owner = requireOwner(request);
      const input = await readJson(request);
      const encoded = String(input.base64 || "");
      if (
        encoded.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
      )
        return reject(response, 400, "invalid_asset_encoding", "Asset encoding is invalid.");
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.toString("base64") !== encoded)
        return reject(response, 400, "invalid_asset_encoding", "Asset encoding is invalid.");
      if (!bytes.length)
        return reject(response, 400, "empty_asset", "base64 data is required.");
      const metadata =
        input.metadata && typeof input.metadata === "object" &&
        !Array.isArray(input.metadata)
          ? input.metadata
          : {};
      await requireLiveAssetRelations(owner.ownerKeyHash, metadata);
      const contentHash = sha256(bytes);
      const objectPath = path.join(dirs.objects, contentHash);
      let objectExisted = true;
      try {
        await fs.access(objectPath);
      } catch {
        objectExisted = false;
        await atomicWrite(objectPath, bytes);
      }
      if (objectExisted)
        await requireStoredObjectMatch(objectPath, contentHash, bytes.length);
      const id = `asset-${crypto.randomUUID()}`;
      const manifest = {
        id,
        schemaVersion: 1,
        ownerKeyHash: owner.ownerKeyHash,
        contentHash,
        originalFilename: safeFilename(input.originalFilename),
        mimeType: String(input.mimeType || "application/octet-stream"),
        size: bytes.length,
        createdAt: now(),
        metadata,
      };
      await atomicWrite(
        path.join(dirs.manifests, `${id}.json`),
        Buffer.from(JSON.stringify(manifest, null, 2))
      );
      await appendJournal("asset.put", {
        id,
        ownerKeyHash: owner.ownerKeyHash,
        contentHash,
        size: bytes.length,
      });
      response.writeHead(objectExisted ? 200 : 201, {
        "content-type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify({ asset: manifest, deduplicated: objectExisted }));
      return;
    }
    if (
      request.method === "POST" &&
      request.url.startsWith("/api/v1/assets/raw?")
    ) {
      const owner = requireOwner(request);
      await storeRawAsset(request, response, owner);
      return;
    }
    if (
      request.method === "GET" &&
      /^\/api\/v1\/assets\/asset-[\w-]+\/meta$/.test(String(request.url))
    ) {
      const owner = requireOwner(request);
      const assetId = String(request.url).slice(
        "/api/v1/assets/".length,
        -"/meta".length,
      );
      const manifest = JSON.parse(
        await fs.readFile(path.join(dirs.manifests, `${assetId}.json`), "utf8"),
      );
      if (manifest.ownerKeyHash !== owner.ownerKeyHash)
        return reject(response, 404, "asset_not_found", "Asset not found for this account.");
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ asset: manifest }));
      return;
    }
    if (request.method === "GET" && request.url === "/api/v1/assets") {
      const owner = requireOwner(request);
      const manifests = (await ownerManifests(owner.ownerKeyHash))
        .map(({ manifest }) => manifest)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify({ assets: manifests }));
      return;
    }
    if (
      request.method === "DELETE" &&
      /^\/api\/v1\/assets\/asset-[\w-]+$/.test(String(request.url))
    ) {
      const owner = requireOwner(request);
      const assetId = decodeURIComponent(
        String(request.url).slice("/api/v1/assets/".length)
      );
      // Inspect the complete reference graph before removing anything. If one
      // manifest is unreadable we cannot prove the content-addressed object is
      // unshared, so deletion fails closed and preserves both files.
      const allManifests = await allManifestsStrict();
      const manifestPath = path.join(dirs.manifests, `${assetId}.json`);
      const manifestEntry = allManifests.find(item => item.name === `${assetId}.json`);
      if (!manifestEntry)
        return reject(response, 404, "asset_not_found", "Asset not found for this account.");
      const manifest = manifestEntry.manifest;
      if (manifest.ownerKeyHash !== owner.ownerKeyHash)
        return reject(
          response,
          404,
          "asset_not_found",
          "Asset not found for this account."
        );
      const { workspace: liveWorkspace } = await loadWorkspace(owner.ownerKeyHash);
      const liveLegacyMetadata = {
        ...liveWorkspace,
        // High-growth records become authoritative in Workspace v2 after its
        // verified one-time migration; their v1 arrays are retained only as a
        // rollback source and must not create permanent ghost references.
        instances: [],
        importRuns: [],
      };
      if (
        workspaceAssetReferences(liveLegacyMetadata).some(
          reference => reference.assetId === assetId,
        ) ||
        await workspaceV2ReferencesAsset(owner, liveWorkspace, assetId)
      )
        return reject(
          response,
          409,
          "asset_in_use",
          "Asset is still referenced by the current Workspace.",
        );
      await fs.rm(manifestPath, { force: true });
      const globallyReferenced = allManifests.some(
        item => item.name !== `${assetId}.json` && item.manifest.contentHash === manifest.contentHash,
      );
      if (!globallyReferenced)
        await fs.rm(path.join(dirs.objects, manifest.contentHash), { force: true });
      await appendJournal("asset.delete", {
        id: assetId,
        ownerKeyHash: owner.ownerKeyHash,
        contentHash: manifest.contentHash,
      });
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify({ deleted: true, assetId }));
      return;
    }
    if (
      request.method === "DELETE" &&
      /^\/api\/v1\/templates\/[a-z0-9_-]+\/assets$/i.test(String(request.url))
    ) {
      const owner = requireOwner(request);
      const templateId = decodeURIComponent(
        String(request.url).slice(
          "/api/v1/templates/".length,
          -"/assets".length
        )
      );
      const allManifests = await allManifestsStrict();
      const { workspace: liveWorkspace } = await loadWorkspace(owner.ownerKeyHash);
      const liveReferenceIds = new Set(
        workspaceAssetReferences({
          ...liveWorkspace,
          instances: [],
          importRuns: [],
        }).map(reference => reference.assetId),
      );
      for await (const reference of workspaceV2AssetReferences(owner, liveWorkspace))
        liveReferenceIds.add(reference.assetId);
      const matches = allManifests.filter(
        ({ manifest }) =>
          manifest.ownerKeyHash === owner.ownerKeyHash &&
          manifest.metadata?.templateId === templateId &&
          !liveReferenceIds.has(manifest.id)
      );
      for (const { name } of matches)
        await fs.rm(path.join(dirs.manifests, name), { force: true });
      const removedNames = new Set(matches.map(item => item.name));
      const remainingHashes = new Set(
        allManifests
          .filter(item => !removedNames.has(item.name))
          .map(item => item.manifest.contentHash),
      );
      for (const { manifest } of matches)
        if (!remainingHashes.has(manifest.contentHash))
          await fs.rm(path.join(dirs.objects, manifest.contentHash), {
            force: true,
          });
      await appendJournal("template.assets.delete", {
        templateId,
        ownerKeyHash: owner.ownerKeyHash,
        assets: matches.length,
      });
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify({ deleted: matches.length, templateId }));
      return;
    }
    if (
      request.method === "GET" &&
      /^\/api\/v1\/assets\/asset-[\w-]+$/.test(String(request.url))
    ) {
      const owner = requireOwner(request);
      const assetId = decodeURIComponent(
        String(request.url).slice("/api/v1/assets/".length)
      );
      const manifest = JSON.parse(
        await fs.readFile(path.join(dirs.manifests, `${assetId}.json`), "utf8")
      );
      if (manifest.ownerKeyHash !== owner.ownerKeyHash)
        return reject(
          response,
          404,
          "asset_not_found",
          "Asset not found for this account."
        );
      const bytes = await fs.readFile(
        path.join(dirs.objects, manifest.contentHash)
      );
      if (sha256(bytes) !== manifest.contentHash)
        return reject(
          response,
          409,
          "asset_hash_mismatch",
          "Asset content hash does not match its manifest."
        );
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
      });
      response.end(
        JSON.stringify({ asset: manifest, base64: bytes.toString("base64") })
      );
      return;
    }
    if (
      request.method === "GET" &&
      /^\/api\/v1\/assets\/asset-[\w-]+\/raw$/.test(String(request.url))
    ) {
      const owner = requireOwner(request);
      const assetId = String(request.url).slice(
        "/api/v1/assets/".length,
        -"/raw".length,
      );
      const manifest = JSON.parse(
        await fs.readFile(path.join(dirs.manifests, `${assetId}.json`), "utf8"),
      );
      if (manifest.ownerKeyHash !== owner.ownerKeyHash)
        return reject(response, 404, "asset_not_found", "Asset not found for this account.");
      const objectPath = path.join(dirs.objects, manifest.contentHash);
      const verifier = crypto.createHash("sha256");
      await pipeline(
        createReadStream(objectPath),
        new Transform({
          transform(chunk, _encoding, callback) {
            verifier.update(chunk);
            callback(null, chunk);
          },
        }),
        new Transform({ transform(_chunk, _encoding, callback) { callback(); } }),
      );
      if (verifier.digest("hex") !== manifest.contentHash)
        return reject(response, 409, "asset_hash_mismatch", "Asset content hash does not match its manifest.");
      response.writeHead(200, {
        "content-type": manifest.mimeType || "application/octet-stream",
        "content-length": String(manifest.size),
        "cache-control": "no-store",
      });
      await pipeline(createReadStream(objectPath), response);
      return;
    }
    if (request.method === "POST" && request.url === "/api/v1/integrity-scan") {
      const scan = await integrityScan();
      await appendJournal("integrity.scan", {
        healthy: scan.healthy,
        findings: scan.findings.length,
      });
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify(scan));
      return;
    }
    if (
      request.method === "POST" &&
      request.url === "/api/v1/integrity-repair"
    ) {
      const result = await repairIntegrity();
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify(result));
      return;
    }
    if (
      request.method === "POST" &&
      request.url === "/api/v1/portable-backups"
    ) {
      const owner = requireOwner(request);
      const input = await readJsonBounded(request, 64 * 1024);
      if (input?.templateId)
        return reject(
          response,
          422,
          "portable_template_stream_not_supported",
          "Large streaming backups currently support the complete account Workspace only.",
        );
      const backup = await createStreamingPortableBackup(owner, "manual");
      response.writeHead(201, {
        "content-type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify({
        id: backup.id,
        createdAt: backup.createdAt,
        filename: backup.filename,
        archiveBytes: backup.archiveBytes,
        archiveHash: backup.archiveHash,
        fileCount: backup.manifest.files.length,
        manifest: {
          id: backup.manifest.id,
          schemaVersion: backup.manifest.schemaVersion,
          scope: backup.manifest.scope,
          templateId: backup.manifest.templateId,
          createdAt: backup.manifest.createdAt,
          summary: backup.manifest.summary,
        },
      }));
      return;
    }
    if (
      request.method === "GET" &&
      /^\/api\/v1\/portable-backups\/backup-[A-Za-z0-9_-]{1,240}\/archive$/.test(
        String(request.url),
      )
    ) {
      const owner = requireOwner(request);
      const backupId = String(request.url).slice(
        "/api/v1/portable-backups/".length,
        -"/archive".length,
      );
      const metadata = await readPortableJsonFile(
        path.join(dirs.metadata, "portable-backups", `${backupId}.json`),
        64 * 1024,
        "PORTABLE_BACKUP_NOT_FOUND",
      );
      if (
        metadata?.schemaVersion !== 1 ||
        metadata?.id !== backupId ||
        metadata?.ownerKeyHash !== owner.ownerKeyHash ||
        metadata?.emergency !== false ||
        !Number.isSafeInteger(metadata?.archiveBytes) ||
        metadata.archiveBytes < 1 ||
        !PORTABLE_HASH_RE.test(String(metadata?.archiveHash ?? ""))
      )
        return reject(
          response,
          404,
          "portable_backup_not_found",
          "Portable Backup was not found for this account.",
        );
      const archivePath = path.join(dirs.backups, `${backupId}.formdigital-backup`);
      let verifiedArchive;
      try {
        verifiedArchive = await openVerifiedPortableArchive(archivePath, {
          size: metadata.archiveBytes,
          contentHash: metadata.archiveHash,
        });
      } catch {
        return reject(
          response,
          409,
          "portable_backup_corrupt",
          "Portable Backup failed its stored integrity check.",
        );
      }
      try {
        response.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": String(verifiedArchive.size),
          "content-disposition": `attachment; filename="${backupId}.formdigital-backup"`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        await pipeline(
          verifiedArchive.handle.createReadStream({
            autoClose: false,
            start: 0,
            highWaterMark: 256 * 1024,
          }),
          response,
        );
      } finally {
        await verifiedArchive.handle.close().catch(() => {});
      }
      return;
    }
    if (
      request.method === "POST" &&
      request.url === "/api/v1/portable-restore-sessions"
    ) {
      const owner = requireOwner(request);
      if (!/^application\/octet-stream(?:\s*;|$)/i.test(
        String(request.headers["content-type"] ?? ""),
      ))
        return reject(
          response,
          415,
          "portable_archive_content_type_required",
          "Portable Backup upload requires application/octet-stream.",
        );
      let session;
      try {
        session = await createPortableRestoreSession(owner, request);
      } catch {
        return reject(
          response,
          422,
          "portable_archive_rejected",
          "Portable Backup failed bounded verification. No change was made.",
        );
      }
      response.writeHead(201, {
        "content-type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify(session));
      return;
    }
    const portableSessionMatch = /^\/api\/v1\/portable-restore-sessions\/([0-9a-f-]{36})$/.exec(
      String(request.url),
    );
    if (request.method === "DELETE" && portableSessionMatch) {
      const owner = requireOwner(request);
      try {
        await deletePortableRestoreSession(owner.ownerKeyHash, portableSessionMatch[1]);
      } catch {
        return reject(
          response,
          404,
          "portable_restore_session_not_found",
          "Portable restore session is unavailable.",
        );
      }
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify({ deleted: true }));
      return;
    }
    const portableCommitMatch = /^\/api\/v1\/portable-restore-sessions\/([0-9a-f-]{36})\/commit$/.exec(
      String(request.url),
    );
    if (request.method === "POST" && portableCommitMatch) {
      const owner = requireOwner(request);
      let restored;
      try {
        restored = await restoreStreamingPortableBackup(
          owner,
          portableCommitMatch[1],
        );
        legacyWorkspaceCompactionChecks.delete(owner.ownerKeyHash);
      } catch (error) {
        return reject(
          response,
          422,
          "portable_restore_rejected",
          error && typeof error === "object" && typeof error.safeMessage === "string"
            ? error.safeMessage
            : "Portable Backup restore was rejected. No change was made.",
        );
      }
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify(restored));
      return;
    }
    if (request.method === "POST" && request.url === "/api/v1/backups") {
      const input = await readJson(request);
      const headerOwner = String(
        request.headers["x-formdigital-owner"] || ""
      ).trim();
      const portableOwner = headerOwner && input.portable
        ? requireOwner(request)
        : null;
      if (portableOwner)
        await prepareLegacyWorkspaceForV2(portableOwner);
      const backup =
        portableOwner
          ? await createPortableBackup(
              portableOwner,
              "manual",
              input.templateId ? String(input.templateId) : null
            )
          : await createBackup();
      response.writeHead(201, {
        "content-type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify(backup));
      return;
    }
    if (request.method === "POST" && request.url === "/api/v1/restore") {
      const input = await readJson(request);
      if (input.archiveBase64) {
        const owner = requireOwner(request);
        let restoredPortable;
        try {
          restoredPortable = await restorePortableBackup(
            owner.ownerKeyHash,
            decodeLegacyPortableBase64(input.archiveBase64),
            { preserveExistingAssets: Boolean(input.preserveExistingAssets) }
          );
          legacyWorkspaceCompactionChecks.delete(owner.ownerKeyHash);
        } catch (error) {
          if (
            error &&
            typeof error === "object" &&
            error.statusCode === 413 &&
            error.publicCode === "portable_backup_requires_streaming"
          )
            return reject(
              response,
              413,
              error.publicCode,
              error.safeMessage,
            );
          // Only a curated safeMessage is ever echoed: a raw failure can carry
          // absolute paths, staging filenames, tokens or owner hashes.
          return reject(
            response,
            422,
            "portable_restore_rejected",
            error &&
              typeof error === "object" &&
              typeof error.safeMessage === "string"
              ? error.safeMessage
              : "Portable Backup restore was rejected. No change was made."
          );
        }
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
        });
        response.end(JSON.stringify(restoredPortable));
        return;
      }
      let restored;
      try {
        restored = await restoreBackup(input.backupId);
        legacyWorkspaceCompactionChecks.clear();
        pendingV2HistoryOwners.clear();
      } catch (error) {
        throw error;
      }
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify(restored));
      return;
    }
    if (request.method === "POST" && request.url === "/api/v1/ocr/tesseract") {
      const result = await runLocalTesseract(await readJson(request));
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify(result));
      return;
    }
    reject(response, 404, "not_found", "Local service route not found.");
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
    if (code === "WORKSPACE_REVISION_CONFLICT")
      reject(response, 409, "workspace_revision_conflict", "Workspace data changed; retry the operation.");
    else if (code === "ENOENT")
      reject(response, 404, "not_found", "Requested local data was not found.");
    else if (
      error &&
      typeof error === "object" &&
      "statusCode" in error &&
      Number.isInteger(error.statusCode) &&
      error.statusCode >= 400 &&
      error.statusCode <= 599 &&
      "publicCode" in error &&
      typeof error.publicCode === "string" &&
      /^[a-z0-9_]{1,80}$/.test(error.publicCode)
    )
      reject(
        response,
        error.statusCode,
        error.publicCode,
        typeof error.safeMessage === "string"
          ? error.safeMessage
          : "Local data request was rejected.",
      );
    else {
      // The response stays detail-free on purpose: a raw failure can carry
      // absolute paths, owner hashes or staging filenames. The cause still has
      // to exist somewhere, though — without this an unexpected fault left no
      // trace at all, in the service, the browser, or on disk.
      console.error(
        `[local-data-service] ${request.method} ${String(request.url).split("?")[0]} failed:`,
        error && typeof error === "object" && "stack" in error ? error.stack : error
      );
      reject(
        response,
        500,
        "local_service_error",
        "Local data operation failed. No internal details were returned."
      );
    }
  }
}

if (rootAvailable) {
  await recoverPortableRestoreTransactions();
  await cleanupExpiredPortableSessions();
}

function workspaceV2ReadRequiresMigration(request) {
  if (!rootAvailable) return false;
  const url = new URL(String(request.url), "http://127.0.0.1");
  const readRoute =
    (request.method === "GET" &&
      (url.pathname === "/api/v2/workspace/describe" ||
        url.pathname === "/api/v2/workspace/export")) ||
    (request.method === "POST" &&
      (url.pathname === "/api/v2/workspace/query" ||
        url.pathname === "/api/v2/workspace/query-many" ||
        url.pathname === "/api/v2/workspace/internal-journal-stream"));
  if (!readRoute) return false;
  const ownerKey = String(request.headers["x-formdigital-owner"] || "").trim();
  if (!ownerKey || ownerKey.length > 512) return false;
  const hash = ownerKeyHash(ownerKey);
  const databasePath = path.join(
    dirs["workspace-v2"],
    hash,
    "workspace-v2.sqlite",
  );
  const legacyExists = existsSync(accountPaths(hash).workspace);
  return (
    legacyExists &&
    (!existsSync(databasePath) || !legacyWorkspaceCompactionChecks.has(hash))
  );
}

function workspaceV1ReadRequiresCompactionCheck(request) {
  if (
    !rootAvailable ||
    request.method !== "GET" ||
    request.url !== "/api/v1/workspace"
  )
    return false;
  const ownerKey = String(request.headers["x-formdigital-owner"] || "").trim();
  if (!ownerKey || ownerKey.length > 512) return false;
  const hash = ownerKeyHash(ownerKey);
  return (
    !legacyWorkspaceCompactionChecks.has(hash) &&
    existsSync(accountPaths(hash).workspace)
  );
}

const server = http.createServer((request, response) => {
  // Health is intentionally lock-free so a long import or backup never makes
  // the launcher think the service is dead. Every other request participates
  // in a writer-preferring service-wide read/write gate. This makes backup,
  // restore and Data Folder moves a coherent snapshot with respect to all
  // Workspace/asset mutations, including streamed upload commits.
  const isHealth = request.method === "GET" && request.url === "/health";
  const isReadOnlyOcr =
    request.method === "POST" && request.url === "/api/v1/ocr/tesseract";
  const isWorkspaceV2Read =
    (request.method === "GET" &&
      (request.url === "/api/v2/workspace/describe" ||
        request.url?.startsWith("/api/v2/workspace/export"))) ||
    (request.method === "POST" &&
      (request.url === "/api/v2/workspace/query" ||
        request.url === "/api/v2/workspace/query-many" ||
        request.url === "/api/v2/workspace/internal-journal-stream"));
  const isWorkspaceV2MigrationWrite =
    isWorkspaceV2Read && workspaceV2ReadRequiresMigration(request);
  const isWorkspaceV1CompactionWrite =
    workspaceV1ReadRequiresCompactionCheck(request);
  const isReadOnlyWorkspaceV2 =
    isWorkspaceV2Read && !isWorkspaceV2MigrationWrite;
  const isPortableSessionUpload =
    request.method === "POST" &&
    request.url === "/api/v1/portable-restore-sessions";
  const isMutation =
    isWorkspaceV2MigrationWrite ||
    isWorkspaceV1CompactionWrite ||
    (request.method !== "GET" &&
      request.method !== "OPTIONS" &&
      !isReadOnlyOcr &&
      !isReadOnlyWorkspaceV2 &&
      !isPortableSessionUpload);
  const operation = () => handleRequest(request, response);
  void (isHealth ? operation() : withDataGate(isMutation, operation));
});

server.listen(Number(config.port || 4317), "127.0.0.1", () => {
  console.log(
    `Formdigital Local Data Folder service listening on http://127.0.0.1:${config.port || 4317}`
  );
});
