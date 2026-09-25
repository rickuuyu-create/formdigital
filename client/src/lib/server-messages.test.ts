import { describe, expect, it } from "vitest";
import { translateServerMessage } from "./server-messages";

describe("server message localization", () => {
  it("translates known CSV failures without exposing implementation details", () => {
    const english = translateServerMessage(
      "Strict 匯入已取消：12 筆資料未通過欄位驗證，未建立任何 Instance。",
      (_traditional, english) => english
    );
    expect(english).toBe(
      "Strict import cancelled: 12 rows failed field validation. No Instances were created."
    );
  });

  it("keeps an unknown server message intact for diagnostics", () => {
    const value = "Unknown operational failure.";
    expect(translateServerMessage(value, (_traditional, english) => english)).toBe(
      value
    );
  });

  it("translates editor, instance, and output failures", () => {
    expect(
      translateServerMessage("仍有 3 個欄位未命名或未經人工確認。", (_zh, english) => english)
    ).toBe("3 fields are still unnamed or have not been human-confirmed.");
    expect(
      translateServerMessage("Instance 尚有 2 項驗證錯誤，修正後才可預覽、列印或匯出。", (_zh, english) => english)
    ).toBe("The Instance still has 2 validation errors. Correct them before previewing, printing, or exporting.");
  });

  describe("R5-P3: stable server issue codes are localized without leaking internals", () => {
    const CJK = /[一-鿿]/;
    const MARKED = "Template 發佈失敗：[[FD_ISSUE:table_formula_unknown_column|row=1|column=B|reference=C]]";
    const MARKED_UNKNOWN = "Template 發佈失敗：[[FD_ISSUE:totally_unknown_code|row=1]]";

    it("renders the English server publish failure with no CJK and no raw code", () => {
      const english = translateServerMessage(MARKED, (_zh, english) => english, "en");
      expect(english).not.toContain("FD_ISSUE");
      expect(english).not.toContain("table_formula_unknown_column");
      expect(english).not.toMatch(CJK);
    });

    it("renders the Traditional Chinese server publish failure without raw markers", () => {
      const traditional = translateServerMessage(MARKED, zh => zh, "zh-Hant");
      expect(traditional).not.toContain("FD_ISSUE");
      expect(traditional).not.toContain("table_formula_unknown_column");
      expect(traditional).toMatch(/[一-鿿]/);
    });

    it("hands the Simplified variant to the locale converter without raw markers", () => {
      const simplified = translateServerMessage(MARKED, zh => `SIMPLIFIED(${zh})`, "zh-Hans");
      expect(simplified.startsWith("SIMPLIFIED(")).toBe(true);
      expect(simplified).not.toContain("FD_ISSUE");
      expect(simplified).not.toContain("table_formula_unknown_column");
    });

    it("falls back to a generic safe message for an unknown stable code", () => {
      const english = translateServerMessage(MARKED_UNKNOWN, (_zh, english) => english, "en");
      expect(english).not.toContain("FD_ISSUE");
      expect(english).not.toContain("totally_unknown_code");
      expect(english).not.toMatch(CJK);
    });

    it("R8-P1: Object.prototype keys via the publish/status outer wrapper stay a validation message", () => {
      for (const protoKey of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
        const publishMarker = `Template 發佈失敗：[[FD_ISSUE:${protoKey}]]`;
        const statusMarker = `無法將狀態更新為 PUBLISHED，表單包含 1 項驗證錯誤：[[FD_ISSUE:${protoKey}]]`;

        const enPublish = translateServerMessage(publishMarker, (_zh, english) => english, "en");
        expect(enPublish).toContain("Data validation failed");
        expect(enPublish).not.toContain("FD_ISSUE");
        expect(enPublish).not.toContain(protoKey);
        expect(enPublish).not.toContain("Formula could not be processed");
        expect(enPublish).not.toMatch(CJK);

        const hantPublish = translateServerMessage(publishMarker, zh => zh, "zh-Hant");
        expect(hantPublish).toContain("資料驗證失敗");
        expect(hantPublish).not.toContain("FD_ISSUE");
        expect(hantPublish).not.toContain(protoKey);

        const hansPublish = translateServerMessage(publishMarker, zh => `SIMPLIFIED(${zh})`, "zh-Hans");
        expect(hansPublish).toContain("数据验证失败");
        expect(hansPublish).not.toContain("FD_ISSUE");
        expect(hansPublish).not.toContain(protoKey);

        // The same protection must hold behind the status outer wrapper.
        const enStatus = translateServerMessage(statusMarker, (_zh, english) => english, "en");
        expect(enStatus).toContain("Data validation failed");
        expect(enStatus).not.toContain("FD_ISSUE");
        expect(enStatus).not.toContain(protoKey);
      }
    });
  });

  describe("R6-P2: trilingual transport failure messages (v2_transport_unconfirmed / v2_busy)", () => {
    const CJK = /[一-鿿]/;
    const UNCONFIRMED = "[[FD_ISSUE:v2_transport_unconfirmed]]";
    const BUSY = "[[FD_ISSUE:v2_busy]]";

    it("renders v2_transport_unconfirmed in every locale without leaking the raw code", () => {
      const en = translateServerMessage(UNCONFIRMED, (_zh, english) => english, "en");
      expect(en).toBe(
        "The local data service connection was interrupted and the transaction result could not be confirmed. Please try again later."
      );
      expect(en).not.toContain("FD_ISSUE");
      expect(en).not.toContain("v2_transport_unconfirmed");
      expect(en).not.toMatch(CJK);

      const hans = translateServerMessage(UNCONFIRMED, zh => `SIMPLIFIED(${zh})`, "zh-Hans");
      expect(hans).toBe("SIMPLIFIED(本地数据服务连接中断，交易结果无法确认；请稍后再试。)");
      expect(hans).not.toContain("FD_ISSUE");

      const hant = translateServerMessage(UNCONFIRMED, zh => zh, "zh-Hant");
      expect(hant).toContain("無法確認");
      expect(hant).not.toContain("FD_ISSUE");
    });

    it("renders v2_busy in every locale without leaking the raw code", () => {
      const en = translateServerMessage(BUSY, (_zh, english) => english, "en");
      expect(en).toBe("The workspace data is busy. Please try again later.");
      expect(en).not.toContain("FD_ISSUE");
      expect(en).not.toContain("v2_busy");
      expect(en).not.toMatch(CJK);

      const hans = translateServerMessage(BUSY, zh => `SIMPLIFIED(${zh})`, "zh-Hans");
      expect(hans).toBe("SIMPLIFIED(工作区数据忙碌中，请稍后再试。)");
      expect(hans).not.toContain("FD_ISSUE");

      const hant = translateServerMessage(BUSY, zh => zh, "zh-Hant");
      expect(hant).toContain("忙碌");
      expect(hant).not.toContain("FD_ISSUE");
    });
  });

  describe("R7-P3: unknown wire validation code uses a generic validation message, not a formula error", () => {
    const CJK = /[一-鿿]/;
    const UNKNOWN = "Template 發佈失敗：[[FD_ISSUE:totally_unknown_validation_code|row=1]]";
    const UNKNOWN_STATUS = "無法將狀態更新為 printed，表單包含 2 項驗證錯誤：[[FD_ISSUE:unknown_wire_code_xyz]]";

    it("renders a generic data-validation message for an unknown wire code in every locale", () => {
      const en = translateServerMessage(UNKNOWN, (_zh, english) => english, "en");
      expect(en).toBe("Template publish failed: Data validation failed");
      expect(en).not.toContain("FD_ISSUE");
      expect(en).not.toContain("totally_unknown_validation_code");
      expect(en).not.toMatch(CJK);

      const hans = translateServerMessage(UNKNOWN, zh => `SIMPLIFIED(${zh})`, "zh-Hans");
      expect(hans).toBe("SIMPLIFIED(Template 发布失败：数据验证失败)");
      expect(hans).not.toContain("FD_ISSUE");

      const hant = translateServerMessage(UNKNOWN, zh => zh, "zh-Hant");
      expect(hant).toBe("Template 發佈失敗：資料驗證失敗");
      expect(hant).not.toContain("FD_ISSUE");
    });

    it("keeps the outer status/publish wrapper consistent with the generic validation inner message", () => {
      const en = translateServerMessage(UNKNOWN_STATUS, (_zh, english) => english, "en");
      expect(en).toBe(
        "Cannot change the status to printed: the form still has 2 validation errors. Data validation failed"
      );
      expect(en).not.toContain("FD_ISSUE");
      expect(en).not.toContain("unknown_wire_code_xyz");
      expect(en).not.toMatch(CJK);

      const hans = translateServerMessage(UNKNOWN_STATUS, zh => `SIMPLIFIED(${zh})`, "zh-Hans");
      expect(hans).toBe(
        "SIMPLIFIED(无法将状态更新为 printed，表单包含 2 项验证错误：数据验证失败)"
      );
      expect(hans).not.toContain("FD_ISSUE");
    });

    it("never echoes the raw code, params, fallback message, path or stack", () => {
      const en = translateServerMessage(
        "[[FD_ISSUE:unknown_code|path=/x/y|msg=Internal failure at /secret/trace]]",
        (_zh, english) => english,
        "en"
      );
      expect(en).toBe("Data validation failed");
      expect(en).not.toContain("FD_ISSUE");
      expect(en).not.toContain("unknown_code");
      expect(en).not.toContain("path");
      expect(en).not.toContain("msg");
      expect(en).not.toContain("/secret/trace");
    });
  });
});
