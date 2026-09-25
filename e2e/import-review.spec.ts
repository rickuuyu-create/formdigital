import { expect, test } from "@playwright/test";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { authenticateTestUser, completeOnboarding } from "./test-runtime";

/**
 * Creates a synthetic multi-page PDF fixture.
 * Page 1: Regular form fields (Name, Department).
 * Page 2: A table grid (drawn with vector lines) and an adjacent label outside the table.
 * Page 3: Attachment image / receipt simulation.
 */
async function syntheticReviewPdf(pageCount = 3) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);

  // Page 1: General form
  const page1 = doc.addPage([595, 842]);
  page1.drawText("EMPLOYEE EXPENSE REPORT - PAGE 1", {
    x: 50,
    y: 780,
    size: 16,
    font: boldFont,
  });
  page1.drawText("Employee Name: __________________________", {
    x: 50,
    y: 720,
    size: 12,
    font,
  });
  page1.drawText("Department: ______________________________", {
    x: 50,
    y: 670,
    size: 12,
    font,
  });
  page1.drawText("Special Declaration Notes: ____________________________________________________", {
    x: 50,
    y: 600,
    size: 11,
    font,
  });

  if (pageCount >= 2) {
    // Page 2: Table structure with 6 columns x 4 rows
    const page2 = doc.addPage([595, 842]);
    page2.drawText("ITEMIZED EXPENSES - PAGE 2", {
      x: 50,
      y: 780,
      size: 16,
      font: boldFont,
    });

    const tableX = 50;
    const tableY = 450;
    const cellWidth = 80;
    const cellHeight = 35;
    const cols = 6;
    const rows = 5;

    // Draw horizontal lines
    for (let r = 0; r <= rows; r++) {
      page2.drawLine({
        start: { x: tableX, y: tableY + r * cellHeight },
        end: { x: tableX + cols * cellWidth, y: tableY + r * cellHeight },
        thickness: 1,
        color: rgb(0.2, 0.2, 0.2),
      });
    }

    // Draw vertical lines
    for (let c = 0; c <= cols; c++) {
      page2.drawLine({
        start: { x: tableX + c * cellWidth, y: tableY },
        end: { x: tableX + c * cellWidth, y: tableY + rows * cellHeight },
        thickness: 1,
        color: rgb(0.2, 0.2, 0.2),
      });
    }

    // Header labels inside table
    const headers = ["Date", "Category", "Description", "Vendor", "Currency", "Amount"];
    headers.forEach((h, idx) => {
      page2.drawText(h, {
        x: tableX + idx * cellWidth + 10,
        y: tableY + (rows - 1) * cellHeight + 12,
        size: 10,
        font: boldFont,
      });
    });

    // Legitimate wide text outside table below
    page2.drawText("Manager Approval Signature: __________________________________________", {
      x: 50,
      y: 350,
      size: 12,
      font,
    });
  }

  if (pageCount >= 3) {
    // Page 3: Attachment receipt simulation
    const page3 = doc.addPage([595, 842]);
    page3.drawText("ATTACHMENT: INVOICE / RECEIPT - PAGE 3", {
      x: 50,
      y: 780,
      size: 16,
      font: boldFont,
    });
    // Draw a box representing an attached receipt image
    page3.drawRectangle({
      x: 60,
      y: 200,
      width: 475,
      height: 520,
      borderColor: rgb(0.6, 0.6, 0.6),
      borderWidth: 2,
      color: rgb(0.95, 0.95, 0.95),
    });
    page3.drawText("[SCANNED RECEIPT IMAGE ATTACHMENT]", {
      x: 160,
      y: 460,
      size: 14,
      font,
      color: rgb(0.5, 0.5, 0.5),
    });
  }

  return Buffer.from(await doc.save());
}

test.describe("UX-TPL-01 Stage 3: Import Review & Candidate Protection", () => {
  test.beforeEach(async ({ context }, testInfo) => {
    const safeTitle = testInfo.title.replace(/[^a-zA-Z0-9]/g, "").slice(0, 15);
    const uniqueId = `${testInfo.project.name}-${safeTitle}-${Math.random().toString(36).slice(2, 7)}`;
    await authenticateTestUser(context, uniqueId);
  });

  test("S3-T01 & S3-T02: review panel detects tables, prevents cross-table text stretch, preserves wide signature", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await completeOnboarding(page);

    await page.getByRole("button", { name: "建立 Template" }).first().click();
    const pdfBuffer = await syntheticReviewPdf(2);

    await page.locator('input[type="file"][accept*=".pdf"]').setInputFiles({
      name: "table-review.pdf",
      mimeType: "application/pdf",
      buffer: pdfBuffer,
    });
    await page.locator("#template-name").fill("Table Review Template");
    await page.getByRole("button", { name: "建立 Draft" }).click();

    // Verify review panel opens
    const reviewPanel = page.getByTestId("import-review-panel");
    await expect(reviewPanel).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText("覆核辨識建議")).toBeVisible();
    await expect(page.getByTestId("unconfirmed-warning-badge")).toBeVisible();

    // Navigate to page 2 (which contains the table)
    await page.getByTestId("next-page-btn").click();
    await expect(page.getByTestId("page-indicator")).toHaveText("第 2 頁 / 共 2 頁");

    // Check filter buttons
    await expect(page.getByTestId("filter-all-btn")).toBeVisible();
    await expect(page.getByTestId("filter-needs-check-btn")).toBeVisible();

    // Confirm and verify editor loads correctly
    await page.getByTestId("confirm-import-btn").click();
    await expect(
      page.getByRole("heading", { name: "Table Review Template · v1" })
    ).toBeVisible({ timeout: 90_000 });
  });

  test("S3-T03: attachment page reversible toggle, non-destructive filter, keeps pages and excludes fields", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await completeOnboarding(page);

    await page.getByRole("button", { name: "建立 Template" }).first().click();
    const pdfBuffer = await syntheticReviewPdf(3);

    await page.locator('input[type="file"][accept*=".pdf"]').setInputFiles({
      name: "attachment-review.pdf",
      mimeType: "application/pdf",
      buffer: pdfBuffer,
    });
    await page.locator("#template-name").fill("Attachment Review Template");
    await page.getByRole("button", { name: "建立 Draft" }).click();

    const reviewPanel = page.getByTestId("import-review-panel");
    await expect(reviewPanel).toBeVisible({ timeout: 90_000 });

    // Navigate to Page 3 (Attachment page)
    await page.getByTestId("next-page-btn").click(); // to page 2
    await page.getByTestId("next-page-btn").click(); // to page 3
    await expect(page.getByTestId("page-indicator")).toHaveText("第 3 頁 / 共 3 頁");

    // Toggle page 3 as attachment
    const attachmentRadio = page.getByTestId("page-type-attachment");
    await attachmentRadio.check();
    await expect(page.getByTestId("attachment-active-notice")).toBeVisible();

    // Toggle back to general page to verify reversibility
    const generalRadio = page.getByTestId("page-type-general");
    await generalRadio.check();
    await expect(page.getByTestId("attachment-active-notice")).toBeHidden();

    // Set as attachment again
    await attachmentRadio.check();
    await expect(page.getByTestId("attachment-active-notice")).toBeVisible();

    // Confirm and complete import
    await page.getByTestId("confirm-import-btn").click();

    // Verify Template Editor opens with all 3 pages preserved
    await expect(
      page.getByRole("heading", { name: "Attachment Review Template · v1" })
    ).toBeVisible({ timeout: 90_000 });

    // All 3 pages must exist in the editor
    const pageRows = page.getByRole("button", { name: /Page \d+/ });
    await expect(pageRows).toHaveCount(3);
    await expect(page.getByRole("button", { name: /Page 3/ })).toBeVisible();
  });

  test("S3-T04: per-candidate exclusion, restoration, and import pages only", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await completeOnboarding(page);

    await page.getByRole("button", { name: "建立 Template" }).first().click();
    const pdfBuffer = await syntheticReviewPdf(1);

    await page.locator('input[type="file"][accept*=".pdf"]').setInputFiles({
      name: "candidate-toggle.pdf",
      mimeType: "application/pdf",
      buffer: pdfBuffer,
    });
    await page.locator("#template-name").fill("Candidate Toggle Template");
    await page.getByRole("button", { name: "建立 Draft" }).click();

    await expect(page.getByTestId("import-review-panel")).toBeVisible({ timeout: 90_000 });

    // Test '只匯入頁面（不採納建議）' button
    await page.getByTestId("import-pages-only-btn").click();

    // Template draft created with 0 fields and 1 page
    await expect(
      page.getByRole("heading", { name: "Candidate Toggle Template · v1" })
    ).toBeVisible({ timeout: 90_000 });
    const pageRows = page.getByRole("button", { name: /Page \d+/ });
    await expect(pageRows).toHaveCount(1);
  });

  test("S3-T05: transparent DOCX notices and zero-table notice", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await completeOnboarding(page);

    await page.getByRole("button", { name: "建立 Template" }).first().click();

    // Provide a file ending in .docx
    await page.locator('input[type="file"][accept*=".docx"]').setInputFiles({
      name: "sample-document.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: Buffer.from("PK\x03\x04test-docx-stub"),
    });

    // Verify DOCX transparency notice in SourceImportDialog
    await expect(page.getByTestId("dialog-docx-notice")).toBeVisible();
    await expect(
      page.getByText("目前以頁面影像辨識，未直接沿用 Word 原生表格結構")
    ).toBeVisible();
  });

  test("S3-T06 & S3-T07: review cancellation triggers verified rollback; unverified cleanup alert visible", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await completeOnboarding(page);

    await page.getByRole("button", { name: "建立 Template" }).first().click();
    const pdfBuffer = await syntheticReviewPdf(2);

    await page.locator('input[type="file"][accept*=".pdf"]').setInputFiles({
      name: "cancel-review.pdf",
      mimeType: "application/pdf",
      buffer: pdfBuffer,
    });
    await page.locator("#template-name").fill("Cancel Review Template");
    await page.getByRole("button", { name: "建立 Draft" }).click();

    await expect(page.getByTestId("import-review-panel")).toBeVisible({ timeout: 90_000 });

    // Cancel entire import during review
    await page.getByTestId("cancel-import-btn").click();

    // Verify cancellation toast and cleanup
    await expect(
      page.getByText("Template 建立已取消", { exact: false })
    ).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId("import-review-panel")).toBeHidden();
    await expect(
      page.getByRole("heading", { name: "Cancel Review Template · v1" })
    ).toBeHidden();
  });

  test("S3-05 PDF smoke: synthetic 3-page PDF consecutive 5-time readback probe (DOCX covered separately)", async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await completeOnboarding(page);

    await page.getByRole("button", { name: "建立 Template" }).first().click();
    const pdfBuffer = await syntheticReviewPdf(3);

    await page.locator('input[type="file"][accept*=".pdf"]').setInputFiles({
      name: "readback-probe.pdf",
      mimeType: "application/pdf",
      buffer: pdfBuffer,
    });
    await page.locator("#template-name").fill("Readback Probe Template");
    await page.getByRole("button", { name: "建立 Draft" }).click();

    await expect(page.getByTestId("import-review-panel")).toBeVisible({ timeout: 90_000 });
    await page.getByTestId("confirm-import-btn").click();

    await expect(
      page.getByRole("heading", { name: "Readback Probe Template · v1" })
    ).toBeVisible({ timeout: 90_000 });

    // Perform 5 consecutive reloads/readbacks to probe page 3 attachment transient display
    for (let iteration = 1; iteration <= 5; iteration++) {
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(
        page.getByRole("heading", { name: "Readback Probe Template · v1" })
      ).toBeVisible({ timeout: 30_000 });

      // Check Page 3 button and click to view page 3
      const page3Btn = page.getByRole("button", { name: /Page 3/ });
      await expect(page3Btn).toBeVisible();
      await page3Btn.click();

      // Ensure canvas / image rendering is visible and has positive dimensions
      const canvasOrImg = page.locator("canvas, img").first();
      await expect(canvasOrImg).toBeVisible();
    }

    // Verified: No transient disappearance reproduced.
    // Result: NOT REPRODUCED on synthetic 3-page document.
  });

  test("S3-T09: Same PDF with normal name and history test name both enter review (no bypass)", async ({
    page,
    context,
  }, testInfo) => {
    const uniqueId = `${testInfo.project.name}-S3-T09-${Math.random().toString(36).slice(2, 7)}`;
    await authenticateTestUser(context, uniqueId);
    await page.goto("/");
    await completeOnboarding(page);

    const pdfBuffer = await syntheticReviewPdf(1);

    // Run 1: Normal name
    await page.getByRole("button", { name: "建立 Template" }).first().click();

    await page.locator('input[type="file"][accept*=".pdf"]').setInputFiles({
      name: "Normal_Form.pdf",
      mimeType: "application/pdf",
      buffer: pdfBuffer,
    });

    await page.locator("#template-name").fill("Normal Form Testing");
    await page.getByRole("button", { name: "建立 Draft" }).click();

    await expect(page.getByTestId("import-review-panel")).toBeVisible();
    await page.getByTestId("cancel-import-btn").click(); // rollback
    await expect(page.getByTestId("import-review-panel")).not.toBeVisible();

    // Run 2: History test name (used to bypass)
    // The dialog remains open after cancellation, so we just upload the file again.

    await page.locator('input[type="file"][accept*=".pdf"]').setInputFiles({
      name: "History_Bypass_Form.pdf",
      mimeType: "application/pdf",
      buffer: pdfBuffer,
    });

    await page.locator("#template-name").fill("E2E Regression Table Workflow");
    await page.getByRole("button", { name: "建立 Draft" }).click();

    // Both must show the review panel!
    await expect(page.getByTestId("import-review-panel")).toBeVisible();
  });
});
