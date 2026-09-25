import { expect, test, type Page } from "@playwright/test";
import { PDFCheckBox, PDFDocument, StandardFonts } from "pdf-lib";
import { authenticateTestUser, completeOnboarding } from "./test-runtime";
import { getVersionDetails, saveDraftAndConfirmFor, versionIdFromUrl } from "./save-completion";

async function importForm(page: Page) {
  const pdf = await PDFDocument.create();
  const sheet = pdf.addPage([420, 595]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.getForm().createTextField("Consent").addToPage(sheet, { x: 40, y: 500, width: 240, height: 60, font });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await completeOnboarding(page);
  await page.getByRole("button", { name: "建立 Template" }).first().click();
  await page.locator('input[type="file"][accept*=".pdf"]').setInputFiles({ name: "acceptance.pdf", mimeType: "application/pdf", buffer: Buffer.from(await pdf.save()) });
  await page.locator("#template-name").fill("Manual Acceptance Regression");
  await page.getByRole("button", { name: "建立 Draft" }).click();
  await expect(page.getByTestId("import-review-panel")).toBeVisible({ timeout: 90_000 });
  await page.getByTestId("confirm-import-btn").click();
  await expect(page.getByRole("heading", { name: "Manual Acceptance Regression · v1" })).toBeVisible({ timeout: 90_000 });
  await page.locator('button.field-row[data-field-type="text"]').first().click();
  return { versionId: versionIdFromUrl(page), settings: page.locator(".editor-inspector") };
}

test("a named single checkbox stays checked across panel, paper, save and editable PDF", async ({ context, page }, info) => {
  test.setTimeout(180_000);
  await authenticateTestUser(context, `${info.project.name}-manual-single-checkbox`);
  const { versionId, settings } = await importForm(page);
  const original = (await getVersionDetails(page, versionId)).fields.find(f => f.fieldType === "text")!;
  await settings.locator("select").first().selectOption("checkbox");
  await settings.getByTestId("choice-options").fill("Agree");
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "全部確認" }).click();
  await saveDraftAndConfirmFor(page, { versionId, target: { fieldId: String(original.stableFieldId), assertField: f => expect(f?.definition?.options).toEqual(["Agree"]) } });
  await page.getByRole("button", { name: "發佈", exact: true }).click();
  await expect(page.getByText("Template Version 已發佈及鎖定", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "建立 Instance", exact: true }).click();
  const checkbox = page.locator(".field-form").getByRole("checkbox", { name: "Agree", exact: true });
  await checkbox.check();
  await expect(page.locator('.canvas-option-hotspot[title="Agree"]')).toHaveAttribute("aria-pressed", "true");
  await page.locator('.canvas-option-hotspot[title="Agree"]').click();
  await expect(checkbox).not.toBeChecked();
  await checkbox.check();
  await page.locator(".fill-footer").getByRole("button", { name: "建立 Instance", exact: true }).click();
  await expect(page).toHaveURL(/instance=ins_/);
  await page.reload();
  await expect(checkbox).toBeChecked();
  await expect(page.locator('.canvas-option-hotspot[title="Agree"]')).toHaveAttribute("aria-pressed", "true");
  await page.getByText("輸出", { exact: true }).click();
  const [, response] = await Promise.all([
    page.waitForEvent("popup"),
    page.waitForResponse(r => r.url().includes("/api/trpc/formdigital.exports.pdf") && r.status() === 200),
    page.getByRole("button", { name: "可繼續填寫的 PDF", exact: true }).click(),
  ]);
  const url = JSON.stringify(await response.json()).match(/\/api\/local\/assets\/[^"\\]+/)?.[0];
  expect(url).toBeTruthy();
  const bytes = await (await page.request.get(new URL(url!, page.url()).href)).body();
  const boxes = (await PDFDocument.load(bytes)).getForm().getFields().filter(f => f instanceof PDFCheckBox) as PDFCheckBox[];
  expect(boxes).toHaveLength(1);
  expect(boxes[0].isChecked()).toBe(true);
});

test("telephone text stays synchronized between the paper and the side panel after saving", async ({ context, page }, info) => {
  await authenticateTestUser(context, `${info.project.name}-manual-telephone`);
  const { versionId, settings } = await importForm(page);
  const original = (await getVersionDetails(page, versionId)).fields.find(f => f.fieldType === "text")!;
  await settings.getByRole("textbox", { name: "欄位名稱", exact: true }).fill("Tel. No.");
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "全部確認" }).click();
  await saveDraftAndConfirmFor(page, { versionId, target: { fieldId: String(original.stableFieldId), assertField: f => expect(f?.definition?.label).toBe("Tel. No.") } });
  await page.getByRole("button", { name: "發佈", exact: true }).click();
  await expect(page.getByText("Template Version 已發佈及鎖定", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "建立 Instance", exact: true }).click();
  const panel = page.locator(".field-form").getByRole("textbox", { name: "Tel. No. 單行文字", exact: true });
  const paper = page.getByRole("textbox", { name: "Tel. No.", exact: true });
  await panel.fill("55550101");
  await expect(paper).toHaveValue("55550101");
  await paper.fill("55550102");
  await expect(panel).toHaveValue("55550102");
  await page.locator(".fill-footer").getByRole("button", { name: "建立 Instance", exact: true }).click();
  await expect(page).toHaveURL(/instance=ins_/);
  await page.reload();
  await expect(paper).toHaveValue("55550102");
  await expect(panel).toHaveValue("55550102");
});

test("an inherited irregular table can reset its grid without losing roles and can undo", async ({ context, page }, info) => {
  test.setTimeout(180_000);
  await authenticateTestUser(context, `${info.project.name}-manual-grid-reset`);
  const { versionId, settings } = await importForm(page);
  const original = (await getVersionDetails(page, versionId)).fields.find(f => f.fieldType === "text")!;
  await settings.locator("select").first().selectOption("table");
  await settings.getByRole("spinbutton").nth(4).fill("3");
  await settings.getByRole("spinbutton").nth(5).fill("1");
  await settings.getByRole("button", { name: "逐格微調", exact: true }).click();
  const cell = page.locator(".field-overlay.is-active .mark-position-handle").first();
  await cell.focus();
  await cell.press("ArrowRight");
  await cell.press("Enter");
  await settings.getByRole("spinbutton").nth(4).fill("11");
  await settings.getByRole("spinbutton").nth(5).fill("4");
  await settings.getByRole("button", { name: "選取第1列", exact: true }).click();
  await settings.getByRole("button", { name: "不可填寫", exact: true }).click();
  await saveDraftAndConfirmFor(page, { versionId, target: { fieldId: String(original.stableFieldId), assertField: f => {
    expect(f?.definition?.maxRows).toBe(11);
    expect(f?.definition?.tableColumns).toBe(4);
  } } });
  const before = (await getVersionDetails(page, versionId)).fields.find(f => f.stableFieldId === original.stableFieldId)!;
  await settings.getByRole("button", { name: "重新均分格線", exact: true }).click();
  await saveDraftAndConfirmFor(page, { versionId, target: { fieldId: String(original.stableFieldId), assertField: f => {
    const guides = f?.definition?.tableCellGuides as Array<{ xRatio: number; yRatio: number; widthRatio: number; heightRatio: number }>;
    expect(guides).toHaveLength(44);
    for (const [index, guide] of guides.entries()) {
      expect(guide.xRatio).toBeCloseTo((index % 4) / 4, 8);
      expect(guide.yRatio).toBeCloseTo(Math.floor(index / 4) / 11, 8);
      expect(guide.widthRatio).toBeCloseTo(.25, 8);
      expect(guide.heightRatio).toBeCloseTo(1 / 11, 8);
    }
    expect(f?.definition?.tableWritableCells).toEqual(before.definition?.tableWritableCells);
  } } });
  await page.getByRole("button", { name: "復原", exact: true }).click();
  await saveDraftAndConfirmFor(page, { versionId, target: { fieldId: String(original.stableFieldId), assertField: f => expect(f?.definition?.tableCellGuides).toEqual(before.definition?.tableCellGuides) } });
});
