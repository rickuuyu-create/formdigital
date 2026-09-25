import { expect, type Page, type Request, type Response } from "@playwright/test";

/**
 * test-only 輔助：讓「保存完成」的等待真正有效（UX-TPL-01 階段 2 測試可靠性修正）。
 *
 * 背景：`TemplateEditor` 的 header 常駐顯示「DRAFT · 已保存至 localhost」
 * （`saveState` 初始即 `"saved"`，見 TemplateEditor.tsx:872），因此
 * `expect(getByText("DRAFT · 已保存至 localhost")).toBeVisible()` 會在**頁面
 * 一渲染**就通過，完全不能證明剛才的 saveDraftFields mutation 已完成。
 *
 * 更正（2026-09-21 第二輪）：前一版註解曾寫「`mark-position-editor.spec.ts`
 * WebKit 間歇失敗即由此而生」——那是**過度因果聲明**，現已移除。常駐文字只能
 * 證明「這個等待信號本身無效」，不能證明 WebKit 失敗的唯一成因：DOM 位移可能
 * 只是 preview，發出的請求也可能尚未包含 commit 結果。該歸因未經證實，
 * `mpe` WebKit 位移遺失目前仍為 `NOT PROVEN`（見 Task 四）。
 *
 * 本模組提供：
 *  - `saveDraftAndConfirmFor`：在觸發 Save **之前**登記監聽器，點擊後只接受
 *    「本次觸發之後發出」且「按 procedure 與 batch index 精確對位」的
 *    saveDraftFields 回應；同時核對目標 version 與本次預期保存內容，不讓
 *    其他版本或同版本的舊 autosave 誤滿足。
 *  - 沒有新請求時（已被 autosave 落盤）：**逾時本身不是證據**，一律改由
 *    精確正式讀回（`getVersionDetails` ＋ 目標 field ID ＋ 預期幾何）判定。
 *  - `saveDraftAndConfirm`：舊簽名的薄包裝，保留既有呼叫點。
 */

/** tRPC procedure 名稱（點號，不是斜線）。 */
export const SAVE_PROCEDURE = "formdigital.templates.saveDraftFields";

const TRPC_MARKER = "/api/trpc/";

/** 等待期間頁面被關閉的固定錯誤標記（不得被當成「逾時」吞掉）。 */
export const SAVE_WAIT_PAGE_CLOSED = "SAVE_WAIT_PAGE_CLOSED";

/* ------------------------------------------------------------------ *
 * 1. httpBatchLink 批次解析
 * ------------------------------------------------------------------ */

export type BatchEntry = { index: number; body: any };

/** 從 tRPC URL 取出批次裡的 procedure 名稱（依序，對應 batch index）。 */
export function proceduresFromUrl(url: string): string[] {
  const withoutQuery = url.split("?")[0] ?? "";
  const at = withoutQuery.indexOf(TRPC_MARKER);
  if (at < 0) return [];
  return withoutQuery
    .slice(at + TRPC_MARKER.length)
    .split(",")
    .filter(Boolean)
    .map(item => {
      try {
        return decodeURIComponent(item);
      } catch {
        return item;
      }
    });
}

function queryValue(url: string, key: string): string | undefined {
  const query = url.split("?")[1] ?? "";
  for (const part of query.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const name = eq < 0 ? part : part.slice(0, eq);
    if (name !== key) continue;
    const raw = eq < 0 ? "" : part.slice(eq + 1);
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}

/** 解析失敗一律回傳 undefined，不丟出內容、不印 body 片段。 */
export function safeJsonParse(text: string | null | undefined): unknown {
  if (typeof text !== "string" || text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * 批次本體正規化：可能是陣列（`[{…},{…}]`），也可能是以 batch index 為鍵的
 * 物件（`{"0":{…},"1":{…}}`），或單筆未批次 envelope。一律回傳 `[{index,body}]`。
 */
export function normalizeBatchEntries(payload: unknown): BatchEntry[] {
  if (Array.isArray(payload))
    return payload.map((body, index) => ({ index, body }));
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const keys = Object.keys(record);
    const numeric = keys.filter(key => /^(0|[1-9][0-9]*)$/.test(key));
    if (numeric.length > 0 && numeric.length === keys.length)
      return numeric
        .map(key => ({ index: Number(key), body: record[key] }))
        .sort((a, b) => a.index - b.index);
    return [{ index: 0, body: payload }];
  }
  return [];
}

function unwrapEnvelope(entry: any): any {
  if (entry && typeof entry === "object" && "json" in (entry as Record<string, unknown>))
    return (entry as Record<string, unknown>).json;
  return entry;
}

/** 取出批次輸入：優先 `?input=`（httpBatchLink），其次 POST body。 */
export function batchInputsFrom(
  url: string,
  postData: string | null | undefined
): BatchEntry[] {
  const fromQuery = safeJsonParse(queryValue(url, "input"));
  return normalizeBatchEntries(
    fromQuery !== undefined ? fromQuery : safeJsonParse(postData)
  );
}

export type SaveInputEntry = { index: number; input: any };

export type SaveInputParse =
  | { entries: SaveInputEntry[]; reason: null }
  | { entries: []; reason: SaveSkipReason };

export type SaveSkipReason =
  | "not-post"
  | "not-save-procedure"
  | "no-batch-input"
  | "batch-shape-mismatch"
  | "version-mismatch"
  | "payload-target-missing"
  | "payload-geometry-mismatch"
  | "no-response-entry"
  | "business-error"
  | "response-version-mismatch"
  | "response-unparsed";

/**
 * 依「procedure ＋ 對應 batch index」取出本次請求中真正的 saveDraftFields
 * 輸入。**不會**永遠取 `payload[0]`；當 procedure 數量與輸入筆數對不起來時
 * fail closed（回傳 `batch-shape-mismatch`），不猜測。
 */
export function saveInputEntries(
  url: string,
  postData: string | null | undefined
): SaveInputParse {
  const procedures = proceduresFromUrl(url);
  if (procedures.length === 0) return { entries: [], reason: "not-save-procedure" };
  const entries = batchInputsFrom(url, postData);
  if (entries.length === 0) return { entries: [], reason: "no-batch-input" };
  if (procedures.length > 1 && procedures.length !== entries.length)
    return { entries: [], reason: "batch-shape-mismatch" };
  const picked: SaveInputEntry[] = [];
  for (const { index, body } of entries) {
    const procedure =
      procedures.length === entries.length ? procedures[index] : procedures[0];
    if (procedure !== SAVE_PROCEDURE) continue;
    picked.push({ index, input: unwrapEnvelope(body) });
  }
  if (picked.length === 0) return { entries: [], reason: "not-save-procedure" };
  return { entries: picked, reason: null };
}

/* ------------------------------------------------------------------ *
 * 2. 目標欄位與預期內容
 * ------------------------------------------------------------------ */

/**
 * 目標欄位的精確檢查。`fieldId` 是 `stableFieldId`（＝客戶端 `field.id`，
 * 見 `client/src/lib/product-types.ts` 的雙向映射）。
 *
 * `assertField` 同時作用於兩種物件，故可同時核對「發出的 draft payload 項目」
 * 與「正式讀回的欄位」：
 *  - saveDraftFields 輸入項目：`{ stableFieldId, fieldType, displayOrder, definition, coordinate }`
 *  - getVersionDetails 讀回欄位：`{ id, stableFieldId, fieldType, definition, coordinate }`
 *
 * 不符合就拋錯（拋錯即「尚未落盤／不是這一次要的內容」）。
 */
export type SaveTarget = {
  fieldId: string;
  assertField: (field: any) => void;
};

/** 依 stableFieldId 取回正式讀回的欄位；找不到回 undefined。 */
export function findPersistedField(details: any, fieldId: string): any {
  const fields = details?.fields as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(fields)) return undefined;
  return fields.find(
    field => field && (field.stableFieldId === fieldId || field.id === fieldId)
  );
}

function payloadMatchesTarget(
  input: any,
  versionId: string,
  target: SaveTarget | undefined
): SaveSkipReason | null {
  if (!input || typeof input !== "object") return "no-batch-input";
  if (input.versionId !== versionId) return "version-mismatch";
  if (!target) return null;
  const fields = input.fields;
  if (!Array.isArray(fields)) return "payload-target-missing";
  const field = fields.find(
    (item: any) => item && item.stableFieldId === target.fieldId
  );
  if (!field) return "payload-target-missing";
  try {
    target.assertField(field);
  } catch {
    return "payload-geometry-mismatch";
  }
  return null;
}

export type SaveMatch =
  | { ok: true; index: number }
  | { ok: false; reason: SaveSkipReason };

/**
 * 精確驗證一個 response 是否「本次預期的 saveDraftFields 成功回應」。
 *
 * 檢查順序：方法 → procedure ＋ batch index → 請求輸入的目標 version／預期內容
 * → 回應本體同 index 的 `result.data`（tRPC 業務錯誤是 HTTP 200 但沒有
 * `result.data`）→ 回應的 versionId。任何一關不符都是 `ok:false`，理由為固定
 * 字串，**不輸出 body、token 或使用者內容**。
 */
export async function validateSaveResponse(
  response: Response,
  options: { versionId: string; target?: SaveTarget }
): Promise<SaveMatch> {
  const request = response.request();
  if (request.method() !== "POST") return { ok: false, reason: "not-post" };
  const url = response.url();
  const parsed = saveInputEntries(url, request.postData());
  if (parsed.reason) return { ok: false, reason: parsed.reason };

  let responseText: string | undefined;
  try {
    responseText = await response.text();
  } catch {
    responseText = undefined;
  }
  const responsePayload = safeJsonParse(responseText);
  if (responsePayload === undefined)
    return { ok: false, reason: "response-unparsed" };
  const responseEntries = normalizeBatchEntries(responsePayload);
  if (responseEntries.length === 0)
    return { ok: false, reason: "response-unparsed" };

  let lastPayloadProblem: SaveSkipReason | null = null;
  for (const { index, input } of parsed.entries) {
    const payloadProblem = payloadMatchesTarget(input, options.versionId, options.target);
    if (payloadProblem) {
      lastPayloadProblem = payloadProblem;
      continue;
    }
    const item = responseEntries.find(entry => entry.index === index)?.body;
    if (!item || typeof item !== "object")
      return { ok: false, reason: "no-response-entry" };
    const data = unwrapEnvelope((item as any).result?.data);
    if (!data) return { ok: false, reason: "business-error" };
    if (data.versionId !== options.versionId)
      return { ok: false, reason: "response-version-mismatch" };
    return { ok: true, index };
  }
  // 走到這裡代表至少有一筆 save 輸入，但沒有一筆對得上目標 version／預期內容。
  return {
    ok: false,
    reason:
      lastPayloadProblem ??
      (options.target ? "payload-geometry-mismatch" : "version-mismatch"),
  };
}

/**
 * 驗證 saveDraftFields 回應是「本次預期的業務成功」，而非只有 HTTP 200。
 * 回傳成功對位到的 batch index，供測試記錄。
 */
export async function expectSaveResponseSuccess(
  response: Response,
  expectedVersionId: string,
  target?: SaveTarget
): Promise<number> {
  if (response.status() >= 400)
    throw new Error("saveDraftFields transport must succeed");
  const result = await validateSaveResponse(response, {
    versionId: expectedVersionId,
    target,
  });
  if (!result.ok)
    throw new Error(
      `saveDraftFields response did not match the expected save (${result.reason})`
    );
  return result.index;
}

/** tRPC 回應體抽回 `result.data`（superjson）。 */
export function extractTrpcData(payload: unknown): any {
  const item = Array.isArray(payload) ? payload[0] : payload;
  const data = item?.result?.data;
  if (data && typeof data === "object" && "json" in data)
    return (data as Record<string, unknown>).json;
  return data;
}

/** 從目前 URL 取 versionId（`?view=editor&version=…`）。 */
export function versionIdFromUrl(page: Page): string {
  const match = page.url().match(/[?&]version=([^&]+)/);
  expect(match, "editor URL must carry the versionId").toBeTruthy();
  return decodeURIComponent(match![1]);
}

/** 既有正式讀取路徑：getVersionDetails（tRPC query）。 */
export async function getVersionDetails(
  page: Page,
  versionId: string
): Promise<any> {
  const response = await page.request.get(
    `/api/trpc/formdigital.templates.getVersionDetails?input=${encodeURIComponent(
      JSON.stringify({ json: { versionId } })
    )}`
  );
  if (response.status() !== 200)
    throw new Error(`getVersionDetails must succeed (status=${response.status()})`);
  return extractTrpcData(await response.json());
}

/**
 * 依 fieldType 取第一個欄位。
 *
 * 注意：這**不是**精確關聯（同一型別可能有多個欄位）。需要證明的等待請用
 * `SaveTarget`（fieldId）＋ `findPersistedField`。
 */
export function fieldOf(details: any, fieldType: string): any {
  const fields = details?.fields as
    | Array<Record<string, unknown>>
    | undefined;
  return fields?.find(field => field.fieldType === fieldType);
}

/* ------------------------------------------------------------------ *
 * 3. 有界等待與安全收尾
 * ------------------------------------------------------------------ */

type SaveWatcher = {
  promise: Promise<Response | null>;
  cancel: () => void;
};

/**
 * 手動監聽器（不用 `page.waitForResponse`），以便：
 *  - click 失敗時立刻 `cancel()`，不留 pending promise；
 *  - 頁面關閉時丟出固定錯誤，不被「逾時」吞掉；
 *  - 一律在 settle 時移除監聽器並清除計時器。
 */
function createSaveWatcher(
  page: Page,
  match: (response: Response) => Promise<SaveMatch>,
  timeoutMs: number,
  log?: (marker: string) => void
): SaveWatcher {
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settleFn: (value: Response | null) => void = () => {};
  let failFn: (error: unknown) => void = () => {};

  const promise = new Promise<Response | null>((resolve, reject) => {
    settleFn = resolve;
    failFn = reject;
  });
  // A page can close while click() is still pending, before the caller awaits us.
  void promise.catch(() => {});

  const cleanup = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    page.off("response", onResponse);
    page.off("close", onClose);
  };
  const finish = (value: Response | null) => {
    if (settled) return;
    settled = true;
    cleanup();
    settleFn(value);
  };
  const abort = (error: unknown) => {
    if (settled) return;
    settled = true;
    cleanup();
    failFn(error);
  };

  const onResponse = (response: Response) => {
    // 驗證本身若拋錯（例如 body 已被回收）只當「不匹配」，不得留下未處理拒絕。
    void match(response)
      .then(result => {
        if (result.ok) finish(response);
        else log?.(`save:skip:${result.reason}`);
      })
      .catch(() => log?.("save:skip:validation-error"));
  };
  const onClose = () => abort(new Error(SAVE_WAIT_PAGE_CLOSED));

  page.on("response", onResponse);
  page.on("close", onClose);
  timer = setTimeout(() => finish(null), timeoutMs);

  return { promise, cancel: () => finish(null) };
}

function isTrackedAfter(
  request: Request,
  baseline: number,
  seen: Map<Request, number>
): boolean {
  const seq = seen.get(request);
  return typeof seq === "number" && seq >= baseline;
}

async function poll(
  page: Page,
  fn: () => Promise<void>,
  timeoutMs: number,
  intervalMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      await fn();
      return;
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline) break;
    }
    await page.waitForTimeout(intervalMs);
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError ?? "poll failed"));
}

/* ------------------------------------------------------------------ *
 * 4. 觸發 Save 並等待真正完成
 * ------------------------------------------------------------------ */

export type SaveConfirmOptions = {
  /** 目標 versionId；請求與回應都必須是這個 version。 */
  versionId: string;
  /** 目標欄位 ID ＋ 預期幾何；同時用於 payload 關聯與正式讀回。 */
  target?: SaveTarget;
  /** 等待「本次觸發後的新請求」的界線（預設 8000ms）。 */
  timeoutMs?: number;
  /** 正式讀回輪詢界線（預設 12000ms）。 */
  readBackTimeoutMs?: number;
  readBackIntervalMs?: number;
  /** 診斷標記（只寫固定字串，不寫 body／token／使用者內容）。 */
  log?: (marker: string) => void;
};

export type SaveConfirmOutcome = {
  /** 是否真的等到「本次預期」的 saveDraftFields 成功回應。 */
  hadNewRequest: boolean;
  matchedIndex: number | null;
};

/**
 * 觸發 Save 並等待真正完成。
 *
 * 保證：
 *  1. 監聽器在 click **之前**掛上；click 之前的請求（含已在飛行中的 autosave）
 *     一律排除（以掛載後才開始編號的序號為界）。
 *  2. 只接受按 procedure ＋ batch index 精確對位、且輸入是「目標 version ＋
 *     本次預期內容」的回應；其他版本／同版本舊 payload 都不算。
 *  3. 沒有新請求時（已被 autosave 落盤）**不把逾時當證據**：改由精確正式讀回
 *     （目標 field ID ＋ 預期幾何）判定，讀不到就拋錯。
 *  4. click 失敗、等待超時、頁面關閉都會安全收尾監聽器；頁面關閉等錯誤原樣
 *     拋出，不會被當成「已 autosave」吞掉。
 */
export async function saveDraftAndConfirmFor(
  page: Page,
  options: SaveConfirmOptions,
  assertPersisted?: () => Promise<void>
): Promise<SaveConfirmOutcome> {
  const {
    versionId,
    target,
    timeoutMs = 8_000,
    readBackTimeoutMs = 12_000,
    readBackIntervalMs = 250,
    log,
  } = options;
  if (!assertPersisted && !target)
    throw new Error(
      "saveDraftAndConfirmFor needs either `target` or `assertPersisted`"
    );

  // 1) 觸發前掛上請求監聽器並取基準序號；掛載前就已發出的請求不會進來。
  const seen = new Map<Request, number>();
  let seq = 0;
  const onRequest = (request: Request) => {
    if (request.method() !== "POST") return;
    if (!request.url().includes(SAVE_PROCEDURE)) return;
    seen.set(request, seq++);
  };
  page.on("request", onRequest);
  const baseline = seq;
  log?.("save:registered");

  const watcher = createSaveWatcher(
    page,
    async response => {
      if (!isTrackedAfter(response.request(), baseline, seen))
        return { ok: false, reason: "not-save-procedure" };
      return validateSaveResponse(response, { versionId, target });
    },
    timeoutMs,
    log
  );

  let response: Response | null = null;
  try {
  try {
    // 2) 觸發。
    await page.getByRole("button", { name: /儲存|Save/ }).click();
  } catch (error) {
    // click 失敗：立刻收尾等待，錯誤原樣拋出。
    watcher.cancel();
    log?.("save:click-failed");
    throw error;
  }
  try {
    response = await watcher.promise;
  } catch (error) {
    // 只可能是頁面關閉等真實錯誤；逾時是 resolve(null)，不會到這裡。
    watcher.cancel();
    throw error;
  }

  let matchedIndex: number | null = null;
  if (response) {
    matchedIndex = await expectSaveResponseSuccess(response, versionId, target);
    log?.(`save:matched:index=${matchedIndex}`);
  } else {
    // 逾時本身不是已 autosave 的證據；只能靠下面的精確讀回判定。
    log?.("save:no-new-request");
  }

  // 3) 決定性：正式讀回，核對目標 field ID 與預期幾何。
  await poll(
    page,
    async () => {
      if (target) {
        const details = await getVersionDetails(page, versionId);
        const field = findPersistedField(details, target.fieldId);
        if (!field)
          throw new Error(
            `persisted field is missing (fieldId length=${String(target.fieldId).length})`
          );
        target.assertField(field);
      }
      if (assertPersisted) await assertPersisted();
    },
    readBackTimeoutMs,
    readBackIntervalMs
  );
  log?.("save:readback:ok");

  return { hadNewRequest: response !== null, matchedIndex };
  } finally {
    watcher.cancel();
    page.off("request", onRequest);
    seen.clear();
  }
}

/**
 * 舊簽名的薄包裝：`saveDraftAndConfirm(page, versionId, assertPersisted)`。
 * 需要精確關聯的版本請改用 `saveDraftAndConfirmFor` 並帶上 `target`。
 */
export async function saveDraftAndConfirm(
  page: Page,
  versionId: string,
  assertPersisted: () => Promise<void>
): Promise<SaveConfirmOutcome> {
  return saveDraftAndConfirmFor(page, { versionId }, assertPersisted);
}
