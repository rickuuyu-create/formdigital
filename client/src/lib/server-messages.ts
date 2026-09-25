import {
  localizeServerIssueMarkers,
  normalizeFormulaLocale,
  type FormulaLocale,
} from "../../../shared/tableFormula";

type Translate = (traditionalChinese: string, english: string) => string;

const ENGLISH_SERVER_MESSAGES: Array<[RegExp, string]> = [
  [/^找不到指定 Template。$/, "The selected Template was not found."],
  [/^找不到指定版本。$/, "The selected Version was not found."],
  [/^無權存取此 Template Version。$/, "You do not have access to this Template Version."],
  [/^此 Import Run 已完成或已封存，不需要 Resume。$/, "This import run is completed or archived and does not need to be resumed."],
  [/^原始 CSV 資產完整性驗證失敗。$/, "Original CSV asset integrity verification failed."],
  [/^Import Run 缺少可重播的 Mapping Decision manifest。$/, "The import run is missing a replayable mapping-decision manifest."],
  [/^CSV 必須包含標題列與至少一筆資料。$/, "The CSV must contain a header row and at least one data row."],
  [/^CSV 欄位名稱不得為空白或重複。$/, "CSV field names cannot be blank or duplicated."],
  [/^CSV 批量匯入只接受 text\/csv 資產。$/, "CSV batch import accepts text/csv assets only."],
  [/^CSV 欄位「(.+)」尚未完成 Mapping 決定。$/, "CSV field \"$1\" does not have a mapping decision yet."],
  [/^Mapping 包含不存在的 CSV 欄位：(.+)$/, "Mapping refers to a missing CSV field: $1"],
  [/^Mapping 指向不存在的 Template Field：/, "Mapping refers to a missing Template Field: "],
  [/^未授權的 CSV 預覽。$/, "Unauthorized CSV preview."],
  [/^找不到指定 Template Version。$/, "The selected Template Version was not found."],
  [/^找不到指定 Import Run，或您沒有存取權限。$/, "The import run was not found, or you do not have access to it."],
  [/^找不到指定 Import Run。$/, "The import run was not found."],
  [/^CSV 批量建立只允許使用已發佈的 Template Version。$/, "CSV batch creation allows published Template Versions only."],
  [/^Template Version 在匯入期間已改變，請重新預覽 CSV。$/, "The Template Version changed during import. Preview the CSV again."],
  [/^Strict 匯入已取消：(\d+) 筆資料未通過欄位驗證，未建立任何 Instance。$/, "Strict import cancelled: $1 rows failed field validation. No Instances were created."],
  [/^Strict 匯入仍有 (\d+) 筆資料未通過欄位驗證。$/, "Strict import still has $1 rows that failed field validation."],
  [/^請選擇已發佈的 Template Version。$/, "Select a published Template Version."],
  [/^請先保存 Instance。$/, "Save the Instance first."],
  [/^此 Import Run 缺少可重播的原始 CSV 資產。$/, "This import run is missing its replayable original CSV asset."],
  [/^Import Run 綁定的 Template Version 不存在。$/, "The Template Version bound to this import run does not exist."],
  [/^CSV 上傳失敗。$/, "CSV upload failed."],
  [/^找不到指定 Instance，或您沒有存取權限。$/, "The Instance was not found, or you do not have access to it."],
  [/^找不到指定 Instance。$/, "The selected Instance was not found."],
  [/^Instance 綁定的 Template Version hash 不一致。$/, "The Template Version hash bound to this Instance does not match."],
  [/^已發佈或取代的 Template Version 不可修改；請建立新的 Draft Version。$/, "Published or superseded Template Versions are locked. Create a new Draft Version."],
  [/^Draft Version 已可直接修改，不需要複製。$/, "This Draft Version can be edited directly and does not need to be copied."],
  [/^找不到 Template。$/, "The selected Template was not found."],
  [/^此 Template 已有未完成的 Draft；請先開啟或處理該 Draft。$/, "This Template already has an unfinished Draft. Open or resolve it first."],
  [/^Template 至少需要一個已確認欄位才可發佈。$/, "A Template needs at least one confirmed field before publishing."],
  [/^仍有 (\d+) 個欄位未命名或未經人工確認。$/, "$1 fields are still unnamed or have not been human-confirmed."],
  [/^只能從已發佈的 Template Version 建立 Instance。$/, "Instances can be created only from a published Template Version."],
  [/^只有 Draft Version 可修改頁面。$/, "Only Draft Versions can change pages."],
  [/^部分 Instance 不存在或無權存取。$/, "Some Instances do not exist or are inaccessible."],
  [/^部分來源 Instance 不存在或無權存取。$/, "Some source Instances do not exist or are inaccessible."],
  [/^目標必須是已發佈 Version。$/, "The target must be a published Version."],
  [/^只可在同一 Template 的 Version 之間遷移。$/, "Migration is allowed only between Versions of the same Template."],
  [/^來源已綁定目標 Version。$/, "The source is already bound to the target Version."],
  [/^自動保存失敗$/, "Autosave failed"],
  [/^建立失敗$/, "Create failed"],
  [/^圖片保存失敗$/, "Could not save the image"],
  [/^輸出失敗$/, "Export failed"],
  [/^Instance「(.+)」沒有符合指定頁碼的頁面。$/, "Instance \"$1\" has no page matching the selected page range."],
  [/^找不到可完整輸出本次內容的離線繁體中文字型/, "No offline Traditional Chinese font contains every character in this output. Set FORMDIGITAL_CJK_FONT to a static (non-variable, non-.ttc) font that covers them."],
  [/^圖片／簽名欄位必須指向 PNG 或 JPG 本機資產。$/, "Image and signature fields must point to local PNG or JPG assets."],
  [/^Template Version 缺少頁面 manifest。$/, "The Template Version has no page manifest."],
  [/^完整背景輸出缺少第一頁來源資產。$/, "Full-background output is missing the first-page source asset."],
  [/^PDF 來源頁數少於 Template Version 的頁面 manifest。$/, "The source PDF has fewer pages than the Template Version page manifest."],
  [/^完整背景輸出缺少第 (\d+) 頁來源資產。$/, "Full-background output is missing the page $1 source asset."],
  [/^影像背景 Template 的每一頁都必須是 PNG 或 JPG 資產。$/, "Every page in an image-background Template must be a PNG or JPG asset."],
  [/^來源資產格式不支援完整背景輸出。$/, "The source asset format does not support full-background output."],
  [/^欄位 (.+) 指向不存在的頁面。$/, "Field $1 points to a missing page."],
  [/^Instance 尚有 (\d+) 項驗證錯誤，修正後才可預覽、列印或匯出。$/, "The Instance still has $1 validation errors. Correct them before previewing, printing, or exporting."],
];

/**
 * Localizes the fixed Traditional Chinese outer wrapper phrases that surround a
 * structured `[[FD_ISSUE:...]]` marker (e.g. "Template 發佈失敗："). The inner
 * marker is already localized by `localizeServerIssueMarkers`; this keeps the
 * outer phrase consistent with the inner one so we never show an English outer
 * wrapping a Traditional Chinese inner message (or vice versa).
 */
function localizeOuter(message: string, locale: FormulaLocale): string {
  if (locale === "zh-Hant") return message;
  if (locale === "zh-Hans") {
    return message
      .replace(/^Template 發佈失敗：/, "Template 发布失败：")
      .replace(
        /^無法將狀態更新為 (\w+)，表單包含 (\d+) 項驗證錯誤：/,
        "无法将状态更新为 $1，表单包含 $2 项验证错误："
      );
  }
  return message
    .replace(/^Template 發佈失敗：/, "Template publish failed: ")
    .replace(
      /^無法將狀態更新為 (\w+)，表單包含 (\d+) 項驗證錯誤：/,
      "Cannot change the status to $1: the form still has $2 validation errors. "
    );
}

export function translateServerMessage(
  value: string,
  translate: Translate,
  locale?: FormulaLocale
) {
  const target = normalizeFormulaLocale(locale);
  const raw = String(value || "");
  // Stable issue markers are rendered from the shared trilingual catalog first,
  // so no raw code, internal suffix or Traditional Chinese can survive. Then the
  // fixed outer wrapper (if any) is localized to match the inner message.
  const message = localizeOuter(localizeServerIssueMarkers(raw, target), target);
  for (const [pattern, english] of ENGLISH_SERVER_MESSAGES)
    if (pattern.test(message)) return translate(message, message.replace(pattern, english));
  return translate(message, message);
}
