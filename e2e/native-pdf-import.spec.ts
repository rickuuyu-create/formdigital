import { expect, test } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { authenticateTestUser, completeOnboarding } from "./test-runtime";

async function nativeFormFixture() {
  const document = await PDFDocument.create();
  const page = document.addPage([420, 594]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const form = document.getForm();

  page.drawText("NATIVE REGISTRATION FORM", { x: 40, y: 550, size: 16, font });
  page.drawText("Full Name:", { x: 40, y: 495, size: 11, font });
  page.drawText("Consent:", { x: 40, y: 435, size: 11, font });
  page.drawText("Contact method:", { x: 40, y: 375, size: 11, font });
  page.drawText("Email", { x: 180, y: 345, size: 10, font });
  page.drawText("Phone", { x: 265, y: 345, size: 10, font });
  page.drawText("Department:", { x: 40, y: 285, size: 11, font });

  form.createTextField("Full Name").addToPage(page, {
    x: 150,
    y: 485,
    width: 200,
    height: 24,
    font,
  });
  form.createCheckBox("Consent").addToPage(page, {
    x: 150,
    y: 425,
    width: 18,
    height: 18,
  });
  const radio = form.createRadioGroup("Contact method");
  radio.addOptionToPage("email", page, { x: 150, y: 338, width: 16, height: 16 });
  radio.addOptionToPage("phone", page, { x: 235, y: 338, width: 16, height: 16 });
  const dropdown = form.createDropdown("Department");
  dropdown.addOptions(["Engineering", "Operations"]);
  dropdown.addToPage(page, {
    x: 150,
    y: 275,
    width: 200,
    height: 24,
    font,
  });
  return Buffer.from(await document.save());
}

test("imports native PDF text and AcroForm Widgets without starting OCR", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await authenticateTestUser(context, `${testInfo.project.name}-native-pdf-import`);

  const ocrMutationRequests: string[] = [];
  const browserOcrRequests: string[] = [];
  page.on("request", request => {
    const url = request.url();
    if (url.includes("formdigital.ocr.recognize")) ocrMutationRequests.push(url);
    if (url.includes("/ocr-runtime/")) browserOcrRequests.push(url);
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await completeOnboarding(page);
  await page.getByRole("button", { name: "建立 Template" }).first().click();
  await page.locator('input[type="file"][accept*=".pdf"]').setInputFiles({
    name: "native-form.pdf",
    mimeType: "application/pdf",
    buffer: await nativeFormFixture(),
  });
  await page.locator("#template-name").fill("E2E Native PDF Template");
  await page.getByRole("button", { name: "建立 Draft" }).click();
  const confirmBtn = page.getByRole("button", { name: "採用建議並完成匯入" });
  await confirmBtn.waitFor({ state: "visible", timeout: 90_000 });
  await confirmBtn.click();

  await expect(
    page.getByRole("heading", { name: "E2E Native PDF Template · v1" })
  ).toBeVisible({ timeout: 90_000 });
  const settings = page.locator("aside").last();
  const expectedTypes = [
    ["Full Name", "text"],
    ["Consent", "checkbox"],
    ["Contact method", "radio"],
    ["Department", "select"],
  ] as const;
  for (const [label, fieldType] of expectedTypes) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect(settings.locator("select").first()).toHaveValue(fieldType);
    await expect(settings.getByText("需要確認", { exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "Contact method", exact: true }).click();
  await expect(settings.locator("textarea")).toHaveValue("Email\nPhone");
  await page.getByRole("button", { name: "Department", exact: true }).click();
  await expect(settings.locator("textarea")).toHaveValue("Engineering\nOperations");

  expect(ocrMutationRequests).toEqual([]);
  expect(browserOcrRequests).toEqual([]);
});
