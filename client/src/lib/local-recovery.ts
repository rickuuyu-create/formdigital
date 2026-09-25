// Layer 1C — Pre-login Local Data Folder reconnect (client side).
//
// These helpers are deliberately pure and dependency-free so the preflight
// parsing, recovery-request building, and status mapping can be unit tested
// deterministically without a DOM, a running server, or the secret config.
// Home.tsx uses them to drive the public preflight probe and the
// POST /api/local/recovery/reconnect endpoint.
//
// SECURITY INVARIANTS (must never be weakened):
//  - We never read or send the Local Data Service bearer token.
//  - We never set Origin / Host / Forwarded / X-Forwarded-* / Sec-Fetch-* by
//    hand; the browser owns those. The server decides trust from the real
//    socket address plus the received headers.
//  - The recovery request only ever carries { dataFolder } (trimmed).

export type PreflightStatus = "ok" | "reconnect_required" | "unavailable";
export type PreflightViewState = "checking" | PreflightStatus;
export type RecoveryStatus =
  | "reconnected"
  | "not_required"
  | "invalid_request"
  | "reconnect_failed"
  | "unavailable"
  | "forbidden";

export const PREFLIGHT_ENDPOINT = "/api/local/preflight";
export const RECOVERY_ENDPOINT = "/api/local/recovery/reconnect";

/**
 * Safe, non-secret, actionable guidance shown on the login screen when the
 * Local Data Service is `unavailable`. It points the user at the one-click
 * local launcher and the recheck button; it never names a path, token, port
 * number, or raw error.
 */
export const LOCAL_SERVICE_STARTUP_HINT =
  "本機資料服務（Local Data Service）尚未啟動或無法連線。請在專案資料夾執行啟動指令（start-formdigital-dev.cmd 或 npm run dev:local），待畫面顯示「本機資料服務已連線」後，再按下方「重新檢查本機服務」。";

/** Minimal request init for the public preflight probe. */
export function buildPreflightRequestInit(): RequestInit {
  return { cache: "no-store", credentials: "same-origin" };
}

/**
 * Map an HTTP Response from GET /api/local/preflight to the UI view state.
 * The body only ever contains { status }; anything unexpected -> unavailable.
 * A JSON parse failure -> unavailable (corrupt / non-JSON payload).
 */
export async function interpretPreflightResponse(
  response: Response
): Promise<PreflightViewState> {
  if (response.status === 503) return "unavailable";
  if (response.status !== 200) return "unavailable";
  try {
    const body = (await response.json()) as { status?: unknown };
    if (body.status === "reconnect_required") return "reconnect_required";
    if (body.status === "ok") return "ok";
    return "unavailable";
  } catch {
    return "unavailable";
  }
}

/**
 * Build the RequestInit for POST /api/local/recovery/reconnect.
 * Content-Type + the custom recovery header are set explicitly; Origin, Host,
 * Sec-Fetch-*, Forwarded / X-Forwarded-* and any token are intentionally NOT
 * set here — the browser manages them and the server enforces trust.
 */
export function buildRecoveryRequestInit(dataFolder: string): RequestInit {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Formdigital-Recovery": "1",
    },
    body: JSON.stringify({ dataFolder: dataFolder.trim() }),
    credentials: "same-origin",
    cache: "no-store",
  };
}

/** Parse the recovery response body into one of the known statuses. */
export async function interpretRecoveryResponse(
  response: Response
): Promise<RecoveryStatus> {
  try {
    const body = (await response.json()) as { status?: unknown };
    if (response.status === 200 && body.status === "reconnected")
      return "reconnected";
    if (response.status === 409 && body.status === "not_required")
      return "not_required";
    if (
      response.status === 400 &&
      (body.status === "invalid_request" || body.status === "reconnect_failed")
    )
      return body.status;
    if (response.status === 503 && body.status === "unavailable")
      return "unavailable";
    if (response.status === 403 && body.status === "forbidden")
      return "forbidden";
    return "reconnect_failed";
  } catch {
    return "reconnect_failed";
  }
}

/**
 * User-facing copy for each terminal recovery status. Chinese, safe — never
 * includes the path, raw error, token, or stack. reconnected / not_required
 * carry no message because those branches re-check preflight instead.
 */
export function recoveryUserMessage(
  status: RecoveryStatus | "network_error"
): string {
  switch (status) {
    case "invalid_request":
      return "請輸入有效的 Windows 完整路徑。";
    case "reconnect_failed":
      return "無法驗證或重新連接該資料夾。請確認這是原有的 FormdigitalData，而且資料完整及有存取權限。";
    case "unavailable":
      return "本機資料服務目前無法連線，請確認服務已啟動後再試。";
    case "forbidden":
      return "安全檢查未通過。請只從本機 Formdigital 頁面執行重新連接。";
    case "network_error":
      return "重新連接失敗，請確認本機 Formdigital 服務仍在執行，然後重試。";
    case "reconnected":
    case "not_required":
      return "";
  }
}

/**
 * Light client-side hint only (the server is the final authority). Mirrors the
 * server's Windows-absolute-path rule: drive letter (C:\ / C:/) or UNC
 * (\\server\share), length 3-1024, no NUL. Used to give immediate feedback and
 * to keep an obviously invalid value from being sent.
 */
export function isLikelyWindowsAbsolutePath(raw: string): boolean {
  const value = raw.trim();
  if (value.length < 3 || value.length > 1024) return false;
  if (value.includes("\0")) return false;
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\");
}
