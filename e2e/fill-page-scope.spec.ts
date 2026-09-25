import { expect, test } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { authenticateTestUser, completeOnboarding } from "./test-runtime";

/**
 * The fill screen shows one page of the form at a time, but its field list
 * used to hold every field in the document. On anything longer than a couple
 * of pages that list ran far past what anyone could scan while looking at a
 * single sheet, and the input for the box being pointed at sat buried among
 * inputs for pages that were not even on screen.
 */
async function twoPageFixture() {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const form = document.getForm();
  for (const [index, label] of ["First page:", "Second page:"].entries()) {
    const page = document.addPage([420, 300]);
    page.drawText(label, { x: 40, y: 220, size: 12, font });
    form
      .createTextField(`entry${index}`)
      .addToPage(page, { x: 170, y: 214, width: 120, height: 16, font });
  }
  return Buffer.from(await document.save());
}

test("lists only the fields printed on the page being filled", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await authenticateTestUser(context, `${testInfo.project.name}-page-scope`);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await completeOnboarding(page);
  await page.getByRole("button", { name: "建立 Template" }).first().click();
  await page.locator('input[type="file"][accept*=".pdf"]').setInputFiles({
    name: "two-page-form.pdf",
    mimeType: "application/pdf",
    buffer: await twoPageFixture(),
  });
  await page.locator("#template-name").fill("Page Scope Test");
  await page.getByRole("button", { name: "建立 Draft" }).click();
  await expect(page.getByTestId("import-review-panel")).toBeVisible({ timeout: 90_000 });
  await page.getByTestId("confirm-import-btn").click();
  await expect(
    page.getByRole("heading", { name: "Page Scope Test · v1" })
  ).toBeVisible({ timeout: 90_000 });

  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "全部確認" }).click();
  await page.getByRole("button", { name: /儲存|Save/ }).click();
  await expect(
    page.getByText("DRAFT · 已保存至 localhost", { exact: true })
  ).toBeVisible();
  await page.getByRole("button", { name: "發佈" }).click();
  await expect(
    page.getByText("Template Version 已發佈及鎖定", { exact: true })
  ).toBeVisible();
  await page.getByRole("button", { name: "建立 Instance" }).click();

  /** Which fields the panel is offering, by the input each label points at. */
  const listedFields = () =>
    page
      .locator(".field-form-row label.field-form-label")
      .evaluateAll(nodes =>
        nodes.map(node => (node as HTMLLabelElement).htmlFor).filter(Boolean)
      );

  await expect(page.locator(".field-form-row").first()).toBeVisible();
  const onPageOne = await listedFields();
  expect(onPageOne.length).toBeGreaterThan(0);
  await expect(
    page.getByText(`第 1 頁 · ${onPageOne.length} 個欄位`)
  ).toBeVisible();

  const firstInput = page.locator(`[id="${onPageOne[0]}"]`);
  await firstInput.fill("page one value");

  await page.getByRole("button", { name: /^Page 2/ }).click();
  await expect(page.locator(".field-form-row").first()).toBeVisible();
  const onPageTwo = await listedFields();
  expect(onPageTwo.length).toBeGreaterThan(0);
  await expect(
    page.getByText(`第 2 頁 · ${onPageTwo.length} 個欄位`)
  ).toBeVisible();

  // The two pages offer entirely different fields; before the list was scoped
  // it showed the whole document on every page.
  expect(onPageTwo.filter(id => onPageOne.includes(id))).toEqual([]);
  await expect(firstInput).toHaveCount(0);

  // Coming back finds the value still there: the list was filtered, not reset.
  await page.getByRole("button", { name: /^Page 1/ }).click();
  await expect(page.locator(`[id="${onPageOne[0]}"]`)).toHaveValue(
    "page one value"
  );
});
