import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pausePoints = [
  "after_descriptor_swapping",
  "after_first_object",
  "after_manifests",
  "after_workspace",
  "after_workspace_v2",
  "after_descriptor_committed",
];
let assertions = 0;

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

async function fileHash(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
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

async function stopService(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise(resolve => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
}

async function startService(configPath, port, extraEnv = {}) {
  const child = spawn(process.execPath, [
    "--max-old-space-size=96",
    path.join(projectRoot, "local-data-service.mjs"),
  ], {
    cwd: projectRoot,
    env: {
      ...process.env,
      FORMDIGITAL_LOCAL_CONFIG: configPath,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.on("data", data => { stderr += data.toString(); });
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return child;
    } catch {}
    if (child.exitCode !== null)
      throw new Error(stderr || "Local Data Service exited during startup.");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  await stopService(child);
  throw new Error(`Local Data Service startup timed out. ${stderr}`);
}

function requestHelpers(port, token, owner) {
  const base = `http://127.0.0.1:${port}`;
  const headers = {
    authorization: `Bearer ${token}`,
    "x-formdigital-owner": owner,
    "content-type": "application/json",
  };
  const request = async (route, method = "GET", body) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`${route}: ${response.status} returned invalid JSON.`);
    }
    assert.equal(
      response.ok,
      true,
      `${route}: ${response.status} ${JSON.stringify(payload)}`,
    );
    return payload;
  };
  return { base, headers, request };
}

async function uploadArchive(port, token, owner, archivePath) {
  const stat = await fs.stat(archivePath);
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
        "content-length": String(stat.size),
      },
    }, response => {
      let payload = "";
      response.setEncoding("utf8");
      response.on("data", value => { payload += value; });
      response.on("end", () => {
        try {
          const parsed = JSON.parse(payload);
          if (response.statusCode >= 200 && response.statusCode < 300) resolve(parsed);
          else reject(new Error(`${response.statusCode}: ${payload}`));
        } catch (error) {
          reject(error);
        }
      });
    });
    upload.on("error", reject);
    createReadStream(archivePath).pipe(upload);
  });
}

async function waitForCheckpoint(markerPath, point, child) {
  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    const marker = await fs.readFile(markerPath, "utf8").catch(() => null);
    if (marker === point) return;
    if (child.exitCode !== null)
      throw new Error(`Service exited before checkpoint ${point}.`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for checkpoint ${point}.`);
}

async function ownerManifestNames(manifestsRoot, ownerHash) {
  const names = [];
  for (const name of await fs.readdir(manifestsRoot)) {
    if (!name.endsWith(".json")) continue;
    const manifest = JSON.parse(
      await fs.readFile(path.join(manifestsRoot, name), "utf8"),
    );
    if (manifest.ownerKeyHash === ownerHash) names.push(name);
  }
  return names.sort();
}

async function runScenario(point, { missingDatabase = false } = {}) {
  const scenarioName = missingDatabase ? `${point}-missing-db` : point;
  const scratch = await fs.mkdtemp(
    path.join(os.tmpdir(), `formdigital-portable-crash-${scenarioName}-`),
  );
  const dataFolder = path.join(scratch, "data");
  const configPath = path.join(scratch, "config.json");
  const archivePath = path.join(scratch, "snapshot.formdigital-backup");
  const owner = `synthetic-crash-owner-${scenarioName}`;
  const ownerHash = sha256(Buffer.from(owner));
  const token = crypto.randomBytes(24).toString("base64url");
  const port = await freePort();
  const accountRoot = path.join(dataFolder, "accounts", ownerHash);
  const workspacePath = path.join(accountRoot, "workspace.json");
  const workspaceV2Path = path.join(
    dataFolder,
    "workspace-v2",
    ownerHash,
    "workspace-v2.sqlite",
  );
  const objectsRoot = path.join(dataFolder, "objects");
  const manifestsRoot = path.join(dataFolder, "manifests");
  const stagingRoot = path.join(dataFolder, "staging");
  const markerPath = path.join(
    stagingRoot,
    ".formdigital-portable-restore-test-checkpoint",
  );
  let service;
  try {
    await Promise.all([
      fs.mkdir(accountRoot, { recursive: true }),
      fs.mkdir(objectsRoot, { recursive: true }),
      fs.mkdir(manifestsRoot, { recursive: true }),
    ]);
    const originalWorkspace = {
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
      folders: [],
      tags: [],
      savedValues: [],
      mappingTemplates: [],
      importRuns: [],
      importRows: [],
      mappingDecisions: [],
      detectionRuns: [],
      operationJournal: [],
      preferences: {},
    };
    const originalWorkspaceBytes = Buffer.from(
      `${JSON.stringify({ revision: 4, workspace: originalWorkspace }, null, 2)}\n`,
    );
    await fs.writeFile(workspacePath, originalWorkspaceBytes);

    const originalObject = Buffer.from(`ORIGINAL-OBJECT-${point}`);
    const originalObjectHash = sha256(originalObject);
    await fs.writeFile(path.join(objectsRoot, originalObjectHash), originalObject);
    const originalManifestBytes = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      id: "asset-original",
      ownerKeyHash: ownerHash,
      contentHash: originalObjectHash,
      originalFilename: "original.bin",
      mimeType: "application/octet-stream",
      size: originalObject.byteLength,
      createdAt: "2026-01-01T00:00:00.000Z",
      metadata: { kind: "source" },
    }));
    await fs.writeFile(
      path.join(manifestsRoot, "asset-original.json"),
      originalManifestBytes,
    );
    await fs.writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      port,
      dataFolder,
      token,
      allowedOrigins: [],
    }));

    service = await startService(configPath, port);
    let api = requestHelpers(port, token, owner);
    equal((await api.request("/api/v2/workspace/describe")).revision, 4);
    const backup = await api.request("/api/v1/portable-backups", "POST", {});
    const download = await fetch(
      `${api.base}/api/v1/portable-backups/${backup.id}/archive`,
      { headers: api.headers },
    );
    assert.equal(download.ok, true);
    await pipeline(
      /** @type {any} */ (download.body),
      createWriteStream(archivePath),
    );
    const originalV2Hash = await fileHash(workspaceV2Path);

    const projectedOriginal = await api.request("/api/v1/workspace");
    const projectedMarker =
      projectedOriginal.workspace.preferences.__formdigitalWorkspaceV2;
    const restoredWorkspaceHash = sha256(Buffer.from(JSON.stringify({
      ...projectedOriginal,
      workspace: {
        ...projectedOriginal.workspace,
        preferences: {
          ...projectedOriginal.workspace.preferences,
          __formdigitalWorkspaceV2: {
            ...projectedMarker,
            safetyBackupId: backup.id,
          },
        },
      },
    }, null, 2)));
    const currentWorkspace = structuredClone(projectedOriginal.workspace);
    currentWorkspace.templates[0].name = "Current before restore";
    await api.request("/api/v1/workspace", "PUT", {
      expectedRevision: projectedOriginal.revision,
      workspace: currentWorkspace,
    });
    await api.request("/api/v2/workspace/transaction", "POST", {
      expectedRevision: 4,
      transactionId: `current-${point}`,
      delete: [{ collection: "instances", id: "instance-original" }],
      put: [{
        collection: "instances",
        record: {
          id: "instance-current",
          templateId: "template-1",
          templateVersionId: "version-1",
          status: "draft",
          values: {},
          outputHistory: [],
        },
      }],
    });

    const currentObject = Buffer.from(`CURRENT-OBJECT-${point}`);
    const currentObjectHash = sha256(currentObject);
    await fs.writeFile(path.join(objectsRoot, currentObjectHash), currentObject);
    const currentManifestBytes = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      id: "asset-current",
      ownerKeyHash: ownerHash,
      contentHash: currentObjectHash,
      originalFilename: "current.bin",
      mimeType: "application/octet-stream",
      size: currentObject.byteLength,
      createdAt: "2026-01-02T00:00:00.000Z",
      metadata: { kind: "source" },
    }));
    await fs.rm(path.join(manifestsRoot, "asset-original.json"));
    await fs.writeFile(
      path.join(manifestsRoot, "asset-current.json"),
      currentManifestBytes,
    );
    const currentWorkspaceHash = await fileHash(workspacePath);
    const currentV2Hash = await fileHash(workspaceV2Path);
    const session = await uploadArchive(port, token, owner, archivePath);
    check(
      /^[0-9a-f-]{36}$/i.test(session.sessionId),
      `${point}: restore session must be a UUID`,
    );

    await stopService(service);
    service = null;
    let retainedSourceBeforeMissingDatabase = null;
    if (missingDatabase) {
      retainedSourceBeforeMissingDatabase = await fileHash(path.join(
        dataFolder,
        "workspace-v2",
        ownerHash,
        "legacy-workspace.json",
      ));
      await fs.rm(workspaceV2Path);
    }
    service = await startService(configPath, port, {
      FORMDIGITAL_ENABLE_TEST_HOOKS: "1",
      FORMDIGITAL_TEST_PORTABLE_RESTORE_PAUSE_AT: point,
    });
    api = requestHelpers(port, token, owner);
    const commit = api.request(
      `/api/v1/portable-restore-sessions/${session.sessionId}/commit`,
      "POST",
    );
    void commit.catch(() => {});
    await waitForCheckpoint(markerPath, point, service);
    await stopService(service);
    service = null;
    await fs.rm(markerPath, { force: true });

    service = await startService(configPath, port);
    api = requestHelpers(port, token, owner);
    const committed = point === "after_descriptor_committed";
    if (missingDatabase && !committed) {
      const workspaceResponse = await fetch(`${api.base}/api/v1/workspace`, {
        headers: api.headers,
      });
      equal(workspaceResponse.status, 409, `${scenarioName}: missing DB remains explicit`);
      equal(
        (await workspaceResponse.json()).error?.code,
        "workspace_v2_restore_required",
        `${scenarioName}: fixed restore-required response`,
      );
      equal(
        await fs.stat(workspaceV2Path).then(() => true, () => false),
        false,
        `${scenarioName}: rollback must not invent the missing database`,
      );
      equal(
        await fileHash(path.join(
          dataFolder,
          "workspace-v2",
          ownerHash,
          "legacy-workspace.json",
        )),
        retainedSourceBeforeMissingDatabase,
        `${scenarioName}: retained legacy source survives rollback byte-exactly`,
      );
    } else {
      const workspaceResult = await api.request("/api/v1/workspace");
      equal(
        workspaceResult.workspace.templates[0].name,
        committed ? "Original" : "Current before restore",
        `${scenarioName}: v1 generation`,
      );
      equal(
        (await api.request("/api/v2/workspace/describe")).revision,
        committed ? 4 : 5,
        `${scenarioName}: v2 generation`,
      );
    }
    equal(
      await fileHash(workspacePath),
      committed ? restoredWorkspaceHash : currentWorkspaceHash,
      `${scenarioName}: v1 bytes`,
    );
    if (!missingDatabase || committed)
      equal(
        await fileHash(workspaceV2Path),
        committed ? originalV2Hash : currentV2Hash,
        `${scenarioName}: v2 bytes`,
      );
    equal(
      await ownerManifestNames(manifestsRoot, ownerHash),
      [committed ? "asset-original.json" : "asset-current.json"],
      `${scenarioName}: exact manifest generation`,
    );
    equal(
      await fs.readFile(path.join(
        manifestsRoot,
        committed ? "asset-original.json" : "asset-current.json",
      )),
      committed ? originalManifestBytes : currentManifestBytes,
      `${scenarioName}: manifest bytes`,
    );
    const stagingNames = await fs.readdir(stagingRoot);
    check(
      !stagingNames.some(name =>
        name.startsWith(".formdigital-portable-restore-") ||
        name.startsWith("restore-portable-")),
      `${scenarioName}: durable restore artifacts must be recovered`,
    );
    equal(
      await fs.stat(
        path.join(stagingRoot, `portable-session-${session.sessionId}`),
      ).then(() => true, () => false),
      !committed,
      `${scenarioName}: committed sessions are consumed; rolled-back sessions remain retryable`,
    );
    const emergencyFiles = await fs.readdir(
      path.join(dataFolder, "backups", "emergency"),
    );
    check(
      emergencyFiles.some(name => name.endsWith(".formdigital-backup")),
      `${scenarioName}: pre-restore Emergency Backup must be preserved`,
    );
    if (!missingDatabase || committed)
      equal(
        (await api.request("/api/v1/integrity-scan", "POST")).healthy,
        true,
        `${scenarioName}: recovered generation must pass integrity scan`,
      );
  } finally {
    await stopService(service).catch(() => {});
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

for (const point of pausePoints) await runScenario(point);
await runScenario("after_workspace", { missingDatabase: true });

console.log(`Portable restore crash recovery: ${assertions} assertions passed.`);
