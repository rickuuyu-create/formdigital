// WB-01 — LoginScreen UI coverage (no DOM / no running server needed).
//
// Renders the component to static HTML via react-dom/server so the four
// preflight view states (checking / unavailable / reconnect_required / ok) can
// be asserted deterministically. The `unavailable` branch must show an
// actionable startup hint and must NEVER leak a path, token, port, config name,
// or raw error.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LoginScreen } from "./LoginScreen";
import { LOCAL_SERVICE_STARTUP_HINT } from "../../lib/local-recovery";
import { I18nProvider } from "../../lib/i18n";

type ViewState = "checking" | "unavailable" | "reconnect_required" | "ok";

function render(ready: ViewState): string {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      null,
      createElement(LoginScreen, {
        ready,
        reconnectPath: "",
        reconnectPending: false,
        onReconnectPathChange: () => {},
        onReconnectSubmit: () => {},
        onRecheck: () => {},
      })
    )
  );
}

// Secrets that must never appear anywhere in the rendered login UI.
const FORBIDDEN = [
  "C:\\",
  "127.0.0.1",
  "localhost:4317",
  "token",
  "local-service-config.json",
  "stack",
  "WebsiteMother",
  "C:\\Users",
];

describe("LoginScreen view states", () => {
  it("renders the checking state", () => {
    const html = render("checking");
    expect(html).toContain("正在檢查本機服務");
    expect(html).toContain("FORMDIGITAL");
    for (const secret of FORBIDDEN) expect(html).not.toContain(secret);
  });

  it("renders the ok state with the Google login button enabled copy", () => {
    const html = render("ok");
    expect(html).toContain("本機資料服務已連線");
    expect(html).toContain("使用 Google 登入");
    for (const secret of FORBIDDEN) expect(html).not.toContain(secret);
  });

  it("renders the reconnect_required state with the reconnect form", () => {
    const html = render("reconnect_required");
    expect(html).toContain("需要重新連接 Local Data Folder");
    expect(html).toContain('id="reconnect-path"');
    expect(html).toContain("驗證並重新連接");
    for (const secret of FORBIDDEN) expect(html).not.toContain(secret);
  });

  it("renders the unavailable state with an actionable, secret-free hint", () => {
    const html = render("unavailable");
    expect(html).toContain("本機資料服務未啟動或無法連線");
    expect(html).toContain(LOCAL_SERVICE_STARTUP_HINT);
    expect(html).toContain("重新檢查本機服務");
    // actionable: points at the one-click launcher + recheck button
    expect(LOCAL_SERVICE_STARTUP_HINT).toContain("start-formdigital-dev.cmd");
    expect(LOCAL_SERVICE_STARTUP_HINT).toContain("npm run dev:local");
    // secret-free
    for (const secret of FORBIDDEN) {
      expect(html).not.toContain(secret);
      expect(LOCAL_SERVICE_STARTUP_HINT).not.toContain(secret);
    }
  });
});

describe("LOCAL_SERVICE_STARTUP_HINT constant", () => {
  it("is actionable and contains no secret value", () => {
    expect(LOCAL_SERVICE_STARTUP_HINT.length).toBeGreaterThan(20);
    expect(LOCAL_SERVICE_STARTUP_HINT).toContain("重新檢查本機服務");
    for (const secret of FORBIDDEN) {
      expect(LOCAL_SERVICE_STARTUP_HINT).not.toContain(secret);
    }
  });
});
