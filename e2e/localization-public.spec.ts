import { expect, test } from "@playwright/test";
import { authenticateTestUser, completeOnboarding } from "./test-runtime";

test("core setup and import controls switch between traditional, simplified and English", async ({ page, context }, info) => {
  await authenticateTestUser(context, `${info.project.name}-public-locale`);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Google 登入" })).toBeVisible();
  await page.getByLabel("介面語言").selectOption("en");
  await expect(page.getByRole("heading", { name: "Google sign-in" })).toBeVisible();
  await page.getByLabel("Interface language").selectOption("zh-Hans");
  await expect(page.getByRole("heading", { name: "Google 登录" })).toBeVisible();
  await page.getByLabel("界面语言").selectOption("zh-Hant");
  await completeOnboarding(page);

  await page.goto("/?view=settings");
  await expect(page.getByRole("heading", { name: "本機資料、安全及偏好" })).toBeVisible();
  await page.getByLabel("介面語言").selectOption("en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { name: "Local data, security and preferences" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create portable backup" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Move and verify" })).toBeVisible();

  await page.goto("/");
  await page.locator('[data-tour="create-template"]').click();
  await expect(page.getByRole("dialog", { name: "Choose source files" })).toBeVisible();
  await expect(page.getByText("Page preprocessing", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Close" })).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();

  await page.goto("/?view=settings");
  await page.getByLabel("Interface language").selectOption("zh-Hans");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hans");
  await expect(page.getByRole("heading", { name: "本地数据、安全及偏好" })).toBeVisible();
  await expect(page.getByRole("button", { name: "创建便携备份" })).toBeVisible();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hans");
});
