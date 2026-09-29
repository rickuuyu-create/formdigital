import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zipSync, unzipSync, strToU8 } from "fflate";
import {
  writePortableStoredZip,
  extractPortableZip,
} from "../server/formdigital/portable-archive-stream.mjs";

const root = await fs.mkdtemp(
  path.join(os.tmpdir(), "FormDigital-nested-zip-")
);
const nested = zipSync({
  "word/document.xml": strToU8("Synthetic DOCX body"),
  "word/media/image.png": new Uint8Array([80, 75, 3, 4, 80, 75, 7, 8]),
});
const binary = Buffer.concat([
  Buffer.alloc(256 * 1024 - 3, 42),
  Buffer.from(nested),
  Buffer.from([80, 75, 7, 8]),
]);
const source = path.join(root, "large.bin");
await fs.writeFile(source, binary);
const archive = path.join(root, "backup.zip");
await writePortableStoredZip(archive, [
  { archivePath: "objects/docx", bytes: nested, size: nested.length },
  { archivePath: "objects/binary", sourcePath: source, size: binary.length },
  { archivePath: "account/empty", bytes: new Uint8Array(), size: 0 },
]);
const expected = new Map([
  ["objects/docx", Buffer.from(nested)],
  ["objects/binary", binary],
  ["account/empty", Buffer.alloc(0)],
]);
const extracted = await extractPortableZip(archive, path.join(root, "out"), {
  validateEntryName: name => expected.has(name),
});
assert.equal(extracted.entries.size, 3);
for (const [name, bytes] of expected)
  assert.deepEqual(await fs.readFile(extracted.entries.get(name).path), bytes);
const independent = unzipSync(await fs.readFile(archive));
for (const [name, bytes] of expected)
  assert.deepEqual(Buffer.from(independent[name]), bytes);
console.log("Nested DOCX ZIP and binary signatures: 7 assertions passed.");
