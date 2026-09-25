// scripts/start-dev-runtime.mjs
//
// Windows / cross-platform one-click local runtime launcher for Formdigital
// (WB-01: Windows 本機 runtime 一鍵啟動與 503 可行動提示).
//
// What it does (and only this):
//   1. Resolves the project root from THIS file's own directory so it works
//      regardless of the caller's current working directory.
//   2. Refuses to start when the Local Data Service config is missing — it
//      does NOT read the config content and does NOT auto-create a Data Folder.
//   3. Starts the Local Data Service, then polls its loopback /health with a
//      bounded timeout. If it is already healthy on the expected port we
//      reuse the existing instance instead of spawning a second one.
//   4. Only after the Local Data Service is healthy does it start the Web
//      service, then verifies `/`, `/src/main.tsx` and `/api/local/preflight`
//      (must be `ok`) before announcing ready.
//   5. Fails closed (non-zero exit, fixed actionable message, no secrets) on
//      config missing, Local Data Service failure / wrong occupant / timeout,
//      or Web failure / preflight not ok / timeout.
//   6. On any failure it tears down only the child processes it spawned; it
//      never kills a service that was already running beforehand.
//
// Secrets: this launcher NEVER reads local-service-config.json content, and
// never prints the token, Data Folder path, raw exception or command line.
//
// Test / override knobs (all optional):
//   FORMDIGITAL_LAUNCHER_VERIFY_ONLY=1   exit 0 right after readiness, after
//                                        tearing down spawned children.
//   FORMDIGITAL_LDS_HEALTH_PORT          loopback port to probe the Local Data
//                                        Service (default 4317). Never read
//                                        from the config file.
//   FORMDIGITAL_WEB_PORT                 Web port (default 3000).
//   FORMDIGITAL_LOCAL_CONFIG             path forwarded to children; never read
//                                        by this launcher.
//   FORMDIGITAL_LAUNCHER_LDS_TIMEOUT_MS / _WEB_TIMEOUT_MS   override timeouts.

import { spawn } from "node:child_process";
import { openSync, mkdirSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

/**
 * A log file for a child process this launcher spawns.
 *
 * Both children used to run with every stream discarded, so when one of them
 * failed at runtime the browser showed a deliberately detail-free message and
 * there was nowhere at all to look for the real cause. The streams are kept on
 * disk instead; the directory is already ignored by git.
 */
function childLog(name) {
  try {
    mkdirSync(path.join(PROJECT_ROOT, "logs"), { recursive: true });
    return openSync(path.join(PROJECT_ROOT, "logs", `${name}.log`), "a");
  } catch {
    return "ignore";
  }
}

export function sanitizeChildEnv(rawEnv = process.env) {
  const sanitized = {};
  for (const [key, val] of Object.entries(rawEnv)) {
    if (
      key === "FORMDIGITAL_ENABLE_TEST_HOOKS" ||
      key.startsWith("FORMDIGITAL_TEST_")
    ) {
      continue;
    }
    sanitized[key] = val;
  }
  return sanitized;
}

// Resolve from this file only. The launcher must not trust the caller's cwd or
// an environment override when deciding which project scripts to execute.
const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const CONFIG_PATH = process.env.FORMDIGITAL_LOCAL_CONFIG
  ? path.resolve(process.env.FORMDIGITAL_LOCAL_CONFIG)
  : path.join(PROJECT_ROOT, "local-service-config.json");

const LDS_HEALTH_PORT = Number.parseInt(
  process.env.FORMDIGITAL_LDS_HEALTH_PORT || "4317",
  10
);
const WEB_PORT = Number.parseInt(process.env.FORMDIGITAL_WEB_PORT || "3000", 10);
const LDS_TIMEOUT_MS = Number.parseInt(
  process.env.FORMDIGITAL_LAUNCHER_LDS_TIMEOUT_MS || "30000",
  10
);
const WEB_TIMEOUT_MS = Number.parseInt(
  process.env.FORMDIGITAL_LAUNCHER_WEB_TIMEOUT_MS || "90000",
  10
);
const VERIFY_ONLY = process.env.FORMDIGITAL_LAUNCHER_VERIFY_ONLY === "1";
const LDS_SERVICE_NAME = "formdigital-local-data-folder";

// Fixed, safe, non-secret, actionable messages (no token / path / raw error).
const SAFE = {
  configMissing:
    "本機設定檔（local-service-config.json）不存在。首次啟動仍待完成 Data Folder 選擇，請依文件執行一次性設定；本啟動器不會自動建立預設資料夾。",
  ldsFailed:
    "本機資料服務啟動失敗或逾時。請確認沒有其它程式佔用該連接埠，並依文件手動啟動 Local Data Service 後重試。",
  webFailed:
    "Web 服務啟動失敗或逾時。請檢查連接埠是否可用，或改用 npm run dev 個別啟動。",
  preflightNotOk:
    "Web 已啟動，但本機資料服務未回報可用（preflight 非 ok）。請確認 Local Data Service 正在運作。",
  ldsStale:
    "正在運作的本機資料服務比目前程式碼舊，繼續使用會令匯入的頁面無法顯示。本啟動器不會自動終止既有服務；請先在工作管理員結束執行 local-data-service.mjs 的 node.exe（或關閉其視窗），再重新執行本啟動器。",
};

/** Child processes this launcher spawned and therefore owns for cleanup. */
const spawned = [];
let cleanupPromise = null;

function log(message) {
  process.stdout.write(`[formdigital-launcher] ${message}\n`);
}
function fail(message) {
  process.stdout.write(`[formdigital-launcher] ERROR: ${message}\n`);
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnTracked(command, args, options) {
  try {
    const child = spawn(command, args, options);
    const state = { child, spawnFailed: false };
    // spawn() normally reports launch failures asynchronously. Register the
    // listener immediately so ENOENT/EACCES never becomes an unhandled event.
    child.once("error", () => {
      state.spawnFailed = true;
    });
    spawned.push(child);
    return state;
  } catch {
    return null;
  }
}

function killTree(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || !child.pid) return resolve();
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    try {
      if (process.platform === "win32") {
        const killer = spawn(
          "taskkill",
          ["/pid", String(child.pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore" }
        );
        const fallback = () => {
          try {
            child.kill("SIGKILL");
          } catch {}
          done();
        };
        killer.on("close", (code) => (code === 0 ? done() : fallback()));
        killer.on("error", fallback);
      } else if (child.pid) {
        process.kill(-child.pid, "SIGKILL");
        done();
      } else {
        done();
      }
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {}
      done();
    }
    setTimeout(done, 2000);
  });
}

async function cleanupAndExit(code) {
  if (!cleanupPromise) {
    cleanupPromise = (async () => {
      for (const child of spawned) await killTree(child);
      await delay(400);
      process.exit(code);
    })();
  }
  return cleanupPromise;
}

/**
 * Poll an HTTP endpoint until it answers. When `requireService` is set we also
 * require the JSON body's `service` field to match, so a port occupied by an
 * unrelated process is treated as "not our service" (fail-closed), not as
 * healthy.
 */
async function probe(url, { requireService = null, timeoutMs, intervalMs = 400 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { "content-type": "application/json" },
      });
      if (response.ok) {
        if (requireService) {
          const body = await response.json().catch(() => null);
          if (body && body.service === requireService) return { ok: true, body };
          // answers but wrong service -> keep waiting (wrong occupant)
        } else {
          return { ok: true };
        }
      }
    } catch {
      // not up yet
    }
    await delay(intervalMs);
  }
  return { ok: false };
}

/**
 * True when the running service reports the same source build as the file on
 * disk. A service predating this check reports no marker at all, which is
 * itself proof that it is older than the current source.
 */
async function ldsMatchesSource(health) {
  const reported = health?.sourceModifiedAtMs;
  if (typeof reported !== "number" || !Number.isFinite(reported)) return false;
  try {
    const stat = await fs.stat(path.join(PROJECT_ROOT, "local-data-service.mjs"));
    return Math.round(stat.mtimeMs) === reported;
  } catch {
    return false;
  }
}

async function webReady(webPort) {
  const root = `http://127.0.0.1:${webPort}`;
  const rootProbe = await probe(`${root}/`, { timeoutMs: 600, intervalMs: 200 });
  if (!rootProbe.ok) return false;
  const mainProbe = await probe(`${root}/src/main.tsx`, {
    timeoutMs: 600,
    intervalMs: 200,
  });
  if (!mainProbe.ok) return false;
  // preflight must report ok (Local Data Service reachable from the Web server)
  try {
    const response = await fetch(`${root}/api/local/preflight`, {
      method: "GET",
      cache: "no-store",
    });
    if (response.status === 200) {
      const body = await response.json().catch(() => null);
      return body?.status === "ok";
    }
  } catch {}
  return false;
}

async function main() {
  process.on("SIGINT", () => void cleanupAndExit(130));
  process.on("SIGTERM", () => void cleanupAndExit(143));

  log(
    `Mode: ${VERIFY_ONLY ? "verify-only (exit after readiness)" : "interactive (keep running)"}`
  );
  // NOTE: this launcher intentionally never prints the project root, config
  // path, Data Folder, token, raw exceptions, or any other secret value.

  // 1) Config existence gate. Do NOT read content; do NOT auto-create.
  try {
    await fs.access(CONFIG_PATH);
  } catch {
    fail(SAFE.configMissing);
    await cleanupAndExit(1);
    return;
  }

  // 2) Local Data Service — reuse if already healthy, else spawn exactly one.
  const ldsHealthUrl = `http://127.0.0.1:${LDS_HEALTH_PORT}/health`;
  log("Checking Local Data Service health ...");
  const existing = await probe(ldsHealthUrl, {
    requireService: LDS_SERVICE_NAME,
    timeoutMs: 3000,
    intervalMs: 300,
  });
  if (existing.ok) {
    // A service started before the current source cannot honour newer request
    // contracts. Refuse to reuse it rather than let imports fail silently, and
    // never terminate a service this launcher did not start.
    if (!(await ldsMatchesSource(existing.body))) {
      fail(SAFE.ldsStale);
      await cleanupAndExit(1);
      return;
    }
    log("Local Data Service already healthy — reusing existing instance.");
  } else {
    log("Starting Local Data Service ...");
    const ldsLog = childLog("local-data-service");
    const started = spawnTracked(process.execPath, ["local-data-service.mjs"], {
      cwd: PROJECT_ROOT,
      env: sanitizeChildEnv(process.env),
      stdio: ["ignore", ldsLog, ldsLog],
      windowsHide: true,
    });
    if (!started) {
      fail(SAFE.ldsFailed);
      await cleanupAndExit(1);
      return;
    }
    let ldsHealthy = false;
    const deadline = Date.now() + LDS_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const result = await probe(ldsHealthUrl, {
        requireService: LDS_SERVICE_NAME,
        timeoutMs: 1500,
        intervalMs: 300,
      });
      if (result.ok) {
        ldsHealthy = true;
        break;
      }
      if (started.spawnFailed || started.child.exitCode !== null) break;
      await delay(400);
    }
    if (!ldsHealthy) {
      fail(SAFE.ldsFailed);
      await cleanupAndExit(1);
      return;
    }
    log("Local Data Service is healthy.");
  }

  // 3) Web service — reuse if already serving preflight ok, else spawn.
  let webReadyFlag = false;
  try {
    webReadyFlag = await webReady(WEB_PORT);
  } catch {}
  if (webReadyFlag) {
    log("Web service already serving preflight ok — reusing existing instance.");
  } else {
    log("Starting Web service (npm run dev) ...");
    // Recent Node releases reject direct .cmd spawning on Windows. Invoke the
    // fixed npm command through the system command processor; neither the
    // command nor its arguments contain caller-controlled input.
    const webCommand =
      process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "npm";
    const webArgs =
      process.platform === "win32"
        ? ["/d", "/s", "/c", "npm run dev"]
        : ["run", "dev"];
    const webLog = childLog("web");
    const started = spawnTracked(webCommand, webArgs, {
      cwd: PROJECT_ROOT,
      env: { ...sanitizeChildEnv(process.env), PORT: String(WEB_PORT), NODE_ENV: "development" },
      stdio: ["ignore", webLog, webLog],
      windowsHide: true,
    });
    if (!started) {
      fail(SAFE.webFailed);
      await cleanupAndExit(1);
      return;
    }
    const deadline = Date.now() + WEB_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        webReadyFlag = await webReady(WEB_PORT);
      } catch {}
      if (webReadyFlag) break;
      if (started.spawnFailed || started.child.exitCode !== null) break;
      await delay(1000);
    }
    if (!webReadyFlag) {
      fail(SAFE.webFailed);
      await cleanupAndExit(1);
      return;
    }
    log("Web service is ready.");
  }

  // 4) Final preflight confirmation (authoritative `ok`).
  try {
    const response = await fetch(`http://127.0.0.1:${WEB_PORT}/api/local/preflight`, {
      method: "GET",
      cache: "no-store",
    });
    const body = await response.json().catch(() => null);
    if (!(response.status === 200 && body?.status === "ok")) {
      fail(SAFE.preflightNotOk);
      await cleanupAndExit(1);
      return;
    }
  } catch {
    fail(SAFE.preflightNotOk);
    await cleanupAndExit(1);
    return;
  }

  log(`READY. Open http://localhost:${WEB_PORT}/`);

  if (VERIFY_ONLY) {
    await cleanupAndExit(0);
    return;
  }
  // Interactive mode: keep the launcher process alive so both services keep
  // running. Children hold the event loop open; Ctrl+C kills them via handlers.
}

main().catch(async () => {
  fail("Launcher crashed.");
  await cleanupAndExit(1);
});
