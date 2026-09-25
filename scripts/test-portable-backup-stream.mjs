import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "formdigital-portable-stream-"));
const dataFolder = path.join(scratch, "data");
const configPath = path.join(scratch, "config.json");
const downloadedPath = path.join(scratch, "download.formdigital-backup");
const owner = "synthetic-portable-stream-owner";
const ownerHash = crypto.createHash("sha256").update(owner).digest("hex");
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

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()),
  );
  return port;
}

async function stop() {
  if (!service || service.exitCode !== null) return;
  service.kill();
  await new Promise(resolve => service.once("exit", resolve));
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

async function uploadPortableArchive(port, token, owner, archivePath) {
  const result = await uploadPortableArchiveResponse(
    port,
    token,
    owner,
    archivePath,
  );
  if (result.status >= 200 && result.status < 300) return result.payload;
  throw new Error(`${result.status}: ${JSON.stringify(result.payload)}`);
}

async function uploadPortableArchiveResponse(port, token, owner, archivePath) {
  const archiveStat = await fs.stat(archivePath);
  return new Promise((resolve, reject) => {
    const upload = http.request({
      hostname: "127.0.0.1",
      port,
      path: "/api/v1/portable-restore-sessions",
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-formdigital-owner": owner,
        "content-type": "application/octet-stream",
        "content-length": String(archiveStat.size),
      },
    }, response => {
      let payload = "";
      response.setEncoding("utf8");
      response.on("data", value => { payload += value; });
      response.on("end", () => {
        try {
          const parsed = JSON.parse(payload);
          resolve({ status: response.statusCode, payload: parsed });
        } catch (error) {
          reject(error);
        }
      });
    });
    upload.on("error", reject);
    createReadStream(archivePath).pipe(upload);
  });
}

async function listTree(target, relative = "") {
  const entries = await fs.readdir(target, { withFileTypes: true }).catch(error =>
    error?.code === "ENOENT" ? [] : Promise.reject(error),
  );
  const result = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const childPath = path.join(target, entry.name);
    if (entry.isDirectory()) result.push(...await listTree(childPath, childRelative));
    else if (entry.isFile()) result.push(`${childRelative}:${(await fs.stat(childPath)).size}`);
    else result.push(`${childRelative}:non-file`);
  }
  return result;
}

try {
  const port = await freePort();
  const accountRoot = path.join(dataFolder, "accounts", ownerHash);
  const objectsRoot = path.join(dataFolder, "objects");
  const manifestsRoot = path.join(dataFolder, "manifests");
  await Promise.all([
    fs.mkdir(accountRoot, { recursive: true }),
    fs.mkdir(objectsRoot, { recursive: true }),
    fs.mkdir(manifestsRoot, { recursive: true }),
  ]);
  const workspace = {
    schemaVersion: 2,
    ownerKey: owner,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    templates: [{ id: "template-1", name: "Original", lifecycle: "published" }],
    templateVersions: [{ id: "version-1", templateId: "template-1", state: "published" }],
    fields: [],
    instances: [{
      id: "instance-original",
      templateId: "template-1",
      templateVersionId: "version-1",
      status: "draft",
      values: {},
      outputHistory: [],
    }],
    folders: [], tags: [], savedValues: [], mappingTemplates: [], importRuns: [], importRows: [],
    mappingDecisions: [], detectionRuns: [], operationJournal: [], preferences: {},
  };
  await fs.writeFile(
    path.join(accountRoot, "workspace.json"),
    `${JSON.stringify({ revision: 4, workspace }, null, 2)}\n`,
  );

  // A stored, incompressible-by-policy (ZIP store method) synthetic object
  // larger than the old 50 MiB JSON transport ceiling.
  const objectBytes = 56 * 1024 * 1024;
  const objectTemp = path.join(objectsRoot, "object.pending");
  const handle = await fs.open(objectTemp, "wx");
  const objectHash = crypto.createHash("sha256");
  const chunk = Buffer.alloc(1024 * 1024, 0x5a);
  for (let offset = 0; offset < objectBytes; offset += chunk.length) {
    await handle.write(chunk);
    objectHash.update(chunk);
  }
  await handle.sync();
  await handle.close();
  const contentHash = objectHash.digest("hex");
  await fs.rename(objectTemp, path.join(objectsRoot, contentHash));
  await fs.writeFile(
    path.join(manifestsRoot, "asset-large.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "asset-large",
      ownerKeyHash: ownerHash,
      contentHash,
      originalFilename: "synthetic-large.bin",
      mimeType: "application/octet-stream",
      size: objectBytes,
      createdAt: "2026-01-01T00:00:00.000Z",
      metadata: { kind: "source" },
    }),
  );
  await fs.writeFile(configPath, JSON.stringify({
    schemaVersion: 1,
    port,
    dataFolder,
    token,
    allowedOrigins: [],
  }));

  service = spawn(process.execPath, [
    "--max-old-space-size=96",
    path.join(projectRoot, "local-data-service.mjs"),
  ], {
    cwd: projectRoot,
    env: {
      ...process.env,
      FORMDIGITAL_LOCAL_CONFIG: configPath,
      FORMDIGITAL_ENABLE_TEST_HOOKS: "1",
      FORMDIGITAL_TEST_PORTABLE_LEGACY_CREATE_MAX_BYTES: "256",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let serviceError = "";
  service.stderr.on("data", data => { serviceError += data.toString(); });
  const base = `http://127.0.0.1:${port}`;
  const headers = {
    authorization: `Bearer ${token}`,
    "x-formdigital-owner": owner,
    "content-type": "application/json",
  };
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {}
    if (service.exitCode !== null) throw new Error(serviceError || "service exited");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const request = async (route, method = "GET", body) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json();
    assert.equal(response.ok, true, `${route}: ${response.status} ${JSON.stringify(payload)}`);
    return payload;
  };

  equal((await request("/api/v2/workspace/describe")).revision, 4);
  const backup = await request("/api/v1/portable-backups", "POST", {});
  check(backup.archiveBytes > 50 * 1024 * 1024, "archive must exceed the legacy JSON ceiling");
  equal(backup.manifest.schemaVersion, 2);

  // A schema-v1/template backup must never be published when its archive is
  // larger than the matching legacy restore transport can accept. The small
  // limit is a test-only override; production remains fixed at 32 MiB.
  const backupFolder = path.join(dataFolder, "backups");
  const beforeRejectedLegacy = (await fs.readdir(backupFolder)).sort();
  const journalPath = path.join(dataFolder, "journal", "operations.ndjson");
  const beforeRejectedJournal = await fs.readFile(journalPath, "utf8");
  const rejectedLegacyResponse = await fetch(`${base}/api/v1/backups`, {
    method: "POST",
    headers,
    body: JSON.stringify({ portable: true, templateId: "template-1" }),
  });
  const rejectedLegacy = await rejectedLegacyResponse.json();
  equal(rejectedLegacyResponse.status, 413);
  equal(rejectedLegacy.error?.code, "portable_backup_requires_streaming");
  equal(
    rejectedLegacy.error?.message,
    "This backup is too large for the legacy transport. Create a complete account backup to use bounded streaming.",
  );
  check(
    !JSON.stringify(rejectedLegacy).includes(owner),
    "public rejection must not expose the owner value",
  );
  equal((await fs.readdir(backupFolder)).sort(), beforeRejectedLegacy);
  equal(await fs.readFile(journalPath, "utf8"), beforeRejectedJournal);

  const download = await fetch(
    `${base}/api/v1/portable-backups/${backup.id}/archive`,
    { headers },
  );
  equal(download.status, 200);
  check(!!download.body, "download stream must exist");
  await pipeline(
    /** @type {any} */ (download.body),
    (await import("node:fs")).createWriteStream(downloadedPath),
  );
  equal((await fs.stat(downloadedPath)).size, backup.archiveBytes);
  const { extractPortableZip, writePortableStoredZip } = await import(
    "../server/formdigital/portable-archive-stream.mjs"
  );
  const directExtractionRoot = path.join(scratch, "direct-extraction");
  const legacyArchivePath = path.join(
    scratch,
    "legacy-projected.formdigital-backup",
  );
  const invalidProjectedArchivePath = path.join(
    scratch,
    "invalid-projected.formdigital-backup",
  );
  const divergedLegacyArchivePath = path.join(
    scratch,
    "diverged-legacy.formdigital-backup",
  );
  let retainedSourceInfo;
  let legacyArchiveId;
  let legacyWorkspaceInfo;
  try {
    const directExtraction = await extractPortableZip(
      downloadedPath,
      directExtractionRoot,
      { validateEntryName: () => true },
    );
    equal(directExtraction.entries.size, backup.fileCount + 1);
    const archivedWorkspace = JSON.parse(
      await fs.readFile(
        directExtraction.entries.get("account/workspace.json").path,
        "utf8",
      ),
    );
    const archivedMarker =
      archivedWorkspace.workspace.preferences.__formdigitalWorkspaceV2;
    const retainedEntry = directExtraction.entries.get(
      "account/legacy-workspace.json",
    );
    check(!!retainedEntry, "projected backup must retain its migration source");
    retainedSourceInfo = await hashFile(retainedEntry.path);
    equal(retainedSourceInfo.contentHash, archivedMarker.sourceHash);
    equal(
      JSON.parse(await fs.readFile(retainedEntry.path, "utf8")).revision,
      archivedMarker.sourceRevision,
    );
    const fullManifest = JSON.parse(
      await fs.readFile(
        directExtraction.entries.get("backup-manifest.json").path,
        "utf8",
      ),
    );
    const writeVariantArchive = async ({
      target,
      id,
      workspaceEnvelope,
      includeRetained,
    }) => {
      const workspaceBytes = Buffer.from(JSON.stringify(workspaceEnvelope, null, 2));
      const variantFiles = fullManifest.files
        .filter(file => includeRetained || file.path !== "account/legacy-workspace.json")
        .map(file => file.path === "account/workspace.json"
          ? {
              ...file,
              size: workspaceBytes.byteLength,
              contentHash: sha256(workspaceBytes),
            }
          : file);
      const manifestBytes = Buffer.from(JSON.stringify({
        ...fullManifest,
        id,
        files: variantFiles,
      }, null, 2));
      async function* entries() {
        yield {
          archivePath: "backup-manifest.json",
          bytes: manifestBytes,
          size: manifestBytes.byteLength,
        };
        for (const file of variantFiles)
          yield file.path === "account/workspace.json"
            ? {
                archivePath: file.path,
                bytes: workspaceBytes,
                size: workspaceBytes.byteLength,
              }
            : {
                archivePath: file.path,
                sourcePath: directExtraction.entries.get(file.path).path,
                size: file.size,
              };
      }
      await writePortableStoredZip(target, entries());
      return variantFiles.find(file => file.path === "account/workspace.json");
    };

    const invalidProjectedEnvelope = structuredClone(archivedWorkspace);
    invalidProjectedEnvelope.workspace.instances = [{
      id: "TEST_PRIVATE_VALUE",
      templateId: "template-1",
      templateVersionId: "version-1",
      status: "draft",
    }];
    await writeVariantArchive({
      target: invalidProjectedArchivePath,
      id: `${fullManifest.id}-invalid-projected`,
      workspaceEnvelope: invalidProjectedEnvelope,
      includeRetained: true,
    });

    const divergedLegacyEnvelope = JSON.parse(
      await fs.readFile(retainedEntry.path, "utf8"),
    );
    divergedLegacyEnvelope.workspace.instances[0].status = "TEST_PRIVATE_VALUE";
    await writeVariantArchive({
      target: divergedLegacyArchivePath,
      id: `${fullManifest.id}-diverged-legacy`,
      workspaceEnvelope: divergedLegacyEnvelope,
      includeRetained: false,
    });

    legacyArchiveId = `${fullManifest.id}-legacy`;
    const legacyFiles = fullManifest.files.filter(
      file => file.path !== "account/legacy-workspace.json",
    );
    legacyWorkspaceInfo = legacyFiles.find(
      file => file.path === "account/workspace.json",
    );
    const legacyManifestBytes = Buffer.from(JSON.stringify({
      ...fullManifest,
      id: legacyArchiveId,
      files: legacyFiles,
    }, null, 2));
    async function* legacyArchiveEntries() {
      yield {
        archivePath: "backup-manifest.json",
        bytes: legacyManifestBytes,
        size: legacyManifestBytes.byteLength,
      };
      for (const file of legacyFiles)
        yield {
          archivePath: file.path,
          sourcePath: directExtraction.entries.get(file.path).path,
          size: file.size,
        };
    }
    await writePortableStoredZip(legacyArchivePath, legacyArchiveEntries());
  } finally {
    await fs.rm(directExtractionRoot, { recursive: true, force: true });
  }

  const captureRestoreState = async () => ({
    workspace: await hashFile(path.join(accountRoot, "workspace.json")),
    workspaceV2: await hashFile(path.join(
      dataFolder,
      "workspace-v2",
      ownerHash,
      "workspace-v2.sqlite",
    )),
    manifests: await listTree(manifestsRoot),
    objects: await listTree(objectsRoot),
    backups: await listTree(path.join(dataFolder, "backups")),
    metadata: await listTree(path.join(dataFolder, "metadata")),
    staging: await listTree(path.join(dataFolder, "staging")),
    journal: await hashFile(journalPath),
  });
  const beforeInvalidArchives = await captureRestoreState();
  for (const invalidArchive of [
    invalidProjectedArchivePath,
    divergedLegacyArchivePath,
  ]) {
    const rejected = await uploadPortableArchiveResponse(
      port,
      token,
      owner,
      invalidArchive,
    );
    equal(rejected.status, 422);
    equal(rejected.payload?.error?.code, "portable_archive_rejected");
    equal(
      rejected.payload?.error?.message,
      "Portable Backup failed bounded verification. No change was made.",
    );
    check(!JSON.stringify(rejected.payload).includes("TEST_PRIVATE_VALUE"));
    equal(await captureRestoreState(), beforeInvalidArchives);
  }

  // Mutate both stores after the snapshot. A full restore must return both to
  // one coherent generation.
  const projectedBeforeMutation = await request("/api/v1/workspace");
  const mutatedWorkspace = structuredClone(projectedBeforeMutation.workspace);
  mutatedWorkspace.templates[0].name = "Mutated after backup";
  await request("/api/v1/workspace", "PUT", {
    expectedRevision: projectedBeforeMutation.revision,
    workspace: mutatedWorkspace,
  });
  equal((await request("/api/v2/workspace/transaction", "POST", {
    expectedRevision: 4,
    transactionId: "after-backup-mutation",
    put: [{
      collection: "instances",
      record: {
        id: "instance-after-backup",
        templateId: "template-1",
        templateVersionId: "version-1",
        status: "draft",
        values: {},
        outputHistory: [],
      },
    }],
  })).revision, 5);

  const uploadResult = await uploadPortableArchive(
    port,
    token,
    owner,
    downloadedPath,
  );
  equal(uploadResult.manifest.schemaVersion, 2);
  const restored = await request(
    `/api/v1/portable-restore-sessions/${uploadResult.sessionId}/commit`,
    "POST",
  );
  equal(restored.restored, true);
  check(typeof restored.emergencyBackupId === "string");
  const restoredWorkspace = await request("/api/v1/workspace");
  equal(restoredWorkspace.workspace.templates[0].name, "Original");
  const restoredMarker =
    restoredWorkspace.workspace.preferences.__formdigitalWorkspaceV2;
  equal(restoredMarker.sourceHash, retainedSourceInfo.contentHash);
  equal(restoredMarker.safetyBackupId, backup.id);
  equal(
    await hashFile(path.join(
      dataFolder,
      "workspace-v2",
      ownerHash,
      "legacy-workspace.json",
    )),
    retainedSourceInfo,
  );
  check(
    await fs.stat(path.join(
      dataFolder,
      "backups",
      "emergency",
      `${backup.id}.formdigital-backup`,
    )).then(stat => stat.isFile(), () => false),
    "restored marker safety backup must resolve to a local archive",
  );
  equal((await request("/api/v2/workspace/describe")).revision, 4);
  equal((await request("/api/v2/workspace/query", "POST", {
    collection: "instances",
    where: { id: "instance-after-backup" },
    limit: 10,
  })).records.length, 0);
  equal((await request("/api/v1/integrity-scan", "POST")).healthy, true);

  // Backward compatibility: early projected schema-v2 archives did not carry
  // the retained source. Restore them by rebasing the marker to the compact
  // workspace bytes that the archive actually contains.
  const legacyUpload = await uploadPortableArchive(
    port,
    token,
    owner,
    legacyArchivePath,
  );
  equal(legacyUpload.manifest.id, legacyArchiveId);
  equal((await request(
    `/api/v1/portable-restore-sessions/${legacyUpload.sessionId}/commit`,
    "POST",
  )).restored, true);
  const rebasedWorkspace = await request("/api/v1/workspace");
  const rebasedMarker =
    rebasedWorkspace.workspace.preferences.__formdigitalWorkspaceV2;
  equal(rebasedMarker.sourceRevision, rebasedWorkspace.revision);
  equal(rebasedMarker.sourceHash, legacyWorkspaceInfo.contentHash);
  equal(rebasedMarker.safetyBackupId, legacyArchiveId);
  equal(
    await hashFile(path.join(
      dataFolder,
      "workspace-v2",
      ownerHash,
      "legacy-workspace.json",
    )),
    {
      size: legacyWorkspaceInfo.size,
      contentHash: legacyWorkspaceInfo.contentHash,
    },
  );
  check(
    await fs.stat(path.join(
      dataFolder,
      "backups",
      "emergency",
      `${legacyArchiveId}.formdigital-backup`,
    )).then(stat => stat.isFile(), () => false),
    "rebased marker safety backup must resolve locally",
  );

  console.log(`Portable Backup stream: ${assertions} assertions passed.`);
} finally {
  await stop().catch(() => {});
  await fs.rm(scratch, { recursive: true, force: true });
}
