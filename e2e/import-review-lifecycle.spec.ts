import { expect, test } from "@playwright/test";
import path from "node:path";
import { authenticateTestUser, completeOnboarding } from "./test-runtime";
import { nativeReviewPdf } from "./import-review-fixtures";

for (const shutdown of ["close", "unmount"] as const) test(`review ${shutdown}: real component, synchronous double start, exactly one rollback, preview cache released`, async ({ context, page }, info) => {
  await authenticateTestUser(context, `review-lifetime-${shutdown}-${info.project.name}-${Date.now()}`);
  await page.goto("/"); await completeOnboarding(page);
  const moduleUrl = `/@fs/${path.resolve("e2e/import-review-lifecycle.browser.tsx").replaceAll("\\", "/")}`;
  await page.evaluate(async url => {
    const module = await import(/* @vite-ignore */ url);
    (window as any).__reviewLifetime = module.mountReviewLifecycle();
  }, moduleUrl);
  let creates = 0, deletes = 0;
  page.on("request", req => {
    if (req.method() !== "POST") return;
    if (req.url().includes("templates.createDraft")) creates++;
    if (req.url().includes("templates.delete")) deletes++;
  });
  await page.locator('input[type="file"][accept*=".pdf"]').setInputFiles({ name: "lifetime.pdf", buffer: await nativeReviewPdf(), mimeType: "application/pdf" });
  await page.locator("#template-name").fill("Lifecycle synthetic");
  await page.getByRole("button", { name: "建立 Draft", exact: true }).evaluate((button: HTMLButtonElement) => {
    button.click(); button.click(); // One JS event loop, before React renders disabled state.
  });
  // Match the real import's bounded review wait (same as round3 start()).
  // OCR may still be processing page 3 after the default UI-only 5 seconds.
  await expect(page.getByTestId("import-review-panel")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("preview-image")).toBeVisible();
  expect(creates).toBe(1);
  await page.evaluate(mode => (window as any).__reviewLifetime[mode](), shutdown);
  await expect(page.getByTestId("import-review-panel")).toHaveCount(0);
  const list = async (procedure: string) => {
    const response = await page.request.get(`/api/trpc/formdigital.${procedure}?input=${encodeURIComponent(JSON.stringify({ json: null }))}`);
    expect(response.ok()).toBe(true); const body = await response.json(); return body.result.data.json ?? body.result.data;
  };
  await expect.poll(async () => (await list("templates.list")).length).toBe(0);
  await expect.poll(async () => (await list("assets.list")).length).toBe(0);
  expect(deletes).toBe(1);
  expect(await page.evaluate(() => (window as any).__reviewLifetime.created())).toBe(0);
  await expect.poll(() => page.evaluate(() => (window as any).__reviewLifetime.cachedPreviews())).toBe(0);
  await page.evaluate(() => { (window as any).__reviewLifetime.dispose(); delete (window as any).__reviewLifetime; });
});
