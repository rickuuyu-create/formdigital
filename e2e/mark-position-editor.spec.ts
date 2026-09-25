import { expect, test } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { authenticateTestUser, completeOnboarding } from "./test-runtime";
import {
  fieldOf,
  getVersionDetails,
  saveDraftAndConfirmFor,
  versionIdFromUrl,
} from "./save-completion";
import {
  createMarkPositionTrace,
  shouldPrintTrace,
} from "./mark-position-diag";

/**
 * A ticked box or a selected radio option is only as accurate as the AI-
 * detected geometry it prints into. When that geometry is a few pixels off,
 * the mark lands on the neighbouring printed text instead of inside the
 * square, and moving or resizing the whole field cannot fix it — every mark
 * shares the same field box. This proves the per-mark drag/nudge handles that
 * let a person correct one detected box without touching the others, and that
 * the corrected position survives a save and reload.
 */
async function radioFormFixture() {
  const document = await PDFDocument.create();
  const page = document.addPage([420, 300]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const form = document.getForm();
  page.drawText("Other groups involved:", { x: 40, y: 220, size: 12, font });
  const radio = form.createRadioGroup("joined");
  radio.addOptionToPage("none", page, {
    x: 220,
    y: 214,
    width: 16,
    height: 16,
  });
  radio.addOptionToPage("yes", page, { x: 280, y: 214, width: 16, height: 16 });
  return Buffer.from(await document.save());
}

test("lets a person drag and nudge one detected radio mark without moving its sibling", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await authenticateTestUser(context, `${testInfo.project.name}-mark-position`);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await completeOnboarding(page);
  await page.getByRole("button", { name: "建立 Template" }).first().click();
  await page.locator('input[type="file"][accept*=".pdf"]').setInputFiles({
    name: "radio-form.pdf",
    mimeType: "application/pdf",
    buffer: await radioFormFixture(),
  });
  await page.locator("#template-name").fill("Mark Position Test");
  await page.getByRole("button", { name: "建立 Draft" }).click();
  await expect(page.getByTestId("import-review-panel")).toBeVisible({ timeout: 90_000 });
  await page.getByTestId("confirm-import-btn").click();
  await expect(
    page.getByRole("heading", { name: "Mark Position Test · v1" })
  ).toBeVisible({ timeout: 90_000 });

  await page.locator('button.field-row[data-field-type="radio"]').first().click();
  const overlay = page.locator(".field-overlay.is-active");
  await expect(overlay).toBeVisible();
  const handles = overlay.locator(".mark-position-handle");
  await expect(handles).toHaveCount(2);

  // 從 URL 取 versionId，並讀取拖動前的伺服器端基準（偵測到的選項框）。
  const versionId = versionIdFromUrl(page);
  const beforeRadioField = fieldOf(
    await getVersionDetails(page, versionId),
    "radio"
  );
  const beforeMarks = beforeRadioField?.definition?.optionMarks as
    | Array<Record<string, number>>
    | undefined;
  const beforeFirstX = beforeMarks?.[0]?.xRatio ?? 0;
  const radioFieldId = String(
    beforeRadioField?.stableFieldId ?? beforeRadioField?.id ?? ""
  );
  expect(
    radioFieldId,
    "the radio field must expose a stableFieldId to correlate on"
  ).not.toBe("");

  // test-only 診斷軌跡：以**同一 versionId ＋ fieldId** 串起
  // pointer 順序 → DOM 預覽 → 保存 payload → 業務回應 → 正式讀回。
  // 只輸出必要座標與安全識別；平時不印，只在失敗時印一次。
  // 這是**定位用**紀錄，不代表產品端有故障（見交接：根因目前 `NOT PROVEN`）。
  const trace = createMarkPositionTrace(page, {
    versionId,
    fieldId: radioFieldId,
    geometryKey: "optionMarks",
    geometryIndex: 0,
  });
  try {
    const overlayBox = (await overlay.boundingBox())!;
    const firstBefore = (await handles.nth(0).boundingBox())!;
    const secondBefore = (await handles.nth(1).boundingBox())!;

    // Drag only the first mark; the second must not move.
    const startX = firstBefore.x + firstBefore.width / 2;
    const startY = firstBefore.y + firstBefore.height / 2;
    const endX = startX + overlayBox.width * 0.3;
    trace.pointer("down", startX, startY);
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(endX, startY, { steps: 6 });
    await page.mouse.up();
    trace.pointer("up", endX, startY);

    const firstAfterDrag = (await handles.nth(0).boundingBox())!;
    const secondAfterDrag = (await handles.nth(1).boundingBox())!;
    trace.dom(firstAfterDrag.x, firstAfterDrag.y);
    expect(firstAfterDrag.x - firstBefore.x).toBeGreaterThan(10);
    expect(Math.abs(secondAfterDrag.x - secondBefore.x)).toBeLessThan(1);

    // Keyboard nudge on the second mark moves only that mark, in small steps.
    await handles.nth(1).click();
    await handles.nth(1).focus();
    const secondBeforeNudge = (await handles.nth(1).boundingBox())!;
    for (let step = 0; step < 5; step += 1)
      await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(150);
    const secondAfterNudge = (await handles.nth(1).boundingBox())!;
    expect(secondAfterNudge.x).toBeLessThan(secondBeforeNudge.x);
    const firstAfterNudge = (await handles.nth(0).boundingBox())!;
    expect(Math.abs(firstAfterNudge.x - firstAfterDrag.x)).toBeLessThan(1);

    const afterDragXRadio = (await handles.nth(0).boundingBox())!.x;
    // 同上：診斷「拖動後、Save 前」本機座標是否已被伺服器快照重置。
    const beforeSaveBoxRadio = (await handles.nth(0).boundingBox())!;
    const beforeSaveXRadio = beforeSaveBoxRadio.x;
    trace.dom(beforeSaveXRadio, beforeSaveBoxRadio.y);
    console.log(
      `MPE-DIAG radio: firstBeforeX=${firstBefore.x} afterDragX=${afterDragXRadio} beforeSaveX=${beforeSaveXRadio}`
    );

    // The corrected position is real data, not a visual-only drag preview. 等真正
    // 的 saveDraftFields 完成並經正式讀取路徑確認**目標 field ID** 的第 0 個
    // 選項框座標已落盤，再 reload。
    await saveDraftAndConfirmFor(page, {
      versionId,
      target: {
        fieldId: radioFieldId,
        assertField: field => {
          const marks = field?.definition?.optionMarks as
            | Array<Record<string, number>>
            | undefined;
          expect(
            marks?.[0]?.xRatio,
            "the first mark must be persisted to the right of its starting position"
          ).toBeGreaterThan(beforeFirstX + 0.1);
        },
      },
    });
    trace.readback(await getVersionDetails(page, versionId));
    if (shouldPrintTrace()) console.log(`MPE-DIAG radio ${trace.summary()}`);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page
      .locator('button.field-row[data-field-type="radio"]')
      .first()
      .click();
    const reloadedHandles = page
      .locator(".field-overlay.is-active")
      .locator(".mark-position-handle");
    const firstPersisted = (await reloadedHandles.nth(0).boundingBox())!;
    expect(firstPersisted.x - firstBefore.x).toBeGreaterThan(10);
  } catch (error) {
    // 失敗時印一次完整軌跡供定位（只含必要座標與安全識別，不含 body／token）。
    console.log(`MPE-DIAG radio ${trace.summary()}`);
    throw error;
  } finally {
    trace.close();
  }
});

async function textFieldFixture() {
  const document = await PDFDocument.create();
  const page = document.addPage([420, 300]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText("Other groups involved:", { x: 40, y: 220, size: 12, font });
  document
    .getForm()
    .createTextField("notes")
    .addToPage(page, { x: 220, y: 214, width: 120, height: 16, font });
  return Buffer.from(await document.save());
}

test("typing options keeps its line breaks and gives a radio field draggable marks", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await authenticateTestUser(context, `${testInfo.project.name}-option-lines`);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await completeOnboarding(page);
  await page.getByRole("button", { name: "建立 Template" }).first().click();
  await page.locator('input[type="file"][accept*=".pdf"]').setInputFiles({
    name: "text-form.pdf",
    mimeType: "application/pdf",
    buffer: await textFieldFixture(),
  });
  await page.locator("#template-name").fill("Option Lines Test");
  await page.getByRole("button", { name: "建立 Draft" }).click();
  await expect(page.getByTestId("import-review-panel")).toBeVisible({ timeout: 90_000 });
  await page.getByTestId("confirm-import-btn").click();
  await expect(
    page.getByRole("heading", { name: "Option Lines Test · v1" })
  ).toBeVisible({ timeout: 90_000 });

  await page.locator("button.field-row").first().click();
  const settings = page.locator("aside").last();
  await settings.locator("select").first().selectOption("radio");

  // The committed options drop blank lines; binding the textarea straight to
  // them used to erase the newline the instant Enter was pressed.
  const textarea = settings.locator("textarea").first();
  await textarea.click();
  await textarea.type("沒有");
  await page.keyboard.press("Enter");
  await textarea.type("有");
  await expect(textarea).toHaveValue("沒有\n有");

  // A hand-typed radio field still needs a box per option to print into and to
  // drag, so marks are generated for options that had no detected geometry.
  const handles = page.locator(
    ".field-overlay.is-active .mark-position-handle"
  );
  await expect(handles).toHaveCount(2);
});

test("ticks a radio option by clicking its box directly on the fill canvas", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await authenticateTestUser(context, `${testInfo.project.name}-fill-click`);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await completeOnboarding(page);
  await page.getByRole("button", { name: "建立 Template" }).first().click();
  await page.locator('input[type="file"][accept*=".pdf"]').setInputFiles({
    name: "radio-form.pdf",
    mimeType: "application/pdf",
    buffer: await radioFormFixture(),
  });
  await page.locator("#template-name").fill("Fill Click Test");
  await page.getByRole("button", { name: "建立 Draft" }).click();
  await expect(page.getByTestId("import-review-panel")).toBeVisible({ timeout: 90_000 });
  await page.getByTestId("confirm-import-btn").click();
  await expect(
    page.getByRole("heading", { name: "Fill Click Test · v1" })
  ).toBeVisible({ timeout: 90_000 });

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

  // Every detected option box is its own click target on the page itself.
  const hotspots = page.locator(".canvas-option-hotspot");
  await expect(hotspots).toHaveCount(2);

  await hotspots.nth(1).click();
  await expect(hotspots.nth(1)).toHaveAttribute("aria-pressed", "true");
  await expect(hotspots.nth(0)).toHaveAttribute("aria-pressed", "false");
  // Exactly one mark is drawn, in the box that was clicked.
  await expect(page.locator(".canvas-option-hotspot svg")).toHaveCount(1);

  // Clicking the chosen option again clears the answer.
  await hotspots.nth(1).click();
  await expect(hotspots.nth(1)).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".canvas-option-hotspot svg")).toHaveCount(0);
});

test("gives a multi-select checkbox row its own positionable, independently tickable boxes", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await authenticateTestUser(context, `${testInfo.project.name}-multi-checkbox`);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await completeOnboarding(page);
  await page.getByRole("button", { name: "建立 Template" }).first().click();
  await page.locator('input[type="file"][accept*=".pdf"]').setInputFiles({
    name: "text-form.pdf",
    mimeType: "application/pdf",
    buffer: await textFieldFixture(),
  });
  await page.locator("#template-name").fill("Multi Checkbox Test");
  await page.getByRole("button", { name: "建立 Draft" }).click();
  await expect(page.getByTestId("import-review-panel")).toBeVisible({ timeout: 90_000 });
  await page.getByTestId("confirm-import-btn").click();
  await expect(
    page.getByRole("heading", { name: "Multi Checkbox Test · v1" })
  ).toBeVisible({ timeout: 90_000 });

  await page.locator("button.field-row").first().click();
  const settings = page.locator("aside").last();
  await settings.locator("select").first().selectOption("checkbox");

  const textarea = settings.locator("textarea").first();
  await textarea.click();
  await textarea.fill("A\nB\nC");

  // A checkbox row gets one positionable box per option, same as a radio.
  const handles = page.locator(
    ".field-overlay.is-active .mark-position-handle"
  );
  await expect(handles).toHaveCount(3);

  // Moving one box leaves the rest alone.
  const overlayBox = (await page
    .locator(".field-overlay.is-active")
    .boundingBox())!;
  const firstBefore = (await handles.nth(0).boundingBox())!;
  const secondBefore = (await handles.nth(1).boundingBox())!;
  await page.mouse.move(
    firstBefore.x + firstBefore.width / 2,
    firstBefore.y + firstBefore.height / 2
  );
  await page.mouse.down();
  await page.mouse.move(
    firstBefore.x + firstBefore.width / 2 + overlayBox.width * 0.05,
    firstBefore.y + firstBefore.height / 2,
    { steps: 5 }
  );
  await page.mouse.up();
  expect((await handles.nth(0).boundingBox())!.x).toBeGreaterThan(
    firstBefore.x
  );
  expect(
    Math.abs((await handles.nth(1).boundingBox())!.x - secondBefore.x)
  ).toBeLessThan(1);

  // Filling: each square toggles on its own, unlike a radio group.
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

  const hotspots = page.locator(".canvas-option-hotspot");
  await expect(hotspots).toHaveCount(3);
  await hotspots.nth(0).click();
  await hotspots.nth(2).click();
  await expect(hotspots.nth(0)).toHaveAttribute("aria-pressed", "true");
  await expect(hotspots.nth(1)).toHaveAttribute("aria-pressed", "false");
  await expect(hotspots.nth(2)).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".canvas-option-hotspot svg")).toHaveCount(2);
});

async function nestedFieldFixture() {
  const document = await PDFDocument.create();
  const page = document.addPage([420, 300]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const form = document.getForm();
  page.drawText("Venue:", { x: 40, y: 220, size: 12, font });
  // A writable blank printed between the two squares of one option row: the
  // row's field box encloses it completely.
  form
    .createTextField("venue")
    .addToPage(page, { x: 150, y: 214, width: 90, height: 16, font });
  const radio = form.createRadioGroup("where");
  radio.addOptionToPage("hall", page, { x: 120, y: 214, width: 12, height: 12 });
  radio.addOptionToPage("room", page, { x: 300, y: 214, width: 12, height: 12 });
  return Buffer.from(await document.save());
}

/**
 * Stacking used to follow the order fields were created, which has nothing to
 * do with size, and the whole option row took every click inside it. Between
 * them, a blank printed inside an option row could not be typed into at all.
 */
test("types into a text field printed inside an option row", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await authenticateTestUser(context, `${testInfo.project.name}-nested-field`);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await completeOnboarding(page);
  await page.getByRole("button", { name: "建立 Template" }).first().click();
  await page.locator('input[type="file"][accept*=".pdf"]').setInputFiles({
    name: "nested-form.pdf",
    mimeType: "application/pdf",
    buffer: await nestedFieldFixture(),
  });
  await page.locator("#template-name").fill("Nested Field Test");
  await page.getByRole("button", { name: "建立 Draft" }).click();
  await expect(page.getByTestId("import-review-panel")).toBeVisible({ timeout: 90_000 });
  await page.getByTestId("confirm-import-btn").click();
  await expect(
    page.getByRole("heading", { name: "Nested Field Test · v1" })
  ).toBeVisible({ timeout: 90_000 });

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

  // The blank enclosed by the option row takes the click and the typing.
  const inner = page.locator(".field-overlay input.canvas-direct-input");
  await expect(inner).toHaveCount(1);
  await inner.click();
  await inner.fill("CBCC620");
  await expect(inner).toHaveValue("CBCC620");

  // The squares of the enclosing row still tick, so nothing was traded away.
  const hotspots = page.locator(".canvas-option-hotspot");
  await expect(hotspots).toHaveCount(2);
  await hotspots.nth(1).click();
  await expect(hotspots.nth(1)).toHaveAttribute("aria-pressed", "true");
  await expect(inner).toHaveValue("CBCC620");
});

/**
 * A repeating-row field prints into cells derived from one box. Real tables
 * have uneven rows and rarely start at the top of the detected box, so each
 * cell needs its own handle — and moving one must leave the rest alone.
 */
test("positions one repeating-row cell without moving the others", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await authenticateTestUser(context, `${testInfo.project.name}-table-cells`);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await completeOnboarding(page);
  await page.getByRole("button", { name: "建立 Template" }).first().click();
  await page.locator('input[type="file"][accept*=".pdf"]').setInputFiles({
    name: "text-form.pdf",
    mimeType: "application/pdf",
    buffer: await textFieldFixture(),
  });
  await page.locator("#template-name").fill("Table Cells Test");
  await page.getByRole("button", { name: "建立 Draft" }).click();
  await expect(page.getByTestId("import-review-panel")).toBeVisible({ timeout: 90_000 });
  await page.getByTestId("confirm-import-btn").click();
  await expect(
    page.getByRole("heading", { name: "Table Cells Test · v1" })
  ).toBeVisible({ timeout: 90_000 });

  await page.locator("button.field-row").first().click();
  const settings = page.locator("aside").last();
  await settings.locator("select").first().selectOption("table");
  await settings.locator('label:has-text("最大列數") + input').fill("2");
  await settings.locator('label:has-text("欄數") + input').fill("2");

  // 階段 2：表格欄位的逐格把手只在「逐格模式」下渲染，故需先切到逐格模式。
  await page.getByTestId("mode-cell").click();

  // 從 URL 取 versionId，供「保存後正式讀回驗證」使用。
  const versionId = versionIdFromUrl(page);
  // 拖動前的伺服器端基準。欄位剛切成 table、可能尚未落盤，故退回原 text 欄位：
  // 兩者是同一個 stableFieldId，這正是兩條鏈路要關聯的識別。
  const beforeDetails = await getVersionDetails(page, versionId);
  const beforeField =
    fieldOf(beforeDetails, "table") ?? fieldOf(beforeDetails, "text");
  const beforeGuides = beforeField?.definition?.tableCellGuides as
    | Array<Record<string, number>>
    | undefined;
  const beforeX0 = beforeGuides?.[0]?.xRatio ?? 0;
  const tableFieldId = String(
    beforeField?.stableFieldId ?? beforeField?.id ?? ""
  );
  expect(
    tableFieldId,
    "the table field must expose a stableFieldId to correlate on"
  ).not.toBe("");

  // test-only 診斷軌跡：同一 versionId ＋ fieldId，串起 pointer 順序 → DOM 預覽
  // → 保存 payload（含所有相關事件的順序、正確解析 batch）→ 業務回應 → 正式讀回。
  // 只輸出必要座標與安全識別；解析失敗用固定訊息，**不印 body 片段**。
  const trace = createMarkPositionTrace(page, {
    versionId,
    fieldId: tableFieldId,
    geometryKey: "tableCellGuides",
    geometryIndex: 0,
  });
  try {
    // One handle per cell of the grid, starting on the even division.
    const handles = page.locator(
      ".field-overlay.is-active .mark-position-handle"
    );
    await expect(handles).toHaveCount(4);

    const overlayBox = (await page
      .locator(".field-overlay.is-active")
      .boundingBox())!;
    const firstBefore = (await handles.nth(0).boundingBox())!;
    const others = await Promise.all(
      [1, 2, 3].map(async index => (await handles.nth(index).boundingBox())!)
    );
    const startX = firstBefore.x + firstBefore.width / 2;
    const startY = firstBefore.y + firstBefore.height / 2;
    const endX = startX + overlayBox.width * 0.05;
    trace.pointer("down", startX, startY);
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(endX, startY, { steps: 5 });
    await page.mouse.up();
    trace.pointer("up", endX, startY);

    const afterDragBox0 = (await handles.nth(0).boundingBox())!;
    const afterDragX0 = afterDragBox0.x;
    trace.dom(afterDragX0, afterDragBox0.y);
    expect(afterDragX0).toBeGreaterThan(firstBefore.x);
    for (const [index, box] of others.entries())
      expect(
        Math.abs((await handles.nth(index + 1).boundingBox())!.x - box.x)
      ).toBeLessThan(1);

    // 診斷（test-only，不影響斷言）：若 TemplateEditor 被 getVersionDetails 重新
    // 抓取的 contentHash 變化重置（`setFields` 用伺服器快照覆寫＋`setDirty(false)`），
    // 本機剛拖動的結果會在 Save 之前就被丟棄 → beforeSaveX 會退回 firstBefore.x。
    const beforeSaveBox0 = (await handles.nth(0).boundingBox())!;
    const beforeSaveX0 = beforeSaveBox0.x;
    trace.dom(beforeSaveX0, beforeSaveBox0.y);
    console.log(
      `MPE-DIAG table: firstBeforeX=${firstBefore.x} afterDragX=${afterDragX0} beforeSaveX=${beforeSaveX0}`
    );

    // The corrected cell is stored, not just drawn. 等真正的 saveDraftFields 完成
    // （而不是常駐的「已保存至 localhost」文字），並透過正式讀取路徑確認**目標
    // field ID** 的第 0 格座標已落盤，才 reload——否則立即 reload 可能讀到舊座標。
    await saveDraftAndConfirmFor(page, {
      versionId,
      target: {
        fieldId: tableFieldId,
        assertField: field => {
          const guides = field?.definition?.tableCellGuides as
            | Array<Record<string, number>>
            | undefined;
          expect(guides, "table cell guides must be persisted").toBeTruthy();
          expect(
            guides!.length,
            "a 2×2 table must persist 4 cell guides"
          ).toBe(4);
          expect(
            guides![0]!.xRatio,
            "the first cell must be persisted to the right of its starting position"
          ).toBeGreaterThan(beforeX0 + 0.01);
        },
      },
    });
    trace.readback(await getVersionDetails(page, versionId));
    if (shouldPrintTrace()) console.log(`MPE-DIAG table ${trace.summary()}`);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page
      .locator('button.field-row[data-field-type="table"]')
      .first()
      .click();
    await page.getByTestId("mode-cell").click();
    const reloaded = page.locator(
      ".field-overlay.is-active .mark-position-handle"
    );
    await expect(reloaded).toHaveCount(4);
    expect((await reloaded.nth(0).boundingBox())!.x).toBeGreaterThan(
      firstBefore.x
    );
  } catch (error) {
    // 失敗時印一次完整軌跡供定位（只含必要座標與安全識別，不含 body／token）。
    console.log(`MPE-DIAG table ${trace.summary()}`);
    throw error;
  } finally {
    trace.close();
  }
});
