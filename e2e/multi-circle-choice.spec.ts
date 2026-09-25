import { expect, test } from "@playwright/test";
import { PDFCheckBox, PDFDocument, StandardFonts } from "pdf-lib";
import { authenticateTestUser, completeOnboarding } from "./test-runtime";
import { getVersionDetails, saveDraftAndConfirmFor, versionIdFromUrl } from "./save-completion";

async function letterForm() {
  const document = await PDFDocument.create();
  const page = document.addPage([420, 300]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText("Choose one:   A        B        C        D", {
    x: 40, y: 214, size: 12, font,
  });
  document.getForm().createTextField("answer").addToPage(page, {
    x: 105, y: 205, width: 220, height: 20, font,
  });
  return Buffer.from(await document.save());
}

function assetUrl(payload: unknown) {
  return JSON.stringify(payload).match(/\/api\/local\/assets\/[^"\\]+/)?.[0];
}

test("a person can circle A and C on a multi-select form and export editable PDF", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await authenticateTestUser(context, `${testInfo.project.name}-multi-circle-choice`);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const onboarding = page.getByRole("heading", { name: "Google 登入" });
  await expect.poll(async () =>
    (await onboarding.isVisible()) || (await page.getByRole("button", { name: "建立 Template" }).first().isVisible())
  ).toBe(true);
  if (await onboarding.isVisible()) await completeOnboarding(page);
  await page.getByRole("button", { name: "建立 Template" }).first().click();
  await page.locator('input[type="file"][accept*=".pdf"]').setInputFiles({
    name: "letters.pdf",
    mimeType: "application/pdf",
    buffer: await letterForm(),
  });
  await page.locator("#template-name").fill("Circle Choice Test");
  await page.getByRole("button", { name: "建立 Draft" }).click();
  await expect(page.getByTestId("import-review-panel")).toBeVisible({ timeout: 90_000 });
  await page.getByTestId("confirm-import-btn").click();
  await expect(page.getByRole("heading", { name: "Circle Choice Test · v1" })).toBeVisible({ timeout: 90_000 });

  const versionId = versionIdFromUrl(page);
  const before = await getVersionDetails(page, versionId);
  const text = before.fields.find(field => field.fieldType === "text");
  expect(text).toBeTruthy();
  await page.locator('button.field-row[data-field-type="text"]').first().click();
  const settings = page.locator(".editor-inspector");
  await settings.locator("select").first().selectOption("checkbox");
  await settings.getByRole("button", { name: "帶入 A／B／C／D 範例" }).click();
  await settings.getByTestId("choice-options").fill("A\nB\nC\nD\nE\nF");
  await expect(settings.locator('select:has(option[value="circle"])')).toHaveValue("circle");
  await expect(settings.getByTestId("choice-options")).toHaveValue("A\nB\nC\nD\nE\nF");
  await expect(page.locator(".field-overlay.is-active .mark-position-handle")).toHaveCount(6);

  await saveDraftAndConfirmFor(page, {
    versionId,
    target: {
      fieldId: String(text!.stableFieldId),
      assertField: field => {
        expect(field?.fieldType).toBe("checkbox");
        expect(field?.definition?.markStyle).toBe("circle");
        expect(field?.definition?.options).toEqual(["A", "B", "C", "D", "E", "F"]);
        expect(field?.definition?.optionMarks).toHaveLength(6);
      },
    },
  });
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "全部確認" }).click();
  await expect(settings.getByText("已人工確認")).toBeVisible();
  await saveDraftAndConfirmFor(page, {
    versionId,
    target: {
      fieldId: String(text!.stableFieldId),
      assertField: field => expect(field?.definition?.confirmed).toBe(true),
    },
  });
  await page.getByRole("button", { name: "發佈" }).click();
  await expect(page.getByText("Template Version 已發佈及鎖定", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "建立 Instance" }).click();

  for (const letter of ["A", "C"]) {
    const choice = page.locator(`.canvas-option-hotspot[title="${letter}"]`);
    await expect(choice).toBeVisible();
    await choice.click();
    await expect(choice).toHaveAttribute("aria-pressed", "true");
    await expect(choice.locator("svg ellipse")).toHaveCount(1);
  }
  await expect(page.locator(".canvas-option-hotspot svg ellipse")).toHaveCount(2);

  await page.locator(".fill-footer").getByRole("button", { name: "建立 Instance" }).click();
  await expect(page.getByText("Instance 已建立並綁定目前 Version")).toBeVisible();
  await page.getByText("輸出", { exact: true }).click();
  const [, response] = await Promise.all([
    page.waitForEvent("popup"),
    page.waitForResponse(item => item.url().includes("/api/trpc/formdigital.exports.pdf") && item.status() === 200),
    page.getByRole("button", { name: /可繼續填寫的 PDF|Editable PDF/ }).click(),
  ]);
  const url = assetUrl(await response.json());
  expect(url).toBeTruthy();
  const bytes = await (await page.request.get(new URL(url!, page.url()).href)).body();
  const fields = (await PDFDocument.load(bytes)).getForm().getFields();
  const checked = fields.filter(field => field instanceof PDFCheckBox && field.isChecked());
  expect(checked.map(field => field.getName().slice(-2))).toEqual(["_0", "_2"]);
});
