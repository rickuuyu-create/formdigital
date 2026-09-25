import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { authenticateTestUser, completeOnboarding } from "./test-runtime";
import { nativeReviewPdf, threePageDocx } from "./import-review-fixtures";

const data = (body: any) => body.result.data.json ?? body.result.data;
async function query(page: Page, procedure: string, input?: unknown) {
  const response = await page.request.get(`/api/trpc/formdigital.${procedure}?input=${encodeURIComponent(JSON.stringify({ json: input ?? null }))}`);
  expect(response.status()).toBe(200); return data(await response.json());
}
async function start(page: Page, buffer: Buffer, name: string, docx = false, detect = true) {
  await page.getByRole("button", { name: /建立 Template|Create template/i }).first().click();
  await page.locator('input[type="file"][accept*=".pdf"]').setInputFiles({ name: `${name}.${docx ? "docx" : "pdf"}`, buffer,
    mimeType: docx ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "application/pdf" });
  await page.locator("#template-name").fill(name);
  // Keep the full DOCX page for the page-size/image-retention regression;
  // default auto-crop intentionally shrinks to the small receipt's contents.
  if (docx) await page.getByLabel("自動裁邊", { exact: true }).uncheck();
  if (!detect) await page.getByLabel("建立未確認欄位候選").uncheck();
  await page.getByRole("button", { name: /建立 Draft|Create draft/i }).click();
  await expect(page.getByTestId("import-review-panel")).toBeVisible({ timeout: 90_000 });
}
async function finish(page: Page) {
  await page.getByTestId("confirm-import-btn").click();
  await expect(page).toHaveURL(/version=ver_/);
  const versionId = new URL(page.url()).searchParams.get("version")!;
  return query(page, "templates.getVersionDetails", { versionId });
}
test.beforeEach(async ({ context, page }, info) => {
  await authenticateTestUser(context, `s3r3-${info.project.name}-${info.testId}-${Date.now()}`);
  await page.goto("/"); await completeOnboarding(page);
});

test("S3-T01/T02 actual 6x12 unequal grid survives review and persisted readback", async ({ page }) => {
  await start(page, await nativeReviewPdf(true), "Unequal Grid");
  const result = await finish(page);
  const table = result.fields.find((f: any) => f.fieldType === "table" && f.definition.tableColumns === 12 && f.definition.maxRows === 6);
  expect(table, "pixel table detector must identify all 72 cells").toBeTruthy();
  const guides = table.definition.tableCellGuides;
  expect(guides).toHaveLength(72);
  expect(guides[0].widthRatio).toBeGreaterThan(guides[1].widthRatio * 2.5);
  expect(guides[60].heightRatio).toBeGreaterThan(guides[0].heightRatio * 1.6);
  for (const g of guides) {
    expect(g.widthRatio).toBeGreaterThan(0); expect(g.heightRatio).toBeGreaterThan(0);
    expect(g.xRatio + g.widthRatio).toBeLessThanOrEqual(1.000001);
  }
  const again = await query(page, "templates.getVersionDetails", { versionId: new URL(page.url()).searchParams.get("version") });
  expect(again.fields.find((f: any) => f.id === table.id).definition.tableCellGuides).toEqual(guides);
});

test("S3-T03/T04 attachment and candidate decisions persist exactly, assets remain", async ({ page }) => {
  await start(page, await nativeReviewPdf(), "Decisions");
  const first = page.locator('[data-testid^="candidate-action-"]').first();
  const excludedId = (await first.getAttribute("data-testid"))!.replace("candidate-action-", "");
  await first.click(); await expect(first).toHaveText("復原"); await first.click(); await expect(first).toHaveText("排除"); await first.click();
  await page.getByTestId("next-page-btn").click();
  const retainedIds = await page.locator('[data-testid^="candidate-item-"]').evaluateAll(nodes => nodes.map(n => n.getAttribute("data-testid")!.replace("candidate-item-", "")));
  expect(retainedIds.length).toBeGreaterThan(0);
  await page.getByTestId("next-page-btn").click();
  const thirdIds = await page.locator('[data-testid^="candidate-item-"]').evaluateAll(nodes => nodes.map(n => n.getAttribute("data-testid")!.replace("candidate-item-", "")));
  expect(thirdIds.length).toBeGreaterThan(0);
  await page.getByTestId("page-type-attachment").check(); await page.getByTestId("page-type-general").check();
  await expect(page.locator('[data-testid^="candidate-item-"]')).toHaveCount(thirdIds.length);
  await page.getByTestId("page-type-attachment").check();
  const result = await finish(page);
  expect(result.version.pageManifest).toHaveLength(3);
  expect(result.fields.map((f: any) => f.stableFieldId)).not.toContain(excludedId);
  for (const id of thirdIds) expect(result.fields.map((f: any) => f.stableFieldId)).not.toContain(id);
  expect(result.fields.map((f: any) => f.stableFieldId).sort()).toEqual(retainedIds.sort());
  expect(result.fields.every((f: any) => f.coordinate.page === 2)).toBe(true);
  for (const entry of result.version.pageManifest) {
    const asset = await query(page, "assets.getUrl", { assetId: entry.assetId });
    const response = await page.request.get(asset.url); expect(response.ok()).toBe(true);
    expect((await response.body()).length).toBeGreaterThan(100);
  }
});

test("S3-T06/T07 cancellation verifies rollback and failed cleanup stays visible", async ({ page }) => {
  await start(page, await nativeReviewPdf(), "Rollback");
  await page.getByTestId("cancel-import-btn").click();
  await expect(page.getByText("Template 建立已取消", { exact: false })).toBeVisible();
  expect(await query(page, "templates.list")).toEqual([]);
  expect(await query(page, "assets.list")).toEqual([]);
  await page.getByRole("button", { name: "關閉", exact: true }).click();
  await start(page, await nativeReviewPdf(), "Failure");
  await page.route("**/api/trpc/formdigital.templates.delete*", route => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { json: { message: "Synthetic cleanup failure", code: -32603 } } }) }));
  await page.getByTestId("cancel-import-btn").click();
  await expect(page.getByRole("alert").filter({ hasText: "清理未確認" })).toBeVisible({ timeout: 20_000 });
  expect((await query(page, "templates.list")).length).toBe(1);
});

for (const locale of ["zh-Hant", "zh-Hans", "en"] as const) test(`S3 locale ${locale}: full panel, keyboard navigation and lazy page preview`, async ({ page }) => {
  await page.goto("/?view=settings"); await page.locator("#interface-locale").selectOption(locale);
  await page.goto("/?view=library");
  await start(page, await nativeReviewPdf(), "Keyboard");
  const panel = page.getByTestId("import-review-panel");
  if (locale === "en") expect(await panel.innerText()).not.toMatch(/[\u3400-\u9fff]/);
  else await expect(panel).toContainText(locale === "zh-Hans" ? "复核辨识建议" : "覆核辨識建議");
  await expect(page.getByTestId("preview-image")).toBeVisible();
  await page.getByTestId("next-page-btn").focus(); await page.keyboard.press("Enter");
  await expect(page.getByTestId("page-indicator")).toBeFocused();
  await expect(page.getByTestId("page-indicator")).toHaveAttribute("aria-live", "polite");
  await page.getByTestId("page-type-attachment").focus(); await page.keyboard.press("Space");
  await expect(page.getByTestId("page-type-attachment")).toBeChecked();
  await page.getByTestId("page-type-general").focus(); await page.keyboard.press("Space");
  await expect(page.getByTestId("page-type-general")).toBeChecked();
  await page.getByTestId("cancel-import-btn").click();
});

test("S3-T09 every exact historical name still enters review", async ({ page }) => {
  const buffer = await nativeReviewPdf();
  for (const name of ["Table Cells Test", "Table Workflow Test", "Table Roles Formula", "Preview PDF Parity"]) {
    await start(page, buffer, name);
    await page.getByTestId("cancel-import-btn").click();
    await expect.poll(async () => (await query(page, "templates.list")).length).toBe(0);
    await expect(page.getByRole("button", { name: "建立 Draft" })).toBeEnabled();
    await page.getByRole("button", { name: "關閉", exact: true }).click();
  }
});

test("S3-T10 real three-page DOCX retains visible final-page image across five readbacks", async ({ page }) => {
  test.setTimeout(180_000);
  await start(page, threePageDocx(), "Real Docx", true, false);
  await expect(page.getByTestId("docx-notice")).toBeVisible();
  await expect(page.getByTestId("detection-disabled-notice")).toBeVisible();
  const result = await finish(page);
  expect(result.version.pageManifest).toHaveLength(3); expect(result.fields).toHaveLength(0);
  const last = result.version.pageManifest[2]; expect(last.mimeType).toBe("image/png");
  let hash = "";
  for (let i = 0; i < 5; i++) {
    const details = await query(page, "templates.getVersionDetails", { versionId: result.version.id });
    expect(details.version.pageManifest[2].assetId).toBe(last.assetId);
    const asset = await query(page, "assets.getUrl", { assetId: last.assetId });
    const response = await page.request.get(asset.url); expect(response.ok()).toBe(true);
    expect(response.headers()["content-type"]).toContain("image/png");
    const bytes = await response.body(); expect(bytes.length).toBeGreaterThan(1000);
    const current = createHash("sha256").update(bytes).digest("hex"); if (!hash) hash = current; expect(current).toBe(hash);
    const pixels = await page.evaluate(async url => {
      const bitmap = await createImageBitmap(await (await fetch(url)).blob());
      const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d")!; ctx.drawImage(bitmap, 0, 0); bitmap.close();
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data; let red = 0;
      for (let p=0;p<data.length;p+=4) if(data[p]>170 && data[p+1]<90 && data[p+2]<120) red++;
      return { width: canvas.width, height: canvas.height, red };
    }, asset.url);
    expect(pixels.width).toBeGreaterThan(500); expect(pixels.height).toBeGreaterThan(500); expect(pixels.red).toBeGreaterThan(10_000);
  }
});
