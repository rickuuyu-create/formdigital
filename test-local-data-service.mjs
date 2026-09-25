import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await fs.readFile(path.join(here, "local-service-config.json"), "utf8"));
const headers = { authorization: `Bearer ${config.token}`, "content-type": "application/json" };

const allowedOrigin = config.allowedOrigins.find((origin) => origin.startsWith("https://")) || config.allowedOrigins[0];
const health = await fetch(`http://127.0.0.1:${config.port}/health`, { headers: { origin: allowedOrigin } });
if (!health.ok || health.headers.get("access-control-allow-origin") !== allowedOrigin || health.headers.get("access-control-allow-private-network") !== "true") {
  throw new Error("Allowed-origin CORS or private-network handshake validation failed.");
}
const unauthorized = await fetch(`http://127.0.0.1:${config.port}/api/v1/assets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
if (unauthorized.status !== 401) throw new Error(`Expected unauthenticated asset write to be rejected with 401, received ${unauthorized.status}.`);

async function call(route, body) {
  const response = await fetch(`http://127.0.0.1:${config.port}${route}`, { method: "POST", headers, body: body ? JSON.stringify(body) : undefined });
  const json = await response.json();
  if (!response.ok) throw new Error(`${route}: ${JSON.stringify(json)}`);
  return json;
}

const content = Buffer.from(`Formdigital Local Data Folder verification\n${new Date().toISOString()}\n`, "utf8");
const asset = await call("/api/v1/assets", { base64: content.toString("base64"), originalFilename: "verification.txt", mimeType: "text/plain", metadata: { test: true, retention: "keep-for-integrity-audit" } });
const scan = await call("/api/v1/integrity-scan");
const backup = await call("/api/v1/backups");
const restored = await call("/api/v1/restore", { backupId: backup.id });
const missingRestore = await fetch(`http://127.0.0.1:${config.port}/api/v1/restore`, { method: "POST", headers, body: JSON.stringify({ backupId: "backup-does-not-exist" }) });
const dataSchema = JSON.parse(await fs.readFile(path.join(config.dataFolder, "metadata", "data-schema.json"), "utf8"));
if (!scan.healthy) throw new Error(`Integrity scan reported ${scan.findings.length} findings.`);
if (!restored.scan.healthy) throw new Error(`Restore scan reported ${restored.scan.findings.length} findings.`);
if (missingRestore.ok || ![400, 404].includes(missingRestore.status)) throw new Error(`Expected unknown backup restore to be rejected, received ${missingRestore.status}.`);
if (dataSchema.schemaVersion !== 1 || !Array.isArray(dataSchema.appliedMigrations)) throw new Error("Data Folder schema migration metadata is missing or invalid.");
console.log(JSON.stringify({ verified: true, cors: "allowed-origin and private-network headers verified", unauthorizedWrite: "rejected", restoreFailure: `unknown backup rejected with ${missingRestore.status}`, assetId: asset.asset.id, contentHash: asset.asset.contentHash, dataSchema, integrity: scan, backupId: backup.id, restore: restored }, null, 2));
