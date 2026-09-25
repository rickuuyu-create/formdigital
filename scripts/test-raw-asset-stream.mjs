// Offline fixture check for the Local Data Service raw asset transport.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const port = 4399;
const root = await fs.mkdtemp(path.join(os.tmpdir(), "formdigital-raw-"));
const dataFolder = path.join(root, "data");
await fs.mkdir(dataFolder);
const token = crypto.randomBytes(32).toString("base64");
const configPath = path.join(root, "config.json");
await fs.writeFile(
  configPath,
  JSON.stringify({
    schemaVersion: 1,
    port,
    dataFolder,
    token,
    allowedOrigins: [],
  })
);

const service = spawn(process.execPath, ["local-data-service.mjs"], {
  env: { ...process.env, FORMDIGITAL_LOCAL_CONFIG: configPath },
  stdio: ["ignore", "ignore", "pipe"],
});
let serviceError = "";
service.stderr.on("data", chunk => {
  serviceError += String(chunk);
});

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function stopService() {
  if (service.exitCode === null) {
    service.kill();
    await new Promise(resolve => service.once("exit", resolve));
  }
}

try {
  let healthy = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`).then(value => value.json());
      if (health.status === "ok") {
        healthy = true;
        break;
      }
    } catch {
      await wait(200);
    }
  }
  if (!healthy) throw new Error(`raw fixture service did not start: ${serviceError}`);

  const source = new Uint8Array(Buffer.from("\uFEFFname,number\r\nAda,1\r\n", "utf8"));
  const owner = "raw-stream-test-owner";
  const auth = { authorization: `Bearer ${token}`, "x-formdigital-owner": owner };
  const upload = await fetch(
    `http://127.0.0.1:${port}/api/v1/assets/raw?filename=fixture.csv&metadata=${encodeURIComponent(JSON.stringify({ kind: "source" }))}`,
    {
      method: "POST",
      headers: { ...auth, "content-type": "application/octet-stream" },
      body: Buffer.from(source),
    }
  );
  const uploaded = await upload.json();
  if (!upload.ok || uploaded.asset?.mimeType !== "text/csv")
    throw new Error("raw upload failed");

  const metadataResponse = await fetch(
    `http://127.0.0.1:${port}/api/v1/assets/${uploaded.asset.id}/meta`,
    { headers: auth }
  );
  const metadata = await metadataResponse.json();
  if (!metadataResponse.ok || metadata.asset.metadata.kind !== "source")
    throw new Error("raw asset metadata failed");

  const download = await fetch(
    `http://127.0.0.1:${port}/api/v1/assets/${uploaded.asset.id}/raw`,
    { headers: auth }
  );
  if (!download.ok) throw new Error("raw asset download failed");
  const downloaded = new Uint8Array(await download.arrayBuffer());
  const sourceHash = crypto.createHash("sha256").update(source).digest("hex");
  const downloadedHash = crypto.createHash("sha256").update(downloaded).digest("hex");
  if (sourceHash !== downloadedHash) throw new Error("raw asset bytes changed");

  console.log(
    JSON.stringify({
      verified: true,
      deduplicated: Boolean(uploaded.deduplicated),
      metadataPreserved: true,
      sha256Matched: true,
    })
  );
} finally {
  await stopService();
  await fs.rm(root, { recursive: true, force: true });
}
