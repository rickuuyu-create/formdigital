// WB-01 launcher smoke/regression harness.
//
// Every scenario uses a throwaway project containing a copied launcher and
// synthetic services. The launcher is always invoked from a different
// throwaway working directory. No real config or Data Folder is inspected.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_LAUNCHER = path.join(SCRIPT_DIR, "start-dev-runtime.mjs");
const SOURCE_CMD = path.resolve(SCRIPT_DIR, "..", "start-formdigital-dev.cmd");
const results = [];

function record(name, pass, detail = "") {
  results.push({ name, pass });
  process.stdout.write(
    `[smoke] ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}\n`
  );
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(check, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await delay(100);
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

function isPortListening(port) {
  return new Promise(resolve => {
    const socket = net.connect({ port, host: "127.0.0.1" });
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

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPid(pidFile) {
  try {
    return Number.parseInt((await fs.readFile(pidFile, "utf8")).trim(), 10);
  } catch {
    return 0;
  }
}

/**
 * The launcher refuses to reuse a Local Data Service whose reported build no
 * longer matches local-data-service.mjs on disk, so a mock that stands in for a
 * healthy service must report the fixture's own source mtime.
 */
async function fixtureSourceModifiedAtMs(projectRoot) {
  const sourcePath = path.join(projectRoot, "local-data-service.mjs");
  // Scenarios that stand in a mock server for the service still need the file
  // a real project would have, because the launcher compares against it.
  try {
    await fs.access(sourcePath);
  } catch {
    await fs.writeFile(sourcePath, "// smoke fixture placeholder", "utf8");
  }
  const stat = await fs.stat(sourcePath);
  return Math.round(stat.mtimeMs);
}

async function createFixture(label) {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), `fd-${label}-project-`));
  const callerCwd = await fs.mkdtemp(path.join(os.tmpdir(), `fd-${label}-cwd-`));
  await fs.mkdir(path.join(projectRoot, "scripts"), { recursive: true });
  await fs.copyFile(
    SOURCE_LAUNCHER,
    path.join(projectRoot, "scripts", "start-dev-runtime.mjs")
  );
  return { projectRoot, callerCwd };
}

async function removeFixture(fixture) {
  await fs.rm(fixture.projectRoot, { recursive: true, force: true });
  await fs.rm(fixture.callerCwd, { recursive: true, force: true });
}

function baseEnv(ldsPort, webPort) {
  const env = { ...process.env };
  delete env.FORMDIGITAL_PROJECT_ROOT;
  delete env.FORMDIGITAL_LOCAL_CONFIG;
  env.FORMDIGITAL_LDS_HEALTH_PORT = String(ldsPort);
  env.FORMDIGITAL_WEB_PORT = String(webPort);
  env.FORMDIGITAL_LAUNCHER_LDS_TIMEOUT_MS = "4500";
  env.FORMDIGITAL_LAUNCHER_WEB_TIMEOUT_MS = "6500";
  env.FORMDIGITAL_LAUNCHER_VERIFY_ONLY = "1";
  env.FORMDIGITAL_TEST_SENTINEL = "TEST_TOKEN_VALUE";
  return env;
}

function outputIsSafe(result, fixture) {
  const output = `${result.stdout}\n${result.stderr}`;
  return (
    !output.includes(fixture.projectRoot) &&
    !output.includes(fixture.callerCwd) &&
    !output.includes("TEST_TOKEN_VALUE") &&
    !output.includes("TEST_PATH_VALUE") &&
    !output.includes("TEST_PRIVATE_VALUE") &&
    !output.includes("ENOENT") &&
    !output.includes("EACCES") &&
    !/\n\s*at\s+.*:\d+:\d+/.test(output)
  );
}

function terminateTree(child) {
  return new Promise(resolve => {
    if (!child?.pid || child.exitCode !== null) return resolve();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    if (process.platform === "win32") {
      const systemRoot = process.env.SystemRoot || "C:\\Windows";
      const taskkill = path.join(systemRoot, "System32", "taskkill.exe");
      const killer = spawn(taskkill, ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("close", finish);
      killer.once("error", () => {
        try {
          child.kill("SIGKILL");
        } catch {}
        finish();
      });
    } else {
      try {
        child.kill("SIGKILL");
      } catch {}
      finish();
    }
    setTimeout(finish, 2000).unref?.();
  });
}

function runProcess(command, args, { cwd, env, timeoutMs = 30000 }) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      resolve({ code: null, stdout: "", stderr: "", timedOut: false });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code, timedOut) => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr, timedOut });
    };
    child.stdout.on("data", data => {
      stdout += data.toString();
    });
    child.stderr.on("data", data => {
      stderr += data.toString();
    });
    child.once("error", () => finish(null, false));
    child.once("close", code => finish(code, false));
    setTimeout(async () => {
      if (settled) return;
      await terminateTree(child);
      finish(null, true);
    }, timeoutMs).unref?.();
  });
}

function runLauncher(fixture, env, timeoutMs = 30000) {
  return runProcess(
    process.execPath,
    [path.join(fixture.projectRoot, "scripts", "start-dev-runtime.mjs")],
    { cwd: fixture.callerCwd, env, timeoutMs }
  );
}

async function runWindowsCmd(fixture, env, timeoutMs = 30000) {
  await fs.copyFile(
    SOURCE_CMD,
    path.join(fixture.projectRoot, "start-formdigital-dev.cmd")
  );
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const command = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const cmdPath = path.join(fixture.projectRoot, "start-formdigital-dev.cmd");
  const quotedCmdPath = cmdPath.replaceAll("'", "''");
  return runProcess(
    command,
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `& '${quotedCmdPath}'; exit $LASTEXITCODE`,
    ],
    { cwd: fixture.callerCwd, env, timeoutMs }
  );
}

async function writeConfig(projectRoot) {
  await fs.writeFile(path.join(projectRoot, "local-service-config.json"), "", "utf8");
}

async function writeFakeLds(projectRoot, mode, pidFile, eventFile) {
  const prelude = `
import fs from "node:fs";
import http from "node:http";
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const eventFile = ${JSON.stringify(eventFile)};
`;
  let body;
  if (mode === "exit") {
    body = `fs.appendFileSync(eventFile, "lds-exit\\n"); process.exit(1);\n`;
  } else if (mode === "idle") {
    body = `fs.appendFileSync(eventFile, "lds-idle\\n"); setInterval(() => {}, 1000);\n`;
  } else {
    body = `
const port = Number.parseInt(process.env.FORMDIGITAL_LDS_HEALTH_PORT, 10);
const server = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ status: "ok", service: "formdigital-local-data-folder", sourceModifiedAtMs: Math.round(fs.statSync(new URL(import.meta.url)).mtimeMs) }));
    return;
  }
  response.statusCode = 404;
  response.end("");
});
server.once("error", () => process.exit(2));
server.listen(port, "127.0.0.1", () => fs.appendFileSync(eventFile, "lds-ready\\n"));
`;
  }
  await fs.writeFile(
    path.join(projectRoot, "local-data-service.mjs"),
    prelude + body,
    "utf8"
  );
}

async function writeFakeWeb(projectRoot, mode, pidFile, eventFile) {
  const packageJson = {
    name: "formdigital-launcher-smoke-fixture",
    private: true,
    type: "module",
    scripts: { dev: "node fake-web.mjs" },
  };
  await fs.writeFile(
    path.join(projectRoot, "package.json"),
    JSON.stringify(packageJson),
    "utf8"
  );
  const prelude = `
import fs from "node:fs";
import http from "node:http";
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const eventFile = ${JSON.stringify(eventFile)};
`;
  let body;
  if (mode === "exit") {
    body = `fs.appendFileSync(eventFile, "web-exit\\n"); process.exit(1);\n`;
  } else {
    body = `
const ldsPort = Number.parseInt(process.env.FORMDIGITAL_LDS_HEALTH_PORT, 10);
const webPort = Number.parseInt(process.env.PORT, 10);
try {
  const health = await fetch("http://127.0.0.1:" + ldsPort + "/health");
  const payload = await health.json();
  if (!health.ok || payload.service !== "formdigital-local-data-folder") process.exit(3);
} catch {
  process.exit(3);
}
fs.appendFileSync(eventFile, "web-start-after-lds-health\\n");
const server = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/") {
    fs.appendFileSync(eventFile, "root-probed\\n");
    response.statusCode = 200;
    response.end("<!doctype html>");
    return;
  }
  if (request.method === "GET" && request.url.startsWith("/src/main.tsx")) {
    fs.appendFileSync(eventFile, "main-probed\\n");
    response.statusCode = 200;
    response.end("export {};");
    return;
  }
  if (request.method === "GET" && request.url === "/api/local/preflight") {
    fs.appendFileSync(eventFile, "preflight-probed\\n");
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }
  response.statusCode = 404;
  response.end("");
});
server.listen(webPort, "127.0.0.1");
`;
  }
  await fs.writeFile(path.join(projectRoot, "fake-web.mjs"), prelude + body, "utf8");
}

async function startMockServer(handlers) {
  const server = http.createServer((request, response) => {
    const handler = handlers[`${request.method} ${request.url}`];
    if (!handler) {
      response.statusCode = 404;
      response.end("");
      return;
    }
    response.statusCode = handler.status ?? 200;
    if (handler.json !== undefined) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(handler.json));
    } else {
      response.end(handler.body ?? "");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : 0 };
}

function closeServer(server) {
  return new Promise(resolve => server.close(resolve));
}

async function scenarioColdStart() {
  const fixture = await createFixture("cold");
  const ldsPort = await reservePort();
  const webPort = await reservePort();
  const eventFile = path.join(fixture.projectRoot, "events.txt");
  const ldsPidFile = path.join(fixture.projectRoot, "lds.pid");
  const webPidFile = path.join(fixture.projectRoot, "web.pid");
  try {
    await writeConfig(fixture.projectRoot);
    await writeFakeLds(fixture.projectRoot, "healthy", ldsPidFile, eventFile);
    await writeFakeWeb(fixture.projectRoot, "healthy", webPidFile, eventFile);
    const result = await runWindowsCmd(fixture, baseEnv(ldsPort, webPort), 30000);
    const events = (await fs.readFile(eventFile, "utf8")).trim().split(/\r?\n/);
    const ldsIndex = events.indexOf("lds-ready");
    const webIndex = events.indexOf("web-start-after-lds-health");
    const endpointsVerified =
      events.includes("root-probed") &&
      events.includes("main-probed") &&
      events.includes("preflight-probed");
    const ldsPid = await readPid(ldsPidFile);
    const webPid = await readPid(webPidFile);
    const childrenStopped = await waitFor(
      async () => !pidAlive(ldsPid) && !pidAlive(webPid)
    );
    const portsFreed = await waitFor(
      async () => !(await isPortListening(ldsPort)) && !(await isPortListening(webPort))
    );
    const pass =
      result.code === 0 &&
      !result.timedOut &&
      ldsIndex >= 0 &&
      webIndex > ldsIndex &&
      endpointsVerified &&
      childrenStopped &&
      portsFreed &&
      outputIsSafe(result, fixture);
    record(
      "cold start from unrelated cwd: LDS -> Web -> verified -> clean exit",
      pass,
      `code=${result.code} events=${events.join(",")} endpoints=${endpointsVerified} cleaned=${childrenStopped && portsFreed}`
    );
  } catch {
    record("cold start from unrelated cwd: LDS -> Web -> verified -> clean exit", false, "scenario_error");
  } finally {
    await removeFixture(fixture);
  }
}

async function scenarioReuse() {
  const fixture = await createFixture("reuse");
  let mockLds;
  let mockWeb;
  try {
    await writeConfig(fixture.projectRoot);
    mockLds = await startMockServer({
      "GET /health": {
        json: {
          status: "ok",
          service: "formdigital-local-data-folder",
          sourceModifiedAtMs: await fixtureSourceModifiedAtMs(
            fixture.projectRoot
          ),
        },
      },
    });
    mockWeb = await startMockServer({
      "GET /": { body: "<!doctype html>" },
      "GET /src/main.tsx": { body: "export {};" },
      "GET /api/local/preflight": { json: { status: "ok" } },
    });
    const result = await runLauncher(
      fixture,
      baseEnv(mockLds.port, mockWeb.port),
      20000
    );
    const preserved =
      (await isPortListening(mockLds.port)) && (await isPortListening(mockWeb.port));
    const reuseCount = (result.stdout.match(/reusing existing instance/g) || []).length;
    record(
      "existing healthy services are reused and preserved",
      result.code === 0 && reuseCount === 2 && preserved && outputIsSafe(result, fixture),
      `code=${result.code} reused=${reuseCount} preserved=${preserved}`
    );
  } catch {
    record("existing healthy services are reused and preserved", false, "scenario_error");
  } finally {
    if (mockLds) await closeServer(mockLds.server);
    if (mockWeb) await closeServer(mockWeb.server);
    await removeFixture(fixture);
  }
}

async function scenarioStaleLds() {
  const fixture = await createFixture("stale-lds");
  let mockLds;
  try {
    await writeConfig(fixture.projectRoot);
    // A service started before the current source reports no build marker at
    // all, which is exactly what a long-running old process looks like.
    mockLds = await startMockServer({
      "GET /health": {
        json: { status: "ok", service: "formdigital-local-data-folder" },
      },
    });
    const result = await runLauncher(
      fixture,
      baseEnv(mockLds.port, 45999),
      20000
    );
    const preserved = await isPortListening(mockLds.port);
    const explained = result.stdout.includes("比目前程式碼舊");
    record(
      "a Local Data Service older than the source is refused, not killed",
      result.code === 1 &&
        explained &&
        preserved &&
        outputIsSafe(result, fixture),
      `code=${result.code} explained=${explained} preserved=${preserved}`
    );
  } catch {
    record(
      "a Local Data Service older than the source is refused, not killed",
      false,
      "scenario_error"
    );
  } finally {
    if (mockLds) await closeServer(mockLds.server);
    await removeFixture(fixture);
  }
}

async function scenarioMissingConfig() {
  const fixture = await createFixture("missing");
  try {
    const result = await runLauncher(fixture, baseEnv(await reservePort(), await reservePort()));
    const pass =
      result.code === 1 &&
      result.stdout.includes("本機設定檔（local-service-config.json）不存在") &&
      outputIsSafe(result, fixture);
    record("missing config fails safely from unrelated cwd", pass, `code=${result.code}`);
  } catch {
    record("missing config fails safely from unrelated cwd", false, "scenario_error");
  } finally {
    await removeFixture(fixture);
  }
}

async function scenarioWrongOccupant() {
  const fixture = await createFixture("occupant");
  const eventFile = path.join(fixture.projectRoot, "events.txt");
  const pidFile = path.join(fixture.projectRoot, "lds.pid");
  let occupant;
  try {
    await writeConfig(fixture.projectRoot);
    occupant = await startMockServer({
      "GET /health": { json: { status: "ok", service: "UNRELATED_TEST_SERVICE" } },
    });
    await writeFakeLds(fixture.projectRoot, "healthy", pidFile, eventFile);
    const result = await runLauncher(
      fixture,
      baseEnv(occupant.port, await reservePort()),
      20000
    );
    const childPid = await readPid(pidFile);
    const childGone = await waitFor(async () => !pidAlive(childPid));
    const occupantPreserved = await isPortListening(occupant.port);
    const pass =
      result.code === 1 &&
      !result.stdout.includes("READY") &&
      result.stdout.includes("本機資料服務啟動失敗或逾時") &&
      childGone &&
      occupantPreserved &&
      outputIsSafe(result, fixture);
    record(
      "wrong port occupant fails closed without killing occupant",
      pass,
      `code=${result.code} childGone=${childGone} preserved=${occupantPreserved}`
    );
  } catch {
    record("wrong port occupant fails closed without killing occupant", false, "scenario_error");
  } finally {
    if (occupant) await closeServer(occupant.server);
    await removeFixture(fixture);
  }
}

async function scenarioLdsExit() {
  const fixture = await createFixture("lds-exit");
  const eventFile = path.join(fixture.projectRoot, "events.txt");
  const pidFile = path.join(fixture.projectRoot, "lds.pid");
  try {
    await writeConfig(fixture.projectRoot);
    await writeFakeLds(fixture.projectRoot, "exit", pidFile, eventFile);
    const result = await runLauncher(fixture, baseEnv(await reservePort(), await reservePort()));
    const pid = await readPid(pidFile);
    const childGone = await waitFor(async () => !pidAlive(pid));
    record(
      "LDS child exit returns fixed error with no orphan",
      result.code === 1 &&
        result.stdout.includes("本機資料服務啟動失敗或逾時") &&
        childGone &&
        outputIsSafe(result, fixture),
      `code=${result.code} childGone=${childGone}`
    );
  } catch {
    record("LDS child exit returns fixed error with no orphan", false, "scenario_error");
  } finally {
    await removeFixture(fixture);
  }
}

async function scenarioLdsTimeout() {
  const fixture = await createFixture("lds-timeout");
  const eventFile = path.join(fixture.projectRoot, "events.txt");
  const pidFile = path.join(fixture.projectRoot, "lds.pid");
  const ldsPort = await reservePort();
  try {
    await writeConfig(fixture.projectRoot);
    await writeFakeLds(fixture.projectRoot, "idle", pidFile, eventFile);
    const env = baseEnv(ldsPort, await reservePort());
    env.FORMDIGITAL_LAUNCHER_LDS_TIMEOUT_MS = "2200";
    const result = await runLauncher(fixture, env);
    const pid = await readPid(pidFile);
    const childGone = await waitFor(async () => !pidAlive(pid));
    const portFree = !(await isPortListening(ldsPort));
    record(
      "bounded LDS timeout returns fixed error with no orphan",
      result.code === 1 &&
        result.stdout.includes("本機資料服務啟動失敗或逾時") &&
        childGone &&
        portFree &&
        outputIsSafe(result, fixture),
      `code=${result.code} childGone=${childGone} portFree=${portFree}`
    );
  } catch {
    record("bounded LDS timeout returns fixed error with no orphan", false, "scenario_error");
  } finally {
    await removeFixture(fixture);
  }
}

async function scenarioWebExit() {
  const fixture = await createFixture("web-exit");
  const eventFile = path.join(fixture.projectRoot, "events.txt");
  const ldsPidFile = path.join(fixture.projectRoot, "lds.pid");
  const webPidFile = path.join(fixture.projectRoot, "web.pid");
  const ldsPort = await reservePort();
  const webPort = await reservePort();
  try {
    await writeConfig(fixture.projectRoot);
    await writeFakeLds(fixture.projectRoot, "healthy", ldsPidFile, eventFile);
    await writeFakeWeb(fixture.projectRoot, "exit", webPidFile, eventFile);
    const result = await runLauncher(fixture, baseEnv(ldsPort, webPort));
    const ldsPid = await readPid(ldsPidFile);
    const webPid = await readPid(webPidFile);
    const childrenGone = await waitFor(
      async () => !pidAlive(ldsPid) && !pidAlive(webPid)
    );
    const portsFree =
      !(await isPortListening(ldsPort)) && !(await isPortListening(webPort));
    record(
      "Web child exit cleans the newly started LDS",
      result.code === 1 &&
        result.stdout.includes("Web 服務啟動失敗或逾時") &&
        childrenGone &&
        portsFree &&
        outputIsSafe(result, fixture),
      `code=${result.code} childrenGone=${childrenGone} portsFree=${portsFree}`
    );
  } catch {
    record("Web child exit cleans the newly started LDS", false, "scenario_error");
  } finally {
    await removeFixture(fixture);
  }
}

async function scenarioAsyncSpawnError() {
  const fixture = await createFixture("spawn-error");
  let mockLds;
  try {
    await writeConfig(fixture.projectRoot);
    mockLds = await startMockServer({
      "GET /health": {
        json: {
          status: "ok",
          service: "formdigital-local-data-folder",
          sourceModifiedAtMs: await fixtureSourceModifiedAtMs(
            fixture.projectRoot
          ),
        },
      },
    });
    const env = baseEnv(mockLds.port, await reservePort());
    env.ComSpec = path.join(fixture.callerCwd, "missing-command-processor.exe");
    const result = await runLauncher(fixture, env);
    const preserved = await isPortListening(mockLds.port);
    record(
      "asynchronous npm spawn error is fixed, safe, and preserves existing LDS",
      result.code === 1 &&
        result.stdout.includes("Web 服務啟動失敗或逾時") &&
        preserved &&
        outputIsSafe(result, fixture),
      `code=${result.code} preserved=${preserved}`
    );
  } catch {
    record("asynchronous npm spawn error is fixed, safe, and preserves existing LDS", false, "scenario_error");
  } finally {
    if (mockLds) await closeServer(mockLds.server);
    await removeFixture(fixture);
  }
}

async function scenarioWindowsCmdExitCode() {
  const fixture = await createFixture("cmd");
  try {
    const env = baseEnv(await reservePort(), await reservePort());
    const result = await runWindowsCmd(fixture, env, 20000);
    record(
      "Windows cmd runs from unrelated cwd and preserves launcher exit code",
      result.code === 1 &&
        result.stdout.includes("local-service-config.json") &&
        outputIsSafe(result, fixture),
      `code=${result.code} message=${result.stdout.includes("local-service-config.json")} safe=${outputIsSafe(result, fixture)}`
    );
  } catch {
    record("Windows cmd runs from unrelated cwd and preserves launcher exit code", false, "scenario_error");
  } finally {
    await removeFixture(fixture);
  }
}

// JRN-05: the launcher must never hand FORMDIGITAL_TEST_* / test-hook secrets to
// a spawned child, while still preserving the runtime variables a child needs
// (PATH, SystemRoot, TEMP/TMP). A synthetic child records the exact env keys it
// actually received; we assert against that file, not merely against the absence
// of secrets in the launcher's own stdout/stderr.
async function writeEnvDumpLds(projectRoot, dumpFile) {
  const prelude = `
import fs from "node:fs";
import http from "node:http";
fs.writeFileSync(${JSON.stringify(dumpFile)}, JSON.stringify(Object.keys(process.env).sort()));
`;
  const body = `
const port = Number.parseInt(process.env.FORMDIGITAL_LDS_HEALTH_PORT, 10);
const server = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ status: "ok", service: "formdigital-local-data-folder", sourceModifiedAtMs: Math.round(fs.statSync(new URL(import.meta.url)).mtimeMs) }));
    return;
  }
  response.statusCode = 404;
  response.end("");
});
server.once("error", () => process.exit(2));
server.listen(port, "127.0.0.1");
`;
  await fs.writeFile(path.join(projectRoot, "local-data-service.mjs"), prelude + body, "utf8");
}

async function writeEnvDumpWeb(projectRoot, dumpFile) {
  const prelude = `
import fs from "node:fs";
import http from "node:http";
fs.writeFileSync(${JSON.stringify(dumpFile)}, JSON.stringify(Object.keys(process.env).sort()));
`;
  const body = `
const ldsPort = Number.parseInt(process.env.FORMDIGITAL_LDS_HEALTH_PORT, 10);
const webPort = Number.parseInt(process.env.PORT, 10);
try {
  const health = await fetch("http://127.0.0.1:" + ldsPort + "/health");
  const payload = await health.json();
  if (!health.ok || payload.service !== "formdigital-local-data-folder") process.exit(3);
} catch { process.exit(3); }
const server = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/") { response.statusCode = 200; response.end("<!doctype html>"); return; }
  if (request.method === "GET" && request.url.startsWith("/src/main.tsx")) { response.statusCode = 200; response.end("export {};"); return; }
  if (request.method === "GET" && request.url === "/api/local/preflight") { response.statusCode = 200; response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ status: "ok" })); return; }
  response.statusCode = 404; response.end("");
});
server.listen(webPort, "127.0.0.1");
`;
  const packageJson = { name: "formdigital-launcher-smoke-fixture", private: true, type: "module", scripts: { dev: "node fake-web.mjs" } };
  await fs.writeFile(path.join(projectRoot, "package.json"), JSON.stringify(packageJson), "utf8");
  await fs.writeFile(path.join(projectRoot, "fake-web.mjs"), prelude + body, "utf8");
}

async function scenarioChildEnvIsolation() {
  const fixture = await createFixture("env-iso");
  const ldsPort = await reservePort();
  const webPort = await reservePort();
  const ldsDump = path.join(fixture.projectRoot, "lds-env.json");
  const webDump = path.join(fixture.projectRoot, "web-env.json");
  try {
    await writeConfig(fixture.projectRoot);
    await writeEnvDumpLds(fixture.projectRoot, ldsDump);
    await writeEnvDumpWeb(fixture.projectRoot, webDump);
    const env = baseEnv(ldsPort, webPort);
    // The secret surface the launcher must strip from every spawned child.
    env.FORMDIGITAL_ENABLE_TEST_HOOKS = "1";
    env.FORMDIGITAL_TEST_SENTINEL = "TEST_TOKEN_VALUE";
    env.FORMDIGITAL_TEST_TOKEN = "SUPER_SECRET_TOKEN";
    env.FORMDIGITAL_TEST_PRIVATE_PATH = "/secret/workspace/path";
    // Make the launcher exit with the expected success code after readiness so
    // the scenario can verify the exit code (JRN-05), not run forever.
    env.FORMDIGITAL_LAUNCHER_VERIFY_ONLY = "1";
    const parentKeys = Object.keys(env);
    const result = await runLauncher(fixture, env, 30000);
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
    // A child must retain every runtime variable the parent actually had; the
    // launcher is not expected to invent SystemRoot/TEMP/TMP if the parent never
    // exported them (e.g. a stripped CI shell).
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
    const output = `${result.stdout}\n${result.stderr}`;
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
    const launchedOk = result.code === 0;
    const pass = ldsOk && webOk && launchedOk && noLeak;
    record(
      "launcher strips FORMDIGITAL_TEST_* from child env; keeps PATH/SystemRoot/TEMP",
      pass,
      `ldsStripped=${stripped(ldsKeys)} ldsKept=${kept(ldsKeys)} webStripped=${stripped(webKeys)} webKept=${kept(webKeys)} launchedCode=${result.code} leak=${!noLeak}`
    );
  } catch {
    record(
      "launcher strips FORMDIGITAL_TEST_* from child env; keeps PATH/SystemRoot/TEMP",
      false,
      "scenario_error"
    );
  } finally {
    await removeFixture(fixture);
  }
}

async function main() {
  process.stdout.write("[smoke] isolated launcher validation started\n");
  await scenarioColdStart();
  await scenarioReuse();
  await scenarioStaleLds();
  await scenarioMissingConfig();
  await scenarioWrongOccupant();
  await scenarioLdsExit();
  await scenarioLdsTimeout();
  await scenarioWebExit();
  await scenarioAsyncSpawnError();
  await scenarioWindowsCmdExitCode();
  await scenarioChildEnvIsolation();
  const failed = results.filter(result => !result.pass).length;
  process.stdout.write(
    `[smoke] ${results.length - failed}/${results.length} scenarios passed.\n`
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(() => {
  process.stdout.write("[smoke] HARNESS_FAILED\n");
  process.exit(2);
});
