import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PDFDocument } from "pdf-lib";
import { chromium } from "@playwright/test";
import { threePageDocx, receiptPng } from "../../e2e/import-review-fixtures.ts";

const appRoot = process.argv[3] ? path.resolve(process.argv[3]) : process.cwd();
const dist = path.resolve(process.argv[2] || "tmp/mcp-stage/dist");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "FormDigital-MCP-"));
const files = path.join(root, "Shared forms");
await fs.mkdir(files);
const origin = "http://127.0.0.1:32127";
const env = {
  ...process.env,
  FORMDIGITAL_LOCAL_ONLY: "1",
  FORMDIGITAL_LOCAL_CONFIG: path.join(root, "config.json"),
  FORMDIGITAL_DATA_FOLDER: path.join(root, "Data"),
  FORMDIGITAL_WEB_PORT: "32127",
  FORMDIGITAL_LDS_HEALTH_PORT: "43217",
  PORT: "32127",
  NODE_ENV: "production",
};
const init = spawnSync(
  process.execPath,
  [path.resolve("delivery/windows/initialize-delivery.mjs")],
  { env, windowsHide: true }
);
assert.equal(init.status, 0);
const children = [];
let logs = "";
function start(file) {
  const child = spawn(process.execPath, [file], {
    cwd: appRoot,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  child.stdout.on("data", b => (logs += b));
  child.stderr.on("data", b => (logs += b));
  return child;
}
start(path.join(appRoot, "local-data-service.mjs"));
start(path.join(dist, "index.js"));
let client, stdioClient, browser;
const evidence = [];
const ok = name => {
  evidence.push(name);
  console.log(`PASS ${name}`);
};
async function settings(body) {
  const r = await fetch(`${origin}/api/local/mcp`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const value = await r.json();
  assert.equal(r.status, 200, JSON.stringify(value));
  return value;
}
async function tool(name, args = {}, expectedError = false, c = client) {
  const r = await c.callTool({ name, arguments: args }, undefined, {
    timeout: 180000,
  });
  if (expectedError) {
    assert.equal(r.isError, true, JSON.stringify(r));
    return r;
  }
  assert.ok(!r.isError, `${name}: ${JSON.stringify(r)}`);
  if (r.structuredContent && "result" in r.structuredContent)
    return r.structuredContent.result;
  return r;
}
const write = (input = {}) => ({
  operationKey: randomUUID(),
  expected: [],
  ...input,
});
const versionRef = d => ({
  collection: "templateVersions",
  id: d.version.id,
  hash: d.version.revision,
});
const instanceRef = d => ({
  collection: "instances",
  id: d.instance.id,
  hash: d.instance.revision,
});
async function waitJob(jobId) {
  let result;
  for (let i = 0; i < 400; i++) {
    result = await tool("job_get", { jobId });
    if (!["queued", "running"].includes(result.status)) return result;
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`Job timed out: ${JSON.stringify(result)}`);
}
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${origin}/api/local/preflight`)).ok) break;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  const state = await (await fetch(`${origin}/api/local/mcp`)).json();
  assert.equal(state.enabled, false);
  assert.equal(
    (
      await fetch(`${origin}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
    401
  );
  ok("MCP off by default");
  await settings({ action: "configure", enabled: true, roots: [files] });
  const pair = await settings({
    action: "pair",
    name: "Synthetic integration",
    permissions: ["read", "write", "export", "manage"],
  });
  client = new Client({ name: "formdigital-integration", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(pair.http.url), {
      requestInit: { headers: pair.http.headers },
    })
  );
  const tools = await client.listTools();
  assert.ok(tools.tools.length > 40);
  assert.equal((await tool("system_status")).googleLogin, false);
  ok("standard SDK HTTP initialize and catalog");
  assert.equal((await client.listResources()).resources.length, 1);
  assert.ok(
    (await client.readResource({ uri: "formdigital://guide" })).contents.length
  );
  await client.getPrompt({
    name: "form-workflow",
    arguments: { request: "synthetic" },
  });
  ok("resources and workflow prompt");
  const types = [
    "text",
    "textarea",
    "number",
    "date",
    "time",
    "select",
    "radio",
    "checkbox",
    "characterBox",
    "table",
    "image",
    "signature",
  ];
  const fields = types.map((fieldType, i) => ({
    stableFieldId: `f-${fieldType.toLowerCase()}`,
    fieldType,
    displayOrder: i,
    definition: {
      label: fieldType,
      confirmed: true,
      required: i === 0,
      fontSizePt: 10,
      overflow: ["wrap", "shrink", "warn", "block"][i % 4],
      ...(["radio", "select", "checkbox"].includes(fieldType)
        ? { options: ["A", "B"], markStyle: "circle" }
        : {}),
      ...(fieldType === "table"
        ? {
            maxRows: 2,
            tableColumns: 3,
            tableFormulaSchemaVersion: 2,
            tableFormulaCells: [
              { row: 0, column: 2, expression: "A*B", decimalPlaces: 2 },
            ],
          }
        : {}),
      ...(fieldType === "characterBox" ? { boxCount: 8 } : {}),
      ...(fieldType === "signature" ? { signatureMode: "text" } : {}),
    },
    coordinate: {
      page: i < 6 ? 1 : 2,
      xMm: 15,
      yMm: 35 + (i % 6) * 35,
      widthMm: 175,
      heightMm: 22,
    },
  }));
  const design = write({
    name: "MCP synthetic all 12 fields",
    pages: [{ title: "MCP 繁體 简体 English" }, { title: "Choices, table and media" }],
    fields,
  });
  const draft = await tool("form_design_create", design);
  assert.equal(
    (await tool("form_design_create", design)).versionId,
    draft.versionId
  );
  ok("12 field types, multi-page design and persistent replay");
  await tool(
    "form_design_create",
    { ...design, name: "Changed request" },
    true
  );
  ok("operation key cannot change meaning");
  let detail = await tool("templates_getVersionDetails", {
    input: { versionId: draft.versionId },
  });
  const old = versionRef(detail);
  await tool(
    "draft_patch",
    write({
      versionId: draft.versionId,
      expected: [old],
      upsert: [
        {
          ...fields[0],
          definition: {
            ...fields[0].definition,
            label: "Applicant name",
            align: "center",
          },
        },
      ],
    })
  );
  await tool(
    "draft_patch",
    write({
      versionId: draft.versionId,
      expected: [old],
      remove: [fields[1].stableFieldId],
    }),
    true
  );
  ok("stale template revision rejected");
  detail = await tool("templates_getVersionDetails", {
    input: { versionId: draft.versionId },
  });
  assert.equal(detail.fields.length, 12);
  await tool(
    "templates_publish",
    write({
      input: { versionId: draft.versionId },
      expected: [versionRef(detail)],
    })
  );
  detail = await tool("templates_getVersionDetails", {
    input: { versionId: draft.versionId },
  });
  await tool(
    "draft_patch",
    write({
      versionId: draft.versionId,
      expected: [versionRef(detail)],
      remove: [fields[0].stableFieldId],
    }),
    true
  );
  ok("published template protected");
  const pngPath = path.join(files, "Synthetic red image.png");
  await fs.writeFile(pngPath, receiptPng());
  const png = await tool("asset_import", write({ path: pngPath }));
  const instance = await tool(
    "instances_create",
    write({
      input: {
        templateVersionId: draft.versionId,
        name: "Synthetic filled instance",
        values: {
          "f-text": "Hong Kong is the city",
          "f-textarea": "English word wrapping test；繁體中文；简体中文",
          "f-number": "12",
          "f-date": "2026-09-30",
          "f-time": "12:34",
          "f-select": "A",
          "f-radio": "B",
          "f-checkbox": "A\nB",
          "f-characterbox": "00123456",
          "f-table": '[["2","3",""],["4","5",""]]',
          "f-image": png.asset.id,
          "f-signature": "text:Synthetic signature",
        },
      },
    })
  );
  const instanceId = instance.instanceId ?? instance.id;
  assert.ok(instanceId, JSON.stringify(instance));
  let d = await tool("instances_get", { input: { instanceId } }),
    previous = instanceRef(d);
  const patchResult = await tool(
    "instance_patch",
    write({
      instanceId,
      expected: [previous],
      values: { "f-text": "Updated name" },
    })
  );
  await tool(
    "instance_patch",
    write({ instanceId, expected: [previous], values: { "f-text": "stale" } }),
    true
  );
  d = await tool("instances_get", { input: { instanceId } });
  assert.equal(d.instance.values["f-number"], "12");
  ok("instance patch preserves other fields and rejects stale data");
  const change = await tool("change_preview", {
    operationId: patchResult.operationId,
  });
  assert.equal(change.reversible, true);
  await tool(
    "change_revert",
    write({
      originalOperationId: patchResult.operationId,
      expected: [change.after],
    })
  );
  d = await tool("instances_get", { input: { instanceId } });
  assert.equal(d.instance.values["f-text"], "Hong Kong is the city");
  ok("guarded undo retains original data");
  for (const mode of ["full", "overlay", "editable"]) {
    const output = await tool(
      "exports_pdf",
      write({ input: { instanceId, mode } })
    );
    assert.ok(output.assetId || output.asset?.id, JSON.stringify(output));
    const assetId = output.assetId ?? output.asset.id;
    const file = path.join(files, `${mode}.pdf`);
    await tool("asset_save", write({ assetId, path: file }));
    assert.equal(
      (await PDFDocument.load(await fs.readFile(file))).getPageCount(),
      2
    );
    if (mode === "full") {
      const image = await tool("output_preview", { assetId, page: 1 });
      assert.ok(image.content.some(c => c.type === "image"));
      assert.ok(image.structuredContent.text.includes("繁體"));
      await fs.writeFile(path.join(root, "full-page1.png"), Buffer.from(image.content.find(c => c.type === "image").data, "base64"));
      const page2 = await tool("output_preview", { assetId, page: 2 });
      await fs.writeFile(path.join(root, "full-page2.png"), Buffer.from(page2.content.find(c => c.type === "image").data, "base64"));
    }
    ok(`${mode} PDF and local save`);
  }
  const preview = await tool("page_preview", {
    versionId: draft.versionId,
    page: 2,
    overlay: true,
  });
  assert.ok(preview.content.some(c => c.type === "image"));
  ok("offline PDF raster preview with field overlay");
  const docx = path.join(files, "Synthetic images.docx");
  await fs.writeFile(docx, threePageDocx());
  const source = await tool("asset_import", write({ path: docx }));
  const job = await tool(
    "source_import_start",
    write({
      assetIds: [source.asset.id],
      name: "MCP DOCX import",
      detect: false,
    })
  );
  let result;
  for (let i = 0; i < 300; i++) {
    result = await tool("job_get", { jobId: job.jobId });
    if (!["queued", "running"].includes(result.status)) break;
    await new Promise(r => setTimeout(r, 300));
  }
  assert.equal(result.status, "review", JSON.stringify(result));
  assert.equal(result.result.pages, 3);
  ok("DOCX background job with images and explicit review");
  const imported = await tool("templates_getVersionDetails", {
    input: { versionId: result.result.versionId },
  });
  assert.ok(imported.version.pageManifest.every(p => p.assetId));
  const ocrJob = await tool("source_import_start", write({
    assetIds: [source.asset.id], name: "MCP OCR candidates", detect: true,
    language: "eng",
  }));
  const cancelledJob = await tool("source_import_start", write({
    assetIds: [source.asset.id], name: "Cancelled queued import", detect: false,
  }));
  await tool("job_cancel", write({ jobId: cancelledJob.jobId }));
  assert.equal((await waitJob(cancelledJob.jobId)).status, "cancelled");
  const ocr = await waitJob(ocrJob.jobId);
  assert.equal(ocr.status, "review", JSON.stringify(ocr));
  const candidates = await tool("templates_getVersionDetails", { input: { versionId: ocr.result.versionId } });
  assert.ok(candidates.fields.length > 0);
  assert.ok(candidates.fields.every(f => !f.definition.confirmed));
  ok("offline OCR candidates remain unconfirmed; queued job cancellation");
  const badPath = path.join(files, "Invalid.docx");
  await fs.writeFile(badPath, "synthetic invalid document");
  const badAsset = await tool("asset_import", write({ path: badPath }));
  const badJob = await tool("source_import_start", write({ assetIds: [badAsset.asset.id], name: "Bad import", detect: false }));
  assert.equal((await waitJob(badJob.jobId)).status, "failed");
  ok("invalid DOCX produces a failed job without a fabricated success");
  const sample = await tool(
    "practice_create",
    write({ name: "Independent practice" })
  );
  assert.ok(sample.versionId);
  ok("independent bundled practice without human completion");
  const csv = path.join(files, "Leading zeros.csv");
  await fs.writeFile(
    csv,
    'Name,Number\r\n"Hong Kong, China",0012\r\n"New\nLine",0003\r\n'
  );
  const csvAsset = await tool("asset_import", write({ path: csv }));
  const csvPreview = await tool("imports_preview", {
    input: { sourceAssetId: csvAsset.asset.id },
  });
  assert.ok(csvPreview);
  ok("CSV preview with quotes, newlines and leading zeros");
  const csvInput = {
    templateVersionId: draft.versionId, sourceAssetId: csvAsset.asset.id,
    sourceHash: csvPreview.sourceHash,
    decisions: [
      { csvField: "Name", templateStableFieldId: "f-text", confidence: "high", decision: "accepted" },
      { csvField: "Number", templateStableFieldId: "f-characterbox", confidence: "high", decision: "accepted" },
    ],
  };
  await tool("imports_analyze", { input: csvInput });
  const csvArgs = write({ input: { ...csvInput, mode: "strict" } });
  const importedCsv = await tool("imports_create", csvArgs);
  assert.equal(importedCsv.created, 2, JSON.stringify(importedCsv));
  assert.deepEqual(await tool("imports_create", csvArgs), importedCsv);
  const found = await tool("instances_search", { query: "", limit: 100 });
  assert.ok(JSON.stringify(found).includes("ins_"), JSON.stringify(found));
  ok("CSV analysis, two-row creation and retry without duplicate instances");
  const folder = await tool("folders_upsert", write({ input: { name: "Synthetic folder" } }));
  const tag = await tool("tags_upsert", write({ input: { name: "Synthetic tag", color: "#336699" } }));
  const savedValue = await tool("savedValues_add", write({ input: { templateId: detail.template.id, stableFieldId: "f-text", value: "Saved synthetic name" } }));
  await tool("savedValues_use", write({ input: { savedValueId: savedValue.id }, expected: [{ collection: "savedValues", id: savedValue.id, hash: savedValue.revision }] }));
  await tool("mappingTemplates_upsert", write({ input: { templateVersionId: draft.versionId, name: "Synthetic mapping", sourceSchemaFingerprint: csvPreview.schemaFingerprint, mapping: csvInput.decisions } }));
  const groups = await tool("collections");
  assert.ok(groups.folders.some(f => f.id === folder.id));
  assert.ok(groups.tags.some(t => t.id === tag.id));
  ok("folders, tags, saved values and CSV mapping persistence");
  const empty = await tool("instances_create", write({ input: { templateVersionId: draft.versionId, name: "Missing required field", values: {} } }));
  const emptyId = empty.instanceId ?? empty.id;
  const emptyDetail = await tool("instances_get", { input: { instanceId: emptyId } });
  await tool("instances_setStatus", write({ input: { instanceId: emptyId, status: "completed" }, expected: [instanceRef(emptyDetail)] }), true);
  ok("required field validation prevents incomplete completion");
  const calibration = await tool("exports_calibrationTest", write({ input: { templateId: detail.template.id, xOffsetMm: 0, yOffsetMm: 0, xScale: 100, yScale: 100 } }));
  assert.ok(calibration.assetId);
  await tool("localData_integrity", write());
  ok("printer calibration PDF and workspace integrity scan");
  const structured = await tool(
    "exports_structured",
    write({ input: { instanceId, format: "json" } })
  );
  assert.ok(structured.assetId);
  ok("structured JSON export");
  const batch = await tool(
    "exports_batchPdf",
    write({
      input: {
        instanceIds: [instanceId],
        mode: "full",
        copies: 2,
        titlePage: true,
        separatorPage: true,
      },
    })
  );
  assert.ok(batch.assetId);
  ok("batch PDF copies and cover");
  const backup = await tool("backups_createStream", write());
  const backupFile = path.join(files, "Verified backup.formdigital-backup");
  await tool(
    "backup_save",
    write({ backupId: backup.manifestId, path: backupFile })
  );
  assert.ok((await fs.stat(backupFile)).size > 0);
  const restore = await tool("restore_preview", write({ path: backupFile }));
  assert.ok(restore.sessionId);
  ok("streaming backup export and restore verification");
  const restoreArgs = write({ sessionId: restore.sessionId });
  const restorePending = await tool("restore_apply", restoreArgs);
  assert.ok(restorePending.approvalRequired);
  await settings({
    action: "approve",
    id: restorePending.operationId,
    approve: true,
  });
  const restored = await tool("restore_apply", restoreArgs);
  assert.ok(restored.recoveryBackup);
  await tool("instances_get", { input: { instanceId } });
  ok("approved restore creates recovery backup and preserves fixtures");
  const cloned = await tool(
    "templates_cloneToDraft",
    write({
      input: { versionId: draft.versionId },
      expected: [
        versionRef(
          await tool("templates_getVersionDetails", {
            input: { versionId: draft.versionId },
          })
        ),
      ],
    })
  );
  const diff = await tool("template_diff", {
    fromVersionId: draft.versionId,
    toVersionId: cloned.versionId,
  });
  assert.equal(diff.changed.length, 0);
  ok("version clone and stable-field diff");
  let layoutDetail = await tool("templates_getVersionDetails", { input: { versionId: cloned.versionId } });
  await tool("draft_layout", write({ versionId: cloned.versionId, fieldIds: ["f-text", "f-textarea"], action: "move", dxMm: 2, dyMm: 1, expected: [versionRef(layoutDetail)] }));
  layoutDetail = await tool("templates_getVersionDetails", { input: { versionId: cloned.versionId } });
  assert.equal(layoutDetail.fields.find(f => f.stableFieldId === "f-text").coordinate.xMm, 17);
  const pageArgs = write({ versionId: cloned.versionId, pageOrder: [2,1,2], expected: [versionRef(layoutDetail)] });
  const pagePending = await tool("draft_pages", pageArgs);
  await settings({ action: "approve", id: pagePending.operationId, approve: true });
  await tool("draft_pages", pageArgs);
  layoutDetail = await tool("templates_getVersionDetails", { input: { versionId: cloned.versionId } });
  assert.equal(layoutDetail.version.pageManifest.length, 3);
  assert.equal(new Set(layoutDetail.fields.map(f => f.stableFieldId)).size, 18);
  ok("draft movement, approved page reorder and duplication keep unique field IDs");
  assert.equal(
    (
      await fetch(`${origin}/mcp`, {
        method: "POST",
        headers: {
          ...pair.http.headers,
          Origin: "https://attacker.invalid",
          "Content-Type": "application/json",
        },
        body: "{}",
      })
    ).status,
    403
  );
  ok("cross-origin MCP access denied");
  const readOnly = await settings({
    action: "pair",
    name: "Read only",
    permissions: ["read"],
  });
  const ro = new Client({ name: "read-only-test", version: "1" });
  await ro.connect(
    new StreamableHTTPClientTransport(new URL(readOnly.http.url), {
      requestInit: { headers: readOnly.http.headers },
    })
  );
  await tool(
    "instance_patch",
    write({ instanceId, values: { "f-text": "not allowed" } }),
    true,
    ro
  );
  await ro.close();
  ok("read-only client cannot write");
  await tool(
    "asset_import",
    write({ path: path.join(root, "config.json") }),
    true
  );
  ok("file access outside approved root denied");
  d = await tool("instances_get", { input: { instanceId } });
  const deletion = write({
    input: { instanceIds: [instanceId] },
    expected: [instanceRef(d)],
  });
  const pending = await tool("instances_delete", deletion);
  assert.equal(pending.approvalRequired, true);
  await tool("instances_get", { input: { instanceId } });
  await settings({
    action: "approve",
    id: pending.operationId,
    approve: false,
  });
  await tool("instances_delete", deletion, true);
  ok("destructive operation requires exact local approval");
  stdioClient = new Client({ name: "stdio-integration", version: "1" });
  await stdioClient.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        path.join(dist, "mcp-stdio.js"),
        "--connection",
        pair.stdio.mcpServers.formdigital.args[2],
      ],
      stderr: "pipe",
    })
  );
  assert.ok((await stdioClient.listTools()).tools.length > 40);
  ok("bundled stdio bridge");
  browser = await chromium.launch({ executablePath: path.join(dist, "mcp-runtime/chromium/chrome.exe"), headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(origin);
  await page.getByRole("heading", { name: "本機資料資料夾" }).waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: "確認資料夾" }).click();
  for (let i = 0; i < 6; i++) await page.getByRole("button", { name: "下一步" }).click();
  await page.getByRole("button", { name: "進入工作台" }).click();
  await page.getByRole("button", { name: "建立 Template" }).waitFor();
  await page.goto(`${origin}/?view=settings`);
  const section = page.getByTestId("mcp-settings");
  for (const [locale, heading] of [["en", "AI connections (MCP)"], ["zh-Hans", "AI 连线（MCP）"], ["zh-Hant", "AI 連線（MCP）"]]) {
    const saved = page.waitForResponse(r => r.url().includes("/api/trpc/formdigital.preferences") && r.request().method() === "POST" && r.ok());
    await page.locator("#interface-locale").selectOption(locale);
    await section.getByRole("heading", { name: heading, exact: true }).waitFor();
    await saved;
  }
  const guide = page.getByTestId("mcp-guide");
  await guide.locator("summary").click();
  await guide.screenshot({ path: path.join(root, "mcp-guide.png") });
  await guide.locator("summary").click();
  const createConnection = section.getByRole("button", { name: "建立連線設定", exact: true });
  assert.equal(await createConnection.evaluate(el => getComputedStyle(el).backgroundColor), "rgb(16, 42, 67)");
  await section.getByLabel("新增連線名稱").fill("WorkBuddy UI test");
  await createConnection.click();
  await section.getByText("WorkBuddy / MCP (stdio JSON)", { exact: true }).click();
  const details = section.locator("details").filter({ has: page.getByText("WorkBuddy / MCP (stdio JSON)", { exact: true }) });
  const clientConfig = JSON.parse(await details.locator("pre").textContent());
  assert.ok(clientConfig.mcpServers.formdigital.command);
  assert.ok(clientConfig.mcpServers.formdigital.args.includes("--connection"));
  await section.getByRole("button", { name: "關閉設定資訊" }).click();
  await section.screenshot({ path: path.join(root, "mcp-settings.png") });
  ok("visible connection button generates client configuration and tutorial opens");
  ok("MCP settings in Traditional Chinese, Simplified Chinese and English");
  await page.goto(`${origin}/?view=fill&instance=${instanceId}`);
  const nameInput = page.locator('input:visible, textarea:visible');
  await page.waitForFunction(() => [...document.querySelectorAll('input,textarea')].some(e => e.value === 'Hong Kong is the city'));
  const inputIndex = await nameInput.evaluateAll(inputs => inputs.findIndex(e => e.value === 'Hong Kong is the city'));
  assert.ok(inputIndex >= 0);
  const current = await tool("instances_get", { input: { instanceId } });
  await nameInput.nth(inputIndex).fill("Website unsaved edit");
  await tool("instance_patch", write({ instanceId, expected: [instanceRef(current)], values: { "f-text": "AI concurrent edit" } }));
  await page.getByText(/資料已被另一個視窗或 AI 修改/).first().waitFor({ timeout: 15000 });
  assert.equal(await nameInput.nth(inputIndex).inputValue(), "Website unsaved edit");
  assert.equal((await tool("instances_get", { input: { instanceId } })).instance.values["f-text"], "AI concurrent edit");
  ok("website retains unsaved input when an agent changes the same instance");
  await browser.close(); browser = undefined;
  await settings({ action: "configure", enabled: false, roots: [files] });
  await assert.rejects(() => client.listTools());
  assert.ok((await fetch(`${origin}/`)).ok);
  ok("disabling MCP refuses clients while website remains available");
  await fs.writeFile(
    path.join(root, "evidence.json"),
    JSON.stringify({ passed: evidence.length, checks: evidence }, null, 2)
  );
  console.log(`Evidence: ${root}`);
} catch (error) {
  console.error(error);
  console.error(logs.slice(-6000));
  throw error;
} finally {
  await browser?.close();
  for (const child of children.reverse()) {
    if (child.exitCode === null)
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
  }
  await Promise.race([
    Promise.all([stdioClient?.close(), client?.close()]),
    new Promise(r => setTimeout(r, 3000)),
  ]);
}
