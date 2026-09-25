import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { PDFDocument, PDFRadioGroup, PDFTextField } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  authenticateTestUser,
  completeOnboarding,
  findLocalAssetUrl,
} from "./test-runtime";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

const GAPPED_TABLE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAXwAAAEECAYAAAArlo9mAAAFGUlEQVR42u3cQWpgMQxEQd3/0vYthKSuAu/Df6KHZDH1AIhQPgGAwQfA4ANg8AEw+AAYfAAMPgAGHwCDD4DBBzD4ABh8AAw+AAYfAIMPgMEHwOADYPABMPgAGHwAgw+AwQfA4ANg8AEw+AAYfAAMPgAGHwCDD2DwATD4ABh8AAw+AAYfAIMPgMEHwOADYPABMPgABh8Agw+AwQfA4ANg8AEw+AAYfAAMPgAGH8DgA2DwO3+YKs/zvJPP4Bt8z/MMfvbgM/BXQW20YX0fg4822mDwHS7aaIPBd7iOFm0w+A7X0aINBt/hOlq00cfgO1xHizb6GHy0QRt9DD7aoI0+Bh9ttEEfg4822mDwfRi00QaD73AdrTbaYPAdrqNFGwy+w3W0aKOPwXe4jhZt9DH4DtfRoo0+Bh9t0EYfg4822qCPwUcbbdDH4KONNhh8h4s22mDwHa6jRRsMvsN1tGiDwXe4jhZt9DH4DtfRoo0+Bh9t0EYfg482aKOPwUcbbdDH4KONNhh8HwZttMHgO1y00QaD73AdLdpg8B2uo0UbDL7DdbRoo4/Bd7iOFm30Mfhogzb6GHy00caH0Mfgo4026GPw0UYbDL4PgzbaYPAdrqNFGwy+w3W0aIPBd7iOFm30MfgO19GijT4GH23QRh+DjzZoo4/BRxtt0GfP4Hue5117Bt/ge55n8P1JB7+Woo0+Bh9t0EYfg4822qCPwUcbbTD4PgzaaIPBd7hoow0G3+E6WrTB4DtcR4s2GHyH62jRRh+D73AdLdroY/DRBm30Mfhoo402+hh8tNEGfQw+2miDwfdh0EYbDL7DdbTaaIPBd7iOFm0w+ABM+cfHJwAw+AAYfAAMPgAGHwCDD4DBB8DgA2DwATD4AAYfAIPf88P4T6DmHoo22rC+j8FHG20w+A4XbbTB4DtcR4s2GHyH62jRBoPvcB0t2uhj8B2uo0UbfQw+2qCNPgYfbdBGH4OPNtqgj8FHG20w+D4M2miDwXe4jlYbbTD4DtfRog0G3+E6WrTRx+A7XEeLNvoYfIfraNFGH4OPNmijj8FHG23QZ+Hge57nXXsG3+B7nmfw/UkHv5aijT4GH23QRh+DjzbaoI/BRxttMPg+DNpog8F3uGijDQbf4TpatMHgO1xHizYYfIfraNFGH4PvcB0t2uhj8NEGbfQx+GijjTb6GHy00QZ9DD7aaIPB92HQRhsMvsN1tNpog8F3uI4WbTD4DtfRoo0+Bt/hOlq00cfg42jRRh+DjzZoo4/BRxtt0Mfgo4026GPw0UYbDL7DRRttMPgO19GiDQbf4TpatMHgO1xHizb6GHyH62jRRh+DjzZoo4/BRxu00cfgo4026GPw0UYbDL4PgzbaYPAdrqPVRhsMvsN1tGiDwXe4jhZt9DH4DtfRoo0+Bt/hOlq00cfgow3a6GPw0UYb9DH4aKMN+hh8tNEGg+9w0UYbDL7DdbRog8F3uI4WbTD4DtfRoo0+Bt/hOlq00Sd18D3P8649g2/wPc8z9pmDD4DBB8DgA2DwATD4AAYfAIMPgMEHwOADYPABMPgAGHwADD4ABh/A4ANg8AEw+AAYfAAMPgAGHwCDD4DBB8DgA2DwAQw+AAYfAIMPgMEHwOADYPABMPgAGHwADD4ABh/A4ANg8AEw+AAYfAAMPgAGHwCDD4DBB8DgAxh8AAw+AAYfAIMPgMEHwOADYPABMPgAGHwADD6AwQfA4ANg8AEw+AAYfAAafE7NnIaovQ20AAAAAElFTkSuQmCC";

test("uses the free browser OCR fallback when system Tesseract is unavailable", async ({
  context,
  page,
}, testInfo) => {
  // The first browser-OCR model load is intentionally offline and can be
  // slower on modest machines.  Stage 3 adds an explicit review boundary
  // after recognition, so keep enough budget for both operations.
  test.setTimeout(300_000);
  await authenticateTestUser(
    context,
    `${testInfo.project.name}-free-ocr-fallback`
  );
  const pageErrors: Error[] = [];
  const blockedExternalRequests: string[] = [];
  const browserOcrRequests: string[] = [];
  const systemOcrRequests: string[] = [];
  await context.route(/^https?:\/\//, async route => {
    const requestUrl = route.request().url();
    const url = new URL(requestUrl);
    if (url.pathname.includes("/ocr-runtime/"))
      browserOcrRequests.push(requestUrl);
    if (requestUrl.includes("formdigital.ocr.recognize"))
      systemOcrRequests.push(requestUrl);
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost")
      await route.continue();
    else {
      blockedExternalRequests.push(url.hostname);
      await route.abort();
    }
  });
  page.on("pageerror", error => pageErrors.push(error));

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await completeOnboarding(page);
  await page.getByRole("button", { name: "建立 Template" }).first().click();

  const sourceInput = page.locator('input[type="file"][accept*=".pdf"]');
  await sourceInput.setInputFiles(path.join(projectRoot, "ocr-fixture.png"));
  await page.locator("#template-name").fill("E2E Free OCR Template");
  // This fixture and its assertion are English-only ("ADA"). Loading all
  // three language models would test model download/startup cost rather than
  // the browser-fallback path, and can exceed the bounded import timeout on
  // modest offline machines.
  await page
    .locator("select")
    .filter({ hasText: "English" })
    .selectOption("eng");
  await page.getByRole("button", { name: "建立 Draft" }).click();
  const importOutcome = await Promise.race([
    page
      .getByTestId("import-review-panel")
      .waitFor({ state: "visible", timeout: 240_000 })
      .then(() => "review" as const),
    page
      .locator('[data-sonner-toast][data-type="error"]')
      .first()
      .waitFor({ state: "visible", timeout: 240_000 })
      .then(() => "error" as const),
  ]);
  expect(
    importOutcome,
    importOutcome === "error"
      ? await page.locator('[data-sonner-toast][data-type="error"]').first().innerText()
      : undefined
  ).toBe("review");
  await page.getByTestId("confirm-import-btn").click();

  await expect(
    page.getByRole("heading", { name: "E2E Free OCR Template · v1" })
  ).toBeVisible({ timeout: 150_000 });
  await expect(page.getByText("ADA", { exact: true }).first()).toBeVisible();
  await expect(
    page.getByText("需要確認", { exact: true }).first()
  ).toBeVisible();
  expect(browserOcrRequests.length).toBeGreaterThan(0);
  expect(systemOcrRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(blockedExternalRequests).toEqual([]);
});

test("detects a synthetic form box locally and labels it with free OCR", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const fixturePage = await context.newPage();
  await fixturePage.setContent(`
    <main id="fixture" style="width:760px;height:420px;padding:60px;background:#fff;color:#111;font:28px Arial,sans-serif">
      <h1 style="font-size:34px;margin:0 0 52px">REGISTRATION FORM</h1>
      <section style="margin-bottom:36px">
        <div>Name:</div><div style="width:360px;height:52px;border:3px solid #111;margin-top:8px"></div>
      </section>
      <section style="display:flex;align-items:center;gap:24px">
        <span>Agree:</span><div style="width:28px;height:28px;border:3px solid #111"></div>
      </section>
    </main>
  `);
  const fixture = await fixturePage.locator("#fixture").screenshot();
  await fixturePage.close();

  await authenticateTestUser(
    context,
    `${testInfo.project.name}-free-structure-detection`
  );
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await completeOnboarding(page);
  await page.getByRole("button", { name: "建立 Template" }).first().click();
  await page.locator('input[type="file"][accept*=".pdf"]').setInputFiles({
    name: "synthetic-structure.png",
    mimeType: "image/png",
    buffer: fixture,
  });
  await page.locator("#template-name").fill("E2E Structure Template");
  await page
    .locator("select")
    .filter({ hasText: "English" })
    .selectOption("eng");
  await page.getByRole("button", { name: "建立 Draft" }).click();
  await expect(page.getByTestId("import-review-panel")).toBeVisible({ timeout: 150_000 });
  await page.getByTestId("confirm-import-btn").click();

  await expect(
    page.getByRole("heading", { name: "E2E Structure Template · v1" })
  ).toBeVisible({ timeout: 150_000 });
  await expect(page.getByText("Name", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Agree", { exact: true }).first()).toBeVisible();
  await expect(
    page.getByText("需要確認", { exact: true }).first()
  ).toBeVisible();
});

test("keeps a gapped table as one unconfirmed local table suggestion", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await authenticateTestUser(
    context,
    `${testInfo.project.name}-gapped-table-detection`
  );
  const pageErrors: Error[] = [];
  const blockedExternalRequests: string[] = [];
  await context.route(/^https?:\/\//, async route => {
    const url = new URL(route.request().url());
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost")
      await route.continue();
    else {
      blockedExternalRequests.push(url.hostname);
      await route.abort();
    }
  });
  page.on("pageerror", error => pageErrors.push(error));

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await completeOnboarding(page);
  await page.getByRole("button", { name: "建立 Template" }).first().click();
  await page.locator('input[type="file"][accept*=".pdf"]').setInputFiles({
    name: "synthetic-gapped-table.png",
    mimeType: "image/png",
    buffer: Buffer.from(GAPPED_TABLE_PNG_BASE64, "base64"),
  });
  await page.locator("#template-name").fill("E2E Gapped Table Template");
  await page
    .locator("select")
    .filter({ hasText: "English" })
    .selectOption("eng");
  await page.getByRole("button", { name: "建立 Draft" }).click();
  await expect(page.getByTestId("import-review-panel")).toBeVisible({ timeout: 150_000 });
  await page.getByTestId("confirm-import-btn").click();

  await expect(
    page.getByRole("heading", { name: "E2E Gapped Table Template · v1" })
  ).toBeVisible({ timeout: 150_000 });
  const fieldRows = page.locator("button.field-row");
  await expect(fieldRows).toHaveCount(1);
  await expect(
    page.locator('button.field-row[data-field-type="table"]')
  ).toHaveCount(1);
  await expect(
    page.locator(
      'button.field-row[data-field-type="table"] .field-dot.needs-review'
    )
  ).toHaveCount(1);
  expect(pageErrors).toEqual([]);
  expect(blockedExternalRequests).toEqual([]);
});

test("edits and exports logical radio, character-box, and table fields", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const fixturePage = await context.newPage();
  const fixtureBase64 = await fixturePage.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 900;
    canvas.height = 760;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Synthetic fixture canvas unavailable");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#000";
    const horizontal = (x0: number, x1: number, y: number, thickness = 3) =>
      context.fillRect(x0, y, x1 - x0 + 1, thickness);
    const vertical = (x: number, y0: number, y1: number, thickness = 3) =>
      context.fillRect(x, y0, thickness, y1 - y0 + 1);
    const box = (x: number, y: number, width: number, height: number) => {
      horizontal(x, x + width, y);
      horizontal(x, x + width, y + height);
      vertical(x, y, y + height);
      vertical(x + width, y, y + height);
    };
    for (let index = 0; index < 6; index += 1)
      box(60 + index * 40, 100, 36, 40);
    box(60, 300, 240, 48);
    for (const y of [480, 530, 580, 630]) horizontal(60, 600, y);
    for (const x of [60, 240, 420, 600]) vertical(x, 480, 630);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  const fixture = Buffer.from(fixtureBase64, "base64");
  await fixturePage.close();

  await authenticateTestUser(
    context,
    `${testInfo.project.name}-advanced-structure-detection`
  );
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await completeOnboarding(page);
  await page.getByRole("button", { name: "建立 Template" }).first().click();
  await page.locator('input[type="file"][accept*=".pdf"]').setInputFiles({
    name: "synthetic-advanced-structure.png",
    mimeType: "image/png",
    buffer: fixture,
  });
  await page.locator("#template-name").fill("E2E Advanced Structure Template");
  await page
    .locator("select")
    .filter({ hasText: "English" })
    .selectOption("eng");
  await page.getByRole("button", { name: "建立 Draft" }).click();
  await expect(page.getByTestId("import-review-panel")).toBeVisible({ timeout: 150_000 });
  await page.getByTestId("confirm-import-btn").click();

  await expect(
    page.getByRole("heading", { name: "E2E Advanced Structure Template · v1" })
  ).toBeVisible({ timeout: 150_000 });
  await expect(
    page.locator("aside").filter({ hasText: "原始來源" })
  ).toContainText(/欄位\s*3/);
  const settings = page.locator("aside").last();
  const fieldRows = page.locator("button.field-row");
  await expect(fieldRows).toHaveCount(3);

  // Exact OCR structure classification is covered with deterministic pixel
  // fixtures in form-structure.test.ts. This fixed-pixel cross-browser flow
  // verifies that all advanced field types can be edited, persisted, filled,
  // and exported without depending on browser font rasterisation.
  await fieldRows.nth(0).click();
  await settings.locator("select").first().selectOption("characterBox");
  await expect(settings.locator("select").first()).toHaveValue("characterBox");
  await expect(settings.getByText("格數", { exact: true })).toBeVisible();
  await settings.getByRole("textbox", { name: "欄位名稱" }).fill("Code");

  await fieldRows.nth(1).click();
  await settings.locator("select").first().selectOption("radio");
  await expect(settings.locator("select").first()).toHaveValue("radio");
  await settings.locator("textarea").fill("Male\nFemale");
  await settings.getByRole("textbox", { name: "欄位名稱" }).fill("Gender");

  await fieldRows.nth(2).click();
  await settings.locator("select").first().selectOption("table");
  await expect(settings.locator("select").first()).toHaveValue("table");
  await expect(settings.getByText("最大列數", { exact: true })).toBeVisible();
  await settings.getByRole("textbox", { name: "欄位名稱" }).fill("Scores");

  for (const fieldName of ["Code", "Gender", "Scores"]) {
    await page.getByRole("button", { name: fieldName, exact: true }).click();
    await page.getByRole("button", { name: "確認此欄位" }).click();
  }
  await page.getByRole("button", { name: /儲存|Save/ }).click();
  await expect(
    page.getByText("DRAFT · 已保存至 localhost", { exact: true })
  ).toBeVisible();
  await page.getByRole("button", { name: "發佈" }).click();
  await expect(
    page.getByText("Template Version 已發佈及鎖定", { exact: true })
  ).toBeVisible();
  await page.getByRole("button", { name: "建立 Instance" }).click();

  await page.getByRole("textbox", { name: "Code 逐格字元" }).fill("AB-1234");
  const radioField = page
    .locator(".field-form-row")
    .filter({ hasText: "Gender" });
  await radioField.getByRole("radio", { name: "Female" }).check();
  const tableField = page
    .locator(".field-form-row")
    .filter({ hasText: "Scores" });
  // A table detected from a printed form has a fixed grid whose writable cells
  // are already laid out; a plain table field still grows row by row.
  const addTableRow = tableField.getByRole("button", { name: /新增列/ });
  if (await addTableRow.count()) await addTableRow.click();
  await tableField.locator("tbody input").nth(0).fill("10");
  await tableField.locator("tbody input").nth(1).fill("20");
  await tableField.locator("tbody input").nth(2).fill("30");
  await page.getByRole("button", { name: "建立 Instance" }).click();
  await expect(
    page.getByText("Instance 已建立並綁定目前 Version")
  ).toBeVisible();

  await page.getByText("輸出", { exact: true }).click();
  const [popup, exportResponse] = await Promise.all([
    page.waitForEvent("popup"),
    page.waitForResponse(
      response =>
        response.url().includes("/api/trpc/formdigital.exports.pdf") &&
        response.status() === 200
    ),
    page.getByRole("button", { name: /可繼續填寫的 PDF|Editable PDF/ }).click(),
  ]);
  expect(popup).toBeDefined();
  const assetUrl = findLocalAssetUrl(await exportResponse.json());
  expect(assetUrl).toContain("/api/local/assets/");
  const pdfResponse = await page.request.get(
    new URL(assetUrl!, page.url()).href
  );
  expect(pdfResponse.ok()).toBe(true);
  const pdfBytes = await pdfResponse.body();
  const rendered = await PDFDocument.load(pdfBytes);
  const pdfFields = rendered.getForm().getFields();
  const radio = pdfFields.find(field => field instanceof PDFRadioGroup) as
    | PDFRadioGroup
    | undefined;
  const textValues = pdfFields
    .filter(field => field instanceof PDFTextField)
    .map(field => (field as PDFTextField).getText());
  expect(radio?.getOptions()).toEqual(["Male", "Female"]);
  expect(radio?.getSelected()).toBe("Female");
  expect(textValues).toContain("AB1234");
  // Complex table values remain a faithful, printable overlay in editable
  // PDFs; raw JSON must not be exposed as an AcroForm text field.
  expect(textValues.some(value => value?.startsWith("[["))).toBe(false);
  const loadingTask = getDocument({
    data: new Uint8Array(pdfBytes),
    standardFontDataUrl: `${path
      .join(projectRoot, "node_modules", "pdfjs-dist", "standard_fonts")
      .replaceAll("\\", "/")}/`,
  });
  const pdfJsDocument = await loadingTask.promise;
  try {
    const content = await (await pdfJsDocument.getPage(1)).getTextContent();
    const shownText = content.items
      .map(item => ("str" in item ? item.str : ""))
      .join(" ");
    expect(shownText).toContain("10");
    expect(shownText).toContain("20");
    expect(shownText).toContain("30");
  } finally {
    await pdfJsDocument.destroy();
  }
});
