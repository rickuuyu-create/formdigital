import type { Page, Request, Response } from "@playwright/test";
import {
  SAVE_PROCEDURE,
  findPersistedField,
  normalizeBatchEntries,
  proceduresFromUrl,
  safeJsonParse,
  saveInputEntries,
} from "./save-completion";

/**
 * test-only：`mark-position-editor.spec.ts` 的「位移遺失」定位追蹤。
 *
 * 目的：把**同一個 versionId ＋ 同一個 fieldId** 的整條鏈路串成一條有序軌跡——
 *
 *   pointer 事件順序 → DOM 預覽座標 → 發出的保存 payload → 對應業務回應 → 正式讀回
 *
 * 好讓「拖動結果沒落盤」這件事能被**定位**（客戶端沒序列化出去？還是伺服器沒寫入／
 * 被正規化覆寫？），而不需要去猜。
 *
 * 硬性邊界（2026-09-21 第二輪）：
 *  - **不宣告產品端故障**。DOM 位移可能只是 preview（尚未 commit），請求也可能
 *    還沒帶到 commit 的結果；本檔只記錄事實，不寫結論。
 *  - **安全輸出**：只輸出必要座標與安全識別；解析失敗一律用**固定訊息**，
 *    不印 body 片段、token 或使用者內容。
 *  - **正確解析 batch**：`httpBatchLink` 的本體可能是陣列，也可能是以 batch index
 *    為鍵的物件（`{"0": …}`），且一次請求可含多個 procedure；一律走
 *    `saveInputEntries`／`normalizeBatchEntries`，不取 `payload[0]`。
 *  - **記錄所有相關保存事件的順序**，不是只留最後一個請求。
 *  - 監聽器一律可 `close()` 收尾；不留下未處理的 rejection。
 */

/** 預先限定的獨立診斷次數上限：最多 3 次，未重現就標 `NOT REPRODUCED`。 */
export const MAX_MARK_POSITION_DIAGNOSTICS = 3;

/** 超過預先限定的診斷預算就中止，不再跑到全綠。 */
export function checkDiagnosticBudget(attempt: number): void {
  if (!Number.isInteger(attempt) || attempt < 1)
    throw new Error("MARK_POSITION_DIAG_BAD_ATTEMPT");
  if (attempt > MAX_MARK_POSITION_DIAGNOSTICS)
    throw new Error(`MARK_POSITION_DIAG_BUDGET_EXCEEDED:${attempt}`);
}

/** 解析失敗等情況的固定訊息：一律不含 body 片段。 */
const UNPARSED = "payload-unparsed";

export type TraceKind =
  | "pointer"
  | "dom"
  | "save-request"
  | "save-response"
  | "readback"
  | "note";

export type TraceEvent = { seq: number; kind: TraceKind; text: string };

export type TraceOptions = {
  versionId: string;
  /** 目標欄位識別（stableFieldId ＝ 客戶端 field.id），兩條鏈路共用同一個值。 */
  fieldId: string;
  /** 幾何資料在 `definition` 下的鍵，例如 `optionMarks`／`tableCellGuides`。 */
  geometryKey: string;
  /** 要看幾何陣列的第幾項（預設 0）。 */
  geometryIndex?: number;
  /** 只輸出這些座標欄位（預設 xRatio、yRatio）。 */
  geometryFields?: string[];
  /** 軌跡上限，避免長時間拖動把記憶體吃滿（預設 40）。 */
  maxEvents?: number;
};

export type MarkPositionTrace = {
  readonly fieldId: string;
  pointer: (phase: "down" | "move" | "up", x: number, y: number) => void;
  dom: (x: number, y: number) => void;
  note: (text: string) => void;
  /** 正式讀回（getVersionDetails 結果）後呼叫，核對目標 fieldId。 */
  readback: (details: unknown) => void;
  /** 單行摘要；平時不印，只在失敗或 `MPE_DIAG=1` 時輸出。 */
  summary: () => string;
  events: () => TraceEvent[];
  close: () => void;
};

const round = (value: number): string => String(Math.round(value * 10_000) / 10_000);

/**
 * 只輸出必要座標：從 `definition[geometryKey][geometryIndex]` 取指定欄位；
 * 缺任何一層都回固定形狀的訊息，不含內容。
 */
function geometryText(
  source: any,
  geometryKey: string,
  geometryIndex: number,
  geometryFields: string[]
): string {
  const list = source?.definition?.[geometryKey];
  if (!Array.isArray(list)) return `${geometryKey}=absent`;
  const item = list[geometryIndex];
  if (!item || typeof item !== "object") return `${geometryKey}[${geometryIndex}]=absent`;
  const parts = geometryFields.map(key => {
    const value = (item as Record<string, unknown>)[key];
    return typeof value === "number" ? `${key}=${round(value)}` : `${key}=n/a`;
  });
  return parts.join(",");
}

/**
 * 掛上追蹤監聽器。回傳的物件必須在測試結束（含失敗）時 `close()`。
 */
export function createMarkPositionTrace(
  page: Page,
  options: TraceOptions
): MarkPositionTrace {
  const {
    versionId,
    fieldId,
    geometryKey,
    geometryIndex = 0,
    geometryFields = ["xRatio", "yRatio"],
    maxEvents = 40,
  } = options;

  const events: TraceEvent[] = [];
  let seq = 0;
  let truncated = false;

  const push = (kind: TraceKind, text: string): void => {
    seq += 1;
    if (events.length >= maxEvents) {
      if (!truncated) {
        truncated = true;
        events.push({ seq, kind: "note", text: `trace-truncated:${maxEvents}` });
      }
      return;
    }
    events.push({ seq, kind, text });
  };

  const geomOf = (source: any): string =>
    geometryText(source, geometryKey, geometryIndex, geometryFields);

  /** 已看到的 save 請求 → 其 batch index 清單，供回應對位。 */
  const pending = new Map<Request, number[]>();

  const onRequest = (request: Request): void => {
    try {
      if (request.method() !== "POST") return;
      const url = request.url();
      if (!url.includes("/api/trpc/")) return;
      const parsed = saveInputEntries(url, request.postData());
      const isSaveUrl = proceduresFromUrl(url).includes(SAVE_PROCEDURE);
      if (parsed.reason || parsed.entries.length === 0) {
        // 只對「確實是 save procedure」的請求留痕，且理由採固定訊息。
        if (isSaveUrl) push("save-request", `${UNPARSED}:${parsed.reason ?? "no-entry"}`);
        return;
      }
      pending.set(request, parsed.entries.map(entry => entry.index));
      for (const { index, input } of parsed.entries) {
        const version = input?.versionId === versionId ? "ver=ok" : "ver=other";
        const draft =
          Array.isArray(input?.fields) && fieldId
            ? (input.fields as any[]).find(
                (item: any) => item && item.stableFieldId === fieldId
              )
            : undefined;
        const target = draft ? "target=present" : "target=missing";
        const geom = draft ? geomOf(draft) : `${geometryKey}=none`;
        push("save-request", `idx=${index} ${version} ${target} ${geom}`);
      }
    } catch {
      push("save-request", UNPARSED);
    }
  };

  const onResponse = (response: Response): void => {
    const request = response.request();
    const indices = pending.get(request);
    if (!indices) return;
    pending.delete(request);
    void (async () => {
      let payload: unknown;
      try {
        payload = safeJsonParse(await response.text());
      } catch {
        payload = undefined;
      }
      const entries = normalizeBatchEntries(payload);
      if (entries.length === 0) {
        push("save-response", `status=${response.status()} ${UNPARSED}`);
        return;
      }
      for (const index of indices) {
        const body = entries.find(entry => entry.index === index)?.body;
        const data = body?.result?.data;
        const json =
          data && typeof data === "object" && "json" in data
            ? (data as Record<string, unknown>).json
            : undefined;
        const outcome = json ? "ok" : "business-error";
        const version =
          json && typeof json === "object" && (json as any).versionId === versionId
            ? "ver=ok"
            : "ver=other-or-absent";
        push("save-response", `idx=${index} status=${response.status()} ${outcome} ${version}`);
      }
    })().catch(() => {
      push("save-response", `status=${response.status()} ${UNPARSED}`);
    });
  };

  const onClose = (): void => {
    push("note", "page-closed");
  };

  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("close", onClose);

  return {
    fieldId,
    pointer(phase, x, y) {
      push("pointer", `${phase} x=${round(x)} y=${round(y)}`);
    },
    dom(x, y) {
      push("dom", `x=${round(x)} y=${round(y)}`);
    },
    note(text) {
      push("note", text);
    },
    readback(details) {
      const field = findPersistedField(details, fieldId);
      push(
        "readback",
        field ? `target=present ${geomOf(field)}` : "target=missing"
      );
    },
    summary() {
      const body = events
        .map(event => `${event.seq}:${event.kind}=${event.text}`)
        .join(" | ");
      return `MPE-TRACE field=${fieldId} ${body}`;
    },
    events() {
      return events.slice();
    },
    close() {
      page.off("request", onRequest);
      page.off("response", onResponse);
      page.off("close", onClose);
      pending.clear();
    },
  };
}

/** 平時不印雜訊：只有開 `MPE_DIAG=1` 才在成功路徑也輸出軌跡。 */
export function shouldPrintTrace(): boolean {
  return process.env.MPE_DIAG === "1";
}
