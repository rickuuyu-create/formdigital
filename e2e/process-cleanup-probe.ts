import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PROCESS_CLEANUP_FAILED,
  assertCleanupVerified,
  terminateAll,
  terminateChild,
  terminateChildOrThrow,
} from "./process-cleanup";

/**
 * test-only：隔離合成子程序，驗證 `terminateChild`／`terminateAll` 的清理行為。
 *
 * 用「合成的 node -e 子程序」與**故障注入**做測試，**不拿真實
 * local-data-service 或 web 服務來測，也不在真實 E2E 服務上還原舊的 SIGTERM
 * 行為來製造孤兒**。執行：`node node_modules/tsx/dist/cli.mjs
 * e2e/process-cleanup-probe.ts`。
 *
 * 2026-09-21 第二輪修正（回歸測試反例）：
 *  - 孫程序情境改為「先有界等待並斷言取得合法 PID 且孫程序確實存在」，再清理、
 *    再確認退出；不再把「沒拿到 PID」當成已退出。
 *  - 探針自己建立的程序一律在 `finally` 清理，失敗也不例外。
 *  - 未驗證的平台／情境標 `NOT VERIFIED`，不假通過。
 */

const node = process.execPath;

function childWith(code: string): ChildProcess {
  return spawn(node, ["-e", code], { stdio: "ignore", windowsHide: true });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Virtual child: used ONLY with the fully injected runtime below.
 * It is not an OS process and must never reach taskkill/process.kill.
 */
function virtualChild(pid: number): ChildProcess {
  return {
    pid,
    exitCode: null,
    signalCode: null,
    once: () => undefined,
    kill: () => { throw new Error("VIRTUAL_CHILD_REACHED_OS_BOUNDARY"); },
  } as unknown as ChildProcess;
}

/** 是否已退出：被訊號終止時 exitCode 為 null、signalCode 非空，也算退出。 */
function exited(child: ReturnType<typeof spawn>): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** 本探針自己建立、必須在收尾時清掉的程序。 */
const owned: ChildProcess[] = [];
/**
 * 登記本探針自己建立的程序，並吞掉 spawn 失敗的 `error` 事件。
 *
 * 必須監聽：Node 的 ChildProcess 在 spawn 失敗（ENOENT）時會發出 `error`，
 * 沒有監聽者會讓整個探針以 unhandled 'error' 崩潰——那樣反而測不到
 * `terminateChild` 的 `spawn-failed` 行為。這裡只吞事件，不改變判定。
 */
function own(child: ChildProcess): ChildProcess {
  child.on("error", () => {
    // 預期：spawn failure 情境。判定交由 terminateChild 的 pid 檢查。
  });
  owned.push(child);
  return child;
}

async function main(): Promise<void> {
  let failures = 0;
  const notVerified: string[] = [];
  const check = (name: string, ok: boolean, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
    if (!ok) failures += 1;
  };
  const markNotVerified = (name: string, why: string) => {
    notVerified.push(name);
    console.log(`NOT VERIFIED ${name} (${why})`);
  };

  try {
    // 1) 正常退出：子程序 ~200ms 後自行結束；terminateChild 應走「已退出」快速路徑。
    {
      const c = own(childWith("setTimeout(() => {}, 200)"));
      await sleep(900);
      const t0 = Date.now();
      const result = await terminateChild(c, "normal", undefined, 2000);
      check(
        "normal-exit already-exited (fast)",
        result.exited && exited(c) && Date.now() - t0 < 1000,
        `exited=${result.exited} exitCode=${c.exitCode} markers=${result.markers.join("|")}`
      );
    }

    // 2) 長駐子程序：須被終止（Windows 走 taskkill，其餘走 SIGTERM→SIGKILL）。
    {
      const c = own(childWith("setInterval(() => {}, 1000)"));
      const pid = c.pid!;
      const t0 = Date.now();
      const result = await terminateChild(c, "long-running", undefined, 2000);
      check(
        "long-running killed",
        result.exited && exited(c) && !isAlive(pid) && Date.now() - t0 < 6000,
        `exited=${result.exited} alive=${isAlive(pid)} markers=${result.markers.join("|")}`
      );
    }

    // 3a) 啟動中即退出（已死）：terminateChild 應無副作用處理。
    {
      const c = own(childWith("process.exit(7)"));
      await sleep(900);
      const result = await terminateChild(c, "already-dead", undefined, 2000);
      check(
        "already-dead handled",
        result.exited && exited(c),
        `exitCode=${c.exitCode} markers=${result.markers.join("|")}`
      );
    }

    // 3b) 啟動失敗（執行檔不存在）：程序從未存在，必須判定為「無可清理」且
    //     不得等到逾時才回報成清理失敗。
    {
      const c = own(
        spawn(path.join(os.tmpdir(), "no-such-executable-ux-tpl.exe"), [], {
          stdio: "ignore",
          windowsHide: true,
        })
      );
      const t0 = Date.now();
      const result = await terminateChild(c, "spawn-failed", undefined, 1500);
      check(
        "spawn failure reported as nothing-to-clean (bounded)",
        result.exited &&
          result.markers.includes("spawn-failed") &&
          Date.now() - t0 < 3000,
        `exited=${result.exited} markers=${result.markers.join("|")} elapsed=${Date.now() - t0}ms`
      );
    }

    // 4) 重複呼叫（冪等）：同一 child 再終止一次，不拋錯、仍視為已退出。
    {
      const c = own(childWith("setInterval(() => {}, 1000)"));
      const first = await terminateChild(c, "repeat-1", undefined, 2000);
      const second = await terminateChild(c, "repeat-2", undefined, 2000);
      check(
        "repeat idempotent",
        first.exited && second.exited && exited(c),
        `first=${first.markers.join("|")} second=${second.markers.join("|")}`
      );
    }

    // 5) 未定義 child：直接返回不拋錯。
    {
      const result = await terminateChild(undefined, "none", undefined, 2000);
      check("undefined child handled", result.exited);
    }

    // 6) 終止命令「失敗」：注入一個一定失敗的 kill command，且 child 不會自己
    //    退出 → 必須回報 exited=false，`terminateChildOrThrow` 必須拋出。
    {
      const c = own(childWith("setInterval(() => {}, 1000)"));
      const failingKill = {
        file: node,
        buildArgs: () => ["-e", "process.exit(1)"],
        timeoutMs: 3000,
      };
      const result = await terminateChild(c, "kill-fails", undefined, 800, {
        killCommand: failingKill,
      });
      check(
        "kill command failure is reported (not a silent success)",
        result.exited === false && result.markers.includes("STILL-RUNNING"),
        `exited=${result.exited} markers=${result.markers.join("|")}`
      );
      let threw = "";
      try {
        await terminateChildOrThrow(c, "kill-fails-throw", undefined, 800, {
          killCommand: failingKill,
        });
      } catch (error) {
        threw = (error as Error).message;
      }
      check(
        "terminateChildOrThrow throws a fixed error on failure",
        threw.startsWith(`${PROCESS_CLEANUP_FAILED}:`),
        `message=${JSON.stringify(threw)}`
      );
      // 收尾：改用真正的終止命令把這個合成程序清掉。
      const recovered = await terminateChild(c, "kill-fails-recover", undefined, 2000);
      check("synthetic child recovered with the real kill command", recovered.exited);
    }

    // 7) 終止命令「卡住」：注入一個不會自己結束的 kill command → 整段仍必須有界。
    {
      const c = own(childWith("setInterval(() => {}, 1000)"));
      const hangingKill = {
        file: node,
        buildArgs: () => ["-e", "setInterval(() => {}, 5000)"],
        timeoutMs: 700,
      };
      const t0 = Date.now();
      const result = await terminateChild(c, "kill-hangs", undefined, 800, {
        killCommand: hangingKill,
      });
      const elapsed = Date.now() - t0;
      check(
        "hanging kill command stays bounded",
        elapsed < 4000,
        `elapsed=${elapsed}ms exited=${result.exited} markers=${result.markers.join("|")}`
      );
      const recovered = await terminateChild(c, "kill-hangs-recover", undefined, 2000);
      check("synthetic child recovered after the hanging command", recovered.exited);
    }

    // 8) terminateAll：一項失敗也要清理另一項，最後彙總失敗。
    //
    // Entirely virtual: both termination and exit observation are injected.
    {
      const good = virtualChild(100002);
      const unkillable = virtualChild(100001);
      const intercepted: string[] = [];
      const outcome = await terminateAll(
        [
          { child: unkillable, label: "all-bad" },
          { child: good, label: "all-good" },
        ],
        undefined,
        800,
        {
          killCommand: { file: "VIRTUAL_ONLY", buildArgs: pid => [String(pid)] },
          runtime: {
            execute: async (file, args) => {
              if (file !== "VIRTUAL_ONLY") throw new Error("UNEXPECTED_OS_COMMAND");
              intercepted.push(args[0]!);
              return { ok: args[0] === String(good.pid) };
            },
            wait: async child => child === good,
          },
        }
      );
      const badResult = outcome.results.find(item => item.label === "all-bad");
      const goodResult = outcome.results.find(item => item.label === "all-good");
      check(
        "terminateAll still cleans the second service after the first fails",
        badResult?.exited === false &&
          goodResult?.exited === true &&
          intercepted.join(",") === "100001,100002" &&
          outcome.verified === false &&
          outcome.failed.length === 1 &&
          outcome.failed[0]?.label === "all-bad",
        `verified=${outcome.verified} failed=[${outcome.failed.map(i => i.label).join(",")}]`
      );
      let aggregateThrew = "";
      try {
        assertCleanupVerified(outcome);
      } catch (error) {
        aggregateThrew = (error as Error).message;
      }
      check(
        "assertCleanupVerified aggregates failures into a fixed error",
        aggregateThrew === `${PROCESS_CLEANUP_FAILED}:all-bad`,
        `message=${JSON.stringify(aggregateThrew)}`
      );
    }

    // 9) 子孫樹：先**有界等待並斷言**取得合法孫 PID 且孫程序確實存在，再清理。
    {
      const marker = path.join(
        os.tmpdir(),
        `pc-probe-grandchild-${process.pid}-${Date.now()}.txt`
      );
      const parent = own(
        childWith(
          `const { spawn } = require("child_process");
           const fs = require("fs");
           const g = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
           fs.writeFileSync(${JSON.stringify(marker)}, String(g.pid));
           setInterval(()=>{}, 1000);`
        )
      );
      let gpid = Number.NaN;
      try {
        gpid = await waitForGrandchildPid(marker, 5000);
        check(
          "tree: grandchild PID obtained and valid",
          Number.isInteger(gpid) && gpid > 0 && gpid !== parent.pid,
          `gpid=${String(gpid)}`
        );
        check(
          "tree: grandchild is really alive before cleanup",
          Number.isInteger(gpid) && gpid > 0 && isAlive(gpid),
          `alive=${isAlive(gpid)}`
        );
        const rootPid = parent.pid!;
        const result = await terminateChild(parent, "tree", undefined, 3000);
        check(
          "tree: root exited",
          result.exited && exited(parent) && !isAlive(rootPid),
          `exited=${result.exited} markers=${result.markers.join("|")}`
        );
        if (process.platform === "win32") {
          check(
            "tree: grandchild exited (win32 taskkill /T)",
            !isAlive(gpid),
            `alive=${isAlive(gpid)}`
          );
        } else {
          markNotVerified(
            "tree: grandchild exited",
            `${process.platform} uses SIGTERM/SIGKILL on the direct child only`
          );
        }
      } finally {
        // 不論成敗都清理自己建立的程序。
        const finalRoot = await terminateChild(parent, "tree-final", undefined, 2000);
        if (!finalRoot.exited) console.log("WARN tree-final root still running");
        if (Number.isInteger(gpid) && gpid > 0 && isAlive(gpid)) {
          try {
            process.kill(gpid);
          } catch {
            // 已退出等情況，忽略。
          }
        }
        try {
          fs.rmSync(marker, { force: true });
        } catch {
          // ignore
        }
      }
    }
  } finally {
    // 收尾：任何殘留的自有合成程序都要再清一次。
    for (const child of owned) {
      if (!exited(child)) await terminateChild(child, "probe-final", undefined, 1500);
    }
  }

  // 只有「曾成功 spawn（有 pid）且尚未退出」才算殘留。spawn 失敗的 child 永不
  // 發出 `exit`（只發 `error`／`close`），exitCode 保持 null，若一律算殘留會
  // 把「從未存在的程序」誤判成清理失敗。
  const stillRunning = owned.filter(child => child.pid !== undefined && !exited(child)).length;
  console.log(
    `SUMMARY failures=${failures} notVerified=${notVerified.length} ownedChildren=${owned.length} stillRunning=${stillRunning}`
  );
  for (const item of notVerified) console.log(`  NOT VERIFIED: ${item}`);
  if (failures > 0 || stillRunning > 0) {
    console.log("FAILURES");
    process.exit(1);
  }
  console.log("ALL PASS");
  process.exit(0);
}

/** 有界輪詢孫程序 PID：必須取得正整數且該程序確實存在，否則回 NaN。 */
async function waitForGrandchildPid(marker: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let raw = "";
    try {
      if (fs.existsSync(marker)) raw = fs.readFileSync(marker, "utf8").trim();
    } catch {
      raw = "";
    }
    const pid = Number(raw);
    if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) return pid;
    await sleep(100);
  }
  return Number.NaN;
}

void main();
