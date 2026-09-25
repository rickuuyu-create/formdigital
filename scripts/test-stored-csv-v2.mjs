import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";
import {
  PDFDocument,
  PDFRawStream,
  StandardFonts,
  TextRenderingMode,
  setTextRenderingMode,
  clip,
  closePath,
  endPath,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rgb,
} from "pdf-lib";
// R10-P1: real page-raster / pixel visibility helper (test-only, never imported by
// production code). This is what replaces the round-9 content-stream heuristic.
import {
  createRasterSession,
  RASTER_SCALE,
  diffCrops,
  pdfRectToCanvasRect,
  rectOverlapRatio,
} from "./pdf-raster-visibility.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "formdigital-csv-v2-"));
const dataFolder = path.join(scratch, "data");
const configPath = path.join(scratch, "config.json");
const owner = "synthetic-csv-v2-owner";
const ownerHash = crypto.createHash("sha256").update(owner).digest("hex");
const token = crypto.randomBytes(24).toString("base64url");
let service;
let assertions = 0;

function equal(actual, expected, message) {
  assert.deepStrictEqual(actual, expected, message);
  assertions += 1;
}

// Decompress every content stream of a PDF and concatenate it as latin1 text.
async function extractPdfContentBytes(bytes) {
  const doc = await PDFDocument.load(Buffer.from(bytes));
  let content = "";
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    let data = Buffer.from(object.contents);
    try {
      data = zlib.inflateSync(data);
    } catch {
      /* an uncompressed content stream is read as-is */
    }
    content += data.toString("latin1");
  }
  return content;
}

async function extractPdfContent(owner, assetId) {
  const { getOwnedAssetBytes } = await import("../server/formdigital/assetStore.ts");
  const { bytes } = await getOwnedAssetBytes(owner, assetId);
  return extractPdfContentBytes(bytes);
}

// Return the (x, y) baseline origin of every text-show operator. pdf-lib emits
// `1 0 0 1 x y Tm` immediately before each `(literal)` or `<hex>` Tj, so the
// text matrix translation is the glyph-run start position regardless of whether
// the CJK font wrote the text as a literal or a hex string.
function extractRunPositions(content) {
  const runs = [];
  let x = 0;
  let y = 0;
  let i = 0;
  const n = content.length;
  while (i < n) {
    const ch = content[i];
    if (ch === "T" && content[i + 1] === "m") {
      const before = content.slice(Math.max(0, i - 80), i);
      const nums = before.match(/[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/g);
      if (nums && nums.length >= 6) {
        x = parseFloat(nums[nums.length - 2]);
        y = parseFloat(nums[nums.length - 1]);
      }
      i += 2;
    } else if (ch === "(") {
      let j = i + 1;
      while (j < n && content[j] !== ")") {
        if (content[j] === "\\") j += 1;
        j += 1;
      }
      runs.push({ x, y });
      i = j + 1;
    } else if (ch === "<" && /[0-9A-Fa-f]/.test(content[i + 1] || "")) {
      let j = i + 1;
      while (j < n && content[j] !== ">") j += 1;
      runs.push({ x, y });
      i = j + 1;
    } else {
      i += 1;
    }
  }
  return runs;
}

// R9-P1: parse a PDF content stream and report, for every text-show operation,
// whether it is actually RASTER-VISIBLE. Visibility is decided from the graphics
// state at the operator time:
//   - text rendering mode Tr in {3,4,5,6,7} paints nothing (invisible / clip-only);
//   - fill alpha ca <= threshold makes fill-only text invisible, stroke alpha CA
//     <= threshold makes stroke-only text invisible;
//   - an active clip path whose bounding box excludes the glyph origin means the
//     text is clipped away (raster-invisible even though pdf.js still extracts it).
// This is the deterministic, dependency-free proof that a value is truly painted,
// not merely present in the extracted text (which pdf.js reports regardless of
// opacity / clipping / rendering mode).
/**
 * DIAGNOSTIC ONLY — NOT RASTER EVIDENCE, NEVER USED TO PASS OR FAIL ANYTHING.
 *
 * This is the round-9 hand-written content-stream / graphics-state heuristic. regression test
 * proved it can be fooled: a visible blank run satisfies it while the real value
 * stays invisible, real ExtGState opacity (`/GS.. gs`) is not parsed, and rendering
 * modes 4/5/6 (which DO paint) are mis-classified. It is kept only so the round-10
 * report can log, for each control, what the old gate would have concluded.
 *
 * Real visibility is decided by assertRasterVisibleInCells(), which compares actual
 * device pixels from a genuine pdf.js rasterisation in headless Chromium.
 */
function analyzeTextVisibility(content) {
  const tokens = [];
  let i = 0;
  const n = content.length;
  const isWs = (c) => c === " " || c === "\n" || c === "\r" || c === "\t";
  while (i < n) {
    const ch = content[i];
    if (isWs(ch)) { i += 1; continue; }
    if (ch === "(") {
      let j = i + 1, depth = 1;
      while (j < n && depth > 0) {
        if (content[j] === "\\") j += 2;
        else if (content[j] === "(") depth += 1;
        else if (content[j] === ")") depth -= 1;
        else j += 1;
      }
      tokens.push({ t: "str" });
      i = j + 1;
      continue;
    }
    if (ch === "<") {
      let j = i + 1;
      while (j < n && content[j] !== ">") j += 1;
      tokens.push({ t: "str" });
      i = j + 1;
      continue;
    }
    if (ch === "/") {
      let j = i + 1;
      while (j < n && !isWs(content[j]) && content[j] !== "(" && content[j] !== "<") j += 1;
      tokens.push({ t: "name" });
      i = j;
      continue;
    }
    if (ch === "[" || ch === "]") { i += 1; continue; }
    const num = content.slice(i).match(/^[-+]?(\d+\.\d*|\.\d+|\d+)/);
    if (num) { tokens.push({ t: "num", v: parseFloat(num[0]) }); i += num[0].length; continue; }
    const two = content.slice(i, i + 2);
    const twoOps = new Set(["re", "Tm", "Td", "TD", "Tj", "TJ", "cm", "CA", "ca", "Tr", "W*", "BT", "ET", "Tc", "Tw", "Tz", "TL", "T*", "rg", "RG"]);
    if (twoOps.has(two)) { tokens.push({ t: "op", v: two }); i += 2; continue; }
    const oneOps = new Set(["q", "Q", "w", "J", "j", "M", "d", "m", "l", "c", "v", "y", "h", "n", "f", "S", "s", "B", "b", "i", "W", "G", "g", "r", "F"]);
    if (oneOps.has(ch)) { tokens.push({ t: "op", v: ch }); i += 1; continue; }
    i += 1;
  }
  let state = { ca: 1, CA: 1, Tr: 0, clip: null };
  const stack = [];
  let pathMinX = Infinity, pathMinY = Infinity, pathMaxX = -Infinity, pathMaxY = -Infinity;
  let pathHas = false;
  let textX = 0, textY = 0;
  const numStack = [];
  const runs = [];
  const intersect = (a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  const resetPath = () => { pathMinX = Infinity; pathMinY = Infinity; pathMaxX = -Infinity; pathMaxY = -Infinity; pathHas = false; };
  const addPoint = (x, y) => { pathMinX = Math.min(pathMinX, x); pathMinY = Math.min(pathMinY, y); pathMaxX = Math.max(pathMaxX, x); pathMaxY = Math.max(pathMaxY, y); pathHas = true; };
  const makeRun = () => {
    let visible = true;
    const tr = state.Tr;
    if (tr === 3 || tr === 4 || tr === 5 || tr === 6 || tr === 7) {
      visible = false;
    } else {
      const needFill = tr === 0 || tr === 2;
      const needStroke = tr === 1 || tr === 2;
      if (needFill && state.ca <= 0.01) visible = false;
      if (needStroke && state.CA <= 0.01) visible = false;
    }
    if (visible && state.clip) {
      const [x0, y0, x1, y1] = state.clip;
      const inside = textX >= x0 - 1 && textX <= x1 + 1 && textY >= y0 - 1 && textY <= y1 + 1;
      if (!inside) visible = false;
    }
    return { x: textX, y: textY, visible };
  };
  let k = 0;
  while (k < tokens.length) {
    const tk = tokens[k];
    if (tk.t === "num") { numStack.push(tk.v); k += 1; continue; }
    if (tk.t === "op") {
      const op = tk.v;
      const pop = (c) => { const r = []; for (let z = 0; z < c; z += 1) r.unshift(numStack.pop()); return r; };
      switch (op) {
        case "q": stack.push({ ca: state.ca, CA: state.CA, Tr: state.Tr, clip: state.clip }); break;
        case "Q": { const s = stack.pop(); if (s) state = s; resetPath(); break; }
        case "re": { const [x, y, w, h] = pop(4); addPoint(x, y); addPoint(x + w, y + h); break; }
        case "m": { const [x, y] = pop(2); addPoint(x, y); break; }
        case "l": { const [x, y] = pop(2); addPoint(x, y); break; }
        case "c": case "v": case "y": { const p = pop(op === "c" ? 6 : 4); for (let z = 0; z < p.length; z += 2) addPoint(p[z], p[z + 1]); break; }
        case "W": case "W*": {
          if (pathHas) {
            const pr = [pathMinX, pathMinY, pathMaxX, pathMaxY];
            state.clip = state.clip ? intersect(state.clip, pr) : pr;
          }
          resetPath();
          break;
        }
        case "n": resetPath(); break;
        case "ca": state.ca = pop(1)[0]; break;
        case "CA": state.CA = pop(1)[0]; break;
        case "gs": pop(1); break;
        case "Tr": state.Tr = pop(1)[0]; break;
        case "Tm": { const p = pop(6); textX = p[4]; textY = p[5]; break; }
        case "Td": case "TD": { const [tx, ty] = pop(2); textX += tx; textY += ty; break; }
        case "T*": textY -= 0; break;
        case "BT": textX = 0; textY = 0; break;
        case "ET": break;
        case "Tj": case "TJ": numStack.length = 0; runs.push(makeRun()); break;
        default: break;
      }
      k += 1;
      continue;
    }
    k += 1;
  }
  return runs;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function stop() {
  if (!service || service.exitCode !== null) return;
  service.kill();
  await new Promise(resolve => service.once("exit", resolve));
}

try {
  const port = await freePort();
  const timestamp = Date.now();
  const version = {
    id: "version-csv", templateId: "template-csv", versionNumber: 1,
    state: "published", schemaVersion: 2, contentHash: "synthetic-version-hash",
    note: null, pageManifest: [], fieldSnapshot: [], printSettings: {},
    publishedAt: timestamp, createdAt: timestamp, updatedAt: timestamp,
  };
  const tableVersion = {
    id: "version-table", templateId: "template-table", versionNumber: 1,
    state: "published", schemaVersion: 2, contentHash: "synthetic-table-version-hash",
    note: null, pageManifest: [{ page: 1, widthMm: 210, heightMm: 297 }], fieldSnapshot: [], printSettings: {},
    publishedAt: timestamp, createdAt: timestamp, updatedAt: timestamp,
  };
  const workspace = {
    schemaVersion: 2, ownerKey: owner,
    createdAt: new Date(timestamp).toISOString(), updatedAt: new Date(timestamp).toISOString(),
    templates: [
      {
        id: "template-csv", ownerId: owner, name: "CSV", description: null,
        lifecycle: "published", currentPublishedVersionId: version.id, currentDraftVersionId: null,
        schemaVersion: 2, folderIds: [], tagIds: [], favorite: false, pinned: false,
        printProfile: {}, instanceNamePattern: "{Template名稱}", keyFieldIds: [],
        createdAt: timestamp, updatedAt: timestamp, lastOpenedAt: timestamp,
      },
      {
        id: "template-table", ownerId: owner, name: "Table CSV", description: null,
        lifecycle: "published", currentPublishedVersionId: tableVersion.id, currentDraftVersionId: null,
        schemaVersion: 2, folderIds: [], tagIds: [], favorite: false, pinned: false,
        printProfile: {}, instanceNamePattern: "{Template名稱}", keyFieldIds: [],
        createdAt: timestamp, updatedAt: timestamp, lastOpenedAt: timestamp,
      },
    ],
    templateVersions: [version, tableVersion],
    fields: [
      {
        id: "field-name", templateVersionId: version.id, stableFieldId: "name",
        fieldType: "text", displayOrder: 0, definition: { required: false },
        coordinate: {}, createdAt: timestamp,
      },
      {
        id: "field-table", templateVersionId: tableVersion.id, stableFieldId: "statement_table",
        fieldType: "table", displayOrder: 0, definition: {
          label: "財務報表",
          confirmed: true,
          tableColumns: 3,
          maxRows: 2,
          tableWritableCells: [{ row: 0, column: 0 }, { row: 0, column: 1 }],
          tableFormulaCells: [{ row: 0, column: 2, expression: "A+B", decimalPlaces: 2 }],
        },
        coordinate: { page: 1, xMm: 10, yMm: 10, widthMm: 100, heightMm: 50 }, createdAt: timestamp,
      },
    ],
    instances: [], folders: [], tags: [], savedValues: [], mappingTemplates: [],
    importRuns: [], importRows: [], mappingDecisions: [], detectionRuns: [], operationJournal: [], preferences: {},
  };
  await fs.mkdir(path.join(dataFolder, "accounts", ownerHash), { recursive: true });
  await fs.writeFile(
    path.join(dataFolder, "accounts", ownerHash, "workspace.json"),
    JSON.stringify({ revision: 3, workspace }, null, 2),
  );
  await fs.writeFile(configPath, JSON.stringify({
    schemaVersion: 1, port, dataFolder, token, allowedOrigins: [],
  }));
  process.env.FORMDIGITAL_LOCAL_CONFIG = configPath;
  service = spawn(process.execPath, [path.join(root, "local-data-service.mjs")], {
    cwd: root,
    env: { ...process.env, FORMDIGITAL_LOCAL_CONFIG: configPath },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const headers = { authorization: `Bearer ${token}`, "x-formdigital-owner": owner };
  const rowCount = 1_001;
  const csv = `Name\n${Array.from({ length: rowCount }, (_, index) => `Person ${index}`).join("\n")}\n`;
  const upload = await fetch(
    `${base}/api/v1/assets/raw?filename=synthetic.csv&mimeType=text%2Fcsv&metadata=%257B%257D`,
    { method: "POST", headers: { ...headers, "content-type": "application/octet-stream" }, body: csv },
  );
  const uploaded = await upload.json();
  equal(upload.status, 201);

  const batch = await import("../server/formdigital/batch.ts");
  const local = await import("../server/formdigital/localServiceClient.ts");
  const inspected = await batch.inspectStoredCsv(owner, uploaded.asset.id);
  equal(inspected.totalRows, rowCount);
  const result = await batch.createStoredImportRun(owner, {
    templateVersionId: version.id,
    sourceAssetId: uploaded.asset.id,
    sourceHash: inspected.sourceHash,
    decisions: [{ csvField: "Name", templateStableFieldId: "name", confidence: "high", decision: "accepted" }],
    mode: "tolerant",
  });
  equal(result.created, rowCount);
  equal(result.totalRows, rowCount);

  const countCollection = async (collection, where) => {
    let cursor = null;
    let count = 0;
    do {
      const page = await local.queryLocalWorkspaceV2(owner, { collection, where, limit: 1_000, cursor });
      count += page.records.length;
      cursor = page.nextCursor;
    } while (cursor);
    return count;
  };
  equal(await countCollection("instances", { templateVersionId: version.id }), rowCount);
  equal(await countCollection("importRows", { importRunId: result.importRunId }), rowCount);
  const analysis = await batch.analyzeStoredCsvImport(owner, {
    templateVersionId: version.id,
    sourceAssetId: uploaded.asset.id,
    sourceHash: inspected.sourceHash,
    decisions: [{
      csvField: "Name",
      templateStableFieldId: "name",
      confidence: "high",
      decision: "accepted",
    }],
    previewPage: 0,
  });
  equal(
    analysis.duplicateCount,
    rowCount,
    "analysis must detect existing Instances from Workspace v2",
  );
  equal(analysis.returnedRows, 100);

  const savedRun = (await local.queryLocalWorkspaceV2(owner, {
    collection: "importRuns", where: { id: result.importRunId }, limit: 1,
  })).records[0];
  const description = await local.describeLocalWorkspaceV2(owner);
  await local.transactLocalWorkspaceV2(owner, {
    expectedRevision: description.revision,
    transactionId: `synthetic-interruption-${result.importRunId}`,
    put: [{ collection: "importRuns", record: { ...savedRun, status: "failed" } }],
  });
  const resumed = await batch.resumeStoredImportRun(owner, result.importRunId);
  equal(resumed.created, 0, "resume must skip already committed rows");
  equal(await countCollection("instances", { templateVersionId: version.id }), rowCount);
  equal(await countCollection("importRows", { importRunId: result.importRunId }), rowCount);

  const repository = await import("../server/formdigital/repository.ts");
  const firstPage = await repository.listInstancesPageForOwner(owner, null, 1_000);
  equal(firstPage.records.length, 1_000, "the product repository must page v2 instances");
  equal(typeof firstPage.nextCursor, "string");
  const secondPage = await repository.listInstancesPageForOwner(owner, firstPage.nextCursor, 1_000);
  equal(secondPage.records.length, 1);
  equal(secondPage.nextCursor, null);
  const selected = firstPage.records[0];
  const opened = await repository.getInstanceForOwner(owner, selected.id);
  equal(opened.instance.id, selected.id, "a CSV-created v2 instance must open in the product");
  await repository.saveInstanceValues(owner, selected.id, { name: "Updated" });
  equal((await repository.getInstanceForOwner(owner, selected.id)).instance.values.name, "Updated");
  const cloned = await repository.cloneInstanceForOwner(owner, selected.id, false);
  equal((await repository.getInstanceForOwner(owner, cloned.instanceId)).instance.values.name, "Updated");
  equal((await repository.updateInstanceStatus(owner, cloned.instanceId, "completed")).status, "completed");
  equal((await repository.deleteInstancesForOwner(owner, [cloned.instanceId])).deleted, 1);
  await assert.rejects(() => repository.getInstanceForOwner(owner, cloned.instanceId));
  assertions += 1;

  // --- R4-P3: Real stored-v2 CSV Table Import, Sanitization, Formula Eval, Export & Overwrite ---
  const tableCsv = 'StatementTable\n"[[100,200,""STALE_FORMULA_RESIDUAL""],[""STALE_FIXED"",""STALE_FIXED"",""STALE_FIXED""]]"\n';
  const uploadTable = await fetch(
    `${base}/api/v1/assets/raw?filename=table.csv&mimeType=text%2Fcsv&metadata=%257B%257D`,
    { method: "POST", headers: { ...headers, "content-type": "application/octet-stream" }, body: tableCsv },
  );
  equal(uploadTable.status, 201);
  const uploadedTable = await uploadTable.json();

  const tableInspected = await batch.inspectStoredCsv(owner, uploadedTable.asset.id);
  equal(tableInspected.totalRows, 1);

  // 1. Formal createStoredImportRun with table field mapping
  const tableImportRes = await batch.createStoredImportRun(owner, {
    templateVersionId: "version-table",
    sourceAssetId: uploadedTable.asset.id,
    sourceHash: tableInspected.sourceHash,
    decisions: [{ csvField: "StatementTable", templateStableFieldId: "statement_table", confidence: "high", decision: "accepted" }],
    mode: "tolerant",
  });
  equal(tableImportRes.created, 1);
  equal(tableImportRes.totalRows, 1);

  // 2. Read back Instance directly from v2 database
  const tableInstances = await local.queryLocalWorkspaceV2(owner, {
    collection: "instances", where: { templateVersionId: "version-table" }, limit: 10,
  });
  equal(tableInstances.records.length, 1);
  const tableInstance = tableInstances.records[0];

  // Verify raw authority stored values: writable inputs kept ("100", "200"), formula/fixed sanitized to ""!
  equal(
    tableInstance.values.statement_table,
    JSON.stringify([["100", "200", ""], ["", "", ""]]),
    "stored-v2 CSV import must sanitize formula and fixed residuals into empty strings"
  );
  const { sha256: domainSha256 } = await import("../server/formdigital/domain.ts");
  equal(tableInstance.valuesHash, domainSha256(tableInstance.values), "valuesHash must be calculated from sanitized values");

  // 3. Formula live calculation from stored raw authority
  const { resolveEffectiveTableGrid: resolveGrid } = await import("../shared/tableFormula.ts");
  const effectiveGrid = resolveGrid(
    workspace.fields.find(f => f.id === "field-table").definition,
    tableInstance.values.statement_table
  );
  equal(effectiveGrid.effectiveRows[0][0], "100");
  equal(effectiveGrid.effectiveRows[0][1], "200");
  equal(effectiveGrid.effectiveRows[0][2], "300.00", "formula cell must be live-evaluated from writable inputs");

  // 4. Structured JSON and CSV export verification
  const exportService = await import("../server/formdigital/exportService.ts");
  const jsonExport = await exportService.exportStructuredInstance(owner, tableInstance.id, "json");
  equal(typeof jsonExport.assetId, "string");
  const jsonAssetBytes = await (await import("../server/formdigital/assetStore.ts")).getOwnedAssetBytes(owner, jsonExport.assetId);
  const exportedJsonParsed = JSON.parse(Buffer.from(jsonAssetBytes.bytes).toString("utf8"));
  const exportedTableField = exportedJsonParsed.fields.find(f => f.id === "statement_table");
  equal(
    exportedTableField.value,
    JSON.stringify([["100", "200", "300.00"], ["", "", ""]]),
    "structured JSON export must contain live-evaluated formula value"
  );

  const csvExport = await exportService.exportStructuredInstance(owner, tableInstance.id, "csv");
  equal(typeof csvExport.assetId, "string");

  // 5. PDF rendering verification (overlay, full and editable)
  const { PDFDocument } = await import("pdf-lib");
  const bgDoc = await PDFDocument.create();
  bgDoc.addPage([595, 842]);
  const bgBytes = await bgDoc.save();
  const uploadBg = await fetch(
    `${base}/api/v1/assets/raw?filename=bg.pdf&mimeType=application%2Fpdf&metadata=%257B%257D`,
    { method: "POST", headers: { ...headers, "content-type": "application/octet-stream" }, body: bgBytes },
  );
  equal(uploadBg.status, 201);
  const uploadedBg = await uploadBg.json();

  const { loadLocalWorkspace, saveLocalWorkspace } = await import("../server/formdigital/localServiceClient.ts");
  const loaded = await loadLocalWorkspace(owner);
  const targetTv = loaded.workspace.templateVersions.find(v => v.id === "version-table");
  targetTv.pageManifest = [{ page: 1, widthMm: 210, heightMm: 297, assetId: uploadedBg.asset.id }];
  await saveLocalWorkspace(owner, loaded.workspace, loaded.revision);

  const pdfRenderer = await import("../server/formdigital/pdfRenderer.ts");
  const overlayPdf = await pdfRenderer.renderInstancePdf(owner, tableInstance.id, "overlay");
  equal(typeof overlayPdf.assetId, "string");
  const fullPdf = await pdfRenderer.renderInstancePdf(owner, tableInstance.id, "full");
  equal(typeof fullPdf.assetId, "string");
  const editPdf = await pdfRenderer.renderInstancePdf(owner, tableInstance.id, "editable");
  equal(typeof editPdf.assetId, "string");

  // 6. Duplicate overwrite with mergedValues containing new inputs and new stale residuals
  const uploadTable2 = await fetch(
    `${base}/api/v1/assets/raw?filename=table2.csv&mimeType=text%2Fcsv&metadata=%257B%257D`,
    { method: "POST", headers: { ...headers, "content-type": "application/octet-stream" }, body: tableCsv },
  );
  const uploadedTable2 = await uploadTable2.json();
  const tableInspected2 = await batch.inspectStoredCsv(owner, uploadedTable2.asset.id);

  const dupOverwriteRes = await batch.createStoredImportRun(owner, {
    templateVersionId: "version-table",
    sourceAssetId: uploadedTable2.asset.id,
    sourceHash: tableInspected2.sourceHash,
    decisions: [{ csvField: "StatementTable", templateStableFieldId: "statement_table", confidence: "high", decision: "accepted" }],
    mode: "tolerant",
    duplicateDecisions: [{
      rowNumber: 2,
      instanceId: tableInstance.id,
      action: "overwrite",
      mergedValues: {
        statement_table: JSON.stringify([
          ["500", "250", "NEW_STALE_FORMULA_RESIDUAL"],
          ["NEW_STALE_FIXED", "NEW_STALE_FIXED", ""],
        ]),
      },
    }],
  });
  equal(dupOverwriteRes.duplicate, 1);

  // Read back overwritten instance from v2 database
  const afterDupInstance = (await local.queryLocalWorkspaceV2(owner, {
    collection: "instances", where: { id: tableInstance.id }, limit: 1,
  })).records[0];
  equal(
    afterDupInstance.values.statement_table,
    JSON.stringify([["500", "250", ""], ["", "", ""]]),
    "stored-v2 duplicate overwrite must sanitize mergedValues table into raw authority"
  );
  equal(afterDupInstance.valuesHash, domainSha256(afterDupInstance.values));

  // 7. Malformed table raw data in stored-v2 CSV must fail closed
  const malformedTableCsv = 'StatementTable\n"[{},[""x"",{}]]"\n';
  const uploadMalformed = await fetch(
    `${base}/api/v1/assets/raw?filename=malformed.csv&mimeType=text%2Fcsv&metadata=%257B%257D`,
    { method: "POST", headers: { ...headers, "content-type": "application/octet-stream" }, body: malformedTableCsv },
  );
  const uploadedMalformed = await uploadMalformed.json();
  const inspectMalformed = await batch.inspectStoredCsv(owner, uploadedMalformed.asset.id);
  const malformedRunRes = await batch.createStoredImportRun(owner, {
    templateVersionId: "version-table",
    sourceAssetId: uploadedMalformed.asset.id,
    sourceHash: inspectMalformed.sourceHash,
    decisions: [{ csvField: "StatementTable", templateStableFieldId: "statement_table", confidence: "high", decision: "accepted" }],
    mode: "tolerant",
  });
  equal(malformedRunRes.failed, 1, "stored-v2 import must fail closed on malformed table JSON");
  equal(malformedRunRes.created, 0);

  // ===== R5-P4: real stored-v2 CSV table output / resume / correction evidence =====
  // The fixture is intentionally 3 columns (NOT the 4th-round-claimed 4): writable
  // col0/col1, formula col2 = A+B, and a fully-fixed second row (row1 is neither
  // writable nor formula, so its cells are the "fixed" role). The report must say so.
  const { tableCellRect } = await import("../shared/tableGeometry.ts");
  const { mmToPoint } = await import("../server/formdigital/pdfRenderer.ts");
  const { getOwnedAssetBytes } = await import("../server/formdigital/assetStore.ts");
  const tableField = workspace.fields.find(f => f.id === "field-table");
  const fc = tableField.coordinate;
  const fieldPos = {
    x: mmToPoint(fc.xMm),
    y: mmToPoint(297 - fc.yMm - fc.heightMm),
    width: mmToPoint(fc.widthMm),
    height: mmToPoint(fc.heightMm),
  };
  const tol = 14;
  const cellRect = (row, col) => {
    const r = tableCellRect(tableField.definition.tableCellGuides, 2, 3, row, col);
    const left = fieldPos.x + r.xRatio * fieldPos.width;
    const right = left + r.widthRatio * fieldPos.width;
    const top = fieldPos.y + (1 - r.yRatio) * fieldPos.height;
    const bottom = fieldPos.y + (1 - r.yRatio - r.heightRatio) * fieldPos.height;
    return { left, right, top, bottom };
  };
  const inRect = (rc, run) =>
    run.x >= rc.left - tol && run.x <= rc.right + tol && run.y >= rc.bottom - tol && run.y <= rc.top + tol;
  const inAnyRect = (rects, run) => rects.some(rc => inRect(rc, run));
  const populatedCells = [cellRect(0, 0), cellRect(0, 1), cellRect(0, 2)];
  const emptyCells = [cellRect(1, 0), cellRect(1, 1), cellRect(1, 2)];
  const formulaCell = cellRect(0, 2);

  const verifyTablePdf = (content, label) => {
    const runs = extractRunPositions(content);
    equal(runs.length, 3, `${label} PDF must render exactly 3 populated table-cell text runs (writable + formula)`);
    let inPopulated = 0, inEmpty = 0, inFormula = 0;
    for (const run of runs) {
      if (inAnyRect(populatedCells, run)) inPopulated += 1;
      if (inAnyRect(emptyCells, run)) inEmpty += 1;
      if (inRect(formulaCell, run)) inFormula += 1;
    }
    equal(inPopulated, 3, `${label} PDF: every text run sits inside a populated cell (writable+formula) — stale/fixed residuals are not rendered`);
    equal(inEmpty, 0, `${label} PDF: no text run lands in an empty/fixed cell (stale residual absent)`);
    equal(inFormula, 1, `${label} PDF: exactly one text run lands inside the formula-cell coordinate computed by shared tableCellRect()`);
  };

  // ===== R11-P1: production no-value twin baseline =====
  // The round-10 gate compared the populated output against a raw BLANK source
  // PDF. Production `drawTable()` draws a 0.4pt border rectangle around every
  // non-fixed cell, so that border (and any other non-value ink the renderer
  // emits) was being counted as "the value is visible". regression test proved the hole
  // with a 0.4pt border + Tr=3 invisible values: A/B/C all passed at 284/284/384
  // pixels. The baseline must therefore be produced by the SAME production
  // renderer, same mode, same background, same table geometry — with only the
  // expected values removed — so every non-value pixel cancels in the diff.
  //
  // The twin is created through the formal repository write path and rendered by
  // the formal `renderInstancePdf(owner, twinId, mode)`: same templateVersionId,
  // same page background, same field definition/coordinate/calibration. Its raw
  // table authority keeps the identical 2x3 shape with every writable cell set to
  // the empty string; nothing in the template definition is changed and no
  // `detectionSource` is added to dodge the borders.
  const TWIN_GRID = JSON.stringify([["", "", ""], ["", "", ""]]);
  const twinPdfBytes = new Map();
  const buildNoValueTwinBytes = async (mode) => {
    if (twinPdfBytes.has(mode)) return twinPdfBytes.get(mode);
    const twin = await repository.createInstanceFromPublishedVersion(owner, {
      templateVersionId: tableInstance.templateVersionId,
      name: `no-value-twin-${mode}`,
      values: { statement_table: TWIN_GRID },
    });
    equal(
      (await local.queryLocalWorkspaceV2(owner, {
        collection: "instances", where: { id: twin.instanceId }, limit: 1,
      })).records[0].values.statement_table,
      TWIN_GRID,
      `no-value twin (${mode}) must keep the same 2x3 raw authority with every writable cell empty`,
    );
    const twinGrid = resolveGrid(tableField.definition, TWIN_GRID);
    equal(
      JSON.stringify(twinGrid.effectiveRows),
      JSON.stringify([["", "", ""], ["", "", ""]]),
      `no-value twin (${mode}) must resolve to no cell value at all`,
    );
    const twinPdf = await pdfRenderer.renderInstancePdf(owner, twin.instanceId, mode);
    const { bytes } = await getOwnedAssetBytes(owner, twinPdf.assetId);
    const twinBytes = Buffer.from(bytes);

    // pdf.js must prove the twin carries none of the expected values and no
    // stale residual — otherwise it would not be a no-value baseline.
    const twinText = await extractPdfText(twinPdf.assetId);
    for (const value of ["100", "200", "300.00"]) {
      assert.ok(
        !twinText.fullText.includes(value),
        `R11-P1: no-value twin (${mode}) must NOT contain "${value}" (baseline must carry no expected glyph)`,
      );
      assertions += 1;
    }
    for (const residual of STALE_RESIDUALS) {
      assert.ok(
        !twinText.fullText.includes(residual),
        `R11-P1: no-value twin (${mode}) must NOT contain stale residual "${residual}"`,
      );
      assertions += 1;
    }
    twinPdfBytes.set(mode, twinBytes);
    return twinBytes;
  };

  // ===== R10-P1: real page-raster / pixel visibility =====
  // Visibility is decided ONLY by actual device pixels (see
  // assertRasterVisibleInCells + scripts/pdf-raster-visibility.mjs). The round-9
  // content-stream heuristic (analyzeTextVisibility) is retained for DIAGNOSTIC
  // LOGGING ONLY — it is not raster evidence and must never decide pass/fail.
  // Fixed raster pass/fail thresholds. These were derived from measurement, not
  // guessed: the positive control (normally rendered 100/200/300.00) produces
  // hundreds of differing pixels per cell, while all four negative controls produce
  // exactly 0. See the round-10 report for the full measurement table.
  const RASTER_MIN_DIFF_PIXELS = 120;
  const RASTER_MIN_OVERLAP = 0.1;
  const RASTER_MIN_SPAN_X = 12;
  const RASTER_MIN_SPAN_Y = 8;

  // Coordinate convention, established empirically in round 10 (NOT guessed):
  // pdf.js TextItem.transform[4]/[5] is the text ORIGIN (baseline) in PDF user
  // space and the glyph box extends UPWARD, so an item's PDF rect is
  // [x, y, x + width, y + height]. Conversion to canvas pixels always goes through
  // the authoritative pdf.js viewport transform.
  const cellValueItems = (pdfText, r, c) => {
    const its = pdfText.items.filter((it) => {
      const a = assignCellStrict(it);
      return a !== null && a.r === r && a.c === c && String(it.text ?? "").trim().length > 0;
    });
    its.sort((p, q) => p.x - q.x);
    return its;
  };

  const mergedItemBBox = (items) => ({
    x0: Math.min(...items.map((i) => i.x)),
    y0: Math.min(...items.map((i) => i.y)),
    x1: Math.max(...items.map((i) => i.x + i.width)),
    y1: Math.max(...items.map((i) => i.y + i.height)),
  });

  /**
   * R10-P1 RASTER visibility gate.
   *
   * Renders `pdfBytes` and `baselineBytes` with pdf.js inside a real headless
   * Chromium at RASTER_SCALE, extracts the ACTUAL RGBA pixels inside each expected
   * value's own text bounding box, and diffs them. A value only passes if it has
   * really put ink on the page: enough differing pixels, spanning a plausible glyph
   * area, overlapping the value's own text box.
   *
   * Text presence is not evidence: pdf.js happily extracts strings for Tr=3,
   * opacity=0 and clipped-away text, all of which rasterise to nothing.
   */
  const assertRasterVisibleInCells = async ({ session, pdfBytes, baselineBytes, pdfText, label }) => {
    const spec = [
      { r: 0, c: 0, name: "A", expected: "100" },
      { r: 0, c: 1, name: "B", expected: "200" },
      { r: 0, c: 2, name: "C", expected: "300.00" },
    ];
    const pdfRegions = [];
    for (const s of spec) {
      const its = cellValueItems(pdfText, s.r, s.c);
      assert.ok(its.length > 0, `${label}: cell ${s.name} has no value text item to raster-check`);
      const bb = mergedItemBBox(its);
      // Pad by 2pt so glyph antialiasing at the edges stays inside the compared area.
      pdfRegions.push({ x0: bb.x0 - 2, y0: bb.y0 - 2, x1: bb.x1 + 2, y1: bb.y1 + 2 });
      s.pdfBBox = bb;
    }
    const test = await session.rasterize(pdfBytes, { pdfRegions });
    const base = await session.rasterize(baselineBytes, { pdfRegions });

    const measurements = [];
    for (let i = 0; i < spec.length; i += 1) {
      const s = spec[i];
      const d = diffCrops(test.regions[i], base.regions[i]);
      const textCanvas = pdfRectToCanvasRect(
        test.transform, s.pdfBBox.x0, s.pdfBBox.y0, s.pdfBBox.x1, s.pdfBBox.y1,
      );
      const overlap = d.bbox ? rectOverlapRatio(textCanvas, d.bbox) : 0;
      measurements.push({
        cell: s.name,
        expected: s.expected,
        diffPixels: d.diffCount,
        diffBBox: d.bbox,
        textBBox: textCanvas,
        overlap,
      });

      assert.ok(
        d.diffCount >= RASTER_MIN_DIFF_PIXELS,
        `${label}: cell ${s.name} value "${s.expected}" must produce REAL ink — found only ` +
          `${d.diffCount} differing pixels in its text bbox (minimum ${RASTER_MIN_DIFF_PIXELS}). ` +
          `Raster-invisible text (Tr=3, opacity=0, clipped away) must be rejected.`,
      );
      assert.ok(
        overlap >= RASTER_MIN_OVERLAP,
        `${label}: cell ${s.name} differing pixels must substantially overlap the value's own text bbox ` +
          `(overlap ${overlap.toFixed(3)} < ${RASTER_MIN_OVERLAP}); stray ink elsewhere does not count.`,
      );
      assert.ok(
        d.width >= RASTER_MIN_SPAN_X && d.height >= RASTER_MIN_SPAN_Y,
        `${label}: cell ${s.name} differing pixels must span a plausible glyph area ` +
          `(got ${d.width}x${d.height}px, minimum ${RASTER_MIN_SPAN_X}x${RASTER_MIN_SPAN_Y}); ` +
          `a single speck or a one-pixel line is not a rendered value.`,
      );
    }
    return measurements;
  };

  // R6-P3: verify REAL rendered PDF TEXT (not only glyph coordinates) using pdfjs-dist.
  // This proves the cells actually carry the live-evaluated values 100/200/300.00 and
  // that no stale residual survives into the generated PDFs.
  async function extractPdfTextBytes(bytes) {
    const { getDocument, GlobalWorkerOptions } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    GlobalWorkerOptions.workerSrc = pathToFileURL(
      path.join(root, "node_modules", "pdfjs-dist", "legacy", "build", "pdf.worker.mjs"),
    ).href;
    const standardFontDataUrl = `${path
      .join(root, "node_modules", "pdfjs-dist", "standard_fonts")
      .replaceAll("\\", "/")}/`;
    const loadingTask = getDocument({ data: new Uint8Array(bytes), standardFontDataUrl });
    const pdfJsDocument = await loadingTask.promise;
    try {
      const page1 = await pdfJsDocument.getPage(1);
      const content = await page1.getTextContent();
      const items = content.items
        .filter(item => "str" in item)
        .map(item => ({
          text: item.str,
          x: item.transform[4],
          y: item.transform[5],
          width: item.width,
          height: item.height,
        }));
      const fullText = items.map(i => i.text).join(" ");
      return { items, fullText };
    } finally {
      await pdfJsDocument.destroy();
    }
  }

  async function extractPdfText(assetId) {
    const { getOwnedAssetBytes } = await import("../server/formdigital/assetStore.ts");
    const { bytes } = await getOwnedAssetBytes(owner, assetId);
    return extractPdfTextBytes(bytes);
  }

  const STALE_RESIDUALS = ["STALE_FORMULA_RESIDUAL", "STALE_FIXED", "NEW_STALE_FORMULA_RESIDUAL"];

  // R7-P2: bind each rendered value to its EXACT table cell. Real pdf.js text items
  // are grouped into cells via the production tableCellRect() geometry, merged per
  // cell (sorted by x), and compared exactly. A swap of values between cells (e.g.
  // 100<->300.00) makes the exact-equality assertion fail, so the verifier can no
  // longer be fooled by a value-set + position-set that merely overlap.
  const EXPECTED_CELL = {
    "0,0": "100",
    "0,1": "200",
    "0,2": "300.00",
  };
  // ===== R8-P2: strict cell-containment binding (replaces the nearest-centre bug) =====
  // Each rendered VALUE must be PROVABLY inside its exact table cell. We compute the six
  // real cell rectangles via production tableCellRect(), then require every pdf.js text
  // item's actual bounding box to lie within a single cell (≤1pt float slack). An item
  // that is outside every cell, or that straddles more than one cell, fails the
  // verification instead of being force-assigned to the nearest centre.
  //
  // The unresolved/out-of-cell check is scoped to value-bearing items only (the three
  // expected strings), so legitimate page text from other fields/labels — which lives
  // outside the table — does not trip a false failure.
  const EPS = 1; // maximal permitted float/placement slack, in PDF points
  const ALL_CELLS = [];
  for (let r = 0; r < 2; r += 1) {
    for (let c = 0; c < 3; c += 1) ALL_CELLS.push({ r, c, rc: cellRect(r, c) });
  }
  const EXPECTED_VALUES = new Set(Object.values(EXPECTED_CELL));
  const containsCell = (rc, it) => {
    const x = Number(it.x);
    const y = Number(it.y);
    const w = Number(it.width);
    const h = Number(it.height);
    // Finite guard: NaN / Infinity can never be inside a finite cell rectangle.
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) {
      return false;
    }
    // A real glyph box must have strictly positive extent. Zero or negative
    // width/height is degenerate / invisible — reject it instead of washing the
    // sign away (the old Math.max(0, width) wash is what this round closes).
    if (w <= 0 || h <= 0) return false;
    // Two-endpoint normalization: a legitimately negative width (origin at the
    // right edge) is honoured by its true extents, never force-clamped to 0.
    const left = Math.min(x, x + w);
    const right = Math.max(x, x + w);
    const bottom = Math.min(y, y - h);
    const top = Math.max(y, y - h);
    const hOk = left >= rc.left - EPS && right <= rc.right + EPS;
    const vOk = bottom >= rc.bottom - EPS && top <= rc.top + EPS;
    return hOk && vOk;
  };
  const assignCellStrict = (it) => {
    const hits = ALL_CELLS.filter(cell => containsCell(cell.rc, it));
    return hits.length === 1 ? hits[0] : null;
  };
  const cellTextOf = (pdfText, r, c) => {
    const its = pdfText.items.filter(it => {
      const a = assignCellStrict(it);
      return a !== null && a.r === r && a.c === c;
    });
    its.sort((p, q) => p.x - q.x);
    // pdf.js may emit whitespace-only items or trailing spaces; trim and drop them
    // so the merged cell text reflects the actual value (a genuine swap still fails).
    return its.map(i => String(i.text).trim()).filter(s => s.length > 0).join("");
  };
  const verifyTablePdfText = (pdfText, label) => {
    let added = 0;
    // (0) Every value-bearing item must sit inside EXACTLY one cell. A value rendered
    //     outside every cell (e.g. 10pt past the left edge) or spanning two cells is
    //     an immediate failure — never a silent nearest-centre assignment.
    const strayValues = pdfText.items.filter(it => {
      const text = String(it.text ?? "").trim();
      if (!EXPECTED_VALUES.has(text)) return false;
      return assignCellStrict(it) === null;
    });
    assert.ok(
      strayValues.length === 0,
      `${label} PDF: ${strayValues.length} value text item(s) fall outside every table cell or span multiple cells ` +
        `(strict containment, ≤${EPS}pt slack): ` +
        strayValues.map(i => JSON.stringify({ text: i.text, x: i.x, y: i.y, w: i.width, h: i.height })).join("; "),
    );
    added += 1;
    // (a) Each value is bound to its exact cell; the merged cell text must equal it.
    for (const [key, expected] of Object.entries(EXPECTED_CELL)) {
      const [r, c] = key.split(",").map(Number);
      const got = cellTextOf(pdfText, r, c);
      equal(got, expected, `${label} PDF: cell (${r},${c}) must render exactly "${expected}" (got "${got}")`);
      added += 1;
      // No other expected value may co-exist in this cell.
      for (const other of Object.values(EXPECTED_CELL)) {
        if (other === expected) continue;
        assert.ok(!got.includes(other), `${label} PDF: cell (${r},${c}) must NOT contain "${other}" (got "${got}")`);
        added += 1;
      }
    }
    // (b) Full text must still contain every value (sanity), and no stale residual.
    assert.ok(pdfText.fullText.includes("100"), `${label} PDF text must contain writable cell A = 100`);
    added += 1;
    assert.ok(pdfText.fullText.includes("200"), `${label} PDF text must contain writable cell B = 200`);
    added += 1;
    assert.ok(pdfText.fullText.includes("300.00"), `${label} PDF text must contain live-evaluated formula cell C = 300.00`);
    added += 1;
    for (const residual of STALE_RESIDUALS) {
      assert.ok(!pdfText.fullText.includes(residual), `${label} PDF text must NOT contain stale residual "${residual}"`);
      added += 1;
    }
    // (c) Empty/fixed row cells must carry no table value at all.
    for (const [r, c] of [[1, 0], [1, 1], [1, 2]]) {
      const got = cellTextOf(pdfText, r, c);
      assert.ok(!["100", "200", "300.00"].some(v => got.includes(v)), `${label} PDF: empty cell (${r},${c}) must not contain a table value (got "${got}")`);
      added += 1;
    }
    // (d) R10-P1: visibility is NOT decided here. Text presence proves nothing —
    //     pdf.js extracts strings for Tr=3, opacity=0 and clipped-away text alike.
    //     Visibility is decided exclusively by assertRasterVisibleInCells(), which
    //     compares real device pixels from a genuine rasterisation.
    assertions += added;
  };

  // 3. Read back structured JSON + CSV asset BYTES; assert writable / live formula / no stale residual.
  const jsonBytes = Buffer.from((await getOwnedAssetBytes(owner, jsonExport.assetId)).bytes).toString("utf8");
  assert.ok(jsonBytes.includes("300.00"), "structured JSON export bytes must contain the live-evaluated formula value 300.00");
  assert.ok(!jsonBytes.includes("STALE_FORMULA_RESIDUAL"), "structured JSON export bytes must not contain the formula stale residual");
  assert.ok(!jsonBytes.includes("STALE_FIXED"), "structured JSON export bytes must not contain the fixed stale residual");
  assertions += 3;

  const csvBytes = Buffer.from((await getOwnedAssetBytes(owner, csvExport.assetId)).bytes).toString("utf8");
  assert.ok(csvBytes.includes("300.00"), "CSV export bytes must contain the live-evaluated formula value 300.00");
  assert.ok(!csvBytes.includes("STALE_FORMULA_RESIDUAL"), "CSV export bytes must not contain the formula stale residual");
  assert.ok(!csvBytes.includes("STALE_FIXED"), "CSV export bytes must not contain the fixed stale residual");
  assertions += 3;

  // 4. Read back overlay / full / editable PDF bytes; verify geometry + no AcroForm widget.
  verifyTablePdf(await extractPdfContent(owner, overlayPdf.assetId), "overlay");
  verifyTablePdf(await extractPdfContent(owner, fullPdf.assetId), "full");
  const editContent = await extractPdfContent(owner, editPdf.assetId);
  verifyTablePdf(editContent, "editable");
  assert.ok(!editContent.includes("/AcroForm"), "editable PDF table must not carry an AcroForm widget (rendered as static text in editable mode)");
  assertions += 1;

  // ===== R7-P2 negative probe: a value swap (A<->C) MUST be rejected by the verifier =====
  {
    const cellCenter = (r, c) => {
      const rc = cellRect(r, c);
      return { x: (rc.left + rc.right) / 2, y: (rc.top + rc.bottom) / 2 };
    };
    const a = cellCenter(0, 0); // A should be 100
    const c = cellCenter(0, 2); // C (formula) should be 300.00
    // Swap: put 300.00 where 100 belongs and 100 where 300.00 belongs.
    const swapItems = [
      { text: "300.00", x: a.x, y: a.y, width: 10, height: 10 },
      { text: "200", x: cellCenter(0, 1).x, y: cellCenter(0, 1).y, width: 10, height: 10 },
      { text: "100", x: c.x, y: c.y, width: 10, height: 10 },
    ];
    const swapPdfText = { items: swapItems, fullText: swapItems.map(i => i.text).join(" ") };
    let caught = false;
    try {
      verifyTablePdfText(swapPdfText, "swap-probe");
    } catch {
      caught = true;
    }
    assert.ok(caught, "R7-P2 verifier MUST FAIL when 100/300.00 are swapped between cells A and C");
    assertions += 1;
  }

  // ===== R8-P2 negative probe 1: a value rendered OUTSIDE its cell (10pt past A's left
  // edge, but vertically aligned with A's centre so it stays "closest" to A under the OLD
  // nearest-centre logic) MUST be rejected. fullText still contains all three values, so
  // the old verifier could be fooled; the strict-containment verifier must not. =====
  {
    const rcA = cellRect(0, 0);
    const aCenter = { x: (rcA.left + rcA.right) / 2, y: (rcA.top + rcA.bottom) / 2 };
    const cellCentre = (r, c) => {
      const rc = cellRect(r, c);
      return { x: (rc.left + rc.right) / 2, y: (rc.top + rc.bottom) / 2 };
    };
    const outOfCellItems = [
      // 100 sits 10pt LEFT of A's left boundary, vertically on A's centre.
      { text: "100", x: rcA.left - 10, y: aCenter.y, width: 10, height: 10 },
      { text: "200", x: cellCentre(0, 1).x, y: cellCentre(0, 1).y, width: 10, height: 10 },
      { text: "300.00", x: cellCentre(0, 2).x, y: cellCentre(0, 2).y, width: 10, height: 10 },
    ];
    const outOfCellPdfText = { items: outOfCellItems, fullText: outOfCellItems.map(i => i.text).join(" ") };
    let outCaught = false;
    try {
      verifyTablePdfText(outOfCellPdfText, "out-of-cell-probe");
    } catch {
      outCaught = true;
    }
    assert.ok(
      outCaught,
      "R8-P2 verifier MUST FAIL when a value (100) is rendered 10pt outside its cell yet fullText still holds all three values",
    );
    assertions += 1;
  }

  // ===== R8-P2 negative probe 2: a CLIPPED / straddling value whose bounding box crosses a
  // cell boundary (here it sits astride the A|B border and fits in NEITHER cell) MUST be
  // rejected. It is neither cleanly inside one cell nor fully outside all cells, so the
  // strict verifier must refuse the silent assignment. =====
  {
    const rcA = cellRect(0, 0);
    const rcB = cellRect(0, 1);
    const centerY = (rcA.top + rcA.bottom) / 2;
    const boundaryX = (rcA.right + rcB.left) / 2; // = shared A|B edge
    const straddleItems = [
      // 100 spans 30pt centred on the A|B boundary → overlaps both, fits in neither.
      { text: "100", x: boundaryX - 15, y: centerY, width: 30, height: 10 },
      { text: "200", x: (rcB.left + rcB.right) / 2, y: centerY, width: 10, height: 10 },
      { text: "300.00", x: (rcB.right + cellRect(0, 2).right) / 2, y: centerY, width: 10, height: 10 },
    ];
    const straddlePdfText = { items: straddleItems, fullText: straddleItems.map(i => i.text).join(" ") };
    let strCaught = false;
    try {
      verifyTablePdfText(straddlePdfText, "clipped-probe");
    } catch {
      strCaught = true;
    }
    assert.ok(strCaught, "R8-P2 verifier MUST FAIL when a value (100) straddles two cells (clipped by the boundary)");
    assertions += 1;
  }

  // ===== R9-P1 negative probe 5: NEGATIVE width must be rejected. The OLD verifier
  // washed the width via Math.max(0, width), turning a box that ends 19.5pt OUTSIDE
  // cell A into an (x, x) point that it falsely accepted. =====
  {
    const rcA = cellRect(0, 0);
    const aCenter = { x: (rcA.left + rcA.right) / 2, y: (rcA.top + rcA.bottom) / 2 };
    const cellCentre = (r, c) => {
      const rc = cellRect(r, c);
      return { x: (rc.left + rc.right) / 2, y: (rc.top + rc.bottom) / 2 };
    };
    const negWidthItems = [
      // 100 drawn with a NEGATIVE width (-20) whose far end sits 19.5pt left of A.
      { text: "100", x: rcA.left + 0.5, y: aCenter.y, width: -20, height: 10 },
      { text: "200", x: cellCentre(0, 1).x, y: cellCentre(0, 1).y, width: 10, height: 10 },
      { text: "300.00", x: cellCentre(0, 2).x, y: cellCentre(0, 2).y, width: 10, height: 10 },
    ];
    const negWidthPdfText = { items: negWidthItems, fullText: negWidthItems.map(i => i.text).join(" ") };
    let negCaught = false;
    try {
      verifyTablePdfText(negWidthPdfText, "negative-width-probe");
    } catch {
      negCaught = true;
    }
    assert.ok(negCaught, "R9-P1 verifier MUST REJECT a value drawn with a negative width (box ends outside its cell)");
    assertions += 1;
  }

  // ===== R9-P1 negative probe 6: ZERO range (width=0,height=0) must be rejected. The
  // OLD verifier washed the degenerate box to a point at the cell centre and falsely
  // accepted it. =====
  {
    const cellCentre = (r, c) => {
      const rc = cellRect(r, c);
      return { x: (rc.left + rc.right) / 2, y: (rc.top + rc.bottom) / 2 };
    };
    const zeroRangeItems = [
      { text: "100", x: cellCentre(0, 0).x, y: cellCentre(0, 0).y, width: 0, height: 0 },
      { text: "200", x: cellCentre(0, 1).x, y: cellCentre(0, 1).y, width: 0, height: 0 },
      { text: "300.00", x: cellCentre(0, 2).x, y: cellCentre(0, 2).y, width: 0, height: 0 },
    ];
    const zeroRangePdfText = { items: zeroRangeItems, fullText: zeroRangeItems.map(i => i.text).join(" ") };
    let zeroCaught = false;
    try {
      verifyTablePdfText(zeroRangePdfText, "zero-range-probe");
    } catch {
      zeroCaught = true;
    }
    assert.ok(zeroCaught, "R9-P1 verifier MUST REJECT a value with zero width/height (degenerate, invisible glyph box)");
    assertions += 1;
  }

  // ===== R9-P1 negative probe 7: SPLIT value fragments. (a) Two adjacent in-cell
  // fragments that merge to the exact value MUST pass; (b) moving one fragment
  // out-of-cell / across a border MUST be rejected. =====
  {
    const cellCentre = (r, c) => {
      const rc = cellRect(r, c);
      return { x: (rc.left + rc.right) / 2, y: (rc.top + rc.bottom) / 2 };
    };
    const aC = cellCentre(0, 0);
    const bC = cellCentre(0, 1);
    const cC = cellCentre(0, 2);
    // (a) split 300.00 into "300." + "00", both inside cell C and adjacent.
    const splitInItems = [
      { text: "100", x: aC.x, y: aC.y, width: 10, height: 10 },
      { text: "200", x: bC.x, y: bC.y, width: 10, height: 10 },
      { text: "300.", x: cC.x - 6, y: cC.y, width: 8, height: 10 },
      { text: "00", x: cC.x + 4, y: cC.y, width: 6, height: 10 },
    ];
    // fullText reflects the MERGED logical value (as the production sanity check
    // expects); the geometry/merge gate below is what proves the split is accepted.
    const splitInPdfText = { items: splitInItems, fullText: "100 200 300.00" };
    let splitInPassed = false;
    try {
      verifyTablePdfText(splitInPdfText, "split-in-cell-probe");
      splitInPassed = true;
    } catch {
      splitInPassed = false;
    }
    assert.ok(splitInPassed, "R9-P1 verifier MUST ACCEPT a value split into adjacent in-cell fragments that merge exactly (300.00)");
    assertions += 1;
    // (b) same split but the "00" fragment moved out of cell C (across the right border).
    const rcC = cellRect(0, 2);
    const outX = rcC.right + 12;
    const splitOutItems = [
      { text: "100", x: aC.x, y: aC.y, width: 10, height: 10 },
      { text: "200", x: bC.x, y: bC.y, width: 10, height: 10 },
      { text: "300.", x: cC.x - 6, y: cC.y, width: 8, height: 10 },
      { text: "00", x: outX, y: cC.y, width: 6, height: 10 },
    ];
    const splitOutPdfText = { items: splitOutItems, fullText: splitOutItems.map(i => i.text).join(" ") };
    let splitOutCaught = false;
    try {
      verifyTablePdfText(splitOutPdfText, "split-out-cell-probe");
    } catch {
      splitOutCaught = true;
    }
    assert.ok(splitOutCaught, "R9-P1 verifier MUST REJECT a split value when a fragment is moved out of / across its cell");
    assertions += 1;
  }

  // ===== R10-P1: REAL page-raster / pixel visibility controls =====
  // The round-9 gate was a hand-written content-stream heuristic; it could be
  // satisfied by a visible blank run standing in for an invisible value, it missed
  // real ExtGState opacity, and it mis-classified rendering modes. Visibility is now
  // decided by ACTUAL device pixels from a genuine rasterisation.
  //
  // For every control we first prove the OLD geometry-only verifier still ACCEPTS
  // it (that is the hole), then require the raster verifier to give the right answer.
  //
  //   1. visible       — POSITIVE control: normally drawn 100/200/300.00 (must pass)
  //   2. tr3           — rendering mode Tr=3, no ink
  //   3. opacity0      — pdf-lib drawText({ opacity: 0 }); content must carry /GS.. gs
  //   4. clipaway      — a REAL clipping path removes all three values
  //   5. blankThenTr3  — a VISIBLE blank run first, then the value in Tr=3
  //
  // R11-P1 adds three more, all with the SAME 0.4pt cell borders that production
  // `drawTable()` draws (the ink that fooled the round-10 blank baseline):
  //   6. borderOnly        — borders only, no values (matched baseline for 7 and 8)
  //   7. borderThenTr3     — borders + Tr=3 invisible values (must be rejected)
  //   8. borderThenVisible — borders + normally drawn values (must pass)
  const rasterMeasurements = {};
  const rasterRejections = {};

  // The production table renderer draws, for every non-fixed cell:
  //   page.drawRectangle({ x, y, width, height,
  //                        borderColor: rgb(0.6, 0.62, 0.66), borderWidth: 0.4 })
  // and then the value at the cell's own bottom-left origin (x + 2, y + 1) — see
  // drawTable() / drawPlainText() in server/formdigital/pdfRenderer.ts.
  //
  // These controls reproduce BOTH kinds of non-value ink that a renderer can put
  // next to an expected value:
  //   (1) the production 0.4pt cell rectangle (bottom/left edges sit 1-2pt from
  //       the value's baseline, i.e. inside the padded text-bbox crop), and
  //   (2) a 0.4pt rectangle drawn tightly AROUND the value's expected glyph box,
  //       which is the geometry regression test used for the counterexample.
  // The matched baseline draws the identical ink, so it cancels in the diff.
  // drawPlainText() puts the baseline at `box.y + box.height - fontSize`, and
  // drawTable() hands it the cell inset by 2pt/1pt — so the baseline lands
  // `1pt + fontSize` below the cell's TOP edge. That is where the production
  // value sits, which is why the cell's top border falls inside the padded
  // text-bbox crop and can masquerade as the value's ink.
  const borderValueOrigin = (r, c) => {
    const rc = cellRect(r, c);
    return { x: rc.left + 2, y: rc.top - 1 - 12 };
  };

  const drawTableBorders = (page, font) => {
    for (const [text, r, c] of [["100", 0, 0], ["200", 0, 1], ["300.00", 0, 2]]) {
      const rc = cellRect(r, c);
      page.drawRectangle({
        x: rc.left,
        y: rc.bottom,
        width: rc.right - rc.left,
        height: rc.top - rc.bottom,
        borderColor: rgb(0.6, 0.62, 0.66),
        borderWidth: 0.4,
      });
      const origin = borderValueOrigin(r, c);
      const glyphWidth = font.widthOfTextAtSize(text, 12);
      const glyphHeight = font.heightAtSize(12);
      page.drawRectangle({
        x: origin.x - 1,
        y: origin.y - 1,
        width: glyphWidth + 2,
        height: glyphHeight + 2,
        borderColor: rgb(0, 0, 0),
        borderWidth: 0.4,
      });
    }
  };

  const buildControlPdfBytes = async (mode) => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const values = [["100", 0, 0], ["200", 0, 1], ["300.00", 0, 2]];
    if (mode === "borderOnly" || mode === "borderThenTr3" || mode === "borderThenVisible") {
      drawTableBorders(page, font);
    }
    for (const [text, r, c] of values) {
      if (mode === "blank" || mode === "borderOnly") continue;
      const rc = cellRect(r, c);
      // The border controls place the value where production places it: the
      // cell's own bottom-left origin, 2pt in and 1pt up.
      const origin =
        mode === "borderThenTr3" || mode === "borderThenVisible"
          ? borderValueOrigin(r, c)
          : { x: (rc.left + rc.right) / 2, y: (rc.top + rc.bottom) / 2 };
      const cx = origin.x;
      const cy = origin.y;
      if (mode === "visible") {
        page.drawText(text, { x: cx, y: cy, size: 12, font });
      } else if (mode === "tr3") {
        page.pushOperators(setTextRenderingMode(TextRenderingMode.Invisible));
        page.drawText(text, { x: cx, y: cy, size: 12, font });
      } else if (mode === "opacity0") {
        page.drawText(text, { x: cx, y: cy, size: 12, font, opacity: 0 });
      } else if (mode === "clipaway") {
        // REAL clipping path: clip to a small rectangle in the bottom-left corner,
        // far from every table cell, then draw the values. They are clipped away
        // completely even though pdf.js still extracts them.
        page.pushOperators(pushGraphicsState());
        page.pushOperators(moveTo(5, 5), lineTo(40, 5), lineTo(40, 40), lineTo(5, 40), closePath(), clip(), endPath());
        page.drawText(text, { x: cx, y: cy, size: 12, font });
        page.pushOperators(popGraphicsState());
      } else if (mode === "blankThenTr3") {
        // A VISIBLE blank/space run first — precisely what satisfied the round-9
        // gate while the real value stayed invisible.
        page.pushOperators(setTextRenderingMode(TextRenderingMode.Fill));
        page.drawText(" ", { x: cx, y: cy, size: 12, font });
        page.pushOperators(setTextRenderingMode(TextRenderingMode.Invisible));
        page.drawText(text, { x: cx, y: cy, size: 12, font });
      } else if (mode === "borderThenTr3") {
        // regression test's counterexample: the values are really invisible, but the
        // matched borders supply plenty of non-value ink inside the text bbox.
        page.pushOperators(setTextRenderingMode(TextRenderingMode.Invisible));
        page.drawText(text, { x: cx, y: cy, size: 12, font });
      } else if (mode === "borderThenVisible") {
        // Positive control: same borders, values genuinely drawn.
        page.drawText(text, { x: cx, y: cy, size: 12, font });
      }
    }
    return doc.save();
  };

  {
    const { getOwnedAssetBytes } = await import("../server/formdigital/assetStore.ts");
    const session = await createRasterSession({ scale: RASTER_SCALE });
    try {
      const blankBytes = await buildControlPdfBytes("blank");
      // Matched baseline for the border controls: IDENTICAL non-value ink.
      const borderOnlyBytes = await buildControlPdfBytes("borderOnly");

      for (const [mode, mustPass] of [
        ["visible", true],
        ["tr3", false],
        ["opacity0", false],
        ["clipaway", false],
        ["blankThenTr3", false],
        ["borderThenTr3", false],
        ["borderThenVisible", true],
      ]) {
        const bytes = await buildControlPdfBytes(mode);
        const pdfText = await extractPdfTextBytes(bytes);
        // R11-P1: a control whose non-value ink is drawn by the renderer must be
        // diffed against a baseline carrying that SAME ink. The raw blank source
        // PDF is no longer an acceptable baseline for such a control.
        const baselineBytes =
          mode === "borderThenTr3" || mode === "borderThenVisible" ? borderOnlyBytes : blankBytes;

        // (i) The OLD geometry-only verifier must still ACCEPT every control:
        //     values present, in the right cells, with positive sizes.
        let geoOnlyPassed = false;
        try {
          verifyTablePdfText(pdfText, mode + "-geometry-only");
          geoOnlyPassed = true;
        } catch {
          geoOnlyPassed = false;
        }
        assert.ok(
          geoOnlyPassed,
          `R10-P1 precondition: the geometry-only verifier MUST still accept the "${mode}" control ` +
            `(otherwise the probe does not demonstrate the gap the raster gate closes)`,
        );
        assertions += 1;

        // (ii) Control-specific authenticity evidence.
        if (mode === "opacity0") {
          const c = await extractPdfContentBytes(bytes);
          assert.ok(
            /\/GS/.test(c) && /gs/.test(c),
            "R10-P1: the opacity=0 control must apply real ExtGState transparency (/GS.. gs) in the content stream",
          );
          assertions += 1;
        }
        if (mode === "clipaway") {
          // pdf.js must still extract the correct strings with positive size.
          for (const [r, c, expected] of [[0, 0, "100"], [0, 1, "200"], [0, 2, "300.00"]]) {
            const its = cellValueItems(pdfText, r, c);
            const merged = its.map((i) => String(i.text).trim()).join("");
            assert.ok(
              merged.includes(expected) && its.length > 0 && its.every((i) => i.width > 0 && i.height > 0),
              `R10-P1: the clipped-away control must still extract "${expected}" with positive size (got "${merged}")`,
            );
            assertions += 1;
          }
        }

        // (ii-b) DIAGNOSTIC ONLY — what the round-9 content-stream heuristic would
        // have concluded. Logged purely to document that it is fooled; it never
        // decides pass/fail. (This is the "old gate" regression test showed to be falsely green.)
        {
          const c = await extractPdfContentBytes(bytes);
          const runs = analyzeTextVisibility(c);
          const perCell = [cellRect(0, 0), cellRect(0, 1), cellRect(0, 2)].map((rc) =>
            runs.filter(
              (r) => r.visible && r.x >= rc.left - tol && r.x <= rc.right + tol && r.y >= rc.bottom - tol && r.y <= rc.top + tol,
            ).length,
          );
          console.log(
            `[diagnostic] round9-heuristic ${mode}: visibleRunsPerCell=${JSON.stringify(perCell)} ` +
              `(DIAGNOSTIC ONLY — never used to pass or fail)`,
          );
        }

        // (ii-c) R11-P1 RED EVIDENCE — run the ROUND-10 gate (blank baseline) on
        // the border control. It must be FOOLED: the 0.4pt borders alone satisfy
        // every threshold, which is exactly the hole regression test demonstrated. These
        // numbers are recorded for the report and never used to pass anything.
        if (mode === "borderThenTr3") {
          let redRows = null;
          let redError = null;
          try {
            redRows = await assertRasterVisibleInCells({
              session, pdfBytes: bytes, baselineBytes: blankBytes, pdfText,
              label: "borderThenTr3-vs-blank",
            });
          } catch (e) {
            redError = String((e && e.message) || e);
          }
          assert.ok(
            redRows !== null,
            `R11-P1 RED: the round-10 blank-baseline gate MUST be fooled by matched 0.4pt borders ` +
              `+ invisible values (that is the defect being fixed) — ${redError ?? ""}`,
          );
          assertions += 1;
          for (const m of redRows) {
            console.log(
              `[raster] RED blank-baseline borderThenTr3 cell ${m.cell} (${m.expected}): ` +
                `diffPixels=${m.diffPixels} diffBBox=${JSON.stringify(m.diffBBox)} ` +
                `textBBox=${JSON.stringify(m.textBBox)} overlap=${m.overlap.toFixed(3)}`,
            );
            assert.ok(
              m.diffPixels >= RASTER_MIN_DIFF_PIXELS &&
                m.overlap >= RASTER_MIN_OVERLAP &&
                (m.diffBBox.x1 - m.diffBBox.x0) >= RASTER_MIN_SPAN_X &&
                (m.diffBBox.y1 - m.diffBBox.y0) >= RASTER_MIN_SPAN_Y,
              `R11-P1 RED: cell ${m.cell} must have been falsely accepted by the blank-baseline gate ` +
                `(diffPixels ${m.diffPixels}, overlap ${m.overlap.toFixed(3)})`,
            );
            assertions += 1;
          }
        }

        // (iii) The raster verifier decides, from real pixels, against the MATCHED baseline.
        let rasterPassed = false;
        let detail = null;
        try {
          detail = await assertRasterVisibleInCells({
            session, pdfBytes: bytes, baselineBytes, pdfText, label: mode,
          });
          rasterPassed = true;
        } catch (e) {
          rasterPassed = false;
          rasterRejections[mode] = String((e && e.message) || e);
        }
        if (mustPass) {
          assert.ok(
            rasterPassed,
            `R10-P1: the positive control ("${mode}") MUST pass the raster visibility gate — ${rasterRejections[mode] ?? ""}`,
          );
        } else {
          assert.ok(
            !rasterPassed,
            `R10-P1: raster verifier MUST REJECT the "${mode}" control — its values put no ink on the page`,
          );
        }
        assertions += 1;
        if (detail) rasterMeasurements[mode] = detail;
      }

      // R6-P3 + R10-P1 + R11-P1: production output (overlay / full / editable) must
      // satisfy exact text, unique cell containment AND real raster visibility.
      //
      // R11-P1: each mode is diffed against its OWN production no-value twin —
      // same renderer, same mode, same background, same table geometry, same 0.4pt
      // cell borders — so every non-value pixel cancels. Only then can the
      // remaining pixels be attributed to 100 / 200 / 300.00. Baselines are never
      // shared across modes and the raw blank source PDF is never used here.
      for (const [assetId, label] of [
        [overlayPdf.assetId, "overlay"],
        [fullPdf.assetId, "full"],
        [editPdf.assetId, "editable"],
      ]) {
        const pdfText = await extractPdfText(assetId);
        // Proves the populated output still carries exactly the three values, each
        // uniquely inside A / B / C.
        verifyTablePdfText(pdfText, label);
        const { bytes } = await getOwnedAssetBytes(owner, assetId);
        const twinBytes = await buildNoValueTwinBytes(label);
        assert.ok(
          twinBytes.length > 0 && !twinBytes.equals(Buffer.from(bytes)),
          `R11-P1: the ${label} no-value twin must be a real, different PDF produced by the same renderer`,
        );
        assertions += 1;
        rasterMeasurements[label] = await assertRasterVisibleInCells({
          session, pdfBytes: Buffer.from(bytes), baselineBytes: twinBytes, pdfText, label,
        });
        assertions += 1;
        // AcroForm / stale-residual assertions already covered by verifyTablePdf.
      }
    } finally {
      await session.close();
    }
  }

  // ===== R11-P2: a raster session startup failure must clean up after itself =====
  // Round 10 let the HTTP server reach `listen()` before `chromium.launch()` /
  // `newPage()`. If either threw, no session object existed yet, so `close()` could
  // never run and the listener (and a launched browser) could survive. The probe
  // below drives the test-only injection point and proves the cleanup.
  {
    const portIsListening = (port) =>
      new Promise((resolve) => {
        const socket = net.connect({ host: "127.0.0.1", port });
        const finish = (value) => {
          socket.destroy();
          resolve(value);
        };
        socket.setTimeout(2_000, () => finish(false));
        socket.once("connect", () => finish(true));
        socket.once("error", () => finish(false));
      });

    // Only Playwright's own headless-browser image names are counted. The user's
    // desktop Chrome is also "chrome.exe", so counting that name would make the
    // assertion depend on unrelated browser activity.
    const browserProcessCount = () => {
      if (process.platform !== "win32") return null;
      const listed = spawnSync("tasklist", [], { encoding: "utf8", windowsHide: true });
      if (listed.error || typeof listed.stdout !== "string" || !listed.stdout) return null;
      const output = listed.stdout.toLowerCase();
      return ["chrome-headless-shell.exe", "headless_shell.exe"].reduce(
        (total, name) => total + (output.split(name).length - 1),
        0,
      );
    };

    for (const failureMode of ["launch", "newPage"]) {
      const before = browserProcessCount();
      const probe = { port: 0, browser: null, page: null };
      let thrown = null;
      try {
        await createRasterSession({ scale: RASTER_SCALE, failureMode }, probe);
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown, `R11-P2: a "${failureMode}" startup failure must throw`);
      assertions += 1;
      assert.ok(
        /^raster-startup-probe: simulated (launch|newPage) failure$/.test(String(thrown && thrown.message)),
        "R11-P2: the ORIGINAL error must be rethrown unchanged — fixed message, no absolute path, token or secret",
      );
      assertions += 1;
      assert.ok(probe.port > 0, `R11-P2: the probe must observe the listening port ("${failureMode}")`);
      assertions += 1;
      assert.ok(
        !(await portIsListening(probe.port)),
        `R11-P2: after a "${failureMode}" startup failure the raster HTTP port ${probe.port} must no longer listen`,
      );
      assertions += 1;
      if (failureMode === "launch") {
        assert.ok(!probe.browser, "R11-P2: a launch failure must not leave a browser handle behind");
        assertions += 1;
      } else {
        assert.ok(
          probe.browser && probe.browser.isConnected() === false,
          "R11-P2: after a newPage failure the already-launched browser must be closed (isConnected() === false)",
        );
        assertions += 1;
      }
      const after = browserProcessCount();
      if (before !== null && after !== null) {
        console.log(`[cleanup] ${failureMode}: browser processes before=${before} after=${after}`);
        assert.ok(
          after <= before,
          `R11-P2: no browser child may survive a "${failureMode}" startup failure (before=${before}, after=${after})`,
        );
        assertions += 1;
      }
    }

    // close() must be idempotent — safe after a failure and safe twice in a row.
    const healthySession = await createRasterSession({ scale: RASTER_SCALE });
    let closeError = null;
    try {
      await healthySession.close();
      await healthySession.close();
    } catch (error) {
      closeError = error;
    }
    assert.ok(closeError === null, `R11-P2: close() must be idempotent (${closeError})`);
    assertions += 1;
    let rasterizeAfterClose = null;
    try {
      // The closed-session guard fires before the bytes are ever touched.
      await healthySession.rasterize(Buffer.alloc(0), {});
    } catch (error) {
      rasterizeAfterClose = error;
    }
    assert.ok(rasterizeAfterClose !== null, "R11-P2: a closed session must refuse to rasterise");
    assertions += 1;
  }

  // Emit the measured pixel evidence so the round-10 report can quote real numbers.
  for (const [label, rows] of Object.entries(rasterMeasurements)) {
    for (const m of rows) {
      console.log(
        `[raster] ${label} cell ${m.cell} (${m.expected}): diffPixels=${m.diffPixels} ` +
          `diffBBox=${JSON.stringify(m.diffBBox)} textBBox=${JSON.stringify(m.textBBox)} ` +
          `overlap=${m.overlap.toFixed(3)}`,
      );
    }
  }
  for (const [mode, msg] of Object.entries(rasterRejections)) {
    console.log(`[raster] REJECTED ${mode}: ${msg.split("\n")[0]}`);
  }

  // 7. Malformed overwrite must NOT mutate the old instance byte-for-byte.
  const beforeOverwrite = JSON.stringify(
    (await local.queryLocalWorkspaceV2(owner, { collection: "instances", where: { id: tableInstance.id }, limit: 1 })).records[0].values
  );
  const uploadMOCsv = 'StatementTable\n"[[100,200,""STALE_FORMULA_RESIDUAL""]]"\n';
  const upMO = await fetch(`${base}/api/v1/assets/raw?filename=mo.csv&mimeType=text%2Fcsv&metadata=%257B%257D`, {
    method: "POST", headers: { ...headers, "content-type": "application/octet-stream" }, body: uploadMOCsv,
  });
  const upMOJson = await upMO.json();
  const moInspected = await batch.inspectStoredCsv(owner, upMOJson.asset.id);
  const moRes = await batch.createStoredImportRun(owner, {
    templateVersionId: "version-table",
    sourceAssetId: upMOJson.asset.id,
    sourceHash: moInspected.sourceHash,
    decisions: [{ csvField: "StatementTable", templateStableFieldId: "statement_table", confidence: "high", decision: "accepted" }],
    mode: "tolerant",
    duplicateDecisions: [{
      rowNumber: 2,
      instanceId: tableInstance.id,
      action: "overwrite",
      mergedValues: { statement_table: "[[\"999\",\"888\"" }, // malformed JSON → must fail closed
    }],
  });
  equal(moRes.duplicate, 0);
  equal(moRes.failed, 1, "malformed mergedValues overwrite must fail closed");
  const afterOverwrite = JSON.stringify(
    (await local.queryLocalWorkspaceV2(owner, { collection: "instances", where: { id: tableInstance.id }, limit: 1 })).records[0].values
  );
  equal(afterOverwrite, beforeOverwrite, "malformed overwrite must not change the old instance byte-for-byte");

  // 5. Table-specific stored-v2 resume: a failed run replays without duplicating committed rows.
  const uploadResumeCsv = 'StatementTable\n"[[7,8,""STALE""]]"\n';
  const upResume = await fetch(`${base}/api/v1/assets/raw?filename=tbl-resume.csv&mimeType=text%2Fcsv&metadata=%257B%257D`, {
    method: "POST", headers: { ...headers, "content-type": "application/octet-stream" }, body: uploadResumeCsv,
  });
  const upResumeJson = await upResume.json();
  const resumeInspected = await batch.inspectStoredCsv(owner, upResumeJson.asset.id);
  const resumeRunRes = await batch.createStoredImportRun(owner, {
    templateVersionId: "version-table",
    sourceAssetId: upResumeJson.asset.id,
    sourceHash: resumeInspected.sourceHash,
    decisions: [{ csvField: "StatementTable", templateStableFieldId: "statement_table", confidence: "high", decision: "accepted" }],
    mode: "tolerant",
  });
  equal(resumeRunRes.created, 1);
  const beforeResumeCount = await countCollection("instances", { templateVersionId: "version-table" });
  const savedResumeRun = (await local.queryLocalWorkspaceV2(owner, { collection: "importRuns", where: { id: resumeRunRes.importRunId }, limit: 1 })).records[0];
  const descResume = await local.describeLocalWorkspaceV2(owner);
  await local.transactLocalWorkspaceV2(owner, {
    expectedRevision: descResume.revision,
    transactionId: `synthetic-interruption-${resumeRunRes.importRunId}`,
    put: [{ collection: "importRuns", record: { ...savedResumeRun, status: "failed" } }],
  });
  const resumedTable = await batch.resumeStoredImportRun(owner, resumeRunRes.importRunId);
  equal(resumedTable.created, 0, "table resume must skip already-committed rows");
  equal(await countCollection("instances", { templateVersionId: "version-table" }), beforeResumeCount, "table resume must not duplicate committed rows");
  const resumedInstance = (await local.queryLocalWorkspaceV2(owner, { collection: "instances", where: { templateVersionId: "version-table" }, limit: 20 })).records
    .find(r => r.values.statement_table === JSON.stringify([["7", "8", ""], ["", "", ""]]));
  equal(resumedInstance.values.statement_table, JSON.stringify([["7", "8", ""], ["", "", ""]]), "table resume must preserve sanitized raw values");
  equal(resumedInstance.valuesHash, domainSha256(resumedInstance.values), "table resume must preserve the correct valuesHash");

  // 6. Stored-v2 row correction (legal) + malformed correction fail-closed.
  const uploadCorrCsv = 'StatementTable\n"[[10,20,""STALE_X""]]"\n';
  const upCorr = await fetch(`${base}/api/v1/assets/raw?filename=tbl-corr.csv&mimeType=text%2Fcsv&metadata=%257B%257D`, {
    method: "POST", headers: { ...headers, "content-type": "application/octet-stream" }, body: uploadCorrCsv,
  });
  const upCorrJson = await upCorr.json();
  const corrInspected = await batch.inspectStoredCsv(owner, upCorrJson.asset.id);
  const corrRes = await batch.createStoredImportRun(owner, {
    templateVersionId: "version-table",
    sourceAssetId: upCorrJson.asset.id,
    sourceHash: corrInspected.sourceHash,
    decisions: [{ csvField: "StatementTable", templateStableFieldId: "statement_table", confidence: "high", decision: "accepted" }],
    mode: "tolerant",
    rowCorrections: [{ rowNumber: 2, values: { statement_table: JSON.stringify([["10", "20", ""]]) } }],
  });
  equal(corrRes.created, 1);
  const corrInstance = (await local.queryLocalWorkspaceV2(owner, { collection: "instances", where: { templateVersionId: "version-table" }, limit: 20 })).records
    .find(r => r.values.statement_table === JSON.stringify([["10", "20", ""], ["", "", ""]]));
  equal(corrInstance.values.statement_table, JSON.stringify([["10", "20", ""], ["", "", ""]]), "row correction must be written as sanitized raw authority");
  equal(corrInstance.valuesHash, domainSha256(corrInstance.values), "row correction valuesHash must match sanitized values");
  const corrGrid = resolveGrid(tableField.definition, corrInstance.values.statement_table);
  equal(corrGrid.effectiveRows[0][2], "30.00", "row-corrected formula cell must live-evaluate to 30.00");

  const uploadCorrMalCsv = 'StatementTable\n"[[1,2,""X""]]"\n';
  const upCorrMal = await fetch(`${base}/api/v1/assets/raw?filename=tbl-corr-mal.csv&mimeType=text%2Fcsv&metadata=%257B%257D`, {
    method: "POST", headers: { ...headers, "content-type": "application/octet-stream" }, body: uploadCorrMalCsv,
  });
  const upCorrMalJson = await upCorrMal.json();
  const corrMalInspected = await batch.inspectStoredCsv(owner, upCorrMalJson.asset.id);
  const corrMalRes = await batch.createStoredImportRun(owner, {
    templateVersionId: "version-table",
    sourceAssetId: upCorrMalJson.asset.id,
    sourceHash: corrMalInspected.sourceHash,
    decisions: [{ csvField: "StatementTable", templateStableFieldId: "statement_table", confidence: "high", decision: "accepted" }],
    mode: "tolerant",
    rowCorrections: [{ rowNumber: 2, values: { statement_table: "[[\"1\",\"2\"" } }], // malformed JSON
  });
  equal(corrMalRes.created, 0);
  equal(corrMalRes.failed, 1, "malformed row correction must fail closed");
  const corrMalRun = (await local.queryLocalWorkspaceV2(owner, { collection: "importRuns", where: { id: corrMalRes.importRunId }, limit: 1 })).records[0];
  equal(corrMalRun.status, "completed", "malformed-correction run must settle to completed (not stuck running)");
  equal(corrMalRun.failedCount, 1, "malformed-correction run must record exactly one failed row");

  console.log(`Stored CSV v2: ${assertions} assertions passed.`);
} finally {
  await stop().catch(() => {});
  await fs.rm(scratch, { recursive: true, force: true });
}
