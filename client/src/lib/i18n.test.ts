import { describe, expect, it } from "vitest";
import { normalizeUiLocale, simplifyUiTerminology } from "./i18n";

describe("interface locale", () => {
  it("accepts only the three supported interface locales", () => {
    expect(normalizeUiLocale("zh-Hant")).toBe("zh-Hant");
    expect(normalizeUiLocale("zh-Hans")).toBe("zh-Hans");
    expect(normalizeUiLocale("en")).toBe("en");
    expect(normalizeUiLocale("TEST_PRIVATE_VALUE")).toBe("zh-Hant");
    expect(normalizeUiLocale(null)).toBe("zh-Hant");
  });

  it("uses familiar simplified Chinese product terms", () => {
    expect(simplifyUiTerminology("本机资料、安全及偏好")).toBe("本地数据、安全及偏好");
    expect(simplifyUiTerminology("建立可携备份并汇入范本")).toBe("创建便携备份并导入模板");
    expect(simplifyUiTerminology("介面语言和资料层级")).toBe("界面语言和数据层级");
  });
});
