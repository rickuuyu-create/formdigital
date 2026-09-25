import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const packageRoot = process.argv[2];
if (!packageRoot) throw new Error("Package path required.");
const defaultPorts = process.argv[3] === "--default-ports";
const directRuntime = process.argv.includes("--direct-runtime");
const webPort = defaultPorts ? 3210 : 32125;
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "FormDigitalBrowserSmoke-"));
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const env = {
  ...process.env,
  FORMDIGITAL_LOCAL_CONFIG: path.join(testRoot, "config.json"),
  FORMDIGITAL_DATA_FOLDER: path.join(testRoot, "Data"),
  ...(defaultPorts ? {} : {
    FORMDIGITAL_WEB_PORT: "32125",
    FORMDIGITAL_LDS_HEALTH_PORT: "43215",
  }),
  FORMDIGITAL_NO_BROWSER: "1",
  FORMDIGITAL_LOCAL_ONLY: "1",
};
const appRoot = path.join(packageRoot, "app");
const bundledNode = path.join(packageRoot, "runtime", "node.exe");
if (directRuntime) {
  const initialized = spawnSync(bundledNode, ["scripts/initialize-delivery.mjs"], {
    cwd: appRoot, env, windowsHide: true, stdio: "pipe",
  });
  if (initialized.status !== 0) throw new Error("Isolated package initialization failed.");
}
const launcher = directRuntime
  ? spawn(bundledNode, ["scripts/start-production-runtime.mjs"], {
      cwd: appRoot, env, windowsHide: true, stdio: "ignore",
    })
  : spawn(path.join(packageRoot, "Form Digital.exe"), [], {
      env, windowsHide: true, stdio: "ignore",
    });
let browser;
try {
  const deadline = Date.now() + 30000;
  let healthy = false;
  while (Date.now() < deadline) {
    if (launcher.exitCode !== null) throw new Error("Launcher exited early.");
    try {
      const response = await fetch(`http://127.0.0.1:${webPort}/api/local/preflight`);
      if (response.ok && (await response.json()).status === "ok") { healthy = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!healthy) throw new Error("Packaged site did not become ready.");
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const external = [];
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("request", request => {
    const hostname = new URL(request.url()).hostname;
    if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "")
      external.push(request.url());
  });
  await page.goto(`http://localhost:${webPort}/`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "本機資料資料夾" }).waitFor({ timeout: 20000 });
  if (await page.getByRole("button", { name: /Google|登入/ }).count())
    throw new Error("A login button remains in the local edition.");
  await page.getByRole("button", { name: "確認資料夾" }).click();
  for (let step = 0; step < 6; step++)
    await page.getByRole("button", { name: "下一步" }).click();
  await page.getByRole("button", { name: "進入工作台" }).click();
  await page.getByRole("button", { name: "建立 Template" }).waitFor({ timeout: 20000 });
  await page.goto(`http://localhost:${webPort}/?view=settings`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: /本機資料、安全及偏好/ }).waitFor({ timeout: 20000 });
  if (await page.getByRole("button", { name: "登出" }).count())
    throw new Error("A sign-out button remains in the local edition.");
  const language = page.locator("#interface-locale");
  for (const [locale, heading] of [
    ["en", "Local data, security and preferences"],
    ["zh-Hans", "本地数据、安全及偏好"],
    ["zh-Hant", "本機資料、安全及偏好"],
  ]) {
    const saved = page.waitForResponse(response =>
      response.url().includes("/api/trpc/formdigital.preferences") &&
      response.request().method() === "POST" && response.ok()
    );
    await language.selectOption(locale);
    await page.getByRole("heading", { name: heading }).waitFor();
    await saved;
  }
  await page.goto(`http://localhost:${webPort}/`, { waitUntil: "domcontentloaded" });
  const guide = page.locator("dialog.workspace-tour");
  await guide.waitFor({ state: "visible", timeout: 10000 });
  for (let step = 1; step < 12; step++) {
    await guide.getByRole("button", { name: "下一步" }).click();
    await page.locator(`dialog.workspace-tour[data-step="${step + 1}"]`).waitFor();
  }
  await page.locator('[data-tour="practice-start"]').waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-tour="practice-start"]');
    const spot = document.querySelector('.tour-spotlight');
    if (!button || !spot || spot.hidden) return false;
    const b = button.getBoundingClientRect();
    const s = spot.getBoundingClientRect();
    return s.left <= b.left && s.top <= b.top && s.right >= b.right && s.bottom >= b.bottom;
  });
  await guide.getByRole("button", { name: "完成" }).click();
  await page.locator('[data-tour="practice-start"]:focus').waitFor();
  await page.locator('[data-tour="practice-start"]').click();
  await page.getByRole("dialog", { name: "選擇原始來源" }).waitFor();
  await page.getByText("實習會建立一份獨立草稿", { exact: false }).waitFor();
  await page.getByRole("button", { name: "關閉" }).click();
  await page.getByRole("button", { name: "建立 Template" }).first().click();
  await page.locator('input[type="file"][accept*=".pdf"]').setInputFiles(path.join(projectRoot, "ocr-fixture.png"));
  await page.locator("#template-name").fill("Offline package smoke form");
  await page.getByLabel("建立未確認欄位候選").uncheck();
  await page.getByRole("button", { name: "建立 Draft" }).click();
  await page.getByTestId("import-review-panel").waitFor({ timeout: 90000 });
  await page.getByTestId("import-pages-only-btn").click();
  await page.getByRole("button", { name: "快速新增" }).click();
  await page.getByLabel("欄位名稱").fill("Offline name");
  await page.getByRole("button", { name: "確認此欄位" }).click();
  await page.getByRole("button", { name: /儲存|Save/ }).click();
  await page.getByText("Draft 已保存至 localhost Workspace", { exact: true }).waitFor();
  await page.getByRole("button", { name: "發佈" }).click();
  await page.getByText("Template Version 已發佈及鎖定", { exact: true }).waitFor();
  await page.getByRole("button", { name: "建立 Instance" }).click();
  await page.getByRole("textbox", { name: "Offline name 單行文字" }).fill("TEST_OFFLINE_VALUE");
  await page.getByRole("button", { name: "建立 Instance" }).click();
  await page.getByText("Instance 已建立並綁定目前 Version").waitFor();
  await page.getByText("輸出", { exact: true }).click();
  const [pdfResult] = await Promise.all([
    page.waitForResponse(response => response.url().includes("/api/trpc/formdigital.exports.pdf") && response.ok()),
    page.getByRole("button", { name: /一般 PDF（連原表）|Flattened PDF/ }).click(),
  ]);
  const pdfData = JSON.stringify(await pdfResult.json());
  const assetUrl = pdfData.match(/\/api\/local\/assets\/asset-[\w-]+/)?.[0];
  if (!assetUrl) throw new Error("PDF export did not return a local asset.");
  const pdfResponse = await page.request.get(`http://localhost:${webPort}${assetUrl}`);
  if (!pdfResponse.ok() || (await pdfResponse.body()).subarray(0, 4).toString("ascii") !== "%PDF")
    throw new Error("Packaged PDF cannot be read.");
  if (external.length) throw new Error(`External browser requests: ${external.length}`);
  if (pageErrors.length) throw new Error(`Browser errors: ${pageErrors.join("; ")}`);
  console.log("PASS: no-login onboarding, local workspace, form creation, save, publish, fill, PDF export, no external browser requests");
} finally {
  if (browser) await browser.close();
  if (launcher.exitCode === null) {
    if (directRuntime) {
      const stopped = spawnSync("taskkill", ["/PID", String(launcher.pid), "/T", "/F"], {
        windowsHide: true, stdio: "pipe",
      });
      if (stopped.status !== 0) throw new Error("Isolated runtime cleanup failed.");
    } else launcher.kill();
    await new Promise(resolve => launcher.once("exit", resolve));
  }
  console.log(`Isolated browser data: ${testRoot}`);
}
