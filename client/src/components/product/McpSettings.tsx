import { useEffect, useState } from "react";
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
                className="btn-primary"
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
                {tr("建立連線設定", "Create connection settings")}
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
                        className="btn-primary"
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
