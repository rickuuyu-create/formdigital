import * as React from "react";
import { type FormEvent } from "react";
import { Activity, CloudOff, FileText, HardDrive, LogIn } from "lucide-react";
import { startLogin } from "@/const";
import {
  type PreflightViewState,
  LOCAL_SERVICE_STARTUP_HINT,
} from "@/lib/local-recovery";
import { useI18n } from "@/lib/i18n";
import { LanguageSelect } from "@/components/LanguageSelect";

/**
 * Pre-login screen driven by the public preflight probe (`ok` | `reconnect_required` | `unavailable`).
 * When `unavailable`, it shows a safe, actionable startup hint plus a recheck
 * button (WB-01: 503 可行動提示). The `reconnect_required` branch keeps the
 * existing, already-safe reconnect form. The `ok` branch keeps Google login.
 */
export function LoginScreen({
  ready,
  error,
  reconnectPath,
  reconnectPending,
  onReconnectPathChange,
  onReconnectSubmit,
  onRecheck,
  localOnly = false,
}: {
  ready: PreflightViewState;
  error?: string;
  reconnectPath: string;
  reconnectPending: boolean;
  onReconnectPathChange: (value: string) => void;
  onReconnectSubmit: (event: FormEvent) => void;
  onRecheck: () => void;
  localOnly?: boolean;
}) {
  const { t, tr } = useI18n();
  const showReconnect = ready === "reconnect_required";
  const bannerClass =
    ready === "ok"
      ? "border-emerald-300 bg-emerald-50 text-emerald-800"
      : ready === "unavailable"
        ? "border-red-300 bg-red-50 text-red-800"
        : ready === "reconnect_required"
          ? "border-amber-300 bg-amber-50 text-amber-800"
          : "bg-[#f4f1eb] text-slate-600";
  const bannerText =
    ready === "ok"
      ? t("login.connected", "本機資料服務已連線")
      : ready === "unavailable"
        ? t("login.unavailable", "本機資料服務未啟動或無法連線")
        : ready === "reconnect_required"
          ? t("login.reconnect", "需要重新連接 Local Data Folder")
          : t("login.checking", "正在檢查本機服務…");
  return (
    <main className="grid min-h-screen place-items-center bg-[#f4f1eb] p-5">
      <section className="w-full max-w-sm border border-[#d9d4ca] bg-[#fffdfa] p-8 text-center shadow-xl">
        <div className="mx-auto grid h-12 w-12 place-items-center bg-[#102a43] text-white">
          <FileText size={21} />
        </div>
        <h1 className="mt-5 text-lg font-bold tracking-[.16em] text-[#122f45]">
          FORMDIGITAL
        </h1>
        <LanguageSelect className="mt-3" />
        <div
          aria-live="polite"
          className={`mt-6 flex items-center justify-center gap-2 border p-3 text-xs ${bannerClass}`}
        >
          {ready === "unavailable" ? (
            <CloudOff size={16} />
          ) : ready === "reconnect_required" ? (
            <HardDrive size={16} />
          ) : (
            <Activity
              className={ready === "checking" ? "animate-pulse" : ""}
              size={16}
            />
          )}
          {bannerText}
        </div>
        {error && (
          <p
            role="alert"
            className="mt-3 border border-red-200 bg-red-50 p-3 text-xs text-red-700"
          >
            {error}
          </p>
        )}
        {showReconnect ? (
          <form className="mt-5 text-left" onSubmit={onReconnectSubmit}>
            <p className="text-xs leading-6 text-slate-600">
              {t(
                "login.reconnectHelp",
                "原 Local Data Folder 可能已移動、改名或暫時失去權限。系統沒有建立新的空白資料夾；請選擇／輸入原有 FormdigitalData 的完整 Windows 路徑，系統會先驗證資料結構，成功後才重新連接。"
              )}
            </p>
            <label htmlFor="reconnect-path" className="setting-label mt-4 block">
              {t("login.originalPath", "原有資料夾的 Windows 絕對路徑")}
            </label>
            <input
              id="reconnect-path"
              className="setting-input mt-1 w-full"
              value={reconnectPath}
              onChange={(event) => onReconnectPathChange(event.target.value)}
              placeholder="D:\FormdigitalData"
              disabled={reconnectPending}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="submit"
              className="btn-ink mt-4 min-h-11 w-full"
              disabled={!reconnectPath.trim() || reconnectPending}
            >
              <HardDrive size={16} />
              {reconnectPending
                ? t("login.reconnecting", "正在驗證資料夾……")
                : t("login.reconnectAction", "驗證並重新連接")}
            </button>
            <button
              type="button"
              className="btn-paper mt-2 min-h-11 w-full"
              onClick={onRecheck}
              disabled={reconnectPending}
            >
              {t("login.recheck", "重新檢查本機服務")}
            </button>
          </form>
        ) : (
          <>
            {ready === "unavailable" && (
              <p className="mt-4 border border-red-200 bg-red-50 p-3 text-left text-xs leading-6 text-red-800">
                {localOnly
                  ? tr("請保留 Form Digital 啟動視窗，確認本機服務正在運行，然後按「重新檢查本機服務」。", "Keep the Form Digital launcher open, check that the local service is running, then select Check local service again.")
                  : t("login.startupHint", LOCAL_SERVICE_STARTUP_HINT)}
              </p>
            )}
            {!localOnly && <button
              className="btn-ink mt-5 min-h-11 w-full"
              disabled={ready !== "ok"}
              onClick={startLogin}
            >
              <LogIn size={16} />
              {t("login.google", "使用 Google 登入")}
            </button>}
            {localOnly && <p className="mt-4 text-sm text-slate-700">{tr("本機工作區暫時無法開啟，無須登入。", "The local workspace is temporarily unavailable. No sign-in is required.")}</p>}
            {(localOnly || ready === "unavailable") && (
              <button
                type="button"
                className="btn-paper mt-2 min-h-11 w-full"
                onClick={onRecheck}
              >
                {t("login.recheck", "重新檢查本機服務")}
              </button>
            )}
          </>
        )}
      </section>
    </main>
  );
}
