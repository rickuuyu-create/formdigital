// Public Google OAuth redirects carry only fixed error codes. Never render a
// query-string value directly: URLs are caller-controlled and may contain
// private values or misleading text.

export function googleAuthErrorMessage(code: string | null): string | undefined {
  if (!code) return undefined;
  switch (code) {
    case "oauth_not_configured":
      return "Google 登入尚未完成產品設定，請由產品管理員設定 OAuth 後再試。";
    case "oauth_origin_not_allowed":
      return "目前網址未獲准使用 Google 登入，請由產品管理員檢查 OAuth callback 設定。";
    case "oauth_state_invalid":
      return "Google 登入驗證已失效，請重新按「使用 Google 登入」。";
    case "oauth_account_mismatch":
      return "這個 Google 帳號與目前主機的使用中帳號不相符，已拒絕登入。";
    case "oauth_token_exchange_failed":
      return "Google 授權資料無法完成交換，請檢查 Client Secret及 callback URI設定。";
    case "oauth_profile_failed":
      return "Google 已授權，但無法取得基本帳號資料，請重新登入。";
    case "oauth_local_account_failed":
      return "Google 已授權，但本機帳號綁定未能完成，請確認 Local Data Service仍在運行。";
    case "oauth_session_failed":
      return "Google 已授權，但本機登入 Session未能建立，請重新啟動產品後再試。";
    case "oauth_failed":
      return "Google 登入未能完成，請重新嘗試。";
    default:
      return "Google 登入未能完成，請重新嘗試。";
  }
}
