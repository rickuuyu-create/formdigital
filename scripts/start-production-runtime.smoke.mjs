// Pure-local smoke tests for the production runtime supervisor.
// All services, configs and build files are synthetic throwaway fixtures.

import { spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(SCRIPT_DIR, "start-production-runtime.mjs");
const SOURCE_CMD = path.resolve(
  SCRIPT_DIR,
  "..",
  "start-formdigital-production.cmd"
);
const results = [];

function record(name, pass, detail = "") {
  results.push({ name, pass });
  process.stdout.write(
    `[production-smoke] ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}\n`
  );
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(check, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await delay(75);
  }
  return false;
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function isListening(port) {
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
    setTimeout(() => done(false), 300).unref?.();
  });
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readNumber(file) {
  try {
    return Number.parseInt((await fs.readFile(file, "utf8")).trim(), 10) || 0;
  } catch {
    return 0;
  }
}

async function createFixture(label, { withDist = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `fd-prod-${label}-`));
  const caller = await fs.mkdtemp(
    path.join(os.tmpdir(), `fd-prod-cwd-${label}-`)
  );
  await fs.mkdir(path.join(root, "scripts"), { recursive: true });
  await fs.mkdir(path.join(root, "dist"), { recursive: true });
  await fs.copyFile(
    SOURCE,
    path.join(root, "scripts", "start-production-runtime.mjs")
  );
  await fs.writeFile(
    path.join(root, "local-service-config.json"),
    "TEST_PRIVATE_VALUE",
    "utf8"
  );
  await writeFakeLds(root);
  if (withDist) await writeFakeWeb(root);
  return { root, caller };
}

async function removeFixture(fixture) {
  await fs.rm(fixture.root, { recursive: true, force: true });
  await fs.rm(fixture.caller, { recursive: true, force: true });
}

async function writeFakeLds(root) {
  await fs.writeFile(
    path.join(root, "local-data-service.mjs"),
    `import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const controlFile = path.join(here, "smoke-control.json");
let control = {};
try { control = JSON.parse(fs.readFileSync(controlFile, "utf8")); } catch {}
const port = Number(process.env.FORMDIGITAL_LDS_HEALTH_PORT || control.FORMDIGITAL_LDS_HEALTH_PORT);
const pidFile = control.FORMDIGITAL_TEST_LDS_PID_FILE || process.env.FORMDIGITAL_TEST_LDS_PID_FILE;
if (pidFile) fs.writeFileSync(pidFile, String(process.pid));
const server = http.createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", service: "formdigital-local-data-folder" }));
    return;
  }
  response.writeHead(404).end();
});
const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop); process.on("SIGINT", stop);
server.listen(port, "127.0.0.1");
`,
    "utf8"
  );
}

async function writeFakeWeb(root) {
  await fs.writeFile(
    path.join(root, "dist", "index.js"),
    `import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const controlFile = path.resolve(here, "..", "smoke-control.json");
let control = {};
try { control = JSON.parse(fs.readFileSync(controlFile, "utf8")); } catch {}
const port = Number(process.env.PORT);
const pidFile = control.FORMDIGITAL_TEST_WEB_PID_FILE || process.env.FORMDIGITAL_TEST_WEB_PID_FILE;
const countFile = control.FORMDIGITAL_TEST_WEB_COUNT_FILE || process.env.FORMDIGITAL_TEST_WEB_COUNT_FILE;
if (pidFile) fs.writeFileSync(pidFile, String(process.pid));
let count = 1;
if (countFile) {
  try { count = Number(fs.readFileSync(countFile, "utf8")) + 1; } catch {}
  fs.writeFileSync(countFile, String(count));
}
const scheduledCrashDelay = Number(
  String(control.FORMDIGITAL_TEST_WEB_CRASH_SCHEDULE || process.env.FORMDIGITAL_TEST_WEB_CRASH_SCHEDULE || "")
    .split(",")[count - 1] || 0
);
const transientHealthFailures = Number(
  control.FORMDIGITAL_TEST_WEB_TRANSIENT_HEALTH_FAILURES || process.env.FORMDIGITAL_TEST_WEB_TRANSIENT_HEALTH_FAILURES || 0
);
let healthRequests = 0;
const server = http.createServer((request, response) => {
  if (request.url === "/api/local/preflight") {
    healthRequests += 1;
    if (
      transientHealthFailures > 0 &&
      healthRequests > 1 &&
      healthRequests <= transientHealthFailures + 1
    ) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "busy" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }
  response.writeHead(200, { "content-type": "text/html" }); response.end("FORMDIGITAL_TEST");
});
const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop); process.on("SIGINT", stop);
server.listen(port, "127.0.0.1", () => {
  const crashDelay = scheduledCrashDelay > 0
    ? scheduledCrashDelay
    : (control.FORMDIGITAL_TEST_WEB_CRASH_ONCE === "1" || process.env.FORMDIGITAL_TEST_WEB_CRASH_ONCE === "1") && count === 1
      ? 300
      : 0;
  if (crashDelay > 0)
    setTimeout(() => server.close(() => process.exit(9)), crashDelay);
});
`,
    "utf8"
  );
}

function baseEnv(ldsPort, webPort, fixture) {
  return {
    ...process.env,
    FORMDIGITAL_LDS_HEALTH_PORT: String(ldsPort),
    FORMDIGITAL_WEB_PORT: String(webPort),
    FORMDIGITAL_PROD_START_TIMEOUT_MS: "2500",
    FORMDIGITAL_PROD_MONITOR_INTERVAL_MS: "100",
    FORMDIGITAL_PROD_HEALTH_TIMEOUT_MS: "500",
    FORMDIGITAL_PROD_HEALTH_FAILURE_THRESHOLD: "3",
    FORMDIGITAL_PROD_BACKOFF_BASE_MS: "50",
    FORMDIGITAL_PROD_MAX_RESTARTS: "2",
    FORMDIGITAL_TEST_SENTINEL: "TEST_TOKEN_VALUE",
    FORMDIGITAL_TEST_LDS_PID_FILE: path.join(
      fixture.root,
      "TEST_PATH_VALUE-lds.pid"
    ),
    FORMDIGITAL_TEST_WEB_PID_FILE: path.join(
      fixture.root,
      "TEST_PATH_VALUE-web.pid"
    ),
  };
}

function startLauncher(fixture, env) {
  if (env && fixture?.root) {
    try {
      fsSync.writeFileSync(path.join(fixture.root, "smoke-control.json"), JSON.stringify(env));
    } catch {}
  }
  const child = spawn(
    process.execPath,
    [path.join(fixture.root, "scripts", "start-production-runtime.mjs")],
    {
      cwd: fixture.caller,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", value => {
    stdout += value.toString();
  });
  child.stderr.on("data", value => {
    stderr += value.toString();
  });
  return { child, output: () => `${stdout}\n${stderr}` };
}

async function runWindowsCmd(fixture, env) {
  if (env && fixture?.root) {
    try {
      fsSync.writeFileSync(path.join(fixture.root, "smoke-control.json"), JSON.stringify(env));
    } catch {}
  }
  const target = path.join(fixture.root, "start-formdigital-production.cmd");
  await fs.copyFile(SOURCE_CMD, target);
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const powershell = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const escaped = target.replaceAll("'", "''");
  const child = spawn(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `& '${escaped}'; exit $LASTEXITCODE`,
    ],
    {
      cwd: fixture.caller,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", value => {
    stdout += value.toString();
  });
  child.stderr.on("data", value => {
    stderr += value.toString();
  });
  const code = await new Promise(resolve => child.once("close", resolve));
  return { code, output: `${stdout}\n${stderr}` };
}

async function waitForExit(run, timeoutMs = 8_000) {
  if (run.child.exitCode !== null) return run.child.exitCode;
  return new Promise(resolve => {
    let settled = false;
    const done = code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code);
    };
    run.child.once("close", done);
    const timer = setTimeout(() => done(null), timeoutMs);
  });
}

async function terminateLauncher(run) {
  if (run.child.exitCode !== null) return;
  try {
    run.child.kill("SIGTERM");
  } catch {}
  if ((await waitForExit(run, 4_000)) === null && run.child.pid) {
    if (process.platform === "win32") {
      await new Promise(resolve => {
        const killer = spawn(
          "taskkill",
          ["/pid", String(run.child.pid), "/T", "/F"],
          {
            windowsHide: true,
            stdio: "ignore",
          }
        );
        killer.once("close", resolve);
        killer.once("error", resolve);
      });
    } else {
      try {
        run.child.kill("SIGKILL");
      } catch {}
    }
  }
}

function safeOutput(output, fixture) {
  return (
    !output.includes(fixture.root) &&
    !output.includes(fixture.caller) &&
    !output.includes("TEST_TOKEN_VALUE") &&
    !output.includes("TEST_PATH_VALUE") &&
    !output.includes("TEST_PRIVATE_VALUE") &&
    !output.includes("ENOENT") &&
    !/\n\s*at\s+.*:\d+:\d+/.test(output)
  );
}

async function healthyLdsServer(port, sourceFile) {
  const sourceModifiedAtMs = sourceFile
    ? Math.round((await fs.stat(sourceFile)).mtimeMs)
    : 0;
  const server = http.createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          status: "ok",
          service: "formdigital-local-data-folder",
          sourceModifiedAtMs,
        })
      );
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

// 1. Missing dist fails closed and never starts development mode.
{
  const fixture = await createFixture("missing-dist", { withDist: false });
  try {
    const env = baseEnv(await reservePort(), await reservePort(), fixture);
    env.FORMDIGITAL_PROD_VERIFY_ONLY = "1";
    const run = startLauncher(fixture, env);
    const code = await waitForExit(run);
    const output = run.output();
    record(
      "missing dist gives fixed build instruction and no dev fallback",
      code === 1 &&
        output.includes("npm run build") &&
        !output.includes("npm run dev") &&
        safeOutput(output, fixture)
    );
  } finally {
    await removeFixture(fixture);
  }
}

// 2. A healthy existing Local Data Service is reused and left running.
{
  const fixture = await createFixture("reuse-lds");
  const ldsPort = await reservePort();
  const webPort = await reservePort();
  const existing = await healthyLdsServer(
    ldsPort,
    path.join(fixture.root, "local-data-service.mjs")
  );
  try {
    const env = baseEnv(ldsPort, webPort, fixture);
    env.FORMDIGITAL_PROD_VERIFY_ONLY = "1";
    const run = startLauncher(fixture, env);
    const code = await waitForExit(run);
    record(
      "healthy Local Data Service is reused and preserved",
      code === 0 &&
        run.output().includes("沿用現有健康服務") &&
        (await isListening(ldsPort))
    );
  } finally {
    await new Promise(resolve => existing.close(resolve));
    await removeFixture(fixture);
  }
}

// 3. Wrong Web port occupant is rejected without being terminated.
{
  const fixture = await createFixture("wrong-occupant");
  const ldsPort = await reservePort();
  const webPort = await reservePort();
  const existingLds = await healthyLdsServer(
    ldsPort,
    path.join(fixture.root, "local-data-service.mjs")
  );
  const occupant = net.createServer();
  await new Promise((resolve, reject) => {
    occupant.once("error", reject);
    occupant.listen(webPort, "127.0.0.1", resolve);
  });
  try {
    const run = startLauncher(fixture, baseEnv(ldsPort, webPort, fixture));
    const code = await waitForExit(run);
    record(
      "wrong Web port occupant is rejected and preserved",
      code === 1 &&
        run.output().includes("Web 連接埠已被其它程式佔用") &&
        (await isListening(webPort))
    );
  } finally {
    await new Promise(resolve => occupant.close(resolve));
    await new Promise(resolve => existingLds.close(resolve));
    await removeFixture(fixture);
  }
}

// 4. A child that exits after readiness is restarted with bounded backoff.
{
  const fixture = await createFixture("restart");
  const ldsPort = await reservePort();
  const webPort = await reservePort();
  const countFile = path.join(fixture.root, "web-count.txt");
  const env = baseEnv(ldsPort, webPort, fixture);
  env.FORMDIGITAL_TEST_WEB_CRASH_ONCE = "1";
  env.FORMDIGITAL_TEST_WEB_COUNT_FILE = countFile;
  const run = startLauncher(fixture, env);
  try {
    const restarted = await waitFor(
      async () => (await readNumber(countFile)) >= 2,
      8_000
    );
    const healthyAgain =
      restarted && (await waitFor(() => isListening(webPort), 3_000));
    record(
      "unexpected child exit triggers bounded restart and recovery",
      healthyAgain && run.output().includes("第 1/2 次有限重啟")
    );
  } finally {
    await terminateLauncher(run);
    await waitFor(
      async () =>
        !(await isListening(ldsPort)) && !(await isListening(webPort)),
      4_000
    );
    await removeFixture(fixture);
  }
}

// 5. Graceful supervisor teardown removes only the two owned children.
{
  const fixture = await createFixture("teardown");
  const ldsPort = await reservePort();
  const webPort = await reservePort();
  const env = baseEnv(ldsPort, webPort, fixture);
  const run = startLauncher(fixture, env);
  try {
    const ready = await waitFor(
      () => Promise.resolve(run.output().includes("READY.")),
      7_000
    );
    const ldsPid = await readNumber(env.FORMDIGITAL_TEST_LDS_PID_FILE);
    const webPid = await readNumber(env.FORMDIGITAL_TEST_WEB_PID_FILE);
    await terminateLauncher(run);
    const stopped = await waitFor(
      () => Promise.resolve(!pidAlive(ldsPid) && !pidAlive(webPid)),
      5_000
    );
    record("graceful teardown stops owned children", ready && stopped);
  } finally {
    await terminateLauncher(run);
    await removeFixture(fixture);
  }
}

// 6. A single slow/busy health response must not terminate healthy processes.
{
  const fixture = await createFixture("transient-health");
  const ldsPort = await reservePort();
  const webPort = await reservePort();
  const countFile = path.join(fixture.root, "web-health-count.txt");
  const env = baseEnv(ldsPort, webPort, fixture);
  env.FORMDIGITAL_TEST_WEB_COUNT_FILE = countFile;
  env.FORMDIGITAL_TEST_WEB_TRANSIENT_HEALTH_FAILURES = "1";
  const run = startLauncher(fixture, env);
  try {
    const ready = await waitFor(
      () => Promise.resolve(run.output().includes("READY.")),
      7_000
    );
    await delay(900);
    record(
      "one transient health failure does not restart a live service",
      ready &&
        (await readNumber(countFile)) === 1 &&
        (await isListening(webPort)) &&
        !run.output().includes("Production Web 服務異常")
    );
  } finally {
    await terminateLauncher(run);
    await waitFor(
      async () =>
        !(await isListening(ldsPort)) && !(await isListening(webPort)),
      4_000
    );
    await removeFixture(fixture);
  }
}

// 7. Isolated failures years apart must not exhaust a lifetime restart budget.
{
  const fixture = await createFixture("restart-reset");
  const ldsPort = await reservePort();
  const webPort = await reservePort();
  const countFile = path.join(fixture.root, "web-reset-count.txt");
  const env = baseEnv(ldsPort, webPort, fixture);
  env.FORMDIGITAL_PROD_MAX_RESTARTS = "1";
  env.FORMDIGITAL_PROD_RESTART_RESET_MS = "250";
  env.FORMDIGITAL_TEST_WEB_COUNT_FILE = countFile;
  env.FORMDIGITAL_TEST_WEB_CRASH_SCHEDULE = "400,900";
  const run = startLauncher(fixture, env);
  try {
    const restartedTwice = await waitFor(
      async () => (await readNumber(countFile)) >= 3,
      9_000
    );
    const healthyAgain =
      restartedTwice && (await waitFor(() => isListening(webPort), 3_000));
    const passed =
      healthyAgain && run.output().includes("有限重啟計數已重設");
    record(
      "restart budget resets after a sustained healthy interval",
      passed,
      passed
        ? ""
        : `spawn-count=${await readNumber(countFile)}; ${run
            .output()
            .replaceAll("\n", " | ")
            .slice(0, 800)}`
    );
  } finally {
    await terminateLauncher(run);
    await waitFor(
      async () =>
        !(await isListening(ldsPort)) && !(await isListening(webPort)),
      4_000
    );
    await removeFixture(fixture);
  }
}

// 8. No path, config content, token-like sentinel, raw error or stack is emitted.
{
  const fixture = await createFixture("privacy", { withDist: false });
  try {
    const run = startLauncher(
      fixture,
      baseEnv(await reservePort(), await reservePort(), fixture)
    );
    await waitForExit(run);
    record(
      "all public launcher output is privacy-safe",
      safeOutput(run.output(), fixture)
    );
  } finally {
    await removeFixture(fixture);
  }
}

// 9. The Windows one-click wrapper resolves from itself and preserves failure.
{
  const fixture = await createFixture("windows-cmd", { withDist: false });
  try {
    const result = await runWindowsCmd(
      fixture,
      baseEnv(await reservePort(), await reservePort(), fixture)
    );
    record(
      "Windows one-click command works from unrelated cwd and preserves exit code",
      result.code === 1 &&
        result.output.includes("npm run build") &&
        safeOutput(result.output, fixture)
    );
  } finally {
    await removeFixture(fixture);
  }
}

// JRN-05: the production launcher must never hand FORMDIGITAL_TEST_* /
// test-hook secrets to a spawned child, while preserving PATH/SystemRoot/TEMP.
// A synthetic child records the exact env keys it actually received; we assert
// against that file rather than only the absence of secrets in launcher output.
async function writeEnvDumpLdsProd(root, dumpFile) {
  await fs.writeFile(
    path.join(root, "local-data-service.mjs"),
    `import http from "node:http";
import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(dumpFile)}, JSON.stringify(Object.keys(process.env).sort()));
const port = Number(process.env.FORMDIGITAL_LDS_HEALTH_PORT || 4317);
const server = http.createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", service: "formdigital-local-data-folder" }));
    return;
  }
  response.writeHead(404).end();
});
server.listen(port, "127.0.0.1");
`,
    "utf8"
  );
}

async function writeEnvDumpWebProd(root, dumpFile) {
  await fs.writeFile(
    path.join(root, "dist", "index.js"),
    `import http from "node:http";
import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(dumpFile)}, JSON.stringify(Object.keys(process.env).sort()));
const port = Number(process.env.PORT);
const server = http.createServer((request, response) => {
  if (request.url === "/api/local/preflight") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }
  response.writeHead(200, { "content-type": "text/html" });
  response.end("FORMDIGITAL_TEST");
});
server.listen(port, "127.0.0.1");
`,
    "utf8"
  );
}

// 10. Child env isolation: FORMDIGITAL_TEST_* stripped, runtime vars kept.
{
  const fixture = await createFixture("env-iso", { withDist: true });
  const ldsPort = await reservePort();
  const webPort = await reservePort();
  const ldsDump = path.join(fixture.root, "lds-env.json");
  const webDump = path.join(fixture.root, "web-env.json");
  try {
    await writeEnvDumpLdsProd(fixture.root, ldsDump);
    await writeEnvDumpWebProd(fixture.root, webDump);
    const env = baseEnv(ldsPort, webPort, fixture);
    env.FORMDIGITAL_PROD_VERIFY_ONLY = "1";
    env.FORMDIGITAL_ENABLE_TEST_HOOKS = "1";
    env.FORMDIGITAL_TEST_SENTINEL = "TEST_TOKEN_VALUE";
    env.FORMDIGITAL_TEST_TOKEN = "SUPER_SECRET_TOKEN";
    env.FORMDIGITAL_TEST_PRIVATE_PATH = "/secret/workspace/path";
    const parentKeys = Object.keys(env);
    const run = startLauncher(fixture, env);
    const launchedCode = await waitForExit(run, 12000);
    // Both child env dumps must exist and be parseable. readKeys returns null on
    // a missing or unparseable dump so the check below fails loudly instead of
    // silently treating an absent dump as "clean" (JRN-05).
    const readKeys = async (file) => {
      try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return null; }
    };
    const ldsKeys = await readKeys(ldsDump);
    const webKeys = await readKeys(webDump);
    const stripped = (keys) =>
      keys !== null &&
      !keys.includes("FORMDIGITAL_ENABLE_TEST_HOOKS") &&
      keys.every(k => !k.startsWith("FORMDIGITAL_TEST_"));
    const kept = (keys) => {
      if (keys === null) return false;
      for (const needed of ["PATH"]) {
        if (parentKeys.includes(needed) && !keys.includes(needed)) return false;
      }
      if (process.platform === "win32") {
        for (const needed of ["SystemRoot", "TEMP", "TMP"]) {
          if (parentKeys.includes(needed) && !keys.includes(needed)) return false;
        }
      }
      return true;
    };
    const output = run.output();
    const noLeak =
      !output.includes("SUPER_SECRET_TOKEN") &&
      !output.includes("/secret/workspace/path") &&
      !output.includes("TEST_TOKEN_VALUE");
    // JRN-05: both child dumps must be present and parseable, both must prove the
    // test hooks/secret surface were stripped while runtime vars were kept, the
    // launcher must exit with the expected success code, and nothing secret may
    // leak into stdout/stderr. Any missing/unparseable/unexpected-exit fails.
    const ldsOk = stripped(ldsKeys) && kept(ldsKeys);
    const webOk = stripped(webKeys) && kept(webKeys);
    const launchedOk = launchedCode === 0;
    record(
      "launcher strips FORMDIGITAL_TEST_* from child env; keeps PATH/SystemRoot/TEMP",
      ldsOk && webOk && launchedOk && noLeak,
      `ldsStripped=${stripped(ldsKeys)} ldsKept=${kept(ldsKeys)} webStripped=${stripped(webKeys)} webKept=${kept(webKeys)} launchedCode=${launchedCode} leak=${!noLeak}`
    );
  } finally {
    await removeFixture(fixture);
  }
}

const failed = results.filter(result => !result.pass);
process.stdout.write(
  `[production-smoke] ${results.length - failed.length}/${results.length} checks passed.\n`
);
if (failed.length) process.exitCode = 1;
