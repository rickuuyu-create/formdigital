// Formdigital local production runtime supervisor.
//
// Starts the already-built Web bundle and the Local Data Service, verifies both
// over loopback, monitors them, and performs only bounded restarts. It never
// reads or prints Local Data Service config contents and never falls back to a
// development server.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const DIST_ENTRY = path.join(PROJECT_ROOT, "dist", "index.js");
const LDS_ENTRY = path.join(PROJECT_ROOT, "local-data-service.mjs");
const CONFIG_PATH = process.env.FORMDIGITAL_LOCAL_CONFIG
  ? path.resolve(process.env.FORMDIGITAL_LOCAL_CONFIG)
  : path.join(PROJECT_ROOT, "local-service-config.json");

function positiveInteger(value, fallback, minimum = 1) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

const LDS_PORT = positiveInteger(process.env.FORMDIGITAL_LDS_HEALTH_PORT, 4317);
const WEB_PORT = positiveInteger(process.env.FORMDIGITAL_WEB_PORT, 3000);
const START_TIMEOUT_MS = positiveInteger(
  process.env.FORMDIGITAL_PROD_START_TIMEOUT_MS,
  45_000,
  250
);
const MONITOR_INTERVAL_MS = positiveInteger(
  process.env.FORMDIGITAL_PROD_MONITOR_INTERVAL_MS,
  5_000,
  50
);
const HEALTH_TIMEOUT_MS = positiveInteger(
  process.env.FORMDIGITAL_PROD_HEALTH_TIMEOUT_MS,
  5_000,
  250
);
const HEALTH_FAILURE_THRESHOLD = positiveInteger(
  process.env.FORMDIGITAL_PROD_HEALTH_FAILURE_THRESHOLD,
  3,
  2
);
const MAX_RESTARTS = positiveInteger(
  process.env.FORMDIGITAL_PROD_MAX_RESTARTS,
  3,
  0
);
const BACKOFF_BASE_MS = positiveInteger(
  process.env.FORMDIGITAL_PROD_BACKOFF_BASE_MS,
  1_000,
  10
);
const RESTART_RESET_MS = positiveInteger(
  process.env.FORMDIGITAL_PROD_RESTART_RESET_MS,
  10 * 60 * 1_000,
  100
);
const VERIFY_ONLY = process.env.FORMDIGITAL_PROD_VERIFY_ONLY === "1";
const LDS_SERVICE_NAME = "formdigital-local-data-folder";

const SAFE = Object.freeze({
  configMissing:
    "本機設定尚未完成。請先依交付文件完成 Local Data Service 一次性設定，再重新啟動。",
  unsupportedRuntime:
    "此版本需要 Node.js 24 LTS。請安裝或切換至 Node.js 24 後再重新啟動。",
  distMissing:
    "Production build 不存在或不完整。請先在專案資料夾執行 npm run build，再重新啟動；本啟動器不會改用 development server。",
  ldsOccupied:
    "Local Data Service 連接埠已被其它程式佔用。請關閉佔用程式或既有的錯誤服務後重試。",
  webOccupied: "Web 連接埠已被其它程式佔用。請關閉佔用程式後重試。",
  ldsFailed:
    "Local Data Service 無法啟動或未能通過健康檢查。請檢查本機設定及連接埠後重試。",
  webFailed:
    "Production Web 服務無法啟動或未能通過健康檢查。請重新執行 npm run build，並確認連接埠可用。",
  restartExhausted:
    "服務持續異常，已停止有限次數的自動重啟。請保留此視窗並聯絡維護人員。",
  crashed: "Production runtime supervisor 發生內部錯誤，已安全停止。",
});

const ownedChildren = new Set();
let stopping = false;
let exitPromise = null;

function log(message) {
  process.stdout.write(`[formdigital-production] ${message}\n`);
}

function fail(message) {
  process.stdout.write(`[formdigital-production] ERROR: ${message}\n`);
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

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fileExists(file) {
  try {
    const stat = await fs.stat(file);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function requestJson(url, timeoutMs = HEALTH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    return { status: response.status, ok: response.ok, body };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function ldsHealthy() {
  const result = await requestJson(`http://127.0.0.1:${LDS_PORT}/health`);
  return Boolean(
    result?.ok &&
      result.body?.status === "ok" &&
      result.body?.service === LDS_SERVICE_NAME
  );
}

async function ldsReusable() {
  const result = await requestJson(`http://127.0.0.1:${LDS_PORT}/health`);
  if (
    !(
      result?.ok &&
      result.body?.status === "ok" &&
      result.body?.service === LDS_SERVICE_NAME
    )
  ) {
    return false;
  }
  const reported = result.body?.sourceModifiedAtMs;
  if (typeof reported !== "number" || !Number.isFinite(reported)) return false;
  try {
    const stat = await fs.stat(LDS_ENTRY);
    return Math.round(stat.mtimeMs) === reported;
  } catch {
    return false;
  }
}

async function webHealthy() {
  const result = await requestJson(
    `http://127.0.0.1:${WEB_PORT}/api/local/preflight`
  );
  return Boolean(result?.status === 200 && result.body?.status === "ok");
}

function portListening(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let settled = false;
    const done = value => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    setTimeout(() => done(false), 500).unref?.();
  });
}

function spawnOwned(entry, env) {
  try {
    const child = spawn(process.execPath, [entry], {
      cwd: PROJECT_ROOT,
      env,
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const state = { child, spawnFailed: false };
    child.once("error", () => {
      state.spawnFailed = true;
    });
    ownedChildren.add(child);
    child.once("close", () => ownedChildren.delete(child));
    return state;
  } catch {
    return null;
  }
}

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    let settled = false;
    const done = value => {
      if (settled) return;
      settled = true;
      child.off("close", onClose);
      clearTimeout(timer);
      resolve(value);
    };
    const onClose = () => done(true);
    child.once("close", onClose);
    const timer = setTimeout(() => done(false), timeoutMs);
    timer.unref?.();
  });
}

async function stopOwnedChild(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  try {
    child.kill("SIGTERM");
  } catch {}
  if (await waitForExit(child, 1_500)) return;

  if (process.platform === "win32") {
    await new Promise(resolve => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      try {
        const killer = spawn(
          "taskkill",
          ["/pid", String(child.pid), "/T", "/F"],
          {
            windowsHide: true,
            stdio: "ignore",
          }
        );
        killer.once("close", done);
        killer.once("error", done);
      } catch {
        done();
      }
      setTimeout(done, 2_000).unref?.();
    });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
  }
  await waitForExit(child, 1_000);
}

async function shutdown(code) {
  if (exitPromise) return exitPromise;
  stopping = true;
  exitPromise = (async () => {
    const children = Array.from(ownedChildren);
    await Promise.all(children.map(stopOwnedChild));
    process.exitCode = code;
  })();
  return exitPromise;
}

async function waitUntilHealthy(state, healthCheck) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (!stopping && Date.now() < deadline) {
    if (await healthCheck()) return true;
    if (!state || state.spawnFailed || state.child.exitCode !== null)
      return false;
    await delay(200);
  }
  return false;
}

function createRole({
  label,
  entry,
  env,
  healthCheck,
  reuseCheck = healthCheck,
  occupiedMessage,
  failedMessage,
}) {
  return {
    label,
    entry,
    env,
    healthCheck,
    reuseCheck,
    occupiedMessage,
    failedMessage,
    child: null,
    reused: false,
    restarts: 0,
    stableSince: 0,
    consecutiveHealthFailures: 0,
    lastFailureReported: false,
  };
}

async function startRole(role, { initial = false } = {}) {
  if (stopping) return false;
  if (
    initial &&
    (await portListening(role === ldsRole ? LDS_PORT : WEB_PORT))
  ) {
    if (role === ldsRole && (await role.reuseCheck())) {
      role.reused = true;
      role.stableSince = Date.now();
      log("Local Data Service 已在運作，沿用現有健康服務。");
      return true;
    }
    fail(role.occupiedMessage);
    role.lastFailureReported = true;
    return false;
  }

  role.reused = false;
  const state = spawnOwned(role.entry, role.env);
  role.child = state?.child ?? null;
  if (!state || !(await waitUntilHealthy(state, role.healthCheck))) {
    if (role.child) await stopOwnedChild(role.child);
    role.child = null;
    role.lastFailureReported = false;
    return false;
  }
  role.stableSince = Date.now();
  role.consecutiveHealthFailures = 0;
  log(`${role.label} 已通過健康檢查。`);
  return true;
}

async function recoverRole(role) {
  while (!stopping && role.restarts < MAX_RESTARTS) {
    role.restarts += 1;
    const backoff = Math.min(
      BACKOFF_BASE_MS * 2 ** (role.restarts - 1),
      30_000
    );
    log(
      `${role.label} 異常，將進行第 ${role.restarts}/${MAX_RESTARTS} 次有限重啟。`
    );
    await delay(backoff);
    if (stopping) return false;
    if (await startRole(role)) return true;
  }
  fail(SAFE.restartExhausted);
  return false;
}

let ldsRole;
let webRole;

async function supervise() {
  while (!stopping) {
    await delay(MONITOR_INTERVAL_MS);
    if (stopping) break;

    const ldsIsHealthy = await ldsRole.healthCheck();
    if (ldsIsHealthy) {
      ldsRole.consecutiveHealthFailures = 0;
      if (
        ldsRole.restarts > 0 &&
        ldsRole.stableSince > 0 &&
        Date.now() - ldsRole.stableSince >= RESTART_RESET_MS
      ) {
        ldsRole.restarts = 0;
        ldsRole.stableSince = Date.now();
        log("Local Data Service 已持續穩定，有限重啟計數已重設。");
      }
    } else {
      ldsRole.consecutiveHealthFailures += 1;
      const ldsExited = Boolean(
        ldsRole.child && ldsRole.child.exitCode !== null
      );
      if (
        ldsExited ||
        ldsRole.consecutiveHealthFailures >= HEALTH_FAILURE_THRESHOLD
      ) {
        ldsRole.consecutiveHealthFailures = 0;
        ldsRole.stableSince = 0;
        if (ldsRole.child) await stopOwnedChild(ldsRole.child);
        ldsRole.child = null;
        if (!(await recoverRole(ldsRole))) return false;
      }
    }

    const webIsHealthy = await webRole.healthCheck();
    if (webIsHealthy) {
      webRole.consecutiveHealthFailures = 0;
      if (
        webRole.restarts > 0 &&
        webRole.stableSince > 0 &&
        Date.now() - webRole.stableSince >= RESTART_RESET_MS
      ) {
        webRole.restarts = 0;
        webRole.stableSince = Date.now();
        log("Production Web 服務已持續穩定，有限重啟計數已重設。");
      }
    } else {
      webRole.consecutiveHealthFailures += 1;
      const webExited = Boolean(
        webRole.child && webRole.child.exitCode !== null
      );
      if (
        webExited ||
        webRole.consecutiveHealthFailures >= HEALTH_FAILURE_THRESHOLD
      ) {
        webRole.consecutiveHealthFailures = 0;
        webRole.stableSince = 0;
        if (webRole.child) await stopOwnedChild(webRole.child);
        webRole.child = null;
        if (!(await recoverRole(webRole))) return false;
      }
    }
  }
  return true;
}

async function main() {
  process.once("SIGINT", () => void shutdown(130));
  process.once("SIGTERM", () => void shutdown(143));

  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);
  if (nodeMajor !== 24) {
    fail(SAFE.unsupportedRuntime);
    await shutdown(1);
    return;
  }

  if (!(await fileExists(DIST_ENTRY))) {
    fail(SAFE.distMissing);
    await shutdown(1);
    return;
  }
  if (!(await fileExists(CONFIG_PATH))) {
    fail(SAFE.configMissing);
    await shutdown(1);
    return;
  }
  if (!(await fileExists(LDS_ENTRY))) {
    fail(SAFE.ldsFailed);
    await shutdown(1);
    return;
  }

  ldsRole = createRole({
    label: "Local Data Service",
    entry: LDS_ENTRY,
    env: sanitizeChildEnv(process.env),
    healthCheck: ldsHealthy,
    reuseCheck: ldsReusable,
    occupiedMessage: SAFE.ldsOccupied,
    failedMessage: SAFE.ldsFailed,
  });
  webRole = createRole({
    label: "Production Web 服務",
    entry: DIST_ENTRY,
    env: { ...sanitizeChildEnv(process.env), NODE_ENV: "production", PORT: String(WEB_PORT) },
    healthCheck: webHealthy,
    occupiedMessage: SAFE.webOccupied,
    failedMessage: SAFE.webFailed,
  });

  log("正在檢查 Local Data Service …");
  if (!(await startRole(ldsRole, { initial: true }))) {
    if (!ldsRole.lastFailureReported) fail(SAFE.ldsFailed);
    await shutdown(1);
    return;
  }

  log("正在啟動 Production Web 服務 …");
  if (!(await startRole(webRole, { initial: true }))) {
    if (!webRole.lastFailureReported) fail(SAFE.webFailed);
    await shutdown(1);
    return;
  }

  log(`READY. Open http://localhost:${WEB_PORT}/`);
  if (VERIFY_ONLY) {
    await shutdown(0);
    return;
  }

  const healthy = await supervise();
  if (!healthy && !stopping) await shutdown(1);
}

main().catch(async () => {
  fail(SAFE.crashed);
  await shutdown(1);
});
