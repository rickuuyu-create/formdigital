import { expect, test } from "@playwright/test";
import { PDFDocument, PDFRadioGroup, PDFTextField, StandardFonts } from "pdf-lib";
import { authenticateTestUser, completeOnboarding } from "./test-runtime";

/**
 * The editor and the exported PDF are separate renderers, and a field that has
 * been positioned on screen is only trustworthy if both put it in the same
 * place. Comparing helper against helper cannot show that: it passes even when
 * the rendered UI disagrees with what the helpers say. So this drives the real
 * application, measures the boxes the browser actually laid out, exports a real
 * PDF, and compares the two.
 */
const PAGE_WIDTH_PT = 420;
const PAGE_HEIGHT_PT = 300;

async function parityFixture() {
  const document = await PDFDocument.create();
  const page = document.addPage([PAGE_WIDTH_PT, PAGE_HEIGHT_PT]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const form = document.getForm();

  page.drawText("Organisation:", { x: 30, y: 250, size: 11, font });
  form
    .createTextField("organisation")
    .addToPage(page, { x: 130, y: 244, width: 160, height: 18, font });

  page.drawText("Contact:", { x: 30, y: 210, size: 11, font });
  form
    .createTextField("contact")
    .addToPage(page, { x: 130, y: 204, width: 120, height: 16, font });

  // Two narrow neighbours: the PDF widget for a small field is floored to a
  // minimum size, which must not swell it across its neighbour.
  form
    .createTextField("day")
    .addToPage(page, { x: 30, y: 160, width: 14, height: 12, font });
  form
    .createTextField("month")
    .addToPage(page, { x: 60, y: 160, width: 14, height: 12, font });

  page.drawText("Other groups:", { x: 30, y: 120, size: 11, font });
  const radio = form.createRadioGroup("joined");
  radio.addOptionToPage("none", page, { x: 130, y: 118, width: 12, height: 12 });
  radio.addOptionToPage("yes", page, { x: 200, y: 118, width: 12, height: 12 });

  return Buffer.from(await document.save());
}

/** Where a rectangle sits inside the page, as fractions, y measured downward. */
type Fractional = { left: number; top: number; width: number; height: number };

function sortByPosition(boxes: Fractional[]) {
  return [...boxes].sort((a, b) => a.top - b.top || a.left - b.left);
}

function findAssetUrl(payload: unknown): string | undefined {
  const seen = JSON.stringify(payload);
  return seen.match(/\/api\/local\/assets\/[^"\\]+/)?.[0];
}

test("lays a field out in the same place on screen and in the exported PDF", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await authenticateTestUser(context, `${testInfo.project.name}-parity`);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await completeOnboarding(page);
  await page.getByRole("button", { name: "建立 Template" }).first().click();
  await page.locator('input[type="file"][accept*=".pdf"]').setInputFiles({
    name: "parity-form.pdf",
    mimeType: "application/pdf",
    buffer: await parityFixture(),
  });
  await page.locator("#template-name").fill("Parity Test");
  await page.getByRole("button", { name: "建立 Draft" }).click();
  await expect(page.getByTestId("import-review-panel")).toBeVisible({ timeout: 90_000 });
  await page.getByTestId("confirm-import-btn").click();
  await expect(
    page.getByRole("heading", { name: "Parity Test · v1" })
  ).toBeVisible({ timeout: 120_000 });

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

  // ---- the real UI: tick an option and watch the mark appear -------------
  const hotspots = page.locator(".canvas-option-hotspot");
  await expect(hotspots.first()).toBeVisible();
  const optionCount = await hotspots.count();
  expect(optionCount).toBeGreaterThan(1);
  const chosenLabel = await hotspots.nth(1).getAttribute("title");
  await hotspots.nth(1).click();
  await expect(hotspots.nth(1)).toHaveAttribute("aria-pressed", "true");
  // The mark is really in the document, not merely a state flag.
  await expect(hotspots.nth(1).locator("svg")).toHaveCount(1);
  await expect(page.locator(".canvas-option-hotspot svg")).toHaveCount(1);

  const firstInput = page.locator(".field-overlay input.canvas-direct-input").first();
  await firstInput.click();
  await firstInput.fill("PARITY");

  // Printed point sizes must scale with the actual paper, including small
  // viewports. Inheriting the app's 16px UI font cropped short form rows.
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 1000 });
    const typography = await firstInput.evaluate(input => {
      const paper = input.closest(".document-page")!.getBoundingClientRect();
      const style = getComputedStyle(input);
      return { paperWidth: paper.width, fontSize: Number.parseFloat(style.fontSize) };
    });
    expect(typography.fontSize / typography.paperWidth * PAGE_WIDTH_PT).toBeCloseTo(10, 1);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });

  // ---- measure what the browser actually laid out ------------------------
  const domBoxes: Fractional[] = await page.evaluate(() => {
    const sheet = document.querySelector(".document-page");
    if (!sheet) return [];
    const page = sheet.getBoundingClientRect();
    return Array.from(document.querySelectorAll(".field-overlay"))
      .filter(node => node.querySelector("input.canvas-direct-input"))
      .map(node => {
        const box = node.getBoundingClientRect();
        return {
          left: (box.left - page.left) / page.width,
          top: (box.top - page.top) / page.height,
          width: box.width / page.width,
          height: box.height / page.height,
        };
      });
  });
  expect(domBoxes.length).toBeGreaterThanOrEqual(4);

  // ---- export a real PDF and read the widgets back -----------------------
  // Export works from a stored Instance, so commit what was just filled in.
  await page
    .locator(".fill-footer")
    .getByRole("button", { name: "建立 Instance" })
    .click();
  await expect(
    page.getByText("Instance 已建立並綁定目前 Version")
  ).toBeVisible();
  await page.getByText("輸出", { exact: true }).click();
  const [, exportResponse] = await Promise.all([
    page.waitForEvent("popup"),
    page.waitForResponse(
      response =>
        response.url().includes("/api/trpc/formdigital.exports.pdf") &&
        response.status() === 200
    ),
    page.getByRole("button", { name: /可繼續填寫的 PDF|Editable PDF/ }).click(),
  ]);
  const assetUrl = findAssetUrl(await exportResponse.json());
  expect(assetUrl).toBeTruthy();
  const pdfBytes = await (
    await page.request.get(new URL(assetUrl!, page.url()).href)
  ).body();
  const exported = await PDFDocument.load(pdfBytes);
  const exportedPage = exported.getPage(0);
  const pageWidth = exportedPage.getWidth();
  const pageHeight = exportedPage.getHeight();
  const form = exported.getForm();

  // The option ticked on screen is the option selected in the file.
  const radio = form
    .getFields()
    .find(field => field instanceof PDFRadioGroup) as PDFRadioGroup | undefined;
  expect(radio?.getSelected()).toBe(chosenLabel);

  const widgetBoxes: Fractional[] = form
    .getFields()
    .filter(field => field instanceof PDFTextField)
    .flatMap(field =>
      field.acroField.getWidgets().map(widget => {
        const rect = widget.getRectangle();
        return {
          left: rect.x / pageWidth,
          // PDF measures y upward from the bottom; the DOM measures downward.
          top: (pageHeight - rect.y - rect.height) / pageHeight,
          width: rect.width / pageWidth,
          height: rect.height / pageHeight,
        };
      })
    );
  // Detection can also suggest fields the fixture did not declare, so pair each
  // measured box with its nearest widget rather than demanding equal counts.
  expect(widgetBoxes.length).toBeGreaterThanOrEqual(domBoxes.length);

  const TOLERANCE = 0.02;
  // Each measured box claims a widget of its own. Letting two boxes settle on
  // the same widget would hide a field that the PDF never drew at all.
  const unclaimed = [...widgetBoxes];
  const claim = (box: Fractional) => {
    let best = 0;
    for (let index = 1; index < unclaimed.length; index += 1)
      if (
        Math.hypot(
          unclaimed[index]!.left - box.left,
          unclaimed[index]!.top - box.top
        ) < Math.hypot(unclaimed[best]!.left - box.left, unclaimed[best]!.top - box.top)
      )
        best = index;
    return unclaimed.splice(best, 1)[0]!;
  };
  const pairs = domBoxes.map(box => ({ measured: box, drawn: claim(box) }));

  for (const [index, { measured, drawn }] of pairs.entries()) {
    expect(
      Math.abs(drawn.left - measured.left),
      `field ${index} left`
    ).toBeLessThan(TOLERANCE);
    expect(
      Math.abs(drawn.top - measured.top),
      `field ${index} top`
    ).toBeLessThan(TOLERANCE);
    // A narrow field is floored to a minimum widget size by the PDF form
    // specification, so its width is covered by the non-overlap check instead.
    if (measured.width > 0.1)
      expect(
        Math.abs(drawn.width - measured.width),
        `field ${index} width`
      ).toBeLessThan(TOLERANCE);
  }

  // ---- a floored small widget must not swallow its neighbour -------------
  const narrow = pairs
    .filter(pair => pair.measured.width <= 0.1)
    .map(pair => pair.drawn)
    .sort((a, b) => a.left - b.left);
  expect(narrow.length).toBeGreaterThanOrEqual(2);
  const [left, right] = narrow;
  expect(left!.left + left!.width).toBeLessThanOrEqual(right!.left + 1e-6);
});
