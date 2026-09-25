import { expect, type BrowserContext, type Page } from "@playwright/test";
import { SignJWT } from "jose";

export const E2E_WEB_PORT = Number(process.env.FORMDIGITAL_E2E_WEB_PORT ?? 3210);
export const E2E_LOCAL_SERVICE_PORT = Number(process.env.FORMDIGITAL_E2E_LOCAL_SERVICE_PORT ?? 43210);
export const E2E_BASE_URL = `http://127.0.0.1:${E2E_WEB_PORT}`;
export const E2E_JWT_SECRET =
  "TEST_ONLY_FORMDIGITAL_BROWSER_SECRET_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function findLocalAssetUrl(value: unknown): string | null {
  if (typeof value === "string")
    return value.includes("/api/local/assets/") ? value : null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findLocalAssetUrl(item);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const item of Object.values(value as Record<string, unknown>)) {
    const found = findLocalAssetUrl(item);
    if (found) return found;
  }
  return null;
}

export async function authenticateTestUser(
  context: BrowserContext,
  testId: string
) {
  const googleSubject = `TEST_BROWSER_${testId.replace(/[^a-z0-9_-]/gi, "_")}`;
  const token = await new SignJWT({
    provider: "google",
    name: "Synthetic Browser Tester",
    email: "browser-test@example.invalid",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(`google:${googleSubject}`)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(E2E_JWT_SECRET));

  await context.addCookies([
    {
      name: "fd_google_session",
      value: token,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
  ]);
}

export async function completeOnboarding(page: Page, options: { keepTour?: boolean } = {}) {
  await expect(page.getByRole("heading", { name: "Google 登入" })).toBeVisible();
  await page.getByRole("button", { name: "下一步" }).click();
  await expect(
    page.getByRole("heading", { name: "本機資料資料夾" })
  ).toBeVisible();
  await page.getByRole("button", { name: "確認資料夾" }).click();
  await expect(page.getByText("資料夾已確認")).toBeVisible();
  for (let step = 0; step < 6; step += 1)
    await page.getByRole("button", { name: "下一步" }).click();
  await page.getByRole("button", { name: "進入工作台" }).click();
  await expect(page.getByRole("heading", { name: "Google 登入" })).toBeHidden({ timeout: 20_000 });
  const view = new URL(page.url()).searchParams.get("view") || "dashboard";
  if (!options.keepTour && ["dashboard", "library"].includes(view)
      && await page.evaluate(() => localStorage.getItem("formdigital.workspace-tour.v1") !== "seen")) {
    const guide = page.locator("dialog.workspace-tour");
    await expect(guide).toBeVisible();
    await guide.getByRole("button", { name: "跳過教學" }).click();
    await expect(guide).toHaveCount(0);
  }
}
