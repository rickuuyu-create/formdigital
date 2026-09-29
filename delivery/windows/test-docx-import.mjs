// Production-package regression: node --import tsx delivery/windows/test-docx-import.mjs <package> [chromium|firefox|webkit]
// Uses synthetic documents and isolated data; never bypasses the production CSP.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { threePageDocx } from "../../e2e/import-review-fixtures.ts";
import { zipSync, unzipSync, strToU8 } from "fflate";
import { chromium, firefox, webkit } from "@playwright/test";

const packageRoot = process.argv[2] && path.resolve(process.argv[2]);
if (!packageRoot) throw new Error("Package path required.");
const directRuntime = true;
const webPort = 32125;
const browserName = process.argv[3] || "chromium";
assert.ok(["chromium", "firefox", "webkit"].includes(browserName));
const testRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), "FormDigitalBrowserSmoke-")
);
const env = {
  ...process.env,
  FORMDIGITAL_LOCAL_CONFIG: path.join(testRoot, "config.json"),
  FORMDIGITAL_DATA_FOLDER: path.join(testRoot, "Data"),
  FORMDIGITAL_WEB_PORT: "32125",
  FORMDIGITAL_LDS_HEALTH_PORT: "43215",
  FORMDIGITAL_NO_BROWSER: "1",
  FORMDIGITAL_LOCAL_ONLY: "1",
};
const appRoot = path.join(packageRoot, "app");
const bundledNode = path.join(packageRoot, "runtime", "node.exe");
if (directRuntime) {
  const initialized = spawnSync(
    bundledNode,
    ["scripts/initialize-delivery.mjs"],
    {
      cwd: appRoot,
      env,
      windowsHide: true,
      stdio: "pipe",
    }
  );
  if (initialized.status !== 0)
    throw new Error("Isolated package initialization failed.");
}
const launcher = directRuntime
  ? spawn(bundledNode, ["scripts/start-production-runtime.mjs"], {
      cwd: appRoot,
      env,
      windowsHide: true,
      stdio: "ignore",
    })
  : spawn(path.join(packageRoot, "Form Digital.exe"), [], {
      env,
      windowsHide: true,
      stdio: "ignore",
    });
let browser;
try {
  const deadline = Date.now() + 30000;
  let healthy = false;
  while (Date.now() < deadline) {
    if (launcher.exitCode !== null) throw new Error("Launcher exited early.");
    try {
      const response = await fetch(
        `http://127.0.0.1:${webPort}/api/local/preflight`
      );
      if (response.ok && (await response.json()).status === "ok") {
        healthy = true;
        break;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!healthy) throw new Error("Packaged site did not become ready.");
  browser = await { chromium, firefox, webkit }[browserName].launch({
    headless: true,
  });
  const page = await browser.newPage();
  const external = [];
  const pageErrors = [];
  const violations = [];
  await page.exposeFunction("recordCspViolation", value =>
    violations.push(value)
  );
  page.on("console", m => {
    if (m.type() === "error") console.log("CONSOLE", m.text().slice(0, 1100));
  });
  page.on("requestfailed", r =>
    console.log("FAILED", r.url().slice(0, 180), r.failure())
  );
  await page.addInitScript(() =>
    document.addEventListener("securitypolicyviolation", e =>
      window.recordCspViolation({
        directive: e.violatedDirective,
        uri: e.blockedURI,
      })
    )
  );
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("request", request => {
    const hostname = new URL(request.url()).hostname;
    if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "")
      external.push(request.url());
  });
  await page.goto(`http://localhost:${webPort}/`, {
    waitUntil: "domcontentloaded",
  });
  await page
    .getByRole("heading", { name: "本機資料資料夾" })
    .waitFor({ timeout: 20000 });
  if (await page.getByRole("button", { name: /Google|登入/ }).count())
    throw new Error("A login button remains in the local edition.");
  await page.getByRole("button", { name: "確認資料夾" }).click();
  for (let step = 0; step < 6; step++)
    await page.getByRole("button", { name: "下一步" }).click();
  await page.getByRole("button", { name: "進入工作台" }).click();
  await page
    .getByRole("button", { name: "建立 Template" })
    .waitFor({ timeout: 20000 });

  const tour = page.locator("dialog.workspace-tour");
  await tour.waitFor({ state: "visible" });
  await tour.getByRole("button", { name: "跳過教學" }).click();
  const original = threePageDocx();
  const plain = unzipSync(original);
  plain["word/document.xml"] = strToU8(
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DOCX SYNTHETIC FORM</w:t></w:r></w:p><w:tbl><w:tblPr><w:tblW w:w="8000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>Name</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>TEST VALUE</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr></w:body></w:document>'
  );
  delete plain["word/_rels/document.xml.rels"];
  delete plain["word/media/receipt.png"];
  const results = [];
  for (const [label, buffer, ocr] of [
    ["plain-table-no-ocr", Buffer.from(zipSync(plain)), false],
    ["three-pages-image-no-ocr", original, false],
    ["plain-table-ocr", Buffer.from(zipSync(plain)), true],
    ["three-pages-image-ocr", original, true],
  ]) {
    await fs.writeFile(path.join(testRoot, label + ".docx"), buffer);
    await page.getByRole("button", { name: "建立 Template" }).first().click();
    await page
      .locator('input[type="file"][accept*=".pdf"]')
      .setInputFiles({
        name: label + ".docx",
        buffer,
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      });
    await page.locator("#template-name").fill(label);
    await page.getByLabel("建立未確認欄位候選").setChecked(ocr);
    await page.getByLabel("自動裁邊", { exact: true }).uncheck();
    await page.getByRole("button", { name: "建立 Draft" }).click();
    const review = page.getByTestId("import-review-panel");
    const failure = page.getByText(
      "Template 建立失敗，請檢查來源檔案後再試。",
      { exact: true }
    );
    await review.or(failure).waitFor({ timeout: 90000 });
    const result = (await review.isVisible()) ? "REVIEW" : "FAILED";
    console.log("RESULT", label, result);
    results.push({ label, result });
    await page.screenshot({
      path: path.join(testRoot, label + ".png"),
      fullPage: true,
    });
    assert.equal(result, "REVIEW", label + " must reach import review");
    if (result === "REVIEW") {
      await page.getByTestId("import-pages-only-btn").click();
      await page.waitForURL(/version=ver_/);
      const versionId = new URL(page.url()).searchParams.get("version");
      const res = await page.request.get(
        "http://localhost:" +
          webPort +
          "/api/trpc/formdigital.templates.getVersionDetails?input=" +
          encodeURIComponent(JSON.stringify({ json: { versionId } }))
      );
      const body = await res.json();
      const details = body.result.data.json ?? body.result.data;
      results[results.length - 1].savedPages =
        details.version.pageManifest.length;
      assert.equal(
        details.version.pageManifest.length,
        label.startsWith("three-pages") ? 3 : 1
      );
      if (label.startsWith("three-pages")) {
        const last = details.version.pageManifest[2];
        const a = await page.request.get(
          "http://localhost:" +
            webPort +
            "/api/trpc/formdigital.assets.getUrl?input=" +
            encodeURIComponent(
              JSON.stringify({ json: { assetId: last.assetId } })
            )
        );
        const ab = await a.json();
        const asset = ab.result.data.json ?? ab.result.data;
        const pixels = await page.evaluate(async url => {
          const bitmap = await createImageBitmap(
            await (await fetch(url)).blob()
          );
          const c = document.createElement("canvas");
          c.width = bitmap.width;
          c.height = bitmap.height;
          const ctx = c.getContext("2d");
          ctx.drawImage(bitmap, 0, 0);
          const data = ctx.getImageData(0, 0, c.width, c.height).data;
          let red = 0;
          for (let i = 0; i < data.length; i += 4)
            if (data[i] > 180 && data[i + 1] < 80 && data[i + 2] < 100) red++;
          return { width: c.width, height: c.height, red };
        }, asset.url);
        if (pixels.red < 1000) throw new Error("Embedded image lost");
        results[results.length - 1].image = pixels;
        const png = await page.request.get(
          new URL(asset.url, "http://localhost:" + webPort).href
        );
        await fs.writeFile(
          path.join(testRoot, label + "-saved-page3.png"),
          await png.body()
        );
      }
    } else {
      await page.getByRole("button", { name: "關閉", exact: true }).click();
    }
    await page.goto("http://localhost:" + webPort + "/", {
      waitUntil: "domcontentloaded",
    });
  }
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(violations, [], "Import must not violate the shipped CSP");
  assert.deepEqual(external, []);
  // The production response must still deny Internet connections, even though
  // browser-created blob URLs can now be read by the image converter.
  const blocked = await page.evaluate(async () => {
    try {
      await fetch("https://formdigital-csp-test.invalid/");
      return false;
    } catch {
      return true;
    }
  });
  assert.equal(blocked, true);
  await page.waitForFunction(() => true);
  assert.ok(
    violations.some(
      v =>
        v.directive === "connect-src" &&
        v.uri.includes("formdigital-csp-test.invalid")
    )
  );
  await fs.writeFile(
    path.join(testRoot, "results.json"),
    JSON.stringify(
      { browserName, results, pageErrors, external, violations },
      null,
      2
    )
  );
  console.log(JSON.stringify(results));
} finally {
  if (browser) await browser.close();
  if (launcher.exitCode === null) {
    if (directRuntime) {
      const stopped = spawnSync(
        "taskkill",
        ["/PID", String(launcher.pid), "/T", "/F"],
        {
          windowsHide: true,
          stdio: "pipe",
        }
      );
      if (stopped.status !== 0)
        throw new Error("Isolated runtime cleanup failed.");
    } else launcher.kill();
    if (launcher.exitCode === null)
      await new Promise(resolve => launcher.once("exit", resolve));
  }
  console.log(`Isolated browser data: ${testRoot}`);
}
