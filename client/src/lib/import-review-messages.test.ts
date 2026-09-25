import { describe, expect, it } from "vitest";
import { getImportReviewMessages } from "./import-review-messages";

describe("import-review-messages", () => {
  it("provides full catalog in Traditional Chinese, Simplified Chinese, and English", () => {
    const hant = getImportReviewMessages("zh-Hant");
    const hans = getImportReviewMessages("zh-Hans");
    const en = getImportReviewMessages("en");

    expect(hant.docxNotice).toBe(
      "目前以頁面影像辨識，未直接沿用 Word 原生表格結構；結果需要人工覆核。"
    );
    expect(hant.noTableNotice).toBe("未偵測到表格，可在編輯器手動建立");
    expect(hant.attachmentPage).toBe("本頁是附件，本次不建立欄位建議");

    expect(hans.docxNotice).toBe(
      "目前以页面影像辨识，未直接沿用 Word 原生表格结构；结果需要人工复核。"
    );
    expect(hans.noTableNotice).toBe("未侦测到表格，可在编辑器手动建立");

    expect(en.docxNotice).toContain("Currently recognized via page image");
    expect(en.noTableNotice).toBe("No tables detected; you can create them manually in the editor.");

    expect(en.pageIndicator(2, 5)).toBe("Page 2 of 5");
    expect(hant.pageIndicator(2, 5)).toBe("第 2 頁 / 共 5 頁");
    expect(hans.pageIndicator(2, 5)).toBe("第 2 页 / 共 5 页");
  });

  it("falls back to zh-Hant for unknown locales", () => {
    const unknown = getImportReviewMessages("fr-FR");
    expect(unknown.reviewTitle).toBe("覆核辨識建議");
  });
});
