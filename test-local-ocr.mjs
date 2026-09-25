import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await fs.readFile(path.join(here, "local-service-config.json"), "utf8"));
const fixture = await fs.readFile(path.join(here, "ocr-fixture.png"));
const response = await fetch(`http://127.0.0.1:${config.port}/api/v1/ocr/tesseract`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${config.token}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ base64: fixture.toString("base64"), mimeType: "image/png", language: "eng" }),
});
const payload = await response.json();
if (!response.ok) throw new Error(`OCR endpoint rejected the fixture: ${JSON.stringify(payload)}`);
if (payload.provider !== "tesseract" || payload.cost !== "free-local") throw new Error(`Unexpected OCR provider response: ${JSON.stringify(payload)}`);
const text = payload.words.map((word) => word.text).join(" ");
if (!/FORMDIGITAL/i.test(text) || !/OCR/i.test(text)) throw new Error(`OCR text did not contain the fixture heading: ${text}`);
console.log(JSON.stringify({ verified: true, provider: payload.provider, cost: payload.cost, wordCount: payload.words.length, text }, null, 2));
