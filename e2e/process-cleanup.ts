import { execFile, type ChildProcess } from "node:child_process";

/**
 * test-only：跨平台的子程序終止工具（UX-TPL-01 階段 2 測試可靠性修正／Task B）。
 *
 * 目的：讓 `e2e/global-setup.ts` 在收尾時「真正」關掉本輪 spawn 的合成服務，
 * 而不是在 Windows 上發一個 `SIGTERM` 就以為完成。Windows 的 `child.kill("SIGTERM")`
 * 只會硬殺「直接」child（且其 `exitCode` 保持 null、`signalCode="SIGTERM"`），
 * 對 tsx 這類會再 spawn 子孫的 CLI 會把真正的 server 孤兒化。故 Windows 改用
 * `taskkill /T /F` 一次砍整棵子孫樹。此模組不依賴 Playwright，可用隔離的合成
 * 子程序測試（見 `e2e/process-cleanup-probe.ts`）。
 *
 * 2026-09-21 第二輪修正（回歸測試反例）：
 *  - **終止命令整段有界**：`execFile` 自帶 timeout，並再加一道 Promise 層的
 *    硬性 guard，卡住也一定 settle，不會讓 `await` 無限期懸著。
 *  - **未能確認退出不得「正常返回就算成功」**：`terminateChild` 回傳必須被
 *    檢查的結果；`terminateChildOrThrow`／`terminateAll` 在失敗時拋出固定錯誤。
 *  - **一個失敗也要清理另一個**：`terminateAll` 逐項執行、彙總失敗，不讓第一個
 *    throw 就留下第二個程序。
 *  - 只對「本呼叫拿到的 child 物件」操作；不按名稱廣播終止。
 */

/** 固定、value-free 的清理失敗錯誤前綴（只帶 label，不帶路徑／env／token）。 */
export const PROCESS_CLEANUP_FAILED = "PROCESS_CLEANUP_FAILED";

/**
 * 終止命令（可注入，供合成測試驗證「命令失敗／卡住」）。
 * `null` 代表此平台改用 Node 的 `child.kill()` 訊號路徑。
 */
export type KillCommand = {
  file: string;
  buildArgs: (pid: number) => string[];
  /** 命令本身的執行上限（ms）。 */
  timeoutMs?: number;
};

export type TerminateOptions = {
  /** Test-only boundary: virtual children must never reach operating-system commands. */
  runtime?: {
    execute: (file: string, args: string[], timeoutMs: number) => Promise<{ ok: boolean }>;
    wait: (child: ChildProcess, timeoutMs: number) => Promise<boolean>;
  };
  /** 覆寫終止命令（預設：win32 用 taskkill；其餘用 SIGTERM→SIGKILL）。 */
  killCommand?: KillCommand | null;
  /** 終止命令的執行上限（ms，預設 5000）。 */
  killTimeoutMs?: number;
};

export type TerminateResult = {
  label: string;
  pid: number | undefined;
  /** 是否已確認退出。false 代表**清理失敗**，呼叫端必須處理。 */
  exited: boolean;
  markers: string[];
};

export type TerminateOutcome = {
  results: TerminateResult[];
  failed: TerminateResult[];
  /** 全部都確認退出才為 true；`e2e/global-setup.ts` 只在 true 時才可刪資料。 */
  verified: boolean;
};

function defaultKillCommand(): KillCommand | null {
  if (process.platform !== "win32") return null;
  return {
    file: "taskkill",
    buildArgs: pid => ["/PID", String(pid), "/T", "/F"],
  };
}

/**
 * 有界執行外部命令：命令自帶 timeout，並用一道額外的 Promise guard 保證
 * 任何情況都 settle（卡住時嘗試 kill 該命令程序並回傳 ok=false）。
 */
function execFileBounded(
  file: string,
  args: string[],
  timeoutMs: number
): Promise<{ ok: boolean }> {
  return new Promise(resolve => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      resolve({ ok });
    };
    let guard: ReturnType<typeof setTimeout>;
    const child = execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true },
      error => done(!error)
    );
    guard = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // 命令程序已結束等情況，忽略。
      }
      done(false);
    }, timeoutMs + 1_000);
  });
}

/** 有界等待 child 實際退出（含被訊號終止，`signalCode` 非空也算）；逾時回傳 false。 */
export function waitForExit(
  child: ChildProcess,
  timeoutMs: number
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve(true);
  return new Promise(resolve => {
    let settled = false;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(value);
    };
    const onExit = () => done(true);
    const timer = setTimeout(() => done(false), timeoutMs);
    child.once("exit", onExit);
  });
}

/**
 * 終止一個本輪實際 spawn 的 child（含其子孫），有界等待退出、必要時升級。
 *
 * - 只對「這個 child 物件」操作（不按名稱廣播終止）；`child.pid` 就是我們自己
 *   spawn 的根，歸屬已確認。
 * - 可重複呼叫：未定義／已退出的 child 直接視為完成（冪等）。
 * - 回傳**必須被檢查**的結果：`exited === false` 代表未能確認退出。
 *   需要「失敗即中斷」的呼叫端請用 `terminateChildOrThrow`／`terminateAll`。
 */
export async function terminateChild(
  child: ChildProcess | undefined,
  label: string,
  log?: (marker: string) => void,
  waitMs = 5000,
  options: TerminateOptions = {}
): Promise<TerminateResult> {
  const markers: string[] = [];
  const mark = (marker: string): void => {
    markers.push(marker);
    log?.(`stop:${label}:${marker}`);
  };
  const pid = child?.pid;
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    mark("already-exited");
    return { label, pid, exited: true, markers };
  }
  if (typeof pid !== "number") {
    // spawn 失敗（例如執行檔不存在）：程序從未存在，沒有可清理的對象。
    // 若不這樣判定，`waitForExit` 會等到逾時並誤報成「清理失敗」。
    mark("spawn-failed");
    return { label, pid, exited: true, markers };
  }
  mark(`requested:pid=${pid}`);

  const killCommand =
    options.killCommand === undefined ? defaultKillCommand() : options.killCommand;
  const wait = options.runtime?.wait ?? waitForExit;
  if (killCommand) {
    const { ok } = await (options.runtime?.execute ?? execFileBounded)(
      killCommand.file,
      killCommand.buildArgs(Number(pid)),
      killCommand.timeoutMs ?? options.killTimeoutMs ?? 5_000
    );
    if (!ok) mark("kill-command-failed");
  } else {
    try {
      child.kill("SIGTERM");
    } catch {
      // 已退出等情況，交由 waitForExit 判定。
    }
    if (await wait(child, waitMs)) {
      mark("exited:signal");
      return { label, pid, exited: true, markers };
    }
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }

  if (await wait(child, waitMs)) {
    mark("exited:escalated");
    return { label, pid, exited: true, markers };
  }
  // 未能確認退出：這是**失敗**，不得靜默當成功。
  mark("STILL-RUNNING");
  return { label, pid, exited: false, markers };
}

/** `terminateChild` 的失敗即拋版本（固定錯誤訊息，只帶 label）。 */
export async function terminateChildOrThrow(
  child: ChildProcess | undefined,
  label: string,
  log?: (marker: string) => void,
  waitMs = 5000,
  options: TerminateOptions = {}
): Promise<TerminateResult> {
  const result = await terminateChild(child, label, log, waitMs, options);
  if (!result.exited)
    throw new Error(`${PROCESS_CLEANUP_FAILED}:${label}`);
  return result;
}

/**
 * 依序清理多個自有服務；**一項失敗也繼續清理其餘**，最後彙總。
 * 不會因為第一個 throw 就把第二個程序留著。
 */
export async function terminateAll(
  entries: Array<{ child: ChildProcess | undefined; label: string }>,
  log?: (marker: string) => void,
  waitMs = 5000,
  options: TerminateOptions = {}
): Promise<TerminateOutcome> {
  const results: TerminateResult[] = [];
  for (const entry of entries) {
    try {
      results.push(await terminateChild(entry.child, entry.label, log, waitMs, options));
    } catch (error) {
      log?.(`stop:${entry.label}:threw`);
      results.push({
        label: entry.label,
        pid: entry.child?.pid,
        exited: false,
        markers: ["threw"],
      });
    }
  }
  const failed = results.filter(item => !item.exited);
  return { results, failed, verified: failed.length === 0 };
}

/** 彙總失敗並拋出固定錯誤；全部成功則直接回傳 outcome。 */
export function assertCleanupVerified(outcome: TerminateOutcome): TerminateOutcome {
  if (outcome.verified) return outcome;
  throw new Error(
    `${PROCESS_CLEANUP_FAILED}:${outcome.failed.map(item => item.label).join(",")}`
  );
}
