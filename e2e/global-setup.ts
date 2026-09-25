import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FullConfig } from "@playwright/test";
import {
  E2E_BASE_URL,
  E2E_JWT_SECRET,
  E2E_LOCAL_SERVICE_PORT,
  E2E_WEB_PORT,
} from "./test-runtime";
import {
  PROCESS_CLEANUP_FAILED,
  terminateAll,
  type TerminateOutcome,
} from "./process-cleanup";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

/**
 * 分階段診斷（測試可靠性修正／Task B）：
 * 只在設定了 `FORMDIGITAL_GLOBAL_SETUP_DIAG`（指向本機 TEMP 檔案路徑）時寫入
 * 極少量、無敏感內容的階段標記（phase + PID）。不記錄 env／token／路徑／資料。
 */
const diagPath = process.env.FORMDIGITAL_GLOBAL_SETUP_DIAG;
function diag(marker: string): void {
  if (!diagPath) return;
  try {
    appendFileSync(diagPath, `${Date.now()} ${marker}\n`, "utf8");
  } catch {
    // 診斷寫入失敗不得影響測試本身。
  }
}

/** 固定、value-free 的清理失敗錯誤（只帶 label）。 */
function cleanupError(outcome: TerminateOutcome): Error {
  return new Error(
    `${PROCESS_CLEANUP_FAILED}:${outcome.failed.map(item => item.label).join(",")}`
  );
}

async function waitFor(url: string, child: ChildProcess, label: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`${label} stopped before becoming ready.`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`${label} did not become ready in time.`);
}

export default async function globalSetup(_config: FullConfig) {
  diag("setup:start");
  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "formdigital-browser-e2e-")
  );
  const dataFolder = path.join(temporaryRoot, "data");
  const configPath = path.join(temporaryRoot, "local-service-config.json");
  await fs.mkdir(dataFolder, { recursive: true });
  await fs.writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: 1,
      port: E2E_LOCAL_SERVICE_PORT,
      dataFolder,
      token: randomBytes(32).toString("hex"),
      allowedOrigins: [
        E2E_BASE_URL,
        `http://localhost:${E2E_WEB_PORT}`,
      ],
    }),
    { flag: "wx" }
  );

  let localService: ChildProcess | undefined;
  let web: ChildProcess | undefined;
  try {
    localService = spawn(process.execPath, ["local-data-service.mjs"], {
      cwd: projectRoot,
      env: {
        ...process.env,
        FORMDIGITAL_LOCAL_CONFIG: configPath,
      },
      stdio: "ignore",
      windowsHide: true,
    });
    await waitFor(
      `http://127.0.0.1:${E2E_LOCAL_SERVICE_PORT}/health`,
      localService,
      "Synthetic Local Data Service"
    );
    diag(`setup:local-service:ready:pid=${localService.pid}`);

    web = spawn(
      process.execPath,
      [
        path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs"),
        "server/_core/index.ts",
      ],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          NODE_ENV: "development",
          PORT: String(E2E_WEB_PORT),
          FORMDIGITAL_LOCAL_CONFIG: configPath,
          JWT_SECRET: E2E_JWT_SECRET,
          GOOGLE_OAUTH_CLIENT_ID: "TEST_BROWSER_CLIENT_ID",
          GOOGLE_OAUTH_CLIENT_SECRET: "TEST_BROWSER_CLIENT_SECRET",
          GOOGLE_OAUTH_REDIRECT_URI: `${E2E_BASE_URL}/api/auth/google/callback`,
          FORMDIGITAL_GOOGLE_OAUTH_ALLOWED_ORIGINS: [
            E2E_BASE_URL,
            `http://localhost:${E2E_WEB_PORT}`,
          ].join(","),
        },
        stdio: "ignore",
        windowsHide: true,
      }
    );
    await waitFor(
      `${E2E_BASE_URL}/api/local/preflight`,
      web,
      "Synthetic Web runtime"
    );
    diag(`setup:web:ready:pid=${web.pid}`);
  } catch (error) {
    diag("setup:failed");
    // 一項失敗也要清理另一項；只有在兩個自有服務都確認退出後才可刪合成資料。
    const outcome = await terminateAll(
      [
        { child: web, label: "web" },
        { child: localService, label: "local-service" },
      ],
      diag
    );
    if (!outcome.verified) {
      diag(`setup:cleanup:NOT-VERIFIED:keep-directory:${outcome.failed.length}`);
      throw cleanupError(outcome);
    }
    try {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
      diag("setup:rm:done");
    } catch {
      diag("setup:rm:failed");
      throw new AggregateError([error, new Error("SYNTHETIC_DIRECTORY_CLEANUP_FAILED")], "E2E_SETUP_AND_CLEANUP_FAILED");
    }
    throw error;
  }

  return async () => {
    diag("teardown:start");
    // 先確認「寫入」的 web 服務退出，再停 local-data-service，最後清資料目錄。
    // 兩者都必須確認退出；任何一項沒確認就保留目錄並令本次執行失敗。
    const outcome = await terminateAll(
      [
        { child: web, label: "web" },
        { child: localService, label: "local-service" },
      ],
      diag
    );
    if (!outcome.verified) {
      diag(`teardown:cleanup:NOT-VERIFIED:keep-directory:${outcome.failed.length}`);
      throw cleanupError(outcome);
    }
    const resolvedTemporaryRoot = path.resolve(temporaryRoot);
    const expectedPrefix = path.resolve(os.tmpdir(), "formdigital-browser-e2e-");
    if (!resolvedTemporaryRoot.startsWith(expectedPrefix))
      throw new Error("Refusing to remove an unexpected browser test directory.");
    // 清理失敗會拋出（不偽裝成功）；force 只忽略 ENOENT。
    await fs.rm(resolvedTemporaryRoot, { recursive: true, force: true });
    diag("teardown:rm:done");
  };
}
