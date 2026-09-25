import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ImportReviewContext } from "../../lib/import-pipeline";
import { ImportReviewPanel } from "./ImportReviewPanel";
import { vi } from "vitest";

vi.mock("@/lib/trpc", () => ({
  trpc: {
    formdigital: {
      assets: {
        getUrl: {
          useQuery: () => ({ data: { url: "blob:mocked" } }),
        },
      },
    },
  },
}));

function makeContext(overrides: Partial<ImportReviewContext> = {}): ImportReviewContext {
  return {
    templateId: "tpl-123",
    versionId: "ver-123",
    templateName: "Test Template",
    isDocx: false,
    truncation: "none",
    runDetection: true,
    ocrAvailable: true,
    pages: [
      {
        pageIndex: 0,
        pageNumber: 1,
        assetId: "asset-1",
        widthMm: 210,
        heightMm: 297,
        pixelWidth: 800,
        pixelHeight: 1100,
      },
      {
        pageIndex: 1,
        pageNumber: 2,
        assetId: "asset-2",
        widthMm: 210,
        heightMm: 297,
        pixelWidth: 800,
        pixelHeight: 1100,
      },
    ],
    suggestedFields: [
      {
        stableFieldId: "field-text-1",
        fieldType: "text",
        displayOrder: 0,
        definition: { label: "Applicant Name", confidence: 0.95 },
        coordinate: { page: 1, xMm: 21, yMm: 29.7, widthMm: 63, heightMm: 14.85 },
      },
      {
        stableFieldId: "field-wide-1",
        fieldType: "text",
        displayOrder: 1,
        definition: { label: "Declaration Notes", confidence: 0.85 },
        coordinate: { page: 1, xMm: 10.5, yMm: 148.5, widthMm: 184.8, heightMm: 29.7 },
      },
    ],
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("ImportReviewPanel markup tests (Node environment)", () => {
  it("renders page indicator, buttons, and candidates", () => {
    const ctx = makeContext();
    const html = renderToStaticMarkup(
      createElement(ImportReviewPanel, {
        context: ctx,
        onConfirm: () => {},
        onCancel: () => {},
      })
    );

    expect(html).toContain("覆核辨識建議");
    expect(html).toContain("第 1 頁 / 共 2 頁");
    expect(html).toContain("Applicant Name");
    expect(html).toContain("Declaration Notes");
    expect(html).toContain("&gt;80% 寬"); // ultra-wide badge
    expect(html).toContain("本頁是附件，本次不建立欄位建議");
  });

  it("renders DOCX notice when isDocx is true", () => {
    const ctx = makeContext({ isDocx: true });
    const html = renderToStaticMarkup(
      createElement(ImportReviewPanel, {
        context: ctx,
        onConfirm: () => {},
        onCancel: () => {},
      })
    );

    expect(html).toContain("DOCX:");
    expect(html).toContain("目前以頁面影像辨識，未直接沿用 Word 原生表格結構");
  });

  it("renders zero tables notice when page has no tables", () => {
    const ctx = makeContext();
    const html = renderToStaticMarkup(
      createElement(ImportReviewPanel, {
        context: ctx,
        onConfirm: () => {},
        onCancel: () => {},
      })
    );

    expect(html).toContain("未偵測到表格，可在編輯器手動建立");
  });

  it("renders in English when locale is en", () => {
    const ctx = makeContext({ isDocx: true });
    const html = renderToStaticMarkup(
      createElement(ImportReviewPanel, {
        context: ctx,
        onConfirm: () => {},
        onCancel: () => {},
        locale: "en",
      })
    );

    expect(html).toContain("Review Recognition Suggestions");
    expect(html).toContain("Page 1 of 2");
    expect(html).toContain("Currently recognized via page image");
    expect(html).toContain("Cancel Entire Import");
    expect(html).toContain("Apply Suggestions &amp; Complete Import");
    expect(html).not.toMatch(/[\u3400-\u9fff]/);
  });

  it("renders in Simplified Chinese when locale is zh-Hans", () => {
    const ctx = makeContext();
    const html = renderToStaticMarkup(
      createElement(ImportReviewPanel, {
        context: ctx,
        onConfirm: () => {},
        onCancel: () => {},
        locale: "zh-Hans",
      })
    );

    expect(html).toContain("复核辨识建议");
    expect(html).toContain("采用建议并完成汇入");
  });
});
