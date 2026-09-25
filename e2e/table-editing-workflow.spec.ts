import { expect, test, type Page } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { authenticateTestUser, completeOnboarding } from "./test-runtime";

test("save acknowledgement cannot clear a newer table edit", async ({ page, context }, info) => {
  const versionId = await createTableDraft(page, context, info.project.name, "save-generation", 2, 2);
  await selectTableAndEnterCellMode(page);
  const handle = page.locator('.mark-position-handle[data-cell-index="0"]');
  let release!: () => void;
  const held = new Promise<void>(r => { release = r; });
  let observed!: () => void;
  const started = new Promise<void>(r => { observed = r; });
  let first = true;
  await page.route('**/api/trpc/*saveDraftFields*', async route => {
    const response = await route.fetch();
    if (first) { first = false; observed(); await held; }
    await route.fulfill({ response });
  });
  try {
    await handle.press('ArrowRight'); await handle.press('Enter');
    let timer: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([started, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('autosave did not start')), 15000); })]);
    } finally { clearTimeout(timer!); }
    // The first snapshot is on disk, but its acknowledgement has not arrived.
    await handle.press('ArrowRight'); await handle.press('Enter');
    release();
    await expect.poll(async () => (await readTableGuides(page, versionId))?.[0]?.xRatio,
      { timeout: 8000, message: 'new edit must remain dirty until its own save completes' }).toBeCloseTo(.02, 6);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test("pending cell keyboard edits survive dragging another cell and reload", async ({ page, context }, info) => {
  const versionId = await createTableDraft(page, context, info.project.name, "combined-cell-gesture", 2, 2);
  await selectTableAndEnterCellMode(page);
  await page.locator('.mark-position-handle[data-cell-index="0"]').press('ArrowRight');
  const next = page.locator('.mark-position-handle[data-cell-index="2"]');
  await next.hover();
  const box = (await next.boundingBox())!;
  const parentWidth = await next.evaluate(el => el.parentElement!.getBoundingClientRect().width);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + parentWidth * .05, box.y + box.height / 2, { steps: 3 });
  await page.mouse.up(); // no settling wait: release must consume the last coordinates
  await saveDraft(page);
  const saved = (await readTableGuides(page, versionId))!;
  expect(saved[0].xRatio).toBeCloseTo(.01, 6);
  expect(Math.abs(saved[2].xRatio - .05)).toBeLessThanOrEqual(.5 / parentWidth);
  await page.reload();
  expect(await readTableGuides(page, versionId)).toEqual(saved);
});

/**
 * UX-TPL-01 階段 2 — 永久表格編輯回歸（取代 e2e/red-probe-table-current.spec.ts）。
 *
 * 這些測試透過**真實 UI 拖動／換組／模式切換／保存**來證明階段 2 的修復：
 *  - 72 格全部可達（6×12 分為 2 組，每組 36 把手；尾格 index 71 在組 2 可點、可拖、保存後可讀回）。
 *  - 一次手勢一次提交；拖動中只更新 preview，pointerup 才 commit，Esc 取消，不流向 900ms autosave。
 *  - 共享格線只在可證實對齊時可拖；不對齊則保守停用，且不改寫任何座標。
 *
 * 選取器以 data-testid / data-cell-index / data-axis / data-aligned / data-boundary 為主，
 * 與 locale 無關（預設 E2E locale 為 zh-Hant）。拖動、換組、角色操作、保存皆在真 UI 發生，
 * 不用 API 直接設成預期結果。
 */

async function blankFormFixture(): Promise<Buffer> {
  const document = await PDFDocument.create();
  const page = document.addPage([500, 700]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  document
    .getForm()
    .createTextField("grid_area")
    .addToPage(page, { x: 40, y: 200, width: 420, height: 300, font });
  return Buffer.from(await document.save());
}

function extractTrpcData(payload: unknown): any {
  const item = Array.isArray(payload) ? payload[0] : payload;
  const data = item?.result?.data;
  if (data && typeof data === "object" && "json" in data) {
    return (data as Record<string, unknown>).json;
  }
  return data;
}

async function createTableDraft(
  page: Page,
  context: import("@playwright/test").BrowserContext,
  projectName: string,
  label: string,
  rows = 6,
  columns = 12
): Promise<string> {
  await authenticateTestUser(context, `${projectName}-${label}`);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await completeOnboarding(page);
  await page.getByRole("button", { name: "建立 Template" }).first().click();
  await page.locator('input[type="file"][accept*=".pdf"]').setInputFiles({
    name: "workflow.pdf",
    mimeType: "application/pdf",
    buffer: await blankFormFixture(),
  });
  await page.locator("#template-name").fill(`WF ${label}`);
  await page.getByRole("button", { name: "建立 Draft" }).click();
  await expect(page.getByTestId("import-review-panel")).toBeVisible({ timeout: 90_000 });
  await page.getByTestId("confirm-import-btn").click();
  await expect(
    page.getByRole("heading", { name: `WF ${label} · v1` })
  ).toBeVisible({ timeout: 90_000 });

  await page.locator("button.field-row").first().click();
  const settings = page.locator("aside").last();
  await settings.locator("select").first().selectOption("table");
  await settings.locator('label:has-text("最大列數") + input').fill(String(rows));
  await settings.locator('label:has-text("欄數") + input').fill(String(columns));
  // S2-R5 #2：建立表格欄位時，必須等本次 saveDraftFields mutation 的實際成功回應，
  // 不能用常駐的「DRAFT · 已保存至 localhost」文字當作落盤證據。
  const createResp = page.waitForResponse(
    response =>
      response.url().includes("formdigital.templates.saveDraftFields"),
    { timeout: 30_000 }
  );
  await page.getByRole("button", { name: /儲存|Save/ }).click();
  const createResponse = await createResp;
  expect(
    createResponse.status(),
    "saveDraftFields must succeed when creating the table field"
  ).toBeLessThan(400);
  await expect(
    page.getByText("DRAFT · 已保存至 localhost", { exact: true })
  ).toBeVisible();

  const versionIdMatch = page.url().match(/[?&]version=([^&]+)/);
  expect(versionIdMatch, "editor URL must carry the versionId").toBeTruthy();
  return decodeURIComponent(versionIdMatch![1]);
}

async function readVersionDetails(
  page: Page,
  versionId: string
): Promise<any> {
  const response = await page.request.get(
    `/api/trpc/formdigital.templates.getVersionDetails?input=${encodeURIComponent(
      JSON.stringify({ json: { versionId } })
    )}`
  );
  expect(response.status(), "getVersionDetails must succeed").toBe(200);
  return extractTrpcData(await response.json());
}

/**
 * S2-R2（第二輪）：欄位缺席必須能被**合法表示**。
 *
 * 上一版的 `readTableGuides()` 內部先斷言「table 欄位必須存在」，刪除測試
 * 卻又用它來斷言「不存在」——兩個斷言互相矛盾，等於什麼都沒證明（若查詢
 * 本身壞掉，測試會在「必須存在」那行失敗，而不是證明刪除成功）。
 * 這裡改成由 details 查詢直接取欄位：找得到就回傳，找不到就回 undefined。
 */
function tableFieldOf(details: any): Record<string, unknown> | undefined {
  const fields = details?.fields as
    | Array<Record<string, unknown>>
    | undefined
    | null;
  return fields?.find(field => field.fieldType === "table");
}

function fieldIdsOf(details: any): string[] {
  const fields = (details?.fields ?? []) as Array<Record<string, unknown>>;
  return fields.map(field => String(field.id));
}

/** 只用在「table 必須存在」的測試；刪除測試請用 `tableFieldOf`。 */
async function readTableGuides(
  page: Page,
  versionId: string
): Promise<Array<Record<string, number>> | undefined> {
  const details = await readVersionDetails(page, versionId);
  const tableField = tableFieldOf(details);
  expect(tableField, "a table field must exist").toBeTruthy();
  return (
    tableField!.definition as { tableCellGuides?: Array<Record<string, number>> }
  ).tableCellGuides;
}

async function selectTableAndEnterCellMode(page: Page): Promise<void> {
  await page.locator('button.field-row[data-field-type="table"]').first().click();
  await expect(page.getByTestId("table-editing-controls")).toBeVisible();
  await page.getByTestId("mode-cell").click();
}

/**
 * S2-R5（第二輪）：`saveDraft` 必須真的等到本次 mutation 成功。
 *
 * 上一版用 `.catch(() => null)` 把「等不到請求」也當成成功，再加一個固定
 * 150ms 當作落盤證據——兩者都無法證明資料已寫入（逾時被吞掉、固定等待與
 * server 寫入無關）。這裡改為：
 *  - 等本次 `saveDraftFields` 的實際回應，**逾時直接拋錯**（不吞）；
 *  - 斷言 HTTP 狀態成功（tRPC 錯誤不會被當成成功）；
 *  - 以回應 body 讀完（`response.finished()`）作為 server 端完成的信號，
 *    不用固定 sleep。
 */
async function saveDraft(page: Page): Promise<void> {
  const saved = page.waitForResponse(
    response =>
      response.url().includes("formdigital.templates.saveDraftFields"),
    { timeout: 30_000 }
  );
  await page.getByRole("button", { name: /儲存|Save/ }).click();
  const response = await saved; // 沒有請求／逾時 → 測試失敗，不靜默通過
  expect(
    response.status(),
    "saveDraftFields must succeed (tRPC errors are not success)"
  ).toBeLessThan(400);
  await response.finished();
  await expect(
    page.getByText("DRAFT · 已保存至 localhost", { exact: true })
  ).toBeVisible();
}

/**
 * S2-R5（第二輪）：no-op 保存必須**分開判定**。
 *
 * `save()` 在 `!dirty` 時會直接 return、完全不發請求；把它混在 `saveDraft`
 * 裡用 catch 吃掉，會讓「真的沒發請求」和「發了但逾時」無法區分。
 * 這裡明確斷言：沒有變更時不會產生任何 saveDraftFields 請求。
 */
async function assertSaveIsNoop(page: Page): Promise<void> {
  let saveRequests = 0;
  const counter = (response: import("@playwright/test").Response) => {
    if (response.url().includes("formdigital.templates.saveDraftFields"))
      saveRequests += 1;
  };
  page.on("response", counter);
  await page.getByRole("button", { name: /儲存|Save/ }).click();
  await page.waitForTimeout(600);
  page.off("response", counter);
  expect(
    saveRequests,
    "a no-op Save must not issue any saveDraftFields mutation"
  ).toBe(0);
}

function cellHandle(page: Page, index: number) {
  return page.locator(`.mark-position-handle[data-cell-index="${index}"]`);
}

/** 整張表格欄位目前的 preview／正式左緣（百分比）。 */
async function fieldLeftPercent(page: Page): Promise<number> {
  return page
    .locator(".field-overlay.is-active")
    .evaluate(element => parseFloat((element as HTMLElement).style.left));
}

/** 目前作用中表格欄位的伺服器座標 xMm（用來證明整表微調有沒有落盤）。 */
function tableXMm(details: any): number {
  const field = tableFieldOf(details)!;
  return Number((field.coordinate as { xMm?: number }).xMm);
}

/**
 * 以真實 `WheelEvent`（ctrlKey）經由應用程式自己的監聽器觸發縮放。
 * Playwright 的 `mouse.wheel()` 無法帶快捷鍵，這裡直接對畫布容器派發事件，
 * 走的仍是 TemplateEditor 註冊的那個 non-passive wheel listener。
 */
async function zoomCanvasByWheel(page: Page, deltaY: number): Promise<void> {
  await page.evaluate(delta => {
    const canvas = document.querySelector(".editor-canvas") as HTMLElement;
    canvas.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: delta,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      })
    );
  }, deltaY);
}

/**
 * S2-R5（第二輪收尾）：按下指標前，先確認該座標的 `document.elementFromPoint`
 * 真的命中目標元素。
 *
 * WebKit 實測：單獨跑 `T-06` 是綠的、整輪跑卻紅（拖動完全沒生效）。
 * 原因是 `hover()` 通過後到 `mouse.down()` 之間，通知浮層等暫時性元素可能
 * 剛好蓋住把手，pointerdown 被打到浮層，`gesture` 根本沒建立 → 沒有 dirty →
 * 後續 saveDraft 等不到請求。`hover()` 只保證「hover 當下」可命中等於沒保證。
 * 這裡改成明確等到座標命中目標；等不到就直接失敗並回報實際命中的元素，
 * 不靜默通過也不重試掩蓋問題。
 */
async function expectPointHits(
  page: Page,
  x: number,
  y: number,
  match: { className?: string; testId?: string; cellIndex?: number }
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ x, y, className, testId, cellIndex }) => {
            const el = document.elementFromPoint(x, y) as HTMLElement | null;
            if (!el) return "none";
            if (className && !el.classList.contains(className))
              return `${el.tagName}.${el.className}`;
            if (testId && el.getAttribute("data-testid") !== testId)
              return `${el.tagName}.${el.className}`;
            if (
              cellIndex !== null &&
              el.getAttribute("data-cell-index") !== String(cellIndex)
            )
              return `wrong-cell:${el.getAttribute("data-cell-index")}`;
            return "ok";
          },
          {
            x,
            y,
            className: match.className ?? null,
            testId: match.testId ?? null,
            cellIndex: match.cellIndex ?? null,
          }
        ),
      { timeout: 15_000 }
    )
    .toBe("ok");
}

/**
 * 讀取某個 cell 把手目前的「預覽／正式」位置字串（style.left／style.top）。
 * 拖動中 React 會把 preview 直接寫在行內 style 上，因此它是觀測
 * 「位移是否真的被處理」最直接的依據。
 */
/** 讀取某個 cell 把手／格線目前的行內 style 字串。 */
async function readInlineStyle(page: Page, selector: string): Promise<string> {
  const style = await page.evaluate(s => {
    const el = document.querySelector(s) as HTMLElement | null;
    return el ? el.getAttribute("style") ?? "" : null;
  }, selector);
  if (style === null) throw new Error(`${selector} not found`);
  return style;
}

/**
 * 放開指標（或按 Esc 取消）之前，等待拖動預覽「真的更新並穩定」。
 *
 * 為什麼需要：Playwright 的 WebKit 輸入管線會把一次 mouse.move(steps:n) 產生
 * 的連續 pointermove 合併、留到下一個 rAF 才投遞，而 pointerup 是立即投遞的。
 * 實測（T-08／R1／T-02）因此在 WebKit 上觀測到：
 *   · 第一段的位移一直到 wheel 後的 120ms 等待才出現；
 *   · 緊接著 mouse.up() 的那一段 pointermove 完全沒有生效——事件數（15 次）、
 *     pointer capture（未遺失）、pointercancel（0 次）都正常，但位移整段丟失，
 *     pointerup 時 preview 仍是 null 或舊值。
 * 等待用於驗證「預覽存在後取消」等情境，不能據此推論快速放手遺失並非產品缺陷。
 * 快速放手另由 table-gesture.probe.ts 與上方保存後讀回案例覆蓋；產品提交必須採用
 * 最新手勢座標，不能要求使用者刻意等一個畫面 frame 才放手。
 * 因此這裡等待：值必須先「從起點改變」，然後連續兩次取樣不變（代表已收斂）。
 * 若永遠沒改變就直接丟出錯誤，不會靜默通過。
 */
async function waitForStyleSettled(
  page: Page,
  selector: string,
  start: string
): Promise<string> {
  let last = "";
  let stable = 0;
  for (let i = 0; i < 50; i += 1) {
    const cur = await readInlineStyle(page, selector);
    if (cur !== start) {
      if (cur === last) {
        stable += 1;
        if (stable >= 2) return cur;
      } else {
        last = cur;
        stable = 1;
      }
    }
    await page.waitForTimeout(40);
  }
  throw new Error(
    `preview for ${selector} never settled (start=${start})`
  );
}

async function cellStyle(page: Page, cellIndex: number): Promise<string> {
  return readInlineStyle(page, `[data-cell-index="${cellIndex}"]`);
}

async function dragHandleBy(
  page: Page,
  index: number,
  dxRatio: number,
  dyRatio: number
): Promise<void> {
  const handle = cellHandle(page, index);
  // 先 scrollIntoView 並 hover：hover 具備 actionability（hit-target）檢查，
  // 會等到把手真的能收到 pointer 事件才繼續。若通知 toast 等暫時性浮層正好覆蓋
  // 把手，原始 page.mouse 座標會被浮層吃掉（WebKit 曾因此讓拖動完全沒生效），
  // hover 會自動重試直到浮層消失。
  await handle.scrollIntoViewIfNeeded();
  await handle.hover();
  const box = (await handle.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await expectPointHits(page, cx, cy, { className: "mark-position-handle" });
  const startStyle = await cellStyle(page, index);
  await page.mouse.down();
  await page.mouse.move(cx + box.width * dxRatio, cy + box.height * dyRatio, {
    steps: 8,
  });
  // 放開指標前先等 preview 真的被處理並穩定（WebKit 會把 pointermove 留到下一個
  // rAF；詳見 waitForStyleSettled 註解）。否則位移會在 pointerup 之後才送達而
  // 被丟棄，測試會觀測到「拖動完全沒生效」的假失敗。
  await waitForStyleSettled(
    page,
    `[data-cell-index="${index}"]`,
    startStyle
  );
  await page.mouse.up();
}

// --- T-01：72 格全非 fixed → 2 組（列 1–3／4–6），每組 36 把手；尾格 index 71 可達 ---

test("T-01: 6×12 splits into two groups of 36; the last cell (index 71) is reachable", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await createTableDraft(page, context, testInfo.project.name, "T01");

  await selectTableAndEnterCellMode(page);
  const handles = page.locator(".mark-position-handle");

  // 組 1：36 把手，index 0–35
  await expect(handles).toHaveCount(36);
  const maxGroup1 = await handles
    .last()
    .getAttribute("data-cell-index")
    .then((v) => Number(v));
  expect(maxGroup1).toBe(35);

  // 切到組 2
  await page.getByTestId("group-next").click();
  await expect(handles).toHaveCount(36);
  const maxGroup2 = await handles
    .last()
    .getAttribute("data-cell-index")
    .then((v) => Number(v));
  expect(maxGroup2).toBe(71); // 尾格（第 6 列第 12 欄）在組 2 可達

  // 組 2 含 index 71 的把手
  await expect(cellHandle(page, 71)).toBeVisible();

  // 組 2 為最後一組：下一組按鈕停用 → 共 2 組
  await expect(page.getByTestId("group-next")).toBeDisabled();
});

// --- T-02 / T-03：拖動第 6 列第 12 格；只有該格改變；保存後重開一致 ---

test("T-02/T-03: dragging the last cell changes only it; survives save and reload", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const versionId = await createTableDraft(
    page,
    context,
    testInfo.project.name,
    "T02"
  );
  await selectTableAndEnterCellMode(page);
  await page.getByTestId("group-next").click(); // 組 2

  // S2-R5：此處**沒有任何未保存變更**（表格欄位在 createTableDraft 已落盤）。
  // 因此不能用 saveDraft（它要求真的發出 mutation），而必須斷言「Save 是
  // no-op」——這同時證明前一步的落盤沒有留下任何 pending 變更。
  await assertSaveIsNoop(page);
  const baseline = await readTableGuides(page, versionId);
  expect(baseline, "baseline guides must exist").toBeTruthy();
  expect(baseline!.length).toBe(72);

  // 拖動尾格（index 71，第 6 列第 12 欄＝右下角）向內（左上），避免被邊界夾限
  await dragHandleBy(page, 71, -0.25, -0.25);
  await saveDraft(page);

  const after = await readTableGuides(page, versionId);
  expect(after!.length).toBe(72);

  // 只有 index 71 改變；其餘 71 格 byte 相同
  for (let i = 0; i < 72; i += 1) {
    if (i === 71) continue;
    expect(after![i]).toEqual(baseline![i]);
  }
  expect(after![71]!.xRatio).toBeLessThan(baseline![71]!.xRatio);
  expect(after![71]!.yRatio).toBeLessThan(baseline![71]!.yRatio);

  // 重開：reload 後 server 讀回仍為拖動後座標
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", { name: `WF T02 · v1` })
  ).toBeVisible({ timeout: 90_000 });
  const reloaded = await readTableGuides(page, versionId);
  expect(reloaded![71]!.xRatio).toBeCloseTo(after![71]!.xRatio, 6);
  expect(reloaded![71]!.yRatio).toBeCloseTo(after![71]!.yRatio, 6);
});

// --- T-04：分組與 viewport 無關；整表可見時尾列 12 格仍可達 ---

test("T-04: grouping is viewport-independent; last 12 cells still reachable when the whole table is visible", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await createTableDraft(page, context, testInfo.project.name, "T04");

  // 縮小視窗（模擬整表可見、不需放大）後仍應為 2 組 36
  await page.setViewportSize({ width: 900, height: 700 });
  await selectTableAndEnterCellMode(page);
  let handles = page.locator(".mark-position-handle");
  await expect(handles).toHaveCount(36);
  await expect(cellHandle(page, 35)).toBeVisible();

  await page.getByTestId("group-next").click();
  await expect(handles).toHaveCount(36);
  for (let i = 60; i < 72; i += 1) {
    await expect(cellHandle(page, i)).toBeVisible();
  }
});

// --- T-06：不規則 per-cell guides → 格線保守停用，拖動不改寫座標 ---

test("T-06: irregular per-cell guides disable gridline drag and change nothing", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const versionId = await createTableDraft(
    page,
    context,
    testInfo.project.name,
    "T06"
  );
  await selectTableAndEnterCellMode(page);

  // 基線：先讀出未拖動前的 guides，作為後續「確實移動」的對照
  const baseline = await readTableGuides(page, versionId);
  expect(baseline!.length).toBe(72);

  // 拖動單一格（index 17，第 2 列第 6 欄）的 x 與 y，使其同時與同列、同欄其他格不對齊。
  // 必須雙軸都動：只動 y 不動 x 只會破壞「列」對齊，雙軸都動才同時破壞列與欄，
  // 確保水平與垂直共享格線都會被 checkSharedGridline 保守停用。
  await dragHandleBy(page, 17, -0.25, -0.25);
  await saveDraft(page);
  const irregular = await readTableGuides(page, versionId);
  expect(irregular!.length).toBe(72);

  // 自校：cell 17 必須真的被拖動（否則下方「停用」斷言只是假通過）
  expect(irregular![17]!.xRatio).not.toBeCloseTo(baseline![17]!.xRatio, 6);
  expect(irregular![17]!.yRatio).not.toBeCloseTo(baseline![17]!.yRatio, 6);

  // 進入格線模式
  await page.getByTestId("mode-gridline").click();
  const gridlines = page.locator('[data-testid="table-gridline"]');
  await expect(gridlines.first()).toBeVisible();

  // 至少一條分隔線因不對齊而停用（保守禁用）
  const disabled = page.locator(
    '[data-testid="table-gridline"][data-aligned="false"]'
  );
  await expect(disabled.first()).toBeVisible();

  // 嘗試拖動一條停用的水平分隔線：應完全無效（startDrag 提前 return）
  const line = page
    .locator(
      '[data-testid="table-gridline"][data-aligned="false"][data-axis="horizontal"]'
    )
    .first();
  const box = (await line.boundingBox())!;
  // 同 T-07：避開垂直分隔線交點，點第一欄中段。此線為停用（不對齊）→ startDrag 提前 return。
  const gx = box.x + box.width * 0.04;
  const gy = box.y + box.height / 2;
  await expectPointHits(page, gx, gy, { testId: "table-gridline" });
  await page.mouse.move(gx, gy);
  await page.mouse.down();
  await page.mouse.move(gx + 30, gy + 20, { steps: 6 });
  await page.mouse.up();

  const after = await readTableGuides(page, versionId);
  expect(after).toEqual(irregular); // 座標精確不變
});

// --- T-07：對齊的格線拖動只影響相鄰兩列，其餘列 byte 不變，且仍為共享對齊 ---

test("T-07: a proven-aligned gridline drag adjusts only the two adjacent rows", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const versionId = await createTableDraft(
    page,
    context,
    testInfo.project.name,
    "T07"
  );
  await page.locator('button.field-row[data-field-type="table"]').first().click();
  const baseline = await readTableGuides(page, versionId);

  // 進入格線模式，拖動第 1 條水平分隔線（列 1 與列 2 之間）
  await page.getByTestId("mode-gridline").click();
  const line = page
    .locator('[data-testid="table-gridline"][data-axis="horizontal"][data-boundary="1"]')
    .first();
  await expect(line).toBeVisible();
  // 水平分隔線與垂直分隔線在交點重疊；改點第一欄中段的 x，避開垂直分隔線搶走 pointerdown。
  // hover({ position }) 同時具備 actionability（hit-target）檢查：會等到該座標點真的
  // 能收到 pointer 事件為止，避免通知 toast 等暫時性浮層吃掉原始 page.mouse 座標，
  // 導致拖動完全沒生效（WebKit 曾因此讓本測試與 T-06 間歇性失敗）。
  const box = (await line.boundingBox())!;
  const gx = box.width * 0.04;
  const gy = box.height / 2;
  await line.hover({ position: { x: gx, y: gy } });
  await expectPointHits(page, box.x + gx, box.y + gy, {
    testId: "table-gridline",
  });
  const lineSelector =
    '[data-testid="table-gridline"][data-axis="horizontal"][data-boundary="1"]';
  const startLine = await readInlineStyle(page, lineSelector);
  await page.mouse.down();
  await page.mouse.move(box.x + gx, box.y + gy + 40, { steps: 8 });
  // 同上：等預覽真的更新並穩定才放開（WebKit 的 pointermove 會延到下一個 rAF）。
  await waitForStyleSettled(page, lineSelector, startLine);
  await page.mouse.up();
  await saveDraft(page);

  const after = await readTableGuides(page, versionId);
  // 第 3 列起（index 24+）完全不變
  for (let i = 24; i < 72; i += 1) {
    expect(after![i]).toEqual(baseline![i]);
  }
  // 受影響的邊界仍為「共享」：列 1 全部格底邊一致、列 2 全部格頂邊一致
  const bottomRow0 = after![0]!.yRatio + after![0]!.heightRatio;
  const topRow1 = after![12]!.yRatio;
  for (let c = 0; c < 12; c += 1) {
    expect(after![c]!.yRatio + after![c]!.heightRatio).toBeCloseTo(
      bottomRow0,
      6
    );
    expect(after![12 + c]!.yRatio).toBeCloseTo(topRow1, 6);
  }
  // 邊界值確實移動了
  expect(topRow1).toBeGreaterThan(baseline![12]!.yRatio);
});

// --- T-08：拖動中捲動，目標不更換（指標 capture 鎖定） ---

test("T-08: scrolling mid-drag keeps the locked target", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const versionId = await createTableDraft(
    page,
    context,
    testInfo.project.name,
    "T08"
  );
  await selectTableAndEnterCellMode(page);
  await page.getByTestId("group-next").click(); // 組 2
  // 無未保存變更 → Save 必須是 no-op（證明 createTableDraft 的落盤沒有 pending）
  await assertSaveIsNoop(page);
  const baseline = await readTableGuides(page, versionId);

  // 開始拖動尾格（右下角，向內＝左上移動），先移一點，中途捲動，再移一點後釋放。
  // 注意：cell 把手寬高 = 單格尺寸，而 applyDelta 以「整表」寬高為分母，
  // 故需用較大的把手比例才能產生 >0.03 的 ratio 位移。
  // 中途捲動會改變把手的 viewport 座標；抓取錨點是「容器相對比例」，所以續移
  // 仍以原本的絕對座標累加即可（applyDelta 每次都用當下 rect 重新換算）。
  const handle71 = cellHandle(page, 71);
  await handle71.scrollIntoViewIfNeeded();
  await handle71.hover(); // actionability：等把手真的可接收 pointer 事件（避開 toast 浮層）
  const box = (await handle71.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const startStyle = await cellStyle(page, 71);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - box.width * 0.25, cy - box.height * 0.25, {
    steps: 4,
  });
  // 往「上」捲（deltaY 為負）而不是往下：抓取錨點是「容器相對比例」，
  // 捲動會改變指標所對應的內容座標，往下捲會把指標往上移的量抵銷掉
  // （實測 120px 捲動 ≈ +0.23 ratio，遠大於指標的 -0.1），使 y 位移被
  // clamp 在最後一列的上限而看起來「完全沒動」。往上捲則與指標同向，
  // 無論捲動是否真的發生，y 都必須明確往上位移。
  await page.mouse.wheel(0, -120); // 中途捲動
  await page.waitForTimeout(120);
  await page.mouse.move(cx - box.width * 0.75, cy - box.height * 0.6, {
    steps: 8,
  });
  // 放開指標前必須等 preview 真的被處理並穩定（見 waitForStyleSettled 註解）：
  // WebKit 會把續移的 pointermove 留到下一個 rAF 才投遞，若直接 mouse.up()，
  // 位移會整段丟失，觀測到的會是「拖動完全沒生效」的假失敗。
  await waitForStyleSettled(page, `[data-cell-index="71"]`, startStyle);
  await page.mouse.up();
  await saveDraft(page);

  const after = await readTableGuides(page, versionId);
  // 累積位移（約 0.06/0.07）生效；非因捲動而跳動或重置
  expect(after![71]!.xRatio).toBeLessThan(baseline![71]!.xRatio - 0.03);
  expect(after![71]!.yRatio).toBeLessThan(baseline![71]!.yRatio - 0.03);
  // 其他格不變
  for (let i = 0; i < 72; i += 1) {
    if (i === 71) continue;
    expect(after![i]).toEqual(baseline![i]);
  }
});

// --- T-10：鍵盤換組（Enter 於分頁控制），組指示器更新 ---

test("T-10: keyboard (Enter on group control) switches group and updates status", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await createTableDraft(page, context, testInfo.project.name, "T10");
  await selectTableAndEnterCellMode(page);

  await expect(page.getByTestId("group-status")).toContainText("第 1/2 組");
  await page.getByTestId("group-next").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("group-status")).toContainText("第 2/2 組");
  await expect(page.getByTestId("group-next")).toBeDisabled();
  await expect(cellHandle(page, 71)).toBeVisible();
});

// --- 取消一致性（對應紅探針 P2／P3 的修復） ---

test("S2-FOCUS-RAF: pending default autofocus must yield to a newer navigation focus", async ({ context, page }, testInfo) => {
  test.setTimeout(180_000);
  await createTableDraft(page, context, testInfo.project.name, "FOCUS");
  await page.locator('button.field-row[data-field-type="table"]').first().click();
  await expect(page.getByTestId("mode-cell")).toBeVisible();

  // Hold browser frame scheduling, not application state: this makes the real
  // mode-change → focus-next → pending-autofocus interleaving deterministic.
  await page.evaluate(() => {
    const nativeRequest = window.requestAnimationFrame;
    const nativeCancel = window.cancelAnimationFrame;
    const queued = new Map<number, FrameRequestCallback>();
    let id = -1;
    window.requestAnimationFrame = callback => {
      queued.set(id, callback);
      return id--;
    };
    window.cancelAnimationFrame = handle => {
      if (handle < 0) queued.delete(handle);
      else nativeCancel.call(window, handle);
    };
    (window as any).__focusFrameProbe = {
      pending: () => queued.size,
      release: () => {
        window.requestAnimationFrame = nativeRequest;
        window.cancelAnimationFrame = nativeCancel;
        for (const callback of queued.values()) callback(performance.now());
        queued.clear();
        delete (window as any).__focusFrameProbe;
      },
    };
    document.querySelector<HTMLButtonElement>('[data-testid="mode-cell"]')!.click();
  });
  try {
    await expect(cellHandle(page, 0)).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).__focusFrameProbe.pending())).toBeGreaterThan(0);
    await page.getByTestId("group-next").focus();
    await page.evaluate(() => (window as any).__focusFrameProbe.release());
    await expect(page.getByTestId("group-next")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("group-status")).toContainText("第 2/2 組");
    await expect(page.getByTestId("group-next")).toBeDisabled();
    // With no newer user focus, default group autofocus must still work.
    await expect(cellHandle(page, 36)).toBeFocused();
    await expect(cellHandle(page, 71)).toBeVisible();
  } finally {
    await page.evaluate(() => (window as any).__focusFrameProbe?.release());
  }
});

test("Cancel/autosave: Esc cancels a drag (no server change); an unfinished drag does not leak to autosave", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const versionId = await createTableDraft(
    page,
    context,
    testInfo.project.name,
    "CNCL"
  );
  await selectTableAndEnterCellMode(page);
  await page.getByTestId("group-next").click(); // 組 2
  // 無未保存變更 → Save 必須是 no-op（證明 createTableDraft 的落盤沒有 pending）
  await assertSaveIsNoop(page);
  const baseline = await readTableGuides(page, versionId);

  // (a) Esc 取消：拖動中按 Esc，釋放後 server 不應改變（使用有移動空間的格 40）
  const handle40 = cellHandle(page, 40);
  await handle40.scrollIntoViewIfNeeded();
  await handle40.hover(); // actionability：等把手真的可接收 pointer 事件（避開 toast 浮層）
  const box = (await handle40.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const escStart = await cellStyle(page, 40);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + box.width * 0.1, cy + box.height * 0.1, {
    steps: 5,
  });
  // 先確認預覽真的存在（位移已被處理），Esc 才是「取消」而不是「什麼都沒發生」。
  await waitForStyleSettled(page, `[data-cell-index="40"]`, escStart);
  // onPointerDown 呼叫 preventDefault 會阻止把手自動聚焦；這裡顯式聚焦，
  // 讓 Esc 命中把手的 onKeyDown（setPreview(null)+stopImmediatePropagation），
  // 而不會冒泡到 window 層級的模式切換處理器（避免誤切模式／取消選取）。
  await cellHandle(page, 40).focus();
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await page.waitForTimeout(300);
  const afterEsc = await readTableGuides(page, versionId);
  expect(afterEsc).toEqual(baseline); // P2 修復：取消不保留中間值

  // (b) 未完成的拖動不流向 900ms autosave：仍處於逐格模式＋組 2（來自 (a)，
  //     且 (a) 的 Esc 已取消預覽、未切換模式／取消選取）。只重新確認逐格模式，
  //     不再點擊欄位列（避免再次點擊切換掉選取）。
  await expect(page.getByTestId("table-editing-controls")).toBeVisible();
  await page.getByTestId("mode-cell").click();
  await expect(page.getByTestId("mode-cell")).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await handle40.scrollIntoViewIfNeeded();
  await handle40.hover();
  const box2 = (await handle40.boundingBox())!;
  const cx2 = box2.x + box2.width / 2;
  const cy2 = box2.y + box2.height / 2;
  const leakStart = await cellStyle(page, 40);
  await page.mouse.move(cx2, cy2);
  await page.mouse.down();
  await page.mouse.move(cx2 + box2.width * 0.1, cy2, { steps: 5 });
  // 同上：確認未提交的預覽真的存在，下面「1.5 秒後 server 仍不變」才有意義。
  await waitForStyleSettled(page, `[data-cell-index="40"]`, leakStart);
  await page.waitForTimeout(1500); // 超過 900ms autosave 門檻，但不釋放
  const leaked = await readTableGuides(page, versionId);
  expect(leaked).toEqual(baseline); // P3 修復：未提交的中間值不流向 server
  await cellHandle(page, 40).focus();
  await page.keyboard.press("Escape");
  await page.mouse.up();
});

/**
 * S2-R1（第二輪）：兩次快速手勢（<650ms）必須各成一個 undo 項目。
 *
 * 上一版的兩個缺陷：
 *  1. 挑了 index 60（第 6 列第 1 欄）——初始 xRatio 已是最小的 0，往 -x 方向
 *     沒有任何空間，位移被 clamp 吃掉，「拖動成功」其實是假通過。
 *  2. 兩次拖動中間夾了 Save＋server 讀回（數百 ms～數秒），從未量測兩次
 *     提交之間的實際間隔，根本無法證明「<650ms」。
 * 這裡改為：先用有空間的格子並自檢座標有限與可移動範圍；兩次提交之間不做
 * 任何等待，直接量測兩次 pointerup 的間隔並斷言 <650ms；事後才讀回。
 */
test("R1: two rapid same-type gestures (<650ms) yield two separate undo entries", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const versionId = await createTableDraft(
    page,
    context,
    testInfo.project.name,
    "R1H"
  );
  await selectTableAndEnterCellMode(page);
  await page.getByTestId("group-next").click(); // 組 2

  // 無未保存變更 → Save 必須是 no-op（證明 createTableDraft 的落盤沒有 pending）
  await assertSaveIsNoop(page);
  const base = await readTableGuides(page, versionId);
  expect(base?.length ?? 0).toBe(72);

  // 兩格都選在「往 -x／-y 有實際空間」的位置：
  // index 47＝第 4 列第 12 欄（xRatio≈0.9167）、index 46＝第 4 列第 11 欄。
  const FIRST = 47;
  const SECOND = 46;
  for (const index of [FIRST, SECOND]) {
    const cell = base![index]!;
    // (a) 座標必須是有限數（NaN／Infinity 會讓後續比較靜默通過）
    for (const key of ["xRatio", "yRatio", "widthRatio", "heightRatio"])
      expect(Number.isFinite(cell[key]), `cell ${index}.${key} finite`).toBe(true);
    // (b) 往 -x／-y 確實有可移動空間，且目前位置在合法區間內
    expect(cell.xRatio, `cell ${index} has room to move left`).toBeGreaterThan(0.05);
    expect(cell.yRatio, `cell ${index} has room to move up`).toBeGreaterThan(0.05);
    expect(cell.xRatio + cell.widthRatio).toBeLessThanOrEqual(1.000001);
    expect(cell.yRatio + cell.heightRatio).toBeLessThanOrEqual(1.000001);
  }

  // 兩次提交之間不做任何 save／readback／sleep：先把兩格的 box 量好，
  // 再連續完成「按下→移動→放開」兩次，直接量測兩次 pointerup 的間隔。
  const first = cellHandle(page, FIRST);
  const second = cellHandle(page, SECOND);
  await first.scrollIntoViewIfNeeded();
  await second.scrollIntoViewIfNeeded();
  await first.hover();
  const boxFirst = (await first.boundingBox())!;
  const boxSecond = (await second.boundingBox())!;
  const p1 = {
    x: boxFirst.x + boxFirst.width / 2,
    y: boxFirst.y + boxFirst.height / 2,
  };
  const p2 = {
    x: boxSecond.x + boxSecond.width / 2,
    y: boxSecond.y + boxSecond.height / 2,
  };

  await page.mouse.move(p1.x, p1.y);
  await expectPointHits(page, p1.x, p1.y, {
    className: "mark-position-handle",
    cellIndex: FIRST,
  });
  const startFirst = await cellStyle(page, FIRST);
  await page.mouse.down();
  await page.mouse.move(
    p1.x - boxFirst.width * 0.2,
    p1.y - boxFirst.height * 0.2,
    { steps: 6 }
  );
  // 放開前等 preview 真的被處理（WebKit 會把 pointermove 留到下一個 rAF，
  // 否則整段位移會在 pointerup 之後才送達而被丟棄）。
  await waitForStyleSettled(
    page,
    `[data-cell-index="${FIRST}"]`,
    startFirst
  );
  await page.mouse.up();
  const committedFirstAt = Date.now();
  await page.mouse.move(p2.x, p2.y);
  await expectPointHits(page, p2.x, p2.y, {
    className: "mark-position-handle",
    cellIndex: SECOND,
  });
  const startSecond = await cellStyle(page, SECOND);
  await page.mouse.down();
  await page.mouse.move(
    p2.x - boxSecond.width * 0.2,
    p2.y - boxSecond.height * 0.2,
    { steps: 6 }
  );
  await waitForStyleSettled(
    page,
    `[data-cell-index="${SECOND}"]`,
    startSecond
  );
  await page.mouse.up();
  const committedSecondAt = Date.now();

  const interval = committedSecondAt - committedFirstAt;
  expect(
    interval,
    `the two commits must be <650ms apart (measured ${interval}ms)`
  ).toBeLessThan(650);

  // 事後讀回：兩次手勢都真的生效
  await saveDraft(page);
  const afterSecond = await readTableGuides(page, versionId);
  expect(afterSecond![FIRST]!.xRatio).toBeLessThan(base![FIRST]!.xRatio);
  expect(afterSecond![SECOND]!.xRatio).toBeLessThan(base![SECOND]!.xRatio);

  // undo 1：只還原第二次手勢，第一次的結果保留
  await page.keyboard.press("Control+z");
  await saveDraft(page);
  const afterUndoOne = await readTableGuides(page, versionId);
  expect(afterUndoOne![FIRST]!.xRatio).toBeCloseTo(
    afterSecond![FIRST]!.xRatio,
    6
  );
  expect(afterUndoOne![SECOND]!.xRatio).toBeCloseTo(base![SECOND]!.xRatio, 6);

  // undo 2：回到原始值
  await page.keyboard.press("Control+z");
  await saveDraft(page);
  const afterUndoTwo = await readTableGuides(page, versionId);
  expect(afterUndoTwo![FIRST]!.xRatio).toBeCloseTo(base![FIRST]!.xRatio, 6);

  // redo 逐步還原：第一次 redo 回到「只做完第一次手勢」
  await page.keyboard.press("Control+Shift+z");
  await saveDraft(page);
  const afterRedoOne = await readTableGuides(page, versionId);
  expect(afterRedoOne![FIRST]!.xRatio).toBeCloseTo(
    afterSecond![FIRST]!.xRatio,
    6
  );
  expect(afterRedoOne![SECOND]!.xRatio).toBeCloseTo(base![SECOND]!.xRatio, 6);

  // 第二次 redo 回到「兩次手勢都做完」
  await page.keyboard.press("Control+Shift+z");
  await saveDraft(page);
  const afterRedoTwo = await readTableGuides(page, versionId);
  expect(afterRedoTwo![SECOND]!.xRatio).toBeCloseTo(
    afterSecond![SECOND]!.xRatio,
    6
  );
});

/**
 * S2-R2（第二輪）：
 *  - 上一版用「guides 仍然 truthy」當作取消成功的證據，但 truthy 只代表
 *    table 還在，完全沒比較 fields／roles／guides 是否真的零變化；
 *  - 也沒有證明「確認對話框真的出現並被取消」；
 *  - 沒有涵蓋多選與「整表按鈕」的精確刪除範圍。
 */
test("R2: delete guards are exact-scope, dialog-backed and zero-change", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const versionId = await createTableDraft(
    page,
    context,
    testInfo.project.name,
    "R2D"
  );
  await selectTableAndEnterCellMode(page);

  // 多一個非表格欄位，才能驗證「多選」與「整表按鈕」的精確刪除範圍
  await page.getByRole("button", { name: /快速新增|Quick add/ }).click();
  await saveDraft(page);
  // 快速新增後作用欄位會切到新欄位，逐格把手隨之消失；這裡必須**重新選回表格
  // 並重新進入逐格模式**，否則下方「逐格上下文 Delete」其實是在沒有把手的
  // 狀態下測的（第一輪就是在這裡等到 locator 逾時）。
  await selectTableAndEnterCellMode(page);
  await expect(cellHandle(page, 0)).toBeVisible();

  const before = await readVersionDetails(page, versionId);
  const beforeIds = fieldIdsOf(before);
  const tableFieldBefore = tableFieldOf(before)!;
  const tableId = String(tableFieldBefore.id);
  const beforeDefinition = tableFieldBefore.definition;
  expect(beforeIds.length, "fixture must have table + one other field").toBe(2);
  const otherId = beforeIds.find(id => id !== tableId)!;

  // (a) 逐格／格線上下文的 Delete 不刪表：連對話框都不該出現
  let dialogs = 0;
  const countDialog = (dialog: import("@playwright/test").Dialog) => {
    dialogs += 1;
    dialog.dismiss().catch(() => {});
  };
  page.on("dialog", countDialog);
  await cellHandle(page, 0).focus(); // 組 1 的第一個把手（逐格模式）
  await page.keyboard.press("Delete");
  await page.waitForTimeout(300);
  expect(dialogs, "cell-context Delete must not open any confirm dialog").toBe(0);
  let after = await readVersionDetails(page, versionId);
  expect(fieldIdsOf(after)).toEqual(beforeIds);
  expect(tableFieldOf(after)!.definition).toEqual(beforeDefinition);

  // (b) 整表按鈕 → 取消：對話框真的出現、真的被取消、server 零變化
  await page.getByTestId("mode-field").click();
  let dialogMessage = "";
  const cancelOnce = async (dialog: import("@playwright/test").Dialog) => {
    dialogMessage = dialog.message();
    dialogs += 1;
    await dialog.dismiss();
  };
  page.off("dialog", countDialog);
  page.once("dialog", cancelOnce);
  await page.getByTestId("delete-table").click();
  await page.waitForTimeout(400);
  expect(dialogMessage, "the whole-table delete must ask for confirmation").toContain(
    "整張表格欄位"
  );
  after = await readVersionDetails(page, versionId);
  expect(fieldIdsOf(after), "cancelling must keep every field").toEqual(beforeIds);
  expect(tableFieldOf(after)!.definition, "roles/guides unchanged").toEqual(
    beforeDefinition
  );

  // (c) 多選（表格＋非表格欄位）→ 工具列刪除 → 取消：訊息涵蓋兩者，零變化
  await page.locator('button.field-row[data-field-type="table"]').first().click();
  await page
    .locator(`button.field-row:not([data-field-type="table"])`)
    .first()
    .click({ modifiers: ["Shift"] });
  dialogMessage = "";
  page.once("dialog", cancelOnce);
  // 「刪除」在畫面上同時命中工具列圖示鈕、來源刪除鈕與整表刪除鈕；
  // 這裡要的是**工具列刪除**（多選刪除），必須用 exact 精確指定。
  await page.getByRole("button", { name: "刪除", exact: true }).click();
  await page.waitForTimeout(400);
  expect(dialogMessage, "multi-select confirm must mention the extra field").toContain(
    "另外還有 1 個非表格欄位"
  );
  after = await readVersionDetails(page, versionId);
  expect(fieldIdsOf(after)).toEqual(beforeIds);

  // (d) 多選下按「整表按鈕」→ 確認：精確只刪表格，另一個欄位仍在
  page.once("dialog", async dialog => {
    dialogMessage = dialog.message();
    await dialog.accept();
  });
  await page.getByTestId("delete-table").click();
  await page.waitForTimeout(400);
  await saveDraft(page);
  after = await readVersionDetails(page, versionId);
  const afterIds = fieldIdsOf(after);
  // 精確範圍：表格欄位消失（id 不復見），且逐格模式下再無 table 欄位
  expect(afterIds, "the deleted table id must be gone").not.toContain(tableId);
  expect(afterIds.length, "only the table may be removed").toBe(beforeIds.length - 1);
  expect(tableFieldOf(after), "no table field remains").toBeUndefined();
  // 共同選取的非表格欄位必須存活。
  // 注意：server 在「刪除＋儲存」後會重新指派欄位 id（實測 fld_5b3586d4… →
  // fld_517ae2fd…，type／coordinate／label 完全相同），因此這裡不能用 id 相等
  // 判定存活（那會因為 id 重編而誤判成「被刪掉」），改以穩定身分比對：
  // fieldType + coordinate + definition.label 全部相同才算同一個欄位。
  const otherBefore = (
    before.fields as Array<Record<string, unknown>>
  ).find(field => String(field.id) === otherId)!;
  const survivor = (after.fields as Array<Record<string, unknown>>)[0]!;
  expect(String(survivor.id), "the survivor must not be the deleted table").not.toBe(
    tableId
  );
  expect(survivor.fieldType).toBe(otherBefore.fieldType);
  expect(survivor.coordinate).toEqual(otherBefore.coordinate);
  expect(
    (survivor.definition as { label?: string }).label ?? ""
  ).toBe((otherBefore.definition as { label?: string }).label ?? "");
  page.off("dialog", countDialog);
});

// --- S2-R4：進入逐格模式後聚焦第一個非 fixed 把手；跳格聚焦指定 index；Ctrl+C 不切模式 ---

/**
 * S2-R4（第二輪）：
 *  - 上一版的「L6」實際選的是欄 A → index 60（第 6 列第 1 欄），根本不是 L 欄；
 *    正確的 L6（第 6 列第 12 欄）絕對 index 應為 71。
 *  - Ctrl+C 上一版從 cell 模式出發、再確認「還是 cell」：即使快捷鍵把模式切
 *    成 cell 也會通過，等於證明不了任何事。這裡改從**欄位模式／格線模式**
 *    出發，確認 Ctrl+C（與 Meta+C）不會把模式切到逐格。
 */
test("R4: group change focuses first handle; jump-to-cell L6 focuses index 71; Ctrl+C never switches mode", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  await createTableDraft(page, context, testInfo.project.name, "R4F");
  await selectTableAndEnterCellMode(page);

  // 進入 cell mode（組 1）：第一個非 fixed 把手應自動獲得焦點
  await expect(cellHandle(page, 0)).toBeFocused();

  // 換到組 2：第一個非 fixed 把手（index 36）應獲得焦點，且 index 36 可見
  await page.getByTestId("group-next").click();
  await expect(cellHandle(page, 36)).toBeFocused();
  await expect(cellHandle(page, 36)).toBeVisible();

  // 跳到 L6（第 6 列第 12 欄）＝絕對 index 71：聚焦該指定把手
  await page.locator('select[aria-label="選擇列"]').selectOption({ label: "第 6 列" });
  await page.locator('select[aria-label="選擇欄"]').selectOption({ label: "欄 L" });
  await page.getByTestId("jump-go").click();
  await expect(cellHandle(page, 71)).toBeFocused();
  await expect(cellHandle(page, 71)).toBeVisible();

  // Ctrl+C 不得切換模式：從**格線模式**出發（不是 cell 模式）
  await page.getByTestId("mode-gridline").click();
  await expect(page.getByTestId("mode-gridline")).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await page.keyboard.press("Control+c");
  await expect(page.getByTestId("mode-gridline")).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expect(page.getByTestId("mode-cell")).toHaveAttribute(
    "aria-pressed",
    "false"
  );

  // Meta+C 同樣不得切換模式
  await page.keyboard.press("Meta+c");
  await expect(page.getByTestId("mode-gridline")).toHaveAttribute(
    "aria-pressed",
    "true"
  );

  // 從欄位模式出發：Ctrl+C 也不得切到逐格
  await page.getByTestId("mode-field").click();
  await page.keyboard.press("Control+c");
  await expect(page.getByTestId("mode-field")).toHaveAttribute(
    "aria-pressed",
    "true"
  );

  // 輸入框／可編輯元素內的 C 不應被當成模式快捷鍵
  const nameInput = page.locator("#template-name, input[type='text']").first();
  await nameInput.focus();
  await page.keyboard.press("c");
  await expect(page.getByTestId("mode-field")).toHaveAttribute(
    "aria-pressed",
    "true"
  );
});

// --- S2-R4 #5：published Version 不顯示本輪可寫工具 ---

/**
 * S2-R4 #5（第二輪）：上一版只「按下發佈按鈕 + 等 1 秒」——按鈕按下去不代表
 * 真的發佈成功（欄位未確認就會被擋下），因此後續的「工具隱藏」其實可能是
 * 在 draft 上觀察到的。這裡改為：
 *  1. 先「全部確認」並保存，讓發佈合法；
 *  2. 等 `formdigital.templates.publish` 的**正式回應**並斷言成功；
 *  3. 以 server 讀回證明 `version.state === "published"`；
 *  4. 最後才驗證本輪可寫工具被隱藏。
 */
test("R4: published version hides the table editing tools", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const versionId = await createTableDraft(
    page,
    context,
    testInfo.project.name,
    "R4P"
  );
  await selectTableAndEnterCellMode(page);
  await expect(page.getByTestId("table-editing-controls")).toBeVisible();

  // 1. 讓發佈合法：所有欄位命名並人工確認後保存
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "全部確認" }).click();
  await saveDraft(page);

  // 2. 等正式 publish 回應（不是「按了按鈕」）
  const published = page.waitForResponse(
    response => response.url().includes("formdigital.templates.publish"),
    { timeout: 30_000 }
  );
  await page.getByRole("button", { name: "發佈" }).click();
  const publishResponse = await published;
  expect(
    publishResponse.status(),
    "publish mutation must succeed"
  ).toBeLessThan(400);
  await publishResponse.finished();

  // 3. server 讀回：version.state 必須真的是 published
  const details = await readVersionDetails(page, versionId);
  expect(
    String(details.version.state),
    "server must report the version as published"
  ).toBe("published");

  // 4. 工具隱藏（同一份 versionId，不是切到別的 Draft）
  await page.locator('button.field-row[data-field-type="table"]').first().click();
  await expect(page.getByTestId("table-editing-controls")).toHaveCount(0);
  expect(page.url()).toContain(encodeURIComponent(versionId));
});

// ===========================================================================
// S2-R1（第二輪）：表格手勢生命週期——以下情境在上一輪都「沒有實際測試」，
// 現在各自成為獨立的永久回歸，不再掛在 R1／R4 名下充數。
// ===========================================================================

// --- 情境 A：整表鍵盤微調必須以最新 preview 累加，且未按 Enter 前不入伺服器 ---

test("R1B: whole-table keyboard nudge accumulates from the latest preview and only commits on Enter", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const versionId = await createTableDraft(
    page,
    context,
    testInfo.project.name,
    "R1B"
  );
  // 欄位模式（整表微調只在 field 模式發生）
  await page.locator('button.field-row[data-field-type="table"]').first().click();
  await expect(page.getByTestId("table-editing-controls")).toBeVisible();
  const overlay = page.locator(".field-overlay.is-active");
  await overlay.focus();

  const startLeft = await fieldLeftPercent(page);
  const baselineMm = tableXMm(await readVersionDetails(page, versionId));

  // 連按三次 ArrowRight：每次都必須從「最新 preview」累加（不是從原值重算）
  await page.keyboard.press("ArrowRight");
  const left1 = await fieldLeftPercent(page);
  await page.keyboard.press("ArrowRight");
  const left2 = await fieldLeftPercent(page);
  await page.keyboard.press("ArrowRight");
  const left3 = await fieldLeftPercent(page);
  expect(left1).toBeGreaterThan(startLeft);
  expect(left2).toBeGreaterThan(left1);
  expect(left3).toBeGreaterThan(left2);
  // 步幅 0.2% × 3
  expect(left3 - startLeft).toBeCloseTo(0.6, 3);

  // preview-only：未按 Enter 前伺服器不應有任何變化（連 no-op 保存都不該發請求）
  await assertSaveIsNoop(page);
  expect(tableXMm(await readVersionDetails(page, versionId))).toBeCloseTo(
    baselineMm,
    6
  );

  // Enter 提交一次。
  // 注意：`assertSaveIsNoop` 剛點過 Save 按鈕，焦點已不在表格上；若不重新聚焦，
  // Enter 會落在 Save 按鈕上（等於再按一次 no-op 保存），preview 永遠不會提交。
  await overlay.focus();
  await page.keyboard.press("Enter");
  await saveDraft(page);
  const committedMm = tableXMm(await readVersionDetails(page, versionId));
  expect(committedMm, "Enter must commit the accumulated nudge").toBeGreaterThan(
    baselineMm + 1
  );
  const committedLeft = await fieldLeftPercent(page);
  expect(committedLeft).toBeCloseTo(left3, 3);

  // 情境 B：微調 → Esc 取消 → 重新選取 → Enter：不得提交已取消的內容
  await overlay.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  const movedLeft = await fieldLeftPercent(page);
  expect(movedLeft).toBeGreaterThan(committedLeft);
  await page.keyboard.press("Escape");
  // Esc 只取消手勢：**不得**取消欄位選取（.field-overlay.is-active 必須還在），
  // 也不得切換模式。
  await expect(page.locator(".field-overlay.is-active")).toHaveCount(1);
  // Esc 之後 preview 必須消失，畫面回到已提交的值
  await expect
    .poll(() => fieldLeftPercent(page), { timeout: 5_000 })
    .toBeCloseTo(committedLeft, 3);
  // 取消後重新聚焦表格並按 Enter：不得復活剛才取消的位移
  await page.locator(".field-overlay.is-active").focus();
  await page.keyboard.press("Enter");
  await assertSaveIsNoop(page);
  expect(tableXMm(await readVersionDetails(page, versionId))).toBeCloseTo(
    committedMm,
    6
  );
});

// --- 情境 C：正常拖動 → Esc → 繼續移動 → 放開 → 超過 autosave → 讀回＋reload 仍是原始值 ---

test("R1C: an Esc-cancelled drag does not resurrect on continue-move, release or reload", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const versionId = await createTableDraft(
    page,
    context,
    testInfo.project.name,
    "R1C"
  );
  await selectTableAndEnterCellMode(page);
  // 無未保存變更 → Save 必須是 no-op（證明 createTableDraft 的落盤沒有 pending）
  await assertSaveIsNoop(page);
  const baseline = await readTableGuides(page, versionId);

  const handle = cellHandle(page, 0);
  await handle.scrollIntoViewIfNeeded();
  await handle.hover();
  const box = (await handle.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const cancelStart = await cellStyle(page, 0);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + box.width * 0.3, cy + box.height * 0.3, { steps: 4 });
  // Esc 取消當次（清掉 preview 與手勢）。先等預覽真的建立，取消才有對象。
  await waitForStyleSettled(page, `[data-cell-index="0"]`, cancelStart);
  await cellHandle(page, 0).focus();
  await page.keyboard.press("Escape");
  // 繼續移動並放開：取消後不得復活
  await page.mouse.move(cx + box.width * 0.6, cy + box.height * 0.6, { steps: 4 });
  await page.mouse.up();
  // 超過 900ms autosave 門檻
  await page.waitForTimeout(1500);

  const afterEsc = await readTableGuides(page, versionId);
  expect(afterEsc).toEqual(baseline);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", { name: `WF R1C · v1` })
  ).toBeVisible({ timeout: 90_000 });
  const reloaded = await readTableGuides(page, versionId);
  expect(reloaded).toEqual(baseline);
});

// --- 情境 D：未提交操作存在時衝突入口停用；換表重置模式／組／跳格 ---

test("R1D: conflicting shortcuts are blocked while a table gesture is uncommitted; switching table resets mode/group/jump", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  await createTableDraft(page, context, testInfo.project.name, "R1D");
  await selectTableAndEnterCellMode(page);

  // 用鍵盤微調建立「未提交」狀態（沒有 pointer 手勢，純 preview）
  const handle = cellHandle(page, 0);
  await handle.focus();
  const leftBefore = await handle.evaluate(element =>
    parseFloat((element as HTMLElement).style.left)
  );
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  const leftPreview = await handle.evaluate(element =>
    parseFloat((element as HTMLElement).style.left)
  );
  expect(leftPreview, "keyboard nudge must move the preview").toBeGreaterThan(
    leftBefore
  );

  // 自校：兩次方向鍵真的把 preview 從 0 推到 2%（每次 1%），否則下方的
  // 「Ctrl+S/Ctrl+Z 被停用」與「Esc 還原」都可能是在沒有 preview 的狀態下假通過。
  expect(leftBefore, "cell 0 starts at x=0").toBe(0);
  expect(leftPreview, "two nudges must accumulate to 2%").toBe(2);

  // Ctrl+S：有未提交操作時不得真的送出 saveDraftFields
  let saveRequests = 0;
  const counter = (response: import("@playwright/test").Response) => {
    if (response.url().includes("formdigital.templates.saveDraftFields"))
      saveRequests += 1;
  };
  page.on("response", counter);
  await page.keyboard.press("Control+s");
  await page.waitForTimeout(700);
  expect(saveRequests, "Ctrl+S must be blocked while a gesture is pending").toBe(0);

  // Ctrl+Z（undo）：不得在 preview 存在時偷偷改動／提交
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(300);
  expect(
    await handle.evaluate(element =>
      parseFloat((element as HTMLElement).style.left)
    ),
    "Ctrl+Z must not act while a gesture is pending"
  ).toBeCloseTo(leftPreview, 3);
  page.off("response", counter);
  // Ctrl+S／Ctrl+Z 被停用時必須「吃掉事件」：焦點不得被瀏覽器預設復原行為
  // 移到別的輸入框，否則後續 Esc 打不到把手，取消就失效了。
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          return el ? el.className.trim() : "none";
        }),
      { timeout: 3_000 }
    )
    .toBe("mark-position-handle");

  // Esc 取消後回到原始位置，且**不得切換模式**（preview 存在時 Esc 由把手自己
  // 消化並阻止冒泡，不再逐格→格線→欄位）。
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("mode-cell")).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  // 以 poll 讀取「穩定後」的值：單次 evaluate 會在 React 尚未 flush 時讀到舊值，
  // 造成「其實有還原、卻被判成沒還原」的假失敗。
  await expect
    .poll(
      () =>
        handle.evaluate(element =>
          parseFloat((element as HTMLElement).style.left)
        ),
      { timeout: 5_000 }
    )
    .toBeCloseTo(leftBefore, 3);
  await assertSaveIsNoop(page);

  // 換表／換選取重置：進入逐格模式＋組 2 並設定跳格後，切到別的欄位再切回來
  await page.getByTestId("group-next").click();
  await expect(page.getByTestId("group-status")).toContainText("2");
  await page.locator('select[aria-label="選擇列"]').selectOption({ label: "第 5 列" });
  await page.getByRole("button", { name: /快速新增|Quick add/ }).click(); // 換到新欄位
  await page.locator('button.field-row[data-field-type="table"]').first().click();
  // 模式必須回到欄位模式、組回到第 1 組、跳格選擇回到預設
  await expect(page.getByTestId("mode-field")).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await page.getByTestId("mode-cell").click();
  await expect(page.getByTestId("group-status")).toContainText("1");
  await expect(page.locator('select[aria-label="選擇列"]')).toHaveValue("1");
});

/**
 * S2-R3（第三輪）：共享格線疊層容器的實際像素尺寸。
 *
 * `applyDelta` 的位移分母是「容器」而非把手，因此要把百分比換算回像素，
 * 才能用確切數字驗證（不只驗方向或大於零）。
 */
async function overlayRect(page: Page): Promise<{ width: number; height: number }> {
  return page.evaluate(() => {
    const line = document.querySelector(
      '[data-testid="table-gridline"]'
    ) as HTMLElement | null;
    const parent = line?.parentElement as HTMLElement | null;
    if (!parent) throw new Error("gridline overlay container not found");
    const rect = parent.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });
}

function gridlineSelector(axis: string, boundary: number): string {
  return `[data-testid="table-gridline"][data-axis="${axis}"][data-boundary="${boundary}"]`;
}

/** 讀取分隔線目前的行內位置百分比（水平＝top、垂直＝left）。 */
function percentOf(style: string, axis: string): number {
  const key = axis === "horizontal" ? "top" : "left";
  const match = style.match(new RegExp(`${key}:\\s*(-?[\\d.]+)%`));
  if (!match) throw new Error(`no ${key} percent in style: ${style}`);
  return Number.parseFloat(match[1]!);
}

/**
 * S2-R3（第三輪）：以真實指標拖動一條共享格線。
 *
 * `offsets` 是**從 pointerdown 起點算起**的累計像素位移，每一步都用
 * `waitForStyleSettled` 讓 React 真的處理完該次 pointermove 才繼續
 * （WebKit 會把連續 pointermove 留到下一個 rAF）。回傳每一次移動後
 * 穩定下來的預覽百分比，供「確切幾何」斷言使用。
 */
async function dragGridline(
  page: Page,
  axis: string,
  boundary: number,
  offsets: number[]
): Promise<{ startPercent: number; percents: number[] }> {
  const selector = gridlineSelector(axis, boundary);
  const line = page.locator(selector).first();
  await expect(line).toBeVisible();
  // The workflow guide can place the canvas below the initial viewport.
  // Scroll first, then measure: coordinates captured before hover/scroll are
  // stale and document.elementFromPoint correctly returns null for them.
  await line.scrollIntoViewIfNeeded();
  let box = (await line.boundingBox())!;
  // 水平線取第一欄中段 x、垂直線取第一列中段 y，避開兩者交點搶走 pointerdown。
  let localX = axis === "horizontal" ? box.width * 0.04 : box.width / 2;
  let localY = axis === "vertical" ? box.height * 0.04 : box.height / 2;
  await line.hover({ position: { x: localX, y: localY } });
  box = (await line.boundingBox())!;
  localX = axis === "horizontal" ? box.width * 0.04 : box.width / 2;
  localY = axis === "vertical" ? box.height * 0.04 : box.height / 2;
  const px = box.x + localX;
  const py = box.y + localY;
  await expectPointHits(page, px, py, { testId: "table-gridline" });
  const start = await readInlineStyle(page, selector);
  await page.mouse.move(px, py);
  await page.mouse.down();
  const styles: string[] = [];
  let previous = start;
  for (const offset of offsets) {
    await page.mouse.move(
      axis === "horizontal" ? px : px + offset,
      axis === "horizontal" ? py + offset : py
    );
    previous = await waitForStyleSettled(page, selector, previous);
    styles.push(previous);
  }
  await page.mouse.up();
  return {
    startPercent: percentOf(start, axis),
    percents: styles.map(style => percentOf(style, axis)),
  };
}

/** 把百分比位移換算成像素，讓斷言用「px」這種確切單位表達。 */
function percentToPx(percent: number, size: number): number {
  return (percent / 100) * size;
}

/**
 * S2-R4（第四輪）：等待行內預覽「收斂」，**不預期它一定要改變**。
 *
 * `waitForStyleSettled` 專供「位移必須發生」的步驟（沒改變就丟錯）；但
 * 「手勢中按方向鍵」在修正後的正確行為是**完全不動**，用前者會直接丟錯。
 * 這裡改成：先給 React 處理本次事件的時間，再要求連續三次取樣相同
 * （改變了就重新計數），因此「有變」與「沒變」都能正確收斂。
 */
async function waitForStyleStable(
  page: Page,
  selector: string,
  previous: string
): Promise<string> {
  await page.waitForTimeout(120);
  let last = await readInlineStyle(page, selector);
  let stable = 0;
  for (let i = 0; i < 24; i += 1) {
    await page.waitForTimeout(50);
    const cur = await readInlineStyle(page, selector);
    if (cur === last) {
      stable += 1;
      if (stable >= 3) return cur;
    } else {
      last = cur;
      stable = 0;
    }
  }
  throw new Error(
    `preview for ${selector} never became stable (previous=${previous})`
  );
}

/**
 * S2-R4（第四輪）：一次指標手勢中夾入按鍵的「混合操作」。
 *
 * `steps` 依序執行：`move` 是**從 pointerdown 起點算起**的累計像素位移，
 * `key` 是手勢進行中按下的鍵。`move` 步驟用 `waitForStyleSettled`（必須真的
 * 移動），`key` 步驟用 `waitForStyleStable`（允許完全不動），兩者都會等到
 * React 真的處理完該次事件才繼續，避免量到被 WebKit 合併／丟棄的輸入。
 *
 * 手勢開始前會先 `focus()`：`startDrag` 對 pointerdown 呼叫了
 * `preventDefault()`（避免瀏覽器改焦點），若沒有先聚焦，手勢中的方向鍵
 * 會送不到分隔線的 `onKeyDown`，測試就變成空測試。
 */
async function mixedGridlineGesture(
  page: Page,
  axis: string,
  boundary: number,
  steps: Array<{ move?: number; key?: string }>
): Promise<{ startPercent: number; percents: number[] }> {
  const selector = gridlineSelector(axis, boundary);
  const line = page.locator(selector).first();
  await expect(line).toBeVisible();
  const box = (await line.boundingBox())!;
  // 水平線取第一欄中段 x、垂直線取第一列中段 y，避開兩者交點搶走 pointerdown。
  const localX = axis === "horizontal" ? box.width * 0.04 : box.width / 2;
  const localY = axis === "vertical" ? box.height * 0.04 : box.height / 2;
  const px = box.x + localX;
  const py = box.y + localY;
  await line.focus();
  await line.hover({ position: { x: localX, y: localY } });
  await expectPointHits(page, px, py, { testId: "table-gridline" });
  const start = await readInlineStyle(page, selector);
  await page.mouse.move(px, py);
  await page.mouse.down();
  const styles: string[] = [];
  let previous = start;
  for (const step of steps) {
    if (step.key !== undefined) {
      await page.keyboard.press(step.key);
      previous = await waitForStyleStable(page, selector, previous);
    } else {
      const offset = step.move ?? 0;
      await page.mouse.move(
        axis === "horizontal" ? px : px + offset,
        axis === "horizontal" ? py + offset : py
      );
      previous = await waitForStyleSettled(page, selector, previous);
    }
    styles.push(previous);
  }
  await page.mouse.up();
  return {
    startPercent: percentOf(start, axis),
    percents: styles.map(style => percentOf(style, axis)),
  };
}

// --- 情境 E：拖動中縮放（真實 WheelEvent 經應用程式監聽器）→ 位移仍正確、其他格不變 ---

test("R1E: zooming mid-drag keeps the displacement correct and leaves other cells untouched", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const versionId = await createTableDraft(
    page,
    context,
    testInfo.project.name,
    "R1E"
  );
  await selectTableAndEnterCellMode(page);
  await page.getByTestId("group-next").click(); // 組 2
  // 無未保存變更 → Save 必須是 no-op（證明 createTableDraft 的落盤沒有 pending）
  await assertSaveIsNoop(page);
  const baseline = await readTableGuides(page, versionId);

  const handle = cellHandle(page, 71);
  await handle.scrollIntoViewIfNeeded();
  await handle.hover();
  const box = (await handle.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const zoomStart = await cellStyle(page, 71);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - box.width * 0.3, cy - box.height * 0.3, { steps: 4 });
  // 拖動中縮放：錨點是「容器比例」，縮放後每次 move 都用當下 rect 重新換算
  await zoomCanvasByWheel(page, -120);
  await page.waitForTimeout(300);
  // 重新讀取縮放後的把手位置，再往同方向續移
  const zoomed = (await handle.boundingBox())!;
  await page.mouse.move(
    zoomed.x + zoomed.width / 2 - zoomed.width * 0.3,
    zoomed.y + zoomed.height / 2 - zoomed.height * 0.3,
    { steps: 4 }
  );
  // 同上：等續移的預覽真的被處理再放開。
  await waitForStyleSettled(page, `[data-cell-index="71"]`, zoomStart);
  await page.mouse.up();
  await saveDraft(page);

  const after = await readTableGuides(page, versionId);
  const dx = baseline![71]!.xRatio - after![71]!.xRatio;
  const dy = baseline![71]!.yRatio - after![71]!.yRatio;
  // 方向正確、位移真的發生（不是被重置成 0，也不是跳到離譜的量）
  expect(dx, "x displacement must be positive (moved left)").toBeGreaterThan(0.005);
  expect(dy, "y displacement must be positive (moved up)").toBeGreaterThan(0.005);
  expect(dx).toBeLessThan(0.5);
  expect(dy).toBeLessThan(0.5);
  // 其他 71 格完全不變
  for (let i = 0; i < 72; i += 1) {
    if (i === 71) continue;
    expect(after![i]).toEqual(baseline![i]);
  }
});

// --- 情境 F（第三輪 P1）：共享格線的連續 pointermove 不得重複累加位移 ---

/**
 * S2-R3（第三輪 P1）：`TableGridOverlay` 曾用 `sourceGuides = preview ?? rawGuides`
 * 同時供應鍵盤（需從最新 preview 累加）與滑鼠（delta 是從 pointerdown 起點算的
 * 絕對差）。兩者混用會讓每一次 pointermove 把「從起點算起的總距離」再加進
 * 已經移動過的 preview：依次移 +4／+8／+12px，預覽會變成 51%／53%／56%，
 * 放手提交 0.56；正確應為 51%／52%／53%，提交 0.53。
 *
 * 這裡用**確切像素**驗證（不是只驗方向或大於零）：
 *  - 每一段增量都必須等於該段的實際像素位移（三段相等）；
 *  - 提交值必須等於「最後一次」絕對位移（12px），不是三段總和（24px）；
 *  - 相同終點、不同事件數（一次到位 vs 三次分段）必須得到相同結果；
 *  - 移回起點必須是零變更。
 */
test("R3B: shared gridline pointer drag never accumulates across pointermove events", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  const versionId = await createTableDraft(
    page,
    context,
    testInfo.project.name,
    "R3B"
  );
  await page.locator('button.field-row[data-field-type="table"]').first().click();
  await page.getByTestId("mode-gridline").click();
  await expect(page.locator('[data-testid="table-gridline"]').first()).toBeVisible();

  const base = (await readTableGuides(page, versionId))!;
  expect(base.length).toBe(72);
  const rect = await overlayRect(page);
  expect(rect.height, "overlay height must be measurable").toBeGreaterThan(40);
  expect(rect.width, "overlay width must be measurable").toBeGreaterThan(40);
  // 一個像素等於多少 ratio；斷言統一換算成 px（容忍 ±1.5px 的量測／取整誤差）
  const TOL = 1.5;

  // --- (1) 水平 boundary 1：連續三次 +4／+8／+12px（從起點算的累計位置）---
  const h1 = await dragGridline(page, "horizontal", 1, [4, 8, 12]);
  const inc1 = [
    h1.percents[0]! - h1.startPercent,
    h1.percents[1]! - h1.percents[0]!,
    h1.percents[2]! - h1.percents[1]!,
  ].map(value => percentToPx(value, rect.height));
  // 每段都是 4px：三段增量必須相等（舊行為會是 4／8／12px）
  for (const [index, value] of inc1.entries()) {
    expect(
      Math.abs(value - 4),
      `horizontal segment ${index + 1} must move exactly 4px (got ${value}px)`
    ).toBeLessThan(TOL);
  }
  await saveDraft(page);
  const g1 = (await readTableGuides(page, versionId))!;
  // 提交值＝最後一次絕對位移 12px，不是 4+8+12=24px
  const committed1Px = (g1[12]!.yRatio - base[12]!.yRatio) * rect.height;
  expect(
    Math.abs(committed1Px - 12),
    `commit must equal the last absolute offset 12px (got ${committed1Px}px)`
  ).toBeLessThan(TOL);
  expect(
    committed1Px,
    `commit must not be the accumulated 24px (got ${committed1Px}px)`
  ).toBeLessThan(18);

  // --- (2) 水平 boundary 2：一次到位 +12px（相同終點、不同事件數）---
  await dragGridline(page, "horizontal", 2, [12]);
  await saveDraft(page);
  const g2 = (await readTableGuides(page, versionId))!;
  const committed2Px = (g2[24]!.yRatio - g1[24]!.yRatio) * rect.height;
  expect(
    Math.abs(committed2Px - committed1Px),
    `same endpoint with fewer events must commit the same value (${committed1Px}px vs ${committed2Px}px)`
  ).toBeLessThan(TOL);

  // --- (3) 水平 boundary 3：移出去 12px 再移回起點 → 零變更 ---
  const h3 = await dragGridline(page, "horizontal", 3, [12, 0]);
  expect(
    Math.abs(h3.percents[1]! - h3.startPercent),
    "returning to the start must restore the original preview"
  ).toBeLessThan(0.05);
  // 沒有提交 → Save 必須是 no-op（若舊行為提交了殘留 preview，這裡會收到請求而失敗）
  await assertSaveIsNoop(page);
  const g3 = (await readTableGuides(page, versionId))!;
  expect(g3, "moving back to the start must change nothing").toEqual(g2);

  // --- (4) 垂直 boundary 1：連續三次 +4／+8／+12px ---
  const v1 = await dragGridline(page, "vertical", 1, [4, 8, 12]);
  const incV = [
    v1.percents[0]! - v1.startPercent,
    v1.percents[1]! - v1.percents[0]!,
    v1.percents[2]! - v1.percents[1]!,
  ].map(value => percentToPx(value, rect.width));
  for (const [index, value] of incV.entries()) {
    expect(
      Math.abs(value - 4),
      `vertical segment ${index + 1} must move exactly 4px (got ${value}px)`
    ).toBeLessThan(TOL);
  }
  await saveDraft(page);
  const g4 = (await readTableGuides(page, versionId))!;
  const committed3Px = (g4[1]!.xRatio - g3[1]!.xRatio) * rect.width;
  expect(
    Math.abs(committed3Px - 12),
    `vertical commit must equal 12px (got ${committed3Px}px)`
  ).toBeLessThan(TOL);
  // 垂直只動第 1、2 欄；其餘 60 格不變
  for (let i = 0; i < 72; i += 1) {
    if (i % 12 === 0 || i % 12 === 1) continue;
    expect(g4[i]).toEqual(g3[i]);
  }
});

/**
 * S2-R3（第三輪 P1）：鍵盤與取消的路徑仍必須維持原語意——
 *  - 每次方向鍵從**最新 preview** 累加（1 次 1%），三次應為 +3%；
 *  - Enter 只提交一次；
 *  - Esc 後預覽歸零、Save 是 no-op；
 *  - 拖動中 Esc 之後「繼續移動」與「放手」都不再提交。
 */
test("R3C: gridline keyboard nudge accumulates from the latest preview; Esc commits nothing", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  const versionId = await createTableDraft(
    page,
    context,
    testInfo.project.name,
    "R3C"
  );
  await page.locator('button.field-row[data-field-type="table"]').first().click();
  await page.getByTestId("mode-gridline").click();
  await expect(page.locator('[data-testid="table-gridline"]').first()).toBeVisible();

  const base = (await readTableGuides(page, versionId))!;
  const rect = await overlayRect(page);

  // --- (1) 鍵盤連按三次 ArrowDown（每次 1 個百分點，從最新預覽累加）---
  const sel4 = gridlineSelector("horizontal", 4);
  const line4 = page.locator(sel4).first();
  await line4.focus();
  const start4 = await readInlineStyle(page, sel4);
  let previous = start4;
  const steps: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    await page.keyboard.press("ArrowDown");
    previous = await waitForStyleSettled(page, sel4, previous);
    steps.push(previous);
  }
  const deltas = [
    percentOf(steps[0]!, "horizontal") - percentOf(start4, "horizontal"),
    percentOf(steps[1]!, "horizontal") - percentOf(steps[0]!, "horizontal"),
    percentOf(steps[2]!, "horizontal") - percentOf(steps[1]!, "horizontal"),
  ];
  for (const [index, value] of deltas.entries()) {
    expect(
      Math.abs(value - 1),
      `keyboard nudge ${index + 1} must be exactly 1 percentage point (got ${value})`
    ).toBeLessThan(0.05);
  }
  // Enter 提交一次（0.03 ratio）
  await page.keyboard.press("Enter");
  await saveDraft(page);
  const g1 = (await readTableGuides(page, versionId))!;
  const movedPx = (g1[48]!.yRatio - base[48]!.yRatio) * rect.height;
  expect(
    Math.abs(movedPx - 0.03 * rect.height),
    `Enter must commit the accumulated 3% (got ${movedPx}px of ${0.03 * rect.height}px)`
  ).toBeLessThan(1.5);

  // --- (2) Esc 取消鍵盤微調 → 零提交 ---
  const sel5 = gridlineSelector("horizontal", 5);
  const line5 = page.locator(sel5).first();
  await line5.focus();
  const start5 = await readInlineStyle(page, sel5);
  await page.keyboard.press("ArrowDown");
  const nudged1 = await waitForStyleSettled(page, sel5, start5);
  await page.keyboard.press("ArrowDown");
  const nudged2 = await waitForStyleSettled(page, sel5, nudged1);
  expect(
    percentOf(nudged2, "horizontal") - percentOf(start5, "horizontal"),
    "two nudges must move 2 percentage points before Esc"
  ).toBeCloseTo(2, 1);
  await page.keyboard.press("Escape");
  const afterEsc = await waitForStyleSettled(page, sel5, nudged2);
  expect(
    percentOf(afterEsc, "horizontal"),
    "Esc must restore the committed geometry"
  ).toBeCloseTo(percentOf(start5, "horizontal"), 1);
  // 沒有任何未提交變更 → Save 必須是 no-op
  await assertSaveIsNoop(page);
  const g2 = (await readTableGuides(page, versionId))!;
  expect(g2, "Esc must commit nothing").toEqual(g1);

  // --- (3) 拖動中 Esc：之後繼續移動與放手都不提交 ---
  await line5.scrollIntoViewIfNeeded();
  let box = (await line5.boundingBox())!;
  let localX = box.width * 0.04;
  let localY = box.height / 2;
  await line5.hover({ position: { x: localX, y: localY } });
  box = (await line5.boundingBox())!;
  localX = box.width * 0.04;
  localY = box.height / 2;
  const px = box.x + localX;
  const py = box.y + localY;
  await expectPointHits(page, px, py, { testId: "table-gridline" });
  const beforeDrag = await readInlineStyle(page, sel5);
  await page.mouse.move(px, py);
  await page.mouse.down();
  await page.mouse.move(px, py + 20);
  const dragged = await waitForStyleSettled(page, sel5, beforeDrag);
  expect(
    percentOf(dragged, "horizontal"),
    "the drag must really produce a preview before Esc"
  ).not.toBeCloseTo(percentOf(beforeDrag, "horizontal"), 1);
  await page.keyboard.press("Escape");
  const cancelled = await waitForStyleSettled(page, sel5, dragged);
  // Esc 之後繼續移動：預覽不得復活
  await page.mouse.move(px, py + 60);
  await page.waitForTimeout(300);
  const afterContinue = await readInlineStyle(page, sel5);
  await page.mouse.up();
  await assertSaveIsNoop(page);
  const g3 = (await readTableGuides(page, versionId))!;
  expect(g3, "moving and releasing after Esc must commit nothing").toEqual(g2);
  expect(
    percentOf(afterContinue, "horizontal"),
    "continuing to move after Esc must not resurrect a preview"
  ).toBeCloseTo(percentOf(cancelled, "horizontal"), 1);
});

// --- 情境 G（第四輪 P1）：混合手勢（拖動中按方向鍵）不得讓座標錯位 ---

/**
 * S2-R4（第四輪 P1）：指標手勢與鍵盤微調同時作用於同一條格線時會錯位。
 *
 * 測試以真實 `TableGridOverlay`＋Chrome 重現（400×400、2×2、水平線 50%）：
 *   pointerdown → 移 12px（53%）→ ArrowDown（54%）→ 續移到「起算 16px」
 *   → 實際 **58%**，放手提交 `.5800000000000001`；正確應 55%。
 * 根因：`applyDelta` 把 `gesture.current.startGuides` 推進到含鍵盤位移的
 * 最新幾何，卻沒有同步指標起始錨點 `startRatioX/Y`；下一次 pointermove
 * 用「從起點算起的絕對 delta」去算，等於把既有位移**再算一次**。
 *
 * 本輪採用的策略（明確記錄）：**指標手勢進行期間忽略方向鍵微調**。
 * 因此正確值不是 55%（那是「支援混合」策略下的值），而是：
 *   - 移 12px → +12px；
 *   - 手勢中 ArrowDown → **不移動**（仍 +12px）；
 *   - 續移到起算 16px → +16px（絕對值，不是 12+4+4）；
 *   - 放手提交 = 起點 +16px。
 * 舊行為在此會量到 +12／+16／+32px，提交 +32px。
 */
test("R4A: an arrow key pressed during a pointer gesture must not shift the gridline", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  const versionId = await createTableDraft(
    page,
    context,
    testInfo.project.name,
    "R4A"
  );
  await page.locator('button.field-row[data-field-type="table"]').first().click();
  await page.getByTestId("mode-gridline").click();
  await expect(page.locator('[data-testid="table-gridline"]').first()).toBeVisible();

  const base = (await readTableGuides(page, versionId))!;
  expect(base.length).toBe(72);
  const rect = await overlayRect(page);
  expect(rect.height, "overlay height must be measurable").toBeGreaterThan(40);
  expect(rect.width, "overlay width must be measurable").toBeGreaterThan(40);
  const TOL = 1.5;

  // --- (1) 水平 boundary 1：移 12px → ArrowDown → 續移到起算 16px ---
  const h = await mixedGridlineGesture(page, "horizontal", 1, [
    { move: 12 },
    { key: "ArrowDown" },
    { move: 16 },
  ]);
  const hPx = h.percents.map(value =>
    percentToPx(value - h.startPercent, rect.height)
  );
  expect(
    Math.abs(hPx[0]! - 12),
    `after a 12px move the preview must be +12px (got ${hPx[0]}px)`
  ).toBeLessThan(TOL);
  expect(
    Math.abs(hPx[1]! - 12),
    `an ArrowDown during the drag must not move the gridline (got ${hPx[1]}px)`
  ).toBeLessThan(TOL);
  expect(
    Math.abs(hPx[2]! - 16),
    `continuing to the absolute 16px must be +16px, not +32px (got ${hPx[2]}px)`
  ).toBeLessThan(TOL);
  await saveDraft(page);
  const g1 = (await readTableGuides(page, versionId))!;
  const committedH = (g1[12]!.yRatio - base[12]!.yRatio) * rect.height;
  expect(
    Math.abs(committedH - 16),
    `release must commit the absolute 16px (got ${committedH}px)`
  ).toBeLessThan(TOL);
  expect(
    committedH,
    `release must not commit the doubled 32px (got ${committedH}px)`
  ).toBeLessThan(24);

  // --- (2) 垂直 boundary 1：同序列（ArrowRight）---
  const v = await mixedGridlineGesture(page, "vertical", 1, [
    { move: 12 },
    { key: "ArrowRight" },
    { move: 16 },
  ]);
  const vPx = v.percents.map(value =>
    percentToPx(value - v.startPercent, rect.width)
  );
  expect(
    Math.abs(vPx[0]! - 12),
    `vertical: after a 12px move the preview must be +12px (got ${vPx[0]}px)`
  ).toBeLessThan(TOL);
  expect(
    Math.abs(vPx[1]! - 12),
    `vertical: an ArrowRight during the drag must not move the gridline (got ${vPx[1]}px)`
  ).toBeLessThan(TOL);
  expect(
    Math.abs(vPx[2]! - 16),
    `vertical: continuing to the absolute 16px must be +16px (got ${vPx[2]}px)`
  ).toBeLessThan(TOL);
  await saveDraft(page);
  const g2 = (await readTableGuides(page, versionId))!;
  const committedV = (g2[1]!.xRatio - g1[1]!.xRatio) * rect.width;
  expect(
    Math.abs(committedV - 16),
    `vertical release must commit the absolute 16px (got ${committedV}px)`
  ).toBeLessThan(TOL);
  // 垂直只動第 1、2 欄；其餘 60 格不變
  for (let i = 0; i < 72; i += 1) {
    if (i % 12 === 0 || i % 12 === 1) continue;
    expect(g2[i]).toEqual(g1[i]);
  }
});

/**
 * S2-R4（第四輪）：改動混合手勢後，原語意必須全部保留——
 *  (b) 同一操作中移回起點（含手勢中按鍵）→ 零變更；
 *  (c) Esc 之後續移與放手都不提交（這裡補**垂直**，R3C 只測水平）；
 *  (d) 純鍵盤連按累加、Enter 一次提交（補**垂直**）；
 *  (e) 鍵盤 preview 之後開始指標拖動：鍵盤位移不得被丟棄（水平＋垂直）。
 */
test("R4B: preserved semantics — return-to-start, Esc, pure keyboard + Enter, keyboard preview then pointer drag", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  const versionId = await createTableDraft(
    page,
    context,
    testInfo.project.name,
    "R4B"
  );
  await page.locator('button.field-row[data-field-type="table"]').first().click();
  await page.getByTestId("mode-gridline").click();
  await expect(page.locator('[data-testid="table-gridline"]').first()).toBeVisible();

  const base = (await readTableGuides(page, versionId))!;
  expect(base.length).toBe(72);
  const rect = await overlayRect(page);
  const TOL = 1.5;

  // --- (b) 水平 boundary 2：移出 12px → 手勢中按鍵 → 移回起點 → 零變更 ---
  const back = await mixedGridlineGesture(page, "horizontal", 2, [
    { move: 12 },
    { key: "ArrowDown" },
    { move: 0 },
  ]);
  expect(
    Math.abs(back.percents[2]! - back.startPercent),
    "moving back to the start must restore the original preview"
  ).toBeLessThan(0.05);
  await assertSaveIsNoop(page);
  const g1 = (await readTableGuides(page, versionId))!;
  expect(g1, "return-to-start must commit nothing").toEqual(base);

  // --- (c) 垂直 boundary 2：拖動中 Esc → 續移、放手都不提交 ---
  const selV2 = gridlineSelector("vertical", 2);
  const lineV2 = page.locator(selV2).first();
  const boxV2 = (await lineV2.boundingBox())!;
  const pxV2 = boxV2.x + boxV2.width / 2;
  const pyV2 = boxV2.y + boxV2.height * 0.04;
  await expectPointHits(page, pxV2, pyV2, { testId: "table-gridline" });
  const beforeV2 = await readInlineStyle(page, selV2);
  await page.mouse.move(pxV2, pyV2);
  await page.mouse.down();
  await page.mouse.move(pxV2 + 20, pyV2);
  const draggedV2 = await waitForStyleSettled(page, selV2, beforeV2);
  expect(
    percentOf(draggedV2, "vertical"),
    "the vertical drag must really produce a preview before Esc"
  ).not.toBeCloseTo(percentOf(beforeV2, "vertical"), 1);
  await page.keyboard.press("Escape");
  const cancelledV2 = await waitForStyleSettled(page, selV2, draggedV2);
  await page.mouse.move(pxV2 + 60, pyV2);
  await page.waitForTimeout(300);
  const afterContinueV2 = await readInlineStyle(page, selV2);
  await page.mouse.up();
  await assertSaveIsNoop(page);
  const g2 = (await readTableGuides(page, versionId))!;
  expect(g2, "vertical Esc must commit nothing").toEqual(g1);
  expect(
    percentOf(afterContinueV2, "vertical"),
    "continuing to move after Esc must not resurrect a preview"
  ).toBeCloseTo(percentOf(cancelledV2, "vertical"), 1);

  // --- (d) 垂直 boundary 3：純鍵盤連按三次 ArrowRight → Enter 一次提交 3% ---
  const selV3 = gridlineSelector("vertical", 3);
  const lineV3 = page.locator(selV3).first();
  await lineV3.focus();
  const startV3 = await readInlineStyle(page, selV3);
  let prevV3 = startV3;
  const keySteps: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    await page.keyboard.press("ArrowRight");
    prevV3 = await waitForStyleSettled(page, selV3, prevV3);
    keySteps.push(prevV3);
  }
  const keyDeltas = [
    percentOf(keySteps[0]!, "vertical") - percentOf(startV3, "vertical"),
    percentOf(keySteps[1]!, "vertical") - percentOf(keySteps[0]!, "vertical"),
    percentOf(keySteps[2]!, "vertical") - percentOf(keySteps[1]!, "vertical"),
  ];
  for (const [index, value] of keyDeltas.entries()) {
    expect(
      Math.abs(value - 1),
      `vertical keyboard nudge ${index + 1} must be exactly 1 percentage point (got ${value})`
    ).toBeLessThan(0.05);
  }
  await page.keyboard.press("Enter");
  await saveDraft(page);
  const g3 = (await readTableGuides(page, versionId))!;
  const movedV3 = (g3[3]!.xRatio - g2[3]!.xRatio) * rect.width;
  expect(
    Math.abs(movedV3 - 0.03 * rect.width),
    `Enter must commit the accumulated 3% (got ${movedV3}px of ${0.03 * rect.width}px)`
  ).toBeLessThan(TOL);

  // --- (e1) 水平 boundary 5：先鍵盤微調 1%，再用指標拖 12px → 提交 1%+12px ---
  const selH5 = gridlineSelector("horizontal", 5);
  const lineH5 = page.locator(selH5).first();
  await lineH5.focus();
  const startH5 = await readInlineStyle(page, selH5);
  await page.keyboard.press("ArrowDown");
  const nudgedH5 = await waitForStyleSettled(page, selH5, startH5);
  expect(
    percentOf(nudgedH5, "horizontal") - percentOf(startH5, "horizontal"),
    "the pre-drag keyboard nudge must move 1 percentage point"
  ).toBeCloseTo(1, 1);
  const dragH5 = await mixedGridlineGesture(page, "horizontal", 5, [
    { move: 12 },
  ]);
  const dragH5Px = percentToPx(
    dragH5.percents[0]! - dragH5.startPercent,
    rect.height
  );
  expect(
    Math.abs(dragH5Px - 12),
    `a pointer drag started from a keyboard preview must move 12px (got ${dragH5Px}px)`
  ).toBeLessThan(TOL);
  await saveDraft(page);
  const g4 = (await readTableGuides(page, versionId))!;
  const committedH5 = (g4[60]!.yRatio - g3[60]!.yRatio) * rect.height;
  expect(
    Math.abs(committedH5 - (0.01 * rect.height + 12)),
    `the keyboard offset must survive the pointer drag: expect 1%+12px (got ${committedH5}px of ${0.01 * rect.height + 12}px)`
  ).toBeLessThan(TOL);

  // --- (e2) 垂直 boundary 4：先鍵盤微調 1%，再用指標拖 12px ---
  const selV4 = gridlineSelector("vertical", 4);
  const lineV4 = page.locator(selV4).first();
  await lineV4.focus();
  const startV4 = await readInlineStyle(page, selV4);
  await page.keyboard.press("ArrowRight");
  const nudgedV4 = await waitForStyleSettled(page, selV4, startV4);
  expect(
    percentOf(nudgedV4, "vertical") - percentOf(startV4, "vertical"),
    "the vertical pre-drag keyboard nudge must move 1 percentage point"
  ).toBeCloseTo(1, 1);
  const dragV4 = await mixedGridlineGesture(page, "vertical", 4, [
    { move: 12 },
  ]);
  const dragV4Px = percentToPx(
    dragV4.percents[0]! - dragV4.startPercent,
    rect.width
  );
  expect(
    Math.abs(dragV4Px - 12),
    `vertical: a pointer drag started from a keyboard preview must move 12px (got ${dragV4Px}px)`
  ).toBeLessThan(TOL);
  await saveDraft(page);
  const g5 = (await readTableGuides(page, versionId))!;
  const committedV4 = (g5[4]!.xRatio - g4[4]!.xRatio) * rect.width;
  expect(
    Math.abs(committedV4 - (0.01 * rect.width + 12)),
    `vertical: the keyboard offset must survive the pointer drag: expect 1%+12px (got ${committedV4}px of ${0.01 * rect.width + 12}px)`
  ).toBeLessThan(TOL);
});
