// Isolated regression: never reads the user's local service configuration/data.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "formdigital-text-signature-"));
const token = crypto.randomBytes(24).toString("base64url");
const listener = net.createServer();
await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const configPath = path.join(scratch, "config.json");
await fs.mkdir(path.join(scratch, "data"));
await fs.writeFile(configPath, JSON.stringify({
  schemaVersion: 1, port, token, dataFolder: path.join(scratch, "data"), allowedOrigins: [],
}));
const service = spawn(process.execPath, [path.join(root, "local-data-service.mjs")], {
  cwd: root, env: { ...process.env, FORMDIGITAL_LOCAL_CONFIG: configPath },
  stdio: "ignore", windowsHide: true,
});
const base = `http://127.0.0.1:${port}`;
const request = async (route, method = "GET", body) => {
  const response = await fetch(base + route, {
    method, headers: { authorization: `Bearer ${token}`, "x-formdigital-owner": "synthetic-signature", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  assert.ok(response.ok, `${route}: ${response.status} ${JSON.stringify(result)}`);
  return result;
};
try {
  for (let n = 0; n < 100; n++) {
    try { if ((await fetch(base + "/health")).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const instance = {
    id: "instance-1", templateId: "template-1", templateVersionId: "version-1",
    status: "draft", values: { signature: "text:Demo User", blank: "text:" },
  };
  const workspace = {
    schemaVersion: 2,
    templates: [{ id: "template-1", name: "Synthetic", currentPublishedVersionId: "version-1" }],
    templateVersions: [{ id: "version-1", templateId: "template-1", state: "published", pageManifest: [] }],
    fields: [
      { id: "field-1", stableFieldId: "signature", templateVersionId: "version-1", fieldType: "signature" },
      { id: "field-2", stableFieldId: "blank", templateVersionId: "version-1", fieldType: "signature" },
      { id: "field-3", stableFieldId: "image", templateVersionId: "version-1", fieldType: "image" },
    ],
    instances: [instance], folders: [], tags: [], savedValues: [], mappingTemplates: [],
    importRuns: [], importRows: [], mappingDecisions: [], detectionRuns: [],
  };
  await request("/api/v1/workspace", "PUT", { expectedRevision: 0, workspace });
  assert.equal((await request("/api/v1/integrity-scan", "POST")).healthy, true, "legacy text signatures must pass");
  await request("/api/v1/backups", "POST", { portable: true, templateId: "template-1" });
  await request("/api/v2/workspace/describe");
  assert.equal((await request("/api/v1/integrity-scan", "POST")).healthy, true, "v2 text signatures must pass");
  await request("/api/v1/backups", "POST", { portable: true, templateId: "template-1" });
  await request("/api/v1/portable-backups", "POST", {});
  const records = await request("/api/v2/workspace/query", "POST", { collection: "instances", limit: 10 });
  assert.deepEqual(records.records[0].values, instance.values, "signature content must be preserved");
  for (const [field, value] of [["image", "text:not-an-image"], ["signature", "asset-missing-signature"]]) {
    const state = await request("/api/v2/workspace/describe");
    await request("/api/v2/workspace/transaction", "POST", {
      expectedRevision: state.revision, transactionId: `negative-${field}`,
      put: [{ collection: "instances", record: { ...instance, values: { ...instance.values, [field]: value } } }],
    });
    const scan = await request("/api/v1/integrity-scan", "POST");
    assert.equal(scan.healthy, false, `${field}: genuinely missing assets must still fail`);
    assert.ok(scan.findings.some(f => f.code === "workspace_asset_missing"));
  }
  console.log("PASS: legacy/v2 inline signatures, scoped/portable backups, preserved values, missing-image/signature controls");
} finally {
  if (service.exitCode === null) {
    service.kill();
    await new Promise(resolve => service.once("exit", resolve));
  }
  // Retain the isolated synthetic fixture for diagnosis; never touch real data.
}
