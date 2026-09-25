import { expect, test } from "@playwright/test";
import { authenticateTestUser, completeOnboarding } from "./test-runtime";
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { PDFDocument } from "pdf-lib";
import { findLocalAssetUrl } from "./test-runtime";
const practiceLessons = JSON.parse(
  readFileSync(
    new URL(
      "../client/src/lib/template-practice-catalog.json",
      import.meta.url
    ),
    "utf8"
  )
);

async function mutate(page: Page, name: string, input: unknown) {
  const response = await page.request.post(`/api/trpc/${name}`, {
    data: { json: input },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const body = await response.json();
  return body.result.data.json;
}

test("approved practice import, real editing checks, circle alignment and resume", async ({
  page,
  context,
}, info) => {
  test.setTimeout(180_000);
  await authenticateTestUser(context, `practice-${info.project.name}`);
  await page.goto("/");
  await completeOnboarding(page);
  await page
    .getByRole("button", { name: "開始新的範本實習", exact: true })
    .click();
  await expect(page.locator("#template-name")).toHaveValue("範本建立實習");
  await expect(
    page.getByText("Formdigital-template-practice-v1.pdf", { exact: false })
  ).toBeVisible();
  await page.getByRole("button", { name: "建立 Draft", exact: true }).click();
  await expect(page.getByTestId("import-review-panel")).toBeVisible({
    timeout: 90_000,
  });
  await page.getByTestId("import-pages-only-btn").click();
  const coach = page.getByTestId("practice-coach");
  await expect(coach).toBeVisible({ timeout: 90_000 });
  await expect(
    page
      .locator(".editor-nav .page-row")
      .filter({ has: page.getByRole("button", { name: /Page \d/ }) })
  ).toHaveCount(8);
  await expect(coach).toContainText("0 / 41");
  await coach
    .getByRole("button", { name: "建立本步空框", exact: true })
    .click();
  const inspector = page.locator(".editor-inspector");
  await inspector
    .locator("label")
    .filter({ hasText: /^必填$/ })
    .locator("input")
    .check();
  await inspector.locator('label:has-text("最大字數") + input').fill("20");
  await inspector
    .getByRole("button", { name: "確認此欄位", exact: true })
    .click();
  await expect(coach).toContainText("1 / 41");
  await inspector.locator('label:has-text("最大字數") + input').fill("19");
  await expect(coach).toContainText("0 / 41");
  await inspector.locator('label:has-text("最大字數") + input').fill("20");
  await page.getByRole("button", { name: "儲存", exact: true }).click();
  await coach.getByRole("combobox").selectOption("12");
  await coach
    .getByRole("button", { name: "建立本步空框", exact: true })
    .click();
  await inspector.locator("select").first().selectOption("radio");
  await inspector.locator("textarea").first().fill("A\nB\nC\nD\nE\nF");
  await inspector
    .locator('select:has(option[value="circle"])')
    .selectOption("circle");
  await inspector
    .locator("label")
    .filter({ hasText: /^必填$/ })
    .locator("input")
    .check();
  await inspector
    .getByRole("button", { name: "確認此欄位", exact: true })
    .click();
  await expect(coach.locator('[data-check="marks"]')).toHaveAttribute(
    "data-passed",
    "false"
  );
  // Resize and move actual visible handles, using the approved target geometry.
  const lesson = practiceLessons.find(l => l.id === "B01")!;
  for (let i = 0; i < 6; i++) {
    const handle = page
      .locator(".field-overlay.is-active .mark-position-handle")
      .nth(i);
    await handle.scrollIntoViewIfNeeded();
    let box = await handle.boundingBox();
    let field = await page.locator(".field-overlay.is-active").boundingBox();
    const m = lesson.marks![i];
    const resize = await handle
      .locator("[data-mark-resize-handle]")
      .boundingBox();
    await page.mouse.move(
      resize!.x + resize!.width / 2,
      resize!.y + resize!.height / 2
    );
    await page.mouse.down();
    await page.mouse.move(
      resize!.x + resize!.width / 2 + field!.width * m.widthRatio - box!.width,
      resize!.y +
        resize!.height / 2 +
        field!.height * m.heightRatio -
        box!.height,
      { steps: 8 }
    );
    await page.mouse.up();
    box = await handle.boundingBox();
    field = await page.locator(".field-overlay.is-active").boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      field!.x + field!.width * m.xRatio + box!.width / 2,
      field!.y + field!.height * m.yRatio + box!.height / 2,
      { steps: 8 }
    );
    await page.mouse.up();
  }
  await expect(coach.locator('[data-check="marks"]')).toHaveAttribute(
    "data-passed",
    "true"
  );
  await inspector
    .getByRole("button", { name: "確認此欄位", exact: true })
    .click();
  await expect(coach).toContainText("2 / 41");
  await page.getByRole("button", { name: "儲存", exact: true }).click();
  await expect(page.locator(".editor-header")).toContainText(
    "已保存至 localhost"
  );
  await page.reload();
  await expect(coach).toContainText("2 / 41");
  await expect(coach.getByRole("combobox")).toHaveValue("12");
  await expect(inspector.getByRole('textbox', { name: '欄位名稱', exact: true })).toHaveValue(/^B01 /);
  await coach.getByRole("button", { name: "前往練習位置" }).click();
  await expect(page.getByTestId("practice-outline")).toBeVisible();
  await page.screenshot({
    path: info.outputPath("practice-circle-editor.png"),
    fullPage: true,
  });
  await coach.getByRole("combobox").selectOption("13");
  await expect(inspector).toContainText("選取欄位以編輯設定");
  await coach.getByRole("combobox").selectOption("31");
  await coach.getByRole("button", { name: "建立本步空框", exact: true }).click();
  await inspector.locator("select").first().selectOption("table");
  await inspector.locator('input[type="number"]').last().fill("3");
  await inspector.getByRole("button", { name: "逐格微調", exact: true }).click();
  await expect(page.locator('.field-overlay.is-active [data-cell-index]')).toHaveCount(9);
});

test("all 41 saved settings survive, 72 cells remain reachable, fill guide and eight-page export", async ({
  page,
  context,
}, info) => {
  test.setTimeout(180_000);
  await authenticateTestUser(context, `practice-complete-${info.project.name}`);
  await page.goto("/");
  await completeOnboarding(page);
  await page
    .getByRole("button", { name: "開始新的範本實習", exact: true })
    .click();
  await expect(page.locator("#template-name")).toHaveValue("範本建立實習");
  await page.getByRole("button", { name: "建立 Draft", exact: true }).click();
  await expect(page.getByTestId("import-review-panel")).toBeVisible({
    timeout: 90_000,
  });
  await page.getByTestId("import-pages-only-btn").click();
  const coach = page.getByTestId("practice-coach");
  await expect(coach).toBeVisible({ timeout: 90_000 });
  const versionId = new URL(page.url()).searchParams.get("version")!;
  // Synthetic complete reference fixture through the real repository. The other test exercises manual authoring.
  const fields = practiceLessons.map((l: any, i: number) => ({
    stableFieldId: `practice-${l.id}`,
    fieldType: l.type,
    displayOrder: i,
    definition: {
      label: `${l.id} ${l.title[0]}`,
      confirmed: true,
      ...l.settings,
      fontSizePt: 10,
      optionMarks: l.marks ?? [],
      tableCellGuides: l.cells ?? [],
      detectionGroup: l.segments ?? [],
    },
    coordinate: {
      page: l.page,
      xMm: l.box.x,
      yMm: l.box.y,
      widthMm: l.box.width,
      heightMm: l.box.height,
    },
  }));
  await mutate(page, "formdigital.templates.saveDraftFields", {
    versionId,
    fields,
  });
  await page.reload();
  await expect(coach).toContainText("41 / 41");
  await coach.getByRole("combobox").selectOption("32"); // E01
  await page.getByTestId("mode-cell").click();
  await expect(
    page.locator(".field-overlay.is-active .mark-position-handle")
  ).toHaveCount(36);
  await page.getByTestId("group-next").click();
  await expect(
    page.locator(".field-overlay.is-active .mark-position-handle")
  ).toHaveCount(36);
  await expect(
    page.locator('.field-overlay.is-active [data-cell-index="71"]')
  ).toBeVisible();
  await expect(
    page.locator('.field-overlay.is-active [data-cell-index="71"]')
  ).toHaveAttribute("aria-label", "調整第 12 列第 6 格位置");
  await page.goto("/?view=settings");
  await page.getByLabel("介面語言").selectOption("en");
  await page.goto(`/?view=editor&version=${versionId}`);
  await expect(coach).toContainText("41 / 41");
  await expect(
    coach.getByRole("button", { name: "Go to practice location" })
  ).toBeVisible();
  await page.setViewportSize({ width: 375, height: 812 });
  const bounds = await coach.boundingBox();
  expect(bounds!.width).toBeLessThanOrEqual(375);
  await page.screenshot({
    path: info.outputPath("practice-mobile.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/?view=settings");
  await page.getByLabel("Interface language").selectOption("zh-Hant");
  await page.goto(`/?view=editor&version=${versionId}`);
  await expect(coach).toContainText("41 / 41");
  await page.getByRole("button", { name: "發佈", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "建立 Instance", exact: true })
  ).toBeVisible();
  const instance = await mutate(page, "formdigital.instances.create", {
    templateVersionId: versionId,
    name: "Practice synthetic filled record",
    values: {
      "practice-A01": "示範姓名",
      "practice-A03": "learner@example.com",
      "practice-A05": "FD-2026-001",
      "practice-B01": "C",
      "practice-D01": JSON.stringify([
        ["文具套裝", "2", "120", "", "20"],
        ["展示材料", "3", "50", "", "0"],
        ["資料印刷", "1", "80", "", "5"],
        ["練習卡紙", "4", "25", "", "0"],
        ["收納袋", "2", "35", "", "10"],
      ]),
      "practice-F01": JSON.stringify([
        ["10", "5"],
        ["10", "5"],
        ["10", "5"],
        ["10", "5"],
        ["10", "5"],
        ["3", "2"],
        ["9", ""],
        ["10", "5"],
        ["-1.5", "2.25"],
      ]),
    },
  });
  await page.goto(`/?view=fill&instance=${instance.instanceId ?? instance.id}`);
  const fillGuide = page.getByTestId("practice-fill-guide");
  await expect(fillGuide).toBeVisible();
  await fillGuide.getByRole("combobox").selectOption("2");
  await page.locator('.canvas-option-hotspot[title="F"]').click();
  for (const value of ["投影", "桌椅", "攝影", "桌椅"])
    await page.locator(`.canvas-option-hotspot[title="${value}"]`).click();
  await expect(page.locator(".canvas-option-hotspot svg ellipse")).toHaveCount(
    3
  );
  await expect(fillGuide).toContainText("✓ B01");
  await expect(fillGuide).toContainText("✓ B02");
  await fillGuide.getByRole("combobox").selectOption("4");
  await expect(fillGuide).toContainText("✓ 三個合計與樣例一致");
  await page.getByRole("button", { name: "儲存", exact: true }).first().click();
  await page.getByText("輸出", { exact: true }).click();
  const responsePromise = page.waitForResponse(
    r =>
      r.url().includes("/api/trpc/formdigital.exports.pdf") &&
      r.status() === 200
  );
  await page
    .getByRole("button", { name: "一般 PDF（連原表）", exact: true })
    .click();
  const url = findLocalAssetUrl(await (await responsePromise).json());
  expect(url).toBeTruthy();
  const bytes = await (await page.request.get(url!)).body();
  const doc = await PDFDocument.load(bytes);
  expect(doc.getPageCount()).toBe(8);
  await expect(page.getByTestId("confirm-output-reviewed")).toBeVisible();
  await page.goto(`/?view=editor&version=${versionId}`);
  await page.getByRole("button", { name: "建立新 Draft", exact: true }).click();
  const draftDialog = page.getByRole("dialog", { name: "建立新 Draft" });
  await expect(draftDialog).toBeVisible();
  await draftDialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(draftDialog).not.toBeVisible();
  await expect(page).toHaveURL(new RegExp(versionId));
  await page.getByRole("button", { name: "建立新 Draft", exact: true }).click();
  await draftDialog.getByRole("textbox").fill("UI regression draft");
  await draftDialog.getByRole("button", { name: "建立草稿", exact: true }).click();
  await expect(page).not.toHaveURL(new RegExp(versionId));
  await expect(page.getByTestId("practice-coach")).toContainText("41 / 41");
  await expect(page.getByRole("button", { name: "發佈", exact: true })).toBeVisible();
  await expect(page.getByText("UI regression draft", { exact: true })).toBeVisible();
});
