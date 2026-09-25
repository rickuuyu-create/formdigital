import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { parse as parseCsv } from "csv-parse/sync";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { tableCellRect } from "../shared/tableGeometry";
import { authenticateTestUser, completeOnboarding } from "./test-runtime";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

const standardFontDataUrl = `${path
  .join(projectRoot, "node_modules", "pdfjs-dist", "standard_fonts")
  .replaceAll("\\", "/")}/`;

/**
 * Synthetic 4-column table fixture:
 * A: Item (項目), B: Income (收入), C: Expense (支出), D: Balance (結餘)
 */
async function financialTableFixture() {
  const document = await PDFDocument.create();
  const page = document.addPage([500, 400]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  // Initial PDF text field to be detected and mapped to a table
  document
    .getForm()
    .createTextField("statement_table")
    .addToPage(page, { x: 50, y: 150, width: 400, height: 180, font });
  return Buffer.from(await document.save());
}

function findAssetUrl(payload: unknown): string | undefined {
  const seen = JSON.stringify(payload);
  return seen.match(/\/api\/local\/assets\/[^"\\]+/)?.[0];
}

function extractTrpcData(payload: unknown): any {
  const item = Array.isArray(payload) ? payload[0] : payload;
  const data = item?.result?.data;
  if (data && typeof data === "object" && "json" in data) {
    return (data as Record<string, unknown>).json;
  }
  return data;
}

async function extractPdfTextItems(pdfBytes: Uint8Array) {
  const loadingTask = getDocument({
    data: pdfBytes,
    standardFontDataUrl,
  });
  const pdfJsDocument = await loadingTask.promise;
  try {
    const page1 = await pdfJsDocument.getPage(1);
    const content = await page1.getTextContent();
    const items = content.items
      .filter((item): item is { str: string; transform: number[]; width: number; height: number } => "str" in item)
      .map(item => ({
        text: item.str,
        x: item.transform[4],
        y: item.transform[5],
        width: item.width,
        height: item.height,
      }));
    const fullText = items.map(i => i.text).join(" ");
    return { items, fullText };
  } finally {
    await pdfJsDocument.destroy();
  }
}

test("configures 4-column table cell roles and batch formulas, verifies live calc, draft preservation, fail-closed publish, and real exports", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  await authenticateTestUser(context, `${testInfo.project.name}-table-roles-formulas`);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await completeOnboarding(page);

  // 1. Create Template from synthetic PDF
  await page.getByRole("button", { name: "建立 Template" }).first().click();
  await page.locator('input[type="file"][accept*=".pdf"]').setInputFiles({
    name: "financial-table.pdf",
    mimeType: "application/pdf",
    buffer: await financialTableFixture(),
  });
  await page.locator("#template-name").fill("Financial Table Template");
  await page.getByRole("button", { name: "建立 Draft" }).click();
  await expect(page.getByTestId("import-review-panel")).toBeVisible({ timeout: 90_000 });
  await page.getByTestId("confirm-import-btn").click();
  await expect(
    page.getByRole("heading", { name: "Financial Table Template · v1" })
  ).toBeVisible({ timeout: 90_000 });

  // 2. Select field and switch to table
  await page.getByRole("button", { name: "statement table", exact: true }).click();
  const settings = page.locator("aside").last();
  await settings.locator("select").first().selectOption("table");

  // Set 4 rows and 4 columns
  const maxRowsInput = settings.locator('label:has-text("最大列數") + input');
  await maxRowsInput.fill("4");
  const colsInput = settings.locator('label:has-text("欄數") + input');
  await colsInput.fill("4");

  // Verify TableRoleEditor appears
  await expect(
    settings.getByText("表格儲存格角色與公式", { exact: false })
  ).toBeVisible();

  // Save draft initially so the table field configuration is persisted
  await page.getByRole("button", { name: /儲存|Save/ }).click();
  await expect(
    page.getByText("DRAFT · 已保存至 localhost", { exact: true })
  ).toBeVisible();

  const editorUrl = page.url();

  // Helper to switch locale via Settings and return to editor
  const switchLocaleViaSettings = async (targetLocale: "zh-Hant" | "zh-Hans" | "en") => {
    await page.goto("/?view=settings");
    await page.locator("#interface-locale").selectOption(targetLocale);
    await expect(page.locator("html")).toHaveAttribute("lang", targetLocale);
    await page.goto(editorUrl);
    await expect(
      page.getByRole("heading", { name: /Financial Table Template/ })
    ).toBeVisible();
    await page.locator('button.field-row[data-field-type="table"]').first().click();
  };

  // -----------------------------------------------------------------
  // R4-P4: Comprehensive Trilingual Safe Localization & Error Handling
  // -----------------------------------------------------------------

  // --- A. Verify zh-Hant (Traditional Chinese) ---
  await settings.locator('button[data-testid="clear-selection-button"]').click();
  const toggleHant = settings.locator('button[data-testid="toggle-multi-select-mode"]');
  await expect(toggleHant).toContainText("多選模式：關閉");
  await toggleHant.click();
  await expect(toggleHant).toHaveAttribute("aria-pressed", "true");
  await expect(toggleHant).toContainText("多選模式：開啟");
  await settings.locator('button[data-testid="cell-1-3"]').click();
  await settings.locator('button[data-testid="cell-2-3"]').click();
  const badgeHant = settings.locator('[data-testid="selection-count-badge"]');
  await expect(badgeHant).toContainText("已選取 2 個儲存格");
  await toggleHant.click();
  await expect(toggleHant).toHaveAttribute("aria-pressed", "false");
  await expect(toggleHant).toContainText("多選模式：關閉");
  await expect(settings.locator('button[data-testid="batch-writable-button"]')).toHaveText("可輸入");
  await expect(settings.locator('button[data-testid="batch-formula-button"]')).toHaveText("公式");
  await expect(settings.locator('button[data-testid="batch-fixed-button"]')).toHaveText("不可填寫");
  const formulaInputHant = settings.locator('input[data-testid="formula-expression-input"]');
  await expect(formulaInputHant).toHaveAttribute("placeholder", "例：B+C 或 =B*C");
  // Test empty formula error
  await formulaInputHant.fill("");
  await settings.locator('button[data-testid="batch-formula-button"]').click();
  const bannerHant = settings.locator('[data-testid="formula-validation-banner"]');
  await expect(bannerHant).toBeVisible();
  await expect(bannerHant).toContainText("公式不可為空");
  // Test unsupported function error
  await formulaInputHant.fill("SUM(A)");
  await expect(bannerHant).toContainText("語法錯誤：不支援的函數名稱（僅支援 sqrt）");
  await expect(bannerHant).not.toContainText("UNSUPPORTED_FUNCTION");
  await expect(bannerHant).not.toContainText("UNEXPECTED_CHARACTER");
  await expect(bannerHant).not.toContainText(": SUM");
  await expect(page.locator("body")).not.toContainText("UNSUPPORTED_FUNCTION");

  // --- B. Verify zh-Hans (Simplified Chinese) via Settings ---
  await switchLocaleViaSettings("zh-Hans");
  const settingsHans = page.locator("aside").last();
  await settingsHans.locator('button[data-testid="clear-selection-button"]').click();
  const toggleHans = settingsHans.locator('button[data-testid="toggle-multi-select-mode"]');
  await expect(toggleHans).toContainText("多选模式：关闭");
  await toggleHans.click();
  await expect(toggleHans).toHaveAttribute("aria-pressed", "true");
  await expect(toggleHans).toContainText("多选模式：开启");
  await settingsHans.locator('button[data-testid="cell-1-3"]').click();
  await settingsHans.locator('button[data-testid="cell-2-3"]').click();
  const badgeHans = settingsHans.locator('[data-testid="selection-count-badge"]');
  await expect(badgeHans).toContainText("已选取 2 个储存格");
  await toggleHans.click();
  await expect(toggleHans).toHaveAttribute("aria-pressed", "false");
  await expect(toggleHans).toContainText("多选模式：关闭");
  await expect(settingsHans.locator('button[data-testid="batch-writable-button"]')).toHaveText("可输入");
  await expect(settingsHans.locator('button[data-testid="batch-formula-button"]')).toHaveText("公式");
  await expect(settingsHans.locator('button[data-testid="batch-fixed-button"]')).toHaveText("不可填写");
  const formulaInputHans = settingsHans.locator('input[data-testid="formula-expression-input"]');
  await expect(formulaInputHans).toHaveAttribute("placeholder", "例：B+C 或 =B*C");
  // Test empty formula error in Simplified Chinese
  await formulaInputHans.fill("");
  await settingsHans.locator('button[data-testid="batch-formula-button"]').click();
  const bannerHans = settingsHans.locator('[data-testid="formula-validation-banner"]');
  await expect(bannerHans).toBeVisible();
  await expect(bannerHans).toContainText("公式不可为空");
  // Test unsupported function error in Simplified Chinese
  await formulaInputHans.fill("SUM(A)");
  await expect(bannerHans).toContainText("语法错误：不支持的函数名称（仅支持 sqrt）");
  await expect(bannerHans).not.toContainText("UNSUPPORTED_FUNCTION");
  await expect(bannerHans).not.toContainText("UNEXPECTED_CHARACTER");
  await expect(bannerHans).not.toContainText(": SUM");
  await expect(page.locator("body")).not.toContainText("UNSUPPORTED_FUNCTION");

  // --- C. Verify en (English) via Settings ---
  await switchLocaleViaSettings("en");
  const settingsEn = page.locator("aside").last();
  await settingsEn.locator('button[data-testid="clear-selection-button"]').click();
  const toggleEn = settingsEn.locator('button[data-testid="toggle-multi-select-mode"]');
  await expect(toggleEn).toContainText("Multi-Select: OFF");
  await toggleEn.click();
  await expect(toggleEn).toHaveAttribute("aria-pressed", "true");
  await expect(toggleEn).toContainText("Multi-Select: ON");
  await settingsEn.locator('button[data-testid="cell-1-3"]').click();
  await settingsEn.locator('button[data-testid="cell-2-3"]').click();
  const badgeEn = settingsEn.locator('[data-testid="selection-count-badge"]');
  await expect(badgeEn).toContainText("Selected 2 cells");
  await toggleEn.click();
  await expect(toggleEn).toHaveAttribute("aria-pressed", "false");
  await expect(toggleEn).toContainText("Multi-Select: OFF");
  await expect(settingsEn.locator('button[data-testid="batch-writable-button"]')).toHaveText("Writable");
  await expect(settingsEn.locator('button[data-testid="batch-formula-button"]')).toHaveText("Formula");
  await expect(settingsEn.locator('button[data-testid="batch-fixed-button"]')).toHaveText("Fixed");
  const formulaInputEn = settingsEn.locator('input[data-testid="formula-expression-input"]');
  await expect(formulaInputEn).toHaveAttribute("placeholder", "e.g. B+C or =B*C");
  // Test empty formula error in English
  await formulaInputEn.fill("");
  await settingsEn.locator('button[data-testid="batch-formula-button"]').click();
  const bannerEn = settingsEn.locator('[data-testid="formula-validation-banner"]');
  await expect(bannerEn).toBeVisible();
  await expect(bannerEn).toContainText("Formula expression cannot be empty");
  // Test unsupported function error in English
  await formulaInputEn.fill("SUM(A)");
  await expect(bannerEn).toContainText("Syntax error: Unsupported function (only sqrt is supported)");
  await expect(bannerEn).not.toContainText("UNSUPPORTED_FUNCTION");
  await expect(bannerEn).not.toContainText("UNEXPECTED_CHARACTER");
  await expect(bannerEn).not.toContainText(": SUM");
  await expect(page.locator("body")).not.toContainText("UNSUPPORTED_FUNCTION");

  // --- D. Switch back to zh-Hant to continue core workflow ---
  await switchLocaleViaSettings("zh-Hant");
  const finalSettings = page.locator("aside").last();

  // Test Selection Controls & Accessible Buttons:
  // Select All button (#)
  const selectAllBtn = finalSettings.locator('button[data-testid="select-all-button"]');
  await selectAllBtn.click();
  const selectionBadge = finalSettings.locator('[data-testid="selection-count-badge"]');
  await expect(selectionBadge).toContainText("16");

  // Clear selection button
  const clearSelectionBtn = finalSettings.locator('button[data-testid="clear-selection-button"]');
  await clearSelectionBtn.click();
  await expect(selectionBadge).toContainText("0");

  // Configure Roles:
  // Row 1 (Header/Title row): select Row 1 and set to fixed (不可填寫)
  await finalSettings.locator('button[data-testid="select-row-0"]').click();
  await finalSettings.locator('button[data-testid="batch-fixed-button"]').click();

  // Row 4 (Summary row): select Row 4 and set to fixed (不可填寫)
  await finalSettings.locator('button[data-testid="select-row-3"]').click();
  await finalSettings.locator('button[data-testid="batch-fixed-button"]').click();

  // Clear selection before testing multi-cell selection
  await clearSelectionBtn.click();
  await expect(selectionBadge).toContainText("0");

  // Multi-cell selection with toggle mode:
  const toggleMultiSelectBtn = finalSettings.locator('button[data-testid="toggle-multi-select-mode"]');
  await toggleMultiSelectBtn.click();
  await expect(toggleMultiSelectBtn).toHaveAttribute("aria-pressed", "true");

  // Click Row 2 Col D (cell-1-3)
  const cell13 = finalSettings.locator('button[data-testid="cell-1-3"]');
  await cell13.click();
  await expect(cell13).toHaveAttribute("aria-pressed", "true");

  // Click Row 3 Col D (cell-2-3)
  const cell23 = finalSettings.locator('button[data-testid="cell-2-3"]');
  await cell23.click();
  await expect(cell23).toHaveAttribute("aria-pressed", "true");
  await expect(selectionBadge).toContainText("2");

  await toggleMultiSelectBtn.click();
  await expect(toggleMultiSelectBtn).toHaveAttribute("aria-pressed", "false");

  // Fill valid batch formula input and apply
  const formulaInput = finalSettings.locator('input[data-testid="formula-expression-input"]');
  await formulaInput.fill("B+C");
  const validationBanner = finalSettings.locator('[data-testid="formula-validation-banner"]');
  await expect(validationBanner).toContainText("公式語法正確");

  const applyBatchBtn = finalSettings.locator('button[data-testid="apply-batch-formula-button"]');
  await applyBatchBtn.click();

  // Verify both selected cells now show fx
  await expect(cell13).toHaveText("fx");
  await expect(cell23).toHaveText("fx");

  // Test P1-B: Draft formula preservation & fail-closed publish validation
  // Select Row 2 Col A (cell-1-0) and set to empty formula draft
  const cell10 = settings.locator('button[data-testid="cell-1-0"]');
  await cell10.click();
  await settings.locator('button[data-testid="batch-formula-button"]').click();
  await formulaInput.fill("");
  await expect(cell10).toHaveText("fx");

  // Save Draft
  const confirmAllBtn = page.getByRole("button", { name: "全部確認" });
  if (await confirmAllBtn.isVisible()) {
    page.once("dialog", dialog => dialog.accept());
    await confirmAllBtn.click();
  }
  await page.getByRole("button", { name: "確認此欄位" }).click();
  await page.getByRole("button", { name: /儲存|Save/ }).click();
  await expect(
    page.getByText("DRAFT · 已保存至 localhost", { exact: true })
  ).toBeVisible();

  // Reload page to verify empty formula draft is preserved across reloads
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator('button.field-row[data-field-type="table"]').first().click();
  const reloadedCell10 = page.locator('button[data-testid="cell-1-0"]');
  await expect(reloadedCell10).toHaveText("fx");

  // ---------------------------------------------------------------------------
  // R7-P1: Prove each locale receives a REAL server-side publish rejection.
  //
  // The previous E2E (R6-P2) configured an EMPTY formula draft and relied on the
  // client-side guard in TemplateEditor.publishVersion() to block publishing.
  // That guard returns BEFORE any server request is dispatched, so the old test
  // only proved a client-side block — never a server rejection. The RED probe
  // run (captured earlier) timed out waiting for the publish request, confirming
  // no request was ever sent.
  //
  // Corrected scenario — "stale view":
  //   1. The client holds a VALID local draft (local validation passes).
  //   2. The SERVER-side draft is corrupted (one formula expression blanked) via
  //      the official saveDraftFields mutation, WITHOUT reloading the editor, so
  //      the client keeps its valid local state and `dirty` stays false.
  //   3. Clicking publish therefore passes the client guard and dispatches a REAL
  //      POST to the publish endpoint; the server authoritatively rejects the
  //      corrupted draft and returns a structured issue.
  //   4. We assert a real POST response arrived, its body carries the structured
  //      [[FD_ISSUE:table_formula_empty|...]] marker (formal rejection), and the
  //      UI shows the locale-specific message with no raw marker / code /
  //      placeholder / raw formula leaking through.
  // ---------------------------------------------------------------------------
  const versionIdMatch = editorUrl.match(/[?&]version=([^&]+)/);
  expect(versionIdMatch, "editor URL must carry the versionId").toBeTruthy();
  const versionId = decodeURIComponent(versionIdMatch![1]);
  const PUBLISH_ENDPOINT = "/api/trpc/formdigital.templates.publish";

  const publishLabels: Record<"zh-Hant" | "zh-Hans" | "en", string> = {
    "zh-Hant": "發佈", "zh-Hans": "发布", en: "Publish",
  };
  // R8-P3: NO LONGER a loose "inner OR outer" regex. Each locale is locked to the FULL
  // server-publish rejection string (outer wrapper + inner issue), derived from the FIRST
  // server issue reported in the wire body so the assertion cannot drift or be satisfied
  // by an outer-only / inner-only partial toast.
  const outerPhrase: Record<"zh-Hant" | "zh-Hans" | "en", string> = {
    "zh-Hant": "Template 發佈失敗：",
    "zh-Hans": "Template 发布失败：",
    en: "Template publish failed: ",
  };
  const innerPhrase = (locale: "zh-Hant" | "zh-Hans" | "en", row: string, col: string): string => {
    if (locale === "zh-Hant") return `第 ${row} 列 ${col} 欄公式不可為空`;
    if (locale === "zh-Hans") return `第 ${row} 行 ${col} 列公式不可为空`;
    return `Row ${row} column ${col} formula cannot be empty`;
  };
  // Internal details that must NEVER reach the user-facing toast.
  const CJK = /[一-鿿]/;
  const assertNoToastLeak = (toast: string) => {
    expect(toast).not.toContain("FD_ISSUE");
    expect(toast).not.toContain("table_formula_empty"); // stable code
    expect(toast).not.toContain("[[");
    expect(toast).not.toContain("{row}"); // placeholder
    expect(toast).not.toContain("{column}");
    expect(toast).not.toContain("{reference}");
    expect(toast).not.toContain("B+C"); // raw formula
    expect(toast).not.toContain("{{"); // placeholder template
    expect(toast).not.toMatch(/[\\/]/); // path separator
    expect(toast).not.toMatch(/[a-f0-9]{16,}/i); // token / hash
    expect(toast).not.toMatch(/\bat\s+[^\s(]+\s*\(/); // stack-trace fragment
    expect(toast).not.toMatch(/^\s*Error:/); // raw error class
  };

  // Capture the VALID server draft once; reused to (a) corrupt per-locale and
  // (b) restore the server to a valid state after the loop so the downstream
  // successful-publish flow (cleanup + line ~380) is unaffected.
  const baseDetailsResp = await page.request.get(
    `/api/trpc/formdigital.templates.getVersionDetails?input=${encodeURIComponent(JSON.stringify({ json: { versionId } }))}`
  );
  expect(baseDetailsResp.status()).toBe(200);
  const baseDetails = extractTrpcData(await baseDetailsResp.json());
  const baseFields = baseDetails.fields as Array<Record<string, unknown>>;
  expect(Array.isArray(baseFields) && baseFields.length > 0).toBe(true);

  // The captured draft may itself contain an empty-formula cell (the P1-B setup
  // above leaves Row 2 Col A as an empty formula). Normalize every formula cell
  // to a non-empty, valid expression so this baseline is a genuinely VALID draft
  // the client will accept — the server-side corruption below is what makes the
  // publish fail, not the client baseline.
  // IMPORTANT: the formula must NOT reference its own column (the safe formula
  // engine rejects self-references as `formula_self_reference`). We use "B+C",
  // which references Columns B and C and is therefore valid for any cell (none of
  // the formula cells here live in Column B or C).
  const makeValid = (fields: Array<Record<string, unknown>>) =>
    fields.map((field) => {
      const def = field.definition as { tableFormulaCells?: Array<Record<string, unknown>> } | undefined;
      if (field.fieldType !== "table" || !def?.tableFormulaCells?.length) return field;
      const tableFormulaCells = def.tableFormulaCells.map((cell) => {
        const expr = typeof cell.expression === "string" ? cell.expression.trim() : "";
        return expr ? cell : { ...cell, expression: "B+C" };
      });
      return { ...field, definition: { ...(field.definition as Record<string, unknown>), tableFormulaCells } };
    });
  const validBase = makeValid(baseFields);

  const corruptFields = (fields: Array<Record<string, unknown>>) =>
    fields.map((field) => {
      const def = field.definition as { tableFormulaCells?: Array<Record<string, unknown>> } | undefined;
      if (field.fieldType !== "table" || !def?.tableFormulaCells?.length) return field;
      const definition = {
        ...(field.definition as Record<string, unknown>),
        tableFormulaCells: def.tableFormulaCells.map((cell) => ({ ...cell, expression: "" })),
      };
      return { ...field, definition };
    });

  const hasBlankFormula = (fields: Array<Record<string, unknown>>) =>
    fields.some((f) => {
      const d = f.definition as { tableFormulaCells?: Array<Record<string, unknown>> } | undefined;
      return f.fieldType === "table" && !!d?.tableFormulaCells?.some((c) => c.expression === "");
    });

  for (const locale of ["zh-Hant", "zh-Hans", "en"] as const) {
    // Restore the server draft to VALID, then switch locale (reload). The freshly
    // loaded client draft is valid and `dirty` is false, so the client guard will
    // NOT intercept the upcoming publish — a real server request will be sent.
    const restoreFirst = await page.request.post(
      "/api/trpc/formdigital.templates.saveDraftFields",
      { data: { json: { versionId, fields: validBase } } }
    );
    expect(restoreFirst.status()).toBe(200);
    await switchLocaleViaSettings(locale);

    // Corrupt the SERVER draft only (no reload): blank every formula expression.
    const corrupted = corruptFields(validBase);
    expect(hasBlankFormula(corrupted)).toBe(true);
    const saveCorrupt = await page.request.post(
      "/api/trpc/formdigital.templates.saveDraftFields",
      { data: { json: { versionId, fields: corrupted } } }
    );
    expect(saveCorrupt.status()).toBe(200);

    // Publish must now dispatch a REAL request and receive a formal structured
    // rejection from the server (the client guard is passed because the local
    // draft is still valid). Promise.all guarantees the request actually fires
    // and we observe its response.
    const [response] = await Promise.all([
      page.waitForResponse(
        (res) =>
          res.url().includes(PUBLISH_ENDPOINT) &&
          res.request().method() === "POST",
        { timeout: 15_000 }
      ),
      page.getByRole("button", { name: publishLabels[locale] }).click(),
    ]);
    const rawBody = await response.text();
    // Formal server rejection: a non-2xx status AND the structured issue marker in the
    // wire body (the client guard was bypassed, so this is a genuine server verdict).
    expect(response.status()).toBeGreaterThanOrEqual(400);
    expect(rawBody).toContain("FD_ISSUE");
    expect(rawBody).toContain("table_formula_empty");
    // R9-P2: The expected toast is built from the FIXED fixture truth (Row 2 / Col A),
    // NOT derived from the server response. We still read the first server issue's
    // row/column from the wire marker to ASSERT it matches the fixed truth — if the
    // server ever reports a different cell (e.g. Row 3 / D), the test MUST FAIL.
    const issueMatch = rawBody.match(
      /\[\[FD_ISSUE:table_formula_empty\|row=(\d+)\|column=([A-Za-z]+)/
    );
    expect(issueMatch, "wire body must carry the first issue row/column").toBeTruthy();
    const issueRow = issueMatch![1];
    const issueCol = issueMatch![2];
    const FIXED_ROW = "2";
    const FIXED_COL = "A";
    expect(issueRow, `first server issue row must equal fixed Row ${FIXED_ROW}`).toBe(FIXED_ROW);
    expect(issueCol, `first server issue column must equal fixed Column ${FIXED_COL}`).toBe(FIXED_COL);
    // Build the expected toast from the FIXED truth only.
    const expectedToast = outerPhrase[locale] + innerPhrase(locale, FIXED_ROW, FIXED_COL);

    // R9-P2 RED probes (pure string-equality, exactly what toHaveText exact does): the
    // EXACT matcher must reject any row/column drift or value/secret/path/stack/prefix/
    // suffix leak. These prove a loose substring/getByText locator could not pass.
    const redVariants: Record<string, string> = {
      "Row 3/D": outerPhrase[locale] + innerPhrase(locale, "3", "D"),
      "outer-only": outerPhrase[locale].replace(/\s+$/, ""),
      "inner-only": innerPhrase(locale, "2", "A"),
      "with-token": expectedToast + " token=ZZZ_SECRET_123",
      "with-win-path": expectedToast + " C:\\Users\\k\\x.pdf",
      "with-posix-path": expectedToast + " /home/k/x.pdf",
      "with-stack": expectedToast + " Error: at publish (server.js:12:3)",
      "with-prefix": "Warning: " + expectedToast,
      "with-suffix": expectedToast + " Please retry.",
    };
    for (const [name, variant] of Object.entries(redVariants)) {
      expect(variant, `exact matcher must REJECT ${name} variant`).not.toBe(expectedToast);
    }

    // R9-P2: assert the ACTUAL error toast shows the COMPLETE outer + inner message,
    // using the real Sonner error-toast root and an EXACT (full, case-sensitive,
    // whitespace-normalized) text assertion. Any prefix/suffix leak fails exact equality.
    const toastRoot = page.locator('[data-sonner-toast][data-type="error"]', { hasText: expectedToast });
    await expect(toastRoot).toHaveText(expectedToast, { exact: true });
    const toastText = (await toastRoot.textContent()) ?? "";
    // English toast must carry NO CJK; Simplified inner must truly be Simplified.
    if (locale === "en") {
      expect(toastText).not.toMatch(CJK);
    }
    if (locale === "zh-Hans") {
      expect(toastText).toContain("为"); // simplified form
      expect(toastText).not.toContain("為"); // not the traditional form
    }
    // No internal leakage reaching the user-facing toast.
    assertNoToastLeak(toastText);

    // Page-wide leakage guards (stricter than the toast alone).
    const body = page.locator("body");
    await expect(body).not.toContainText("FD_ISSUE");
    await expect(body).not.toContainText("[[");
    await expect(body).not.toContainText("{row}");
    await expect(body).not.toContainText("{column}");
    await expect(body).not.toContainText("{reference}");
    await expect(body).not.toContainText("table_formula_empty");
  }

  // Restore the server draft to a valid state (official mutation, no reload) so
  // the downstream cleanup + successful-publish flow is unaffected.
  const restoreFinal = await page.request.post(
    "/api/trpc/formdigital.templates.saveDraftFields",
    { data: { json: { versionId, fields: validBase } } }
  );
  expect(restoreFinal.status()).toBe(200);

  // Clean up: revert Row 2 Col A back to writable (back in zh-Hant for clarity)
  await switchLocaleViaSettings("zh-Hant");
  await reloadedCell10.click();
  await page.locator('button[data-testid="batch-writable-button"]').click();
  await expect(reloadedCell10).toHaveText("✓");
  await page.getByRole("button", { name: /儲存|Save/ }).click();
  await expect(
    page.getByText("DRAFT · 已保存至 localhost", { exact: true })
  ).toBeVisible();

  // Now publish successfully
  if (await confirmAllBtn.isVisible()) {
    await confirmAllBtn.click();
  }
  await page.getByRole("button", { name: "發佈" }).click();
  await expect(
    page.getByText("Template Version 已發佈及鎖定", { exact: true })
  ).toBeVisible();

  // 3. Create Instance
  await page.getByRole("button", { name: "建立 Instance" }).click();
  await expect(page.locator(".fill-header")).toBeVisible({ timeout: 30_000 });

  // In InstanceStudio:
  // Check fixed cells have no input
  const fixedCellDivs = page.locator(".fill-panel tbody td div.bg-\\[\\#f2efe9\\]");
  expect(await fixedCellDivs.count()).toBeGreaterThanOrEqual(8);

  // Check formula cells have fx badges
  const fxBadges = page.locator(".fill-panel tbody td span.bg-\\[\\#2b6cb0\\]");
  await expect(fxBadges).toHaveCount(2);

  // Fill Row 2: B = "100", C = "50"
  const row2Inputs = page.locator(".fill-panel tbody tr").nth(1).locator("input");
  await row2Inputs.nth(0).fill("Salary");
  await row2Inputs.nth(1).fill("100");
  await row2Inputs.nth(2).fill("50");

  // Live calculation: Row 2 Col D evaluates to "150.00"
  const row2FormulaCell = page.locator(".fill-panel tbody tr").nth(1).locator("td").nth(3);
  await expect(row2FormulaCell).toContainText("150.00");

  // Fill Row 3: B = "25.5", C = "14.25"
  const row3Inputs = page.locator(".fill-panel tbody tr").nth(2).locator("input");
  await row3Inputs.nth(0).fill("Bonus");
  await row3Inputs.nth(1).fill("25.5");
  await row3Inputs.nth(2).fill("14.25");

  // Live calculation: Row 3 Col D evaluates to "39.75"
  const row3FormulaCell = page.locator(".fill-panel tbody tr").nth(2).locator("td").nth(3);
  await expect(row3FormulaCell).toContainText("39.75");

  // FormCanvas preview reflects live evaluated formula results
  await expect(page.locator(".fill-canvas")).toContainText("150.00");
  await expect(page.locator(".fill-canvas")).toContainText("39.75");

  // 4. Save Instance
  const [createResponse] = await Promise.all([
    page.waitForResponse(
      response =>
        response.url().includes("/api/trpc/formdigital.instances.create") &&
        response.status() === 200
    ),
    page
      .locator(".fill-footer")
      .getByRole("button", { name: "建立 Instance" })
      .click(),
  ]);
  await expect(
    page.getByText("Instance 已建立並綁定目前 Version")
  ).toBeVisible();

  // -----------------------------------------------------------------
  // R4-P3: Server Sanitization of Fixed/Formula Residuals via Official API
  // -----------------------------------------------------------------
  const createData = extractTrpcData(await createResponse.json());
  const instanceId = createData?.instanceId;
  expect(instanceId).toBeTruthy();

  // Query instance via official API to get the table field stable ID
  const instQueryResponse = await page.request.get(
    `/api/trpc/formdigital.instances.get?input=${encodeURIComponent(JSON.stringify({ json: { instanceId } }))}`
  );
  expect(instQueryResponse.status()).toBe(200);
  const instData = extractTrpcData(await instQueryResponse.json());
  const instValues = instData.instance.values;
  const tableFieldId = Object.keys(instValues).find(k => {
    try {
      const parsed = JSON.parse(instValues[k]);
      return Array.isArray(parsed);
    } catch {
      return false;
    }
  });
  expect(tableFieldId).toBeTruthy();

  // Inject stale residuals into fixed and formula cells via official saveValues API
  const dirtyTable = [
    ["RESIDUAL_FIXED_HEADER", "", "", ""],
    ["Salary", "100", "50", "RESIDUAL_FORMULA_1"],
    ["Bonus", "25.5", "14.25", "RESIDUAL_FORMULA_2"],
    ["", "", "", "RESIDUAL_FIXED_FOOTER"],
  ];
  const saveDirtyResponse = await page.request.post("/api/trpc/formdigital.instances.saveValues", {
    data: {
      json: {
        instanceId,
        values: {
          ...instValues,
          [tableFieldId!]: JSON.stringify(dirtyTable),
        },
      },
    },
  });
  expect(saveDirtyResponse.status()).toBe(200);

  // Query back via official API: assert server strictly cleaned fixed and formula raw cells to ""
  const verifySanitizedResponse = await page.request.get(
    `/api/trpc/formdigital.instances.get?input=${encodeURIComponent(JSON.stringify({ json: { instanceId } }))}`
  );
  expect(verifySanitizedResponse.status()).toBe(200);
  const sanitizedData = extractTrpcData(await verifySanitizedResponse.json());
  const sanitizedTable = JSON.parse(sanitizedData.instance.values[tableFieldId!]);
  expect(sanitizedTable[0][0]).toBe(""); // fixed row cleaned
  expect(sanitizedTable[1][3]).toBe(""); // formula cell cleaned
  expect(sanitizedTable[2][3]).toBe(""); // formula cell cleaned
  expect(sanitizedTable[3][3]).toBe(""); // fixed row cleaned
  expect(sanitizedTable[1][0]).toBe("Salary"); // writable cell preserved
  expect(sanitizedTable[1][1]).toBe("100");
  expect(sanitizedTable[1][2]).toBe("50");
  expect(sanitizedTable[2][0]).toBe("Bonus");
  expect(sanitizedTable[2][1]).toBe("25.5");
  expect(sanitizedTable[2][2]).toBe("14.25");

  // Reload page to reflect verified clean state in UI
  await page.goto(`/?view=fill&instance=${encodeURIComponent(instanceId)}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".fill-canvas")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".fill-canvas")).toContainText("150.00");
  await expect(page.locator(".fill-canvas")).toContainText("39.75");

  // 5. Structured JSON Export Verification
  const exportSummary = page.getByText("輸出", { exact: true });
  const openExportMenu = async () => {
    const details = page.locator("details", { has: exportSummary });
    const isOpen = await details.evaluate(el => el.hasAttribute("open"));
    if (!isOpen) {
      await exportSummary.click();
    }
  };

  await openExportMenu();
  const [jsonDownload, structuredJsonResponse] = await Promise.all([
    page.waitForEvent("download"),
    page.waitForResponse(
      response =>
        response.url().includes("/api/trpc/formdigital.exports.structured") &&
        response.status() === 200
    ),
    page.getByRole("button", { name: /JSON \+ Metadata/i }).click(),
  ]);
  const structuredAssetUrl = findAssetUrl(await structuredJsonResponse.json());
  expect(structuredAssetUrl).toBeTruthy();
  const jsonContent = await (
    await page.request.get(new URL(structuredAssetUrl!, page.url()).href)
  ).json();
  const tableFieldExport = jsonContent.fields?.find((f: { type: string; value: string }) => f.type === "table");
  expect(tableFieldExport).toBeTruthy();
  const exportedTable = JSON.parse(tableFieldExport.value);
  // Row 2 col D has formula result 150.00
  expect(exportedTable[1][3]).toBe("150.00");
  // Row 3 col D has formula result 39.75
  expect(exportedTable[2][3]).toBe("39.75");
  // Row 1 (fixed) and Row 4 (fixed) are empty
  expect(exportedTable[0][0]).toBe("");
  expect(exportedTable[3][3]).toBe("");

  // 6. Structured CSV Export Verification (P1-E)
  await openExportMenu();
  const [csvDownload, structuredCsvResponse] = await Promise.all([
    page.waitForEvent("download"),
    page.waitForResponse(
      response =>
        response.url().includes("/api/trpc/formdigital.exports.structured") &&
        response.status() === 200
    ),
    page.getByRole("button", { name: /CSV \+ Metadata/i }).click(),
  ]);
  const csvAssetUrl = findAssetUrl(await structuredCsvResponse.json());
  expect(csvAssetUrl).toBeTruthy();
  const csvText = await (
    await page.request.get(new URL(csvAssetUrl!, page.url()).href)
  ).text();

  // Parse structured CSV records to verify exported cell data
  const parsedCsvRecords = parseCsv(csvText, { bom: true, columns: true }) as Array<Record<string, string>>;
  const tableCsvRow = parsedCsvRecords.find(r => r.fieldType === "table");
  expect(tableCsvRow).toBeDefined();
  const parsedTableData = JSON.parse(tableCsvRow!.fieldValue);
  // Row 2 (index 1): Salary, 100, 50, calculated 150.00
  expect(parsedTableData[1][0]).toBe("Salary");
  expect(parsedTableData[1][1]).toBe("100");
  expect(parsedTableData[1][2]).toBe("50");
  expect(parsedTableData[1][3]).toBe("150.00");
  // Row 3 (index 2): Bonus, 25.5, 14.25, calculated 39.75
  expect(parsedTableData[2][0]).toBe("Bonus");
  expect(parsedTableData[2][1]).toBe("25.5");
  expect(parsedTableData[2][2]).toBe("14.25");
  expect(parsedTableData[2][3]).toBe("39.75");
  // Row 1 (index 0, fixed) and Row 4 (index 3, fixed) are empty
  expect(parsedTableData[0][0]).toBe("");
  expect(parsedTableData[3][3]).toBe("");

  // 7. Real PDF Export Verification (Flattened & Editable with tableCellRect geometry bounds)
  // Shared geometry truth bounds helper using production tableCellRect
  const rowSlots = 4;
  const cols = 4;
  const tableFieldBox = { x: 50, y: 150, width: 400, height: 180 };
  const getExpectedCellBounds = (r: number, c: number) => {
    const rect = tableCellRect(undefined, rowSlots, cols, r, c);
    const width = rect.widthRatio * tableFieldBox.width;
    const height = rect.heightRatio * tableFieldBox.height;
    const x = tableFieldBox.x + rect.xRatio * tableFieldBox.width;
    const y = tableFieldBox.y + tableFieldBox.height - (rect.yRatio + rect.heightRatio) * tableFieldBox.height;
    return {
      xMin: x - 15,
      xMax: x + width + 15,
      yMin: y - 15,
      yMax: y + height + 15,
    };
  };

  const bounds150 = getExpectedCellBounds(1, 3); // Row 2, Col D
  const bounds39 = getExpectedCellBounds(2, 3);  // Row 3, Col D

  // Flattened PDF
  await openExportMenu();
  const [flatPopup, flatPdfResponse] = await Promise.all([
    page.waitForEvent("popup"),
    page.waitForResponse(
      response =>
        response.url().includes("/api/trpc/formdigital.exports.pdf") &&
        response.status() === 200
    ),
    page.getByRole("button", { name: /一般 PDF（連原表）|Flattened PDF/i }).click(),
  ]);
  await flatPopup.close();
  const flatAssetUrl = findAssetUrl(await flatPdfResponse.json());
  expect(flatAssetUrl).toBeTruthy();
  const flatBytes = await (
    await page.request.get(new URL(flatAssetUrl!, page.url()).href)
  ).body();
  const flatDoc = await PDFDocument.load(flatBytes);
  expect(flatDoc.getPageCount()).toBe(1);

  const flatExtracted = await extractPdfTextItems(new Uint8Array(flatBytes));
  expect(flatExtracted.fullText).toContain("150.00");
  expect(flatExtracted.fullText).toContain("39.75");

  const flatItem150 = flatExtracted.items.find(i => i.text.includes("150.00"));
  expect(flatItem150).toBeDefined();
  expect(flatItem150!.x).toBeGreaterThanOrEqual(bounds150.xMin);
  expect(flatItem150!.x).toBeLessThanOrEqual(bounds150.xMax);
  expect(flatItem150!.y).toBeGreaterThanOrEqual(bounds150.yMin);
  expect(flatItem150!.y).toBeLessThanOrEqual(bounds150.yMax);

  const flatItem39 = flatExtracted.items.find(i => i.text.includes("39.75"));
  expect(flatItem39).toBeDefined();
  expect(flatItem39!.x).toBeGreaterThanOrEqual(bounds39.xMin);
  expect(flatItem39!.x).toBeLessThanOrEqual(bounds39.xMax);
  expect(flatItem39!.y).toBeGreaterThanOrEqual(bounds39.yMin);
  expect(flatItem39!.y).toBeLessThanOrEqual(bounds39.yMax);

  // Editable PDF
  // IMPORTANT (P1-E & R4-P3): Editable table fields intentionally have NO AcroForm widgets;
  // all table values and formulas are rendered directly into the page content stream.
  await openExportMenu();
  const [editPopup, editPdfResponse] = await Promise.all([
    page.waitForEvent("popup"),
    page.waitForResponse(
      response =>
        response.url().includes("/api/trpc/formdigital.exports.pdf") &&
        response.status() === 200
    ),
    page.getByRole("button", { name: /可繼續填寫的 PDF|Editable PDF/ }).click(),
  ]);
  await editPopup.close();
  const editAssetUrl = findAssetUrl(await editPdfResponse.json());
  expect(editAssetUrl).toBeTruthy();
  const editBytes = await (
    await page.request.get(new URL(editAssetUrl!, page.url()).href)
  ).body();
  const editDoc = await PDFDocument.load(editBytes);
  expect(editDoc.getPageCount()).toBe(1);
  const editForm = editDoc.getForm();

  // Table fields have NO AcroForm text fields
  const fieldNames = editForm.getFields().map(f => f.getName());
  const tableAcroFields = fieldNames.filter(name => name.includes("statement_table"));
  expect(tableAcroFields).toHaveLength(0);

  // Extract drawn text from Editable PDF printable content stream and verify against tableCellRect bounds
  const editExtracted = await extractPdfTextItems(new Uint8Array(editBytes));
  expect(editExtracted.fullText).toContain("150.00");
  expect(editExtracted.fullText).toContain("39.75");

  const editItem150 = editExtracted.items.find(i => i.text.includes("150.00"));
  expect(editItem150).toBeDefined();
  expect(editItem150!.x).toBeGreaterThanOrEqual(bounds150.xMin);
  expect(editItem150!.x).toBeLessThanOrEqual(bounds150.xMax);
  expect(editItem150!.y).toBeGreaterThanOrEqual(bounds150.yMin);
  expect(editItem150!.y).toBeLessThanOrEqual(bounds150.yMax);

  const editItem39 = editExtracted.items.find(i => i.text.includes("39.75"));
  expect(editItem39).toBeDefined();
  expect(editItem39!.x).toBeGreaterThanOrEqual(bounds39.xMin);
  expect(editItem39!.x).toBeLessThanOrEqual(bounds39.xMax);
  expect(editItem39!.y).toBeGreaterThanOrEqual(bounds39.yMin);
  expect(editItem39!.y).toBeLessThanOrEqual(bounds39.yMax);
});
