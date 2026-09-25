import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const scratch = await fs.mkdtemp(
  path.join(os.tmpdir(), "formdigital-integrity-bounds-"),
);
const dataFolder = path.join(scratch, "data");
const configPath = path.join(scratch, "config.json");
const token = crypto.randomBytes(24).toString("base64url");
let service;
let assertions = 0;

function check(value, message) {
  assert.ok(value, message);
  assertions += 1;
}

function equal(actual, expected, message) {
  assert.deepStrictEqual(actual, expected, message);
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

async function resetDirectory(target) {
  const resolved = path.resolve(target);
  const expectedPrefix = `${path.resolve(dataFolder)}${path.sep}`;
  if (!resolved.startsWith(expectedPrefix))
    throw new Error("Refusing to reset an unexpected test directory.");
  await fs.rm(resolved, { recursive: true, force: true });
  await fs.mkdir(resolved, { recursive: true });
}

try {
  const port = await freePort();
  await fs.mkdir(dataFolder, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({
    schemaVersion: 1,
    port,
    dataFolder,
    token,
    allowedOrigins: [],
  }));
  service = spawn(process.execPath, [path.join(projectRoot, "local-data-service.mjs")], {
    cwd: projectRoot,
    env: {
      ...process.env,
      FORMDIGITAL_LOCAL_CONFIG: configPath,
      FORMDIGITAL_ENABLE_TEST_HOOKS: "1",
      FORMDIGITAL_TEST_INTEGRITY_MAX_FINDINGS: "3",
      FORMDIGITAL_TEST_INTEGRITY_MAX_MANIFESTS: "10",
      FORMDIGITAL_TEST_INTEGRITY_MAX_OBJECTS: "10",
      FORMDIGITAL_TEST_INTEGRITY_MAX_OWNERS: "10",
      FORMDIGITAL_TEST_INTEGRITY_MAX_MANIFEST_BYTES: "128",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const headers = {
    authorization: `Bearer ${token}`,
    "x-formdigital-owner": "synthetic-integrity-owner",
  };
  const scan = async () => {
    const response = await fetch(`${base}/api/v1/integrity-scan`, {
      method: "POST",
      headers,
    });
    const payload = await response.json();
    assert.equal(response.ok, true, JSON.stringify(payload));
    return payload;
  };
  const manifests = path.join(dataFolder, "manifests");

  for (let index = 0; index < 5; index += 1)
    await fs.writeFile(path.join(manifests, `invalid-${index}.json`), "{");
  const cappedFindings = await scan();
  equal(cappedFindings.healthy, false);
  equal(cappedFindings.findings.length, 3);
  check(
    cappedFindings.findings.some(
      finding =>
        finding.code === "integrity_scan_limit_exceeded" &&
        finding.scope === "findings",
    ),
    "Integrity findings must be capped with a fixed terminal finding.",
  );

  await resetDirectory(manifests);
  await fs.writeFile(path.join(manifests, "oversized.json"), "x".repeat(256));
  const oversized = await scan();
  check(
    oversized.findings.some(
      finding => finding.code === "manifest_size_limit_exceeded",
    ),
    "An oversized manifest must be rejected before JSON materialisation.",
  );

  await resetDirectory(manifests);
  for (let index = 0; index < 11; index += 1)
    await fs.writeFile(path.join(manifests, `ignored-${index}.tmp`), "x");
  const boundedDirectory = await scan();
  check(
    boundedDirectory.findings.some(
      finding =>
        finding.code === "integrity_scan_limit_exceeded" &&
        finding.scope === "manifests",
    ),
    "Directory iteration must stop at its fixed manifest-entry limit.",
  );

  console.log(`Integrity bounds: ${assertions} assertions passed.`);
} finally {
  await stop().catch(() => undefined);
  await fs.rm(scratch, { recursive: true, force: true });
}
