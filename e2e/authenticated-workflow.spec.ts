import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
  authenticateTestUser,
  completeOnboarding,
  findLocalAssetUrl,
} from "./test-runtime";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

test("creates, publishes, fills, and exports a synthetic form", async ({
  context,
  page,
}, testInfo) => {
  await authenticateTestUser(context, `${testInfo.project.name}-full-workflow`);
  const pageErrors: Error[] = [];
  page.on("pageerror", error => pageErrors.push(error));

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await completeOnboarding(page);
  await page.getByRole("button", { name: "建立 Template" }).first().click();

  const sourceInput = page.locator('input[type="file"][accept*=".pdf"]');
  await sourceInput.setInputFiles(path.join(projectRoot, "ocr-fixture.png"));
  await page.locator("#template-name").fill("E2E Synthetic Template");
  await page.getByLabel("建立未確認欄位候選").uncheck();
  await page.getByRole("button", { name: "建立 Draft" }).click();
  // Stage 3 always presents an explicit import-review boundary, even when
  // automatic candidates are disabled. Continue through the user-visible
  // "pages only" choice instead of relying on the removed auto-bypass.
  await expect(page.getByTestId("import-review-panel")).toBeVisible({ timeout: 90_000 });
  await page.getByTestId("import-pages-only-btn").click();

  await expect(
    page.getByRole("heading", { name: "E2E Synthetic Template · v1" })
  ).toBeVisible();
  await expect(page.getByText("DRAFT", { exact: false }).first()).toBeVisible();

  await page.getByRole("button", { name: "快速新增" }).click();
  await page.getByLabel("欄位名稱").fill("E2E Name");
  await page.getByRole("button", { name: "確認此欄位" }).click();
  await page.getByRole("button", { name: /儲存|Save/ }).click();
  await expect(
    page.getByText("Draft 已保存至 localhost Workspace", { exact: true })
  ).toBeVisible();

  await page.getByRole("button", { name: "發佈" }).click();
  await expect(
    page.getByText("Template Version 已發佈及鎖定", { exact: true })
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "建立 Instance" })).toBeVisible();
  await page.getByRole("button", { name: "建立 Instance" }).click();

  await expect(page.getByRole("heading", { name: "欄位輸入" })).toBeVisible();
  await page
    .getByRole("textbox", { name: "E2E Name 單行文字" })
    .fill("TEST_PRIVATE_VALUE");
  await page.getByRole("button", { name: "建立 Instance" }).click();
  await expect(page.getByText("Instance 已建立並綁定目前 Version")).toBeVisible();

  await page.getByText("輸出", { exact: true }).click();
  const [popup, exportResponse] = await Promise.all([
    page.waitForEvent("popup"),
    page.waitForResponse(
      response =>
        response.url().includes("/api/trpc/formdigital.exports.pdf") &&
        response.status() === 200
    ),
    page.getByRole("button", { name: /一般 PDF（連原表）|Flattened PDF/ }).click(),
  ]);
  expect(exportResponse.ok()).toBe(true);
  expect(popup).toBeDefined();
  const assetUrl = findLocalAssetUrl(await exportResponse.json());
  expect(assetUrl).toContain("/api/local/assets/");

  const pdfResponse = await page.request.get(new URL(assetUrl!, page.url()).href);
  expect(pdfResponse.ok()).toBe(true);
  expect(pdfResponse.headers()["content-type"]).toContain("application/pdf");
  const pdfBytes = await pdfResponse.body();
  expect(pdfBytes.subarray(0, 4).toString("ascii")).toBe("%PDF");
  expect(pdfBytes.byteLength).toBeGreaterThan(500);
  expect(pageErrors).toEqual([]);
});

test("rolls back a partially created template when source import fails", async ({
  context,
  page,
}, testInfo) => {
  await authenticateTestUser(
    context,
    `${testInfo.project.name}-source-import-rollback`
  );
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await completeOnboarding(page);
  let uploadCount = 0;
  // Template sources and pages stream through the raw asset route; failing the
  // first page upload leaves a Draft plus one asset that must be rolled back.
  await page.route("**/api/local/raw-assets*", async route => {
    uploadCount += 1;
    if (uploadCount === 2) await route.abort("failed");
    else await route.continue();
  });

  await page.getByRole("button", { name: "建立 Template" }).first().click();
  await page
    .locator('input[type="file"][accept*=".pdf"]')
    .setInputFiles(path.join(projectRoot, "ocr-fixture.png"));
  await page.locator("#template-name").fill("E2E Rollback Template");
  await page.getByLabel("建立未確認欄位候選").uncheck();
  await page.getByRole("button", { name: "建立 Draft" }).click();

  await expect(
    page.getByText("Template 建立失敗，請檢查來源檔案後再試。", {
      exact: true,
    })
  ).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "關閉" }).click();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /範本庫|Template Library/ }).first().click();
  await expect(page.getByText("E2E Rollback Template", { exact: true })).toHaveCount(0);
});
