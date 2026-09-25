import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { authenticateTestUser, completeOnboarding, findLocalAssetUrl } from "./test-runtime";

const documentRoot = process.env.FORMDIGITAL_STAGE6_DOC_ROOT ?? "C:\\Users\\User\\Downloads";
const documents = [
  "Reimbursement Form_Clean.docx",
  "Purchase Requisition and Quotation Summary Form.docx",
  "Purchase Requisition_below_or equal to $5000.docx",
  "Reimbursement Form.docx",
] as const;

async function importPagesOnly(page: Page, input: string | { name: string; mimeType: string; buffer: Buffer }, name: string) {
  await page.getByRole("button", { name: "建立 Template" }).first().click();
  await page.locator('input[type="file"][accept*=".pdf"]').setInputFiles(input);
  await page.locator("#template-name").fill(name);
  await page.getByRole("button", { name: "建立 Draft" }).click();
  await expect(page.getByTestId("import-review-panel")).toBeVisible({ timeout: 180_000 });
  await expect(page.getByTestId("docx-notice")).toBeVisible().catch(() => undefined);
  await page.getByTestId("import-pages-only-btn").click();
  await expect(page.getByRole("heading", { name: `${name} · v1` })).toBeVisible({ timeout: 180_000 });
}

async function publishFillAndExport(page: Page, name: string) {
  await expect(page.getByTestId("workflow-guide")).toBeVisible();
  await page.getByRole("button", { name: "快速新增" }).click();
  await page.getByLabel("欄位名稱").fill("驗收名稱");
  await page.getByRole("button", { name: "確認此欄位" }).click();
  const saved = page.waitForResponse(response => response.url().includes("formdigital.templates.saveDraftFields") && response.status() === 200);
  await page.getByRole("button", { name: /儲存|Save/, exact: true }).click();
  await saved;
  const published = page.waitForResponse(response => response.url().includes("formdigital.templates.publish") && response.status() === 200);
  await page.getByRole("button", { name: "發佈" }).click();
  await published;
  await expect(page.getByRole("button", { name: "建立 Instance" })).toBeVisible();
  await page.getByRole("button", { name: "建立 Instance" }).click();
  await page.getByRole("textbox", { name: "驗收名稱 單行文字" }).fill(`已驗收 ${name}`);
  await page.getByRole("button", { name: "建立 Instance" }).click();
  await expect(page.getByText("Instance 已建立並綁定目前 Version")).toBeVisible();
  await page.getByText("輸出", { exact: true }).click();
  const responsePromise = page.waitForResponse(response => response.url().includes("formdigital.exports.pdf") && response.status() === 200);
  await page.getByRole("button", { name: /一般 PDF（連原表）|Flattened PDF/ }).click();
  const response = await responsePromise;
  const assetUrl = findLocalAssetUrl(await response.json());
  expect(assetUrl).toBeTruthy();
  const pdf = await page.request.get(new URL(assetUrl!, page.url()).href);
  expect(pdf.ok()).toBe(true);
  const bytes = await pdf.body();
  expect(bytes.subarray(0, 4).toString("ascii")).toBe("%PDF");
  expect(bytes.length).toBeGreaterThan(500);
}

for (const [index, filename] of documents.entries()) {
  test(`stage 6 real document ${index + 1}: ${filename}`, async ({ page, context }, info) => {
    test.skip(info.project.name !== "chromium", "DOCX conversion is browser-independent and is exercised once per real file.");
    test.setTimeout(360_000);
    const file = path.join(documentRoot, filename);
    test.skip(!fs.existsSync(file), `Real acceptance document is not available at ${file}`);
    await authenticateTestUser(context, `stage6-real-${index}-${Date.now()}`);
    await page.goto("/");
    await completeOnboarding(page);
    const templateName = `Stage6 ${index + 1} ${Date.now()}`;
    await importPagesOnly(page, file, templateName);
    await publishFillAndExport(page, templateName);
  });
}

test("stage 6 synthetic shifted-table variant completes the same delivery path", async ({ page, context }, info) => {
  test.setTimeout(240_000);
  await authenticateTestUser(context, `stage6-variant-${info.project.name}-${Date.now()}`);
  await page.goto("/");
  await completeOnboarding(page);
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  sheet.drawText("SHIFTED PURCHASE TABLE", { x: 88, y: 735, size: 15, font });
  const widths = [42, 151, 64, 93];
  const x0 = 88, y0 = 390, rowHeight = 29;
  let x = x0;
  for (const width of widths) { sheet.drawLine({ start: { x, y: y0 }, end: { x, y: y0 + rowHeight * 7 }, thickness: 1, color: rgb(0.1, 0.1, 0.1) }); x += width; }
  sheet.drawLine({ start: { x, y: y0 }, end: { x, y: y0 + rowHeight * 7 }, thickness: 1, color: rgb(0.1, 0.1, 0.1) });
  for (let row = 0; row <= 7; row += 1) sheet.drawLine({ start: { x: x0, y: y0 + row * rowHeight }, end: { x, y: y0 + row * rowHeight }, thickness: 1, color: rgb(0.1, 0.1, 0.1) });
  sheet.drawText("Item", { x: x0 + 4, y: y0 + rowHeight * 6 + 9, size: 9, font });
  sheet.drawText("Description", { x: x0 + widths[0] + 4, y: y0 + rowHeight * 6 + 9, size: 9, font });
  const name = `Stage6 Variant ${Date.now()}`;
  await importPagesOnly(page, { name: "shifted-table.pdf", mimeType: "application/pdf", buffer: Buffer.from(await doc.save()) }, name);
  await publishFillAndExport(page, name);
});
