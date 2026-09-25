import { describe, expect, it } from "vitest";
import {
  tableEditingText,
  type TableEditingMessages,
} from "./tableEditingMessages";

/**
 * UX-TPL-01 階段 2／S2-05：本輪新表格控制的局部三語文案。
 * 不新增全站 i18n 架構；使用者欄名／原文／公式一律不翻譯。
 * 提示詞 §5.5：新控制三語無 raw marker／路徑／token 洩漏。
 */

const LOCALES = ["zh-Hant", "zh-Hans", "en"] as const;

/** 這些繁體字形不得出現在簡中文案（人工字典，非僅 OpenCC）。 */
const TRADITIONAL_ONLY = [
  "調", "線", "組", "請", "寫", "動", "這", "個", "為", "欄", "儲",
  "點", "選", "確", "認", "復", "範", "圍", "編", "輯", "標", "記",
  "態", "單", "鍵", "盤", "顯", "換", "頁", "關", "於", "們", "無",
  "須", "麼", "體", "應", "該", "時", "間", "與", "變", "張", "將",
  "會", "對", "說", "設", "證", "實", "資", "號", "棄", "銷",
];

/** 不得洩漏的 raw marker／路徑／token。 */
const BANNED_SUBSTRINGS = [
  "C:\\",
  "\\",
  "/api/",
  "Bearer",
  "token",
  "Token",
  "%TEMP%",
  "localhost:",
  "file://",
];

/** 函式型文案的代表性參數（依 key 取樣，避免錯誤 arity）。 */
const SAMPLE_ARGS: Record<string, unknown[]> = {
  groupStatus: [2, 2, 4, 6, 36],
  rowOption: [2],
  columnOption: [11],
  cellHandleAria: [2, 3],
  gridlineHandleAria: ["horizontal", 3],
  deleteTableConfirm: [6, 12, "Quotation"],
  tableEntryDimensions: [6, 12],
};

function allStrings(messages: TableEditingMessages): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(messages)) {
    if (typeof value === "string") {
      out.push(value);
      continue;
    }
    if (typeof value === "function") {
      const args = SAMPLE_ARGS[key] ?? [];
      out.push((value as (...fnArgs: never[]) => string)(...(args as never[])));
    }
  }
  return out;
}

describe("tableEditingMessages locale coverage", () => {
  it("provides the same message keys in all three locales", () => {
    const hant = tableEditingText("zh-Hant");
    for (const locale of LOCALES) {
      const messages = tableEditingText(locale);
      expect(Object.keys(messages).sort()).toEqual(Object.keys(hant).sort());
    }
  });

  it("normalizes unknown locales to zh-Hant", () => {
    expect(tableEditingText("fr")).toEqual(tableEditingText("zh-Hant"));
    expect(tableEditingText("")).toEqual(tableEditingText("zh-Hant"));
    expect(tableEditingText("en")).not.toEqual(tableEditingText("zh-Hant"));
    expect(tableEditingText("zh-Hans").modeField).not.toBe(
      tableEditingText("zh-Hant").modeField
    );
  });

  it("keeps English free of CJK characters", () => {
    for (const value of allStrings(tableEditingText("en")))
      expect(value).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it("keeps Simplified Chinese free of traditional-only glyphs", () => {
    for (const value of allStrings(tableEditingText("zh-Hans")))
      for (const glyph of TRADITIONAL_ONLY) expect(value).not.toContain(glyph);
  });

  it("leaks no raw markers, paths or tokens in any locale", () => {
    for (const locale of LOCALES)
      for (const value of allStrings(tableEditingText(locale)))
        for (const banned of BANNED_SUBSTRINGS)
          expect(value).not.toContain(banned);
  });
});

describe("tableEditingMessages parameterized copy", () => {
  it("formats the group status line per locale", () => {
    expect(tableEditingText("zh-Hant").groupStatus(2, 2, 4, 6, 36)).toBe(
      "第 2/2 組 · 第 4–6 列 · 36 個控制點"
    );
    expect(tableEditingText("zh-Hans").groupStatus(2, 2, 4, 6, 36)).toBe(
      "第 2/2 组 · 第 4–6 列 · 36 个控制点"
    );
    expect(tableEditingText("en").groupStatus(2, 2, 4, 6, 36)).toBe(
      "Group 2/2 · rows 4–6 · 36 handles"
    );
  });

  it("labels rows 1-based and columns with the official A–AD names", () => {
    const messages = tableEditingText("zh-Hant");
    expect(messages.rowOption(0)).toContain("1");
    expect(messages.rowOption(5)).toContain("6");
    expect(messages.columnOption(0)).toContain("A");
    expect(messages.columnOption(11)).toContain("L");
    expect(messages.columnOption(29)).toContain("AD");
    expect(tableEditingText("en").columnOption(11)).toContain("L");
  });

  it("describes gridline handles with axis and neighboring rows or columns", () => {
    const hant = tableEditingText("zh-Hant");
    expect(hant.gridlineHandleAria("horizontal", 3)).toContain("3");
    expect(hant.gridlineHandleAria("horizontal", 3)).toContain("4");
    expect(hant.gridlineHandleAria("vertical", 2)).toContain("2");
    const en = tableEditingText("en");
    expect(en.gridlineHandleAria("horizontal", 3)).toMatch(/horizontal/i);
    expect(en.gridlineHandleAria("vertical", 2)).toMatch(/vertical/i);
  });

  it("explains whole-table deletion scope without naming single cells", () => {
    for (const locale of LOCALES) {
      const text = tableEditingText(locale).deleteTableConfirm(6, 12, "Quotation");
      expect(text).toContain("6");
      expect(text).toContain("12");
      expect(text).toContain("Quotation"); // 使用者欄名原文保留，不翻譯
    }
    expect(tableEditingText("zh-Hant").deleteTableConfirm(6, 12, "Q")).toContain(
      "不會被刪除"
    );
    expect(tableEditingText("en").deleteTableConfirm(6, 12, "Q")).toMatch(
      /not be deleted/i
    );
  });

  it("states the fixed-cell jump locates without changing the role", () => {
    expect(tableEditingText("zh-Hant").fixedCellLocated).toContain("未變更");
    expect(tableEditingText("en").fixedCellLocated).toMatch(/not changed/i);
  });
});
