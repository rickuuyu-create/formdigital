import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  COLLECTIONS,
  STORAGE_SCHEMA_VERSION,
  WorkspaceStorageError,
  WorkspaceStorageV2,
  migrateLegacyWorkspaceV2,
  ownerWorkspaceV2Paths,
  planJournalArchiveBatches,
  isJournalArchiveWrapper,
  journalArchiveMeasuredBytes,
  JOURNAL_ARCHIVE_RECORD_TYPE,
  JOURNAL_ARCHIVE_SCHEMA_VERSION,
  JOURNAL_INTERNAL_MAX_RESPONSE_BYTES,
  JOURNAL_ARCHIVE_MAX_BATCH_BYTES,
  LEGACY_WORKSPACE_JOURNAL_MAX_RECORD_BYTES,
  calculateCanonicalTransactionBytes,
  formatJournalArchiveTransactionId,
} from "../server/formdigital/workspace-storage-v2.mjs";

// The Workspace v2 record ceiling is not exported; the fixtures below only need
// its documented value.
const MAX_V2_RECORD_BYTES_CEILING = 1024 * 1024;

const startedAt = Date.now();
let assertions = 0;

function check(value, message) {
  assert.ok(value, message);
  assertions += 1;
}

function equal(actual, expected, message) {
  assert.deepStrictEqual(actual, expected, message);
  assertions += 1;
}

function throwsCode(operation, code) {
  assert.throws(operation, error => {
    assertions += 1;
    return error instanceof WorkspaceStorageError && error.code === code && error.message === code;
  });
}

async function heapChild(rootDir, ownerKey) {
  const storage = WorkspaceStorageV2.open({ rootDir, ownerKey });
  let count = 0;
  for await (const entry of storage.exportRecords()) {
    if (!entry.record || typeof entry.record !== "object") process.exit(21);
    count += 1;
  }
  if (count !== 100_001) process.exit(22);
  let cursor = null;
  let queried = 0;
  do {
    const page = storage.query({ collection: "instances", limit: 1_000, cursor });
    queried += page.records.length;
    cursor = page.nextCursor;
  } while (cursor);
  if (queried !== 50_001) process.exit(23);
  storage.close();
}

if (process.argv[2] === "--heap-child") {
  await heapChild(process.argv[3], process.argv[4]);
  process.exit(0);
}

const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "formdigital-workspace-v2-"));
try {
  // Basic persistence, fixed indexed queries and bounded compatibility reads.
  const basicRoot = path.join(scratch, "basic");
  const owner = "synthetic-owner";
  let storage = WorkspaceStorageV2.open({ rootDir: basicRoot, ownerKey: owner });
  equal(storage.describe(), { storageSchemaVersion: 2, schemaVersion: 2, revision: 0 });
  check(storage.integrityCheck());
  const firstRequest = {
    expectedRevision: 0,
    transactionId: "tx-first",
    put: [
      { collection: "instances", record: { id: "instance-1", templateId: "template-1", status: "draft", valuesHash: "hash-a" } },
      { collection: "importRows", record: { id: "row-1", importRunId: "run-1", rowNumber: 1, status: "valid" } },
    ],
    metaPatch: { schemaVersion: 2, ownerKey: owner, preferences: { locale: "zh-Hant" } },
  };
  equal(storage.transaction(firstRequest), {
    baseRevision: 0, revision: 1, operationCount: 5, idempotent: false,
  });
  equal(storage.query({ collection: "instances", where: { templateId: "template-1", status: "draft" } }).records,
    [{ id: "instance-1", status: "draft", templateId: "template-1", valuesHash: "hash-a" }]);
  storage.close();
  storage = WorkspaceStorageV2.open({ rootDir: basicRoot, ownerKey: owner });
  equal(storage.describe().revision, 1);
  equal(storage.query({ collection: "importRows", where: { importRunId: "run-1", rowNumber: 1 } }).records.length, 1);

  // Idempotency is checked before revision conflict, so a retry returns its original result.
  equal(storage.transaction({ expectedRevision: 1, transactionId: "tx-second", metaPatch: { updatedAt: "fixed" } }).revision, 2);
  equal(storage.transaction(firstRequest), {
    baseRevision: 0, revision: 1, operationCount: 5, idempotent: true,
  });
  throwsCode(() => storage.transaction({ ...firstRequest, metaPatch: { ownerKey: "different" } }), "TRANSACTION_ID_REUSE");
  throwsCode(() => storage.transaction({ expectedRevision: 1, transactionId: "tx-conflict", metaPatch: { updatedAt: "fixed-2" } }), "REVISION_CONFLICT");

  // Cursor is authenticated and revision-bound.
  equal(storage.transaction({
    expectedRevision: 2,
    transactionId: "tx-cursor-data",
    put: [
      { collection: "instances", record: { id: "instance-2", status: "draft" } },
      { collection: "instances", record: { id: "instance-3", status: "draft" } },
    ],
  }).revision, 3);
  const newestPage = storage.query({ collection: "instances", where: { status: "draft" }, limit: 1, order: "desc" });
  equal(newestPage.records.map(record => record.id), ["instance-3"]);
  const nextNewestPage = storage.query({
    collection: "instances", where: { status: "draft" }, limit: 1,
    order: "desc", cursor: newestPage.nextCursor,
  });
  equal(nextNewestPage.records.map(record => record.id), ["instance-2"]);
  throwsCode(() => storage.query({
    collection: "instances", where: { status: "draft" }, limit: 1,
    order: "asc", cursor: newestPage.nextCursor,
  }), "INVALID_CURSOR");
  const cursorPage = storage.query({ collection: "instances", where: { status: "draft" }, limit: 1 });
  check(typeof cursorPage.nextCursor === "string");
  equal(storage.transaction({ expectedRevision: 3, transactionId: "tx-stale-cursor", metaPatch: { updatedAt: "fixed-3" } }).revision, 4);
  throwsCode(() => storage.query({ collection: "instances", where: { status: "draft" }, limit: 1, cursor: cursorPage.nextCursor }), "STALE_CURSOR");

  // Validation happens before BEGIN and a rejected multi-put changes neither data nor revision.
  throwsCode(() => storage.transaction({
    expectedRevision: 4,
    transactionId: "tx-rollback",
    put: [
      { collection: "instances", record: { id: "must-not-exist" } },
      { collection: "instances", id: "mismatch", record: { id: "different" } },
    ],
  }), "INVALID_RECORD_ID");
  equal(storage.describe().revision, 4);
  equal(storage.query({ collection: "instances", where: { id: "must-not-exist" } }).records.length, 0);
  throwsCode(() => storage.query({ collection: "instances", where: { unboundedKey: "x" } }), "INVALID_QUERY_KEY");
  throwsCode(() => storage.transaction({
    expectedRevision: 4,
    transactionId: "tx-too-many",
    deleteIds: [{ collection: "instances", ids: Array.from({ length: 12_001 }, (_, index) => `id-${index}`) }],
  }), "TRANSACTION_TOO_LARGE");
  throwsCode(() => storage.transaction({
    expectedRevision: 4,
    transactionId: "tx-record-too-large",
    put: [{ collection: "instances", record: { id: "too-large", value: "x".repeat(1024 * 1024) } }],
  }), "RECORD_TOO_LARGE");
  throwsCode(() => storage.getCompatSnapshot(), "COMPAT_LIMIT_REQUIRED");
  throwsCode(() => storage.getCompatSnapshot({ maxRecords: 1, maxBytes: 1_024 }), "COMPAT_LIMIT_EXCEEDED");
  const smallSnapshot = storage.getCompatSnapshot({ maxRecords: 10, maxBytes: 64 * 1_024 });
  equal(smallSnapshot.workspace.instances.length, 3);
  equal(storage.transaction({
    expectedRevision: 4,
    transactionId: "tx-delete",
    deleteIds: [{ collection: "importRows", ids: ["row-1"] }],
  }).revision, 5);
  equal(storage.query({ collection: "importRows", where: { id: "row-1" } }).records.length, 0);
  storage.close();

  // A future on-disk storage schema is rejected rather than downgraded.
  const basicPaths = ownerWorkspaceV2Paths(basicRoot, owner);
  const rawDb = new DatabaseSync(basicPaths.databasePath);
  rawDb.exec(`PRAGMA user_version = ${STORAGE_SCHEMA_VERSION + 1}`);
  rawDb.close();
  throwsCode(() => WorkspaceStorageV2.open({ rootDir: basicRoot, ownerKey: owner }), "UNSUPPORTED_STORAGE_SCHEMA");

  // Legacy migration: byte-exact source retention and count/hash verified publication.
  const migrationRoot = path.join(scratch, "migration");
  const migrationOwner = "legacy-owner";
  const workspace = {
    schemaVersion: 2,
    ownerKey: migrationOwner,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    preferences: { locale: "zh-Hant", nested: { safe: true } },
    ...Object.fromEntries(COLLECTIONS.map(collection => [collection, []])),
  };
  workspace.templates.push({ id: "template-legacy", status: "published" });
  workspace.instances.push({ id: "instance-legacy", templateId: "template-legacy", status: "draft" });
  workspace.operationJournal.push({ operation: "legacy", at: "fixed" });
  const legacyEnvelope = { revision: 37, workspace };
  const legacyBytes = Buffer.from(`${JSON.stringify(legacyEnvelope, null, 2)}\n`, "utf8");
  const legacyPath = path.join(scratch, "legacy.json");
  await fsp.writeFile(legacyPath, legacyBytes);
  const migration = await migrateLegacyWorkspaceV2({ rootDir: migrationRoot, ownerKey: migrationOwner, legacyPath });
  equal(migration.revision, 37);
  equal(migration.recordCount, 3);
  equal(await fsp.readFile(migration.legacyCopyPath), legacyBytes);
  const migrated = WorkspaceStorageV2.open({ rootDir: migrationRoot, ownerKey: migrationOwner });
  equal(migrated.describe(), { storageSchemaVersion: 2, schemaVersion: 2, revision: 37 });
  equal(migrated.getCompatSnapshot({ maxRecords: 10, maxBytes: 64 * 1_024 }).workspace, workspace);
  migrated.close();

  const futurePath = path.join(scratch, "future.json");
  await fsp.writeFile(futurePath, JSON.stringify({ revision: 1, workspace: { schemaVersion: 99 } }));
  await assert.rejects(
    migrateLegacyWorkspaceV2({ rootDir: path.join(scratch, "future-root"), ownerKey: "future-owner", legacyPath: futurePath }),
    error => {
      assertions += 1;
      return error instanceof WorkspaceStorageError && error.code === "UNSUPPORTED_WORKSPACE_SCHEMA";
    },
  );
  check(!fs.existsSync(ownerWorkspaceV2Paths(path.join(scratch, "future-root"), "future-owner").databasePath));

  // Stress: 100,001 records are persisted in bounded (<= 1,000-op) transactions.
  const stressRoot = path.join(scratch, "stress");
  const stressOwner = "stress-owner";
  const stress = WorkspaceStorageV2.open({ rootDir: stressRoot, ownerKey: stressOwner });
  let revision = 0;
  let written = 0;
  const total = 100_001;
  while (written < total) {
    const count = Math.min(1_000, total - written);
    const put = [];
    for (let offset = 0; offset < count; offset += 1) {
      const ordinal = written + offset;
      if (ordinal < 50_001) {
        put.push({ collection: "instances", record: {
          id: `instance-${ordinal}`,
          templateId: `template-${ordinal % 11}`,
          templateVersionId: `version-${ordinal % 23}`,
          status: ordinal % 2 === 0 ? "draft" : "completed",
          valuesHash: crypto.createHash("sha256").update(String(ordinal)).digest("hex"),
        } });
      } else {
        const rowNumber = ordinal - 50_000;
        put.push({ collection: "importRows", record: {
          id: `row-${rowNumber}`,
          importRunId: `run-${rowNumber % 17}`,
          rowNumber,
          status: "valid",
        } });
      }
    }
    const result = stress.transaction({ expectedRevision: revision, transactionId: `stress-${revision}`, put });
    revision = result.revision;
    written += count;
    check(JSON.stringify(result).length < 160, "transaction result must not contain a growing workspace snapshot");
  }
  equal(written, total);
  equal(stress.describe().revision, 101);
  stress.close();

  const persisted = WorkspaceStorageV2.open({ rootDir: stressRoot, ownerKey: stressOwner });
  let persistedCount = 0;
  for await (const _entry of persisted.exportRecords()) persistedCount += 1;
  equal(persistedCount, total);
  equal(persisted.query({ collection: "instances", where: { templateId: "template-3" }, limit: 1_000 }).records.length > 0, true);
  throwsCode(() => persisted.getCompatSnapshot({ maxRecords: 10_000, maxBytes: 16 * 1024 * 1024 }), "COMPAT_LIMIT_EXCEEDED");
  persisted.close();

  // Verify the complete dataset can be streamed and paged in a 128 MiB heap.
  const heap = spawnSync(process.execPath, [
    "--max-old-space-size=128",
    path.resolve("scripts/test-workspace-storage-v2.mjs"),
    "--heap-child",
    stressRoot,
    stressOwner,
  ], {
    cwd: path.resolve("."),
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  equal(heap.status, 0, `128 MiB child failed: ${heap.stderr || heap.stdout}`);

  // ---------------------------------------------------------------------
  // JRN-02: the internal journal stream is bounded by real response bytes,
  // not only by record count.
  //
  // The store is closed in its own finally: an SQLite handle left open would
  // otherwise make the scratch cleanup fail with EBUSY and mask the real
  // assertion failure.
  // ---------------------------------------------------------------------
  const journalRoot = path.join(scratch, "journal-bytes");
  const journalOwner = "journal-bytes-owner";
  const journalStore = WorkspaceStorageV2.open({ rootDir: journalRoot, ownerKey: journalOwner });
  try {

  // 12 records of ~900 KiB each: well over an 8 MiB page, each still a legal
  // record under the 1 MiB record ceiling.
  const chunk = "x".repeat(900 * 1024);
  let journalRevision = 0;
  for (let index = 0; index < 12; index += 1) {
    journalRevision = journalStore.transaction({
      expectedRevision: journalRevision,
      transactionId: `journal-fill-${index}`,
      put: [{
        collection: "operationJournal",
        record: { id: `journal-big-${index}`, operation: "bulk.op", at: index, blob: chunk },
      }],
    }).revision;
  }

  const bigPage = journalStore.queryJournalInternal({ limit: 1_000, order: "desc" });
  const bigPageBytes = Buffer.byteLength(JSON.stringify(bigPage), "utf8");
  check(
    bigPageBytes <= JOURNAL_INTERNAL_MAX_RESPONSE_BYTES,
    `internal journal page must respect the byte ceiling (got ${bigPageBytes})`
  );
  check(bigPage.items.length > 0, "a page must still return at least one record");
  check(bigPage.items.length < 12, "a page must not return every oversized record at once");
  check(bigPage.nextCursor !== null, "a byte-truncated page must still offer a cursor");

  // Page through the whole collection: no duplicates, no gaps, it terminates.
  const seenSequences = new Set();
  let pageCursor = null;
  let pages = 0;
  do {
    const page = journalStore.queryJournalInternal({ limit: 1_000, cursor: pageCursor, order: "desc" });
    check(
      Buffer.byteLength(JSON.stringify(page), "utf8") <= JOURNAL_INTERNAL_MAX_RESPONSE_BYTES,
      "every page must respect the byte ceiling"
    );
    for (const item of page.items) {
      check(!seenSequences.has(item.sequence), `sequence ${item.sequence} returned twice`);
      seenSequences.add(item.sequence);
    }
    pageCursor = page.nextCursor;
    pages += 1;
    check(pages <= 1_000, "pagination must terminate");
  } while (pageCursor);
  equal(seenSequences.size, 12, "paging must eventually return every record exactly once");
  check(pages > 1, "the byte ceiling must actually split the collection across pages");

  // A single legal record at the record ceiling must always advance.
  const soloRoot = path.join(scratch, "journal-solo");
  const soloStore = WorkspaceStorageV2.open({ rootDir: soloRoot, ownerKey: "solo-owner" });
  const soloBlob = "y".repeat(1024 * 1024 - 200);
  soloStore.transaction({
    expectedRevision: 0,
    transactionId: "solo-fill",
    put: [{ collection: "operationJournal", record: { id: "solo-record", operation: "solo.op", blob: soloBlob } }],
  });
  const soloPage = soloStore.queryJournalInternal({ limit: 1_000, order: "desc" });
  equal(soloPage.items.length, 1, "a single legal record must not stall pagination");
  equal(soloPage.items[0].recordId, "solo-record");
  check(
    Buffer.byteLength(JSON.stringify(soloPage), "utf8") <= JOURNAL_INTERNAL_MAX_RESPONSE_BYTES,
    "a single legal record still fits inside the byte ceiling"
  );
  soloStore.close();

  // Cursor integrity: a write invalidates an outstanding cursor.
  const driftCursor = journalStore.queryJournalInternal({ limit: 2, order: "desc" }).nextCursor;
  check(typeof driftCursor === "string", "a truncated page must produce a cursor");
  journalRevision = journalStore.transaction({
    expectedRevision: journalRevision,
    transactionId: "journal-drift",
    put: [{ collection: "operationJournal", record: { id: "journal-drift-1", operation: "drift.op", at: 99 } }],
  }).revision;
  throwsCode(() => journalStore.queryJournalInternal({ limit: 2, cursor: driftCursor, order: "desc" }), "STALE_CURSOR");

  throwsCode(() => journalStore.queryJournalInternal({ limit: 1_000, cursor: "not-a-cursor", order: "desc" }), "INVALID_CURSOR");
  throwsCode(() => journalStore.queryJournalInternal({ limit: 0, order: "desc" }), "INVALID_QUERY_LIMIT");
  throwsCode(() => journalStore.queryJournalInternal({ limit: 1_000_000, order: "desc" }), "INVALID_QUERY_LIMIT");
  } finally {
    journalStore.close();
  }

  // ---------------------------------------------------------------------
  // JRN-02 (re-review): a record id full of control characters must not blow
  // the 8 MiB response ceiling. regression test reproduced 914 records whose ids were
  // ~1 KiB of \u0000; the old estimate (byte_length + 2*id + 128) under-counted
  // JSON escaping (a NUL id serializes to ~6x its utf8 size, not 2x) and
  // serialized a single page to 11,952,656 bytes. The store sanitizes
  // control-character business ids to an empty record_id, so to reproduce the
  // exact regression test shape we insert the rows directly with a NUL record_id. The fix
  // measures the exact JSON-escaped size, so the final serialized response is
  // always <= 8 MiB. This is the RED case: it fails under the old estimate.
  // ---------------------------------------------------------------------
  const ctrlRoot = path.join(scratch, "journal-ctrl");
  const ctrlOwner = "journal-ctrl-owner";
  const ctrlPaths = ownerWorkspaceV2Paths(ctrlRoot, ctrlOwner);
  // Seed the schema + control row, then close so we can write raw rows that the
  // public put path would otherwise sanitize.
  {
    const seed = WorkspaceStorageV2.open({ rootDir: ctrlRoot, ownerKey: ctrlOwner });
    seed.close();
  }
  // 1018 SOH control characters + 2 varying bytes => a unique, <=1024-byte id
  // that JSON-escapes to ~6x its utf8 size. We use \u0001 (SOH) rather than
  // \u0000 (NUL) because SQLite TEXT columns truncate at an embedded NUL on
  // read-back, so a NUL id would round-trip as empty and never reproduce the
  // blow-up. SOH survives storage yet still expands under JSON.stringify, which
  // is exactly the regression test escaping shape.
  const nulls = "\u0001".repeat(1018);
  const ctrlId = (i) => nulls + String.fromCharCode(i & 0xff) + String.fromCharCode((i >> 8) & 0xff);
  const ctrlBlob = "z".repeat(200);
  const TOTAL = 914;
  const ctrlRawDb = new DatabaseSync(ctrlPaths.databasePath);
  try {
    const insertStmt = ctrlRawDb.prepare(
      `INSERT INTO workspace_records (collection, record_id, payload_json, byte_length, idx_id)
       VALUES ('operationJournal', ?, ?, ?, ?)`
    );
    ctrlRawDb.prepare("BEGIN").run();
    for (let i = 0; i < TOTAL; i += 1) {
      const id = ctrlId(i);
      const record = { id, operation: "ctrl.op", at: i, note: ctrlBlob };
      const payload = JSON.stringify(record);
      insertStmt.run(id, payload, Buffer.byteLength(payload, "utf8"), id);
    }
    ctrlRawDb.prepare("COMMIT").run();
  } finally {
    ctrlRawDb.close();
  }

  const ctrlStore = WorkspaceStorageV2.open({ rootDir: ctrlRoot, ownerKey: ctrlOwner });
  try {
    const ctrlPage = ctrlStore.queryJournalInternal({ limit: 1_000, order: "desc" });
    const ctrlPageBytes = Buffer.byteLength(JSON.stringify(ctrlPage), "utf8");
    check(
      ctrlPageBytes <= JOURNAL_INTERNAL_MAX_RESPONSE_BYTES,
      `control-char id page must stay within 8 MiB (got ${ctrlPageBytes})`
    );
    check(ctrlPage.items.length > 0, "must return at least one record");
    check(ctrlPage.items.length < TOTAL, "byte ceiling must truncate the oversized page");
    check(ctrlPage.nextCursor !== null, "byte-truncated page must still offer a cursor");

    // Page through; every page <= 8 MiB, every record exactly once, terminates.
    const ctrlSeen = new Set();
    let ctrlCursor = null;
    let ctrlPages = 0;
    do {
      const page = ctrlStore.queryJournalInternal({ limit: 1_000, cursor: ctrlCursor, order: "desc" });
      const pageBytes = Buffer.byteLength(JSON.stringify(page), "utf8");
      check(pageBytes <= JOURNAL_INTERNAL_MAX_RESPONSE_BYTES, "every control-char page <= 8 MiB");
      for (const item of page.items) {
        check(!ctrlSeen.has(item.sequence), `sequence ${item.sequence} returned twice`);
        ctrlSeen.add(item.sequence);
      }
      ctrlCursor = page.nextCursor;
      ctrlPages += 1;
      check(ctrlPages <= 1_000, "pagination must terminate");
    } while (ctrlCursor);
    equal(ctrlSeen.size, TOTAL, "must return every control-char record exactly once");
    check(ctrlPages > 1, "the byte ceiling must split the collection across pages");
  } finally {
    ctrlStore.close();
  }

  // ---------------------------------------------------------------------
  // JRN-03: the 64 KiB business limit applies to the original entry, not to
  // the system wrapper that carries it.
  // ---------------------------------------------------------------------
  // regression test's reproduction: a 65,463-byte entry is accepted by the v1 path, but
  // carried inside the system wrapper it measures 65,646 bytes and was refused.
  const entryBase = { operation: "legacy.op", at: "2021-01-01T00:00:00.000Z", blob: "" };
  const entryOverhead = Buffer.byteLength(JSON.stringify(entryBase), "utf8");
  const rawEntry = { ...entryBase, blob: "z".repeat(65_463 - entryOverhead) };
  const rawEntryBytes = Buffer.byteLength(JSON.stringify(rawEntry), "utf8");
  const wrapper = {
    recordType: JOURNAL_ARCHIVE_RECORD_TYPE,
    schemaVersion: JOURNAL_ARCHIVE_SCHEMA_VERSION,
    id: "journal-archive-r123-i0-abcdef0123456789abcdef",
    archivedAt: "2021-01-01T00:00:00.000Z",
    archivedEntry: rawEntry,
  };
  const wrapperBytes = Buffer.byteLength(JSON.stringify(wrapper), "utf8");
  equal(rawEntryBytes, 65_463, "fixture: raw entry is exactly 65,463 bytes");
  equal(wrapperBytes, 65_646, "fixture: wrapper is exactly 65,646 bytes");
  check(rawEntryBytes <= LEGACY_WORKSPACE_JOURNAL_MAX_RECORD_BYTES, "raw entry is inside the business limit");
  check(wrapperBytes > LEGACY_WORKSPACE_JOURNAL_MAX_RECORD_BYTES, "wrapper alone exceeds the business limit");
  check(wrapperBytes < MAX_V2_RECORD_BYTES_CEILING, "wrapper stays inside the v2 record ceiling");

  // An already-accepted 65,463-byte entry must still be archivable.
  const planned = planJournalArchiveBatches(
    [{ collection: "operationJournal", record: wrapper }],
    { expectedRevision: 123 }
  );
  equal(planned.length, 1, "a legal 65,463-byte entry must still plan into one batch");
  equal(planned[0].itemCount, 1);
  check(
    planned[0].serializedRequestBytes <= JOURNAL_ARCHIVE_MAX_BATCH_BYTES,
    "the batch still fits the 12 MiB transaction ceiling"
  );

  // The entry limit is still enforced on the entry itself.
  const oversized = {
    ...wrapper,
    id: "journal-archive-r123-i1-abcdef0123456789abcdef",
    archivedEntry: { ...entryBase, blob: "z".repeat(65_537 - entryOverhead) },
  };
  equal(Buffer.byteLength(JSON.stringify(oversized.archivedEntry), "utf8"), 65_537);
  let oversizedCode = "";
  try {
    planJournalArchiveBatches([{ collection: "operationJournal", record: oversized }], { expectedRevision: 123 });
  } catch (error) {
    oversizedCode = error?.code ?? "";
    equal(error?.status, 413, "an oversized entry is still refused with 413");
    equal(error?.publicCode, "record_too_large");
  }
  equal(oversizedCode, "RECORD_TOO_LARGE", "an entry over 64 KiB is still refused");

  // The v2 record ceiling still bounds the wrapper itself.
  const hugeWrapper = {
    ...wrapper,
    id: "journal-archive-r123-i2-abcdef0123456789abcdef",
    archivedEntry: { operation: "legacy.op", blob: "z".repeat(1024 * 1024) },
  };
  let hugeCode = "";
  try {
    planJournalArchiveBatches([{ collection: "operationJournal", record: hugeWrapper }], { expectedRevision: 123 });
  } catch (error) {
    hugeCode = error?.code ?? "";
  }
  equal(hugeCode, "RECORD_TOO_LARGE", "the wrapper is still bounded by the v2 record ceiling");

  // A business record that merely carries an archivedEntry property is not a
  // wrapper and keeps the ordinary limit.
  const lookalike = { id: "business-1", operation: "op", archivedEntry: { a: 1 } };
  equal(isJournalArchiveWrapper(lookalike), false, "a look-alike record is not a wrapper");
  equal(isJournalArchiveWrapper(wrapper), true, "a real wrapper is recognised");
  equal(journalArchiveMeasuredBytes(lookalike), null, "no wrapper => no entry remeasurement");
  equal(
    journalArchiveMeasuredBytes(wrapper),
    Buffer.byteLength(JSON.stringify(rawEntry), "utf8"),
    "wrapper measures its archived entry"
  );

  // ---------------------------------------------------------------------
  // JRN-04: a genuine 12 MiB boundary. The same batch, measured with a short
  // fake transaction id, sits at 12 MiB - 10 bytes (an old algorithm that
  // under-estimates the id would NOT split and would misplace a record);
  // measured with the formal 24-hex id it sits at 12 MiB + 10 bytes (the
  // planner MUST split before the first SQLite transaction). Every planned
  // batch is re-measured with the exact transaction id that is handed to
  // storage.transaction() -- we never trust the planner's own serializedRequestBytes.
  // ---------------------------------------------------------------------
  const MiB = 1024 * 1024;
  const BOUNDARY_SHORT = 12 * MiB - 10;   // 12582902
  const BOUNDARY_FORMAL = 12 * MiB + 10;  // 12582922

  function makeArchivePut(i, dataLen) {
    return {
      collection: "operationJournal",
      record: {
        recordType: JOURNAL_ARCHIVE_RECORD_TYPE,
        schemaVersion: JOURNAL_ARCHIVE_SCHEMA_VERSION,
        id: `journal-archive-r1-i${i}-${"a".repeat(24)}`,
        archivedAt: "1970-01-01T00:00:00.000Z",
        archivedEntry: { id: "entry", i, data: "m".repeat(dataLen) },
      },
    };
  }

  // 400 puts, every archived entry <= 64 KiB (last entry 31,499 bytes), the
  // batch crosses 12 MiB only because of the transaction-id length difference.
  const BOUNDARY_BASE = 31140;
  const BOUNDARY_LAST = 31467;
  const fixture = [];
  for (let i = 0; i < 400; i += 1) {
    fixture.push(makeArchivePut(i, i === 399 ? BOUNDARY_LAST : BOUNDARY_BASE));
  }
  for (const put of fixture) {
    check(
      Buffer.byteLength(JSON.stringify(put.record.archivedEntry), "utf8") <= LEGACY_WORKSPACE_JOURNAL_MAX_RECORD_BYTES,
      "JRN-04 fixture: every archived entry stays inside the 64 KiB business limit"
    );
  }

  const realBatch0TxId = formatJournalArchiveTransactionId(1, 0, fixture.map(p => p.record.id));
  const shortBatch0TxId = realBatch0TxId.replace(/[a-f0-9]{24}$/, "WXYZ");
  equal(realBatch0TxId.length - shortBatch0TxId.length, 20, "formal id is exactly 20 bytes longer than the short fake id");

  const shortAll = calculateCanonicalTransactionBytes({ expectedRevision: 1, transactionId: shortBatch0TxId, put: fixture });
  const formalAll = calculateCanonicalTransactionBytes({ expectedRevision: 1, transactionId: realBatch0TxId, put: fixture });
  equal(shortAll, BOUNDARY_SHORT, "all 400 puts measure exactly 12 MiB - 10 with the short fake id");
  equal(formalAll, BOUNDARY_FORMAL, "all 400 puts measure exactly 12 MiB + 10 with the formal id");

  // The OLD algorithm (using the short fake id for its look-ahead) would keep
  // all 400 puts in one batch: shortAll <= 12 MiB. Re-measured with the real id
  // that same batch is 12 MiB + 10 -> one record too many, i.e. misplaced.
  check(shortAll <= JOURNAL_ARCHIVE_MAX_BATCH_BYTES, "old algorithm: the short id says the whole batch still fits");
  check(formalAll > JOURNAL_ARCHIVE_MAX_BATCH_BYTES, "old algorithm would have misplaced a record once the real id is applied");

  // The formal planner splits before the first SQLite transaction.
  const batches = planJournalArchiveBatches(fixture, { expectedRevision: 1 });
  check(batches.length >= 2, "the formal planner deterministically splits the boundary batch");

  for (const batch of batches) {
    const reMeasured = calculateCanonicalTransactionBytes({
      expectedRevision: 1,
      transactionId: batch.transactionId,
      put: batch.puts,
    });
    equal(reMeasured, batch.serializedRequestBytes, "re-measured bytes match the planner's self-reported field");
    check(
      reMeasured <= JOURNAL_ARCHIVE_MAX_BATCH_BYTES,
      `planned batch ${batch.transactionId} must be <= 12 MiB (got ${reMeasured})`
    );
    check(
      /^journal-archive-r1-b\d+-[a-f0-9]{24}$/.test(batch.transactionId),
      `planned batch ${batch.transactionId} uses the formal 24-hex id shape`
    );
  }

  // The boundary record (index 399) is split out of the first batch: the formal
  // measurement exceeds 12 MiB, so the planner refuses to carry it forward.
  equal(batches[0].itemCount, 399, "the first batch holds the 399 records that fit under 12 MiB");
  check(
    !batches[0].recordIds.includes(`journal-archive-r1-i399-${"a".repeat(24)}`),
    "the boundary record is split out of the first batch"
  );

  // Determinism: same input and revision => identical boundaries and tx ids.
  const batchesAgain = planJournalArchiveBatches(fixture, { expectedRevision: 1 });
  equal(batchesAgain.length, batches.length, "rerun produces the same batch count");
  equal(
    batchesAgain.map(b => b.transactionId).join("|"),
    batches.map(b => b.transactionId).join("|"),
    "rerun produces identical transaction ids"
  );
  equal(
    batchesAgain.map(b => b.itemCount).join(","),
    batches.map(b => b.itemCount).join(","),
    "rerun produces identical batch boundaries"
  );

  console.log(`Workspace Storage v2: ${assertions} assertions passed in ${Date.now() - startedAt} ms.`);
} finally {
  await fsp.rm(scratch, { recursive: true, force: true });
}
