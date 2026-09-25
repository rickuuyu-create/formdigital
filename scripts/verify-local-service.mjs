import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
let localConfig;
try { localConfig = JSON.parse(await fs.readFile(process.env.FORMDIGITAL_LOCAL_SERVICE_CONFIG ?? path.join(here, "local-service-config.json"), "utf8")); } catch { localConfig = undefined; }
const baseUrl = (process.env.FORMDIGITAL_LOCAL_SERVICE_URL ?? `http://127.0.0.1:${localConfig?.port ?? 4317}`).replace(/\/$/, "");
const token = process.env.FORMDIGITAL_LOCAL_SERVICE_TOKEN ?? localConfig?.token;
if (!token) throw new Error("FORMDIGITAL_LOCAL_SERVICE_TOKEN is required, or run this script beside the Windows local-service-config.json file.");
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

async function call(route, body) {
  const response = await fetch(`${baseUrl}${route}`, { method: "POST", headers, body: body ? JSON.stringify(body) : undefined });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${route}: ${JSON.stringify(payload)}`);
  return payload;
}

const health = await fetch(`${baseUrl}/health`);
if (!health.ok) throw new Error(`Local service health failed with ${health.status}.`);
const body = Buffer.from(`Formdigital automated restore fixture\n${crypto.randomUUID()}\n`).toString("base64");
await call("/api/v1/assets", { base64: body, originalFilename: "restore-fixture.txt", mimeType: "text/plain", metadata: { test: true } });
const backup = await call("/api/v1/backups");
const restored = await call("/api/v1/restore", { backupId: backup.id });
if (!restored.scan?.healthy) throw new Error("Restore succeeded but Integrity Scan is unhealthy.");
const missing = await fetch(`${baseUrl}/api/v1/restore`, { method: "POST", headers, body: JSON.stringify({ backupId: "backup-does-not-exist" }) });
if (missing.status !== 404) throw new Error(`Unknown backup must return 404, received ${missing.status}.`);
console.log(JSON.stringify({ verified: true, backupId: backup.id, emergencyBackupId: restored.emergencyBackupId, missingBackupStatus: missing.status }, null, 2));
