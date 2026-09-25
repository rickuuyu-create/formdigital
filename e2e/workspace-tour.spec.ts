import { expect, test, type Page } from "@playwright/test";
import { authenticateTestUser, completeOnboarding } from "./test-runtime";

const guide = (page: Page) => page.locator("dialog.workspace-tour");

async function checkCard(page: Page, target?: string) {
  await expect(page.locator(".tour-card")).toBeVisible();
  await expect
    .poll(async () =>
      page.locator(".tour-card").evaluate(card => {
        const box = card.getBoundingClientRect();
        return (
          box.left >= 0 &&
          box.top >= 0 &&
          box.right <= window.innerWidth + 1 &&
          box.bottom <= window.innerHeight + 1
        );
      })
    )
    .toBe(true);
  if (target) {
    await expect
      .poll(async () =>
        page.evaluate(selector => {
          const node = document.querySelector(selector)!;
          const spot = document.querySelector<HTMLElement>(".tour-spotlight")!;
          if (!node || spot.hidden) return false;
          const rect = node.getBoundingClientRect();
          const x = parseFloat(spot.style.left),
            y = parseFloat(spot.style.top);
          const w = parseFloat(spot.style.width),
            h = parseFloat(spot.style.height);
          return (
            w > 0 &&
            h > 0 &&
            x <= rect.left + 2 &&
            y <= rect.top + 2 &&
            x + w >= Math.min(rect.right, window.innerWidth - 4) - 2 &&
            y + h >= Math.min(rect.bottom, window.innerHeight - 4) - 2
          );
        }, target)
      )
      .toBe(true);
    await expect(page.locator(".tour-fallback")).toHaveCount(0);
    await expect
      .poll(async () =>
        page.evaluate(selector => {
          const a = document.querySelector(selector)!.getBoundingClientRect();
          const b = document
            .querySelector(".tour-card")!
            .getBoundingClientRect();
          return (
            a.right <= b.left ||
            b.right <= a.left ||
            a.bottom <= b.top ||
            b.bottom <= a.top
          );
        }, target)
      )
      .toBe(true);
  }
}

for (const mobile of [false, true]) {
  test(`first-use tour: ${mobile ? "375px" : "desktop"}, empty workspace, every spotlight, input blocking and completion`, async ({
    page,
    context,
  }, info) => {
    await page.setViewportSize(
      mobile ? { width: 375, height: 812 } : { width: 1440, height: 1000 }
    );
    await authenticateTestUser(context, `${info.project.name}-tour-${mobile}`);
    await page.goto("/");
    // Onboarding can hide before its final preferences request is dispatched.
    // Start the tour's read-only observation only after that existing write settles.
    const onboardingSaved = page.waitForResponse(response =>
      response.url().includes('/api/trpc/formdigital.preferences') &&
      response.request().method() === 'POST' &&
      (response.request().postData() ?? '').includes('onboardingCompleted') &&
      response.status() === 200
    );
    await completeOnboarding(page, { keepTour: true });
    await onboardingSaved;
    const writes: string[] = [];
    page.on("request", request => {
      if (request.method() === "POST")
        writes.push(new URL(request.url()).pathname);
    });
    await expect(guide(page)).toHaveAttribute("data-step", "1");
    await expect(
      guide(page).getByRole("button", { name: "上一步" })
    ).toBeDisabled();
    await checkCard(page);
    await page.keyboard.press("ArrowRight");
    await expect(guide(page)).toHaveAttribute("data-step", "2");
    const importSelector = mobile
      ? '[data-tour="dashboard-import"]'
      : '[data-tour="create-template"]';
    await checkCard(page, importSelector);
    await page.setViewportSize(
      mobile ? { width: 375, height: 667 } : { width: 1000, height: 800 }
    );
    await checkCard(page, importSelector);
    await page.setViewportSize(
      mobile ? { width: 375, height: 812 } : { width: 1440, height: 1000 }
    );
    await checkCard(page, importSelector);
    // Click the real control through the clear spotlight hole: it must remain inert.
    const targetBox = await page.locator(importSelector).boundingBox();
    await page.mouse.click(
      targetBox!.x + targetBox!.width / 2,
      targetBox!.y + targetBox!.height / 2
    );
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(guide(page)).toHaveAttribute("data-step", "2");
    await page.keyboard.press("ArrowLeft");
    await expect(guide(page)).toHaveAttribute("data-step", "1");
    await page.keyboard.press("ArrowRight");
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Tab");
      expect(
        await page.evaluate(() =>
          Boolean(document.activeElement?.closest("dialog.workspace-tour"))
        )
      ).toBe(true);
    }
    const destinations = [
      ["library", '[data-tour-page="library"] h2'],
      [
        "library",
        mobile ? '[data-tour="workspace-menu"]' : '[data-tour="nav-editor"]',
      ],
      [
        "library",
        mobile ? '[data-tour="workspace-menu"]' : '[data-tour="nav-fill"]',
      ],
      ["instances", '[data-tour-page="instances"] h2'],
      ["batch", '[data-tour-page="batch"] select'],
      ["calibrate", '[data-tour-page="calibrate"] h2'],
      ["settings", '[data-tour="backup-create"]'],
      ["settings", '[data-tour="tour-settings"]'],
    ];
    for (const [i, [view, selector]] of destinations.entries()) {
      await guide(page).getByRole("button", { name: "下一步" }).click();
      await expect(guide(page)).toHaveAttribute("data-step", String(i + 3));
      await expect(page).toHaveURL(new RegExp(`view=${view}`));
      await checkCard(page, selector);
      if (i === 0 || i === 7)
        await page.screenshot({
          path: info.outputPath(
            `tour-${mobile ? "mobile" : "desktop"}-${view}.png`
          ),
        });
    }
    await guide(page).getByRole("button", { name: "下一步" }).click();
    await expect(guide(page)).toHaveAttribute("data-step", "11");
    await checkCard(page);
    await guide(page).getByRole("button", { name: "下一步" }).click();
    await expect(guide(page)).toHaveAttribute("data-step", "12");
    await expect(guide(page)).toContainText("開始新的範本實習");
    await checkCard(page, '[data-tour="practice-start"]');
    await guide(page)
      .getByRole("button", { name: "完成", exact: true })
      .click();
    await expect(
      page.locator(".workspace-tour,.tour-spotlight,.tour-card")
    ).toHaveCount(0);
    await expect(page.locator('[data-tour="practice-start"]')).toBeFocused();
    expect(
      await page.evaluate(() =>
        localStorage.getItem("formdigital.workspace-tour.v1")
      )
    ).toBe("seen");
    expect(writes).toEqual([]);
    await page.reload();
    if (mobile)
      await expect(
        page.getByRole("heading", { name: "拍攝或匯入表格" })
      ).toBeVisible();
    else await expect(page.getByText("localhost 已連線")).toBeVisible();
    await expect(guide(page)).toHaveCount(0);
  });
}

test("replay, Escape, next-visit reset and all three languages", async ({
  page,
  context,
}, info) => {
  await authenticateTestUser(context, `${info.project.name}-tour-replay`);
  await page.goto("/");
  await completeOnboarding(page);
  await page.goto("/?view=settings");
  await page.getByRole("button", { name: "重新播放教學" }).click();
  await expect(guide(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(guide(page)).toHaveCount(0);
  await expect(page).toHaveURL(/view=settings/);
  await expect(
    page.getByRole("button", { name: "重新播放教學" })
  ).toBeFocused();
  await page.getByRole("button", { name: "下次進入時自動播放" }).click();
  await page.locator('[data-tour="nav-dashboard"]').click();
  await expect(guide(page)).toHaveCount(0); // Reset is for the next visit, not the current SPA navigation.
  await page.reload();
  await expect(guide(page)).toBeVisible();
  await guide(page).getByRole("button", { name: "跳過教學" }).click();
  for (const [locale, label, replay, skip] of [
    ["en", "介面語言", "Replay tour", "Skip tour"],
    ["zh-Hans", "Interface language", "重新播放教学", "跳过教学"],
  ]) {
    await page.goto("/?view=settings");
    await page.getByLabel(label).selectOption(locale);
    await page.getByRole("button", { name: replay }).click();
    await expect(guide(page).getByRole("button", { name: skip })).toBeVisible();
    if (locale === "en")
      expect(await guide(page).innerText()).not.toMatch(/[\u4e00-\u9fff]/);
    await guide(page).getByRole("button", { name: skip }).click();
  }
});

test("an editor route is not interrupted; unavailable storage fails quietly", async ({
  page,
  context,
}, info) => {
  await authenticateTestUser(context, `${info.project.name}-tour-no-interrupt`);
  await page.goto("/");
  await completeOnboarding(page);
  await page.evaluate(() =>
    localStorage.removeItem("formdigital.workspace-tour.v1")
  );
  await page.goto("/?view=editor");
  await expect(page.getByText("localhost 已連線")).toBeVisible();
  await expect(guide(page)).toHaveCount(0);
  await page.addInitScript(() => {
    const get = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) {
      if (key === "formdigital.workspace-tour.v1")
        throw new DOMException("blocked", "SecurityError");
      return get.call(this, key);
    };
  });
  await page.goto("/");
  await expect(page.getByText("localhost 已連線")).toBeVisible();
  await expect(guide(page)).toHaveCount(0);
});
