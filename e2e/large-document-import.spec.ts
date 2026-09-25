import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { authenticateTestUser, completeOnboarding } from "./test-runtime";

/** Larger than the base64 asset envelope the import used to depend on. */
const OVERSIZED_PAYLOAD_BYTES = 18_000_000;

async function multiPagePdf(pageCount: number, padding = 0) {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = document.addPage([595, 842]);
    page.drawText(`LARGE DOCUMENT PAGE ${pageNumber}`, {
      x: 60,
      y: 760,
      size: 18,
      font,
    });
  }
  if (padding > 0)
    await document.attach(randomBytes(padding), "payload.bin", {
      mimeType: "application/octet-stream",
    });
  return Buffer.from(await document.save());
}

async function startImport(
  page: import("@playwright/test").Page,
  name: string,
  buffer: Buffer,
  confirmReview = true
) {
  await page.getByRole("button", { name: "建立 Template" }).first().click();
  await page.locator('input[type="file"][accept*=".pdf"]').setInputFiles({
    name: "multi-page-form.pdf",
    mimeType: "application/pdf",
    buffer,
  });
  await page.locator("#template-name").fill(name);
  await page.getByLabel("建立未確認欄位候選").uncheck();
  await page.getByRole("button", { name: "建立 Draft" }).click();
  if (confirmReview) {
    const confirmBtn = page.getByRole("button", { name: "採用建議並完成匯入" });
    await confirmBtn.waitFor({ state: "visible", timeout: 90_000 });
    await confirmBtn.click();
  }
}

test("imports a multi-page PDF and keeps one manifest page per source page", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await authenticateTestUser(
    context,
    `${testInfo.project.name}-large-document-import`
  );

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await completeOnboarding(page);
  await startImport(page, "E2E Large Document Template", await multiPagePdf(3));

  await expect(
    page.getByRole("heading", { name: "E2E Large Document Template · v1" })
  ).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText("DRAFT", { exact: false }).first()).toBeVisible();

  // One editor page row per source page, each carrying its own page asset.
  // The row label also carries the page size, so match a substring.
  const pageRows = page.getByRole("button", { name: /Page \d+/ });
  await expect(pageRows).toHaveCount(3);
  await expect(page.getByRole("button", { name: /Page 3/ })).toBeVisible();
});

test("imports a source larger than the old base64 upload limit", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await authenticateTestUser(
    context,
    `${testInfo.project.name}-oversized-source-import`
  );

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await completeOnboarding(page);
  const buffer = await multiPagePdf(1, OVERSIZED_PAYLOAD_BYTES);
  expect(buffer.byteLength).toBeGreaterThan(15_750_000);
  await startImport(page, "E2E Oversized Source Template", buffer);

  await expect(
    page.getByRole("heading", { name: "E2E Oversized Source Template · v1" })
  ).toBeVisible({ timeout: 150_000 });
  await expect(page.getByRole("button", { name: /Page 1/ })).toBeVisible();
});

test("a cancelled import leaves no Template behind", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await authenticateTestUser(
    context,
    `${testInfo.project.name}-cancelled-import`
  );

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await completeOnboarding(page);
  await startImport(page, "E2E Cancelled Template", await multiPagePdf(6), false);

  const cancelBtn = page.getByRole("button", { name: /取消(整次)?匯入/ });
  await cancelBtn.first().click();
  await expect(page.getByText("Template 建立已取消", { exact: false })).toBeVisible(
    { timeout: 90_000 }
  );
  await expect(
    page.getByRole("heading", { name: "E2E Cancelled Template · v1" })
  ).toBeHidden();
  await expect(
    page.getByText("E2E Cancelled Template", { exact: false })
  ).toHaveCount(0);
});
