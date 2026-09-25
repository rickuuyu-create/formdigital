import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const configPath = process.env.FORMDIGITAL_LOCAL_CONFIG || path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "FormDigital", "offline-config.json"
);
const settingsDir = path.dirname(configPath);
const dataFolder = process.env.FORMDIGITAL_DATA_FOLDER || path.join(settingsDir, "Data");
const ldsPort = Number(process.env.FORMDIGITAL_LDS_HEALTH_PORT || 43210);
const webPort = Number(process.env.FORMDIGITAL_WEB_PORT || 3210);
if (!Number.isSafeInteger(ldsPort) || ldsPort < 1 || ldsPort > 65535 ||
    !Number.isSafeInteger(webPort) || webPort < 1 || webPort > 65535 || ldsPort === webPort) {
  throw new Error("Invalid local service ports.");
}

await fs.mkdir(settingsDir, { recursive: true });
await fs.mkdir(dataFolder, { recursive: true });
async function createOnce(file, content) {
  try {
    const handle = await fs.open(file, "wx", 0o600);
    try { await handle.writeFile(content, "utf8"); }
    finally { await handle.close(); }
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
}
await createOnce(configPath, JSON.stringify({
  schemaVersion: 1,
  port: ldsPort,
  dataFolder,
  token: crypto.randomBytes(32).toString("base64url"),
  allowedOrigins: [`http://localhost:${webPort}`],
}, null, 2));
console.log("Local settings ready.");
