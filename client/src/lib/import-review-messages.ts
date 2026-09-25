/**
 * Typed localization messages for the Import Review Panel.
 *
 * Supports zh-Hant, zh-Hans, and en.
 * User field names, source values, and filenames must NEVER be translated.
 */

export type ImportReviewLocale = "zh-Hant" | "zh-Hans" | "en";

export type ImportReviewMessages = {
  invalidGeometry: string;
  loadingPreview: string;
  previewFailed: string;
  excludeAll: string;
  restoreAll: string;
  restorePageHint: string;
  wideBadge: string;
  widthLabel: string;
  sourceLabel: string;
  previousPage: string;
  nextPage: string;
  pageType: string;
  unnamedField: string;
  originalCount: (original: number, excluded: number) => string;
  reviewTitle: string;
  reviewSubtitle: string;
  docxNotice: string;
  noTableNotice: string;
  detectionDisabledNotice: string;
  ocrUnavailableNotice: string;
  documentTruncatedNotice: string;
  generalPage: string;
  attachmentPage: string;
  attachmentNotice: string;
  filterAll: string;
  filterTable: string;
  filterText: string;
  filterNeedsCheck: string;
  ultraWideWarning: string;
  ultraWideTip: string;
  keep: string;
  exclude: string;
  restore: string;
  statusExcluded: string;
  cancelImport: string;
  confirmImport: string;
  importPagesOnly: string;
  emptyCandidates: string;
  pageIndicator: (page: number, total: number) => string;
  candidatesCount: (count: number) => string;
  unconfirmedWarning: string;
  truncatedNotice: string;
};

const MESSAGES: Record<ImportReviewLocale, ImportReviewMessages> = {
  "zh-Hant": {
    invalidGeometry: "辨識結果的頁面或欄位位置無效，未能建立欄位。請檢查來源後重新匯入。",
    loadingPreview: "載入預覽中…", previewFailed: "頁面預覽暫時無法載入。", excludeAll: "排除全部", restoreAll: "復原全部",
    restorePageHint: "切回「一般頁面」可恢復本頁候選設定。", wideBadge: ">80% 寬", widthLabel: "寬度", sourceLabel: "來源",
    previousPage: "上一頁", nextPage: "下一頁", pageType: "頁面類型", unnamedField: "未命名欄位",
    originalCount: (original, excluded) => `（原始 ${original} 個，已排除 ${excluded} 個）`,
    reviewTitle: "覆核辨識建議",
    reviewSubtitle: "檢查辨識結果與附件標記，確認後正式建立欄位。",
    docxNotice: "目前以頁面影像辨識，未直接沿用 Word 原生表格結構；結果需要人工覆核。",
    noTableNotice: "未偵測到表格，可在編輯器手動建立",
    detectionDisabledNotice: "您已停用自動辨識功能，可在編輯器手動建立表格",
    ocrUnavailableNotice: "文字辨識引擎目前無法使用，可在編輯器手動建立表格",
    documentTruncatedNotice: "文件的候選欄位已達安全上限；所有頁面均保留，其餘欄位請手動新增。",
    generalPage: "一般頁面",
    attachmentPage: "本頁是附件，本次不建立欄位建議",
    attachmentNotice: "此頁已標記為附件：完整保留原始頁面與資產，但排除所有欄位建議。",
    filterAll: "全部建議",
    filterTable: "表格",
    filterText: "文字",
    filterNeedsCheck: "需要檢查",
    ultraWideWarning: "寬度超過頁面 80%：可能為整行文字、備註或未分割之表格",
    ultraWideTip: "提示：寬度僅供提醒，不會自動刪除。若為合法備註或簽署欄位可安心保留；若為表格可在完成後至 Editor 編輯。",
    keep: "保留",
    exclude: "排除",
    restore: "復原",
    statusExcluded: "已排除",
    cancelImport: "取消整次匯入",
    confirmImport: "採用建議並完成匯入",
    importPagesOnly: "只匯入頁面（不採納建議）",
    emptyCandidates: "本頁沒有此分類的候選欄位。",
    pageIndicator: (page, total) => `第 ${page} 頁 / 共 ${total} 頁`,
    candidatesCount: count => `${count} 個建議`,
    unconfirmedWarning: "匯入後所有欄位仍為未確認建議，發布前需人工確認。",
    truncatedNotice: "部分候選已達安全上限，其餘欄位可在 Editor 內手動新增。",
  },
  "zh-Hans": {
    invalidGeometry: "辨识结果的页面或栏位位置无效，未能建立栏位。请检查来源后重新汇入。",
    loadingPreview: "载入预览中…", previewFailed: "页面预览暂时无法载入。", excludeAll: "排除全部", restoreAll: "复原全部",
    restorePageHint: "切回“一般页面”可恢复本页候选设置。", wideBadge: ">80% 宽", widthLabel: "宽度", sourceLabel: "来源",
    previousPage: "上一页", nextPage: "下一页", pageType: "页面类型", unnamedField: "未命名栏位",
    originalCount: (original, excluded) => `（原始 ${original} 个，已排除 ${excluded} 个）`,
    reviewTitle: "复核辨识建议",
    reviewSubtitle: "检查辨识结果与附件标记，确认后正式建立栏位。",
    docxNotice: "目前以页面影像辨识，未直接沿用 Word 原生表格结构；结果需要人工复核。",
    noTableNotice: "未侦测到表格，可在编辑器手动建立",
    detectionDisabledNotice: "您已停用自动辨识功能，可在编辑器手动建立表格",
    ocrUnavailableNotice: "文字辨识引擎目前无法使用，可在编辑器手动建立表格",
    documentTruncatedNotice: "文件的候选栏位已达安全上限；所有页面均保留，其余栏位请手动新增。",
    generalPage: "一般页面",
    attachmentPage: "本页是附件，本次不建立栏位建议",
    attachmentNotice: "此页已标记为附件：完整保留原始页面与资产，但排除所有栏位建议。",
    filterAll: "全部建议",
    filterTable: "表格",
    filterText: "文字",
    filterNeedsCheck: "需要检查",
    ultraWideWarning: "宽度超过页面 80%：可能为整行文字、备注或未分割之表格",
    ultraWideTip: "提示：宽度仅供提醒，不会自动删除。若为合法备注或签署栏位可安心保留；若为表格可在完成后至 Editor 编辑。",
    keep: "保留",
    exclude: "排除",
    restore: "复原",
    statusExcluded: "已排除",
    cancelImport: "取消整次汇入",
    confirmImport: "采用建议并完成汇入",
    importPagesOnly: "只汇入页面（不采纳建议）",
    emptyCandidates: "本页没有此分类的候选栏位。",
    pageIndicator: (page, total) => `第 ${page} 页 / 共 ${total} 页`,
    candidatesCount: count => `${count} 个建议`,
    unconfirmedWarning: "汇入后所有栏位仍为未确认建议，发布前需人工确认。",
    truncatedNotice: "部分候选已达安全上限，其余栏位可在 Editor 内手动新增。",
  },
  en: {
    invalidGeometry: "The detected page or field positions are invalid. Fields could not be created. Check the source and import again.",
    loadingPreview: "Loading preview…", previewFailed: "Page preview is temporarily unavailable.", excludeAll: "Exclude all", restoreAll: "Restore all",
    restorePageHint: "Switch back to General Page to restore this page's candidate settings.", wideBadge: ">80% wide", widthLabel: "Width", sourceLabel: "Source",
    previousPage: "Previous page", nextPage: "Next page", pageType: "Page type", unnamedField: "Unnamed field",
    originalCount: (original, excluded) => `(${original} original, ${excluded} excluded)`,
    reviewTitle: "Review Recognition Suggestions",
    reviewSubtitle: "Check recognition results and attachment flags before creating draft fields.",
    docxNotice: "Currently recognized via page image; Word native table structure is not directly adopted; results require human review.",
    noTableNotice: "No tables detected; you can create them manually in the editor.",
    detectionDisabledNotice: "Automatic detection is disabled; you can create tables manually in the editor.",
    ocrUnavailableNotice: "OCR engine is currently unavailable; you can create tables manually in the editor.",
    documentTruncatedNotice: "The document reached the candidate limit. All pages are kept; add further fields manually.",
    generalPage: "General Page",
    attachmentPage: "This page is an attachment; do not create candidate fields",
    attachmentNotice: "Marked as attachment: original page and assets are preserved, but all field suggestions are excluded.",
    filterAll: "All Suggestions",
    filterTable: "Tables",
    filterText: "Text",
    filterNeedsCheck: "Needs Review",
    ultraWideWarning: "Width exceeds 80% of page: may be full-line text, note, or unsegmented table",
    ultraWideTip: "Note: Width is a reminder only and is not auto-deleted. Legitimate wide notes or signature fields can be kept; for tables, please refine in the Editor.",
    keep: "Keep",
    exclude: "Exclude",
    restore: "Restore",
    statusExcluded: "Excluded",
    cancelImport: "Cancel Entire Import",
    confirmImport: "Apply Suggestions & Complete Import",
    importPagesOnly: "Import Pages Only (No Suggestions)",
    emptyCandidates: "No candidate fields in this category on this page.",
    pageIndicator: (page, total) => `Page ${page} of ${total}`,
    candidatesCount: count => `${count} suggestions`,
    unconfirmedWarning: "All imported fields remain unconfirmed suggestions and must be verified before publishing.",
    truncatedNotice: "Some suggestions reached the safety limit; additional fields can be created in the Editor.",
  },
};

export function getImportReviewMessages(locale: string = "zh-Hant"): ImportReviewMessages {
  if (locale === "zh-Hans" || locale.startsWith("zh-CN") || locale.startsWith("zh-SG")) {
    return MESSAGES["zh-Hans"];
  }
  if (locale === "en" || locale.startsWith("en-")) {
    return MESSAGES.en;
  }
  return MESSAGES["zh-Hant"];
}
