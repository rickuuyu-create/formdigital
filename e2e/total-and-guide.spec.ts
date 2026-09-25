import { expect, test, type Page } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { authenticateTestUser, completeOnboarding } from "./test-runtime";

const unwrap = (payload: any) => (Array.isArray(payload) ? payload[0] : payload).result.data.json ?? (Array.isArray(payload) ? payload[0] : payload).result.data;
async function tableDefinition(page: Page, versionId: string) {
  const response = await page.request.get(`/api/trpc/formdigital.templates.getVersionDetails?input=${encodeURIComponent(JSON.stringify({ json: { versionId } }))}`);
  expect(response.ok()).toBe(true);
  return unwrap(await response.json()).fields.find((field: any) => field.fieldType === "table")?.definition;
}

test("stage 4/5: nontechnical guide and column-total wizard persist safely", async ({ page, context }, info) => {
  test.setTimeout(180_000);
  await authenticateTestUser(context, `total-guide-${info.project.name}-${Date.now()}`);
  await page.goto("/");
  await completeOnboarding(page);

  const pdf = await PDFDocument.create();
  const sheet = pdf.addPage([500, 700]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.getForm().createTextField("total_table").addToPage(sheet, { x: 40, y: 200, width: 420, height: 300, font });
  await page.getByRole("button", { name: "建立 Template" }).first().click();
  await page.locator('input[type="file"][accept*=".pdf"]').setInputFiles({ name: "total-guide.pdf", mimeType: "application/pdf", buffer: Buffer.from(await pdf.save()) });
  await page.locator("#template-name").fill("Total Guide Test");
  await page.getByRole("button", { name: "建立 Draft" }).click();
  await expect(page.getByTestId("import-review-panel")).toBeVisible({ timeout: 90_000 });
  await page.getByTestId("confirm-import-btn").click();
  await expect(page.getByRole("heading", { name: "Total Guide Test · v1" })).toBeVisible({ timeout: 90_000 });

  await expect(page.getByTestId("workflow-guide").locator("li")).toHaveCount(5);
  await expect(page.getByTestId("workflow-guide")).toContainText("不代表系統保證辨識結果完全正確");
  await page.getByTestId("workflow-guide-close").click();
  await expect(page.getByTestId("workflow-guide")).toHaveCount(0);
  await page.getByTestId("workflow-guide-reopen").click();
  await expect(page.getByTestId("workflow-guide")).toBeVisible();

  await page.locator("button.field-row").first().click();
  const settings = page.locator("aside").last();
  await settings.locator("select").first().selectOption("table");
  await settings.locator('label:has-text("最大列數") + input').fill("6");
  await settings.locator('label:has-text("欄數") + input').fill("4");
  await expect(page.getByTestId("field-settings-nav")).toContainText("計算");

  const versionId = new URL(page.url()).searchParams.get("version")!;
  await page.getByRole("button", { name: /儲存|Save/, exact: true }).click();
  await expect.poll(async () => {
    const saved = await tableDefinition(page, versionId);
    return [saved?.maxRows, saved?.tableColumns];
  }).toEqual([6, 4]);

  await page.getByTestId("column-total-wizard-open").click();
  const endRow = 4;
  const targetRow = 5;
  await page.getByTestId("total-source-column").selectOption("2");
  await page.getByTestId("total-target-column").selectOption("2");
  await page.getByTestId("total-start-row").fill("1");
  await page.getByTestId("total-end-row").fill(String(endRow + 1));
  await page.getByTestId("total-target-row").fill(String(targetRow + 1));
  await expect(page.getByTestId("total-end-row")).toHaveValue(String(endRow + 1));
  await expect(page.getByTestId("total-target-row")).toHaveValue(String(targetRow + 1));
  await page.getByTestId("total-samples").fill("100\n200\n\n50");
  const expectedExpression = `SUM(C1:C${endRow + 1})`;
  await expect(page.getByTestId("total-expression")).toContainText(expectedExpression);
  await expect(page.getByTestId("total-preview")).toContainText("350.00");
  await expect(page.getByTestId("total-apply")).toBeEnabled();
  await page.getByTestId("total-apply").click();
  await expect(page.getByTestId(`cell-${targetRow}-2`)).toHaveText("fx");

  await page.getByRole("button", { name: /儲存|Save/, exact: true }).click();
  await expect.poll(async () => (await tableDefinition(page, versionId))?.tableFormulaSchemaVersion).toBe(2);
  const definition = await tableDefinition(page, versionId);
  expect(definition.tableFormulaCells).toContainEqual({ row: targetRow, column: 2, expression: expectedExpression, decimalPlaces: 2 });

  await page.reload();
  await page.locator('button.field-row[data-field-type="table"]').first().click();
  await page.getByTestId("column-total-wizard-open").click();
  await expect(page.getByTestId("total-expression")).toContainText(`SUM(A1:A${endRow + 1})`);
  await page.getByTestId("total-cancel").click();
});
