import { expect, test } from "@playwright/test";
import { authenticateTestUser, completeOnboarding } from "./test-runtime";

test.describe("Formdigital browser workbench", () => {
  test("shows the Google sign-in gate while the local service is healthy", async ({
    page,
  }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });

    await expect(page).toHaveTitle(/表格數碼化/);
    await expect(page.getByText("本機資料服務已連線")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "使用 Google 登入" })
    ).toBeVisible();
    await expect(page.getByText("工作總覽", { exact: true })).toHaveCount(0);
  });

  test("loads the authenticated dashboard and its primary navigation", async ({
    context,
    page,
  }, testInfo) => {
    await authenticateTestUser(
      context,
      `${testInfo.project.name}-dashboard-navigation`
    );
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await completeOnboarding(page);

    await expect(
      page.getByRole("heading", { name: /從紙本或 Office 文件/ })
    ).toBeVisible();
    await expect(page.getByText("localhost 已連線")).toBeVisible();

  await page.getByRole("button", { name: /範本庫|Template Library/ }).first().click();
    await expect(page.getByText("TEMPLATE LIBRARY", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "已填表格" }).click();
    await expect(page.getByText("INSTANCES", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "CSV 批量匯入" }).click();
    await expect(page.getByText("CSV BATCH CENTER", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "列印校準" }).click();
    await expect(page.getByText("PRINT CALIBRATION", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "設定與備份" }).click();
    await expect(page.getByText("SETTINGS", { exact: true })).toBeVisible();
  });

  test("switches and persists the supported interface locale", async ({
    context,
    page,
  }, testInfo) => {
    await authenticateTestUser(
      context,
      `${testInfo.project.name}-interface-locale`
    );
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await completeOnboarding(page);
    await expect(
      page.getByRole("heading", {
        name: /從紙本或 Office 文件/,
      })
    ).toBeVisible();
    await page.goto("/?view=settings");

    await page.getByLabel("介面語言").selectOption("en");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByRole("button", { name: "Dashboard" })).toBeVisible();
    await expect(
      page.getByText("Language and theme", { exact: true })
    ).toBeVisible();
    await page.getByRole("button", { name: "Dashboard" }).click();
    await expect(
      page.getByRole("heading", {
        name: "Create reusable digital forms from paper or Office documents.",
      })
    ).toBeVisible();
    await page
      .getByRole("button", { name: /範本庫|Template Library/ })
      .first()
      .click();
    await expect(
      page.getByRole("heading", {
        name: "Templates, versions, and categories",
      })
    ).toBeVisible();
    await page.getByRole("button", { name: "Settings and backup" }).click();
    await page.reload();
    await expect(page.getByRole("button", { name: "Dashboard" })).toBeVisible();

    await page.getByLabel("Interface language").selectOption("zh-Hans");
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hans");
    await expect(page.getByRole("button", { name: "工作总览" })).toBeVisible();
  });
});
