import { describe, expect, it } from "vitest";
import { googleAuthErrorMessage } from "./google-auth-errors";

describe("googleAuthErrorMessage", () => {
  it("maps every supported redirect code to fixed actionable copy", () => {
    expect(googleAuthErrorMessage("oauth_not_configured")).toContain(
      "尚未完成產品設定"
    );
    expect(googleAuthErrorMessage("oauth_origin_not_allowed")).toContain(
      "callback"
    );
    expect(googleAuthErrorMessage("oauth_state_invalid")).toContain(
      "重新按"
    );
    expect(googleAuthErrorMessage("oauth_account_mismatch")).toContain(
      "不相符"
    );
    expect(googleAuthErrorMessage("oauth_token_exchange_failed")).toContain(
      "Client Secret"
    );
    expect(googleAuthErrorMessage("oauth_profile_failed")).toContain(
      "基本帳號資料"
    );
    expect(googleAuthErrorMessage("oauth_local_account_failed")).toContain(
      "本機帳號綁定"
    );
    expect(googleAuthErrorMessage("oauth_session_failed")).toContain(
      "Session"
    );
    expect(googleAuthErrorMessage("oauth_failed")).toContain("未能完成");
  });

  it("does not render caller-controlled query text", () => {
    const privateValue = "TEST_PRIVATE_VALUE";
    const message = googleAuthErrorMessage(privateValue);
    expect(message).toBe("Google 登入未能完成，請重新嘗試。");
    expect(message).not.toContain(privateValue);
  });

  it("returns no message when the URL has no auth error", () => {
    expect(googleAuthErrorMessage(null)).toBeUndefined();
    expect(googleAuthErrorMessage("")).toBeUndefined();
  });
});
