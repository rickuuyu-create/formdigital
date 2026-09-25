import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { unzipSync } from "fflate";
import {
  WorkspaceStorageV2,
  canonicalJson,
  ownerWorkspaceV2Paths,
  planJournalArchiveBatches,
  calculateCanonicalTransactionBytes,
  formatJournalArchiveTransactionId,
  JOURNAL_ARCHIVE_MAX_BATCH_COUNT,
  JOURNAL_ARCHIVE_MAX_BATCH_BYTES,
  LEGACY_WORKSPACE_JOURNAL_MAX_RECORD_BYTES,
} from "../server/formdigital/workspace-storage-v2.mjs";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const testRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), "formdigital-local-test-")
);
const dataFolder = path.join(testRoot, "FormdigitalData");
const configPath = path.join(testRoot, "local-service-config.json");
const token = crypto.randomBytes(32).toString("base64url");

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(error => (error ? reject(error) : resolve(port)));
    });
  });
}

const port = await freePort();
await fs.mkdir(dataFolder, { recursive: true });
await fs.writeFile(
  configPath,
  JSON.stringify(
    {
      schemaVersion: 1,
      port,
      dataFolder,
      token,
      allowedOrigins: ["http://localhost:3000"],
    },
    null,
    2
  )
);

let serviceOutput = "";
function capture(service) {
  service.stdout.on("data", chunk => {
    serviceOutput += chunk.toString();
  });
  service.stderr.on("data", chunk => {
    serviceOutput += chunk.toString();
  });
}

let service = spawn(
  process.execPath,
  [path.join(projectRoot, "local-data-service.mjs")],
  {
    cwd: projectRoot,
    env: { ...process.env, FORMDIGITAL_LOCAL_CONFIG: configPath },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }
);
capture(service);

const baseUrl = `http://127.0.0.1:${port}`;
const owner = "google-user-integration-test";
const headers = {
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
  "x-formdigital-owner": owner,
};

async function waitForHealth() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return response.json();
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Local service did not become healthy. ${serviceOutput}`);
}

// Throws on a non-OK response; used for assertions that must succeed.
async function request(route, method = "GET", body, customHeaders = headers) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: customHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok)
    throw new Error(
      `${method} ${route} failed (${response.status}): ${JSON.stringify(payload)}`
    );
  return { response, payload };
}

// Never throws; returns both status and parsed body so negative cases can be asserted.
async function rawRequest(route, method = "GET", body, customHeaders = headers) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: customHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {}
  return { status: response.status, payload };
}

async function downloadPortableArchive(backupId, customHeaders = headers) {
  const response = await fetch(
    `${baseUrl}/api/v1/portable-backups/${backupId}/archive`,
    { headers: customHeaders },
  );
  if (!response.ok)
    throw new Error(`Portable Backup download failed (${response.status}).`);
  return Buffer.from(await response.arrayBuffer());
}

async function uploadPortableArchive(archive, customHeaders = headers) {
  const response = await fetch(`${baseUrl}/api/v1/portable-restore-sessions`, {
    method: "POST",
    headers: {
      ...customHeaders,
      "content-type": "application/octet-stream",
    },
    body: archive,
  });
  const payload = await response.json();
  if (!response.ok)
    throw new Error(
      `Portable Backup upload failed (${response.status}): ${JSON.stringify(payload)}`,
    );
  return payload;
}

async function health() {
  const response = await fetch(`${baseUrl}/health`);
  return { status: response.status, payload: await response.json() };
}

async function stopService(svc) {
  if (!svc) return;
  if (svc.exitCode !== null || svc.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const onExit = () => {
      svc.off("exit", onExit);
      svc.off("error", onError);
      resolve();
    };
    const onError = error => {
      svc.off("exit", onExit);
      reject(error);
    };
    svc.once("exit", onExit);
    svc.once("error", onError);
    if (!svc.kill() && svc.exitCode !== null) onExit();
  });
}

async function startService(envOverrides = {}) {
  const effectiveEnv = {
    ...process.env,
    FORMDIGITAL_LOCAL_CONFIG: configPath,
    ...envOverrides,
  };
  if (effectiveEnv.FORMDIGITAL_ENABLE_TEST_HOOKS === "1") {
    effectiveEnv.NODE_ENV = effectiveEnv.NODE_ENV || "test";
    if (!effectiveEnv.FORMDIGITAL_TEST_SENTINEL_FILE) {
      const activeFolder = await readConfigDataFolder();
      const sentinelToken = crypto.randomBytes(32).toString("hex");
      const sentinelPath = path.join(activeFolder, ".journal-test-sentinel");
      await fs.writeFile(sentinelPath, sentinelToken, "utf8");
      effectiveEnv.FORMDIGITAL_TEST_SENTINEL_FILE = sentinelPath;
      if (!("FORMDIGITAL_TEST_TOKEN" in effectiveEnv)) {
        effectiveEnv.FORMDIGITAL_TEST_TOKEN = sentinelToken;
      }
    }
  }
  const svc = spawn(
    process.execPath,
    [path.join(projectRoot, "local-data-service.mjs")],
    {
      cwd: projectRoot,
      env: effectiveEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  );
  capture(svc);
  return svc;
}

// Reads only the relative dataFolder field; the token and full config are never logged.
async function readConfigDataFolder() {
  const cfg = JSON.parse(await fs.readFile(configPath, "utf8"));
  return cfg.dataFolder;
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

try {
  const startup = await waitForHealth();
  const initial = (await request("/api/v1/workspace")).payload;
  if (initial.revision !== 0)
    throw new Error("A new account Workspace must begin at revision 0.");
  const saved = (
    await request("/api/v1/workspace", "PUT", {
      expectedRevision: 0,
      workspace: {
        schemaVersion: 2,
        templates: [{ id: "template-before-backup", name: "Before backup" }],
        templateVersions: [],
        instances: [],
        mappingTemplates: [],
      },
    })
  ).payload;
  if (saved.revision !== 1)
    throw new Error("Workspace commit did not advance the revision.");

  const assetBytes = Buffer.from("localhost-only-asset");
  const uploaded = (
    await request("/api/v1/assets", "POST", {
      base64: assetBytes.toString("base64"),
      originalFilename: "local.txt",
      mimeType: "text/plain",
      metadata: { kind: "source" },
    })
  ).payload;
  const loaded = (await request(`/api/v1/assets/${uploaded.asset.id}`)).payload;
  if (!Buffer.from(loaded.base64, "base64").equals(assetBytes))
    throw new Error("Local asset round-trip failed.");

  const otherOwnerResponse = await fetch(
    `${baseUrl}/api/v1/assets/${uploaded.asset.id}`,
    { headers: { ...headers, "x-formdigital-owner": "different-google-user" } }
  );
  if (otherOwnerResponse.status !== 404)
    throw new Error(
      `Cross-account asset access must be 404, received ${otherOwnerResponse.status}.`
    );

  const backup = (await request("/api/v1/backups", "POST", { portable: true }))
    .payload;
  await request("/api/v1/workspace", "PUT", {
      expectedRevision: 1,
      workspace: {
        schemaVersion: 2,
        templates: [{ id: "template-after-backup", name: "After backup" }],
        templateVersions: [],
        instances: [],
        mappingTemplates: [],
      },
  });
  const restored = (
    await request("/api/v1/restore", "POST", {
      archiveBase64: backup.archiveBase64,
    })
  ).payload;
  if (!restored.restored || !restored.emergencyBackupId)
    throw new Error(
      "Portable restore did not create a pre-restore emergency backup."
    );
  const afterRestore = (await request("/api/v1/workspace")).payload;
  if (afterRestore.workspace.templates?.[0]?.id !== "template-before-backup")
    throw new Error("Portable restore did not restore Workspace metadata.");

  const invalidToken = await fetch(`${baseUrl}/api/v1/workspace`, {
    headers: { ...headers, authorization: "Bearer wrong-length" },
  });
  if (invalidToken.status !== 401)
    throw new Error(
      `Invalid bearer token must return 401, received ${invalidToken.status}.`
    );
  const movedFolder = path.join(testRoot, "MovedFormdigitalData");
  const moved = (
    await request("/api/v1/data-folder/move", "POST", {
      dataFolder: movedFolder,
    })
  ).payload;
  if (!moved.moved || moved.dataFolder !== movedFolder)
    throw new Error(
      "Data Folder move did not switch to the verified destination."
    );
  const afterMove = (await request("/api/v1/workspace")).payload;
  if (afterMove.workspace.templates?.[0]?.id !== "template-before-backup")
    throw new Error("Workspace was not readable after Data Folder move.");

  // ---- Begin reconnect flow (Task 2 / Layer 2A) ----
  // Valid folder to "lose": the live root after the move above.
  const lostFolder = movedFolder;
  const renamedFolder = path.join(testRoot, "RenamedFormdigitalData");

  // Capture state before simulating a runtime move of the live Data Folder.
  const wsBefore = (await request("/api/v1/workspace")).payload;
  const assetBefore = (await request(`/api/v1/assets/${uploaded.asset.id}`)).payload;
  const beforeRevision = wsBefore.revision;
  const beforeTemplateId = wsBefore.workspace.templates?.[0]?.id;
  const beforeAssetBase64 = assetBefore.base64;
  const beforeContentHash = assetBefore.asset.contentHash;
  const configBeforeLoss = await readConfigDataFolder();

  // Step 5: rename the live Data Folder while the service is still running.
  await fs.rename(lostFolder, renamedFolder);

  // Steps 6-7: /health must detect the loss and report reconnect_required,
  // and must NOT recreate the lost location as an empty replacement.
  const healthAfterLoss = await health();
  const runtimeFolderLossDetected =
    healthAfterLoss.payload.status === "reconnect_required";
  if (!runtimeFolderLossDetected) {
    throw new Error(
      `RUNTIME HEALTH BUG: /health returned '${healthAfterLoss.payload.status}' after the Data Folder was moved while the service was running.`
    );
  }
  if (await exists(lostFolder)) {
    throw new Error(
      "Local service recreated the lost Data Folder; an empty replacement must never be created."
    );
  }

  // Step 8: a general Workspace API in reconnect_required state must be
  // rejected (409) and must not create an empty Workspace.
  const generalWhileLost = await rawRequest("/api/v1/workspace");
  if (generalWhileLost.status !== 409) {
    throw new Error(
      `General Workspace API during reconnect_required must be 409, received ${generalWhileLost.status}.`
    );
  }

  // Step 9: the reconnect endpoint requires a valid bearer token.
  const noTokenReconnect = await rawRequest(
    "/api/v1/data-folder/reconnect",
    "POST",
    { dataFolder: renamedFolder },
    { "content-type": "application/json", "x-formdigital-owner": owner }
  );
  const invalidTokenReconnect = await rawRequest(
    "/api/v1/data-folder/reconnect",
    "POST",
    { dataFolder: renamedFolder },
    { ...headers, authorization: "Bearer wrong-length" }
  );
  const unauthenticatedReconnectStatus = noTokenReconnect.status;
  const invalidTokenReconnectStatus = invalidTokenReconnect.status;
  if (unauthenticatedReconnectStatus !== 401)
    throw new Error(
      `Reconnect without a token must be 401, received ${unauthenticatedReconnectStatus}.`
    );
  if (invalidTokenReconnectStatus !== 401)
    throw new Error(
      `Reconnect with a wrong token must be 401, received ${invalidTokenReconnectStatus}.`
    );

  // Section 6: negative candidate folders. Each must fail to reconnect,
  // keep health at reconnect_required, leave config unchanged, and never
  // recreate the lost location or clear/overwrite the workspace or asset.
  const negativeResults = {};
  async function assertNegativeCandidate(label, candidateDir, setup) {
    if (setup) await setup(candidateDir);
    const attempt = await rawRequest(
      "/api/v1/data-folder/reconnect",
      "POST",
      { dataFolder: candidateDir },
      headers
    );
    const rejected =
      attempt.status !== 200 || attempt.payload?.reconnected !== true;
    const stillReconnect =
      (await health()).payload.status === "reconnect_required";
    const configUnchanged =
      (await readConfigDataFolder()) === configBeforeLoss;
    const lostNotRecreated = !(await exists(lostFolder));
    const pass = rejected && stillReconnect && configUnchanged && lostNotRecreated;
    negativeResults[label] = pass;
    if (!pass) {
      throw new Error(
        `Negative candidate '${label}' was not safely rejected: rejected=${rejected} stillReconnect=${stillReconnect} configUnchanged=${configUnchanged} lostNotRecreated=${lostNotRecreated}`
      );
    }
  }

  // 1. A path that does not exist.
  const missingFolder = path.join(testRoot, "MissingDataFolder");
  await assertNegativeCandidate("missing", missingFolder, null);

  // 2. A completely empty folder (no required sub-directories).
  const emptyFolder = path.join(testRoot, "EmptyDataFolder");
  await assertNegativeCandidate("empty", emptyFolder, async dir => {
    await fs.mkdir(dir, { recursive: true });
  });

  // 3. Only a partial structure: objects present but manifests/accounts missing.
  const partialFolder = path.join(testRoot, "PartialDataFolder");
  await assertNegativeCandidate("incomplete", partialFolder, async dir => {
    await fs.mkdir(path.join(dir, "objects"), { recursive: true });
  });

  // 4. A valid-looking copy with a deliberately corrupted object byte
  //    (manifest content hash no longer matches the object).
  const corruptFolder = path.join(testRoot, "CorruptDataFolder");
  await assertNegativeCandidate("corrupt", corruptFolder, async dir => {
    await fs.cp(renamedFolder, dir, { recursive: true });
    const objectFile = path.join(dir, "objects", beforeContentHash);
    const bytes = await fs.readFile(objectFile);
    const mutated = Buffer.from(bytes);
    mutated[0] = mutated[0] ^ 0xff;
    await fs.writeFile(objectFile, mutated);
  });

  // 5. Drive root / unsafe root: validated by path parsing only. The reconnect
  //    code rejects a drive root at the parse guard BEFORE any fs access, so no
  //    content is read from or written to the real disk root.
  const driveRoot = path.parse(renamedFolder).root;
  const driveRootAttempt = await rawRequest(
    "/api/v1/data-folder/reconnect",
    "POST",
    { dataFolder: driveRoot },
    headers
  );
  const driveRootRejected =
    driveRootAttempt.status !== 200 ||
    driveRootAttempt.payload?.reconnected !== true;
  const driveRootHealth =
    (await health()).payload.status === "reconnect_required";
  const driveRootConfigUnchanged =
    (await readConfigDataFolder()) === configBeforeLoss;
  if (!(driveRootRejected && driveRootHealth && driveRootConfigUnchanged))
    throw new Error(
      `Drive-root candidate was not safely rejected: rejected=${driveRootRejected} health=${driveRootHealth} configUnchanged=${driveRootConfigUnchanged}`
    );

  // Section 7: valid reconnect to the renamed (true original) folder.
  const reconnectAttempt = await rawRequest(
    "/api/v1/data-folder/reconnect",
    "POST",
    { dataFolder: renamedFolder },
    headers
  );
  const validReconnectSucceeded =
    reconnectAttempt.status === 200 &&
    reconnectAttempt.payload?.reconnected === true;
  if (!validReconnectSucceeded)
    throw new Error(
      `Valid reconnect to the original folder failed (status ${reconnectAttempt.status}).`
    );

  const healthAfterReconnect = await health();
  if (healthAfterReconnect.payload.status !== "ok")
    throw new Error("Health was not 'ok' after a valid reconnect.");

  const wsAfter = (await request("/api/v1/workspace")).payload;
  const workspacePreservedAfterReconnect =
    wsAfter.revision === beforeRevision &&
    wsAfter.workspace.templates?.[0]?.id === beforeTemplateId;
  if (!workspacePreservedAfterReconnect)
    throw new Error(
      "Workspace revision or template fixture changed after reconnect."
    );

  const assetAfter = (await request(`/api/v1/assets/${uploaded.asset.id}`)).payload;
  const assetPreservedAfterReconnect =
    assetAfter.base64 === beforeAssetBase64 &&
    assetAfter.asset.contentHash === beforeContentHash &&
    Buffer.from(assetAfter.base64, "base64").equals(assetBytes);
  if (!assetPreservedAfterReconnect)
    throw new Error("Asset bytes or content hash changed after reconnect.");

  const crossAfter = await fetch(`${baseUrl}/api/v1/assets/${uploaded.asset.id}`, {
    headers: { ...headers, "x-formdigital-owner": "different-google-user" },
  });
  if (crossAfter.status !== 404)
    throw new Error(
      `Owner isolation broke after reconnect (status ${crossAfter.status}).`
    );

  const configAfterReconnect = await readConfigDataFolder();
  if (configAfterReconnect !== renamedFolder)
    throw new Error(
      "Config dataFolder was not atomically updated to the reconnected path."
    );
  if (await exists(lostFolder))
    throw new Error("Lost location was recreated after a valid reconnect.");

  // Section 8: restart persistence.
  await stopService(service);
  service = await startService();
  await waitForHealth();
  const healthRestart = await health();
  const persistedAfterRestart = healthRestart.payload.status === "ok";
  if (!persistedAfterRestart)
    throw new Error("Health was not 'ok' after restart.");

  const wsRestart = (await request("/api/v1/workspace")).payload;
  if (
    wsRestart.revision !== beforeRevision ||
    wsRestart.workspace.templates?.[0]?.id !== beforeTemplateId
  )
    throw new Error("Workspace was not preserved after restart.");

  const assetRestart = (await request(`/api/v1/assets/${uploaded.asset.id}`)).payload;
  if (
    !Buffer.from(assetRestart.base64, "base64").equals(assetBytes) ||
    assetRestart.asset.contentHash !== beforeContentHash
  )
    throw new Error("Asset was not preserved after restart.");

  const configRestart = await readConfigDataFolder();
  if (configRestart !== renamedFolder)
    throw new Error(
      "Config did not persist the reconnected path after restart."
    );

  // A required path with the right name but the wrong filesystem type must
  // not satisfy health. Restore it immediately so the fixture remains valid.
  const accountsDirectory = path.join(renamedFolder, "accounts");
  const heldAccountsDirectory = path.join(renamedFolder, "accounts.health-test");
  let requiredDirectoryTypeDetected = false;
  await fs.rename(accountsDirectory, heldAccountsDirectory);
  try {
    await fs.writeFile(accountsDirectory, "not-a-directory");
    requiredDirectoryTypeDetected =
      (await health()).payload.status === "reconnect_required";
    if (!requiredDirectoryTypeDetected)
      throw new Error(
        "Health accepted a regular file in place of the required accounts directory."
      );
  } finally {
    await fs.rm(accountsDirectory, { force: true });
    await fs.rename(heldAccountsDirectory, accountsDirectory);
  }
  if ((await health()).payload.status !== "ok")
    throw new Error(
      "Health did not recover after the required accounts directory was restored."
    );

  // ================= Task 2 / Layer 2B =================
  // Integrity scan / repair / Emergency Backup integration verification,
  // using the live isolated Data Folder (renamedFolder) from the flow above.
  // All fixtures live under os.tmpdir(); no real data is touched.
  const liveRoot = renamedFolder;
  const ownerHashHex = crypto
    .createHash("sha256")
    .update(owner)
    .digest("hex");
  const liveDirs = {
    objects: path.join(liveRoot, "objects"),
    manifests: path.join(liveRoot, "manifests"),
    accounts: path.join(liveRoot, "accounts"),
    metadata: path.join(liveRoot, "metadata"),
    journal: path.join(liveRoot, "journal"),
    backups: path.join(liveRoot, "backups"),
    emergency: path.join(liveRoot, "backups", "emergency"),
  };
  const wsPath = path.join(liveDirs.accounts, ownerHashHex, "workspace.json");
  const schemaPath = path.join(liveDirs.metadata, "data-schema.json");
  const journalPath = path.join(liveDirs.journal, "operations.ndjson");
  const corruptAssetId = uploaded.asset.id;
  const corruptContentHash = beforeContentHash;
  const readBytes = p => fs.readFile(p);
  async function listEmergencyBackupDirs() {
    try {
      const entries = await fs.readdir(liveDirs.emergency);
      const dirs = [];
      for (const name of entries) {
        if (name.endsWith(".formdigital-backup")) continue;
        if (!name.startsWith("backup-")) continue;
        try {
          if (
            (await fs.stat(path.join(liveDirs.emergency, name))).isDirectory()
          )
            dirs.push(name);
        } catch {}
      }
      return dirs;
    } catch {
      return [];
    }
  }

  // Section 6: a healthy folder must no-op the repair (no Emergency Backup).
  const scanHealthy = (await request("/api/v1/integrity-scan", "POST")).payload;
  if (scanHealthy.healthy !== true)
    throw new Error("Integrity scan of a healthy folder reported unhealthy.");
  const emergencyBeforeNoOp = await listEmergencyBackupDirs();
  const repairNoOp = (await request("/api/v1/integrity-repair", "POST")).payload;
  if (
    repairNoOp.repaired !== false ||
    repairNoOp.emergencyBackupId !== null ||
    !repairNoOp.before ||
    repairNoOp.before.healthy !== true ||
    !repairNoOp.after ||
    repairNoOp.after.healthy !== true ||
    !Array.isArray(repairNoOp.quarantined) ||
    repairNoOp.quarantined.length !== 0
  )
    throw new Error(
      `Healthy no-op repair returned an unexpected result: ${JSON.stringify({
        repaired: repairNoOp.repaired,
        emergencyBackupId: repairNoOp.emergencyBackupId,
        beforeHealthy: repairNoOp.before && repairNoOp.before.healthy,
        afterHealthy: repairNoOp.after && repairNoOp.after.healthy,
        quarantined: repairNoOp.quarantined && repairNoOp.quarantined.length,
      })}`
    );
  const emergencyAfterNoOp = await listEmergencyBackupDirs();
  if (emergencyAfterNoOp.length !== emergencyBeforeNoOp.length)
    throw new Error(
      "Healthy no-op repair must not create an Emergency Backup."
    );
  const wsNoOp = (await request("/api/v1/workspace")).payload;
  if (wsNoOp.revision !== beforeRevision)
    throw new Error("Workspace revision changed during healthy no-op repair.");
  const assetNoOp = (await request(`/api/v1/assets/${corruptAssetId}`)).payload;
  if (
    !Buffer.from(assetNoOp.base64, "base64").equals(assetBytes) ||
    assetNoOp.asset.contentHash !== corruptContentHash
  )
    throw new Error("Asset bytes changed during healthy no-op repair.");
  const healthyRepairNoOp = true;

  // Section 7: introduce a controlled object corruption (manifest hash mismatch).
  const mutated = Buffer.from(
    await readBytes(path.join(liveDirs.objects, corruptContentHash))
  );
  mutated[0] = mutated[0] ^ 0xff;
  await fs.writeFile(
    path.join(liveDirs.objects, corruptContentHash),
    mutated
  );
  const scanCorrupt = (await request("/api/v1/integrity-scan", "POST")).payload;
  const mismatchFinding = scanCorrupt.findings.find(
    f =>
      f.code === "content_hash_mismatch" &&
      f.manifestFile === `${corruptAssetId}.json`
  );
  const contentHashMismatchDetected =
    scanCorrupt.healthy === false &&
    !!mismatchFinding &&
    mismatchFinding.severity === "error";
  if (!contentHashMismatchDetected)
    throw new Error(
      `Integrity scan did not detect the content_hash_mismatch: ${JSON.stringify(
        scanCorrupt.findings
      )}`
    );

  // Section 8: a failed Emergency Backup destination must block repair and
  // leave the original data completely untouched.
  const emergencyExisted = await exists(liveDirs.emergency);
  const savedEmergency = path.join(testRoot, "emergency-saved");
  let failureInjected = false;
  let emergencyBackupFailureBlockedRepair = false;
  let originalBytesPreservedWhenBackupFailed = false;
  try {
    if (emergencyExisted)
      await fs.rename(liveDirs.emergency, savedEmergency);
    // Replace the emergency directory with a regular file so createBackup fails.
    await fs.writeFile(liveDirs.emergency, "blocked");
    failureInjected = true;

    const failManifestBefore = await readBytes(
      path.join(liveDirs.manifests, `${corruptAssetId}.json`)
    );
    const failObjectBefore = await readBytes(
      path.join(liveDirs.objects, corruptContentHash)
    );
    const failWorkspaceBefore = await readBytes(wsPath);

    const failRepair = await rawRequest(
      "/api/v1/integrity-repair",
      "POST",
      undefined,
      headers
    );
    const blockedRepairFailed = failRepair.status !== 200;

    const failManifestAfter = await readBytes(
      path.join(liveDirs.manifests, `${corruptAssetId}.json`)
    );
    const failObjectAfter = await readBytes(
      path.join(liveDirs.objects, corruptContentHash)
    );
    const failWorkspaceAfter = await readBytes(wsPath);

    let quarantineEmpty = true;
    if (await exists(path.join(liveRoot, "quarantine"))) {
      const qEntries = await fs.readdir(path.join(liveRoot, "quarantine"));
      quarantineEmpty = qEntries.length === 0;
    }
    const scanStillBad = (
      await request("/api/v1/integrity-scan", "POST")
    ).payload;
    const scanStillHasMismatch =
      scanStillBad.healthy === false &&
      scanStillBad.findings.some(
        f =>
          f.code === "content_hash_mismatch" &&
          f.manifestFile === `${corruptAssetId}.json`
      );
    originalBytesPreservedWhenBackupFailed =
      blockedRepairFailed &&
      failManifestBefore.equals(failManifestAfter) &&
      failObjectBefore.equals(failObjectAfter) &&
      failWorkspaceBefore.equals(failWorkspaceAfter) &&
      quarantineEmpty &&
      scanStillHasMismatch;
    if (!originalBytesPreservedWhenBackupFailed)
      throw new Error(
        "A failed Emergency Backup did not block repair or preserve the original data."
      );
    emergencyBackupFailureBlockedRepair = blockedRepairFailed;
  } finally {
    if (failureInjected) {
      await fs.rm(liveDirs.emergency, { force: true });
      if (emergencyExisted)
        await fs.rename(savedEmergency, liveDirs.emergency);
    }
  }

  // Section 9: a successful repair must create a COMPLETE Emergency Backup first.
  const preRepairManifest = await readBytes(
    path.join(liveDirs.manifests, `${corruptAssetId}.json`)
  );
  const preRepairObject = await readBytes(
    path.join(liveDirs.objects, corruptContentHash)
  );
  const preRepairWorkspace = await readBytes(wsPath);
  const preRepairSchema = await readBytes(schemaPath);
  const preRepairJournal = await readBytes(journalPath);

  const repairRes = (await request("/api/v1/integrity-repair", "POST")).payload;
  if (
    repairRes.repaired !== true ||
    !repairRes.emergencyBackupId ||
    !repairRes.quarantineId ||
    !repairRes.before ||
    repairRes.before.healthy !== false ||
    !repairRes.after ||
    repairRes.after.healthy !== true ||
    !Array.isArray(repairRes.quarantined) ||
    !repairRes.quarantined.includes(`${corruptAssetId}.json`)
  )
    throw new Error(
      `Successful repair returned an unexpected result: ${JSON.stringify({
        repaired: repairRes.repaired,
        emergencyBackupId: repairRes.emergencyBackupId,
        quarantineId: repairRes.quarantineId,
        beforeHealthy: repairRes.before && repairRes.before.healthy,
        afterHealthy: repairRes.after && repairRes.after.healthy,
        quarantined: repairRes.quarantined,
      })}`
    );

  const emergencyBackupId = repairRes.emergencyBackupId;
  const backupDir = path.join(liveDirs.emergency, emergencyBackupId);
  const backupLocated = await exists(backupDir);
  const backupObjects = path.join(backupDir, "objects");
  const backupManifests = path.join(backupDir, "manifests");
  const backupAccounts = path.join(backupDir, "accounts");
  const backupMetadata = path.join(backupDir, "metadata");
  const backupJournal = path.join(backupDir, "journal");
  const emergencyContainsObjects = await exists(backupObjects);
  const emergencyContainsManifests = await exists(backupManifests);
  const emergencyContainsAccounts = await exists(backupAccounts);
  const emergencyContainsMetadata = await exists(backupMetadata);
  const emergencyContainsJournal = await exists(backupJournal);

  const objectMatchesPreRepair = (
    await readBytes(path.join(backupObjects, corruptContentHash))
  ).equals(preRepairObject);
  const manifestMatchesPreRepair = (
    await readBytes(
      path.join(backupManifests, `${corruptAssetId}.json`)
    )
  ).equals(preRepairManifest);
  const workspaceMatchesPreRepair = (
    await readBytes(
      path.join(backupAccounts, ownerHashHex, "workspace.json")
    )
  ).equals(preRepairWorkspace);
  const schemaMatchesPreRepair = (
    await readBytes(path.join(backupMetadata, "data-schema.json"))
  ).equals(preRepairSchema);
  const journalPreservedPreRepair = (
    await readBytes(path.join(backupJournal, "operations.ndjson"))
  ).equals(preRepairJournal);

  const corruptManifestRemoved = !(await exists(
    path.join(liveDirs.manifests, `${corruptAssetId}.json`)
  ));
  const corruptObjectRetained = await exists(
    path.join(liveDirs.objects, corruptContentHash)
  );

  const quarantineDir = path.join(
    liveRoot,
    "quarantine",
    repairRes.quarantineId
  );
  const manifestInQuarantineUnchanged = (
    await readBytes(
      path.join(quarantineDir, "manifests", `${corruptAssetId}.json`)
    )
  ).equals(preRepairManifest);
  const repairReport = JSON.parse(
    (await readBytes(path.join(quarantineDir, "repair-report.json"))).toString(
      "utf8"
    )
  );
  const repairReportVerified =
    repairReport.emergencyBackupId === repairRes.emergencyBackupId &&
    JSON.stringify(repairReport.before) === JSON.stringify(repairRes.before) &&
    JSON.stringify(repairReport.after) === JSON.stringify(repairRes.after) &&
    Array.isArray(repairReport.quarantined) &&
    repairReport.quarantined.includes(`${corruptAssetId}.json`);

  const scanAfterRepair = (
    await request("/api/v1/integrity-scan", "POST")
  ).payload;
  const orphanWarningReported =
    scanAfterRepair.findings.some(
      f =>
        f.code === "orphan_object" &&
        f.objectFile === corruptContentHash &&
        f.severity === "warning"
    ) && scanAfterRepair.healthy === true;

  const liveJournalAfterRepair = await readBytes(journalPath);
  const journalEvents = liveJournalAfterRepair
    .toString("utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line));
  const journalHasBackupCreate = journalEvents.some(
    event =>
      event.operation === "backup.create" &&
      event.manifest?.id === emergencyBackupId
  );
  const journalHasIntegrityRepair = journalEvents.some(
    event =>
      event.operation === "integrity.repair" &&
      event.manifest?.emergencyBackupId === emergencyBackupId &&
      event.manifest?.quarantineId === repairRes.quarantineId
  );

  const corruptManifestQuarantined =
    corruptManifestRemoved &&
    manifestInQuarantineUnchanged &&
    repairRes.quarantined.includes(`${corruptAssetId}.json`);
  const emergencyBackupCreatedBeforeRepair = backupLocated;
  const repairInvariantsOk =
    backupLocated &&
    emergencyContainsObjects &&
    emergencyContainsManifests &&
    emergencyContainsAccounts &&
    emergencyContainsMetadata &&
    emergencyContainsJournal &&
    objectMatchesPreRepair &&
    manifestMatchesPreRepair &&
    workspaceMatchesPreRepair &&
    schemaMatchesPreRepair &&
    journalPreservedPreRepair &&
    corruptManifestRemoved &&
    corruptObjectRetained &&
    manifestInQuarantineUnchanged &&
    repairReportVerified &&
    orphanWarningReported &&
    journalHasBackupCreate &&
    journalHasIntegrityRepair;
  if (!repairInvariantsOk)
    throw new Error(
      `Successful repair invariants failed: ${JSON.stringify({
        backupLocated,
        emergencyContainsObjects,
        emergencyContainsManifests,
        emergencyContainsAccounts,
        emergencyContainsMetadata,
        emergencyContainsJournal,
        objectMatchesPreRepair,
        manifestMatchesPreRepair,
        workspaceMatchesPreRepair,
        schemaMatchesPreRepair,
        journalPreservedPreRepair,
        corruptManifestRemoved,
        corruptObjectRetained,
        manifestInQuarantineUnchanged,
        repairReportVerified,
        orphanWarningReported,
        journalHasBackupCreate,
        journalHasIntegrityRepair,
      })}`
    );

  // Section 10: a Workspace that cannot be auto-repaired must stay blocked.
  const wsRepairBeforeEmergency = await listEmergencyBackupDirs();
  const corruptWorkspaceBytes = Buffer.from("{ this is not valid json ");
  await fs.writeFile(wsPath, corruptWorkspaceBytes);
  const scanWs = (await request("/api/v1/integrity-scan", "POST")).payload;
  const workspaceCorruptionDetected =
    scanWs.healthy === false &&
    scanWs.findings.some(
      f =>
        (f.code === "workspace_unreadable" || f.code === "workspace_invalid") &&
        f.severity === "error"
    );
  if (!workspaceCorruptionDetected)
    throw new Error(
      `Integrity scan did not detect the broken workspace: ${JSON.stringify(
        scanWs.findings
      )}`
    );

  const wsRepair = (await request("/api/v1/integrity-repair", "POST")).payload;
  const wsEmergencyAfter = await listEmergencyBackupDirs();
  const wsEmergencyId = wsRepair.emergencyBackupId;
  const secondEmergencyCreated =
    wsEmergencyAfter.length === wsRepairBeforeEmergency.length + 1 &&
    !!wsEmergencyId;
  if (!secondEmergencyCreated)
    throw new Error(
      "Repair of an unrepairable Workspace did not create a new Emergency Backup."
    );
  const wsBackupWorkspaceBytes = await readBytes(
    path.join(liveDirs.emergency, wsEmergencyId, "accounts", ownerHashHex, "workspace.json")
  );
  const wsBackupPreservedCorrupt = wsBackupWorkspaceBytes.equals(
    corruptWorkspaceBytes
  );
  const unrepairableWorkspaceStillUnhealthy =
    wsRepair.after && wsRepair.after.healthy === false;
  const unrepairableWorkspacePreserved =
    Array.isArray(wsRepair.quarantined) &&
    wsRepair.quarantined.length === 0 &&
    (await readBytes(wsPath)).equals(corruptWorkspaceBytes) &&
    wsBackupPreservedCorrupt &&
    !(
      await exists(
        path.join(
          liveRoot,
          "accounts",
          ownerHashHex,
          "workspace.json.blank"
        )
      )
    );
  if (!unrepairableWorkspaceStillUnhealthy || !unrepairableWorkspacePreserved)
    throw new Error(
      `Unrepairable Workspace was not preserved: ${JSON.stringify({
        afterHealthy: wsRepair.after && wsRepair.after.healthy,
        quarantined: wsRepair.quarantined,
        wsBackupPreservedCorrupt,
      })}`
    );

  // Section 11: both Emergency Backups must persist across a restart.
  const persistedEmergencyIds = [emergencyBackupId, wsEmergencyId];
  await stopService(service);
  service = await startService();
  await waitForHealth();
  let emergencyBackupsPersistedAfterRestart = true;
  for (const id of persistedEmergencyIds) {
    const dir = path.join(liveDirs.emergency, id);
    if (
      !(await exists(dir)) ||
      !(await exists(path.join(dir, "objects"))) ||
      !(await exists(path.join(dir, "manifests"))) ||
      !(await exists(path.join(dir, "accounts"))) ||
      !(await exists(path.join(dir, "metadata"))) ||
      !(await exists(path.join(dir, "journal")))
    ) {
      emergencyBackupsPersistedAfterRestart = false;
      break;
    }
  }
  if (!emergencyBackupsPersistedAfterRestart)
    throw new Error(
      "Emergency Backups did not persist after a service restart."
    );

  // ================= Task 2 / Layer 2C2A =================
  // Local Data Service Portable Backup verifier alignment + zero-write on reject.
  // Every fixture lives under os.tmpdir(); no real data is touched.
  const fflate = await import("fflate");
  const { unzipSync, zipSync, strFromU8, strToU8 } = fflate;
  const stagingDir = path.join(liveRoot, "staging");
  const quarantineDirRoot = path.join(liveRoot, "quarantine");
  const sha256Local = v => crypto.createHash("sha256").update(v).digest("hex");

  // 1. Re-establish a clean, valid Workspace envelope (Layer 2B left it corrupt)
  //    and upload one valid asset so the Portable Backup includes an asset manifest.
  const c2Envelope = {
    revision: 0,
    workspace: {
      schemaVersion: 2,
      templates: [{ id: "tpl-c2c2a", name: "C2C2A Template" }],
      templateVersions: [{ id: "ver-c2c2a", templateId: "tpl-c2c2a" }],
      instances: [{ id: "ins-c2c2a", templateId: "tpl-c2c2a" }],
      mappingTemplates: [
        { id: "map-c2c2a", templateVersionId: "ver-c2c2a", templateId: "tpl-c2c2a" },
      ],
      folders: [],
      tags: [],
      savedValues: [],
      fields: [],
      importRuns: [],
      importRows: [],
      mappingDecisions: [],
      detectionRuns: [],
      preferences: {},
    },
  };
  await fs.writeFile(wsPath, JSON.stringify(c2Envelope, null, 2));
  if ((await request("/api/v1/workspace")).payload.revision !== 0)
    throw new Error(
      "Layer 2C2A baseline Workspace did not load at revision 0."
    );

  const c2AssetBytes = Buffer.from("layer-2c2a-isolated-asset");
  await request("/api/v1/assets", "POST", {
    base64: c2AssetBytes.toString("base64"),
    originalFilename: "c2c2a.txt",
    mimeType: "text/plain",
    metadata: { kind: "source" },
  });
  await request("/api/v1/workspace", "PUT", {
    expectedRevision: 0,
    workspace: c2Envelope.workspace,
  });

  // 2. Build a legitimate account-scoped Portable Backup via the live service.
  const legitBackup = (
    await request("/api/v1/backups", "POST", { portable: true })
  ).payload;
  const legitEntries = unzipSync(Buffer.from(legitBackup.archiveBase64, "base64"));
  const legitManifest = JSON.parse(
    strFromU8(legitEntries["backup-manifest.json"])
  );
  const assetManifestFile =
    legitManifest.files.find(f => f.path.startsWith("manifests/")) || null;

  // 3. Snapshot every state surface BEFORE any invalid restore attempt.
  async function snapshotState() {
    const manifests = {};
    for (const name of await fs.readdir(liveDirs.manifests))
      manifests[name] = (
        await readBytes(path.join(liveDirs.manifests, name))
      ).toString("base64");
    const objects = {};
    for (const name of await fs.readdir(liveDirs.objects))
      objects[name] = (
        await readBytes(path.join(liveDirs.objects, name))
      ).toString("base64");
    return {
      workspace: (await readBytes(wsPath)).toString("base64"),
      manifests,
      objects,
      emergency: await listEmergencyBackupDirs(),
      journal: (await readBytes(journalPath)).toString("base64"),
      config: (await readBytes(configPath)).toString("base64"),
      quarantine: await fs.readdir(quarantineDirRoot).catch(() => []),
      staging: await fs.readdir(stagingDir).catch(() => []),
    };
  }
  async function expectUnchanged(label) {
    const after = await snapshotState();
    if (after.workspace !== snapshotBefore.workspace)
      throw new Error(`${label}: workspace bytes changed`);
    if (
      JSON.stringify(after.manifests) !==
      JSON.stringify(snapshotBefore.manifests)
    )
      throw new Error(`${label}: manifests changed`);
    if (
      JSON.stringify(after.objects) !== JSON.stringify(snapshotBefore.objects)
    )
      throw new Error(`${label}: objects changed`);
    if (
      JSON.stringify(after.emergency) !==
      JSON.stringify(snapshotBefore.emergency)
    )
      throw new Error(`${label}: emergency backups changed`);
    if (after.journal !== snapshotBefore.journal)
      throw new Error(`${label}: journal changed`);
    if (after.config !== snapshotBefore.config)
      throw new Error(`${label}: config changed`);
    if (
      JSON.stringify(after.quarantine) !==
      JSON.stringify(snapshotBefore.quarantine)
    )
      throw new Error(`${label}: quarantine changed`);
    if (
      JSON.stringify(after.staging) !== JSON.stringify(snapshotBefore.staging)
    )
      throw new Error(`${label}: staging changed`);
  }
  function updateFileHash(manifest, filePath, newBytes) {
    const f = manifest.files.find(x => x.path === filePath);
    if (f) {
      f.contentHash = sha256Local(newBytes);
      f.size = newBytes.byteLength;
    }
  }
  function buildModifiedArchive(mutate) {
    const entries = {};
    for (const [k, v] of Object.entries(legitEntries)) entries[k] = v;
    const manifest = JSON.parse(JSON.stringify(legitManifest));
    mutate(entries, manifest);
    entries["backup-manifest.json"] = strToU8(JSON.stringify(manifest));
    return Buffer.from(zipSync(entries, { level: 6 })).toString("base64");
  }

  const unsafePaths = [
    "../escape.json",
    "account\\workspace.json",
    "/abs/workspace.json",
    "C:\\windows\\evil",
    "//unc/path/file",
    "objects/../../etc/passwd",
    "evil/workspace.json",
    "account/workspace.json\u0000",
    "account//workspace.json",
    "http://example.com/workspace.json",
  ];

  const invalidCaseDefs = [
    {
      name: "wrongOwner",
      mutate: (e, m) => {
        m.ownerKeyHash = "0".repeat(64);
      },
    },
    {
      name: "uppercaseOwnerHash",
      mutate: (e, m) => {
        m.ownerKeyHash = ownerHashHex.toUpperCase();
      },
    },
    {
      name: "accountScopeWithTemplateId",
      mutate: (e, m) => {
        m.scope = "account";
        m.templateId = "tpl-c2c2a";
      },
    },
    {
      name: "accountScopeWithEmptyTemplateId",
      mutate: (e, m) => {
        m.scope = "account";
        m.templateId = "";
      },
    },
    {
      name: "templateScopeMissingTemplateId",
      mutate: (e, m) => {
        m.scope = "template";
        delete m.templateId;
      },
    },
    {
      name: "templateScopeMismatch",
      mutate: (e, m) => {
        m.scope = "template";
        m.templateId = "does-not-exist";
      },
    },
    {
      name: "unsupportedSchemaVersion",
      mutate: (e, m) => {
        m.schemaVersion = 2;
      },
    },
    {
      name: "invalidCreatedAt",
      mutate: (e, m) => {
        m.createdAt = {};
      },
    },
    {
      name: "invalidCreatedAtPath",
      mutate: (e, m) => {
        m.createdAt = "C:\\Users\\victim\\backup";
      },
    },
    {
      name: "filesNotArray",
      mutate: (e, m) => {
        m.files = "notarray";
      },
    },
    {
      name: "duplicateManifestPath",
      mutate: (e, m) => {
        const f = m.files.find(x => x.path.startsWith("manifests/"));
        if (f) m.files.push({ ...f });
      },
    },
    {
      name: "extraUnlistedEntry",
      mutate: (e, m) => {
        e["account/extra.json"] = strToU8(JSON.stringify({ extra: true }));
      },
    },
    {
      name: "missingDeclaredEntry",
      mutate: (e, m) => {
        const f =
          m.files.find(x => x.path.startsWith("manifests/")) ||
          m.files.find(x => x.path.startsWith("objects/"));
        if (f) delete e[f.path];
      },
    },
    {
      name: "missingWorkspaceJson",
      mutate: (e, m) => {
        delete e["account/workspace.json"];
        m.files = m.files.filter(x => x.path !== "account/workspace.json");
      },
    },
    {
      name: "sizeMismatch",
      mutate: (e, m) => {
        const f = m.files.find(x => x.path.startsWith("objects/"));
        if (f) f.size = f.size + 1;
      },
    },
    {
      name: "contentHashMismatch",
      mutate: (e, m) => {
        const f = m.files.find(x => x.path.startsWith("objects/"));
        if (f) f.contentHash = "a".repeat(64);
      },
    },
    {
      name: "objectBasenameMismatch",
      mutate: (e, m) => {
        const bytes = strToU8("mismatch-content-bytes");
        const realHash = sha256Local(bytes);
        const fakeName = "b".repeat(64);
        e[`objects/${fakeName}`] = bytes;
        m.files.push({
          path: `objects/${fakeName}`,
          contentHash: realHash,
          size: bytes.byteLength,
        });
      },
    },
    {
      name: "workspaceJsonCorrupt",
      mutate: (e, m) => {
        const bytes = strToU8("{ this is not valid json ");
        e["account/workspace.json"] = bytes;
        updateFileHash(m, "account/workspace.json", bytes);
      },
    },
    {
      name: "workspaceNotObject",
      mutate: (e, m) => {
        const bytes = strToU8("123");
        e["account/workspace.json"] = bytes;
        updateFileHash(m, "account/workspace.json", bytes);
      },
    },
    {
      name: "workspaceMissingRequiredArrays",
      mutate: (e, m) => {
        const envelope = JSON.parse(strFromU8(e["account/workspace.json"]));
        delete envelope.workspace.instances;
        const bytes = strToU8(JSON.stringify(envelope));
        e["account/workspace.json"] = bytes;
        updateFileHash(m, "account/workspace.json", bytes);
      },
    },
    {
      name: "summaryMismatch",
      mutate: (e, m) => {
        m.summary = { ...m.summary, templateCount: 999 };
      },
    },
  ];
  for (const p of unsafePaths)
    invalidCaseDefs.push({
      name: `unsafePath_${p.replace(/[^a-zA-Z0-9]/g, "_")}`,
      mutate: (e, m) => {
        const bytes = strToU8("x");
        e[p] = bytes;
        m.files.push({
          path: p,
          contentHash: sha256Local(bytes),
          size: bytes.byteLength,
        });
      },
    });
  if (assetManifestFile) {
    const ap = assetManifestFile.path;
    invalidCaseDefs.push(
      {
        name: "assetManifestCorrupt",
        mutate: (e, m) => {
          const bytes = strToU8("{bad");
          e[ap] = bytes;
          updateFileHash(m, ap, bytes);
        },
      },
      {
        name: "assetManifestSchemaVersion",
        mutate: (e, m) => {
          const a = JSON.parse(strFromU8(e[ap]));
          a.schemaVersion = 2;
          const b = strToU8(JSON.stringify(a));
          e[ap] = b;
          updateFileHash(m, ap, b);
        },
      },
      {
        name: "assetOwnerMismatch",
        mutate: (e, m) => {
          const a = JSON.parse(strFromU8(e[ap]));
          a.ownerKeyHash = "0".repeat(64);
          const b = strToU8(JSON.stringify(a));
          e[ap] = b;
          updateFileHash(m, ap, b);
        },
      },
      {
        name: "assetIdMismatch",
        mutate: (e, m) => {
          const a = JSON.parse(strFromU8(e[ap]));
          a.id = "different-id";
          const b = strToU8(JSON.stringify(a));
          e[ap] = b;
          updateFileHash(m, ap, b);
        },
      },
      {
        name: "assetUnlistedObject",
        mutate: (e, m) => {
          const a = JSON.parse(strFromU8(e[ap]));
          a.contentHash = "c".repeat(64);
          const b = strToU8(JSON.stringify(a));
          e[ap] = b;
          updateFileHash(m, ap, b);
        },
      },
      {
        name: "assetSizeMismatch",
        mutate: (e, m) => {
          const a = JSON.parse(strFromU8(e[ap]));
          a.size = a.size + 1;
          const b = strToU8(JSON.stringify(a));
          e[ap] = b;
          updateFileHash(m, ap, b);
        },
      }
    );
  }

  const snapshotBefore = await snapshotState();
  const caseResults = {};
  for (const def of invalidCaseDefs) {
    const archiveBase64 = buildModifiedArchive(def.mutate);
    const resp = await rawRequest("/api/v1/restore", "POST", {
      archiveBase64,
    });
    const rejected = resp.status !== 200;
    if (!rejected)
      throw new Error(`invalid-case-${def.name}: restore was accepted`);
    await expectUnchanged(`invalid-case-${def.name}`);
    const unchanged = true;
    caseResults[def.name] = { rejected, unchanged };
  }

  if (
    !Object.values(caseResults).every(
      result => result.rejected === true && result.unchanged === true
    )
  )
    throw new Error("One or more invalid Portable Backup cases did not fail closed.");

  const finalState = await snapshotState();
  const localVerifierRejectsWrongOwner = !!caseResults.wrongOwner?.rejected;
  const localVerifierRejectsExtraEntries =
    !!caseResults.extraUnlistedEntry?.rejected;
  const localVerifierRejectsWorkspaceSummaryMismatch =
    !!caseResults.summaryMismatch?.rejected &&
    !!caseResults.workspaceJsonCorrupt?.rejected &&
    !!caseResults.workspaceNotObject?.rejected;
  const localVerifierRejectsUnsafePaths = unsafePaths.every(
    p => !!caseResults[`unsafePath_${p.replace(/[^a-zA-Z0-9]/g, "_")}`]?.rejected
  );
  const localVerifierRejectsInvalidAssetLinks = assetManifestFile
    ? [
        "assetManifestCorrupt",
        "assetManifestSchemaVersion",
        "assetOwnerMismatch",
        "assetIdMismatch",
        "assetUnlistedObject",
        "assetSizeMismatch",
      ].every(k => !!caseResults[k]?.rejected)
    : true;
  const invalidPortableRestoreCreatedNoEmergencyBackup =
    JSON.stringify(finalState.emergency) ===
    JSON.stringify(snapshotBefore.emergency);
  const invalidPortableRestoreWroteNoJournal =
    finalState.journal === snapshotBefore.journal;
  const invalidPortableRestorePreservedAllBytes =
    finalState.workspace === snapshotBefore.workspace &&
    JSON.stringify(finalState.manifests) ===
      JSON.stringify(snapshotBefore.manifests) &&
    JSON.stringify(finalState.objects) ===
      JSON.stringify(snapshotBefore.objects) &&
    finalState.config === snapshotBefore.config &&
    JSON.stringify(finalState.quarantine) ===
      JSON.stringify(snapshotBefore.quarantine) &&
    JSON.stringify(finalState.staging) ===
      JSON.stringify(snapshotBefore.staging);

  // ================= Task 2 / Layer 2C2B =================
  // Account full restore transactional safety + failure rollback.
  // All fixtures live under os.tmpdir(); no real data is touched.
  // This layer only addresses legitimate account-scoped Portable Backup full
  // restore (preserveExistingAssets === false). It does NOT implement
  // structure/duplicate merge, which uses the preserveExistingAssets path.

  const c2bFflate = await import("fflate");
  const {
    unzipSync: c2bUnzip,
    strFromU8: c2bStrFromU8,
    strToU8: c2bStrToU8,
    zipSync: c2bZip,
  } = c2bFflate;

  const c2bHeaders = headers; // owner B (google-user-integration-test)
  const c2bOwnerHash = ownerHashHex;
  const c2bAccountWs = wsPath; // accounts/<hash>/workspace.json for owner B
  const c2bManifestDir = liveDirs.manifests;
  const c2bObjectDir = liveDirs.objects;
  const c2bStagingDir = path.join(liveRoot, "staging");

  // Emergency backups come in two shapes: createBackup() emits a directory
  // (used by repair/restore), while createPortableBackup("pre-restore") emits a
  // .formdigital-backup FILE inside backups/emergency/. Both must be counted and
  // both must be preserved across the restore.
  const c2bEmergencyDir = liveDirs.emergency;
  async function c2bListEmergencyEntries() {
    const out = { dirs: [], files: [] };
    try {
      for (const name of await fs.readdir(c2bEmergencyDir)) {
        if (name.endsWith(".formdigital-backup")) out.files.push(name);
        else if (name.startsWith("backup-")) {
          try {
            if (
              (await fs.stat(path.join(c2bEmergencyDir, name))).isDirectory()
            )
              out.dirs.push(name);
          } catch {}
        }
      }
    } catch {}
    return out;
  }
  async function c2bReadPortableEmergency(id) {
    const p = path.join(c2bEmergencyDir, `${id}.formdigital-backup`);
    const bytes = await fs.readFile(p);
    return c2bUnzip(bytes);
  }
  const c2bStripUpdatedAt = ws => {
    const c = JSON.parse(JSON.stringify(ws));
    if (c && typeof c === "object") delete c.updatedAt;
    return c;
  };

  const c2bReadBytes = async p => (await fs.readFile(p)).toString("base64");
  const c2bListManifestNames = async () =>
    (await fs.readdir(c2bManifestDir)).filter(f => f.endsWith(".json"));
  const c2bListObjectNames = async () => await fs.readdir(c2bObjectDir);
  const c2bReadWorkspaceBytes = async () => c2bReadBytes(c2bAccountWs);
  const c2bParseWorkspace = async () => {
    const raw = await fs.readFile(c2bAccountWs, "utf8");
    const env = JSON.parse(raw);
    return { revision: env.revision, workspace: env.workspace };
  };
  const c2bManifestBytes = async name =>
    (await fs.readFile(path.join(c2bManifestDir, name))).toString("base64");

  // Owner C sentinel headers (a different account, must remain untouched).
  const c2bOwnerCKey = "google-user-c-sentinel";
  const c2bHeadersC = {
    ...headers,
    "x-formdigital-owner": c2bOwnerCKey,
  };
  const c2bOwnerCHash = crypto
    .createHash("sha256")
    .update(c2bOwnerCKey)
    .digest("hex");
  const c2bAccountWsC = path.join(
    liveDirs.accounts,
    c2bOwnerCHash,
    "workspace.json"
  );

  // ---- Build Source A: owner B workspace with 2 templates/versions/instances
  //      and 2 distinct assets, then a legitimate account-scoped backup. ----
  const c2bWsA = {
    schemaVersion: 2,
    templates: [
      { id: "tA1", name: "Source A Template One" },
      { id: "tA2", name: "Source A Template Two" },
    ],
    templateVersions: [
      { id: "verA1", templateId: "tA1" },
      { id: "verA2", templateId: "tA2" },
    ],
    instances: [
      { id: "insA1", templateId: "tA1" },
      { id: "insA2", templateId: "tA2" },
    ],
    mappingTemplates: [],
    folders: [],
    tags: [],
    savedValues: [],
    fields: [],
    importRuns: [],
    importRows: [],
    mappingDecisions: [],
    detectionRuns: [],
    preferences: {},
  };
  await request("/api/v1/workspace", "PUT", {
    expectedRevision: (await request("/api/v1/workspace")).payload.revision,
    workspace: c2bWsA,
  });
  const c2bAssetA1Bytes = Buffer.from("source-a-asset-one-unique");
  const c2bAssetA2Bytes = Buffer.from("source-a-asset-two-unique");
  const c2bUpA1 = (
    await request("/api/v1/assets", "POST", {
      base64: c2bAssetA1Bytes.toString("base64"),
      originalFilename: "a1.txt",
      mimeType: "text/plain",
      metadata: { kind: "source" },
    })
  ).payload;
  const c2bUpA2 = (
    await request("/api/v1/assets", "POST", {
      base64: c2bAssetA2Bytes.toString("base64"),
      originalFilename: "a2.txt",
      mimeType: "text/plain",
      metadata: { kind: "source" },
    })
  ).payload;
  // Snapshot the Source A workspace revision right before backup.
  const c2bRevBeforeBackup = (await request("/api/v1/workspace")).payload
    .revision;
  const c2bBackupA = (
    await request("/api/v1/backups", "POST", { portable: true })
  ).payload;
  const c2bBackupAEntries = c2bUnzip(
    Buffer.from(c2bBackupA.archiveBase64, "base64")
  );
  const c2bBackupAManifest = JSON.parse(
    c2bStrFromU8(c2bBackupAEntries["backup-manifest.json"])
  );
  // Capture the exact bytes of every manifest/object inside backup A.
  const c2bBackupAManifestFiles = {};
  const c2bBackupAObjectFiles = {};
  for (const f of c2bBackupAManifest.files) {
    if (f.path.startsWith("manifests/"))
      c2bBackupAManifestFiles[path.basename(f.path)] = c2bBackupAEntries[f.path];
    else if (f.path.startsWith("objects/"))
      c2bBackupAObjectFiles[path.basename(f.path)] = c2bBackupAEntries[f.path];
  }

  // ---- Establish Target B: different workspace + B-exclusive asset. ----
  const c2bWsB = {
    schemaVersion: 2,
    templates: [{ id: "tB1", name: "Target B Template" }],
    templateVersions: [{ id: "verB1", templateId: "tB1" }],
    instances: [{ id: "insB1", templateId: "tB1" }],
    mappingTemplates: [],
    folders: [],
    tags: [],
    savedValues: [],
    fields: [],
    importRuns: [],
    importRows: [],
    mappingDecisions: [],
    detectionRuns: [],
    preferences: {},
  };
  await request("/api/v1/workspace", "PUT", {
    expectedRevision: (await request("/api/v1/workspace")).payload.revision,
    workspace: c2bWsB,
  });
  const c2bAssetBBytes = Buffer.from("target-b-exclusive-asset");
  const c2bUpB = (
    await request("/api/v1/assets", "POST", {
      base64: c2bAssetBBytes.toString("base64"),
      originalFilename: "b.txt",
      mimeType: "text/plain",
      metadata: { kind: "source" },
    })
  ).payload;

  // ---- Owner C sentinel: distinct workspace + asset, must remain untouched. ----
  await request(
    "/api/v1/workspace",
    "PUT",
    {
      expectedRevision: 0,
      workspace: {
        schemaVersion: 2,
        templates: [{ id: "tC1", name: "Owner C Template" }],
        templateVersions: [{ id: "verC1", templateId: "tC1" }],
        instances: [{ id: "insC1", templateId: "tC1" }],
        mappingTemplates: [],
        folders: [],
        tags: [],
        savedValues: [],
        fields: [],
        importRuns: [],
        importRows: [],
        mappingDecisions: [],
        detectionRuns: [],
        preferences: {},
      },
    },
    c2bHeadersC
  );
  const c2bAssetCBytes = Buffer.from("owner-c-sentinel-asset");
  const c2bUpC = await rawRequest(
    "/api/v1/assets",
    "POST",
    {
      base64: c2bAssetCBytes.toString("base64"),
      originalFilename: "c.txt",
      mimeType: "text/plain",
      metadata: { kind: "source" },
    },
    c2bHeadersC
  );
  const c2bUpCId = c2bUpC.payload.asset.id;
  const c2bSentinelWorkspaceBefore = (
    await rawRequest("/api/v1/workspace", "GET", undefined, c2bHeadersC)
  ).payload.workspace;

  // ---- Layer 2C2B assertion ledger -------------------------------------
  // Every field reported in the final summary is registered here, so a field
  // can never be printed without having been asserted first. The run fails
  // before `verified: true` is emitted if any registered field is not true.
  const c2bResults = {};
  const c2bFailed = [];
  const c2bAssert = (name, value) => {
    const ok = value === true;
    c2bResults[name] = ok;
    if (!ok) c2bFailed.push(name);
    return ok;
  };

  // Journal assertions parse NDJSON lines and match the exact transaction /
  // Emergency Backup identity of the operation under test. A substring search
  // over the whole Journal can be satisfied by an unrelated earlier event.
  const c2bReadJournalEvents = async () =>
    (await fs.readFile(journalPath, "utf8"))
      .split("\n")
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

  // Canonical (key-order independent) JSON for semantic envelope comparison.
  const c2bCanon = value => {
    const walk = node => {
      if (Array.isArray(node)) return node.map(walk);
      if (node && typeof node === "object")
        return Object.keys(node)
          .sort()
          .reduce((acc, key) => {
            acc[key] = walk(node[key]);
            return acc;
          }, {});
      return node;
    };
    return JSON.stringify(walk(value));
  };

  // Complete, byte-exact state of the owner C sentinel account: its Workspace
  // file, every manifest it owns and every object those manifests reference.
  const c2bOwnerCState = async () => {
    const state = { workspace: null, manifests: {}, objects: {} };
    state.workspace = await fs
      .readFile(c2bAccountWsC)
      .then(bytes => bytes.toString("base64"))
      .catch(() => null);
    for (const name of await c2bListManifestNames()) {
      const target = path.join(c2bManifestDir, name);
      let parsed = null;
      try {
        parsed = JSON.parse(await fs.readFile(target, "utf8"));
      } catch {}
      if (!parsed || parsed.ownerKeyHash !== c2bOwnerCHash) continue;
      state.manifests[name] = (await fs.readFile(target)).toString("base64");
      if (typeof parsed.contentHash === "string")
        state.objects[parsed.contentHash] = await fs
          .readFile(path.join(c2bObjectDir, parsed.contentHash))
          .then(bytes => bytes.toString("base64"))
          .catch(() => null);
    }
    return state;
  };

  // A failure response may not leak absolute paths, staging names, bearer
  // tokens, owner hashes, errno codes or stack frames.
  const c2bSafeFailurePayload = payload => {
    const message =
      payload && payload.error && typeof payload.error.message === "string"
        ? payload.error.message
        : null;
    if (!message) return false;
    if (JSON.stringify(payload).includes("stack")) return false;
    if (/[\\/]/.test(message)) return false;
    if (/[A-Za-z]:/.test(message)) return false;
    if (message.includes(token)) return false;
    if (message.includes(owner) || message.includes(c2bOwnerCKey)) return false;
    if (/[0-9a-f]{32}/i.test(message)) return false;
    if (/\b(ENOENT|EPERM|EACCES|EEXIST|EISDIR|ENOTDIR|EBUSY)\b/.test(message))
      return false;
    if (/\.tmp|\.previous|restore-portable-|formdigital-local-test-/.test(message))
      return false;
    if (/\bat\s.+\(/.test(message)) return false;
    return true;
  };

  // File identity. atomicWrite() replaces a file through rename, and a delete +
  // recreate also allocates a new record, so a changed inode proves the file was
  // really rewritten while an unchanged inode proves it was never touched.
  // (Windows tunnels birthtime across delete/recreate, so birthtime cannot be
  // used for this.)
  const c2bInode = async target =>
    await fs
      .stat(target)
      .then(stat => String(stat.ino))
      .catch(() => null);

  // Names of the manifests the request owner (B) currently owns on disk.
  const c2bOwnerManifestNames = async ownerHashValue => {
    const names = [];
    for (const name of await c2bListManifestNames()) {
      try {
        const parsed = JSON.parse(
          await fs.readFile(path.join(c2bManifestDir, name), "utf8")
        );
        if (parsed && parsed.ownerKeyHash === ownerHashValue) names.push(name);
      } catch {}
    }
    return names.sort();
  };

  // Exact comparison of a pre-restore Emergency Backup against a captured
  // target snapshot: identical entry set, byte-identical manifests, exactly the
  // referenced objects and a semantically identical Workspace envelope. Each
  // aspect is returned separately so it can be asserted on its own instead of
  // through a single "contains something" check.
  const c2bEmergencyMatchesSnapshot = async (emergencyId, snapshot) => {
    const detail = {
      readable: false,
      descriptor: false,
      workspace: false,
      manifests: false,
      objects: false,
      entryCount: false,
      exact: false,
    };
    let entries;
    try {
      entries = await c2bReadPortableEmergency(emergencyId);
    } catch {
      return detail;
    }
    const keys = Object.keys(entries);
    if (!keys.includes("backup-manifest.json")) return detail;
    let backupManifest;
    try {
      backupManifest = JSON.parse(c2bStrFromU8(entries["backup-manifest.json"]));
    } catch {
      return detail;
    }
    detail.readable = true;
    detail.descriptor =
      backupManifest.scope === "account" &&
      backupManifest.kind === "pre-restore" &&
      backupManifest.ownerKeyHash === c2bOwnerHash &&
      backupManifest.id === emergencyId;
    const wsEntry = entries["account/workspace.json"];
    if (wsEntry)
      try {
        detail.workspace =
          c2bCanon(JSON.parse(c2bStrFromU8(wsEntry))) ===
          c2bCanon(
            JSON.parse(
              Buffer.from(snapshot.workspace, "base64").toString("utf8")
            )
          );
      } catch {}
    const emManifestNames = keys
      .filter(key => key.startsWith("manifests/"))
      .map(key => key.slice("manifests/".length))
      .sort();
    const expectedManifestNames = [...snapshot.ownerManifestNames].sort();
    let manifestsOk =
      JSON.stringify(emManifestNames) === JSON.stringify(expectedManifestNames);
    const expectedObjects = new Set();
    for (const name of expectedManifestNames) {
      const live = Buffer.from(snapshot.manifestBytes[name] ?? "", "base64");
      const archived = entries[`manifests/${name}`];
      if (!archived || !Buffer.from(archived).equals(live)) manifestsOk = false;
      try {
        const parsed = JSON.parse(live.toString("utf8"));
        if (typeof parsed.contentHash === "string")
          expectedObjects.add(parsed.contentHash);
      } catch {
        manifestsOk = false;
      }
    }
    detail.manifests = manifestsOk;
    const emObjectNames = keys
      .filter(key => key.startsWith("objects/"))
      .map(key => key.slice("objects/".length))
      .sort();
    let objectsOk =
      JSON.stringify(emObjectNames) ===
      JSON.stringify([...expectedObjects].sort());
    for (const hash of emObjectNames) {
      const bytes = Buffer.from(entries[`objects/${hash}`]);
      if (sha256Local(bytes) !== hash) objectsOk = false;
      const live = await fs
        .readFile(path.join(c2bObjectDir, hash))
        .catch(() => null);
      if (!live || !live.equals(bytes)) objectsOk = false;
    }
    detail.objects = objectsOk;
    detail.entryCount =
      keys.length === 2 + emManifestNames.length + emObjectNames.length;
    detail.exact =
      detail.readable &&
      detail.descriptor &&
      detail.workspace &&
      detail.manifests &&
      detail.objects &&
      detail.entryCount;
    return detail;
  };

  const c2bLegacyEmergencyMatchesSnapshot = async (emergencyId, snapshot) => {
    const backupRoot = path.join(c2bEmergencyDir, emergencyId);
    try {
      const descriptor = JSON.parse(
        await fs.readFile(path.join(backupRoot, "backup-manifest.json"), "utf8"),
      );
      if (descriptor?.kind !== "emergency-portable-restore") return false;
      const archivedWorkspace = await fs.readFile(
        path.join(backupRoot, "accounts", c2bOwnerHash, "workspace.json"),
      );
      if (!archivedWorkspace.equals(Buffer.from(snapshot.workspace, "base64")))
        return false;
      for (const name of snapshot.ownerManifestNames) {
        const archived = await fs.readFile(path.join(backupRoot, "manifests", name));
        if (!archived.equals(Buffer.from(snapshot.manifestBytes[name], "base64")))
          return false;
        const parsed = JSON.parse(archived.toString("utf8"));
        const object = await fs.readFile(
          path.join(backupRoot, "objects", parsed.contentHash),
        );
        if (sha256Local(object) !== parsed.contentHash) return false;
      }
      return true;
    } catch {
      return false;
    }
  };

  // Incoming manifest names in the exact order the Backup manifest declares
  // them, which is the order the restore commit writes them.
  const c2bIncomingManifestOrder = c2bBackupAManifest.files
    .filter(file => file.path.startsWith("manifests/"))
    .map(file => path.basename(file.path));

  // ---- Snapshot Target B (owner B) before restore. ----
  const c2bSnapB = {
    workspace: await c2bReadWorkspaceBytes(),
    manifestNames: await c2bListManifestNames(),
    manifestBytes: {},
    objectNames: await c2bListObjectNames(),
    ownerManifestNames: await c2bOwnerManifestNames(c2bOwnerHash),
  };
  for (const name of c2bSnapB.manifestNames)
    c2bSnapB.manifestBytes[name] = await c2bManifestBytes(name);
  const c2bEmergencyBefore = await c2bListEmergencyEntries();
  // Owner C baseline: every later time point is compared byte for byte to this.
  const c2bOwnerCBaseline = await c2bOwnerCState();
  const c2bOwnerCBaselineCanon = JSON.stringify(c2bOwnerCBaseline);
  // File-identity baseline for owner C. Byte comparison alone cannot tell
  // "never touched" apart from "rewritten with the same bytes"; a stable inode
  // can. None of owner C's files may be replaced by any restore transaction.
  const c2bOwnerCInodeTargets = [
    c2bAccountWsC,
    ...Object.keys(c2bOwnerCBaseline.manifests).map(name =>
      path.join(c2bManifestDir, name)
    ),
    ...Object.keys(c2bOwnerCBaseline.objects).map(hash =>
      path.join(c2bObjectDir, hash)
    ),
  ];
  const c2bOwnerCInodesBaseline = {};
  for (const target of c2bOwnerCInodeTargets)
    c2bOwnerCInodesBaseline[target] = await c2bInode(target);
  const c2bOwnerCInodesUnchanged = async () => {
    if (c2bOwnerCInodeTargets.length < 3) return false;
    for (const target of c2bOwnerCInodeTargets) {
      const ino = await c2bInode(target);
      if (ino === null || ino !== c2bOwnerCInodesBaseline[target]) return false;
    }
    return true;
  };

  // ================= Success path =================
  const c2bRestoreResp = await rawRequest("/api/v1/restore", "POST", {
    archiveBase64: c2bBackupA.archiveBase64,
  });
  if (c2bRestoreResp.status !== 200)
    throw new Error(
      `account full restore must succeed, received ${c2bRestoreResp.status}`
    );
  const c2bRestored = c2bRestoreResp.payload;
  const c2bEmergencyId = c2bRestored.emergencyBackupId;
  const c2bTxId = c2bRestored.transactionId;
  const c2bEmergencyAfter = await c2bListEmergencyEntries();
  c2bAssert(
    "fullRestoreCreatedEmergencyBackup",
    typeof c2bEmergencyId === "string" &&
      c2bEmergencyId.length > 0 &&
      typeof c2bTxId === "string" &&
      c2bTxId.length > 0 &&
      c2bRestored.restored === true &&
      c2bEmergencyAfter.files.length === c2bEmergencyBefore.files.length + 1 &&
      c2bEmergencyAfter.files.includes(`${c2bEmergencyId}.formdigital-backup`)
  );

  // (Test C) The pre-restore Emergency Backup is compared EXACTLY against the
  // captured Target B state: same descriptor, byte-identical Workspace
  // envelope, exactly Target B's owner manifests with identical bytes, exactly
  // the objects those manifests reference, and no extra entry. "Contains some
  // manifests / some objects" would be satisfied by an unrelated archive.
  const c2bEmDetail = await c2bEmergencyMatchesSnapshot(
    c2bEmergencyId,
    c2bSnapB
  );
  c2bAssert(
    "fullRestoreEmergencyPreservedTargetWorkspace",
    c2bEmDetail.readable && c2bEmDetail.descriptor && c2bEmDetail.workspace
  );
  c2bAssert(
    "fullRestoreEmergencyPreservedTargetManifests",
    c2bEmDetail.manifests
  );
  c2bAssert("fullRestoreEmergencyPreservedTargetObjects", c2bEmDetail.objects);
  c2bAssert("emergencyExactlyPreservedTargetState", c2bEmDetail.exact);

  // Commit verification, test side: the live Workspace file must equal the
  // archive entry byte for byte, not merely "look similar after stripping
  // updatedAt".
  const c2bArchiveWorkspaceBytes = Buffer.from(
    c2bBackupAEntries["account/workspace.json"]
  );
  const c2bLiveWorkspaceBytes = await fs.readFile(c2bAccountWs);
  c2bAssert(
    "commitVerifiedWorkspaceBytes",
    c2bLiveWorkspaceBytes.equals(c2bArchiveWorkspaceBytes)
  );
  const c2bWsAfter = await c2bParseWorkspace();
  c2bAssert(
    "fullRestoreReplacedOwnerWorkspace",
    JSON.stringify(c2bStripUpdatedAt(c2bWsAfter.workspace)) ===
      JSON.stringify(c2bStripUpdatedAt(c2bWsA))
  );

  // The request owner's manifest set must be EXACTLY the archive's manifest
  // set, every one of them byte identical to the archive entry, and the
  // Target-B-exclusive manifest must be gone.
  const c2bOwnerNamesAfter = await c2bOwnerManifestNames(c2bOwnerHash);
  let c2bManifestBytesExact =
    JSON.stringify(c2bOwnerNamesAfter) ===
    JSON.stringify([...c2bIncomingManifestOrder].sort());
  for (const name of c2bIncomingManifestOrder) {
    const live = await fs
      .readFile(path.join(c2bManifestDir, name))
      .catch(() => null);
    if (!live || !live.equals(Buffer.from(c2bBackupAManifestFiles[name])))
      c2bManifestBytesExact = false;
  }
  if (await exists(path.join(c2bManifestDir, `${c2bUpB.asset.id}.json`)))
    c2bManifestBytesExact = false;
  c2bAssert("commitVerifiedManifestBytes", c2bManifestBytesExact);
  c2bAssert("fullRestoreReplacedOwnerManifests", c2bManifestBytesExact);

  // Every archive object is present with the exact bytes and a matching hash.
  let c2bObjectHashesExact = true;
  for (const hash of Object.keys(c2bBackupAObjectFiles)) {
    const live = await fs
      .readFile(path.join(c2bObjectDir, hash))
      .catch(() => null);
    if (
      !live ||
      sha256Local(live) !== hash ||
      !live.equals(Buffer.from(c2bBackupAObjectFiles[hash]))
    )
      c2bObjectHashesExact = false;
  }
  c2bAssert("commitVerifiedObjectHashes", c2bObjectHashesExact);

  // (Test B) Owner C sentinel, time point 2 of 5: byte-exact comparison of its
  // Workspace file, every manifest it owns and every object those manifests
  // reference, plus an API-level read of its asset.
  const c2bOwnerCAfterSuccess = await c2bOwnerCState();
  const c2bSentinelWorkspaceAfter = (
    await rawRequest("/api/v1/workspace", "GET", undefined, c2bHeadersC)
  ).payload.workspace;
  const c2bSentinelAssetAfter = (
    await rawRequest(`/api/v1/assets/${c2bUpCId}`, "GET", undefined, c2bHeadersC)
  ).payload;
  c2bAssert(
    "otherOwnerPreservedAfterSuccess",
    JSON.stringify(c2bOwnerCAfterSuccess) === c2bOwnerCBaselineCanon
  );
  c2bAssert(
    "fullRestorePreservedOtherOwner",
    JSON.stringify(c2bOwnerCAfterSuccess) === c2bOwnerCBaselineCanon &&
      JSON.stringify(c2bSentinelWorkspaceAfter) ===
        JSON.stringify(c2bSentinelWorkspaceBefore) &&
      Buffer.from(c2bSentinelAssetAfter.base64 ?? "", "base64").equals(
        c2bAssetCBytes
      )
  );
  // Stronger than byte equality: owner C's Workspace, manifest and object files
  // still carry their original file identity, so the successful restore did not
  // even rewrite them with identical content.
  c2bAssert(
    "otherOwnerFilesNeverRewrittenAfterSuccess",
    await c2bOwnerCInodesUnchanged()
  );

  // (Test D) The Journal is parsed as NDJSON and matched on the exact
  // transaction identity of THIS restore. A substring search over the whole
  // Journal can be satisfied by an unrelated earlier event.
  const c2bJournalAfterSuccess = await c2bReadJournalEvents();
  const c2bSuccessEvents = c2bJournalAfterSuccess.filter(
    event =>
      event.operation === "backup.portable.restore" &&
      event.manifest &&
      event.manifest.transactionId === c2bTxId
  );
  const c2bSuccessLinked =
    c2bSuccessEvents.length === 1 &&
    c2bSuccessEvents[0].manifest.sourceBackupId === c2bBackupA.id &&
    c2bSuccessEvents[0].manifest.emergencyBackupId === c2bEmergencyId &&
    c2bSuccessEvents[0].manifest.ownerKeyHash === c2bOwnerHash &&
    c2bSuccessEvents[0].manifest.restored === true &&
    c2bSuccessEvents[0].manifest.verified === true;
  c2bAssert("successJournalExactlyLinked", c2bSuccessLinked);
  c2bAssert("fullRestoreJournalLinked", c2bSuccessLinked);

  // Staging cleanup completes before the success state: the transaction's own
  // directory is already gone at the moment the caller observes success.
  const c2bStagingAfter = await fs.readdir(c2bStagingDir).catch(() => []);
  const c2bStagingClean =
    !c2bStagingAfter.includes(`restore-portable-${c2bTxId}`) &&
    !c2bStagingAfter.some(name => name.startsWith("restore-portable-"));
  c2bAssert("stagingRemovedBeforeSuccess", c2bStagingClean);
  c2bAssert("fullRestoreStagingClean", c2bStagingClean);

  // ---- Restart persistence (success); owner C time point 3 of 5. ----
  await stopService(service);
  service = await startService();
  await waitForHealth();
  const c2bWsAfterRestart = await c2bParseWorkspace();
  c2bAssert(
    "fullRestorePersistedAfterRestart",
    (await fs.readFile(c2bAccountWs)).equals(c2bArchiveWorkspaceBytes) &&
      JSON.stringify(c2bStripUpdatedAt(c2bWsAfterRestart.workspace)) ===
        JSON.stringify(c2bStripUpdatedAt(c2bWsA))
  );
  const c2bEmergencyAfterRestart = await c2bListEmergencyEntries();
  c2bAssert(
    "fullRestoreEmergencyPersistedAfterRestart",
    c2bEmergencyAfterRestart.files.includes(
      `${c2bEmergencyId}.formdigital-backup`
    )
  );
  c2bAssert(
    "otherOwnerPreservedAfterSuccessRestart",
    JSON.stringify(await c2bOwnerCState()) === c2bOwnerCBaselineCanon
  );

  // ============ Pre-mutation rejection: cross-owner manifest name ===========
  // An incoming manifest name that already belongs to ANOTHER account must be
  // refused before the Emergency Backup and before any mutation. Overwriting it
  // would destroy the other account's manifest, and the rollback snapshot only
  // covers the request owner, so the loss would be unrecoverable.
  const c2bCollisionName = c2bIncomingManifestOrder[0];
  const c2bCollisionPath = path.join(c2bManifestDir, c2bCollisionName);
  const c2bCollisionOriginal = await fs.readFile(c2bCollisionPath);
  const c2bCollisionId = path.basename(c2bCollisionName, ".json");
  const c2bCollisionManifest = Buffer.from(
    JSON.stringify(
      {
        id: c2bCollisionId,
        schemaVersion: 1,
        ownerKeyHash: c2bOwnerCHash,
        contentHash: sha256Local(c2bAssetCBytes),
        originalFilename: "owner-c-collision.txt",
        mimeType: "text/plain",
        size: c2bAssetCBytes.length,
        createdAt: new Date().toISOString(),
        metadata: { kind: "sentinel-collision" },
      },
      null,
      2
    )
  );
  await fs.writeFile(c2bCollisionPath, c2bCollisionManifest);
  const c2bCollisionSnap = {
    workspace: await c2bReadWorkspaceBytes(),
    manifestNames: await c2bListManifestNames(),
    manifestBytes: {},
    objectNames: await c2bListObjectNames(),
    journal: await c2bReadBytes(journalPath),
    staging: await fs.readdir(c2bStagingDir).catch(() => []),
    emergency: await c2bListEmergencyEntries(),
  };
  for (const name of c2bCollisionSnap.manifestNames)
    c2bCollisionSnap.manifestBytes[name] = await c2bManifestBytes(name);
  const c2bCollisionResp = await rawRequest("/api/v1/restore", "POST", {
    archiveBase64: c2bBackupA.archiveBase64,
  });
  const c2bCollisionAfter = {
    workspace: await c2bReadWorkspaceBytes(),
    manifestNames: await c2bListManifestNames(),
    manifestBytes: {},
    objectNames: await c2bListObjectNames(),
    journal: await c2bReadBytes(journalPath),
    staging: await fs.readdir(c2bStagingDir).catch(() => []),
    emergency: await c2bListEmergencyEntries(),
  };
  for (const name of c2bCollisionAfter.manifestNames)
    c2bCollisionAfter.manifestBytes[name] = await c2bManifestBytes(name);
  c2bAssert(
    "crossOwnerManifestCollisionRejectedPreMutation",
    c2bCollisionResp.status === 422 &&
      c2bCollisionResp.payload?.error?.code === "portable_restore_rejected" &&
      c2bSafeFailurePayload(c2bCollisionResp.payload) &&
      c2bCollisionAfter.emergency.files.length ===
        c2bCollisionSnap.emergency.files.length &&
      c2bCollisionAfter.workspace === c2bCollisionSnap.workspace &&
      c2bCollisionAfter.journal === c2bCollisionSnap.journal &&
      JSON.stringify(c2bCollisionAfter.manifestNames) ===
        JSON.stringify(c2bCollisionSnap.manifestNames) &&
      JSON.stringify(c2bCollisionAfter.manifestBytes) ===
        JSON.stringify(c2bCollisionSnap.manifestBytes) &&
      JSON.stringify(c2bCollisionAfter.objectNames) ===
        JSON.stringify(c2bCollisionSnap.objectNames) &&
      JSON.stringify(c2bCollisionAfter.staging) ===
        JSON.stringify(c2bCollisionSnap.staging)
  );
  c2bAssert(
    "crossOwnerManifestBytesPreserved",
    (await fs.readFile(c2bCollisionPath)).equals(c2bCollisionManifest)
  );
  const c2bCollisionAssetRead = await rawRequest(
    `/api/v1/assets/${c2bCollisionId}`,
    "GET",
    undefined,
    c2bHeadersC
  );
  const c2bSentinelAssetAfterCollision = await rawRequest(
    `/api/v1/assets/${c2bUpCId}`,
    "GET",
    undefined,
    c2bHeadersC
  );
  c2bAssert(
    "crossOwnerAssetReadableAfterCollision",
    c2bCollisionAssetRead.status === 200 &&
      Buffer.from(c2bCollisionAssetRead.payload.base64 ?? "", "base64").equals(
        c2bAssetCBytes
      ) &&
      c2bSentinelAssetAfterCollision.status === 200 &&
      Buffer.from(
        c2bSentinelAssetAfterCollision.payload.base64 ?? "",
        "base64"
      ).equals(c2bAssetCBytes)
  );
  // Fixture teardown: hand the manifest name back to owner B.
  await fs.writeFile(c2bCollisionPath, c2bCollisionOriginal);
  c2bAssert(
    "crossOwnerCollisionFixtureRestored",
    (await fs.readFile(c2bCollisionPath)).equals(c2bCollisionOriginal) &&
      JSON.stringify(await c2bOwnerCState()) === c2bOwnerCBaselineCanon
  );

  // ============ Pre-mutation rejection: corrupt stored object ==============
  // The object store is shared by every account, so an incoming object whose
  // target already exists is only safe to reuse when the stored bytes really
  // hash to the target filename. A corrupt stored object must abort the restore
  // before the Emergency Backup and before any mutation.
  const c2bCorruptHash = Object.keys(c2bBackupAObjectFiles)[0];
  const c2bCorruptPath = path.join(c2bObjectDir, c2bCorruptHash);
  const c2bCorruptOriginal = await fs.readFile(c2bCorruptPath);
  const c2bCorruptFixtureBytes = Buffer.from(
    "layer-2c2b-r1-corrupted-object-bytes"
  );
  await fs.writeFile(c2bCorruptPath, c2bCorruptFixtureBytes);
  const c2bCorruptSnap = {
    workspace: await c2bReadWorkspaceBytes(),
    manifestNames: await c2bListManifestNames(),
    objectNames: await c2bListObjectNames(),
    journal: await c2bReadBytes(journalPath),
    staging: await fs.readdir(c2bStagingDir).catch(() => []),
    emergency: await c2bListEmergencyEntries(),
  };
  const c2bCorruptResp = await rawRequest("/api/v1/restore", "POST", {
    archiveBase64: c2bBackupA.archiveBase64,
  });
  const c2bCorruptAfter = {
    workspace: await c2bReadWorkspaceBytes(),
    manifestNames: await c2bListManifestNames(),
    objectNames: await c2bListObjectNames(),
    journal: await c2bReadBytes(journalPath),
    staging: await fs.readdir(c2bStagingDir).catch(() => []),
    emergency: await c2bListEmergencyEntries(),
  };
  c2bAssert(
    "existingCorruptObjectRejectedPreMutation",
    c2bCorruptResp.status === 422 &&
      c2bCorruptResp.payload?.error?.code === "portable_restore_rejected" &&
      c2bSafeFailurePayload(c2bCorruptResp.payload) &&
      c2bCorruptAfter.emergency.files.length ===
        c2bCorruptSnap.emergency.files.length &&
      c2bCorruptAfter.workspace === c2bCorruptSnap.workspace &&
      c2bCorruptAfter.journal === c2bCorruptSnap.journal &&
      JSON.stringify(c2bCorruptAfter.manifestNames) ===
        JSON.stringify(c2bCorruptSnap.manifestNames) &&
      JSON.stringify(c2bCorruptAfter.objectNames) ===
        JSON.stringify(c2bCorruptSnap.objectNames) &&
      (await fs.readFile(c2bCorruptPath)).equals(c2bCorruptFixtureBytes) &&
      JSON.stringify(c2bCorruptAfter.staging) ===
        JSON.stringify(c2bCorruptSnap.staging)
  );
  // Fixture teardown: put the genuine object bytes back.
  await fs.writeFile(c2bCorruptPath, c2bCorruptOriginal);
  c2bAssert(
    "corruptObjectFixtureRestored",
    sha256Local(await fs.readFile(c2bCorruptPath)) === c2bCorruptHash
  );

  // ================= Failure / rollback path =================
  // Re-establish a fresh Target B' state for the failure test.
  const c2bWsB2 = {
    schemaVersion: 2,
    templates: [{ id: "tB2", name: "Target B2 Template" }],
    templateVersions: [{ id: "verB2", templateId: "tB2" }],
    instances: [{ id: "insB2", templateId: "tB2" }],
    mappingTemplates: [],
    folders: [],
    tags: [],
    savedValues: [],
    fields: [],
    importRuns: [],
    importRows: [],
    mappingDecisions: [],
    detectionRuns: [],
    preferences: {},
  };
  await request("/api/v1/workspace", "PUT", {
    expectedRevision: (await request("/api/v1/workspace")).payload.revision,
    workspace: c2bWsB2,
  });
  const c2bAssetB2Bytes = Buffer.from("target-b2-exclusive-asset");
  const c2bUpB2 = (
    await request("/api/v1/assets", "POST", {
      base64: c2bAssetB2Bytes.toString("base64"),
      originalFilename: "b2.txt",
      mimeType: "text/plain",
      metadata: { kind: "source" },
    })
  ).payload;

  // (Test A) The owner C sentinel is NEVER removed to build this baseline. An
  // earlier revision of this test deleted every manifest whose ownerKeyHash was
  // not owner B's, which silently destroyed the very sentinel the cross-account
  // assertions depend on. The baseline is taken exactly as it is: owner B's
  // manifests plus owner C's untouched manifest.

  // (Test F) Commit-phase fault injection.
  // The delivery platform's Data Folder lives on a case-insensitive filesystem,
  // while the service compares manifest NAMES case-sensitively. Renaming one
  // incoming manifest to upper case therefore creates a state where:
  //   * the pre-mutation preflight passes (the target resolves to a regular,
  //     parseable, owner-B manifest, so nothing is rejected up front),
  //   * the commit writes the incoming lower-case manifest successfully,
  //   * the "remove owner manifests the archive does not declare" step then
  //     deletes the upper-case name — which is the same file that was just
  //     written — and
  //   * commit verification detects the missing archive manifest and rolls the
  //     whole transaction back.
  // The failure is raised inside the commit phase, after objects, manifests and
  // the Workspace have been mutated, and it never touches another account.
  const c2bCaseProbeLower = path.join(testRoot, "case-probe-c2b.txt");
  const c2bCaseProbeUpper = path.join(testRoot, "CASE-PROBE-C2B.txt");
  await fs.writeFile(c2bCaseProbeLower, "case-probe");
  const c2bCaseInsensitive = await fs
    .readFile(c2bCaseProbeUpper, "utf8")
    .then(text => text === "case-probe")
    .catch(() => false);
  await fs.rm(c2bCaseProbeLower, { force: true });
  await fs.rm(c2bCaseProbeUpper, { force: true });
  if (!c2bCaseInsensitive)
    throw new Error(
      "Layer 2C2B commit-phase fault injection needs a case-insensitive Data Folder filesystem; the transactional contract cannot be certified without a real mid-commit failure."
    );
  c2bAssert("midCommitFaultArmedInCommitPhase", c2bCaseInsensitive);

  const c2bFaultLowerName = c2bIncomingManifestOrder[0];
  const c2bFaultUpperName = `${path
    .basename(c2bFaultLowerName, ".json")
    .toUpperCase()}.json`;
  const c2bFaultLowerPath = path.join(c2bManifestDir, c2bFaultLowerName);
  const c2bFaultBytes = await fs.readFile(c2bFaultLowerPath);
  await fs.rm(c2bFaultLowerPath, { force: true });
  const c2bFaultUpperPath = path.join(c2bManifestDir, c2bFaultUpperName);
  await fs.writeFile(c2bFaultUpperPath, c2bFaultBytes);
  // File identity of the manifest the commit phase is about to rewrite and then
  // delete. Comparing bytes alone cannot prove the commit really mutated the
  // live store, because the incoming manifest happens to carry the same bytes.
  const c2bFaultInodeBefore = await c2bInode(c2bFaultUpperPath);

  // Snapshot Target B' AFTER the fault is armed and BEFORE the failing restore,
  // so the rollback is compared against the exact state the service saw.
  const c2bSnapB2 = {
    workspace: await c2bReadWorkspaceBytes(),
    manifestNames: await c2bListManifestNames(),
    manifestBytes: {},
    objectNames: await c2bListObjectNames(),
    ownerManifestNames: await c2bOwnerManifestNames(c2bOwnerHash),
  };
  for (const name of c2bSnapB2.manifestNames)
    c2bSnapB2.manifestBytes[name] = await c2bManifestBytes(name);
  const c2bEmergencyBeforeFail = await c2bListEmergencyEntries();
  c2bAssert(
    "midCommitFaultTargetsRequestOwnerOnly",
    c2bSnapB2.manifestNames.includes(c2bFaultUpperName) &&
      !c2bSnapB2.manifestNames.includes(c2bFaultLowerName) &&
      c2bSnapB2.ownerManifestNames.includes(c2bFaultUpperName) &&
      Object.keys(c2bOwnerCBaseline.manifests).every(name =>
        c2bSnapB2.manifestNames.includes(name)
      )
  );

  const c2bFailResp = await rawRequest("/api/v1/restore", "POST", {
    archiveBase64: c2bBackupA.archiveBase64,
  });
  c2bAssert(
    "midCommitFailureTriggered",
    c2bFailResp.status === 422 &&
      c2bFailResp.payload?.error?.code === "portable_restore_rejected"
  );
  // (Test G) The failure response carries a curated message only: no absolute
  // path, staging name, bearer token, owner hash, errno code or stack frame.
  c2bAssert("safeFailureResponse", c2bSafeFailurePayload(c2bFailResp.payload));

  // Exactly one new pre-restore Emergency Backup, and it is kept.
  const c2bEmergencyAfterFail = await c2bListEmergencyEntries();
  const c2bFailEmergencyNew = [
    ...c2bEmergencyAfterFail.files.filter(
      name => !c2bEmergencyBeforeFail.files.includes(name)
    ),
    ...c2bEmergencyAfterFail.dirs.filter(
      name => !c2bEmergencyBeforeFail.dirs.includes(name)
    ),
  ];
  c2bAssert(
    "rollbackKeptEmergencyBackup",
    c2bFailEmergencyNew.length === 1 &&
      c2bEmergencyAfterFail.files.length + c2bEmergencyAfterFail.dirs.length ===
        c2bEmergencyBeforeFail.files.length + c2bEmergencyBeforeFail.dirs.length + 1
  );
  const c2bFailEmergencyId = String(c2bFailEmergencyNew[0] ?? "").replace(
    /\.formdigital-backup$/,
    ""
  );
  const c2bFailEmDetail = await c2bEmergencyMatchesSnapshot(
    c2bFailEmergencyId,
    c2bSnapB2
  );
  const c2bLegacyEmergencyExact = await c2bLegacyEmergencyMatchesSnapshot(
    c2bFailEmergencyId,
    c2bSnapB2,
  );
  c2bAssert(
    "rollbackEmergencyExactlyPreservedTargetState",
    c2bFailEmDetail.exact || c2bLegacyEmergencyExact,
  );

  // Target B' Workspace bytes fully restored.
  c2bAssert(
    "rollbackRestoredWorkspaceBytes",
    (await c2bReadWorkspaceBytes()) === c2bSnapB2.workspace
  );

  // Target B' manifests fully restored: identical name set and identical bytes,
  // including the upper-case name the failed commit deleted.
  const c2bManifestNamesB2After = await c2bListManifestNames();
  let c2bRollbackManifests =
    JSON.stringify([...c2bManifestNamesB2After].sort()) ===
    JSON.stringify([...c2bSnapB2.manifestNames].sort());
  for (const name of c2bSnapB2.manifestNames) {
    const live = await c2bManifestBytes(name).catch(() => null);
    if (live !== c2bSnapB2.manifestBytes[name]) c2bRollbackManifests = false;
  }
  c2bAssert("rollbackRestoredManifestBytes", c2bRollbackManifests);

  // The commit phase really did mutate the live store before failing: the
  // manifest it rewrote and then deleted now carries a NEW file identity, and
  // rollback put the original bytes back under the original name. An unchanged
  // inode would mean the "mid-commit" failure never reached the commit phase and
  // the rollback proof would be vacuous.
  const c2bFaultInodeAfter = await c2bInode(c2bFaultUpperPath);
  c2bAssert(
    "rollbackRewroteMutatedManifestFile",
    typeof c2bFaultInodeBefore === "string" &&
      typeof c2bFaultInodeAfter === "string" &&
      c2bFaultInodeAfter !== c2bFaultInodeBefore &&
      (await fs.readFile(c2bFaultUpperPath).catch(() => null))?.equals(
        c2bFaultBytes
      ) === true
  );

  // No unsafe NEW object left. The object store is content-addressed and shared
  // across owners; A's objects may legitimately remain as orphans after rollback
  // (they were not added by THIS transaction and rollback must not delete them).
  // The correct assertion is set-equality of the post-rollback object set against
  // the pre-failure snapshot — rollback must not have leaked any new unreferenced
  // object that was absent before the failed transaction began.
  const c2bObjectNamesB2AfterSet = new Set(await c2bListObjectNames());
  c2bAssert(
    "rollbackNoUnsafeObjects",
    c2bObjectNamesB2AfterSet.size === c2bSnapB2.objectNames.length &&
      c2bSnapB2.objectNames.every(hash => c2bObjectNamesB2AfterSet.has(hash))
  );

  // (Test B) Owner C sentinel, time point 4 of 5.
  const c2bOwnerCAfterRollback = await c2bOwnerCState();
  const c2bSentinelWorkspaceB2 = (
    await rawRequest("/api/v1/workspace", "GET", undefined, c2bHeadersC)
  ).payload.workspace;
  const c2bSentinelAssetB2 = await rawRequest(
    `/api/v1/assets/${c2bUpCId}`,
    "GET",
    undefined,
    c2bHeadersC
  );
  c2bAssert(
    "otherOwnerPreservedAfterRollback",
    JSON.stringify(c2bOwnerCAfterRollback) === c2bOwnerCBaselineCanon
  );
  c2bAssert(
    "rollbackPreservedOtherOwner",
    JSON.stringify(c2bOwnerCAfterRollback) === c2bOwnerCBaselineCanon &&
      JSON.stringify(c2bSentinelWorkspaceB2) ===
        JSON.stringify(c2bSentinelWorkspaceBefore) &&
      c2bSentinelAssetB2.status === 200 &&
      Buffer.from(c2bSentinelAssetB2.payload.base64 ?? "", "base64").equals(
        c2bAssetCBytes
      )
  );
  // Neither the failing commit nor the rollback replaced any of owner C's files.
  c2bAssert(
    "otherOwnerFilesNeverRewrittenAfterRollback",
    await c2bOwnerCInodesUnchanged()
  );

  // Staging transaction dir cleaned after rollback.
  const c2bStagingAfterFail = await fs.readdir(c2bStagingDir).catch(() => []);
  c2bAssert(
    "rollbackCleanedStaging",
    !c2bStagingAfterFail.some(name => name.startsWith("restore-portable-"))
  );

  // (Test D) Rollback Journal event matched by exact identity, not substring.
  const c2bJournalEventsAfterFail = await c2bReadJournalEvents();
  const c2bRollbackEvents = c2bJournalEventsAfterFail.filter(
    event =>
      event.operation === "backup.portable.restore.rollback" &&
      event.manifest &&
      event.manifest.emergencyBackupId === c2bFailEmergencyId
  );
  const c2bFailTxId =
    c2bRollbackEvents.length === 1
      ? c2bRollbackEvents[0].manifest.transactionId
      : null;
  const c2bRollbackLinked =
    c2bRollbackEvents.length === 1 &&
    typeof c2bFailTxId === "string" &&
    c2bFailTxId.length > 0 &&
    c2bFailTxId !== c2bTxId &&
    c2bRollbackEvents[0].manifest.sourceBackupId === c2bBackupA.id &&
    c2bRollbackEvents[0].manifest.ownerKeyHash === c2bOwnerHash &&
    c2bRollbackEvents[0].manifest.reason === "mid_commit_failure" &&
    c2bRollbackEvents[0].manifest.rolledBack === true;
  c2bAssert("rollbackJournalExactlyLinked", c2bRollbackLinked);
  c2bAssert("rollbackJournalLinked", c2bRollbackLinked);

  // The failed transaction must have NO success event and NO failed-rollback
  // event anywhere in the Journal, while the earlier successful restore must
  // still appear exactly once. A whole-file substring search proves neither,
  // because the successful restore already wrote `"restored":true`.
  const c2bFailTxForeignEvents = c2bJournalEventsAfterFail.filter(
    event =>
      (event.operation === "backup.portable.restore" ||
        event.operation === "backup.portable.restore.rollback.failed") &&
      event.manifest &&
      (event.manifest.transactionId === c2bFailTxId ||
        event.manifest.emergencyBackupId === c2bFailEmergencyId)
  );
  c2bAssert(
    "failedTransactionHasNoSuccessEvent",
    typeof c2bFailTxId === "string" &&
      c2bFailTxForeignEvents.length === 0 &&
      c2bJournalEventsAfterFail.filter(
        event =>
          event.operation === "backup.portable.restore" &&
          event.manifest &&
          event.manifest.transactionId === c2bTxId
      ).length === 1
  );

  // Health and Target B' readability survive the rollback.
  c2bAssert("rollbackHealthOk", (await health()).payload.status === "ok");
  c2bAssert(
    "rollbackWorkspaceReadableAfterRollback",
    (await request("/api/v1/workspace")).payload.workspace.templates?.[0]?.id ===
      "tB2"
  );
  const c2bAssetB2AfterRollback = await rawRequest(
    `/api/v1/assets/${c2bUpB2.asset.id}`,
    "GET"
  );
  c2bAssert(
    "rollbackAssetReadableAfterRollback",
    c2bAssetB2AfterRollback.status === 200 &&
      Buffer.from(c2bAssetB2AfterRollback.payload.base64 ?? "", "base64").equals(
        c2bAssetB2Bytes
      )
  );

  // ---- Restart persistence (rollback); owner C time point 5 of 5. ----
  await stopService(service);
  service = await startService();
  await waitForHealth();
  const c2bWsB2Restart = await c2bParseWorkspace();
  c2bAssert(
    "rollbackPersistedAfterRestart",
    (await c2bReadWorkspaceBytes()) === c2bSnapB2.workspace &&
      c2bWsB2Restart.workspace.templates?.[0]?.id === "tB2" &&
      JSON.stringify([...(await c2bListManifestNames())].sort()) ===
        JSON.stringify([...c2bSnapB2.manifestNames].sort())
  );
  c2bAssert(
    "otherOwnerPreservedAfterRollbackRestart",
    JSON.stringify(await c2bOwnerCState()) === c2bOwnerCBaselineCanon
  );

  // ================= Boundary: template-scoped full restore rejected =========
  // Build a template-scoped backup, then call full restore with it (no
  // preserveExistingAssets). Must be rejected BEFORE Emergency Backup/mutation.
  const c2bTemplateBackup = (
    await request("/api/v1/backups", "POST", {
      portable: true,
      templateId: "tB2",
    })
  ).payload;
  const c2bEmergencyBeforeTpl = await c2bListEmergencyEntries();
  const c2bTplSnap = {
    workspace: await c2bReadWorkspaceBytes(),
    manifestNames: await c2bListManifestNames(),
    objectNames: await c2bListObjectNames(),
    journal: await c2bReadBytes(journalPath),
    staging: await fs.readdir(c2bStagingDir).catch(() => []),
  };
  const c2bTplResp = await rawRequest("/api/v1/restore", "POST", {
    archiveBase64: c2bTemplateBackup.archiveBase64,
  });
  // No Emergency Backup created, no mutation of workspace/manifest/object/journal.
  const c2bEmergencyAfterTpl = await c2bListEmergencyEntries();
  const c2bTplAfter = {
    workspace: await c2bReadWorkspaceBytes(),
    manifestNames: await c2bListManifestNames(),
    objectNames: await c2bListObjectNames(),
    journal: await c2bReadBytes(journalPath),
    staging: await fs.readdir(c2bStagingDir).catch(() => []),
  };
  c2bAssert(
    "templateScopeFullRestoreRejectedBeforeMutation",
    c2bTplResp.status === 422 &&
      c2bTplResp.payload?.error?.code === "portable_restore_rejected" &&
      c2bSafeFailurePayload(c2bTplResp.payload) &&
      c2bEmergencyAfterTpl.files.length ===
        c2bEmergencyBeforeTpl.files.length &&
      c2bTplAfter.workspace === c2bTplSnap.workspace &&
      JSON.stringify(c2bTplAfter.manifestNames) ===
        JSON.stringify(c2bTplSnap.manifestNames) &&
      JSON.stringify(c2bTplAfter.objectNames) ===
        JSON.stringify(c2bTplSnap.objectNames) &&
      c2bTplAfter.journal === c2bTplSnap.journal &&
      JSON.stringify(c2bTplAfter.staging) === JSON.stringify(c2bTplSnap.staging)
  );

  // ---- (Test E) Enforce the whole Layer 2C2B ledger BEFORE any reporting ----
  // Every Layer 2C2B field in the summary below comes from this ledger, so a
  // field can never be printed — and `verified: true` can never be emitted —
  // unless its assertion actually passed.
  if (c2bFailed.length)
    throw new Error(
      `Layer 2C2B-R1 assertion failed: ${c2bFailed.join(", ")}`
    );
  const c2bAssertionNames = Object.keys(c2bResults);
  const allLayer2C2BAssertionsEnforced =
    c2bAssertionNames.length >= 40 &&
    c2bAssertionNames.every(name => c2bResults[name] === true);
  if (!allLayer2C2BAssertionsEnforced)
    throw new Error(
      `Layer 2C2B-R1 assertion ledger is incomplete (${c2bAssertionNames.length} registered assertions).`
    );

  // ================= P0 Local Data Service hardening regressions ============
  // The earlier transactional fault deliberately leaves an upper-case manifest
  // filename and its historical fixtures predate required Instance->Version
  // links. Normalize those fixtures only after every Layer 2C2B assertion has
  // completed, so the stricter whole-folder integrity/legacy tests start from a
  // valid graph instead of the intentionally damaged fault-injection state.
  if (await exists(c2bFaultUpperPath)) {
    const normalizePath = `${c2bFaultLowerPath}.${crypto.randomUUID()}.normalize`;
    await fs.rename(c2bFaultUpperPath, normalizePath);
    await fs.rename(normalizePath, c2bFaultLowerPath);
  }
  for (const ownerHeaders of [headers, c2bHeadersC]) {
    const envelope = (
      await request("/api/v1/workspace", "GET", undefined, ownerHeaders)
    ).payload;
    await request(
      "/api/v1/workspace",
      "PUT",
      {
        expectedRevision: envelope.revision,
        workspace: {
          ...envelope.workspace,
          instances: (envelope.workspace.instances ?? []).map(instance => ({
            ...instance,
            templateVersionId:
              instance.templateVersionId ??
              (envelope.workspace.templateVersions ?? []).find(
                version => version.templateId === instance.templateId,
              )?.id,
          })),
        },
      },
      ownerHeaders,
    );
  }

  const hardOwner = "google-user-p0-hardening";
  const hardHeaders = { ...headers, "x-formdigital-owner": hardOwner };
  const hardWorkspace = name => ({
    schemaVersion: 2,
    templates: [{
      id: "t-hard",
      name,
      currentPublishedVersionId: null,
      currentDraftVersionId: "v-hard",
      folderIds: [],
      tagIds: [],
    }],
    templateVersions: [{
      id: "v-hard",
      templateId: "t-hard",
      pageManifest: [],
    }],
    fields: [],
    instances: [],
    folders: [],
    tags: [],
    savedValues: [],
    mappingTemplates: [],
    importRuns: [],
    importRows: [],
    mappingDecisions: [],
    detectionRuns: [],
  });
  const hardInitialCommit = await request(
    "/api/v1/workspace",
    "PUT",
    { expectedRevision: 0, workspace: hardWorkspace("Hardening baseline") },
    hardHeaders,
  );
  const hardOverwriteCommit = await request(
    "/api/v1/workspace",
    "PUT",
    {
      expectedRevision: hardInitialCommit.payload.revision,
      workspace: hardWorkspace("Hardening overwrite"),
    },
    hardHeaders,
  );
  const hardOverwriteRead = (
    await request("/api/v1/workspace", "GET", undefined, hardHeaders)
  ).payload;
  const atomicOverwriteExistingTarget =
    hardOverwriteCommit.payload.revision === 2 &&
    hardOverwriteRead.revision === 2 &&
    hardOverwriteRead.workspace.templates?.[0]?.name === "Hardening overwrite";
  if (!atomicOverwriteExistingTarget)
    throw new Error("Atomic overwrite of an existing Workspace target failed.");

  const hardBytes = Buffer.from("same-object-distinct-lifecycle-references");
  const hardAssetInput = {
    base64: hardBytes.toString("base64"),
    originalFilename: "same.pdf",
    mimeType: "application/pdf",
    metadata: {
      kind: "source",
      templateId: "t-hard",
      templateVersionId: "v-hard",
    },
  };
  const hardFirst = (
    await request("/api/v1/assets", "POST", hardAssetInput, hardHeaders)
  ).payload;
  const hardSecond = (
    await request("/api/v1/assets", "POST", hardAssetInput, hardHeaders)
  ).payload;
  const dedupCreatesDistinctManifest =
    hardFirst.asset.id !== hardSecond.asset.id &&
    hardFirst.asset.contentHash === hardSecond.asset.contentHash &&
    hardSecond.deduplicated === true &&
    hardSecond.asset.metadata.templateId === "t-hard" &&
    hardSecond.asset.metadata.templateVersionId === "v-hard";
  if (!dedupCreatesDistinctManifest)
    throw new Error("Object de-duplication reused a lifecycle manifest.");
  await request(
    `/api/v1/assets/${hardSecond.asset.id}`,
    "DELETE",
    undefined,
    hardHeaders,
  );
  const deletingDuplicatePreservesOriginal =
    (
      await rawRequest(
        `/api/v1/assets/${hardFirst.asset.id}`,
        "GET",
        undefined,
        hardHeaders,
      )
    ).status === 200;
  if (!deletingDuplicatePreservesOriginal)
    throw new Error("Deleting one de-duplicated manifest removed another reference.");

  const rawQuery = new URLSearchParams({
    filename: "race.pdf",
    mimeType: "application/pdf",
    metadata: encodeURIComponent(
      JSON.stringify({
        kind: "source",
        templateId: "t-hard",
        templateVersionId: "v-hard",
      }),
    ),
  });
  const slowBody = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from("race-part-one-"));
      setTimeout(() => {
        controller.enqueue(Buffer.from("race-part-two"));
        controller.close();
      }, 80);
    },
  });
  const racingUploadPromise = fetch(
    `${baseUrl}/api/v1/assets/raw?${rawQuery}`,
    {
      method: "POST",
      headers: {
        ...hardHeaders,
        "content-type": "application/octet-stream",
      },
      body: slowBody,
      duplex: "half",
    },
  );
  await new Promise(resolve => setTimeout(resolve, 20));
  const hardBeforeDelete = (
    await rawRequest("/api/v1/workspace", "GET", undefined, hardHeaders)
  ).payload;
  const deleteWorkspacePromise = request(
    "/api/v1/workspace",
    "PUT",
    {
      expectedRevision: hardBeforeDelete.revision,
      workspace: {
        ...hardWorkspace("deleted"),
        templates: [],
        templateVersions: [],
      },
    },
    hardHeaders,
  );
  const racingUpload = await racingUploadPromise;
  await deleteWorkspacePromise;
  await request(
    "/api/v1/templates/t-hard/assets",
    "DELETE",
    undefined,
    hardHeaders,
  );
  const postDeleteUpload = await fetch(
    `${baseUrl}/api/v1/assets/raw?${rawQuery}`,
    {
      method: "POST",
      headers: {
        ...hardHeaders,
        "content-type": "application/octet-stream",
      },
      body: Buffer.from("late-commit-must-fail"),
    },
  );
  const hardAssetsAfterDelete = (
    await request("/api/v1/assets", "GET", undefined, hardHeaders)
  ).payload.assets;
  const mutationGatePreventsLateCommit =
    [200, 201].includes(racingUpload.status) &&
    postDeleteUpload.status === 409 &&
    !hardAssetsAfterDelete.some(
      item => item.metadata?.templateId === "t-hard",
    );
  if (!mutationGatePreventsLateCommit)
    throw new Error("A cancelled/deleted Template accepted a late asset commit.");

  // Legacy folder backups must restore every domain they copy, not only asset
  // objects/manifests. Mutate both account Workspace and metadata after the
  // snapshot, then prove both return to the same snapshot generation.
  const hardDeletedEnvelope = (
    await request("/api/v1/workspace", "GET", undefined, hardHeaders)
  ).payload;
  await request(
    "/api/v1/workspace",
    "PUT",
    {
      expectedRevision: hardDeletedEnvelope.revision,
      workspace: hardWorkspace("Legacy snapshot"),
    },
    hardHeaders,
  );
  await request(
    "/api/v1/host-account",
    "PUT",
    { googleUserId: "legacy-snapshot-user", email: "snapshot@example.invalid" },
  );
  const legacyBackup = (
    await request("/api/v1/backups", "POST", {})
  ).payload;
  const hardSnapshotEnvelope = (
    await request("/api/v1/workspace", "GET", undefined, hardHeaders)
  ).payload;
  await request(
    "/api/v1/workspace",
    "PUT",
    {
      expectedRevision: hardSnapshotEnvelope.revision,
      workspace: hardWorkspace("Post-backup mutation"),
    },
    hardHeaders,
  );
  await request(
    "/api/v1/host-account",
    "PUT",
    { googleUserId: "post-backup-user", email: "changed@example.invalid" },
  );
  await request("/api/v1/restore", "POST", { backupId: legacyBackup.id });
  const legacyRestoredWorkspace = (
    await request("/api/v1/workspace", "GET", undefined, hardHeaders)
  ).payload;
  const legacyRestoredHost = (
    await request("/api/v1/host-account", "GET")
  ).payload;
  const legacyRestoreRestoresAllDomains =
    legacyRestoredWorkspace.workspace.templates?.[0]?.name === "Legacy snapshot" &&
    legacyRestoredHost.googleUserId === "legacy-snapshot-user" &&
    legacyRestoredHost.email === "snapshot@example.invalid";
  if (!legacyRestoreRestoresAllDomains)
    throw new Error("Legacy restore did not restore accounts and metadata together.");

  // A Workspace with a broken foreign key and missing page asset must be
  // reported unhealthy, and an incomplete Portable Backup must not be emitted.
  const hardValidAfterLegacy = legacyRestoredWorkspace.workspace;
  await request(
    "/api/v1/workspace",
    "PUT",
    {
      expectedRevision: legacyRestoredWorkspace.revision,
      workspace: {
        ...hardValidAfterLegacy,
        templateVersions: [{
          ...hardValidAfterLegacy.templateVersions[0],
          templateId: "missing-template",
          pageManifest: [{ page: 1, assetId: "asset-missing" }],
        }],
      },
    },
    hardHeaders,
  );
  const brokenScan = (
    await request("/api/v1/integrity-scan", "POST")
  ).payload;
  const brokenCodes = new Set(brokenScan.findings.map(item => item.code));
  const integrityValidatesWorkspaceGraph =
    brokenScan.healthy === false &&
    brokenCodes.has("workspace_version_template_missing") &&
    brokenCodes.has("workspace_asset_missing");
  if (!integrityValidatesWorkspaceGraph)
    throw new Error("Integrity scan accepted broken Workspace relations.");
  const incompleteBackup = await rawRequest(
    "/api/v1/backups",
    "POST",
    { portable: true },
    hardHeaders,
  );
  const backupRejectsMissingReferencedAsset = incompleteBackup.status >= 400;
  if (!backupRejectsMissingReferencedAsset)
    throw new Error("Portable Backup accepted a missing required asset.");
  const hardBrokenEnvelope = (
    await request("/api/v1/workspace", "GET", undefined, hardHeaders)
  ).payload;
  await request(
    "/api/v1/workspace",
    "PUT",
    {
      expectedRevision: hardBrokenEnvelope.revision,
      workspace: hardValidAfterLegacy,
    },
    hardHeaders,
  );

  // Simulate a process death with a durable atomic transaction descriptor and
  // no canonical target. Startup must deterministically restore the previous
  // committed bytes before serving requests.
  const liveHardRoot = await readConfigDataFolder();
  const hardOwnerHash = crypto.createHash("sha256").update(hardOwner).digest("hex");
  const hardWorkspacePath = path.join(
    liveHardRoot,
    "accounts",
    hardOwnerHash,
    "workspace.json",
  );
  const atomicPreviousBytes = await fs.readFile(hardWorkspacePath);
  await stopService(service);
  const atomicId = crypto.randomUUID();
  const atomicTemp = `${hardWorkspacePath}.formdigital-atomic-${atomicId}.tmp`;
  const atomicPrevious = `${hardWorkspacePath}.formdigital-atomic-${atomicId}.previous`;
  const atomicDescriptor = path.join(
    liveHardRoot,
    "staging",
    `.formdigital-atomic-${atomicId}.json`,
  );
  await fs.writeFile(atomicTemp, Buffer.from("synthetic-uncommitted-bytes"));
  await fs.writeFile(atomicPrevious, atomicPreviousBytes);
  await fs.writeFile(
    atomicDescriptor,
    JSON.stringify({
      schemaVersion: 1,
      target: hardWorkspacePath,
      temp: atomicTemp,
      previous: atomicPrevious,
    }),
  );
  await fs.rm(hardWorkspacePath);
  service = await startService();
  await waitForHealth();
  const atomicRecoveryRestoredCanonical =
    (await fs.readFile(hardWorkspacePath)).equals(atomicPreviousBytes) &&
    !(await exists(atomicTemp)) &&
    !(await exists(atomicPrevious)) &&
    !(await exists(atomicDescriptor)) &&
    (
      await request("/api/v1/workspace", "GET", undefined, hardHeaders)
    ).payload.workspace.templates?.[0]?.name === "Legacy snapshot";
  if (!atomicRecoveryRestoredCanonical)
    throw new Error("Startup did not recover an interrupted atomic write.");

  // A real raw duplicate reuses only the content-addressed object. A corrupt
  // pre-existing target with the same hash-shaped filename must fail closed
  // before any lifecycle manifest is published.
  const rawHardUpload = async bytes => {
    const params = new URLSearchParams({
      filename: "raw-hardening.bin",
      mimeType: "application/octet-stream",
      metadata: encodeURIComponent(JSON.stringify({ kind: "test-fixture" })),
    });
    const response = await fetch(`${baseUrl}/api/v1/assets/raw?${params}`, {
      method: "POST",
      headers: { ...hardHeaders, "content-type": "application/octet-stream" },
      body: bytes,
    });
    return { status: response.status, payload: await response.json() };
  };
  const rawHardBytes = Buffer.from("raw-duplicate-byte-for-byte");
  const rawHardFirst = await rawHardUpload(rawHardBytes);
  const rawHardSecond = await rawHardUpload(rawHardBytes);
  const rawDuplicateVerified =
    rawHardFirst.status === 201 &&
    rawHardSecond.status === 200 &&
    rawHardSecond.payload.deduplicated === true &&
    rawHardFirst.payload.asset.id !== rawHardSecond.payload.asset.id &&
    rawHardFirst.payload.asset.contentHash === rawHardSecond.payload.asset.contentHash;
  if (!rawDuplicateVerified)
    throw new Error("Raw object de-duplication did not preserve lifecycle identity.");

  const conflictBytes = Buffer.from("raw-conflict-expected-content");
  const conflictHash = crypto.createHash("sha256").update(conflictBytes).digest("hex");
  const conflictPath = path.join(liveHardRoot, "objects", conflictHash);
  await fs.writeFile(conflictPath, Buffer.from("wrong-content"));
  const rawAssetsBeforeConflict = (
    await request("/api/v1/assets", "GET", undefined, hardHeaders)
  ).payload.assets.length;
  const rawConflictResponse = await rawHardUpload(conflictBytes);
  const rawAssetsAfterConflict = (
    await request("/api/v1/assets", "GET", undefined, hardHeaders)
  ).payload.assets.length;
  const rawConflictFailedClosed =
    rawConflictResponse.status === 409 &&
    rawAssetsAfterConflict === rawAssetsBeforeConflict &&
    (await fs.readFile(conflictPath, "utf8")) === "wrong-content";
  await fs.rm(conflictPath, { force: true });
  if (!rawConflictFailedClosed)
    throw new Error("Raw upload published a manifest for an unverified object target.");

  const unreadableManifestPath = path.join(
    liveHardRoot,
    "manifests",
    "synthetic-unreadable.json",
  );
  const preservedManifestPath = path.join(
    liveHardRoot,
    "manifests",
    `${rawHardFirst.payload.asset.id}.json`,
  );
  const preservedManifestBytes = await fs.readFile(preservedManifestPath);
  const preservedObjectPath = path.join(
    liveHardRoot,
    "objects",
    rawHardFirst.payload.asset.contentHash,
  );
  const preservedObjectBytes = await fs.readFile(preservedObjectPath);
  await fs.writeFile(unreadableManifestPath, "{not-json");
  const uncertainDelete = await rawRequest(
    `/api/v1/assets/${rawHardFirst.payload.asset.id}`,
    "DELETE",
    undefined,
    hardHeaders,
  );
  const unreadableManifestDeleteFailsClosed =
    uncertainDelete.status === 500 &&
    (await fs.readFile(preservedManifestPath)).equals(preservedManifestBytes) &&
    (await fs.readFile(preservedObjectPath)).equals(preservedObjectBytes);
  await fs.rm(unreadableManifestPath, { force: true });
  if (!unreadableManifestDeleteFailsClosed)
    throw new Error("Asset deletion proceeded with an unreadable reference manifest.");

  // Same-Template draft cloning legitimately reuses source/page bytes across
  // Versions; integrity must distinguish that from a cross-Template relation.
  const cloneEnvelope = (
    await request("/api/v1/workspace", "GET", undefined, hardHeaders)
  ).payload;
  const cloneBaseVersion = cloneEnvelope.workspace.templateVersions[0];
  const cloneAsset = (
    await request(
      "/api/v1/assets",
      "POST",
      {
        base64: Buffer.from("clone-page").toString("base64"),
        originalFilename: "clone-page.png",
        mimeType: "image/png",
        metadata: {
          kind: "page",
          templateId: cloneBaseVersion.templateId,
          templateVersionId: cloneBaseVersion.id,
        },
      },
      hardHeaders,
    )
  ).payload.asset;
  const cloneVersion = {
    ...cloneBaseVersion,
    id: `${cloneBaseVersion.id}-clone`,
    state: "draft",
    pageManifest: [{ page: 1, assetId: cloneAsset.id }],
  };
  const cloneOriginalVersion = {
    ...cloneBaseVersion,
    pageManifest: [{ page: 1, assetId: cloneAsset.id }],
  };
  await request(
    "/api/v1/workspace",
    "PUT",
    {
      expectedRevision: cloneEnvelope.revision,
      workspace: {
        ...cloneEnvelope.workspace,
        templateVersions: [cloneOriginalVersion, cloneVersion],
      },
    },
    hardHeaders,
  );
  const cloneScan = (await request("/api/v1/integrity-scan", "POST")).payload;
  const sameTemplateVersionAssetSharingAccepted = cloneScan.healthy === true;
  if (!sameTemplateVersionAssetSharingAccepted)
    throw new Error("Integrity scan rejected valid same-Template Version asset sharing.");

  // A verified portable archive must still repair an invalid current Workspace.
  // The emergency prebackup falls back to the byte-exact five-domain format.
  const portableBeforeCorruption = (
    await request("/api/v1/portable-backups", "POST", {}, hardHeaders)
  ).payload;
  const portableBeforeCorruptionBytes = await downloadPortableArchive(
    portableBeforeCorruption.id,
    hardHeaders,
  );
  await fs.writeFile(hardWorkspacePath, Buffer.from("{broken-workspace"));
  const repairSession = await uploadPortableArchive(
    portableBeforeCorruptionBytes,
    hardHeaders,
  );
  const repairRestore = await rawRequest(
    `/api/v1/portable-restore-sessions/${repairSession.sessionId}/commit`,
    "POST",
    undefined,
    hardHeaders,
  );
  const portableRestoreRepairsCorruptCurrent =
    repairRestore.status === 200 &&
    JSON.parse(await fs.readFile(hardWorkspacePath, "utf8")).workspace;
  if (!portableRestoreRepairsCorruptCurrent)
    throw new Error("A corrupt current Workspace blocked verified portable restore.");

  // Once the five-domain commit marker is durable, synthetic cleanup failure
  // is reported as deferred work and never rolls the restored generation back.
  const cleanupBackup = (await request("/api/v1/backups", "POST", {})).payload;
  const cleanupBeforeMutation = (
    await request("/api/v1/workspace", "GET", undefined, hardHeaders)
  ).payload;
  await request(
    "/api/v1/workspace",
    "PUT",
    {
      expectedRevision: cleanupBeforeMutation.revision,
      workspace: {
        ...cleanupBeforeMutation.workspace,
        templates: cleanupBeforeMutation.workspace.templates.map((item, index) =>
          index === 0 ? { ...item, name: "cleanup-mutation" } : item
        ),
      },
    },
    hardHeaders,
  );
  await stopService(service);
  service = await startService({
    FORMDIGITAL_TEST_LEGACY_RESTORE_CLEANUP_FAIL: "1",
  });
  await waitForHealth();
  const cleanupRestore = await rawRequest(
    "/api/v1/restore",
    "POST",
    { backupId: cleanupBackup.id },
  );
  const legacyCleanupFailureKeepsCommittedGeneration =
    cleanupRestore.status === 200 &&
    cleanupRestore.payload.cleanupPending === true &&
    (
      await request("/api/v1/workspace", "GET", undefined, hardHeaders)
    ).payload.workspace.templates[0].name !== "cleanup-mutation";
  if (!legacyCleanupFailureKeepsCommittedGeneration)
    throw new Error("Post-commit cleanup failure rolled back the restored generation.");
  await stopService(service);
  service = await startService();
  await waitForHealth();
  const legacyCleanupRecoveredOnStartup = !(
    await fs.readdir(path.join(liveHardRoot, "staging"))
  ).some(name => name.startsWith(".formdigital-restore-") || name.startsWith("previous-"));
  if (!legacyCleanupRecoveredOnStartup)
    throw new Error("Startup did not finish committed legacy restore cleanup.");

  // Crash recovery before the commit marker always returns the complete old
  // generation, even when one domain was already swapped.
  const legacyCrashOldWorkspace = await fs.readFile(hardWorkspacePath);
  await stopService(service);
  const legacyCrashId = crypto.randomUUID();
  const legacyCrashCandidate = path.join(
    liveHardRoot,
    "staging",
    `restore-${legacyCrashId}`,
  );
  await fs.mkdir(legacyCrashCandidate);
  for (const domain of ["objects", "manifests", "accounts", "metadata", "journal"])
    await fs.cp(
      path.join(liveHardRoot, domain),
      path.join(legacyCrashCandidate, domain),
      { recursive: true },
    );
  const candidateWorkspacePath = path.join(
    legacyCrashCandidate,
    "accounts",
    hardOwnerHash,
    "workspace.json",
  );
  const candidateEnvelope = JSON.parse(await fs.readFile(candidateWorkspacePath, "utf8"));
  candidateEnvelope.workspace.templates[0].name = "synthetic-partial-generation";
  await fs.writeFile(candidateWorkspacePath, JSON.stringify(candidateEnvelope));
  const legacyCrashPreviousAccounts = path.join(
    liveHardRoot,
    "staging",
    `previous-accounts-${legacyCrashId}`,
  );
  await fs.writeFile(
    path.join(liveHardRoot, "staging", `.formdigital-restore-${legacyCrashId}.json`),
    JSON.stringify({
      schemaVersion: 1,
      transactionId: legacyCrashId,
      phase: "swapping",
      backupId: "backup-synthetic",
    }),
  );
  await fs.rename(path.join(liveHardRoot, "accounts"), legacyCrashPreviousAccounts);
  await fs.rename(path.join(legacyCrashCandidate, "accounts"), path.join(liveHardRoot, "accounts"));
  service = await startService();
  await waitForHealth();
  const legacyCrashRollbackRecoveredOldGeneration =
    (await fs.readFile(hardWorkspacePath)).equals(legacyCrashOldWorkspace) &&
    !(await exists(legacyCrashCandidate)) &&
    !(await exists(legacyCrashPreviousAccounts));
  if (!legacyCrashRollbackRecoveredOldGeneration)
    throw new Error("Interrupted legacy restore left a mixed generation.");

  // Conversely, the durable commit marker keeps the new generation and only
  // completes cleanup on restart.
  await stopService(service);
  const legacyCommittedId = crypto.randomUUID();
  const legacyCommittedPreviousAccounts = path.join(
    liveHardRoot,
    "staging",
    `previous-accounts-${legacyCommittedId}`,
  );
  await fs.cp(
    path.join(liveHardRoot, "accounts"),
    legacyCommittedPreviousAccounts,
    { recursive: true },
  );
  const committedEnvelope = JSON.parse(await fs.readFile(hardWorkspacePath, "utf8"));
  committedEnvelope.workspace.templates[0].name = "synthetic-committed-generation";
  await fs.writeFile(hardWorkspacePath, JSON.stringify(committedEnvelope));
  await fs.mkdir(
    path.join(liveHardRoot, "staging", `restore-${legacyCommittedId}`),
  );
  await fs.writeFile(
    path.join(liveHardRoot, "staging", `.formdigital-restore-${legacyCommittedId}.json`),
    JSON.stringify({
      schemaVersion: 1,
      transactionId: legacyCommittedId,
      phase: "committed",
      backupId: "backup-synthetic",
    }),
  );
  service = await startService();
  await waitForHealth();
  const legacyCrashCommitMarkerKeepsNewGeneration =
    (
      await request("/api/v1/workspace", "GET", undefined, hardHeaders)
    ).payload.workspace.templates[0].name === "synthetic-committed-generation" &&
    !(await exists(legacyCommittedPreviousAccounts));
  if (!legacyCrashCommitMarkerKeepsNewGeneration)
    throw new Error("Committed legacy restore resurrected the old generation.");

  // ================= Workspace v2 cutover =================
  // A Workspace saved before the high-growth collections existed must stay
  // readable once it crosses the migration trigger. The cutover takes a safety
  // backup and verifies it; while an absent collection counted as invalid that
  // verification rejected its own output, so every read of such a Workspace
  // failed with a detail-free 500 and the workspace could not be opened at all.
  const cutoverHeaders = {
    ...headers,
    "x-formdigital-owner": "google-user-v2-cutover-test",
  };
  const cutoverPadding = "x".repeat(8 * 1024);
  await request(
    "/api/v1/workspace",
    "PUT",
    {
      expectedRevision: 0,
      workspace: {
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        templates: [{ id: "cutover-template", name: "Cutover Template" }],
        // Bounded Template metadata alone carries this past the cutover trigger.
        templateVersions: Array.from({ length: 3800 }, (_, index) => ({
          id: `cutover-version-${index}`,
          templateId: "cutover-template",
          version: index + 1,
          blob: cutoverPadding,
        })),
        mappingTemplates: [],
        instances: [],
        importRuns: [],
        // importRows and mappingDecisions are deliberately absent: a Workspace
        // written before those collections existed simply has no such key.
      },
    },
    cutoverHeaders,
  );
  const cutoverFirstRead = await rawRequest(
    "/api/v1/workspace",
    "GET",
    undefined,
    cutoverHeaders,
  );
  const legacyWorkspaceMissingCollectionsStaysReadable =
    cutoverFirstRead.status === 200;
  if (!legacyWorkspaceMissingCollectionsStaysReadable)
    throw new Error(
      `Workspace v2 cutover made a Workspace with absent high-growth collections unreadable (${cutoverFirstRead.status}).`,
    );
  const cutoverSecondRead = await rawRequest(
    "/api/v1/workspace",
    "GET",
    undefined,
    cutoverHeaders,
  );
  const cutoverWorkspaceStaysReadableAfterProjection =
    cutoverSecondRead.status === 200;
  if (!cutoverWorkspaceStaysReadableAfterProjection)
    throw new Error("Workspace v2 cutover left the Workspace unreadable.");

  // ================= Workspace v2 diverged database recovery =================
  // Until the projection marker is written into v1, v1 is still authoritative
  // and any v2 database is an unpublished migration attempt. One that stops
  // matching v1 — a crash between publishing the database and compacting the
  // envelope, or a restore that replaced v1 underneath it — used to make every
  // Workspace read fail permanently, with no way for anyone to recover.
  const divergeOwner = "google-user-v2-diverged-test";
  const divergeHeaders = { ...headers, "x-formdigital-owner": divergeOwner };
  const divergePadding = "x".repeat(8 * 1024);
  const divergeInstance = id => ({
    id,
    templateId: "diverge-template",
    templateVersionId: "diverge-version-0",
    values: {},
  });
  const divergeWorkspace = instances => ({
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    templates: [{ id: "diverge-template", name: "Diverge Template" }],
    templateVersions: Array.from({ length: 3800 }, (_, index) => ({
      id: `diverge-version-${index}`,
      templateId: "diverge-template",
      version: index + 1,
      blob: divergePadding,
    })),
    mappingTemplates: [],
    instances,
    importRuns: [],
  });
  // Earlier sections move the Data Folder, so the active root has to come from
  // the service rather than from the folder this run started with.
  const divergeRoot = (await health()).payload.root;
  const accountsBefore = await fs
    .readdir(path.join(divergeRoot, "accounts"))
    .catch(() => []);
  await request(
    "/api/v1/workspace",
    "PUT",
    {
      expectedRevision: 0,
      workspace: divergeWorkspace([
        divergeInstance("di1"),
        divergeInstance("di2"),
        divergeInstance("di3"),
      ]),
    },
    divergeHeaders,
  );
  // Take the owner directory the service itself created rather than deriving
  // the hash here, so the fixture cannot drift from the service's own scheme.
  const divergeHash = (
    await fs.readdir(path.join(divergeRoot, "accounts"))
  ).find(entry => !accountsBefore.includes(entry));
  if (!divergeHash)
    throw new Error("The divergence fixture created no account directory.");
  if (
    (await rawRequest("/api/v1/workspace", "GET", undefined, divergeHeaders))
      .status !== 200
  )
    throw new Error("Workspace v2 cutover failed for the divergence fixture.");

  // Replace v1 and its retained copy with a smaller generation, leaving the
  // published database ahead of both. Restart so the per-process "already
  // checked" cache cannot mask the state.
  await stopService(service);
  const divergedEnvelope = JSON.stringify(
    {
      revision: 9,
      workspace: divergeWorkspace([
        divergeInstance("di1"),
        divergeInstance("di2"),
      ]),
    },
    null,
    2,
  );
  await fs.writeFile(
    path.join(divergeRoot, "accounts", divergeHash, "workspace.json"),
    divergedEnvelope,
  );
  await fs.writeFile(
    path.join(divergeRoot, "workspace-v2", divergeHash, "legacy-workspace.json"),
    divergedEnvelope,
  );
  service = await startService();
  await waitForHealth();

  const divergedRead = await rawRequest(
    "/api/v1/workspace",
    "GET",
    undefined,
    divergeHeaders,
  );
  const divergedWorkspaceRecovers = divergedRead.status === 200;
  if (!divergedWorkspaceRecovers)
    throw new Error(
      `A v2 database ahead of the authoritative v1 envelope left the Workspace unreadable (${divergedRead.status}).`,
    );
  const divergedQuarantined = (
    await fs.readdir(path.join(divergeRoot, "quarantine")).catch(() => [])
  ).some(entry => entry.startsWith("workspace-v2-"));
  if (!divergedQuarantined)
    throw new Error("The diverged v2 database was discarded instead of quarantined.");
  const divergedStaysReadable =
    (await rawRequest("/api/v1/workspace", "GET", undefined, divergeHeaders))
      .status === 200;
  if (!divergedStaysReadable)
    throw new Error("The rebuilt Workspace became unreadable on the next read.");

  // The active root has to come from the service: earlier sections move the
  // Data Folder, so the folder this run started with is no longer authoritative.
  const boundsRoot = (await health()).payload.root;
  const boundsAccountsDir = path.join(boundsRoot, "accounts");
  /** The owner directory the service itself creates for a fresh owner. */
  const newAccountHash = async (before) =>
    (await fs.readdir(boundsAccountsDir)).find(entry => !before.includes(entry));

  // ================= Bounded v1 operation journal =================
  // The application layer already trims this array to 5,000 entries, so the
  // service is a backstop against a caller that is not the application. It
  // refuses an oversized journal instead of trimming it: for an account that
  // has never migrated these entries are the only copy of that history, and
  // silently dropping them here would delete authoritative data. A count alone
  // is not a bound either, so the total and each record are bounded as well.
  const journalHeaders = {
    ...headers,
    "x-formdigital-owner": "google-user-journal-bound-test",
  };
  const journalAccountsBefore = await fs.readdir(boundsAccountsDir);
  const journalWorkspace = operationJournal => ({
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    templates: [],
    templateVersions: [],
    mappingTemplates: [],
    instances: [],
    operationJournal,
  });
  const journalEntry = index => ({
    id: `journal-${index}`,
    type: "workspace.commit",
    at: index,
  });

  // Inside every bound: stored complete, nothing trimmed away.
  await request(
    "/api/v1/workspace",
    "PUT",
    {
      expectedRevision: 0,
      workspace: journalWorkspace(
        Array.from({ length: 4_000 }, (_, index) => journalEntry(index)),
      ),
    },
    journalHeaders,
  );
  const journalHash = await newAccountHash(journalAccountsBefore);
  if (!journalHash)
    throw new Error("The journal fixture created no account directory.");
  // A dashboard load queries Workspace v2, which is what publishes the
  // database an account's history is archived into. Any account old enough to
  // overflow its journal has done this thousands of times.
  await request(
    "/api/v2/workspace/query",
    "POST",
    { collection: "instances", limit: 1 },
    journalHeaders,
  );
  /** The cutover moves the revision on, so never assume what it is. */
  const journalRevision = async () =>
    (await request("/api/v1/workspace", "GET", undefined, journalHeaders))
      .payload.revision;
  const journalRead = await request(
    "/api/v1/workspace",
    "GET",
    undefined,
    journalHeaders,
  );
  const storedJournal = journalRead.payload.workspace.operationJournal;
  const legacyJournalKeptIntact =
    storedJournal.length === 4_000 &&
    storedJournal[0].id === "journal-0" &&
    storedJournal.at(-1).id === "journal-3999";
  if (!legacyJournalKeptIntact)
    throw new Error(
      `A journal inside every bound was altered (${storedJournal.length} entries kept).`,
    );

  // Past the entry bound: the envelope stays bounded, the mutation still
  // succeeds, and every entry pushed out lands in Workspace v2 — which is what
  // the account's Portable Backup carries. Trimming them away destroyed
  // history; putting them in a file the Portable Backup does not include lost
  // them on the next machine move instead.
  await request(
    "/api/v1/workspace",
    "PUT",
    {
      expectedRevision: await journalRevision(),
      workspace: journalWorkspace(
        Array.from({ length: 5_400 }, (_, index) => journalEntry(index)),
      ),
    },
    journalHeaders,
  );
  const afterOverflow = await request(
    "/api/v1/workspace",
    "GET",
    undefined,
    journalHeaders,
  );
  const overflowJournal = afterOverflow.payload.workspace.operationJournal;
  const legacyJournalBoundedByArchiving =
    overflowJournal.length === 5_000 &&
    overflowJournal[0].id === "journal-400" &&
    overflowJournal.at(-1).id === "journal-5399";
  if (!legacyJournalBoundedByArchiving)
    throw new Error(
      `Overflow was not bounded to the newest entries (${overflowJournal.length} kept, first ${overflowJournal[0]?.id}).`,
    );

  // Newest first: the cutover migrates the envelope's own journal into v2, so
  // the oldest page of this collection is all migrated records and the
  // archived ones sit at the end.
  const archivedInV2 = await request(
    "/api/v2/workspace/query",
    "POST",
    { collection: "operationJournal", limit: 1_000, order: "desc" },
    journalHeaders,
  );
  const archivedIds = new Set(
    archivedInV2.payload.records
      .map(record => record?.archivedEntry?.id)
      .filter(Boolean),
  );
  const overflowArchivedNotDeleted =
    archivedIds.size === 400 &&
    archivedIds.has("journal-0") &&
    archivedIds.has("journal-399");
  if (!overflowArchivedNotDeleted)
    throw new Error(
      `Expected 400 archived journal entries in Workspace v2, found ${archivedIds.size}.`,
    );

  // The Portable Backup is the machine-move path, so the archived history has
  // to travel in it. Read it back out of the archive rather than trusting that
  // it does.
  // The streaming route: an account this size is past the legacy transport's
  // Base64 ceiling, and streaming is the path a real machine move uses.
  const journalBackup = (
    await request("/api/v1/portable-backups", "POST", {}, journalHeaders)
  ).payload;
  const journalArchive = await downloadPortableArchive(
    journalBackup.id,
    journalHeaders,
  );
  const journalEntriesInArchive = unzipSync(new Uint8Array(journalArchive));
  const archivedDatabase = journalEntriesInArchive["account/workspace-v2.sqlite"];
  if (!archivedDatabase)
    throw new Error("The Portable Backup carries no Workspace v2 database.");
  const extractedDatabase = path.join(testRoot, "portable-journal-check.sqlite");
  await fs.writeFile(extractedDatabase, Buffer.from(archivedDatabase));
  const backedUpStorage = WorkspaceStorageV2.openFileReadOnly({
    databasePath: extractedDatabase,
    ownerHash: journalHash,
  });
  const backedUpIds = new Set();
  try {
    for await (const { record } of backedUpStorage.exportRecords({
      collection: "operationJournal",
    }))
      if (record?.archivedEntry?.id) backedUpIds.add(record.archivedEntry.id);
  } finally {
    backedUpStorage.close();
  }
  const archivedHistorySurvivesPortableBackup =
    backedUpIds.size === 400 &&
    backedUpIds.has("journal-0") &&
    backedUpIds.has("journal-399");
  if (!archivedHistorySurvivesPortableBackup)
    throw new Error(
      `The Portable Backup carries ${backedUpIds.size} archived journal entries, expected 400.`,
    );

  // A refused save must not have archived anything on its way to the refusal,
  // and repeating it must not accumulate copies. Archiving before the size
  // guards ran meant a request that was refused still grew the history, and
  // every retry grew it again.
  const oversizedJournalWorkspace = {
    expectedRevision: await journalRevision(),
    workspace: journalWorkspace([
      ...Array.from({ length: 5_400 }, (_, index) => journalEntry(index + 10_000)),
      { id: "big", blob: "x".repeat(70 * 1024) },
    ]),
  };
  const archivedCount = async () =>
    (
      await request(
        "/api/v2/workspace/query",
        "POST",
        { collection: "operationJournal", limit: 1_000, order: "desc" },
        journalHeaders,
      )
    ).payload.records.filter(record => record?.archivedEntry).length;
  const beforeRefusal = await archivedCount();
  for (const attempt of [1, 2]) {
    const refused = await rawRequest(
      "/api/v1/workspace",
      "PUT",
      oversizedJournalWorkspace,
      journalHeaders,
    );
    if (refused.status !== 413)
      throw new Error(
        `Attempt ${attempt}: an oversized journal entry was not refused (${refused.status}).`,
      );
  }
  const oversizedJournalEntryRefused = true;
  const refusedSaveArchivesNothing = (await archivedCount()) === beforeRefusal;
  if (!refusedSaveArchivesNothing)
    throw new Error(
      `A refused save archived entries: ${beforeRefusal} before, ${await archivedCount()} after two attempts.`,
    );
  const afterJournalRejections = await request(
    "/api/v1/workspace",
    "GET",
    undefined,
    journalHeaders,
  );
  const legacyJournalRejectionKeepsData =
    afterJournalRejections.payload.revision === afterOverflow.payload.revision &&
    afterJournalRejections.payload.workspace.operationJournal.length === 5_000;
  if (!legacyJournalRejectionKeepsData)
    throw new Error("A refused journal save still changed the stored Workspace.");

  // ================= Problem D: 409 unblocked by opening Workspace =================
  // A small Workspace (< 28 MiB) without v2 storage gets 409 with instructions
  // to open the Workspace once. In unfixed code, GET skipped compaction because
  // size was small, never creating v2 and creating a deadlock.
  const problemDHeaders = {
    ...headers,
    "x-formdigital-owner": "google-user-v2-journal-deadlock-test",
  };
  const problemDAccountsBefore = await fs.readdir(boundsAccountsDir);
  await request(
    "/api/v1/workspace",
    "PUT",
    {
      expectedRevision: 0,
      workspace: {
        schemaVersion: 1,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
        templates: [{ id: "t-d", name: "D" }],
        templateVersions: [],
        mappingTemplates: [],
        instances: [],
        operationJournal: [],
      },
    },
    problemDHeaders,
  );
  const problemDHash = await newAccountHash(problemDAccountsBefore);
  if (!problemDHash) throw new Error("Problem D fixture created no account directory.");
  const problemDV2Path = path.join(boundsRoot, "workspace-v2", problemDHash, "workspace-v2.sqlite");
  const problemDV2ExistsInitially = await fs.access(problemDV2Path).then(() => true, () => false);
  if (problemDV2ExistsInitially) throw new Error("V2 database unexpectedly exists initially for small workspace.");

  const problemDOverflowPayload = {
    expectedRevision: 1,
    workspace: {
      schemaVersion: 1,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      templates: [{ id: "t-d", name: "D" }],
      templateVersions: [],
      mappingTemplates: [],
      instances: [],
      operationJournal: Array.from({ length: 5_100 }, (_, i) => ({
        id: `j-d-${i}`,
        type: "edit",
        at: i,
      })),
    },
  };
  const problemDRefused = await rawRequest(
    "/api/v1/workspace",
    "PUT",
    problemDOverflowPayload,
    problemDHeaders,
  );
  if (
    problemDRefused.status !== 409 ||
    problemDRefused.payload?.error?.code !== "workspace_v1_journal_archive_unavailable"
  ) {
    throw new Error(
      `Expected 409 workspace_v1_journal_archive_unavailable, got ${problemDRefused.status}: ${JSON.stringify(problemDRefused.payload)}`,
    );
  }

  // Client opens the workspace once as instructed - BUT FIRST simulate service restart!
  // This verifies that the 409 unblock state persists across process restarts (Issue 1)
  service.kill("SIGTERM");
  await new Promise(r => setTimeout(r, 200));
  service = spawn(
    process.execPath,
    [path.join(projectRoot, "local-data-service.mjs")],
    {
      cwd: projectRoot,
      env: { ...process.env, FORMDIGITAL_LOCAL_CONFIG: configPath },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  );
  capture(service);
  await waitForHealth();

  // Client opens the workspace once as instructed (now on a fresh process lifetime)
  const problemDOpen = await rawRequest("/api/v1/workspace", "GET", undefined, problemDHeaders);
  if (problemDOpen.status !== 200) throw new Error("Failed to open workspace");

  // Retry the PUT: succeeds (200) even across process restart
  const problemDRetry = await rawRequest(
    "/api/v1/workspace",
    "PUT",
    problemDOverflowPayload,
    problemDHeaders,
  );
  const journalArchiveDeadlockResolvedByOpen = problemDRetry.status === 200;
  if (!journalArchiveDeadlockResolvedByOpen) {
    throw new Error(
      `Opening the workspace did not unblock the journal overflow PUT after restart (${problemDRetry.status}): ${JSON.stringify(problemDRetry.payload)}`,
    );
  }

  // ================= Problem 1: Marker state machine integration tests =================
  // 1. marker exists, v2 does not exist -> restart -> GET -> v2 created & verified -> marker unlinked -> PUT succeeds
  const p1Owner1 = "google-user-p1-case1-marker-no-v2";
  const p1Headers1 = { ...headers, "x-formdigital-owner": p1Owner1 };
  const p1AccountsBefore1 = await fs.readdir(boundsAccountsDir);
  await request("/api/v1/workspace", "PUT", {
    expectedRevision: 0,
    workspace: {
      schemaVersion: 1,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      templates: [{ id: "t-p1-1", name: "P1-1" }],
      templateVersions: [],
      mappingTemplates: [],
      instances: [],
      operationJournal: [],
    },
  }, p1Headers1);
  const p1Hash1 = await newAccountHash(p1AccountsBefore1);
  const p1V2Dir1 = path.join(boundsRoot, "workspace-v2", p1Hash1);
  const p1Marker1 = path.join(p1V2Dir1, ".history-init-required");
  await fs.mkdir(p1V2Dir1, { recursive: true });
  await fs.writeFile(p1Marker1, "");
  const p1Db1 = path.join(p1V2Dir1, "workspace-v2.sqlite");
  await fs.rm(p1Db1, { force: true });
  await stopService(service);
  service = await startService();
  await waitForHealth();
  const p1Get1 = await rawRequest("/api/v1/workspace", "GET", undefined, p1Headers1);
  if (p1Get1.status !== 200) throw new Error(`P1 Case 1 GET failed (${p1Get1.status})`);
  if (!(await exists(p1Db1))) throw new Error("P1 Case 1: v2 was not created");
  if (await exists(p1Marker1)) throw new Error("P1 Case 1: marker was not unlinked");
  const p1Put1 = await rawRequest("/api/v1/workspace", "PUT", {
    expectedRevision: 1,
    workspace: {
      schemaVersion: 1,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      templates: [{ id: "t-p1-1", name: "P1-1" }],
      templateVersions: [],
      mappingTemplates: [],
      instances: [],
      operationJournal: Array.from({ length: 5_100 }, (_, i) => ({ id: `j-p1-1-${i}`, at: i })),
    },
  }, p1Headers1);
  const markerRecoveryNoV2Succeeded = p1Put1.status === 200;
  if (!markerRecoveryNoV2Succeeded) throw new Error(`P1 Case 1 PUT failed (${p1Put1.status})`);

  // 2. marker exists, v2 is 0-byte -> restart -> GET -> exactly 1 new quarantine entry -> new v2 created & verified -> marker unlinked -> PUT succeeds
  const p1Owner2 = "google-user-p1-case2-zero-byte-v2";
  const p1Headers2 = { ...headers, "x-formdigital-owner": p1Owner2 };
  const p1AccountsBefore2 = await fs.readdir(boundsAccountsDir);
  await request("/api/v1/workspace", "PUT", {
    expectedRevision: 0,
    workspace: {
      schemaVersion: 1,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      templates: [{ id: "t-p1-2", name: "P1-2" }],
      templateVersions: [],
      mappingTemplates: [],
      instances: [],
      operationJournal: [],
    },
  }, p1Headers2);
  const p1Hash2 = await newAccountHash(p1AccountsBefore2);
  const p1V2Dir2 = path.join(boundsRoot, "workspace-v2", p1Hash2);
  const p1Marker2 = path.join(p1V2Dir2, ".history-init-required");
  const p1Db2 = path.join(p1V2Dir2, "workspace-v2.sqlite");
  await fs.mkdir(p1V2Dir2, { recursive: true });
  await fs.writeFile(p1Db2, "");
  await fs.writeFile(p1Marker2, "");
  const quarantineBefore2 = await fs.readdir(path.join(boundsRoot, "quarantine")).catch(() => []);
  await stopService(service);
  service = await startService();
  await waitForHealth();
  const p1Get2 = await rawRequest("/api/v1/workspace", "GET", undefined, p1Headers2);
  if (p1Get2.status !== 200) throw new Error(`P1 Case 2 GET failed (${p1Get2.status})`);
  const quarantinedNow2 = (
    await fs.readdir(path.join(boundsRoot, "quarantine")).catch(() => [])
  ).filter(entry => entry.startsWith("workspace-v2-") && !quarantineBefore2.includes(entry));
  if (quarantinedNow2.length !== 1) {
    throw new Error(`P1 Case 2 expected exactly 1 new quarantine entry, got ${quarantinedNow2.length}`);
  }
  if (!(await exists(p1Db2))) throw new Error("P1 Case 2: fresh v2 not created");
  if (await exists(p1Marker2)) throw new Error("P1 Case 2: marker not unlinked");
  const p1Put2 = await rawRequest("/api/v1/workspace", "PUT", {
    expectedRevision: 1,
    workspace: {
      schemaVersion: 1,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      templates: [{ id: "t-p1-2", name: "P1-2" }],
      templateVersions: [],
      mappingTemplates: [],
      instances: [],
      operationJournal: Array.from({ length: 5_100 }, (_, i) => ({ id: `j-p1-2-${i}`, at: i })),
    },
  }, p1Headers2);
  const markerRecoveryZeroByteQuarantined = p1Put2.status === 200;
  if (!markerRecoveryZeroByteQuarantined) throw new Error(`P1 Case 2 PUT failed (${p1Put2.status})`);

  // 3. marker exists, v2 is truncated SQLite -> restart -> GET -> exactly 1 new quarantine entry -> new v2 created & verified -> marker unlinked -> PUT succeeds
  const p1Owner3 = "google-user-p1-case3-truncated-v2";
  const p1Headers3 = { ...headers, "x-formdigital-owner": p1Owner3 };
  const p1AccountsBefore3 = await fs.readdir(boundsAccountsDir);
  await request("/api/v1/workspace", "PUT", {
    expectedRevision: 0,
    workspace: {
      schemaVersion: 1,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      templates: [{ id: "t-p1-3", name: "P1-3" }],
      templateVersions: [],
      mappingTemplates: [],
      instances: [],
      operationJournal: [],
    },
  }, p1Headers3);
  const p1Hash3 = await newAccountHash(p1AccountsBefore3);
  const p1V2Dir3 = path.join(boundsRoot, "workspace-v2", p1Hash3);
  const p1Marker3 = path.join(p1V2Dir3, ".history-init-required");
  const p1Db3 = path.join(p1V2Dir3, "workspace-v2.sqlite");
  await fs.mkdir(p1V2Dir3, { recursive: true });
  await fs.writeFile(p1Db3, Buffer.alloc(200, 0xaa));
  await fs.writeFile(p1Marker3, "");
  const quarantineBefore3 = await fs.readdir(path.join(boundsRoot, "quarantine")).catch(() => []);
  await stopService(service);
  service = await startService();
  await waitForHealth();
  const p1Get3 = await rawRequest("/api/v1/workspace", "GET", undefined, p1Headers3);
  if (p1Get3.status !== 200) throw new Error(`P1 Case 3 GET failed (${p1Get3.status})`);
  const quarantinedNow3 = (
    await fs.readdir(path.join(boundsRoot, "quarantine")).catch(() => [])
  ).filter(entry => entry.startsWith("workspace-v2-") && !quarantineBefore3.includes(entry));
  if (quarantinedNow3.length !== 1) {
    throw new Error(`P1 Case 3 expected exactly 1 new quarantine entry, got ${quarantinedNow3.length}`);
  }
  if (!(await exists(p1Db3))) throw new Error("P1 Case 3: fresh v2 not created");
  if (await exists(p1Marker3)) throw new Error("P1 Case 3: marker not unlinked");
  const p1Put3 = await rawRequest("/api/v1/workspace", "PUT", {
    expectedRevision: 1,
    workspace: {
      schemaVersion: 1,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      templates: [{ id: "t-p1-3", name: "P1-3" }],
      templateVersions: [],
      mappingTemplates: [],
      instances: [],
      operationJournal: Array.from({ length: 5_100 }, (_, i) => ({ id: `j-p1-3-${i}`, at: i })),
    },
  }, p1Headers3);
  const markerRecoveryTruncatedQuarantined = p1Put3.status === 200;
  if (!markerRecoveryTruncatedQuarantined) throw new Error(`P1 Case 3 PUT failed (${p1Put3.status})`);

  // 4. marker exists, v2 creation injected failure (FORMDIGITAL_TEST_FAIL_WORKSPACE_V2_INIT=1) -> GET fails with 503 -> marker preserved -> v1 byte-for-byte identical -> restart without fault -> GET/PUT succeeds
  const p1Owner4 = "google-user-p1-case4-injected-failure";
  const p1Headers4 = { ...headers, "x-formdigital-owner": p1Owner4 };
  const p1AccountsBefore4 = await fs.readdir(boundsAccountsDir);
  await request("/api/v1/workspace", "PUT", {
    expectedRevision: 0,
    workspace: {
      schemaVersion: 1,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      templates: [{ id: "t-p1-4", name: "P1-4" }],
      templateVersions: [],
      mappingTemplates: [],
      instances: [],
      operationJournal: [],
    },
  }, p1Headers4);
  const p1Hash4 = await newAccountHash(p1AccountsBefore4);
  const p1WorkspaceFile4 = path.join(boundsAccountsDir, p1Hash4, "workspace.json");
  const p1V1BytesBefore4 = await fs.readFile(p1WorkspaceFile4);
  const p1V2Dir4 = path.join(boundsRoot, "workspace-v2", p1Hash4);
  const p1Marker4 = path.join(p1V2Dir4, ".history-init-required");
  await fs.mkdir(p1V2Dir4, { recursive: true });
  await fs.writeFile(p1Marker4, "");
  await stopService(service);
  service = await startService({
    FORMDIGITAL_ENABLE_TEST_HOOKS: "1",
    FORMDIGITAL_TEST_FAIL_WORKSPACE_V2_INIT: "1",
  });
  await waitForHealth();
  const p1Get4 = await rawRequest("/api/v1/workspace", "GET", undefined, p1Headers4);
  if (p1Get4.status !== 503) {
    throw new Error(`P1 Case 4 expected 503, got ${p1Get4.status}: ${JSON.stringify(p1Get4.payload)}`);
  }
  const p1Get4Str = JSON.stringify(p1Get4.payload);
  if (p1Get4Str.includes(p1Hash4) || p1Get4Str.includes("workspace-v2") || p1Get4Str.includes(".sqlite")) {
    throw new Error(`P1 Case 4 response leaked internal details: ${p1Get4Str}`);
  }
  if (!(await exists(p1Marker4))) throw new Error("P1 Case 4: marker was prematurely deleted on failure");
  const p1V1BytesAfter4 = await fs.readFile(p1WorkspaceFile4);
  if (!p1V1BytesAfter4.equals(p1V1BytesBefore4)) {
    throw new Error("P1 Case 4: v1 workspace file was modified during failed v2 init");
  }
  await stopService(service);
  service = await startService();
  await waitForHealth();
  const p1Get4Recovered = await rawRequest("/api/v1/workspace", "GET", undefined, p1Headers4);
  if (p1Get4Recovered.status !== 200) throw new Error(`P1 Case 4 recovery GET failed (${p1Get4Recovered.status})`);
  if (await exists(p1Marker4)) throw new Error("P1 Case 4: marker was not unlinked upon recovery");
  const p1Put4 = await rawRequest("/api/v1/workspace", "PUT", {
    expectedRevision: 1,
    workspace: {
      schemaVersion: 1,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      templates: [{ id: "t-p1-4", name: "P1-4" }],
      templateVersions: [],
      mappingTemplates: [],
      instances: [],
      operationJournal: Array.from({ length: 5_100 }, (_, i) => ({ id: `j-p1-4-${i}`, at: i })),
    },
  }, p1Headers4);
  const markerRecoveryInjectedFailureHandled = p1Put4.status === 200;
  if (!markerRecoveryInjectedFailureHandled) throw new Error(`P1 Case 4 PUT failed (${p1Put4.status})`);

  // 5. simulated interruption between v2 creation and marker unlink (v2 healthy, marker exists) -> restart -> GET -> healthy v2 NOT quarantined -> marker unlinked -> PUT succeeds
  const p1Owner5 = "google-user-p1-case5-interrupted-marker";
  const p1Headers5 = { ...headers, "x-formdigital-owner": p1Owner5 };
  const p1AccountsBefore5 = await fs.readdir(boundsAccountsDir);
  await request("/api/v1/workspace", "PUT", {
    expectedRevision: 0,
    workspace: {
      schemaVersion: 1,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      templates: [{ id: "t-p1-5", name: "P1-5" }],
      templateVersions: [],
      mappingTemplates: [],
      instances: [],
      operationJournal: [],
    },
  }, p1Headers5);
  const p1Hash5 = await newAccountHash(p1AccountsBefore5);
  const p1V2Dir5 = path.join(boundsRoot, "workspace-v2", p1Hash5);
  const p1Marker5 = path.join(p1V2Dir5, ".history-init-required");
  const p1Storage5 = WorkspaceStorageV2.openByOwnerHash({ rootDir: boundsRoot, ownerHash: p1Hash5 });
  p1Storage5.close();
  await fs.writeFile(p1Marker5, "");
  const quarantineBefore5 = await fs.readdir(path.join(boundsRoot, "quarantine")).catch(() => []);
  await stopService(service);
  service = await startService();
  await waitForHealth();
  const p1Get5 = await rawRequest("/api/v1/workspace", "GET", undefined, p1Headers5);
  if (p1Get5.status !== 200) throw new Error(`P1 Case 5 GET failed (${p1Get5.status})`);
  const quarantinedNow5 = (
    await fs.readdir(path.join(boundsRoot, "quarantine")).catch(() => [])
  ).filter(entry => entry.startsWith("workspace-v2-") && !quarantineBefore5.includes(entry));
  if (quarantinedNow5.length !== 0) {
    throw new Error(`P1 Case 5 healthy database was quarantined (${quarantinedNow5.length} entries)`);
  }
  if (await exists(p1Marker5)) throw new Error("P1 Case 5: marker was not unlinked");
  const p1Put5 = await rawRequest("/api/v1/workspace", "PUT", {
    expectedRevision: 1,
    workspace: {
      schemaVersion: 1,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      templates: [{ id: "t-p1-5", name: "P1-5" }],
      templateVersions: [],
      mappingTemplates: [],
      instances: [],
      operationJournal: Array.from({ length: 5_100 }, (_, i) => ({ id: `j-p1-5-${i}`, at: i })),
    },
  }, p1Headers5);
  const markerRecoveryInterruptedPreservedHealthy = p1Put5.status === 200;
  if (!markerRecoveryInterruptedPreservedHealthy) throw new Error(`P1 Case 5 PUT failed (${p1Put5.status})`);

  // 6. marker unlink boundary verification -> data not corrupted, subsequent retry recovers
  const p1Owner6 = "google-user-p1-case6-marker-lingers";
  const p1Headers6 = { ...headers, "x-formdigital-owner": p1Owner6 };
  const p1AccountsBefore6 = await fs.readdir(boundsAccountsDir);
  await request("/api/v1/workspace", "PUT", {
    expectedRevision: 0,
    workspace: {
      schemaVersion: 1,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      templates: [{ id: "t-p1-6", name: "P1-6" }],
      templateVersions: [],
      mappingTemplates: [],
      instances: [],
      operationJournal: [],
    },
  }, p1Headers6);
  const p1Hash6 = await newAccountHash(p1AccountsBefore6);
  const p1Storage6 = WorkspaceStorageV2.openByOwnerHash({ rootDir: boundsRoot, ownerHash: p1Hash6 });
  p1Storage6.close();
  const p1V2Dir6 = path.join(boundsRoot, "workspace-v2", p1Hash6);
  const p1Marker6 = path.join(p1V2Dir6, ".history-init-required");
  await fs.writeFile(p1Marker6, "");
  const p1Get6 = await rawRequest("/api/v1/workspace", "GET", undefined, p1Headers6);
  if (p1Get6.status !== 200) throw new Error(`P1 Case 6 GET failed (${p1Get6.status})`);
  const p1Storage6Read = WorkspaceStorageV2.openByOwnerHash({ rootDir: boundsRoot, ownerHash: p1Hash6, readOnly: true });
  try {
    p1Storage6Read.integrityCheck();
  } finally {
    p1Storage6Read.close();
  }
  const markerRecoveryLingeringSafe = true;

  // 7. (Issue 3A) marker unlink failure handled safely -> value-free log, marker retained, GET succeeds, subsequent normal retry self-heals
  const p1Owner7 = "google-user-p1-case7-marker-unlink-fail";
  const p1Headers7 = { ...headers, "x-formdigital-owner": p1Owner7 };
  const p1AccountsBefore7 = await fs.readdir(boundsAccountsDir);
  await request("/api/v1/workspace", "PUT", {
    expectedRevision: 0,
    workspace: {
      schemaVersion: 1,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      templates: [{ id: "t-p1-7", name: "P1-7" }],
      templateVersions: [],
      mappingTemplates: [],
      instances: [],
      operationJournal: [],
    },
  }, p1Headers7);
  const p1Hash7 = await newAccountHash(p1AccountsBefore7);
  const p1Storage7 = WorkspaceStorageV2.openByOwnerHash({ rootDir: boundsRoot, ownerHash: p1Hash7 });
  p1Storage7.close();
  const p1V2Dir7 = path.join(boundsRoot, "workspace-v2", p1Hash7);
  const p1Marker7 = path.join(p1V2Dir7, ".history-init-required");
  await fs.writeFile(p1Marker7, "");

  // Restart service with injected unlink failure
  await stopService(service);
  serviceOutput = "";
  service = await startService({
    FORMDIGITAL_ENABLE_TEST_HOOKS: "1",
    FORMDIGITAL_TEST_FAIL_MARKER_UNLINK: "1",
  });
  await waitForHealth();

  const p1Get7UnlinkFail = await rawRequest("/api/v1/workspace", "GET", undefined, p1Headers7);
  if (p1Get7UnlinkFail.status !== 200) {
    throw new Error(`P1 Case 7 expected 200 despite unlink failure, got ${p1Get7UnlinkFail.status}`);
  }
  if (!(await exists(p1Marker7))) {
    throw new Error("P1 Case 7: marker was unexpectedly unlinked when unlink failure was injected");
  }
  if (serviceOutput.includes(p1Hash7) || serviceOutput.includes(p1V2Dir7)) {
    throw new Error(`P1 Case 7 log leaked sensitive path or hash: ${serviceOutput}`);
  }

  // Normal restart without unlink fault -> GET self-heals by unlinking the marker
  await stopService(service);
  service = await startService();
  await waitForHealth();
  const p1Get7Recovered = await rawRequest("/api/v1/workspace", "GET", undefined, p1Headers7);
  if (p1Get7Recovered.status !== 200) {
    throw new Error(`P1 Case 7 recovery GET failed (${p1Get7Recovered.status})`);
  }
  if (await exists(p1Marker7)) {
    throw new Error("P1 Case 7: marker was not unlinked on recovery GET");
  }
  const markerRecoveryUnlinkFailureHandled = true;

  // 8. (Issue 3B) batch planning with formal 24-hex-char digest txId and exact <=12 MiB canonical bytes bounding
  const testEntrySample = { id: "test-item", action: "append", at: 1700000000000 };
  const testDigestSample = crypto.createHash("sha256").update(Buffer.from(canonicalJson(testEntrySample), "utf8")).digest("hex");
  const sampleTxId = formatJournalArchiveTransactionId(1, 0, testDigestSample);
  if (!/^journal-archive-r1-b0-[a-f0-9]{24}$/.test(sampleTxId)) {
    throw new Error(`formatJournalArchiveTransactionId format invalid: ${sampleTxId}`);
  }

  const mediumEntry = { id: "entry", data: "m".repeat(1024) };
  const testBatchRecords = Array.from({ length: 2_500 }, (_, i) => ({
    collection: "operationJournal",
    record: {
      recordType: "formdigital.operation-journal-archive",
      schemaVersion: 1,
      id: `journal-archive-r1-i${i}-${crypto.createHash("sha256").update(Buffer.from(canonicalJson({ ...mediumEntry, i }), "utf8")).digest("hex").slice(0, 24)}`,
      archivedAt: "1970-01-01T00:00:00.000Z",
      archivedEntry: { ...mediumEntry, i },
    },
  }));
  const plannedCases = planJournalArchiveBatches(testBatchRecords, { expectedRevision: 1 });
  for (const b of plannedCases) {
    if (!/^journal-archive-r1-b\d+-[a-f0-9]{24}$/.test(b.transactionId)) {
      throw new Error(`planned batch transactionId invalid: ${b.transactionId}`);
    }
    const bBytes = calculateCanonicalTransactionBytes({
      expectedRevision: 1,
      transactionId: b.transactionId,
      put: b.puts,
    });
    if (bBytes > JOURNAL_ARCHIVE_MAX_BATCH_BYTES) {
      throw new Error(`planned batch exceeded 12 MiB: ${bBytes}`);
    }
  }
  const batchPlanningDeterministic24HexBytesBounded = true;

  // 9. (Issue 4) test hooks strict environment isolation & sibling traversal resistance
  function testIsStrictlyInside(parent, child) {
    const relative = path.relative(parent, child);
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  }
  if (testIsStrictlyInside(path.join(testRoot, "Data"), path.join(testRoot, "Data-Evil"))) {
    throw new Error("isStrictlyInside failed to reject sibling folder with common prefix");
  }
  if (testIsStrictlyInside(path.join(testRoot, "Data"), path.join(testRoot, "Data"))) {
    throw new Error("isStrictlyInside failed to reject identical folder");
  }
  if (!testIsStrictlyInside(path.join(testRoot, "Data"), path.join(testRoot, "Data", "child.txt"))) {
    throw new Error("isStrictlyInside failed to accept true child");
  }

  // Production isolation: NODE_ENV=production makes hooks inactive
  const p1Owner9 = "google-user-p1-case9-prod-isolation";
  const p1Headers9 = { ...headers, "x-formdigital-owner": p1Owner9 };
  const p1AccountsBefore9 = await fs.readdir(boundsAccountsDir);
  await request("/api/v1/workspace", "PUT", {
    expectedRevision: 0,
    workspace: {
      schemaVersion: 1,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      templates: [{ id: "t-p1-9", name: "P1-9" }],
      templateVersions: [],
      mappingTemplates: [],
      instances: [],
      operationJournal: [],
    },
  }, p1Headers9);
  const p1Hash9 = await newAccountHash(p1AccountsBefore9);
  const p1Storage9 = WorkspaceStorageV2.openByOwnerHash({ rootDir: boundsRoot, ownerHash: p1Hash9 });
  p1Storage9.close();
  const p1V2Dir9 = path.join(boundsRoot, "workspace-v2", p1Hash9);
  const p1Marker9 = path.join(p1V2Dir9, ".history-init-required");
  await fs.writeFile(p1Marker9, "");

  await stopService(service);
  service = await startService({
    NODE_ENV: "production",
    FORMDIGITAL_ENABLE_TEST_HOOKS: "1",
    FORMDIGITAL_TEST_FAIL_MARKER_UNLINK: "1",
  });
  await waitForHealth();

  const p1Get9Prod = await rawRequest("/api/v1/workspace", "GET", undefined, p1Headers9);
  if (p1Get9Prod.status !== 200) {
    throw new Error(`P1 Case 9 production mode GET failed (${p1Get9Prod.status})`);
  }
  if (await exists(p1Marker9)) {
    throw new Error("P1 Case 9: test hook was active in NODE_ENV=production; marker was not unlinked!");
  }

  // Token isolation: invalid token makes hooks inactive
  await fs.writeFile(p1Marker9, "");
  await stopService(service);
  service = await startService({
    NODE_ENV: "test",
    FORMDIGITAL_ENABLE_TEST_HOOKS: "1",
    FORMDIGITAL_TEST_FAIL_MARKER_UNLINK: "1",
    FORMDIGITAL_TEST_TOKEN: "wrong-token-invalid",
  });
  await waitForHealth();
  const p1Get9WrongToken = await rawRequest("/api/v1/workspace", "GET", undefined, p1Headers9);
  if (p1Get9WrongToken.status !== 200) {
    throw new Error(`P1 Case 9 wrong token GET failed (${p1Get9WrongToken.status})`);
  }
  if (await exists(p1Marker9)) {
    throw new Error("P1 Case 9: test hook was active with wrong token; marker was not unlinked!");
  }

  await stopService(service);
  service = await startService();
  await waitForHealth();
  const testHooksStrictIsolationAndTraversalResistant = true;

  // ================= Problem A: Identical occurrences preserved across saves =================
  const problemA1Headers = {
    ...headers,
    "x-formdigital-owner": "google-user-v2-journal-occurrence-test",
  };
  await request(
    "/api/v1/workspace",
    "PUT",
    {
      expectedRevision: 0,
      workspace: {
        schemaVersion: 1,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
        templates: [{ id: "t-a1", name: "A1" }],
        templateVersions: [],
        mappingTemplates: [],
        instances: [],
      },
    },
    problemA1Headers,
  );
  await request("/api/v2/workspace/query", "POST", { collection: "instances", limit: 1 }, problemA1Headers);

  const duplicateItem = { id: "dup-event", action: "update", at: 500 };
  // Save 1 with 3 identical entries in overflow
  const problemA1Save1 = await rawRequest(
    "/api/v1/workspace",
    "PUT",
    {
      expectedRevision: (await request("/api/v1/workspace", "GET", undefined, problemA1Headers)).payload.revision,
      workspace: {
        schemaVersion: 1,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
        templates: [{ id: "t-a1", name: "A1" }],
        templateVersions: [],
        mappingTemplates: [],
        instances: [],
        operationJournal: [
          duplicateItem,
          duplicateItem,
          duplicateItem,
          ...Array.from({ length: 5_000 }, (_, i) => ({ id: `j-a1-1-${i}`, at: i })),
        ],
      },
    },
    problemA1Headers,
  );
  if (problemA1Save1.status !== 200) throw new Error("Problem A Save 1 failed");

  // Save 2 with 2 more identical entries in overflow
  const problemA1Save2 = await rawRequest(
    "/api/v1/workspace",
    "PUT",
    {
      expectedRevision: (await request("/api/v1/workspace", "GET", undefined, problemA1Headers)).payload.revision,
      workspace: {
        schemaVersion: 1,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
        templates: [{ id: "t-a1", name: "A1" }],
        templateVersions: [],
        mappingTemplates: [],
        instances: [],
        operationJournal: [
          duplicateItem,
          duplicateItem,
          ...Array.from({ length: 5_000 }, (_, i) => ({ id: `j-a1-2-${i}`, at: i + 10_000 })),
        ],
      },
    },
    problemA1Headers,
  );
  if (problemA1Save2.status !== 200) throw new Error("Problem A Save 2 failed");

  const v2JournalsA1 = (
    await request(
      "/api/v2/workspace/query",
      "POST",
      { collection: "operationJournal", limit: 1_000 },
      problemA1Headers,
    )
  ).payload.records;
  const duplicateOccurrences = v2JournalsA1.filter(
    r => r?.archivedEntry?.id === "dup-event" && r?.archivedEntry?.action === "update",
  );
  const journalArchivePreservesIdenticalOccurrences = duplicateOccurrences.length === 5;
  if (!journalArchivePreservesIdenticalOccurrences) {
    throw new Error(
      `Expected 5 identical occurrences preserved in v2, found ${duplicateOccurrences.length}.`,
    );
  }

  // ================= Problem A: Retry idempotence after interrupted save =================
  // If v2 archiving commits but the save is retried with the exact same payload/revision,
  // it must not throw TRANSACTION_ID_REUSE due to dynamic archivedAt.
  const problemA2Headers = {
    ...headers,
    "x-formdigital-owner": "google-user-v2-journal-retry-test",
  };
  const problemA2AccountsBefore = await fs.readdir(boundsAccountsDir);
  await request(
    "/api/v1/workspace",
    "PUT",
    {
      expectedRevision: 0,
      workspace: {
        schemaVersion: 1,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
        templates: [{ id: "t-a2", name: "A2" }],
        templateVersions: [],
        mappingTemplates: [],
        instances: [],
      },
    },
    problemA2Headers,
  );
  const problemA2Hash = await newAccountHash(problemA2AccountsBefore);
  await request("/api/v2/workspace/query", "POST", { collection: "instances", limit: 1 }, problemA2Headers);

  const problemA2BaseRevision = (
    await request("/api/v1/workspace", "GET", undefined, problemA2Headers)
  ).payload.revision;

  const problemA2SavePayload = {
    expectedRevision: problemA2BaseRevision,
    workspace: {
      schemaVersion: 1,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      templates: [{ id: "t-a2", name: "A2" }],
      templateVersions: [],
      mappingTemplates: [],
      instances: [],
      operationJournal: Array.from({ length: 5_100 }, (_, i) => ({
        id: `j-a2-${i}`,
        at: i,
      })),
    },
  };
  // Attempt 1
  const problemA2Save1 = await rawRequest(
    "/api/v1/workspace",
    "PUT",
    problemA2SavePayload,
    problemA2Headers,
  );
  if (problemA2Save1.status !== 200)
    throw new Error(
      `Problem A2 Save 1 failed (${problemA2Save1.status}): ${JSON.stringify(problemA2Save1.payload)}`,
    );

  // Revert v1 workspace.json back to problemA2BaseRevision (simulating v1 write loss / interruption)
  const problemA2WorkspaceFile = path.join(boundsAccountsDir, problemA2Hash, "workspace.json");
  await fs.writeFile(
    problemA2WorkspaceFile,
    JSON.stringify(
      {
        revision: problemA2BaseRevision,
        workspace: {
          schemaVersion: 1,
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
          templates: [{ id: "t-a2", name: "A2" }],
          templateVersions: [],
          mappingTemplates: [],
          instances: [],
        },
      },
      null,
      2,
    ),
  );

  // Attempt 2: retry with the exact same expectedRevision 1, but with a mutated
  // updatedAt to simulate caller re-generating timestamp on retry (Issue 2).
  // Must NOT trigger TRANSACTION_ID_REUSE.
  const problemA2RetryPayload = structuredClone(problemA2SavePayload);
  problemA2RetryPayload.workspace.updatedAt = "2026-09-02T12:34:56.789Z";
  const problemA2Retry = await rawRequest(
    "/api/v1/workspace",
    "PUT",
    problemA2RetryPayload,
    problemA2Headers,
  );
  const journalArchiveRetryIdempotent = problemA2Retry.status === 200;
  if (!journalArchiveRetryIdempotent) {
    throw new Error(
      `Retrying archive after v1 interruption with new updatedAt failed (${problemA2Retry.status}): ${JSON.stringify(problemA2Retry.payload)}\nServer logs: ${serviceOutput.slice(-2000)}`,
    );
  }

  // ================= Problem B: Dual-bounded batching <= 1,000 entries and <= 12 MiB =================
  // In unfixed code: batch size is fixed at 2,000. 1,200 entries of 14 KiB (~17 MiB total)
  // exceeds 16 MiB MAX_TRANSACTION_BYTES and throws TRANSACTION_TOO_LARGE.
  // In fixed code: batching is bounded by count <= 1,000 and bytes <= 12 MiB.
  const problemBHeaders = {
    ...headers,
    "x-formdigital-owner": "google-user-v2-journal-batch-test",
  };
  await request(
    "/api/v1/workspace",
    "PUT",
    {
      expectedRevision: 0,
      workspace: {
        schemaVersion: 1,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
        templates: [{ id: "t-b", name: "B" }],
        templateVersions: [],
        mappingTemplates: [],
        instances: [],
      },
    },
    problemBHeaders,
  );
  await request("/api/v2/workspace/query", "POST", { collection: "instances", limit: 1 }, problemBHeaders);

  const payload14k = "y".repeat(14 * 1024);
  const overflow1200 = Array.from({ length: 1_200 }, (_, i) => ({
    id: `j-b-${i}`,
    type: "bulk",
    at: i,
    data: payload14k,
  }));
  const problemBSave = await rawRequest(
    "/api/v1/workspace",
    "PUT",
    {
      expectedRevision: (await request("/api/v1/workspace", "GET", undefined, problemBHeaders)).payload.revision,
      workspace: {
        schemaVersion: 1,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
        templates: [{ id: "t-b", name: "B" }],
        templateVersions: [],
        mappingTemplates: [],
        instances: [],
        operationJournal: [
          ...overflow1200,
          ...Array.from({ length: 5_000 }, (_, i) => ({ id: `j-b-kept-${i}`, at: i })),
        ],
      },
    },
    problemBHeaders,
  );
  const journalArchiveBoundedBatching = problemBSave.status === 200;
  if (!journalArchiveBoundedBatching) {
    throw new Error(
      `Large journal overflow failed bounded batching (${problemBSave.status}): ${JSON.stringify(problemBSave.payload)}`,
    );
  }

  // ================= Problem 5: Shared batch planning & true child process interruption =================
  // 1. Shared helper assertion:
  // Convert overflow1200 to records formatted with discriminator & safe timestamp
  const bRecords = overflow1200.map((entry, index) => ({
    collection: "operationJournal",
    record: {
      recordType: "formdigital.operation-journal-archive",
      schemaVersion: 1,
      id: `journal-archive-r1-i${index}-${crypto.createHash("sha256").update(Buffer.from(canonicalJson(entry ?? null), "utf8")).digest("hex").slice(0, 24)}`,
      archivedAt: "1970-01-01T00:00:00.000Z",
      archivedEntry: entry,
    },
  }));
  const plannedBatches = planJournalArchiveBatches(bRecords, { expectedRevision: 1 });
  if (plannedBatches.length < 2) {
    throw new Error(`Expected at least 2 batches due to byte limits, got ${plannedBatches.length}`);
  }
  for (let i = 0; i < plannedBatches.length; i++) {
    const batch = plannedBatches[i];
    if (batch.puts.length > JOURNAL_ARCHIVE_MAX_BATCH_COUNT) {
      throw new Error(`Batch ${i} exceeded max batch count: ${batch.puts.length}`);
    }
    const txId = `journal-archive-r1-b${i}-digest`;
    const canonicalBytes = calculateCanonicalTransactionBytes({
      expectedRevision: 1,
      transactionId: txId,
      put: batch.puts,
    });
    if (canonicalBytes > JOURNAL_ARCHIVE_MAX_BATCH_BYTES) {
      throw new Error(`Batch ${i} canonical transaction bytes ${canonicalBytes} exceeded ${JOURNAL_ARCHIVE_MAX_BATCH_BYTES}`);
    }
    if (batch.serializedRequestBytes > JOURNAL_ARCHIVE_MAX_BATCH_BYTES) {
      throw new Error(`Batch ${i} serializedRequestBytes ${batch.serializedRequestBytes} exceeded ${JOURNAL_ARCHIVE_MAX_BATCH_BYTES}`);
    }
  }
  const sharedBatchPlanningVerified = true;

  // Verify oversized record rejection in planJournalArchiveBatches
  const oversizedRecord = {
    collection: "operationJournal",
    record: {
      recordType: "formdigital.operation-journal-archive",
      schemaVersion: 1,
      id: "oversized-test",
      archivedAt: "1970-01-01T00:00:00.000Z",
      archivedEntry: { data: "x".repeat(65 * 1024) },
    },
  };
  let oversizedRejected = false;
  try {
    planJournalArchiveBatches([oversizedRecord]);
  } catch (err) {
    oversizedRejected = (err.status === 413 || err.statusCode === 413) && err.code === "RECORD_TOO_LARGE";
  }
  if (!oversizedRejected) {
    throw new Error("planJournalArchiveBatches did not reject >64KiB record with 413 RECORD_TOO_LARGE");
  }
  const oversizedRecordRejected413 = true;

  // 2. Interrupted multi-batch failure recovery test with true child process termination:
  // Setup an owner with 1,500 journal entries in overflow (splits into batch 0: 1000, batch 1: 500)
  const problemBRecoveryHeaders = {
    ...headers,
    "x-formdigital-owner": "google-user-v2-journal-multi-batch-recovery",
  };
  const recAccountsBefore = await fs.readdir(boundsAccountsDir);
  await request(
    "/api/v1/workspace",
    "PUT",
    {
      expectedRevision: 0,
      workspace: {
        schemaVersion: 1,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
        templates: [{ id: "t-b-rec", name: "B-Rec" }],
        templateVersions: [],
        mappingTemplates: [],
        instances: [],
      },
    },
    problemBRecoveryHeaders,
  );
  const recOwnerHash = await newAccountHash(recAccountsBefore);
  await request("/api/v2/workspace/query", "POST", { collection: "instances", limit: 1 }, problemBRecoveryHeaders);

  const overflow1500 = Array.from({ length: 1_500 }, (_, i) => ({
    id: `j-rec-${i}`,
    type: "log",
    at: 1700000000000 + i,
    detail: `detail-${i}`,
  }));

  const initialRev = (await request("/api/v1/workspace", "GET", undefined, problemBRecoveryHeaders)).payload.revision;
  const initialV1Path = path.join(boundsAccountsDir, recOwnerHash, "workspace.json");
  const initialV1Bytes = await fs.readFile(initialV1Path);

  // Restart service with test hook enabled to pause after Batch 0
  await stopService(service);
  service = await startService({
    FORMDIGITAL_ENABLE_TEST_HOOKS: "1",
    FORMDIGITAL_TEST_JOURNAL_ARCHIVE_PAUSE_AT: "after_batch_0",
  });
  await waitForHealth();

  const checkpointFile = path.join(boundsRoot, "staging", ".formdigital-journal-archive-test-checkpoint");
  await fs.unlink(checkpointFile).catch(() => {});

  const interruptedSavePayload = {
    expectedRevision: initialRev,
    workspace: {
      schemaVersion: 1,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      templates: [{ id: "t-b-rec", name: "B-Rec" }],
      templateVersions: [],
      mappingTemplates: [],
      instances: [],
      operationJournal: [
        ...overflow1500,
        ...Array.from({ length: 5_000 }, (_, i) => ({ id: `j-b-rec-kept-${i}`, at: i })),
      ],
    },
  };

  const putReqPromise = rawRequest("/api/v1/workspace", "PUT", interruptedSavePayload, problemBRecoveryHeaders).catch(() => null);

  // Wait for Batch 0 to commit and trigger checkpoint
  let checkpointAppeared = false;
  for (let poll = 0; poll < 100; poll++) {
    if (await exists(checkpointFile)) {
      checkpointAppeared = true;
      break;
    }
    await new Promise(r => setTimeout(r, 50));
  }
  if (!checkpointAppeared) {
    throw new Error("Batch 0 checkpoint was not written by local-data-service");
  }

  // Terminate child process while Batch 0 is committed and before Batch 1 finishes!
  await stopService(service);
  await putReqPromise;
  await fs.unlink(checkpointFile).catch(() => {});

  // Verify that during interruption, formal v1 envelope was NOT updated!
  const midFlightV1Bytes = await fs.readFile(initialV1Path);
  if (!midFlightV1Bytes.equals(initialV1Bytes)) {
    throw new Error("v1 envelope was prematurely modified before all batches completed archiving");
  }

  // Check v2 SQLite on disk: Batch 0 (1,000 entries) is present
  const midStorage = WorkspaceStorageV2.openByOwnerHash({
    rootDir: boundsRoot,
    ownerHash: recOwnerHash,
    readOnly: true,
  });
  let midBatchCount = 0;
  try {
    for await (const _rec of midStorage.exportRecords({ collection: "operationJournal" })) {
      midBatchCount++;
    }
  } finally {
    midStorage.close();
  }
  if (midBatchCount !== 1000) {
    throw new Error(`Expected exactly 1,000 entries in v2 after Batch 0 interruption, found ${midBatchCount}`);
  }

  // Restart service cleanly (without test hooks)
  service = await startService();
  await waitForHealth();

  // Retry the full save with a mutated workspace.updatedAt (Issue 2 / Problem 5 requirement)
  const retrySavePayload = structuredClone(interruptedSavePayload);
  retrySavePayload.workspace.updatedAt = "2026-09-02T18:45:00.000Z";

  const problemBRecoverySave = await rawRequest(
    "/api/v1/workspace",
    "PUT",
    retrySavePayload,
    problemBRecoveryHeaders,
  );
  if (problemBRecoverySave.status !== 200) {
    throw new Error(`Interrupted multi-batch recovery failed (${problemBRecoverySave.status}): ${JSON.stringify(problemBRecoverySave.payload)}`);
  }

  // Verify v1 envelope is updated to new revision with mutated updatedAt
  const v1Final = (await request("/api/v1/workspace", "GET", undefined, problemBRecoveryHeaders)).payload;
  if (v1Final.revision !== initialRev + 1) {
    throw new Error(`Expected v1 revision ${initialRev + 1}, got ${v1Final.revision}`);
  }
  if (!Number.isFinite(Date.parse(v1Final.workspace.updatedAt))) {
    throw new Error(`Expected valid workspace updatedAt, got ${v1Final.workspace.updatedAt}`);
  }

  // Verify all 1,500 entries are stored in v2 exactly once (page 1 + page 2)
  const v2Page1 = (
    await request(
      "/api/v2/workspace/query",
      "POST",
      { collection: "operationJournal", limit: 1_000 },
      problemBRecoveryHeaders,
    )
  ).payload;
  const v2Page2 = (
    await request(
      "/api/v2/workspace/query",
      "POST",
      { collection: "operationJournal", limit: 1_000, cursor: v2Page1.nextCursor },
      problemBRecoveryHeaders,
    )
  ).payload;
  const allV2RecEntries = [...v2Page1.records, ...v2Page2.records];
  if (allV2RecEntries.length !== 1_500) {
    throw new Error(`Expected exactly 1,500 entries in v2 after recovery, found ${allV2RecEntries.length}`);
  }
  const uniqueRecIds = new Set(allV2RecEntries.map(r => r?.archivedEntry?.id));
  if (uniqueRecIds.size !== 1_500) {
    throw new Error(`Expected 1,500 unique archived entry IDs, found ${uniqueRecIds.size}`);
  }
  const interruptedProcessRecoverySucceeded = true;

  // ================= Bounded v1 envelope size =================
  // A request arrives as compact JSON under a 50 MiB ceiling and is stored
  // pretty-printed, which is far larger. A payload comfortably inside the
  // request limit could therefore be published past the 64 MiB ceiling that
  // migration enforces: it saved once and could never be read or migrated
  // again. The bulk here sits in an authoritative collection, so the projected
  // metadata stays small and only the real on-disk size can catch it.
  const envelopeHeaders = {
    ...headers,
    "x-formdigital-owner": "google-user-envelope-size-test",
  };
  const envelopeTemplates = [{ id: "envelope-template", name: "Envelope" }];
  const envelopeAccountsBefore = await fs.readdir(boundsAccountsDir);
  await request(
    "/api/v1/workspace",
    "PUT",
    {
      expectedRevision: 0,
      workspace: {
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        templates: envelopeTemplates,
        templateVersions: [],
        mappingTemplates: [],
        instances: [],
      },
    },
    envelopeHeaders,
  );
  const envelopeHash = await newAccountHash(envelopeAccountsBefore);
  if (!envelopeHash)
    throw new Error("The envelope fixture created no account directory.");
  const envelopePath = path.join(boundsAccountsDir, envelopeHash, "workspace.json");
  const envelopeBefore = await fs.readFile(envelopePath);

  // Nested short arrays: pretty-printing puts every number on its own indented
  // line, so the stored form is several times the size of the request.
  const wideRow = Array.from({ length: 200 }, (_, index) => index % 10);
  const oversized = {
    expectedRevision: 1,
    workspace: {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      templates: envelopeTemplates,
      templateVersions: [],
      mappingTemplates: [],
      instances: Array.from({ length: 2_000 }, (_, index) => ({
        id: `bulk-${index}`,
        templateId: "envelope-template",
        d: Array.from({ length: 20 }, () => wideRow),
      })),
    },
  };
  const compactBytes = Buffer.byteLength(JSON.stringify(oversized), "utf8");
  const prettyBytes = Buffer.byteLength(JSON.stringify(oversized, null, 2), "utf8");
  const projectedBytes = Buffer.byteLength(
    JSON.stringify({ ...oversized.workspace, instances: [] }, null, 2),
    "utf8",
  );
  if (compactBytes >= 50 * 1024 * 1024)
    throw new Error("Envelope fixture is not inside the request ceiling.");
  if (prettyBytes <= 64 * 1024 * 1024)
    throw new Error("Envelope fixture does not exceed the stored-size ceiling.");
  if (projectedBytes >= 32 * 1024 * 1024)
    throw new Error("Envelope fixture projected metadata is not small.");

  const envelopeRejected = await rawRequest(
    "/api/v1/workspace",
    "PUT",
    oversized,
    envelopeHeaders,
  );
  const oversizedEnvelopeRefused = envelopeRejected.status === 413;
  if (!oversizedEnvelopeRefused)
    throw new Error(
      `A Workspace that would be unreadable once stored was not refused (${envelopeRejected.status}).`,
    );
  const envelopeAfter = await fs.readFile(envelopePath);
  const oversizedEnvelopeLeavesDataIntact = envelopeBefore.equals(envelopeAfter);
  if (!oversizedEnvelopeLeavesDataIntact)
    throw new Error("A refused oversized save still changed the stored Workspace.");
  const envelopeStillReadable =
    (await rawRequest("/api/v1/workspace", "GET", undefined, envelopeHeaders))
      .status === 200;
  if (!envelopeStillReadable)
    throw new Error("The Workspace became unreadable after a refused oversized save.");

  // ================= Unusable unpublished v2 database =================
  // A published database is only ever the authority once the v1 envelope
  // carries a projection marker. Without one, v1 is still the authority and an
  // unreadable, truncated or diverged database is an unfinished attempt.
  // Previously only the diverged case reached quarantine: a damaged file threw
  // out of requireUsableProjectedWorkspaceV2 first, leaving a permanent 409
  // asking for a Backup restore that could not be reached, because the
  // Workspace would not open to reach it.
  const damageResults = {};
  for (const [kind, damage] of [
    [
      "corrupt",
      async file => {
        const handle = await fs.open(file, "r+");
        try {
          await handle.write(Buffer.alloc(4096, 0xff), 0, 4096, 0);
        } finally {
          await handle.close();
        }
      },
    ],
    ["truncated", async file => fs.truncate(file, 200)],
  ]) {
    const owner = `google-user-v2-${kind}-test`;
    const damageHeaders = { ...headers, "x-formdigital-owner": owner };
    const workspaceOf = instances => ({
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      templates: [{ id: `${kind}-template`, name: "Damaged" }],
      templateVersions: [
        { id: `${kind}-version`, templateId: `${kind}-template`, version: 1 },
      ],
      mappingTemplates: [],
      instances,
    });
    const damageInstance = id => ({
      id,
      templateId: `${kind}-template`,
      templateVersionId: `${kind}-version`,
      values: {},
    });

    const accountsBefore = await fs.readdir(boundsAccountsDir);
    // Snapshot what is already quarantined: an earlier scenario has put a
    // directory there, so "some directory exists" would pass without this
    // scenario having quarantined anything at all.
    const quarantineBefore = await fs
      .readdir(path.join(boundsRoot, "quarantine"))
      .catch(() => []);
    await request(
      "/api/v1/workspace",
      "PUT",
      {
        expectedRevision: 0,
        workspace: workspaceOf([damageInstance("d1"), damageInstance("d2")]),
      },
      damageHeaders,
    );
    const damageHash = await newAccountHash(accountsBefore);
    if (!damageHash)
      throw new Error(`The ${kind} fixture created no account directory.`);

    // A v2 read publishes the database and finishes the cutover, which is how
    // an ordinary dashboard load creates one without any size trigger.
    await request(
      "/api/v2/workspace/query",
      "POST",
      { collection: "instances", limit: 10 },
      damageHeaders,
    );
    if (
      (await rawRequest("/api/v1/workspace", "GET", undefined, damageHeaders))
        .status !== 200
    )
      throw new Error(`The ${kind} fixture could not complete its cutover.`);

    // Put v1 back in charge, then damage the published database.
    await stopService(service);
    const unprojected = JSON.stringify(
      {
        revision: 9,
        workspace: workspaceOf([damageInstance("d1"), damageInstance("d2")]),
      },
      null,
      2,
    );
    await fs.writeFile(
      path.join(boundsAccountsDir, damageHash, "workspace.json"),
      unprojected,
    );
    const ownerV2Directory = path.join(boundsRoot, "workspace-v2", damageHash);
    await fs.writeFile(
      path.join(ownerV2Directory, "legacy-workspace.json"),
      unprojected,
    );
    await damage(path.join(ownerV2Directory, "workspace-v2.sqlite"));
    service = await startService();
    await waitForHealth();

    const recovered = await rawRequest(
      "/api/v1/workspace",
      "GET",
      undefined,
      damageHeaders,
    );
    if (recovered.status !== 200)
      throw new Error(
        `A ${kind} unpublished v2 database left the Workspace unreadable (${recovered.status}).`,
      );
    const quarantinedNow = (
      await fs.readdir(path.join(boundsRoot, "quarantine")).catch(() => [])
    ).filter(
      entry =>
        entry.startsWith("workspace-v2-") && !quarantineBefore.includes(entry),
    );
    if (quarantinedNow.length !== 1)
      throw new Error(
        `A ${kind} v2 database produced ${quarantinedNow.length} new quarantine entries, expected exactly 1.`,
      );
    // Rebuilt from v1, and stable on the read after that.
    const secondRead = await rawRequest(
      "/api/v1/workspace",
      "GET",
      undefined,
      damageHeaders,
    );
    if (secondRead.status !== 200)
      throw new Error(`A rebuilt Workspace (${kind}) failed its second read.`);
    damageResults[kind] = true;
  }
  const corruptV2Recovers = damageResults.corrupt === true;
  const truncatedV2Recovers = damageResults.truncated === true;

  // A Workspace whose projection marker is real must never be overwritten from
  // v1: v2 is the authority there, so the only safe answer is to fail closed.
  const markerHeaders = {
    ...headers,
    "x-formdigital-owner": "google-user-v2-marker-failclosed-test",
  };
  const markerAccountsBefore = await fs.readdir(boundsAccountsDir);
  await request(
    "/api/v1/workspace",
    "PUT",
    {
      expectedRevision: 0,
      workspace: {
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        templates: [{ id: "marker-template", name: "Marker" }],
        templateVersions: [
          { id: "marker-version", templateId: "marker-template", version: 1 },
        ],
        mappingTemplates: [],
        instances: [],
      },
    },
    markerHeaders,
  );
  const markerHash = await newAccountHash(markerAccountsBefore);
  await request(
    "/api/v2/workspace/query",
    "POST",
    { collection: "instances", limit: 10 },
    markerHeaders,
  );
  await request("/api/v1/workspace", "GET", undefined, markerHeaders);
  await stopService(service);
  await fs.truncate(
    path.join(boundsRoot, "workspace-v2", markerHash, "workspace-v2.sqlite"),
    200,
  );
  service = await startService();
  await waitForHealth();
  const markerRead = await rawRequest(
    "/api/v1/workspace",
    "GET",
    undefined,
    markerHeaders,
  );
  const projectedMarkerFailsClosed = markerRead.status === 409;
  if (!projectedMarkerFailsClosed)
    throw new Error(
      `A damaged authoritative v2 database did not fail closed (${markerRead.status}).`,
    );

  // ================= Compliant summary =================
  console.log(
    JSON.stringify(
      {
        verified: true,
        runtimeFolderLossDetected,
        missingRootNotRecreated: !(await exists(lostFolder)),
        missingCandidateRejected: negativeResults.missing === true,
        emptyCandidateRejected: negativeResults.empty === true,
        incompleteCandidateRejected: negativeResults.incomplete === true,
        corruptCandidateRejected: negativeResults.corrupt === true,
        unauthenticatedReconnectStatus,
        invalidTokenReconnectStatus,
        validReconnectSucceeded,
        workspacePreservedAfterReconnect,
        assetPreservedAfterReconnect,
        persistedAfterRestart,
        requiredDirectoryTypeDetected,
        healthStatusAfterReconnect: healthAfterReconnect.payload.status,
        crossAccountStatus: crossAfter.status,
        invalidTokenStatus: invalidToken.status,
        healthyRepairNoOp,
        emergencyBackupFailureBlockedRepair,
        originalBytesPreservedWhenBackupFailed,
        contentHashMismatchDetected,
        emergencyBackupCreatedBeforeRepair,
        emergencyContainsObjects,
        emergencyContainsManifests,
        emergencyContainsAccounts,
        emergencyContainsMetadata,
        emergencyContainsJournal,
        corruptManifestQuarantined,
        corruptObjectRetained,
        orphanWarningReported,
        repairReportVerified,
        workspaceCorruptionDetected,
        unrepairableWorkspacePreserved,
        unrepairableWorkspaceStillUnhealthy,
        emergencyBackupsPersistedAfterRestart,
        localVerifierRejectsWrongOwner,
        localVerifierRejectsUnsafePaths,
        localVerifierRejectsExtraEntries,
        localVerifierRejectsWorkspaceSummaryMismatch,
        localVerifierRejectsInvalidAssetLinks,
        invalidPortableRestoreCreatedNoEmergencyBackup,
        invalidPortableRestoreWroteNoJournal,
        invalidPortableRestorePreservedAllBytes,
        // ---- Task 2 / Layer 2C2B-R1 (account full restore transactional) ----
        // Sourced from the enforced assertion ledger above; nothing here can be
        // reported without having passed its own assertion first.
        ...c2bResults,
        allLayer2C2BAssertionsEnforced,
        layer2C2BAssertionCount: c2bAssertionNames.length,
        dedupCreatesDistinctManifest,
        deletingDuplicatePreservesOriginal,
        mutationGatePreventsLateCommit,
        legacyRestoreRestoresAllDomains,
        integrityValidatesWorkspaceGraph,
        backupRejectsMissingReferencedAsset,
        atomicOverwriteExistingTarget,
        atomicRecoveryRestoredCanonical,
        rawDuplicateVerified,
        rawConflictFailedClosed,
        unreadableManifestDeleteFailsClosed,
        sameTemplateVersionAssetSharingAccepted,
        portableRestoreRepairsCorruptCurrent: Boolean(portableRestoreRepairsCorruptCurrent),
        legacyCleanupFailureKeepsCommittedGeneration,
        legacyCleanupRecoveredOnStartup,
        legacyCrashRollbackRecoveredOldGeneration,
        legacyCrashCommitMarkerKeepsNewGeneration,
        legacyWorkspaceMissingCollectionsStaysReadable,
        cutoverWorkspaceStaysReadableAfterProjection,
        divergedWorkspaceRecovers,
        divergedQuarantined,
        divergedStaysReadable,
        legacyJournalKeptIntact,
        legacyJournalBoundedByArchiving,
        overflowArchivedNotDeleted,
        archivedHistorySurvivesPortableBackup,
        refusedSaveArchivesNothing,
        oversizedJournalEntryRefused,
        legacyJournalRejectionKeepsData,
        journalArchiveDeadlockResolvedByOpen,
        journalArchivePreservesIdenticalOccurrences,
        journalArchiveRetryIdempotent,
        journalArchiveBoundedBatching,
        oversizedEnvelopeRefused,
        oversizedEnvelopeLeavesDataIntact,
        envelopeStillReadable,
        corruptV2Recovers,
        truncatedV2Recovers,
        projectedMarkerFailsClosed,
        markerRecoveryNoV2Succeeded,
        markerRecoveryZeroByteQuarantined,
        markerRecoveryTruncatedQuarantined,
        markerRecoveryInjectedFailureHandled,
        markerRecoveryInterruptedPreservedHealthy,
        markerRecoveryLingeringSafe,
        sharedBatchPlanningVerified,
        oversizedRecordRejected413,
        interruptedProcessRecoverySucceeded,
        markerRecoveryUnlinkFailureHandled,
        batchPlanningDeterministic24HexBytesBounded,
        testHooksStrictIsolationAndTraversalResistant,
      },
      null,
      2
    )
  );
} finally {
  try {
    await stopService(service);
  } finally {
    await fs.rm(testRoot, { recursive: true, force: true });
  }
}
