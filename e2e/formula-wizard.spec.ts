import { test, expect, type Page } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { authenticateTestUser, completeOnboarding } from "./test-runtime";

function data(payload: any) {
  const item = Array.isArray(payload) ? payload[0] : payload;
  return item.result.data.json ?? item.result.data;
}
async function definition(page: Page, id: string) {
  const response = await page.request.get(
    `/api/trpc/formdigital.templates.getVersionDetails?input=${encodeURIComponent(JSON.stringify({ json: { versionId: id } }))}`,
  );
  expect(response.status()).toBe(200);
  return data(await response.json()).fields.find(
    (f: any) => f.fieldType === "table",
  )?.definition;
}
for (const locale of ["zh-Hant", "zh-Hans", "en"] as const)
  test(`wizard ${locale}: samples, cancellation, column apply, undo, persistence and validation`, async ({
    page,
    context,
  }, info) => {
    test.setTimeout(180_000);
    await authenticateTestUser(
      context,
      `wizard-${locale}-${info.project.name}`,
    );
    await page.goto("/");
    await completeOnboarding(page);
    const pdf = await PDFDocument.create(),
      sheet = pdf.addPage([500, 700]),
      font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf
      .getForm()
      .createTextField("wizard_table")
      .addToPage(sheet, { x: 40, y: 200, width: 420, height: 300, font });
    await page.getByRole("button", { name: "建立 Template" }).first().click();
    await page.locator('input[type="file"][accept*=".pdf"]').setInputFiles({
      name: "wizard.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(await pdf.save()),
    });
    await page.locator("#template-name").fill("Wizard Test");
    await page.getByRole("button", { name: "建立 Draft" }).click();
    await expect(page.getByTestId("import-review-panel")).toBeVisible({
      timeout: 90_000,
    });
    await page.getByTestId("confirm-import-btn").click();
    await expect(
      page.getByRole("heading", { name: "Wizard Test · v1" }),
    ).toBeVisible({ timeout: 90_000 });
    await page.locator("button.field-row").first().click();
    const settings = page.locator("aside").last();
    await settings.locator("select").first().selectOption("table");
    await settings.locator('label:has-text("最大列數") + input').fill("6");
    await settings.locator('label:has-text("欄數") + input').fill("12");
    const url = page.url(),
      id = new URL(url).searchParams.get("version")!;
    await page.getByRole("button", { name: /儲存|Save/, exact: true }).click();
    await expect
      .poll(async () => (await definition(page, id))?.tableColumns)
      .toBe(12);
    if (locale !== "zh-Hant") {
      await page.goto("/?view=settings");
      await page.locator("#interface-locale").selectOption(locale);
      await page.goto(url);
      await page
        .locator('button.field-row[data-field-type="table"]')
        .first()
        .click();
    }
    const before = await definition(page, id);
    let saves = 0;
    page.on("request", (req) => {
      if (req.method() === "POST" && req.url().includes("saveDraftFields"))
        saves++;
    });
    const configure = async () => {
      await page.getByTestId("formula-wizard-open").click();
      await page.getByTestId("wizard-result").selectOption("11");
      await page.getByTestId("wizard-left").selectOption("2");
      await page.getByTestId("wizard-right").selectOption("3");
      await page.getByTestId("wizard-sample-0-2").fill("3");
      await page.getByTestId("wizard-sample-0-3").fill("12.5");
      await page.getByTestId("wizard-sample-1-2").fill("2");
      await expect(page.getByTestId("wizard-expression")).toHaveValue("C*D");
      await expect(page.getByTestId("wizard-preview-0")).toHaveText("37.50");
      await expect(page.getByTestId("wizard-preview-1")).toHaveText("0.00");
      await expect(page.getByTestId("wizard-preview-2")).toHaveText(
        locale === "en" ? "Blank" : "留白",
      );
    };
    await configure();
    await page.getByRole("dialog").evaluate((el) => {
      el.scrollTop = 0;
    });
    await page
      .getByRole("dialog")
      .screenshot({ path: info.outputPath(`wizard-${locale}.png`) });
    await expect(page.getByRole("dialog")).toContainText(
      locale === "en"
        ? "Sample values are never written"
        : locale === "zh-Hans"
          ? "示例值不会写入"
          : "範例值不會寫入",
    );
    for (const [preset, expression, result] of [
      ["add", "C+D", "15.50"],
      ["subtract", "C-D", "-9.50"],
      ["percent", "C*D/100", "0.38"],
    ]) {
      await page.getByTestId("wizard-kind").selectOption(preset);
      await expect(page.getByTestId("wizard-expression")).toHaveValue(
        expression,
      );
      await expect(page.getByTestId("wizard-preview-0")).toHaveText(result);
    }
    await page.getByTestId("wizard-kind").selectOption("multiply");
    await page.getByTestId("wizard-sample-0-2").fill("0");
    await expect(page.getByTestId("wizard-preview-0")).toHaveText("0.00");
    await page.getByTestId("wizard-sample-0-3").fill("abc");
    await expect(page.getByTestId("wizard-apply-column")).toBeDisabled();
    await page.getByTestId("wizard-cancel").click();
    // Observation window exceeds autosave debounce; editing samples must emit no save.
    await page.waitForTimeout(1100);
    expect(saves).toBe(0);
    expect(await definition(page, id)).toEqual(before);
    await configure();
    await page.getByTestId("wizard-apply-column").click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByTestId("cell-5-11")).toHaveText("fx");
    await page.keyboard.press("Control+z");
    await expect(page.getByTestId("cell-5-11")).toHaveText("✓");
    await expect
      .poll(async () => (await definition(page, id)).tableFormulaCells ?? [])
      .toEqual(before.tableFormulaCells ?? []);
    await configure();
    await page.getByTestId("wizard-apply-column").click();
    const expected = Array.from({ length: 6 }, (_, row) => ({
      row,
      column: 11,
      expression: "C*D",
      decimalPlaces: 2,
    }));
    await expect
      .poll(async () => (await definition(page, id)).tableFormulaCells)
      .toEqual(expected);
    await page.reload();
    await page
      .locator('button.field-row[data-field-type="table"]')
      .first()
      .click();
    expect((await definition(page, id)).tableFormulaCells).toEqual(expected);
    await page.getByTestId("cell-5-11").click();
    await page.getByTestId("formula-wizard-open").click();
    await expect(page.getByTestId("wizard-expression")).toHaveValue("C*D");
    await expect(page.getByTestId("wizard-kind")).toHaveValue("custom");
    await expect(page.getByTestId("wizard-row")).toHaveValue("5");
    await page.getByTestId("wizard-result").selectOption("11");
    await page.getByTestId("wizard-kind").selectOption("custom");
    for (const expression of ["L+1", "A1*B1", "SUM(A)", "A*"]) {
      await page.getByTestId("wizard-expression").fill(expression);
      await expect(page.getByTestId("wizard-validation")).not.toBeEmpty();
      await expect(page.getByTestId("wizard-apply-column")).toBeDisabled();
    }
    for (const expression of ["C/0", "SQRT(-1)", "2^101"]) {
      await page.getByTestId("wizard-expression").fill(expression);
      if (expression === "C/0")
        await page.getByTestId("wizard-sample-0-2").fill("2");
      await expect(page.getByTestId("wizard-apply-cell")).toBeDisabled();
      await expect(page.getByTestId("wizard-preview-0")).not.toHaveText("0.00");
    }
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByTestId("formula-wizard-open")).toBeFocused();
    await page.getByTestId("formula-wizard-open").click();
    await page.getByTestId("wizard-result").selectOption("11");
    await page.getByTestId("wizard-row").selectOption({ value: "5" });
    await expect(page.getByTestId("wizard-row")).toHaveValue("5");
    await page.getByTestId("wizard-kind").selectOption("custom");
    await page.getByTestId("wizard-expression").fill("SQRT(C)^2");
    await page.getByTestId("wizard-apply-cell").click();
    await expect
      .poll(async () => (await definition(page, id)).tableFormulaCells)
      .toEqual(
        expected.map((f, row) =>
          row === 5 ? { ...f, expression: "SQRT(C)^2" } : f,
        ),
      );
  });
