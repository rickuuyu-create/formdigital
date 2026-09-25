import { expect, test } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { authenticateTestUser, completeOnboarding } from "./test-runtime";
import {
  expectSaveResponseSuccess,
  fieldOf,
  getVersionDetails,
  saveDraftAndConfirmFor,
  versionIdFromUrl,
} from "./save-completion";

/**
 * test-only 診斷／回歸：證明「保存完成等待」的舊做法有缺陷、新做法正確。
 *
 * 舊做法（已修正於 mark-position-editor.spec.ts）：
 *   await page.getByRole("button", { name: /儲存|Save/ }).click();
 *   await expect(page.getByText("DRAFT · 已保存至 localhost")).toBeVisible();
 * 這行 `expect` 會在「頁面一渲染」就通過——`TemplateEditor` 的 `saveState`
 * 初始即 `"saved"`，header 常駐顯示該文字，**與 saveDraftFields mutation 是否
 * 完成無關**。下面兩個測試用可控制的方式證明這件事。
 */

async function radioFormFixture() {
  const document = await PDFDocument.create();
  const page = document.addPage([420, 300]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText("Other groups involved:", { x: 40, y: 220, size: 12, font });
  const radio = document.getForm().createRadioGroup("joined");
  radio.addOptionToPage("none", page, { x: 220, y: 214, width: 16, height: 16 });
  radio.addOptionToPage("yes", page, { x: 280, y: 214, width: 16, height: 16 });
  return Buffer.from(await document.save());
}

test("the persistent 'saved' header is visible before any save, so it is not a completion signal", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await authenticateTestUser(context, `${testInfo.project.name}-no-save`);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await completeOnboarding(page);
  await page.getByRole("button", { name: "建立 Template" }).first().click();
  await page.locator('input[type="file"][accept*=".pdf"]').setInputFiles({
    name: "radio-form.pdf",
    mimeType: "application/pdf",
    buffer: await radioFormFixture(),
  });
  await page.locator("#template-name").fill("No Save Yet");
  await page.getByRole("button", { name: "建立 Draft" }).click();
  await expect(page.getByTestId("import-review-panel")).toBeVisible({ timeout: 90_000 });
  await page.getByTestId("confirm-import-btn").click();
  await expect(
    page.getByRole("heading", { name: "No Save Yet · v1" })
  ).toBeVisible({ timeout: 90_000 });

  // 尚未點擊任何 Save、也尚未改動任何欄位，header 就已顯示「已保存至 localhost」。
  // 這證明舊的等待「點 Save 後等此文字」是無效的完成信號。
  await expect(
    page.getByText("DRAFT · 已保存至 localhost", { exact: true })
  ).toBeVisible();
});

test("save-completion waits for a delayed saveDraftFields response, not the persistent header", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await authenticateTestUser(context, `${testInfo.project.name}-delayed`);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await completeOnboarding(page);
  await page.getByRole("button", { name: "建立 Template" }).first().click();
  await page.locator('input[type="file"][accept*=".pdf"]').setInputFiles({
    name: "radio-form.pdf",
    mimeType: "application/pdf",
    buffer: await radioFormFixture(),
  });
  await page.locator("#template-name").fill("Delayed Save");
  await page.getByRole("button", { name: "建立 Draft" }).click();
  await expect(page.getByTestId("import-review-panel")).toBeVisible({ timeout: 90_000 });
  await page.getByTestId("confirm-import-btn").click();
  await expect(
    page.getByRole("heading", { name: "Delayed Save · v1" })
  ).toBeVisible({ timeout: 90_000 });

  const versionId = versionIdFromUrl(page);

  // 可控延遲：saveDraftFields 一律慢 1500ms 才放行。
  // 注意 procedure 是 `templates.saveDraftFields`（`saveDraftFields` 前是「.」不是
  // 「/」），故用正則比對，不能用 `**/saveDraftFields**` 這類含「/」的 glob。
  await page.route(/saveDraftFields/, async route => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await route.continue();
  });

  await page.locator('button.field-row[data-field-type="radio"]').first().click();
  const handles = page
    .locator(".field-overlay.is-active")
    .locator(".mark-position-handle");
  await expect(handles).toHaveCount(2);

  // 拖動第一個 mark 製造 dirty（每次拖動都會讓 900ms autosave 計時器重置，
  // 故緊接著點 Save 一定是由 Save 自己發出 mutation）。
  const dragFirstMark = async () => {
    const box = (await page.locator(".field-overlay.is-active").boundingBox())!;
    const mark = (await handles.nth(0).boundingBox())!;
    await page.mouse.move(mark.x + mark.width / 2, mark.y + mark.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      mark.x + mark.width / 2 + box.width * 0.3,
      mark.y + mark.height / 2,
      { steps: 6 }
    );
    await page.mouse.up();
  };

  // ---- 新等待（量測）----
  await dragFirstMark();
  // 觸發前才登記等待，避免漏接快速回應／被別的 autosave 滿足。
  const saved = page.waitForResponse(
    response =>
      response.url().includes("formdigital.templates.saveDraftFields") &&
      response.request().method() === "POST",
    { timeout: 30_000 }
  );
  const t0 = Date.now();
  await page.getByRole("button", { name: /儲存|Save/ }).click();
  // 新等待：直到「真的」收到 saveDraftFields 回應（含 1500ms 可控延遲）才放行。
  const response = await saved;
  const newElapsed = Date.now() - t0;
  await expectSaveResponseSuccess(response, versionId);
  expect(
    newElapsed,
    "the completion wait must hold until the delayed saveDraftFields response arrives"
  ).toBeGreaterThanOrEqual(1000);

  // ---- 舊等待（同一個延遲下的對照量測，僅記錄不美化）----
  await dragFirstMark();
  const t1 = Date.now();
  await page.getByRole("button", { name: /儲存|Save/ }).click();
  await expect(
    page.getByText("DRAFT · 已保存至 localhost", { exact: true })
  ).toBeVisible();
  const oldElapsed = Date.now() - t1;
  console.log(
    `MEASURED-SAVE-WAIT old(header-text)=${oldElapsed}ms new(response)=${newElapsed}ms delay=1500ms`
  );
});

/**
 * 決定性反例（不靠碰運氣重跑 WebKit）：
 * 把 saveDraftFields 換成「看起來成功的假回應」——客戶端會把 saveState 設成
 * "saved"，但伺服器其實**什麼都沒收到**。
 *
 *  - 舊等待：「已保存至 localhost」文字 → **通過**（被騙）。
 *  - 新等待：等回應（業務成功）後再用正式讀取路徑讀回 → **失敗**（正確抓到
 *    「沒有真的落盤」），而不是放行去 reload 然後讀到舊座標。
 */
test("a faked successful save fools the persistent header but not the read-back confirmation", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await authenticateTestUser(context, `${testInfo.project.name}-faked-save`);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await completeOnboarding(page);
  await page.getByRole("button", { name: "建立 Template" }).first().click();
  await page.locator('input[type="file"][accept*=".pdf"]').setInputFiles({
    name: "radio-form.pdf",
    mimeType: "application/pdf",
    buffer: await radioFormFixture(),
  });
  await page.locator("#template-name").fill("Faked Save Test");
  await page.getByRole("button", { name: "建立 Draft" }).click();
  await expect(page.getByTestId("import-review-panel")).toBeVisible({ timeout: 90_000 });
  await page.getByTestId("confirm-import-btn").click();
  await expect(
    page.getByRole("heading", { name: "Faked Save Test · v1" })
  ).toBeVisible({ timeout: 90_000 });

  const versionId = versionIdFromUrl(page);
  const beforeFirstX =
    (
      fieldOf(await getVersionDetails(page, versionId), "radio")?.definition
        ?.optionMarks as Array<Record<string, number>> | undefined
    )?.[0]?.xRatio ?? 0;

  await page.locator('button.field-row[data-field-type="radio"]').first().click();
  const handles = page
    .locator(".field-overlay.is-active")
    .locator(".mark-position-handle");
  await expect(handles).toHaveCount(2);
  const dragFirstMark = async () => {
    const box = (await page.locator(".field-overlay.is-active").boundingBox())!;
    const mark = (await handles.nth(0).boundingBox())!;
    await page.mouse.move(mark.x + mark.width / 2, mark.y + mark.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      mark.x + mark.width / 2 + box.width * 0.3,
      mark.y + mark.height / 2,
      { steps: 6 }
    );
    await page.mouse.up();
  };

  // 假的「成功」回應：superjson 形狀 `[{ result: { data: { json: … } } }]`。
  // 請求根本不會送到伺服器，所以伺服器端座標永遠是舊的。
  await page.route(/saveDraftFields/, route =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          result: {
            data: {
              json: {
                versionId,
                contentHash: "faked-not-persisted",
                updatedAt: new Date().toISOString(),
              },
            },
          },
        },
      ]),
    })
  );

  // 舊等待：拖動 → 點 Save → 等常駐文字。假回應讓 saveState 變成 "saved"，
  // 這行**會通過**，即使伺服器什麼都沒存到。
  await dragFirstMark();
  await page.getByRole("button", { name: /儲存|Save/ }).click();
  await expect(
    page.getByText("DRAFT · 已保存至 localhost", { exact: true })
  ).toBeVisible();
  console.log("OLD-WAIT PASSED while nothing was persisted (the defect)");

  // 新等待：同一個假回應下，正式讀取路徑讀回的座標沒有改變 → 必須丟出錯誤，
  // 而不是放行去 reload 讀到舊座標。
  //
  // 讀回改為**目標 field ID**（`stableFieldId`）關聯，不再只找第一個 radio：
  // 同一型別有多個欄位時，只找第一個可能讀到別的欄位而假通過。
  const fieldId = String(
    fieldOf(await getVersionDetails(page, versionId), "radio")?.stableFieldId ?? ""
  );
  expect(fieldId, "the radio field must expose a stableFieldId").not.toBe("");
  await dragFirstMark();
  await expect(
    saveDraftAndConfirmFor(page, {
      versionId,
      target: {
        fieldId,
        assertField: field => {
          const marks = field?.definition?.optionMarks as
            | Array<Record<string, number>>
            | undefined;
          expect(marks?.[0]?.xRatio).toBeGreaterThan(beforeFirstX + 0.1);
        },
      },
    })
  ).rejects.toThrow();
  console.log("NEW-WAIT REJECTED: read-back detected that nothing persisted");
});
