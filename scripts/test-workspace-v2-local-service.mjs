import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { strFromU8, unzipSync } from "fflate";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "formdigital-v2-route-"));
const dataFolder = path.join(scratch, "data");
const configPath = path.join(scratch, "config.json");
const owner = "synthetic-workspace-v2-owner";
const ownerHash = crypto.createHash("sha256").update(owner).digest("hex");
const freshOwner = "synthetic-workspace-v2-fresh-owner";
const freshOwnerHash = crypto.createHash("sha256").update(freshOwner).digest("hex");
const largeOwner = "synthetic-workspace-v2-large-owner";
const largeOwnerHash = crypto.createHash("sha256").update(largeOwner).digest("hex");
const growthOwner = "synthetic-workspace-v2-growth-owner";
const growthOwnerHash = crypto.createHash("sha256").update(growthOwner).digest("hex");
const missingV2Owner = "synthetic-workspace-v2-missing-owner";
const missingV2OwnerHash = crypto.createHash("sha256").update(missingV2Owner).digest("hex");
const token = crypto.randomBytes(24).toString("base64url");
let assertions = 0;
let service;

function equal(actual, expected, message) {
  assert.deepStrictEqual(actual, expected, message);
  assertions += 1;
}

function check(value, message) {
  assert.ok(value, message);
  assertions += 1;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function stop() {
  if (!service || service.exitCode !== null) return;
  service.kill();
  await new Promise(resolve => service.once("exit", resolve));
}

async function exists(target) {
  return fs.stat(target).then(
    () => true,
    error => error?.code === "ENOENT" ? false : Promise.reject(error),
  );
}

async function hashFile(target) {
  const hash = crypto.createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(target)) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { size, contentHash: hash.digest("hex") };
}

async function writeLargeLegacyWorkspace(target) {
  const paddingBytes = 840 * 1024;
  const recordCount = 64;
  const workspace = {
    schemaVersion: 2,
    ownerKey: largeOwner,
    createdAt: "2026-01-02T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    templates: [{ id: "large-template", lifecycle: "published", name: "Large regression" }],
    templateVersions: [{ id: "large-version", templateId: "large-template", state: "published" }],
    fields: [], instances: [], folders: [{ id: "large-folder", name: "Preserved" }],
    tags: [{ id: "large-tag", name: "Preserved" }], savedValues: [], mappingTemplates: [],
    importRuns: [], importRows: [], mappingDecisions: [], detectionRuns: [],
    operationJournal: [{ id: "legacy-journal-preserved", operation: "regression.seed" }],
    preferences: { regressionSeed: "preserved" },
  };
  const skeleton = JSON.stringify({ revision: 23, workspace });
  const needle = '"instances":[]';
  const offset = skeleton.indexOf(needle);
  assert.notEqual(offset, -1);
  const prefix = `${skeleton.slice(0, offset)}"instances":[`;
  const suffix = `]${skeleton.slice(offset + needle.length)}\n`;
  const hash = crypto.createHash("sha256");
  let size = 0;
  const handle = await fs.open(target, "wx");
  const write = async value => {
    const bytes = Buffer.from(value);
    await handle.write(bytes);
    hash.update(bytes);
    size += bytes.length;
  };
  try {
    await write(prefix);
    const padding = "X".repeat(paddingBytes);
    for (let index = 0; index < recordCount; index += 1) {
      const id = `large-instance-${String(index).padStart(3, "0")}`;
      const record = JSON.stringify({
        id,
        templateId: "large-template",
        templateVersionId: "large-version",
        status: "draft",
        marker: `SYNTHETIC-${index}`,
        payload: padding,
      });
      assert.ok(Buffer.byteLength(record) < 1024 * 1024, "each v2 record must stay below 1 MiB");
      await write(`${index === 0 ? "" : ","}${record}`);
    }
    await write(suffix);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { size, contentHash: hash.digest("hex"), paddingBytes, recordCount };
}

try {
  const port = await freePort();
  await fs.mkdir(path.join(dataFolder, "accounts", ownerHash), { recursive: true });
  const workspace = {
    schemaVersion: 2,
    ownerKey: owner,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    templates: [{ id: "template-1", lifecycle: "published", name: "Synthetic Template" }],
    templateVersions: [{ id: "version-1", templateId: "template-1", state: "published" }],
    fields: [],
    instances: [{ id: "legacy-instance", templateId: "template-1", templateVersionId: "version-1", status: "draft" }],
    folders: [], tags: [], savedValues: [], mappingTemplates: [], importRuns: [], importRows: [],
    mappingDecisions: [], detectionRuns: [], operationJournal: [], preferences: {},
  };
  const legacyBytes = Buffer.from(`${JSON.stringify({ revision: 7, workspace }, null, 2)}\n`);
  const legacyPath = path.join(dataFolder, "accounts", ownerHash, "workspace.json");
  await fs.writeFile(legacyPath, legacyBytes);
  await fs.mkdir(path.join(dataFolder, "accounts", missingV2OwnerHash), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(dataFolder, "accounts", missingV2OwnerHash, "workspace.json"),
    Buffer.from(
      `${JSON.stringify({
        revision: 3,
        workspace: { ...workspace, ownerKey: missingV2Owner },
      }, null, 2)}\n`,
    ),
  );
  await fs.mkdir(path.join(dataFolder, "accounts", largeOwnerHash), { recursive: true });
  const largeLegacyPath = path.join(dataFolder, "accounts", largeOwnerHash, "workspace.json");
  const largeLegacy = await writeLargeLegacyWorkspace(largeLegacyPath);
  check(largeLegacy.size > 50 * 1024 * 1024, "large regression must exceed the old 50 MiB ceiling");
  check(largeLegacy.size < 64 * 1024 * 1024, "large regression must stay inside the bounded migration ceiling");
  await fs.writeFile(configPath, JSON.stringify({
    schemaVersion: 1, port, dataFolder, token, allowedOrigins: [],
  }));

  const start = () => {
    service = spawn(process.execPath, [path.join(projectRoot, "local-data-service.mjs")], {
      cwd: projectRoot,
      env: { ...process.env, FORMDIGITAL_LOCAL_CONFIG: configPath },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  };
  start();
  const base = `http://127.0.0.1:${port}`;
  const headers = { authorization: `Bearer ${token}`, "x-formdigital-owner": owner, "content-type": "application/json" };
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const request = async (route, method = "GET", body, requestHeaders = headers) => {
    const response = await fetch(`${base}${route}`, {
      method, headers: requestHeaders, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json();
    assert.equal(response.ok, true, `${route}: ${response.status} ${JSON.stringify(payload)}`);
    return payload;
  };

  const freshHeaders = { ...headers, "x-formdigital-owner": freshOwner };
  const largeHeaders = { ...headers, "x-formdigital-owner": largeOwner };
  const growthHeaders = { ...headers, "x-formdigital-owner": growthOwner };
  const missingV2Headers = { ...headers, "x-formdigital-owner": missingV2Owner };
  equal(
    await request("/api/v2/workspace/describe", "GET", undefined, freshHeaders),
    { storageSchemaVersion: 2, schemaVersion: 2, revision: 0 },
  );
  equal((await request("/api/v2/workspace/query", "POST", {
    collection: "instances", limit: 10,
  }, freshHeaders)).records, []);
  equal((await request("/api/v2/workspace/query-many", "POST", {
    collection: "instances", key: "id", values: ["missing"],
  }, freshHeaders)).records, []);
  const freshExport = await fetch(`${base}/api/v2/workspace/export?collection=instances`, {
    headers: freshHeaders,
  });
  equal(freshExport.status, 200);
  equal((await freshExport.text()).trim().split("\n").length, 1);
  equal(await exists(path.join(dataFolder, "accounts", freshOwnerHash)), false);
  equal(await exists(path.join(dataFolder, "workspace-v2", freshOwnerHash)), false);

  // A normal v1 save in the former 32-40 MiB dead band must be accepted when
  // almost all of its bytes belong to v2-authoritative records. The following
  // v2 access must then cut it over and compact the active v1 envelope.
  const growthPadding = "G".repeat(840 * 1024);
  const growthWorkspace = {
    schemaVersion: 2,
    ownerKey: growthOwner,
    createdAt: "2026-01-03T00:00:00.000Z",
    updatedAt: "2026-01-03T00:00:00.000Z",
    templates: [{ id: "growth-template", lifecycle: "published", name: "Growth regression" }],
    templateVersions: [{ id: "growth-version", templateId: "growth-template", state: "published" }],
    fields: [],
    instances: Array.from({ length: 40 }, (_, index) => ({
      id: `growth-instance-${index}`,
      templateId: "growth-template",
      templateVersionId: "growth-version",
      status: "draft",
      payload: growthPadding,
    })),
    folders: [], tags: [], savedValues: [], mappingTemplates: [], importRuns: [],
    importRows: [], mappingDecisions: [], detectionRuns: [], operationJournal: [],
    preferences: { regressionSeed: "growth" },
  };
  const growthPutBody = JSON.stringify({
    expectedRevision: 0,
    workspace: growthWorkspace,
  });
  check(Buffer.byteLength(growthPutBody) > 32 * 1024 * 1024);
  check(Buffer.byteLength(growthPutBody) < 40 * 1024 * 1024);
  const growthPutResponse = await fetch(`${base}/api/v1/workspace`, {
    method: "PUT",
    headers: growthHeaders,
    body: growthPutBody,
  });
  equal(growthPutResponse.status, 200);
  equal((await growthPutResponse.json()).revision, 1);
  equal(
    await request("/api/v2/workspace/describe", "GET", undefined, growthHeaders),
    { storageSchemaVersion: 2, schemaVersion: 2, revision: 1 },
  );
  const growthProjected = await request(
    "/api/v1/workspace",
    "GET",
    undefined,
    growthHeaders,
  );
  equal(growthProjected.revision, 2);
  equal(growthProjected.workspace.instances, []);
  equal((await request("/api/v2/workspace/query", "POST", {
    collection: "instances",
    where: { id: "growth-instance-39" },
    limit: 1,
  }, growthHeaders)).records[0].payload.length, growthPadding.length);
  check(
    (await fs.stat(path.join(
      dataFolder,
      "workspace-v2",
      growthOwnerHash,
      "legacy-workspace.json",
    ))).size > 32 * 1024 * 1024,
  );
  const reservedMarkerResponse = await fetch(`${base}/api/v1/workspace`, {
    method: "PUT",
    headers: freshHeaders,
    body: JSON.stringify({
      expectedRevision: 0,
      workspace: {
        schemaVersion: 2,
        preferences: {
          __formdigitalWorkspaceV2: {
            schemaVersion: 1,
            layout: "v2-authoritative-high-growth",
            sourceRevision: 0,
            sourceHash: "0".repeat(64),
            safetyBackupId: "backup-caller-created",
            compactedAt: "2026-01-01T00:00:00.000Z",
            collections: ["instances", "importRuns", "importRows", "mappingDecisions"],
          },
        },
      },
    }),
  });
  equal(reservedMarkerResponse.status, 409);
  equal(
    (await reservedMarkerResponse.json()).error.code,
    "workspace_v1_reserved_metadata_rejected",
  );
  equal(await exists(path.join(dataFolder, "accounts", freshOwnerHash)), false);
  const privateBackupId = "backup-TEST_PRIVATE_VALUE";
  const missingBackupResponse = await fetch(`${base}/api/v1/restore`, {
    method: "POST",
    headers,
    body: JSON.stringify({ backupId: privateBackupId }),
  });
  equal(missingBackupResponse.status, 404);
  const missingBackupText = await missingBackupResponse.text();
  equal(JSON.parse(missingBackupText).error.code, "backup_not_found");
  check(!missingBackupText.includes("TEST_PRIVATE_VALUE"));
  check(!missingBackupText.includes(dataFolder));
  equal((await request("/api/v1/integrity-scan", "POST")).healthy, true);

  // A legacy Workspace that has crossed the old 50 MiB request ceiling must
  // migrate without sending the giant JSON back through the v1 PUT route.
  equal(
    await request("/api/v2/workspace/describe", "GET", undefined, largeHeaders),
    { storageSchemaVersion: 2, schemaVersion: 2, revision: 23 },
  );
  const largeLegacyCopy = path.join(
    dataFolder,
    "workspace-v2",
    largeOwnerHash,
    "legacy-workspace.json",
  );
  equal(await hashFile(largeLegacyCopy), {
    size: largeLegacy.size,
    contentHash: largeLegacy.contentHash,
  });
  for (const index of [0, 32, 63]) {
    const id = `large-instance-${String(index).padStart(3, "0")}`;
    const page = await request("/api/v2/workspace/query", "POST", {
      collection: "instances",
      where: { id },
      limit: 1,
    }, largeHeaders);
    equal(page.records.length, 1);
    equal(page.records[0].marker, `SYNTHETIC-${index}`);
    equal(page.records[0].payload.length, largeLegacy.paddingBytes);
  }

  const compactResponse = await fetch(`${base}/api/v1/workspace`, {
    headers: largeHeaders,
  });
  equal(compactResponse.status, 200);
  const compactText = await compactResponse.text();
  check(Buffer.byteLength(compactText) < 1024 * 1024, "compacted v1 response must stay below 1 MiB");
  const compactEnvelope = JSON.parse(compactText);
  equal(compactEnvelope.revision, 24);
  equal(compactEnvelope.workspace.instances, []);
  equal(compactEnvelope.workspace.importRuns, []);
  equal(compactEnvelope.workspace.importRows, []);
  equal(compactEnvelope.workspace.mappingDecisions, []);
  equal(compactEnvelope.workspace.operationJournal[0].id, "legacy-journal-preserved");
  equal(compactEnvelope.workspace.detectionRuns, []);
  equal(compactEnvelope.workspace.folders[0].id, "large-folder");
  equal(compactEnvelope.workspace.preferences.regressionSeed, "preserved");
  const projection = compactEnvelope.workspace.preferences.__formdigitalWorkspaceV2;
  equal(projection.schemaVersion, 1);
  equal(projection.sourceHash, largeLegacy.contentHash);
  check(typeof projection.safetyBackupId === "string" && projection.safetyBackupId.startsWith("backup-"));
  check(await exists(path.join(dataFolder, "backups", "emergency", `${projection.safetyBackupId}.formdigital-backup`)));
  check((await fs.stat(largeLegacyPath)).size < 1024 * 1024, "active v1 file must be compacted on disk");
  equal(await hashFile(largeLegacyCopy), {
    size: largeLegacy.size,
    contentHash: largeLegacy.contentHash,
  });

  compactEnvelope.workspace.preferences.largeMigrationRegression = "persisted";
  const compactPutBody = {
    expectedRevision: compactEnvelope.revision,
    workspace: compactEnvelope.workspace,
  };
  check(Buffer.byteLength(JSON.stringify(compactPutBody)) < 1024 * 1024);
  const compactPut = await request(
    "/api/v1/workspace",
    "PUT",
    compactPutBody,
    largeHeaders,
  );
  equal(compactPut.revision, 25);
  equal(compactPut.workspace.preferences.largeMigrationRegression, "persisted");

  // Metadata growth must be rejected before the compact v1 file crosses its
  // bounded compatibility ceiling. The existing file and v2 records remain
  // usable, and the public error cannot echo the caller-controlled value.
  const compactBeforeOversize = await hashFile(largeLegacyPath);
  const oversizedMetadata = structuredClone(compactPut.workspace);
  oversizedMetadata.preferences.oversizedRegression =
    "TEST_PRIVATE_VALUE".padEnd(33 * 1024 * 1024, "M");
  const oversizedMetadataResponse = await fetch(`${base}/api/v1/workspace`, {
    method: "PUT",
    headers: largeHeaders,
    body: JSON.stringify({
      expectedRevision: compactPut.revision,
      workspace: oversizedMetadata,
    }),
  });
  equal(oversizedMetadataResponse.status, 413);
  const oversizedMetadataText = await oversizedMetadataResponse.text();
  equal(
    JSON.parse(oversizedMetadataText).error.code,
    "workspace_v1_metadata_too_large",
  );
  check(!oversizedMetadataText.includes("TEST_PRIVATE_VALUE"));
  check(!oversizedMetadataText.includes(dataFolder));
  equal(await hashFile(largeLegacyPath), compactBeforeOversize);
  equal((await request("/api/v2/workspace/query", "POST", {
    collection: "instances",
    where: { id: "large-instance-063" },
    limit: 1,
  }, largeHeaders)).records[0].marker, "SYNTHETIC-63");

  const invalidReintroduction = structuredClone(compactPut.workspace);
  invalidReintroduction.instances = [{ id: "must-not-return-to-v1" }];
  const rejectedResponse = await fetch(`${base}/api/v1/workspace`, {
    method: "PUT",
    headers: largeHeaders,
    body: JSON.stringify({
      expectedRevision: compactPut.revision,
      workspace: invalidReintroduction,
    }),
  });
  equal(rejectedResponse.status, 409);
  equal(
    (await rejectedResponse.json()).error.code,
    "workspace_v2_collection_rejected",
  );
  equal(await hashFile(largeLegacyCopy), {
    size: largeLegacy.size,
    contentHash: largeLegacy.contentHash,
  });

  equal(await request("/api/v2/workspace/describe"), { storageSchemaVersion: 2, schemaVersion: 2, revision: 7 });
  const legacyCopy = path.join(dataFolder, "workspace-v2", ownerHash, "legacy-workspace.json");
  equal(await fs.readFile(legacyCopy), legacyBytes, "migration must retain byte-exact legacy source");
  equal((await request("/api/v2/workspace/query", "POST", {
    collection: "instances", where: { id: "legacy-instance" }, limit: 10,
  })).records.length, 1);
  const smallProjected = await request("/api/v1/workspace");
  equal(smallProjected.workspace.instances, []);
  equal(
    smallProjected.workspace.preferences.__formdigitalWorkspaceV2.layout,
    "v2-authoritative-high-growth",
  );
  const splitBrainAttempt = structuredClone(smallProjected.workspace);
  splitBrainAttempt.instances = [{
    id: "split-brain-must-not-commit",
    templateId: "template-1",
    templateVersionId: "version-1",
    status: "draft",
  }];
  const splitBrainResponse = await fetch(`${base}/api/v1/workspace`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      expectedRevision: smallProjected.revision,
      workspace: splitBrainAttempt,
    }),
  });
  equal(splitBrainResponse.status, 409);
  equal(
    (await splitBrainResponse.json()).error.code,
    "workspace_v2_collection_rejected",
  );
  equal((await request("/api/v2/workspace/query", "POST", {
    collection: "instances",
    where: { id: "split-brain-must-not-commit" },
    limit: 1,
  })).records.length, 0);
  equal((await request("/api/v1/integrity-scan", "POST")).healthy, true);

  // A second owner is cut over now; its v2 file is removed only after the
  // service stops so the restart path can prove it fails closed without
  // recreating an empty database from the compact v1 projection.
  equal(
    await request(
      "/api/v2/workspace/describe",
      "GET",
      undefined,
      missingV2Headers,
    ),
    { storageSchemaVersion: 2, schemaVersion: 2, revision: 3 },
  );
  const missingV2Projected = await request(
    "/api/v1/workspace",
    "GET",
    undefined,
    missingV2Headers,
  );
  equal(missingV2Projected.workspace.instances, []);

  const put = Array.from({ length: 1_000 }, (_, index) => ({
    collection: "importRows",
    record: { id: `row-${index}`, importRunId: "run-1", rowNumber: index + 2, status: "created" },
  }));
  const committed = await request("/api/v2/workspace/transaction", "POST", {
    expectedRevision: 7, transactionId: "route-bounded-1", put,
  });
  equal(committed.revision, 8);
  check(JSON.stringify(committed).length < 180, "transaction response must stay constant-size");
  equal((await request("/api/v2/workspace/transaction", "POST", {
    expectedRevision: 7, transactionId: "route-bounded-1", put,
  })).idempotent, true);
  equal((await request("/api/v2/workspace/query-many", "POST", {
    collection: "importRows", key: "rowNumber", values: [2, 501, 1001],
  })).records.length, 3);
  const missingRunScan = await request("/api/v1/integrity-scan", "POST");
  equal(missingRunScan.healthy, false);
  check(
    missingRunScan.findings.some(finding => finding.code === "workspace_import_row_run_missing"),
    "v2 import-row relations must be scanned",
  );

  equal((await request("/api/v2/workspace/transaction", "POST", {
    expectedRevision: 8,
    transactionId: "route-add-run",
    put: [{
      collection: "importRuns",
      record: { id: "run-1", templateVersionId: "version-1", status: "completed" },
    }],
  })).revision, 9);
  equal((await request("/api/v1/integrity-scan", "POST")).healthy, true);

  equal((await request("/api/v2/workspace/transaction", "POST", {
    expectedRevision: 9,
    transactionId: "route-add-invalid-instance",
    put: [{
      collection: "instances",
      record: {
        id: "invalid-v2-instance",
        templateId: "missing-template",
        templateVersionId: "missing-version",
        status: "draft",
      },
    }],
  })).revision, 10);
  const invalidInstanceScan = await request("/api/v1/integrity-scan", "POST");
  check(
    invalidInstanceScan.findings.some(
      finding => finding.code === "workspace_instance_relation_invalid" &&
        finding.recordId === "invalid-v2-instance",
    ),
    "v2 instance relations must be scanned",
  );
  equal((await request("/api/v2/workspace/transaction", "POST", {
    expectedRevision: 10,
    transactionId: "route-remove-invalid-instance",
    deleteIds: [{ collection: "instances", ids: ["invalid-v2-instance"] }],
  })).revision, 11);

  equal((await request("/api/v2/workspace/transaction", "POST", {
    expectedRevision: 11,
    transactionId: "route-add-post-cutover-instance",
    put: [{
      collection: "instances",
      record: {
        id: "post-cutover-instance",
        templateId: "template-1",
        templateVersionId: "version-1",
        status: "draft",
        marker: "CURRENT-V2-ONLY",
      },
    }],
  })).revision, 12);
  const scopedBackup = await request("/api/v1/backups", "POST", {
    portable: true,
    templateId: "template-1",
  });
  const scopedArchive = unzipSync(Buffer.from(scopedBackup.archiveBase64, "base64"));
  const scopedEnvelope = JSON.parse(
    strFromU8(scopedArchive["account/workspace.json"]),
  );
  check(
    scopedEnvelope.workspace.instances.some(
      instance =>
        instance.id === "post-cutover-instance" &&
        instance.marker === "CURRENT-V2-ONLY",
    ),
    "Template Backup must read current Instances from Workspace v2",
  );
  equal(scopedBackup.manifest.scope, "template");
  equal(scopedBackup.manifest.summary.instanceCount, 2);

  let cursor = null;
  let count = 0;
  do {
    const page = await request("/api/v2/workspace/query", "POST", {
      collection: "importRows", where: { importRunId: "run-1" }, limit: 137, cursor,
    });
    count += page.records.length;
    cursor = page.nextCursor;
  } while (cursor);
  equal(count, 1_000);

  const exportResponse = await fetch(`${base}/api/v2/workspace/export?collection=importRows`, { headers });
  equal(exportResponse.status, 200);
  const exported = (await exportResponse.text()).trim().split("\n");
  equal(exported.length, 1_001);

  await stop();
  const missingV2Database = path.join(
    dataFolder,
    "workspace-v2",
    missingV2OwnerHash,
    "workspace-v2.sqlite",
  );
  check(missingV2Database.startsWith(scratch));
  await fs.rm(missingV2Database, { force: true });
  start();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  equal((await request("/api/v2/workspace/describe")).revision, 12);
  const missingV1Response = await fetch(`${base}/api/v1/workspace`, {
    headers: missingV2Headers,
  });
  equal(missingV1Response.status, 409);
  equal(
    (await missingV1Response.json()).error.code,
    "workspace_v2_restore_required",
  );
  const missingV2Response = await fetch(`${base}/api/v2/workspace/query`, {
    method: "POST",
    headers: missingV2Headers,
    body: JSON.stringify({ collection: "instances", limit: 1 }),
  });
  equal(missingV2Response.status, 409);
  equal(
    (await missingV2Response.json()).error.code,
    "workspace_v2_restore_required",
  );
  equal(await exists(missingV2Database), false);
  equal((await request("/api/v2/workspace/query", "POST", {
    collection: "importRows", where: { importRunId: "run-1" }, limit: 1,
  })).records.length, 1);
  check((await fs.stat(path.join(dataFolder, "workspace-v2", ownerHash, "workspace-v2.sqlite"))).isFile());
  const compactAfterRestart = await request(
    "/api/v1/workspace",
    "GET",
    undefined,
    largeHeaders,
  );
  equal(compactAfterRestart.revision, 25);
  equal(compactAfterRestart.workspace.instances, []);
  equal(
    compactAfterRestart.workspace.preferences.largeMigrationRegression,
    "persisted",
  );
  equal((await request("/api/v2/workspace/describe", "GET", undefined, largeHeaders)).revision, 23);
  const tail = await request("/api/v2/workspace/query", "POST", {
    collection: "instances",
    where: { id: "large-instance-063" },
    limit: 1,
  }, largeHeaders);
  equal(tail.records[0].marker, "SYNTHETIC-63");
  equal(tail.records[0].payload.length, largeLegacy.paddingBytes);
  equal(await hashFile(largeLegacyCopy), {
    size: largeLegacy.size,
    contentHash: largeLegacy.contentHash,
  });

  // The retained migration source is part of the projected generation. A
  // later process must fail closed if it disappears; it must never silently
  // accept a marker whose sourceHash no longer resolves to real bytes.
  await stop();
  check(largeLegacyCopy.startsWith(scratch));
  await fs.rm(largeLegacyCopy, { force: true });
  start();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const missingLegacySourceResponse = await fetch(`${base}/api/v1/workspace`, {
    headers: largeHeaders,
  });
  equal(missingLegacySourceResponse.status, 409);
  equal(
    (await missingLegacySourceResponse.json()).error.code,
    "workspace_v2_restore_required",
  );
  check(await exists(path.join(
    dataFolder,
    "workspace-v2",
    largeOwnerHash,
    "workspace-v2.sqlite",
  )));

  console.log(`Workspace v2 Local Service: ${assertions} assertions passed.`);
} finally {
  await stop().catch(() => {});
  await fs.rm(scratch, { recursive: true, force: true });
}
