import { useEffect, useState } from "react";
import { LoaderCircle, PlugZap } from "lucide-react";
import { useI18n } from "@/lib/i18n";

export function McpSettings() {
  const { tr } = useI18n();
  const [state, setState] = useState<any>(),
    [roots, setRoots] = useState(""),
    [name, setName] = useState("Codex"),
    [permissions, setPermissions] = useState(["read", "write", "export"]),
    [connection, setConnection] = useState<any>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function refresh(initial = false) {
    const response = await fetch("/api/local/mcp", { cache: "no-store" });
    if (!response.ok)
      throw new Error(tr("無法讀取 MCP 設定。", "Cannot read MCP settings."));
    const next = await response.json();
    setState(next);
    if (initial) setRoots(next.roots.join("\n"));
  }
  useEffect(() => {
    void refresh(true).catch(e => setError(e.message));
    const timer = setInterval(() => {
      void refresh().catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, []);
  async function update(body: any) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/local/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      await refresh();
      return result;
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const labels: Record<string, string> = {
    read: tr("讀取", "Read"),
    write: tr("製表及填寫", "Create and fill"),
    export: tr("輸出", "Export"),
    manage: tr("備份及管理", "Backup and manage"),
  };
  const statuses: Record<string, string> = {
    "awaiting-approval": tr("待你批准", "Awaiting your approval"),
    approved: tr("已批准，等待 AI 繼續", "Approved; waiting for the agent"),
    running: tr("進行中", "Running"),
    done: tr("完成", "Done"),
    failed: tr("失敗，請查看結果", "Failed; inspect the result"),
    uncertain: tr("中斷，請先核對資料", "Interrupted; inspect data first"),
    denied: tr("已拒絕", "Denied"),
  };
  return (
    <section
      className="border bg-[#fffdfa] p-5 xl:col-span-2"
      data-testid="mcp-settings"
    >
      <h3 className="font-semibold">
        {tr("AI 連線（MCP）", "AI connections (MCP)")}
      </h3>
      <details className="my-3 border p-3" data-testid="mcp-guide">
        <summary className="cursor-pointer font-semibold">
          {tr(
            "第一次連接？按這裡看教學",
            "Connecting for the first time? Open the guide"
          )}
        </summary>
        <ol className="list-decimal pl-5 space-y-3 mt-3 text-sm">
          <li>
            {tr(
              "保持 Form Digital 開啟，再勾選下方的「啟用 MCP」。聊天會在你自己的 Codex 或 WorkBuddy 裡進行。",
              "Keep Form Digital open and select Enable MCP below. You will chat in your own Codex or WorkBuddy app."
            )}
          </li>
          <li>
            {tr(
              "在電腦建立一個放表格的資料夾，把 PDF、DOCX 或圖片放進去。將該資料夾的完整路徑填在下方，再按「儲存資料夾」。附加文件到 AI 聊天不代表 Form Digital 已能讀取它；如文件在 Downloads，請把文件複製到允許的資料夾，或把 Downloads 加入清單。",
              "Create a folder for your forms and put your PDF, DOCX or images there. Enter its full path below and choose Save folders. Attaching a file to an AI chat does not give Form Digital access to it. If it is in Downloads, copy it to an allowed folder or add Downloads to the list."
            )}
          </li>
          <li>
            {tr(
              "輸入連線名稱，例如 WorkBuddy，選擇「讀取、製表及填寫、輸出」，再按「建立連線設定」。每個 AI 客戶端請建立自己的連線。",
              "Name the connection, for example WorkBuddy, select Read, Create and fill, and Export, then choose Create connection settings. Create a separate connection for each AI client."
            )}
          </li>
          <li>
            {tr(
              "在 WorkBuddy 的 MCP 設定加入畫面提供的 stdio JSON；若它要求逐項填寫，將 command 填入啟動指令，將 args 依原順序逐個加入引數。Codex 可使用 TOML，或同樣填入 command 和 args。請使用這部電腦剛產生的設定，保留原有的其他 MCP 項目。",
              "In WorkBuddy's MCP settings, add the generated stdio JSON. If the client uses separate fields, use command as the launch command and add each args item in order as an argument. Codex can use the TOML configuration or the same command and args. Use the settings generated on this computer and keep your other MCP entries."
            )}
          </li>
          <li>
            {tr(
              "在 AI 客戶端儲存並啟用連線，按其提示重新載入工具。先說：「請透過 Form Digital MCP 列出現有範本，不要修改資料。」能讀到清單（即使清單是空的），才代表連接成功。只在本頁看到連線名稱，仍未代表 AI 已連上。",
              "Save and enable the connection in your AI client, and reload its tools if prompted. First ask: “Use Form Digital MCP to list existing templates without changing data.” A successful list, even an empty one, confirms the connection. A connection name on this page alone does not confirm it."
            )}
          </li>
          <li>
            {tr(
              "接著試說：「建立一份採購申請表，包含姓名、日期及採購明細，先給我預覽，不要發佈。」也可提供允許資料夾內的文件完整路徑，請 AI 匯入成草稿。",
              "Then try: “Create a purchase request form with a name, date and purchase items. Show me a preview without publishing.” To import an existing document, give the agent its full path inside an allowed folder and ask for a draft."
            )}
          </li>
        </ol>
        <p className="mt-3 text-sm">
          {tr(
            "匯入後請逐頁核對欄位名稱、位置、單選／多選及表格。自動辨識可能漏掉方框或誤讀標籤；「0 個驗證問題」不代表辨識完全正確。確認草稿後再發佈，填寫後打開 PDF 檢查。舊式 .doc 請先另存為 .docx 或 PDF。",
            "After import, check field names, positions, single/multiple choices and tables on each page. Detection may miss boxes or misread labels; zero validation issues does not mean detection is correct. Review the draft before publishing and inspect the exported PDF after filling. Save older .doc files as .docx or PDF first."
          )}
        </p>
      </details>
      <p className="my-2 text-sm">
        {tr(
          "讓同一部電腦上的 Codex、WorkBuddy 或其他 MCP 客戶端建立範本、填寫及輸出。預設關閉，不需要 Google 登入。使用時請保持 Form Digital 開啟。",
          "Let Codex, WorkBuddy or another MCP client on this computer create templates, fill forms and export. Off by default; no Google login. Keep Form Digital open while connected."
        )}
      </p>
      <p className="my-2 text-sm">
        {tr(
          "本機處理不代表雲端 AI 不會收到資料；只有你授權的連線可以讀取或操作。匯入與儲存檔案限於下列資料夾。",
          "Local processing does not prevent a cloud AI provider from receiving tool results. Only authorized connections can operate. File imports and saves are limited to the folders below."
        )}
      </p>
      {error && (
        <p role="alert" className="my-2 text-red-700">
          {error}
        </p>
      )}
      {!state ? (
        <p>{tr("讀取中…", "Loading…")}</p>
      ) : (
        <>
          <label className="flex gap-2 items-center my-3">
            <input
              type="checkbox"
              checked={state.enabled}
              disabled={busy}
              onChange={e =>
                void update({
                  action: "configure",
                  enabled: e.target.checked,
                  roots: state.roots,
                })
              }
            />
            {tr("啟用 MCP", "Enable MCP")}
          </label>
          <label className="block text-sm">
            {tr(
              "允許匯入及儲存的資料夾，每行一個完整路徑",
              "Allowed import/save folders, one full path per line"
            )}
            <textarea
              className="block border w-full p-2 my-2"
              rows={3}
              value={roots}
              onChange={e => setRoots(e.target.value)}
              placeholder={"C:\\Users\\YourName\\Documents\\Forms"}
            />
          </label>
          <button
            className="btn-paper"
            disabled={busy}
            onClick={() =>
              void update({
                action: "configure",
                enabled: state.enabled,
                roots: roots
                  .split(/\r?\n/)
                  .map(s => s.trim())
                  .filter(Boolean),
              })
            }
          >
            {tr("儲存資料夾", "Save folders")}
          </button>
          {state.enabled && (
            <div className="border-t mt-4 pt-4">
              <label>
                {tr("新增連線名稱", "New connection name")}
                <input
                  className="border p-2 mx-2"
                  value={name}
                  onChange={e => setName(e.target.value)}
                />
              </label>
              <div className="flex flex-wrap gap-4 my-3">
                {Object.keys(labels).map(p => (
                  <label key={p}>
                    <input
                      type="checkbox"
                      className="mr-1"
                      checked={permissions.includes(p)}
                      onChange={e =>
                        setPermissions(
                          e.target.checked
                            ? [...permissions, p]
                            : permissions.filter(x => x !== p)
                        )
                      }
                    />
                    {labels[p]}
                  </label>
                ))}
              </div>
              <button
                type="button"
                className="btn-ink cursor-pointer rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d9573b] disabled:cursor-not-allowed disabled:opacity-50"
                aria-busy={busy}
                disabled={busy || !name.trim() || !permissions.length}
                onClick={async () => {
                  const value = await update({
                    action: "pair",
                    name,
                    permissions,
                  });
                  if (value) setConnection(value);
                }}
              >
                {busy ? (
                  <LoaderCircle
                    size={16}
                    aria-hidden="true"
                    className="animate-spin"
                  />
                ) : (
                  <PlugZap size={16} aria-hidden="true" />
                )}
                {busy
                  ? tr("處理中…", "Working…")
                  : tr("建立連線設定", "Create connection settings")}
              </button>
            </div>
          )}
          {connection && (
            <div className="my-4 border p-3">
              <p>
                {tr(
                  "把下列其中一份設定加入 AI 客戶端。保留其他 MCP 設定；不要公開這份連線資訊。",
                  "Add one configuration below to your AI client. Keep your other MCP entries and keep these credentials private."
                )}
              </p>
              <details open>
                <summary>Codex (TOML)</summary>
                <pre className="overflow-auto p-2 text-xs whitespace-pre-wrap">
                  {connection.codex}
                </pre>
              </details>
              <details>
                <summary>WorkBuddy / MCP (stdio JSON)</summary>
                <pre className="overflow-auto p-2 text-xs whitespace-pre-wrap">
                  {JSON.stringify(connection.stdio, null, 2)}
                </pre>
              </details>
              <details>
                <summary>Streamable HTTP</summary>
                <pre className="overflow-auto p-2 text-xs whitespace-pre-wrap">
                  {JSON.stringify(connection.http, null, 2)}
                </pre>
              </details>
              <button
                className="btn-paper"
                onClick={() => setConnection(undefined)}
              >
                {tr("關閉設定資訊", "Close connection details")}
              </button>
            </div>
          )}
          <div className="my-3">
            {state.clients
              .filter((c: any) => !c.revoked)
              .map((c: any) => (
                <div className="flex justify-between border-t py-2" key={c.id}>
                  <span>
                    {c.name} ·{" "}
                    {c.permissions.map((p: string) => labels[p]).join(" / ")}
                  </span>
                  <button
                    className="btn-paper"
                    disabled={busy}
                    onClick={() => void update({ action: "revoke", id: c.id })}
                  >
                    {tr("撤銷連線", "Revoke")}
                  </button>
                </div>
              ))}
          </div>
          <h4 className="mt-4 font-semibold">
            {tr("操作記錄及待批准事項", "Operations and approvals")}
          </h4>
          <p className="text-sm my-2">
            {tr(
              "刪除、還原及大量覆蓋會先列出確切內容。批准有效期為 15 分鐘；資料已被修改時仍會拒絕操作。",
              "Deletion, restoration and bulk overwrites show the exact request before approval. Approval expires after 15 minutes; changed records still cause a conflict."
            )}
          </p>
          <div className="max-h-96 overflow-auto">
            {state.operations
              .slice()
              .reverse()
              .map((o: any) => (
                <details key={o.id} className="border-t py-2">
                  <summary>
                    {o.tool} · {statuses[o.state] ?? o.state} ·{" "}
                    {new Date(o.at).toLocaleString()}
                  </summary>
                  <pre className="text-xs whitespace-pre-wrap break-all p-2">
                    {JSON.stringify(o.args, null, 2)}
                  </pre>
                  {o.error && <p className="text-red-700">{o.error}</p>}
                  {o.state === "awaiting-approval" && (
                    <div className="flex gap-2">
                      <button
                        className="btn-ink"
                        disabled={busy}
                        onClick={() =>
                          void update({
                            action: "approve",
                            id: o.id,
                            approve: true,
                          })
                        }
                      >
                        {tr("批准這項操作", "Approve this operation")}
                      </button>
                      <button
                        className="btn-paper"
                        disabled={busy}
                        onClick={() =>
                          void update({
                            action: "approve",
                            id: o.id,
                            approve: false,
                          })
                        }
                      >
                        {tr("拒絕", "Deny")}
                      </button>
                    </div>
                  )}
                </details>
              ))}
          </div>
        </>
      )}
    </section>
  );
}
