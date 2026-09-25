import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const STORAGE_SCHEMA_VERSION = 2;
export const WORKSPACE_SCHEMA_VERSION = 2;

export const COLLECTIONS = Object.freeze([
  "templates",
  "templateVersions",
  "fields",
  "instances",
  "folders",
  "tags",
  "savedValues",
  "mappingTemplates",
  "importRuns",
  "importRows",
  "mappingDecisions",
  "detectionRuns",
  "operationJournal",
]);

export const INDEXED_QUERY_KEYS = Object.freeze([
  "id",
  "templateId",
  "templateVersionId",
  "importRunId",
  "rowNumber",
  "status",
  "valuesHash",
]);

export const META_KEYS = Object.freeze([
  "schemaVersion",
  "ownerKey",
  "createdAt",
  "updatedAt",
  "preferences",
]);

const COLLECTION_SET = new Set(COLLECTIONS);
const INDEX_SET = new Set(INDEXED_QUERY_KEYS);
const META_KEY_SET = new Set(META_KEYS);
const MAX_OWNER_BYTES = 512;
const MAX_ID_BYTES = 1_024;
const MAX_RECORD_BYTES = 1024 * 1024;
export const MAX_TRANSACTION_BYTES = 16 * 1024 * 1024;
export const JOURNAL_ARCHIVE_MAX_BATCH_COUNT = 1_000;
export const JOURNAL_ARCHIVE_MAX_BATCH_BYTES = 12 * 1024 * 1024;
export const LEGACY_WORKSPACE_JOURNAL_MAX_RECORD_BYTES = 64 * 1024;
// Hard per-page ceiling for the internal journal stream. A single legal record
// is at most MAX_RECORD_BYTES, so this budget always leaves room for one and
// pagination can never stall on an ordinary record.
export const JOURNAL_INTERNAL_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
// Safety margin reserved for the JSON-encoded nextCursor value. The cursor is
// derived purely from small integers plus a fixed-length HMAC secret, so this
// bound is a hard ceiling rather than an estimate.
const JOURNAL_INTERNAL_CURSOR_SAFE_BYTES = 1_024;
// The byte ceiling remains the primary memory bound. 12,000 operations also
// permits one atomic 5,000-instance migration (put + delete + meta) without
// forcing a partially committed multi-transaction workflow.
const MAX_TRANSACTION_OPS = 12_000;
const MAX_QUERY_LIMIT = 1_000;
const MAX_MULTI_QUERY_VALUES = 1_000;
const MAX_MULTI_QUERY_RESULTS = 2_000;
const MAX_COMPAT_RECORDS = 10_000;
const MAX_COMPAT_BYTES = 16 * 1024 * 1024;
// Legacy JSON is necessarily parsed once during migration. Keep that one-time
// compatibility path explicitly bounded above the v1 50 MiB envelope ceiling.
const MAX_LEGACY_BYTES = 64 * 1024 * 1024;
const CURSOR_VERSION = 1;
const MAX_APPLIED_TRANSACTIONS = 100_000;
const APPLIED_TRANSACTION_PRUNE_INTERVAL = 1_024;

export function calculateCanonicalTransactionBytes(transactionInput) {
  const puts = (transactionInput.put || []).map(p => ({
    collection: p.collection,
    id: p.id ?? p.record?.id,
    record: p.record,
  }));
  const deletes = transactionInput.deleteIds || [];
  const metaPatch = transactionInput.metaPatch || {};
  const requestForHash = {
    expectedRevision: transactionInput.expectedRevision ?? 0,
    transactionId: transactionInput.transactionId ?? "",
    put: puts,
    deleteIds: deletes,
    metaPatch,
  };
  return Buffer.byteLength(canonicalJson(requestForHash), "utf8");
}

// Archive wrapper discriminator. The same contract is declared by the display
// path (repository.ts) and the writer (local-data-service.mjs); it is restated
// here so the batch planner can measure wrappers without depending on either.
export const JOURNAL_ARCHIVE_RECORD_TYPE = "formdigital.operation-journal-archive";
export const JOURNAL_ARCHIVE_SCHEMA_VERSION = 1;
export const JOURNAL_ARCHIVE_ID_PATTERN = /^journal-archive-r\d+-i\d+-[a-f0-9]+$/i;

/**
 * Strict archive-wrapper discriminator. Mirrors the unwrap rules used by the
 * display path so that an ordinary business record that merely happens to
 * carry an `archivedEntry` property is never mistaken for a wrapper.
 */
export function isJournalArchiveWrapper(record) {
  if (!isPlainObject(record)) return false;
  const hasEntry =
    isPlainObject(record.archivedEntry) &&
    typeof record.archivedAt === "string" &&
    record.archivedAt.length > 0 &&
    typeof record.id === "string";
  if (!hasEntry) return false;
  if (record.recordType === JOURNAL_ARCHIVE_RECORD_TYPE) {
    return (
      record.schemaVersion === JOURNAL_ARCHIVE_SCHEMA_VERSION &&
      JOURNAL_ARCHIVE_ID_PATTERN.test(record.id)
    );
  }
  if (record.recordType !== undefined) return false;
  if (!(record.id.startsWith("journal-archive-") || record.id.startsWith("archive-wrap"))) return false;
  // Legacy wrappers are recognised only as an exact 3-key structure.
  return Object.keys(record).every(key => key === "id" || key === "archivedAt" || key === "archivedEntry");
}

/**
 * Bytes that the 64 KiB business limit applies to: the original history entry
 * for a recognised archive wrapper, and the whole record for anything else.
 *
 * The system wrapper is not free, but it is not the operator's data either, so
 * it is bounded separately by the Workspace v2 record ceiling (1 MiB). Without
 * this split, an entry the v1 path already accepted could become impossible to
 * archive later purely because of wrapper overhead.
 */
export function journalArchiveMeasuredBytes(record) {
  if (isJournalArchiveWrapper(record)) return utf8Size(canonicalJson(record.archivedEntry));
  return null;
}

export function formatJournalArchiveTransactionId(expectedWorkspaceRevision, batchIndex, recordIds) {
  const canonicalIdentity = canonicalJson({
    expectedWorkspaceRevision,
    batchIndex,
    recordIds,
  });
  const batchDigest = sha256(canonicalIdentity).slice(0, 24);
  return `journal-archive-r${expectedWorkspaceRevision}-b${batchIndex}-${batchDigest}`;
}

export function planJournalArchiveBatches(records, options = {}) {
  const maxBatchCount = options.maxBatchCount ?? JOURNAL_ARCHIVE_MAX_BATCH_COUNT;
  const maxBatchBytes = options.maxBatchBytes ?? JOURNAL_ARCHIVE_MAX_BATCH_BYTES;
  const maxRecordBytes = options.maxRecordBytes ?? LEGACY_WORKSPACE_JOURNAL_MAX_RECORD_BYTES;
  const expectedRevision = Number.isSafeInteger(options.expectedRevision) ? options.expectedRevision : 0;
  const worstCaseRevision = Number.MAX_SAFE_INTEGER;

  const batches = [];
  let currentPuts = [];

  for (const putItem of records) {
    const recordBytes = Buffer.byteLength(canonicalJson(putItem.record), "utf8");
    // The wrapper is a system envelope, not operator data. It is bounded by the
    // Workspace v2 record ceiling; the 64 KiB business limit is measured
    // against the original entry it carries.
    if (recordBytes > MAX_RECORD_BYTES) {
      const error = new Error("Operation journal record exceeds the maximum allowed record size.");
      error.code = "RECORD_TOO_LARGE";
      error.status = 413;
      error.statusCode = 413;
      error.publicCode = "record_too_large";
      error.safeMessage = "Operation journal record exceeds the maximum allowed record size.";
      throw error;
    }
    const measuredBytes = journalArchiveMeasuredBytes(putItem.record) ?? recordBytes;
    if (measuredBytes > maxRecordBytes) {
      const error = new Error("Operation journal record exceeds the maximum allowed record size.");
      error.code = "RECORD_TOO_LARGE";
      error.status = 413;
      error.statusCode = 413;
      error.publicCode = "record_too_large";
      error.safeMessage = "Operation journal record exceeds the maximum allowed record size.";
      throw error;
    }

    const testPuts = [...currentPuts, putItem];
    const testRecordIds = testPuts.map(p => p.id ?? p.record?.id ?? "");
    const testTxId = formatJournalArchiveTransactionId(worstCaseRevision, batches.length, testRecordIds);
    const testBytes = calculateCanonicalTransactionBytes({
      expectedRevision: worstCaseRevision,
      transactionId: testTxId,
      put: testPuts,
    });

    if (
      currentPuts.length >= maxBatchCount ||
      (currentPuts.length > 0 && testBytes > maxBatchBytes)
    ) {
      const batchRecordIds = currentPuts.map(p => p.id ?? p.record?.id ?? "");
      const batchTxId = formatJournalArchiveTransactionId(expectedRevision, batches.length, batchRecordIds);
      batches.push({
        puts: currentPuts,
        transactionId: batchTxId,
        recordIds: batchRecordIds,
        serializedRequestBytes: calculateCanonicalTransactionBytes({
          expectedRevision,
          transactionId: batchTxId,
          put: currentPuts,
        }),
        itemCount: currentPuts.length,
      });
      currentPuts = [putItem];
    } else {
      currentPuts.push(putItem);
    }
  }

  if (currentPuts.length > 0) {
    const batchRecordIds = currentPuts.map(p => p.id ?? p.record?.id ?? "");
    const batchTxId = formatJournalArchiveTransactionId(expectedRevision, batches.length, batchRecordIds);
    batches.push({
      puts: currentPuts,
      transactionId: batchTxId,
      recordIds: batchRecordIds,
      serializedRequestBytes: calculateCanonicalTransactionBytes({
        expectedRevision,
        transactionId: batchTxId,
        put: currentPuts,
      }),
      itemCount: currentPuts.length,
    });
  }

  return batches;
}

export class WorkspaceStorageError extends Error {
  constructor(code) {
    super(code);
    Object.defineProperty(this, "code", {
      value: code,
      enumerable: true,
      configurable: false,
      writable: false,
    });
    Object.defineProperty(this, "message", {
      value: code,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
}

function fail(code) {
  throw new WorkspaceStorageError(code);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function canonicalJson(value) {
  const active = new WeakSet();

  function visit(input) {
    if (input === null) return "null";
    if (typeof input === "string") return JSON.stringify(input);
    if (typeof input === "boolean") return input ? "true" : "false";
    if (typeof input === "number") {
      if (!Number.isFinite(input)) fail("INVALID_JSON_VALUE");
      return Object.is(input, -0) ? "0" : JSON.stringify(input);
    }
    if (typeof input !== "object") fail("INVALID_JSON_VALUE");
    if (active.has(input)) fail("INVALID_JSON_VALUE");
    active.add(input);
    try {
      if (Array.isArray(input)) {
        if (Object.getPrototypeOf(input) !== Array.prototype) fail("INVALID_JSON_VALUE");
        const descriptors = Object.getOwnPropertyDescriptors(input);
        if (Reflect.ownKeys(input).some(key => typeof key === "symbol")) fail("INVALID_JSON_VALUE");
        const length = descriptors.length;
        if (!length || "get" in length || length.value !== input.length) fail("INVALID_JSON_VALUE");
        const parts = [];
        for (let index = 0; index < input.length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || "get" in descriptor || !descriptor.enumerable) fail("INVALID_JSON_VALUE");
          parts.push(visit(descriptor.value));
        }
        const allowed = new Set(["length", ...Array.from({ length: input.length }, (_, index) => String(index))]);
        for (const key of Object.keys(descriptors)) if (!allowed.has(key)) fail("INVALID_JSON_VALUE");
        return `[${parts.join(",")}]`;
      }
      if (!isPlainObject(input)) fail("INVALID_JSON_VALUE");
      if (Reflect.ownKeys(input).some(key => typeof key === "symbol")) fail("INVALID_JSON_VALUE");
      const descriptors = Object.getOwnPropertyDescriptors(input);
      const keys = Object.keys(descriptors).sort();
      const parts = [];
      for (const key of keys) {
        if (key === "__proto__" || key === "prototype" || key === "constructor") fail("INVALID_JSON_VALUE");
        const descriptor = descriptors[key];
        if ("get" in descriptor || !descriptor.enumerable) fail("INVALID_JSON_VALUE");
        parts.push(`${JSON.stringify(key)}:${visit(descriptor.value)}`);
      }
      return `{${parts.join(",")}}`;
    } finally {
      active.delete(input);
    }
  }

  return visit(value);
}

function parseStoredJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    fail("STORAGE_CORRUPT");
  }
}

function utf8Size(value) {
  return Buffer.byteLength(value, "utf8");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function ownerHash(ownerKey) {
  if (typeof ownerKey !== "string" || utf8Size(ownerKey) < 1 || utf8Size(ownerKey) > MAX_OWNER_BYTES) {
    fail("INVALID_OWNER");
  }
  return sha256(Buffer.from(ownerKey, "utf8"));
}

function assertCollection(collection) {
  if (typeof collection !== "string" || !COLLECTION_SET.has(collection)) fail("INVALID_COLLECTION");
  return collection;
}

function assertRecordId(value) {
  if (typeof value !== "string" || value.length === 0 || utf8Size(value) > MAX_ID_BYTES) fail("INVALID_RECORD_ID");
  return value;
}

function assertMetaKey(value) {
  if (typeof value !== "string" || !META_KEY_SET.has(value)) {
    fail("INVALID_META_KEY");
  }
  return value;
}

function scalarIndexValue(value) {
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "boolean") return canonicalJson(value);
  if (typeof value === "number" && Number.isFinite(value)) return canonicalJson(value);
  fail("INVALID_INDEX_VALUE");
}

function normalizeRecordPut(entry) {
  if (!isPlainObject(entry) || !isPlainObject(entry.record)) fail("INVALID_TRANSACTION");
  const collection = assertCollection(entry.collection);
  const recordJson = canonicalJson(entry.record);
  const byteLength = utf8Size(recordJson);
  if (byteLength > MAX_RECORD_BYTES) fail("RECORD_TOO_LARGE");
  const payload = parseStoredJson(recordJson);
  const id = assertRecordId(entry.id ?? payload.id);
  if (payload.id !== undefined && payload.id !== id) fail("INVALID_RECORD_ID");
  const indexes = Object.fromEntries(INDEXED_QUERY_KEYS.map(key => [key, scalarIndexValue(payload[key])]));
  if (indexes.id === null) indexes.id = scalarIndexValue(id);
  return { collection, id, recordJson, byteLength, indexes };
}

function normalizeTransaction(input) {
  if (!isPlainObject(input)) fail("INVALID_TRANSACTION");
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) fail("INVALID_REVISION");
  if (typeof input.transactionId !== "string" || input.transactionId.length < 1 || utf8Size(input.transactionId) > 256) {
    fail("INVALID_TRANSACTION_ID");
  }
  const puts = input.put === undefined ? [] : input.put;
  const deletes = input.deleteIds === undefined ? [] : input.deleteIds;
  if (!Array.isArray(puts) || !Array.isArray(deletes)) fail("INVALID_TRANSACTION");
  const normalizedPuts = puts.map(normalizeRecordPut);
  const normalizedDeletes = [];
  for (const entry of deletes) {
    if (!isPlainObject(entry) || !Array.isArray(entry.ids)) fail("INVALID_TRANSACTION");
    const collection = assertCollection(entry.collection);
    for (const id of entry.ids) normalizedDeletes.push({ collection, id: assertRecordId(id) });
  }
  const metaPatch = input.metaPatch === undefined ? {} : input.metaPatch;
  if (!isPlainObject(metaPatch)) fail("INVALID_TRANSACTION");
  const normalizedMeta = [];
  for (const key of Object.keys(metaPatch).sort()) {
    assertMetaKey(key);
    if (Array.isArray(metaPatch[key])) fail("INVALID_META_VALUE");
    if (key === "schemaVersion" && metaPatch[key] !== WORKSPACE_SCHEMA_VERSION) fail("UNSUPPORTED_WORKSPACE_SCHEMA");
    const json = canonicalJson(metaPatch[key]);
    if (utf8Size(json) > MAX_RECORD_BYTES) fail("RECORD_TOO_LARGE");
    normalizedMeta.push({ key, json });
  }
  const operationCount = normalizedPuts.length + normalizedDeletes.length + normalizedMeta.length;
  if (operationCount < 1) fail("EMPTY_TRANSACTION");
  if (operationCount > MAX_TRANSACTION_OPS) fail("TRANSACTION_TOO_LARGE");
  const requestForHash = {
    expectedRevision: input.expectedRevision,
    transactionId: input.transactionId,
    put: normalizedPuts.map(value => ({ collection: value.collection, id: value.id, record: parseStoredJson(value.recordJson) })),
    deleteIds: normalizedDeletes,
    metaPatch: Object.fromEntries(normalizedMeta.map(value => [value.key, parseStoredJson(value.json)])),
  };
  const requestJson = canonicalJson(requestForHash);
  if (utf8Size(requestJson) > MAX_TRANSACTION_BYTES) fail("TRANSACTION_TOO_LARGE");
  return {
    expectedRevision: input.expectedRevision,
    transactionId: input.transactionId,
    requestHash: sha256(requestJson),
    puts: normalizedPuts,
    deletes: normalizedDeletes,
    meta: normalizedMeta,
    operationCount,
  };
}

function configureDatabase(db, { readOnly = false } = {}) {
  db.exec("PRAGMA foreign_keys = ON");
  if (!readOnly) {
    db.exec("PRAGMA journal_mode = DELETE");
    db.exec("PRAGMA synchronous = FULL");
  }
  db.exec("PRAGMA busy_timeout = 5000");
}

function createSchema(db, expectedOwnerHash, initialRevision = 0, initialWorkspaceSchema = WORKSPACE_SCHEMA_VERSION) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS control (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      storage_schema_version INTEGER NOT NULL,
      workspace_schema_version INTEGER NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 0),
      owner_hash TEXT NOT NULL,
      cursor_secret TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspace_meta (
      key TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      byte_length INTEGER NOT NULL CHECK (byte_length >= 0)
    );
    CREATE TABLE IF NOT EXISTS workspace_records (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      collection TEXT NOT NULL,
      record_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
      idx_id TEXT,
      idx_templateId TEXT,
      idx_templateVersionId TEXT,
      idx_importRunId TEXT,
      idx_rowNumber TEXT,
      idx_status TEXT,
      idx_valuesHash TEXT,
      UNIQUE(collection, record_id)
    );
    CREATE TABLE IF NOT EXISTS applied_transactions (
      transaction_id TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      base_revision INTEGER NOT NULL,
      result_revision INTEGER NOT NULL,
      operation_count INTEGER NOT NULL,
      applied_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS records_collection_sequence ON workspace_records(collection, sequence);
    CREATE INDEX IF NOT EXISTS records_id ON workspace_records(collection, idx_id, sequence);
    CREATE INDEX IF NOT EXISTS records_templateId ON workspace_records(collection, idx_templateId, sequence);
    CREATE INDEX IF NOT EXISTS records_templateVersionId ON workspace_records(collection, idx_templateVersionId, sequence);
    CREATE INDEX IF NOT EXISTS records_importRunId ON workspace_records(collection, idx_importRunId, sequence);
    CREATE INDEX IF NOT EXISTS records_rowNumber ON workspace_records(collection, idx_rowNumber, sequence);
    CREATE INDEX IF NOT EXISTS records_status ON workspace_records(collection, idx_status, sequence);
    CREATE INDEX IF NOT EXISTS records_valuesHash ON workspace_records(collection, idx_valuesHash, sequence);
  `);
  const existing = db.prepare("SELECT * FROM control WHERE singleton = 1").get();
  if (!existing) {
    db.prepare(`INSERT INTO control
      (singleton, storage_schema_version, workspace_schema_version, revision, owner_hash, cursor_secret, created_at)
      VALUES (1, ?, ?, ?, ?, ?, ?)`)
      .run(STORAGE_SCHEMA_VERSION, initialWorkspaceSchema, initialRevision, expectedOwnerHash, crypto.randomBytes(32).toString("hex"), new Date().toISOString());
  }
  db.exec(`PRAGMA user_version = ${STORAGE_SCHEMA_VERSION}`);
}

function verifyOpenDatabase(db, expectedOwnerHash) {
  const userVersion = Number(db.prepare("PRAGMA user_version").get().user_version);
  if (userVersion > STORAGE_SCHEMA_VERSION || userVersion < 1) fail("UNSUPPORTED_STORAGE_SCHEMA");
  const control = db.prepare("SELECT * FROM control WHERE singleton = 1").get();
  if (!control || Number(control.storage_schema_version) !== STORAGE_SCHEMA_VERSION) fail("UNSUPPORTED_STORAGE_SCHEMA");
  if (Number(control.workspace_schema_version) > WORKSPACE_SCHEMA_VERSION) fail("UNSUPPORTED_WORKSPACE_SCHEMA");
  if (control.owner_hash !== expectedOwnerHash) fail("OWNER_MISMATCH");
  const integrity = db.prepare("PRAGMA integrity_check").all();
  if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") fail("INTEGRITY_CHECK_FAILED");
  return control;
}

function openDatabaseFile(databasePath, expectedOwnerHash, options = {}) {
  const exists = fs.existsSync(databasePath);
  const readOnly = options.readOnly === true;
  if (readOnly && !exists) fail("STORAGE_NOT_FOUND");
  const db = new DatabaseSync(databasePath, {
    readOnly,
    timeout: 5_000,
  });
  try {
    configureDatabase(db, { readOnly });
    if (!exists) createSchema(db, expectedOwnerHash, options.revision, options.workspaceSchemaVersion);
    const control = verifyOpenDatabase(db, expectedOwnerHash);
    return { db, control };
  } catch (error) {
    db.close();
    if (error instanceof WorkspaceStorageError) throw error;
    fail("STORAGE_OPEN_FAILED");
  }
}

export function inspectWorkspaceStorageV2File({ databasePath, ownerHash: expectedOwnerHash }) {
  if (typeof databasePath !== "string" || databasePath.length === 0) fail("INVALID_STORAGE_ROOT");
  if (typeof expectedOwnerHash !== "string" || !/^[a-f0-9]{64}$/.test(expectedOwnerHash))
    fail("INVALID_OWNER");
  const hash = expectedOwnerHash;
  const { db } = openDatabaseFile(path.resolve(databasePath), hash, { readOnly: true });
  try {
    const control = verifyOpenDatabase(db, hash);
    return Object.freeze({
      storageSchemaVersion: Number(control.storage_schema_version),
      schemaVersion: Number(control.workspace_schema_version),
      revision: Number(control.revision),
    });
  } finally {
    db.close();
  }
}

export function ownerWorkspaceV2Paths(rootDir, ownerKey) {
  if (typeof rootDir !== "string" || rootDir.length === 0) fail("INVALID_STORAGE_ROOT");
  const hash = ownerHash(ownerKey);
  const ownerDirectory = path.join(path.resolve(rootDir), "workspace-v2", hash);
  return Object.freeze({
    ownerHash: hash,
    ownerDirectory,
    databasePath: path.join(ownerDirectory, "workspace-v2.sqlite"),
    legacyCopyPath: path.join(ownerDirectory, "legacy-workspace.json"),
  });
}

function ownerWorkspaceV2PathsFromHash(rootDir, hash) {
  if (typeof rootDir !== "string" || rootDir.length === 0) fail("INVALID_STORAGE_ROOT");
  if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) fail("INVALID_OWNER");
  const ownerDirectory = path.join(path.resolve(rootDir), "workspace-v2", hash);
  return Object.freeze({
    ownerHash: hash,
    ownerDirectory,
    databasePath: path.join(ownerDirectory, "workspace-v2.sqlite"),
    legacyCopyPath: path.join(ownerDirectory, "legacy-workspace.json"),
  });
}

function encodeCursor(payload, secret) {
  const body = Buffer.from(canonicalJson(payload), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function decodeCursor(token, secret) {
  try {
    if (typeof token !== "string" || token.length > 4_096) fail("INVALID_CURSOR");
    const parts = token.split(".");
    if (parts.length !== 2) fail("INVALID_CURSOR");
    const expected = crypto.createHmac("sha256", secret).update(parts[0]).digest();
    const actual = Buffer.from(parts[1], "base64url");
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) fail("INVALID_CURSOR");
    const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (!isPlainObject(payload) || payload.v !== CURSOR_VERSION) fail("INVALID_CURSOR");
    return payload;
  } catch (error) {
    if (error instanceof WorkspaceStorageError) throw error;
    fail("INVALID_CURSOR");
  }
}

function publicBoundary(operation, fallback = "STORAGE_FAILURE") {
  try {
    return operation();
  } catch (error) {
    if (error instanceof WorkspaceStorageError) throw error;
    fail(fallback);
  }
}

export class WorkspaceStorageV2 {
  #db;
  #paths;
  #closed = false;

  constructor({
    rootDir,
    ownerKey,
    ownerHash: suppliedOwnerHash,
    databasePath: suppliedDatabasePath,
    readOnly = false,
    ephemeral = false,
  }) {
    try {
      if (ephemeral) {
        if (readOnly || suppliedDatabasePath !== undefined || suppliedOwnerHash !== undefined)
          fail("INVALID_STORAGE_ROOT");
        const paths = ownerWorkspaceV2Paths(rootDir, ownerKey);
        const { db } = openDatabaseFile(":memory:", paths.ownerHash, {
          revision: 0,
          workspaceSchemaVersion: WORKSPACE_SCHEMA_VERSION,
        });
        this.#db = db;
        this.#paths = paths;
        return;
      }
      let paths;
      if (suppliedDatabasePath !== undefined) {
        if (
          !readOnly ||
          typeof suppliedDatabasePath !== "string" ||
          suppliedDatabasePath.length === 0 ||
          typeof suppliedOwnerHash !== "string" ||
          !/^[a-f0-9]{64}$/.test(suppliedOwnerHash)
        )
          fail("INVALID_STORAGE_ROOT");
        const databasePath = path.resolve(suppliedDatabasePath);
        const ownerDirectory = path.dirname(databasePath);
        paths = Object.freeze({
          ownerHash: suppliedOwnerHash,
          ownerDirectory,
          databasePath,
          legacyCopyPath: path.join(ownerDirectory, "legacy-workspace.json"),
        });
      } else {
        paths = suppliedOwnerHash === undefined
          ? ownerWorkspaceV2Paths(rootDir, ownerKey)
          : ownerWorkspaceV2PathsFromHash(rootDir, suppliedOwnerHash);
      }
      if (!readOnly) fs.mkdirSync(paths.ownerDirectory, { recursive: true });
      const { db } = openDatabaseFile(paths.databasePath, paths.ownerHash, { readOnly });
      this.#db = db;
      this.#paths = paths;
    } catch (error) {
      if (error instanceof WorkspaceStorageError) throw error;
      fail("STORAGE_OPEN_FAILED");
    }
  }

  static open(options) {
    return new WorkspaceStorageV2(options);
  }

  static openEphemeral(options) {
    return new WorkspaceStorageV2({ ...options, ephemeral: true });
  }

  static openByOwnerHash(options) {
    return new WorkspaceStorageV2(options);
  }

  static openExistingReadOnly(options) {
    return new WorkspaceStorageV2({ ...options, readOnly: true });
  }

  static openFileReadOnly(options) {
    return new WorkspaceStorageV2({ ...options, readOnly: true });
  }

  get paths() {
    return this.#paths;
  }

  #assertOpen() {
    if (this.#closed) fail("STORAGE_CLOSED");
  }

  close() {
    if (this.#closed) return;
    this.#db.close();
    this.#closed = true;
  }

  describe() {
    return publicBoundary(() => {
      this.#assertOpen();
      const row = this.#db.prepare(`SELECT storage_schema_version, workspace_schema_version, revision
        FROM control WHERE singleton = 1`).get();
      return Object.freeze({
        storageSchemaVersion: Number(row.storage_schema_version),
        schemaVersion: Number(row.workspace_schema_version),
        revision: Number(row.revision),
      });
    });
  }

  integrityCheck() {
    return publicBoundary(() => {
      this.#assertOpen();
      const rows = this.#db.prepare("PRAGMA integrity_check").all();
      if (rows.length !== 1 || rows[0].integrity_check !== "ok") fail("INTEGRITY_CHECK_FAILED");
      return true;
    });
  }

  async readSnapshot(operation) {
    this.#assertOpen();
    if (typeof operation !== "function") fail("INVALID_QUERY");
    this.#db.exec("BEGIN");
    try {
      const revision = this.describe().revision;
      const result = await operation(this, revision);
      if (this.describe().revision !== revision) fail("STALE_CURSOR");
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {}
      if (error instanceof WorkspaceStorageError) throw error;
      throw error;
    }
  }

  getAppliedTransaction(transactionId) {
    return publicBoundary(() => {
      this.#assertOpen();
      if (typeof transactionId !== "string" || !transactionId) return null;
      const row = this.#db.prepare(`SELECT transaction_id, request_hash, base_revision, result_revision, operation_count, applied_at
        FROM applied_transactions WHERE transaction_id = ?`).get(transactionId);
      if (!row) return null;
      return Object.freeze({
        transactionId: row.transaction_id,
        requestHash: row.request_hash,
        baseRevision: Number(row.base_revision),
        revision: Number(row.result_revision),
        operationCount: Number(row.operation_count),
        appliedAt: row.applied_at,
      });
    });
  }

  transaction(input) {
    return publicBoundary(() => {
      this.#assertOpen();
      const normalized = normalizeTransaction(input);
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        const prior = this.#db.prepare(`SELECT request_hash, base_revision, result_revision, operation_count
          FROM applied_transactions WHERE transaction_id = ?`).get(normalized.transactionId);
        if (prior) {
          if (prior.request_hash !== normalized.requestHash) fail("TRANSACTION_ID_REUSE");
          this.#db.exec("ROLLBACK");
          return Object.freeze({
            baseRevision: Number(prior.base_revision),
            revision: Number(prior.result_revision),
            operationCount: Number(prior.operation_count),
            idempotent: true,
          });
        }
        const control = this.#db.prepare("SELECT revision FROM control WHERE singleton = 1").get();
        const currentRevision = Number(control.revision);
        if (currentRevision !== normalized.expectedRevision) fail("REVISION_CONFLICT");

        const putStatement = this.#db.prepare(`INSERT INTO workspace_records
          (collection, record_id, payload_json, byte_length, idx_id, idx_templateId, idx_templateVersionId,
           idx_importRunId, idx_rowNumber, idx_status, idx_valuesHash)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(collection, record_id) DO UPDATE SET
            payload_json = excluded.payload_json,
            byte_length = excluded.byte_length,
            idx_id = excluded.idx_id,
            idx_templateId = excluded.idx_templateId,
            idx_templateVersionId = excluded.idx_templateVersionId,
            idx_importRunId = excluded.idx_importRunId,
            idx_rowNumber = excluded.idx_rowNumber,
            idx_status = excluded.idx_status,
            idx_valuesHash = excluded.idx_valuesHash`);
        for (const value of normalized.puts) {
          putStatement.run(
            value.collection, value.id, value.recordJson, value.byteLength,
            value.indexes.id, value.indexes.templateId, value.indexes.templateVersionId,
            value.indexes.importRunId, value.indexes.rowNumber, value.indexes.status, value.indexes.valuesHash,
          );
        }
        const deleteStatement = this.#db.prepare("DELETE FROM workspace_records WHERE collection = ? AND record_id = ?");
        for (const value of normalized.deletes) deleteStatement.run(value.collection, value.id);
        const metaStatement = this.#db.prepare(`INSERT INTO workspace_meta(key, payload_json, byte_length)
          VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET payload_json = excluded.payload_json, byte_length = excluded.byte_length`);
        for (const value of normalized.meta) metaStatement.run(value.key, value.json, utf8Size(value.json));
        const schemaPatch = normalized.meta.find(value => value.key === "schemaVersion");
        if (schemaPatch) {
          this.#db.prepare("UPDATE control SET workspace_schema_version = ? WHERE singleton = 1")
            .run(Number(parseStoredJson(schemaPatch.json)));
        }

        const nextRevision = currentRevision + 1;
        this.#db.prepare("UPDATE control SET revision = ? WHERE singleton = 1").run(nextRevision);
        this.#db.prepare(`INSERT INTO applied_transactions
          (transaction_id, request_hash, base_revision, result_revision, operation_count, applied_at)
          VALUES (?, ?, ?, ?, ?, ?)`)
          .run(normalized.transactionId, normalized.requestHash, currentRevision, nextRevision, normalized.operationCount, new Date().toISOString());
        // Idempotency records are intentionally retained for a large recent
        // window, but cannot grow forever in a workspace expected to live for
        // decades. Prune only periodically and only records older than the
        // newest 100,000 successful transactions. Immediate and recent retry
        // safety is therefore preserved while disk growth is quantitatively
        // bounded (at most 101,023 rows between prune points).
        if (nextRevision % APPLIED_TRANSACTION_PRUNE_INTERVAL === 0) {
          this.#db.prepare(`DELETE FROM applied_transactions WHERE rowid IN (
            SELECT rowid FROM applied_transactions
            ORDER BY applied_at DESC, rowid DESC LIMIT -1 OFFSET ?
          )`).run(MAX_APPLIED_TRANSACTIONS);
        }
        this.#db.exec("COMMIT");
        return Object.freeze({
          baseRevision: currentRevision,
          revision: nextRevision,
          operationCount: normalized.operationCount,
          idempotent: false,
        });
      } catch (error) {
        try { this.#db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
        throw error;
      }
    });
  }

  query(input) {
    return publicBoundary(() => {
      this.#assertOpen();
      if (!isPlainObject(input)) fail("INVALID_QUERY");
      const collection = assertCollection(input.collection);
      const limit = input.limit === undefined ? 100 : input.limit;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_QUERY_LIMIT) fail("INVALID_QUERY_LIMIT");
      const where = input.where === undefined ? {} : input.where;
      if (!isPlainObject(where)) fail("INVALID_QUERY");
      const order = input.order === undefined ? "asc" : input.order;
      if (order !== "asc" && order !== "desc") fail("INVALID_QUERY");
      const filters = [];
      for (const key of Object.keys(where).sort()) {
        if (!INDEX_SET.has(key)) fail("INVALID_QUERY_KEY");
        filters.push({ key, value: scalarIndexValue(where[key]) });
      }
      const whereHash = sha256(canonicalJson(where));
      const control = this.#db.prepare("SELECT revision, cursor_secret FROM control WHERE singleton = 1").get();
      const revision = Number(control.revision);
      let afterSequence = null;
      if (input.cursor !== undefined && input.cursor !== null) {
        const cursor = decodeCursor(input.cursor, control.cursor_secret);
        if (cursor.revision !== revision) fail("STALE_CURSOR");
        if (
          cursor.collection !== collection ||
          cursor.whereHash !== whereHash ||
          cursor.order !== order ||
          !Number.isSafeInteger(cursor.afterSequence)
        ) {
          fail("INVALID_CURSOR");
        }
        afterSequence = cursor.afterSequence;
      }
      const clauses = ["collection = ?"];
      const params = [collection];
      if (afterSequence !== null) {
        clauses.push(order === "asc" ? "sequence > ?" : "sequence < ?");
        params.push(afterSequence);
      }
      for (const filter of filters) {
        clauses.push(`idx_${filter.key} = ?`);
        params.push(filter.value);
      }
      params.push(limit + 1);
      const rows = this.#db.prepare(`SELECT sequence, record_id, payload_json
        FROM workspace_records WHERE ${clauses.join(" AND ")}
        ORDER BY sequence ${order === "asc" ? "ASC" : "DESC"} LIMIT ?`).all(...params);
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const records = page.map(row => parseStoredJson(row.payload_json));
      const nextCursor = hasMore
        ? encodeCursor({
            v: CURSOR_VERSION,
            revision,
            collection,
            whereHash,
            order,
            afterSequence: Number(page[page.length - 1].sequence),
          }, control.cursor_secret)
        : null;
      return Object.freeze({ revision, records, nextCursor });
    });
  }

  queryJournalInternal(input) {
    return publicBoundary(() => {
      this.#assertOpen();
      if (!isPlainObject(input)) fail("INVALID_QUERY");
      const collection = "operationJournal";
      const limit = input.limit === undefined ? 100 : input.limit;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_QUERY_LIMIT) fail("INVALID_QUERY_LIMIT");
      const order = input.order === undefined ? "desc" : input.order;
      if (order !== "asc" && order !== "desc") fail("INVALID_QUERY");
      const whereHash = sha256(canonicalJson({}));
      const control = this.#db.prepare("SELECT revision, cursor_secret FROM control WHERE singleton = 1").get();
      const revision = Number(control.revision);
      let afterSequence = null;
      if (input.cursor !== undefined && input.cursor !== null) {
        const cursor = decodeCursor(input.cursor, control.cursor_secret);
        if (cursor.revision !== revision) fail("STALE_CURSOR");
        if (
          cursor.collection !== collection ||
          cursor.whereHash !== whereHash ||
          cursor.order !== order ||
          !Number.isSafeInteger(cursor.afterSequence)
        ) {
          fail("INVALID_CURSOR");
        }
        afterSequence = cursor.afterSequence;
      }
      const clauses = ["collection = ?"];
      const params = [collection];
      if (afterSequence !== null) {
        clauses.push(order === "asc" ? "sequence > ?" : "sequence < ?");
        params.push(afterSequence);
      }
      params.push(limit + 1);
      // Plan the page from metadata only. Payload bytes are never read before
      // the budget has decided they will actually be returned, so an oversized
      // page cannot be materialised just to be discarded afterwards.
      const planned = this.#db.prepare(`SELECT sequence, record_id, byte_length
        FROM workspace_records WHERE ${clauses.join(" AND ")}
        ORDER BY sequence ${order === "asc" ? "ASC" : "DESC"} LIMIT ?`).all(...params);
      const hasMoreRows = planned.length > limit;
      const candidates = hasMoreRows ? planned.slice(0, limit) : planned;

      // Exact JSON-escaped byte accounting. We never assume a record id or
      // payload expands by a fixed factor: every field is measured with the
      // same JSON.stringify + utf8 byte length the wire response actually uses,
      // and the stored payload byte_length is a conservative upper bound for the
      // re-serialized record value.
      const MAX = JOURNAL_INTERNAL_MAX_RESPONSE_BYTES;
      const byteLength = (s) => Buffer.byteLength(s, "utf8");
      const prefixBytes = byteLength(`{"revision":${revision},"items":[`);
      const suffixBytes = byteLength('],"nextCursor":') + 1 + JOURNAL_INTERNAL_CURSOR_SAFE_BYTES;
      const selected = [];
      let usedBytes = 0;
      let truncatedByBytes = false;

      for (const row of candidates) {
        const itemBytes =
          byteLength('{"recordId":') +
          byteLength(JSON.stringify(row.record_id)) +
          byteLength(',"sequence":') +
          byteLength(JSON.stringify(row.sequence)) +
          byteLength(',"record":') +
          Number(row.byte_length) +
          byteLength('}');
        // Projected wire size of the page that ends with this item, including
        // the JSON list separators and the trailing envelope.
        const projected =
          prefixBytes +
          usedBytes +
          selected.length +
          itemBytes +
          suffixBytes;
        if (selected.length === 0) {
          // A page that cannot fit even one record plus the envelope would
          // never advance the cursor. Refuse instead of stalling or returning a
          // partial page.
          if (projected > MAX) fail("JOURNAL_PAGE_TOO_LARGE");
        } else if (projected > MAX) {
          truncatedByBytes = true;
          break;
        }
        selected.push(row);
        usedBytes += itemBytes;
      }

      if (selected.length === 0) {
        return Object.freeze({ revision, items: [], nextCursor: null });
      }

      const placeholders = selected.map(() => "?").join(",");
      const payloadRows = this.#db.prepare(`SELECT sequence, payload_json FROM workspace_records
        WHERE sequence IN (${placeholders})`).all(...selected.map(row => row.sequence));
      const payloadBySequence = new Map();
      for (const row of payloadRows) payloadBySequence.set(Number(row.sequence), row.payload_json);

      const items = selected.map(row => {
        const payload = payloadBySequence.get(Number(row.sequence));
        if (typeof payload !== "string") fail("STORAGE_FAILURE");
        return {
          recordId: row.record_id,
          sequence: Number(row.sequence),
          record: parseStoredJson(payload),
        };
      });
      const hasMore = hasMoreRows || truncatedByBytes;
      const nextCursor = hasMore
        ? encodeCursor({
            v: CURSOR_VERSION,
            revision,
            collection,
            whereHash,
            order,
            afterSequence: Number(selected[selected.length - 1].sequence),
          }, control.cursor_secret)
        : null;
      return Object.freeze({ revision, items, nextCursor });
    });
  }

  queryMany(input) {
    return publicBoundary(() => {
      this.#assertOpen();
      if (!isPlainObject(input)) fail("INVALID_QUERY");
      const collection = assertCollection(input.collection);
      const key = input.key;
      if (typeof key !== "string" || !INDEX_SET.has(key)) fail("INVALID_QUERY_KEY");
      if (!Array.isArray(input.values) || input.values.length < 1 || input.values.length > MAX_MULTI_QUERY_VALUES) {
        fail("INVALID_QUERY");
      }
      const normalizedValues = [...new Set(input.values.map(scalarIndexValue))];
      if (normalizedValues.some(value => value === null)) fail("INVALID_QUERY");
      const where = input.where === undefined ? {} : input.where;
      if (!isPlainObject(where)) fail("INVALID_QUERY");
      const filters = [];
      for (const filterKey of Object.keys(where).sort()) {
        if (!INDEX_SET.has(filterKey) || filterKey === key) fail("INVALID_QUERY_KEY");
        filters.push({ key: filterKey, value: scalarIndexValue(where[filterKey]) });
      }
      const placeholders = normalizedValues.map(() => "?").join(",");
      const filterSql = filters.map(filter => ` AND idx_${filter.key} = ?`).join("");
      const rows = this.#db.prepare(`SELECT payload_json FROM workspace_records
        WHERE collection = ? AND idx_${key} IN (${placeholders})${filterSql}
        ORDER BY sequence ASC LIMIT ?`).all(
          collection,
          ...normalizedValues,
          ...filters.map(filter => filter.value),
          MAX_MULTI_QUERY_RESULTS + 1,
        );
      if (rows.length > MAX_MULTI_QUERY_RESULTS) fail("QUERY_RESULT_TOO_LARGE");
      const revision = this.describe().revision;
      return Object.freeze({ revision, records: rows.map(row => parseStoredJson(row.payload_json)) });
    });
  }

  readMeta() {
    return publicBoundary(() => {
      this.#assertOpen();
      const result = {};
      for (const row of this.#db.prepare("SELECT key, payload_json FROM workspace_meta ORDER BY key").all()) {
        result[row.key] = parseStoredJson(row.payload_json);
      }
      return result;
    });
  }

  async *exportRecords({ collection } = {}) {
    this.#assertOpen();
    const selected = collection === undefined ? null : assertCollection(collection);
    const statement = selected === null
      ? this.#db.prepare("SELECT collection, record_id, payload_json FROM workspace_records ORDER BY collection, sequence")
      : this.#db.prepare("SELECT collection, record_id, payload_json FROM workspace_records WHERE collection = ? ORDER BY sequence");
    const iterator = selected === null ? statement.iterate() : statement.iterate(selected);
    try {
      for (const row of iterator) {
        yield Object.freeze({ collection: row.collection, id: row.record_id, record: parseStoredJson(row.payload_json) });
      }
    } catch (error) {
      if (error instanceof WorkspaceStorageError) throw error;
      fail("STORAGE_FAILURE");
    }
  }

  getCompatSnapshot({ maxRecords, maxBytes } = {}) {
    return publicBoundary(() => {
      this.#assertOpen();
      if (!Number.isSafeInteger(maxRecords) || maxRecords < 0 || maxRecords > MAX_COMPAT_RECORDS ||
          !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_COMPAT_BYTES) {
        fail("COMPAT_LIMIT_REQUIRED");
      }
      const workspace = this.readMeta();
      for (const collection of COLLECTIONS) workspace[collection] = [];
      let recordCount = 0;
      let byteCount = utf8Size(canonicalJson(workspace));
      for (const row of this.#db.prepare(`SELECT collection, payload_json, byte_length
        FROM workspace_records ORDER BY collection, sequence`).iterate()) {
        recordCount += 1;
        byteCount += Number(row.byte_length);
        if (recordCount > maxRecords || byteCount > maxBytes) fail("COMPAT_LIMIT_EXCEEDED");
        workspace[row.collection].push(parseStoredJson(row.payload_json));
      }
      if (utf8Size(canonicalJson(workspace)) > maxBytes) fail("COMPAT_LIMIT_EXCEEDED");
      return { revision: this.describe().revision, workspace };
    });
  }
}

function legacyRecordId(record, index) {
  if (isPlainObject(record) && typeof record.id === "string" && record.id.length > 0) return assertRecordId(record.id);
  return `@legacy:${String(index).padStart(12, "0")}`;
}

function normalizedLegacyWorkspace(workspace, expectedOwnerKey) {
  if (!isPlainObject(workspace)) fail("INVALID_LEGACY_ENVELOPE");
  const schemaVersion = workspace.schemaVersion ?? 1;
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > WORKSPACE_SCHEMA_VERSION) {
    fail("UNSUPPORTED_WORKSPACE_SCHEMA");
  }
  if (workspace.ownerKey !== undefined && workspace.ownerKey !== expectedOwnerKey) fail("OWNER_MISMATCH");
  const collections = {};
  const meta = {};
  for (const key of Object.keys(workspace)) {
    if (COLLECTION_SET.has(key)) {
      if (!Array.isArray(workspace[key])) fail("INVALID_LEGACY_ENVELOPE");
      collections[key] = workspace[key];
    } else {
      if (Array.isArray(workspace[key])) fail("UNSUPPORTED_COLLECTION");
      assertMetaKey(key);
      canonicalJson(workspace[key]);
      meta[key] = workspace[key];
    }
  }
  for (const collection of COLLECTIONS) if (!collections[collection]) collections[collection] = [];
  meta.schemaVersion = schemaVersion;
  return { schemaVersion, collections, meta };
}

function digestLegacySource(metaEntries, collections) {
  const hash = crypto.createHash("sha256");
  let recordCount = 0;
  for (const entry of metaEntries) hash.update(`M\0${entry.key}\0${entry.json}\n`);
  for (const collection of [...COLLECTIONS].sort()) {
    for (let index = 0; index < collections[collection].length; index += 1) {
      const record = collections[collection][index];
      const id = legacyRecordId(record, index);
      const json = canonicalJson(record);
      hash.update(`R\0${collection}\0${id}\0${json}\n`);
      recordCount += 1;
    }
  }
  return { recordCount, canonicalHash: hash.digest("hex") };
}

function digestStoredDatabase(db) {
  const hash = crypto.createHash("sha256");
  let metaCount = 0;
  let recordCount = 0;
  for (const row of db.prepare("SELECT key, payload_json AS json FROM workspace_meta ORDER BY key").iterate()) {
    hash.update(`M\0${row.key}\0${row.json}\n`);
    metaCount += 1;
  }
  for (const row of db.prepare(`SELECT collection, record_id AS id, payload_json AS json
    FROM workspace_records ORDER BY collection, sequence`).iterate()) {
    hash.update(`R\0${row.collection}\0${row.id}\0${row.json}\n`);
    recordCount += 1;
  }
  return { metaCount, recordCount, canonicalHash: hash.digest("hex") };
}

export async function migrateLegacyWorkspaceV2({ rootDir, ownerKey, legacyPath }) {
  const paths = ownerWorkspaceV2Paths(rootDir, ownerKey);
  if (typeof legacyPath !== "string" || legacyPath.length === 0) fail("INVALID_LEGACY_PATH");
  try {
    await fsp.mkdir(paths.ownerDirectory, { recursive: true });
    const existing = await fsp.stat(paths.databasePath).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (existing) fail("STORAGE_ALREADY_EXISTS");
    const sourceStat = await fsp.stat(legacyPath);
    if (!sourceStat.isFile() || sourceStat.size > MAX_LEGACY_BYTES) fail("LEGACY_TOO_LARGE");
    const sourceBytes = await fsp.readFile(legacyPath);
    let envelope;
    try { envelope = JSON.parse(sourceBytes.toString("utf8")); } catch { fail("INVALID_LEGACY_ENVELOPE"); }
    if (!isPlainObject(envelope) || !Number.isSafeInteger(envelope.revision) || envelope.revision < 0) {
      fail("INVALID_LEGACY_ENVELOPE");
    }
    const normalized = normalizedLegacyWorkspace(envelope.workspace, ownerKey);

    const copyTemp = `${paths.legacyCopyPath}.${crypto.randomUUID()}.tmp`;
    const dbTemp = `${paths.databasePath}.${crypto.randomUUID()}.tmp`;
    let existingLegacyCopy = false;
    try {
      const priorBytes = await fsp.readFile(paths.legacyCopyPath);
      if (priorBytes.length !== sourceBytes.length || !crypto.timingSafeEqual(priorBytes, sourceBytes)) {
        fail("LEGACY_COPY_CONFLICT");
      }
      existingLegacyCopy = true;
    } catch (error) {
      if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
    }
    if (!existingLegacyCopy) await fsp.writeFile(copyTemp, sourceBytes, { flag: "wx" });
    let db;
    try {
      const opened = openDatabaseFile(dbTemp, paths.ownerHash, {
        revision: envelope.revision,
        workspaceSchemaVersion: normalized.schemaVersion,
      });
      db = opened.db;
      const sourceMeta = Object.keys(normalized.meta).sort().map(key => ({ key, json: canonicalJson(normalized.meta[key]) }));
      db.exec("BEGIN IMMEDIATE");
      try {
        const metaStatement = db.prepare("INSERT INTO workspace_meta(key, payload_json, byte_length) VALUES (?, ?, ?)");
        for (const entry of sourceMeta) metaStatement.run(entry.key, entry.json, utf8Size(entry.json));
        const recordStatement = db.prepare(`INSERT INTO workspace_records
          (collection, record_id, payload_json, byte_length, idx_id, idx_templateId, idx_templateVersionId,
           idx_importRunId, idx_rowNumber, idx_status, idx_valuesHash)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const collection of COLLECTIONS) {
          const seen = new Set();
          for (let index = 0; index < normalized.collections[collection].length; index += 1) {
            const record = normalized.collections[collection][index];
            if (!isPlainObject(record)) fail("INVALID_LEGACY_ENVELOPE");
            const id = legacyRecordId(record, index);
            if (seen.has(id)) fail("DUPLICATE_RECORD_ID");
            seen.add(id);
            const json = canonicalJson(record);
            if (utf8Size(json) > MAX_RECORD_BYTES) fail("RECORD_TOO_LARGE");
            const indexes = Object.fromEntries(INDEXED_QUERY_KEYS.map(key => [key, scalarIndexValue(record[key])]));
            if (indexes.id === null) indexes.id = scalarIndexValue(id);
            recordStatement.run(collection, id, json, utf8Size(json), indexes.id, indexes.templateId,
              indexes.templateVersionId, indexes.importRunId, indexes.rowNumber, indexes.status, indexes.valuesHash);
          }
        }
        db.exec("COMMIT");
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* already closed */ }
        throw error;
      }

      const sourceDigest = digestLegacySource(sourceMeta, normalized.collections);
      const targetDigest = digestStoredDatabase(db);
      if (sourceMeta.length !== targetDigest.metaCount ||
          sourceDigest.recordCount !== targetDigest.recordCount ||
          sourceDigest.canonicalHash !== targetDigest.canonicalHash) {
        fail("MIGRATION_VERIFICATION_FAILED");
      }
      const integrity = db.prepare("PRAGMA integrity_check").all();
      if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") fail("INTEGRITY_CHECK_FAILED");
      db.close();
      db = null;
      if (!existingLegacyCopy) await fsp.rename(copyTemp, paths.legacyCopyPath);
      await fsp.rename(dbTemp, paths.databasePath);
      return Object.freeze({
        storageSchemaVersion: STORAGE_SCHEMA_VERSION,
        schemaVersion: normalized.schemaVersion,
        revision: envelope.revision,
        recordCount: sourceDigest.recordCount,
        canonicalHash: sourceDigest.canonicalHash,
        legacyCopyPath: paths.legacyCopyPath,
        databasePath: paths.databasePath,
      });
    } catch (error) {
      if (db) db.close();
      await Promise.allSettled([fsp.rm(copyTemp, { force: true }), fsp.rm(dbTemp, { force: true })]);
      throw error;
    }
  } catch (error) {
    if (error instanceof WorkspaceStorageError) throw error;
    fail("MIGRATION_FAILED");
  }
}
