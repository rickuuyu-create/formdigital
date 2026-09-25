/**
 * test-only 合成回歸：證明「保存完成等待」的精確關聯行為
 * （UX-TPL-01 階段 2 測試可靠性修正／第二輪 Task 一）。
 *
 * 執行：`tsx e2e/save-completion.probe.ts`
 * - exit 0 = 全部通過；exit 1 = 至少一項失敗。
 * - 全程**不啟動真實瀏覽器、不操作真實 Draft、不讀任何秘密**：用一個假的
 *   Page／Request／Response 直接驅動 `e2e/save-completion.ts` 的正式邏輯。
 * - 另含 `LEGACY` 區：逐字重現**修正前**的舊演算法（舊 predicate ＋
 *   永遠取 `payload[0]` 的 `extractTrpcData`），作為反例證據。LEGACY 區的
 *   「通過」代表**缺陷確實存在**，不代表產品行為正確。
 */

import type { Page, Request, Response } from "@playwright/test";
import {
  SAVE_PROCEDURE,
  SAVE_WAIT_PAGE_CLOSED,
  extractTrpcData,
  normalizeBatchEntries,
  proceduresFromUrl,
  saveDraftAndConfirmFor,
  saveInputEntries,
  validateSaveResponse,
  type SaveTarget,
} from "./save-completion";

/* ------------------------------------------------------------------ *
 * 舊演算法逐字重現（修正前的 e2e/save-completion.ts，僅供反例對照）
 * ------------------------------------------------------------------ */

function legacyExtractTrpcData(payload: unknown): any {
  const item = Array.isArray(payload) ? payload[0] : payload;
  const data = item?.result?.data;
  if (data && typeof data === "object" && "json" in data)
    return (data as Record<string, unknown>).json;
  return data;
}

/** 修正前的等待 predicate：只比 URL substring 與 POST。 */
function legacyPredicate(url: string, method: string): boolean {
  return url.includes("formdigital.templates.saveDraftFields") && method === "POST";
}

/** 修正前的成功驗證：只看回應 body 的 versionId。 */
function legacyVersionCheck(body: unknown, expectedVersionId: string): boolean {
  const data = legacyExtractTrpcData(body);
  return Boolean(data) && data?.versionId === expectedVersionId;
}

/* ------------------------------------------------------------------ *
 * 假 Page／Request／Response
 * ------------------------------------------------------------------ */

type Exchange = {
  delayMs: number;
  procedures: string[];
  input: unknown;
  status?: number;
  body: unknown;
  persist?: boolean;
};

type Plan = {
  versionId: string;
  initial: Record<string, any[]>;
  exchanges: Exchange[];
  clickError?: Error;
  closeMs?: number;
};

function buildTrpcUrl(procedures: string[], input: unknown): string {
  const encoded = encodeURIComponent(JSON.stringify(input));
  return `http://127.0.0.1:3210/api/trpc/${procedures.join(",")}?batch=1&input=${encoded}`;
}

function makeRequest(url: string, postData: string | null): Request {
  return {
    url: () => url,
    method: () => "POST",
    postData: () => postData,
  } as unknown as Request;
}

function makeResponse(request: Request, status: number, body: string): Response {
  return {
    url: () => request.url(),
    status: () => status,
    text: () => Promise.resolve(body),
    request: () => request,
  } as unknown as Response;
}

class FakePage {
  private handlers = new Map<string, Array<(arg: unknown) => void>>();
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  public emittedMarkers: string[] = [];
  public state: Record<string, any[]>;

  constructor(private plan: Plan) {
    this.state = JSON.parse(JSON.stringify(plan.initial)) as Record<string, any[]>;
  }

  on(event: string, handler: (arg: unknown) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  off(event: string, handler: (arg: unknown) => void): void {
    const list = this.handlers.get(event) ?? [];
    this.handlers.set(
      event,
      list.filter(item => item !== handler)
    );
  }

  emit(event: string, arg?: unknown): void {
    for (const handler of [...(this.handlers.get(event) ?? [])]) handler(arg);
  }

  waitForTimeout(ms: number): Promise<void> {
    return new Promise(resolve => {
      this.timers.push(setTimeout(resolve, ms));
    });
  }

  request = {
    get: async (url: string) => {
      const match = /versionId\\":\\"([^\\"]+)/.exec(url) ?? /versionId=([^&"]+)/.exec(url);
      const versionId = match ? match[1] : this.plan.versionId;
      const fields = this.state[versionId] ?? [];
      return {
        status: () => 200,
        json: () =>
          Promise.resolve([
            { result: { data: { json: { template: null, version: null, fields } } } },
          ]),
      };
    },
  };

  getByRole(_role: string, _options: unknown): { click: () => Promise<void> } {
    return {
      click: async () => {
        if (this.plan.clickError) throw this.plan.clickError;
        for (const exchange of this.plan.exchanges) {
          const url = buildTrpcUrl(exchange.procedures, exchange.input);
          // 同一個 Request 物件必須同時交給 request 監聽器與 response，
          // 否則「本次觸發之後發出」的序號關聯會對不起來。
          const request = makeRequest(url, null);
          this.emit("request", request);
          this.timers.push(
            setTimeout(() => {
              const payload = exchange.input as Record<string, any> | null;
              if (exchange.persist !== false && payload && typeof payload === "object") {
                const entries = normalizeBatchEntries(payload);
                for (const { body } of entries) {
                  const input = (body as any)?.json ?? body;
                  if (input && typeof input === "object" && Array.isArray(input.fields)) {
                    this.state[String(input.versionId)] = input.fields;
                  }
                }
              }
              this.emit(
                "response",
                makeResponse(request, exchange.status ?? 200, JSON.stringify(exchange.body))
              );
            }, exchange.delayMs)
          );
        }
        if (typeof this.plan.closeMs === "number") {
          this.timers.push(setTimeout(() => this.emit("close"), this.plan.closeMs));
        }
      },
    };
  }

  dispose(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    this.handlers.clear();
  }

  listenerCount(): number {
    return [...this.handlers.values()].reduce((sum, handlers) => sum + handlers.length, 0);
  }
}

/* ------------------------------------------------------------------ *
 * 幾何與目標欄位
 * ------------------------------------------------------------------ */

const FIELD_ID = "joined";

function fieldWith(xRatio: number): any {
  return {
    stableFieldId: FIELD_ID,
    fieldType: "radio",
    displayOrder: 0,
    definition: {
      options: ["none", "yes"],
      optionMarks: [
        { xRatio, yRatio: 0.2, widthRatio: 0.05, heightRatio: 0.05 },
        { xRatio: 0.8, yRatio: 0.2, widthRatio: 0.05, heightRatio: 0.05 },
      ],
    },
    coordinate: { x: 20, y: 40, width: 160, height: 24 },
  };
}

const TARGET: SaveTarget = {
  fieldId: FIELD_ID,
  assertField: (field: any) => {
    const x = field?.definition?.optionMarks?.[0]?.xRatio;
    if (typeof x !== "number" || !(x > 0.5))
      throw new Error("expected geometry is not persisted");
  },
};

const STALE = 0.1;
const FRESH = 0.6;

/* ------------------------------------------------------------------ *
 * 情境
 * ------------------------------------------------------------------ */

type Scenario = {
  name: string;
  versionId: string;
  plan: Plan;
  target?: SaveTarget;
  expect: "resolve" | "reject";
  expectHadNewRequest?: boolean;
  expectMatchedIndex?: number | null;
  requiredMarkers?: string[];
  forbiddenMarkers?: string[];
  expectMessage?: string;
};

const VERSION = "ver-target";
const OTHER = "ver-other";

function saveBody(versionId: string): unknown {
  return [{ result: { data: { json: { versionId, contentHash: "h", updatedAt: "t" } } } }];
}

const scenarios: Scenario[] = [
  {
    name: "S1 other version must not satisfy the wait",
    versionId: VERSION,
    plan: {
      versionId: VERSION,
      initial: { [VERSION]: [fieldWith(STALE)] },
      exchanges: [
        {
          delayMs: 20,
          procedures: [SAVE_PROCEDURE],
          input: { "0": { json: { versionId: OTHER, fields: [fieldWith(FRESH)] } } },
          body: saveBody(VERSION), // 伺服器謊稱是目標 version
        },
      ],
    },
    target: TARGET,
    expect: "reject",
    expectHadNewRequest: false,
    requiredMarkers: ["save:skip:version-mismatch", "save:no-new-request"],
    forbiddenMarkers: ["save:matched"],
  },
  {
    name: "S2 same version but stale payload must not satisfy the wait",
    versionId: VERSION,
    plan: {
      versionId: VERSION,
      initial: { [VERSION]: [fieldWith(STALE)] },
      exchanges: [
        {
          delayMs: 20,
          procedures: [SAVE_PROCEDURE],
          input: { "0": { json: { versionId: VERSION, fields: [fieldWith(STALE)] } } },
          body: saveBody(VERSION),
        },
      ],
    },
    target: TARGET,
    expect: "reject",
    expectHadNewRequest: false,
    requiredMarkers: ["save:no-new-request"],
    forbiddenMarkers: ["save:matched"],
  },
  {
    name: "S3 save at batch index 1 must be read at index 1",
    versionId: VERSION,
    plan: {
      versionId: VERSION,
      initial: { [VERSION]: [fieldWith(STALE)] },
      exchanges: [
        {
          delayMs: 20,
          procedures: ["formdigital.templates.getVersionDetails", SAVE_PROCEDURE],
          input: {
            "0": { json: { versionId: VERSION } },
            "1": { json: { versionId: VERSION, fields: [fieldWith(FRESH)] } },
          },
          body: [
            { result: { data: { json: { template: null, version: null, fields: [] } } } },
            { result: { data: { json: { versionId: VERSION, contentHash: "h" } } } },
          ],
        },
      ],
    },
    target: TARGET,
    expect: "resolve",
    expectHadNewRequest: true,
    expectMatchedIndex: 1,
    requiredMarkers: ["save:matched:index=1"],
  },
  {
    name: "S4 tRPC business error is not a completed save",
    versionId: VERSION,
    plan: {
      versionId: VERSION,
      initial: { [VERSION]: [fieldWith(STALE)] },
      exchanges: [
        {
          delayMs: 20,
          procedures: [SAVE_PROCEDURE],
          input: { "0": { json: { versionId: VERSION, fields: [fieldWith(FRESH)] } } },
          body: [{ error: { json: { message: "SAVE_FAILED" } } }],
          persist: false,
        },
      ],
    },
    target: TARGET,
    expect: "reject",
    expectHadNewRequest: false,
    requiredMarkers: ["save:skip:business-error", "save:no-new-request"],
    forbiddenMarkers: ["save:matched"],
  },
  {
    name: "S5 no new request but precise read-back already correct -> resolve",
    versionId: VERSION,
    plan: {
      versionId: VERSION,
      initial: { [VERSION]: [fieldWith(FRESH)] },
      exchanges: [],
    },
    target: TARGET,
    expect: "resolve",
    expectHadNewRequest: false,
    requiredMarkers: ["save:no-new-request", "save:readback:ok"],
    forbiddenMarkers: ["save:matched"],
  },
  {
    name: "S6 no new request and read-back wrong -> reject",
    versionId: VERSION,
    plan: {
      versionId: VERSION,
      initial: { [VERSION]: [fieldWith(STALE)] },
      exchanges: [],
    },
    target: TARGET,
    expect: "reject",
    expectHadNewRequest: false,
    requiredMarkers: ["save:no-new-request"],
  },
  {
    name: "S7 page closed while waiting must not be swallowed as autosave",
    versionId: VERSION,
    plan: {
      versionId: VERSION,
      initial: { [VERSION]: [fieldWith(FRESH)] },
      exchanges: [],
      closeMs: 30,
    },
    target: TARGET,
    expect: "reject",
    expectMessage: SAVE_WAIT_PAGE_CLOSED,
  },
  {
    name: "S8 click failure propagates and cancels the wait",
    versionId: VERSION,
    plan: {
      versionId: VERSION,
      initial: { [VERSION]: [fieldWith(FRESH)] },
      exchanges: [],
      clickError: new Error("CLICK_FAILED"),
    },
    target: TARGET,
    expect: "reject",
    expectMessage: "CLICK_FAILED",
    requiredMarkers: ["save:click-failed"],
  },
];

/* ------------------------------------------------------------------ *
 * 執行與判定
 * ------------------------------------------------------------------ */

const results: Array<{ name: string; ok: boolean; detail: string }> = [];

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} :: ${detail}`);
}

async function runScenario(scenario: Scenario): Promise<void> {
  const page = new FakePage(scenario.plan);
  const markers: string[] = [];
  let outcome: "resolve" | "reject" = "resolve";
  let message = "";
  let result: { hadNewRequest: boolean; matchedIndex: number | null } | null = null;
  let remainingListeners = -1;
  try {
    result = await saveDraftAndConfirmFor(
      page as unknown as Page,
      {
        versionId: scenario.versionId,
        target: scenario.target,
        timeoutMs: 400,
        readBackTimeoutMs: 300,
        readBackIntervalMs: 40,
        log: marker => markers.push(marker),
      },
      undefined
    );
  } catch (error) {
    outcome = "reject";
    message = error instanceof Error ? error.message : String(error);
  } finally {
    remainingListeners = page.listenerCount();
    page.dispose();
  }

  const problems: string[] = [];
  if (remainingListeners !== 0) problems.push(`leaked listeners=${remainingListeners}`);
  if (outcome !== scenario.expect)
    problems.push(`outcome=${outcome} expected=${scenario.expect}`);
  if (scenario.expectMessage && !message.includes(scenario.expectMessage))
    problems.push(`message=${JSON.stringify(message)} lacks ${scenario.expectMessage}`);
  // 只有成功 resolve 才會有 outcome；reject 情境不檢查回傳值。
  if (result) {
    if (
      scenario.expectHadNewRequest !== undefined &&
      result.hadNewRequest !== scenario.expectHadNewRequest
    )
      problems.push(`hadNewRequest=${result.hadNewRequest}`);
    if (
      scenario.expectMatchedIndex !== undefined &&
      result.matchedIndex !== scenario.expectMatchedIndex
    )
      problems.push(`matchedIndex=${result.matchedIndex}`);
  }
  for (const marker of scenario.requiredMarkers ?? [])
    if (!markers.some(item => item.startsWith(marker)))
      problems.push(`missing marker ${marker}`);
  for (const marker of scenario.forbiddenMarkers ?? [])
    if (markers.some(item => item.startsWith(marker)))
      problems.push(`unexpected marker ${marker}`);

  record(
    scenario.name,
    problems.length === 0,
    problems.length === 0
      ? `outcome=${outcome} markers=[${markers.join("|")}]`
      : problems.join("; ")
  );
}

/* ------------------------------------------------------------------ *
 * 純函式層的反例（批次解析／procedure 對位）
 * ------------------------------------------------------------------ */

function pureChecks(): void {
  const url = buildTrpcUrl(["formdigital.templates.getVersionDetails", SAVE_PROCEDURE], {
    "0": { json: { versionId: VERSION } },
    "1": { json: { versionId: VERSION, fields: [fieldWith(FRESH)] } },
  });
  const procedures = proceduresFromUrl(url);
  record(
    "P1 proceduresFromUrl keeps batch order",
    procedures.length === 2 && procedures[1] === SAVE_PROCEDURE,
    JSON.stringify(procedures)
  );

  const parsed = saveInputEntries(url, null);
  record(
    "P2 saveInputEntries resolves the save at index 1 (not payload[0])",
    parsed.reason === null && parsed.entries.length === 1 && parsed.entries[0].index === 1,
    parsed.reason ?? JSON.stringify(parsed.entries.map(item => item.index))
  );

  const ambiguous = saveInputEntries(
    buildTrpcUrl(
      [SAVE_PROCEDURE, "formdigital.templates.getVersionDetails"],
      { "0": { json: { versionId: VERSION } } }
    ),
    null
  );
  record(
    "P3 ambiguous batch shape fails closed",
    ambiguous.reason === "batch-shape-mismatch",
    String(ambiguous.reason)
  );

  // LEGACY 反例：同一個批次，舊演算法永遠取 payload[0]。
  const legacyData = legacyExtractTrpcData([
    { result: { data: { json: { template: null, version: null, fields: [] } } } },
    { result: { data: { json: { versionId: VERSION, contentHash: "h" } } } },
  ]);
  record(
    "LEGACY payload[0] misreads the batch (defect evidence)",
    legacyData?.versionId === undefined,
    `legacyData.versionId=${String(legacyData?.versionId)} (expected undefined = wrong item)`
  );
}

/* ------------------------------------------------------------------ *
 * LEGACY 區：舊演算法的行為量測（通過＝缺陷存在）
 * ------------------------------------------------------------------ */

function legacyCounterexamples(): void {
  const url = buildTrpcUrl([SAVE_PROCEDURE], {
    "0": { json: { versionId: OTHER, fields: [fieldWith(FRESH)] } },
  });
  record(
    "LEGACY-L1 old predicate accepts an unrelated version",
    legacyPredicate(url, "POST") === true,
    "old predicate matched by URL substring + POST only"
  );
  record(
    "LEGACY-L2 old success check trusts the response body versionId",
    legacyVersionCheck(saveBody(VERSION), VERSION) === true,
    "old check never looked at which version the request was for"
  );

  const staleUrl = buildTrpcUrl([SAVE_PROCEDURE], {
    "0": { json: { versionId: VERSION, fields: [fieldWith(STALE)] } },
  });
  record(
    "LEGACY-L3 old check accepts a same-version stale payload",
    legacyPredicate(staleUrl, "POST") === true &&
      legacyVersionCheck(saveBody(VERSION), VERSION) === true,
    "stale autosave of the same version satisfied the old wait"
  );

  record(
    "LEGACY-L4 old check cannot see a tRPC business error shape",
    legacyVersionCheck([{ error: { json: { message: "SAVE_FAILED" } } }], VERSION) === false,
    "only reachable via `data` being undefined, i.e. no precise reason"
  );
}

/* ------------------------------------------------------------------ *
 * 直接驗證回應對位（不需瀏覽器）
 * ------------------------------------------------------------------ */

async function validateChecks(): Promise<void> {
  const okResponse = makeResponse(
    makeRequest(
      buildTrpcUrl([SAVE_PROCEDURE], {
        "0": { json: { versionId: VERSION, fields: [fieldWith(FRESH)] } },
      }),
      null
    ),
    200,
    JSON.stringify(saveBody(VERSION))
  );
  const ok = await validateSaveResponse(okResponse, { versionId: VERSION, target: TARGET });
  record("V1 precise match on a correct save", ok.ok === true && ok.index === 0, JSON.stringify(ok));

  const otherResponse = makeResponse(
    makeRequest(
      buildTrpcUrl([SAVE_PROCEDURE], {
        "0": { json: { versionId: OTHER, fields: [fieldWith(FRESH)] } },
      }),
      null
    ),
    200,
    JSON.stringify(saveBody(VERSION))
  );
  const other = await validateSaveResponse(otherResponse, {
    versionId: VERSION,
    target: TARGET,
  });
  record(
    "V2 request for another version is rejected even if the body says otherwise",
    other.ok === false,
    JSON.stringify(other)
  );

  const staleResponse = makeResponse(
    makeRequest(
      buildTrpcUrl([SAVE_PROCEDURE], {
        "0": { json: { versionId: VERSION, fields: [fieldWith(STALE)] } },
      }),
      null
    ),
    200,
    JSON.stringify(saveBody(VERSION))
  );
  const stale = await validateSaveResponse(staleResponse, {
    versionId: VERSION,
    target: TARGET,
  });
  record(
    "V3 same version but stale geometry is rejected",
    stale.ok === false && !stale.ok && stale.reason === "payload-geometry-mismatch",
    JSON.stringify(stale)
  );

  const errorResponse = makeResponse(
    makeRequest(
      buildTrpcUrl([SAVE_PROCEDURE], {
        "0": { json: { versionId: VERSION, fields: [fieldWith(FRESH)] } },
      }),
      null
    ),
    200,
    JSON.stringify([{ error: { json: { message: "SAVE_FAILED" } } }])
  );
  const failed = await validateSaveResponse(errorResponse, {
    versionId: VERSION,
    target: TARGET,
  });
  record(
    "V4 tRPC business error is rejected",
    failed.ok === false && !failed.ok && failed.reason === "business-error",
    JSON.stringify(failed)
  );

  record(
    "V5 extractTrpcData still available for legacy callers",
    extractTrpcData(saveBody(VERSION))?.versionId === VERSION,
    "legacy helper kept for existing read paths"
  );
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.log("save-completion probe: synthetic, no browser, no real Draft");
  pureChecks();
  await validateChecks();
  for (const scenario of scenarios) await runScenario(scenario);
  legacyCounterexamples();

  const failed = results.filter(item => !item.ok);
  console.log(
    `\nSUMMARY total=${results.length} passed=${results.length - failed.length} failed=${failed.length}`
  );
  if (failed.length > 0) {
    for (const item of failed) console.log(`  FAILED: ${item.name} :: ${item.detail}`);
    process.exit(1);
  }
  console.log("ALL PASS");
  process.exit(0);
}

void main();
