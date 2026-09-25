import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(here, "local-service-config.json");
try {
  await fs.access(configPath);
  console.log("Existing local-service-config.json preserved.");
} catch {
  const config = {
    schemaVersion: 1,
    port: 4317,
    dataFolder: path.resolve(here, "..", "FormdigitalData"),
    token: crypto.randomBytes(32).toString("base64url"),
    allowedOrigins: ["http://localhost:3000"],
  };
  await fs.mkdir(config.dataFolder, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(
    "Created local-service-config.json. Add your deployed site origin to allowedOrigins before browser integration."
  );
}
