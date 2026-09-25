/**
 * UX-TPL-01 階段 2／S2-05：本輪新表格控制的局部三語文案（人工字典）。
 *
 * 不新增全站 i18n 架構；只涵蓋本輪新增的控制與訊息。
 * 使用者欄位名稱、原文件文字、公式一律不翻譯（以參數原樣插入）。
 * 欄名 A–AD 沿用 shared 的正式 `columnIndexToName`，不另造一套。
 */

import { columnIndexToName } from "@shared/tableFormula";

export type TableEditingLocale = "zh-Hant" | "zh-Hans" | "en";

export type GridlineAxisText = "horizontal" | "vertical";

export type TableEditingMessages = {
  /** 三種互斥模式 */
  modeField: string;
  modeGridline: string;
  modeCell: string;
  /** 進入模式按鈕 */
  enterGridlineMode: string;
  enterCellMode: string;
  /** 模式說明（常駐顯示目前模式） */
  modeHintField: string;
  modeHintGridline: string;
  modeHintCell: string;
  /** 分組導覽 */
  previousGroup: string;
  nextGroup: string;
  groupStatus: (
    current: number,
    total: number,
    firstRow: number,
    lastRow: number,
    handles: number
  ) => string;
  groupPagingNote: string;
  /** 跳至格子 */
  jumpToCell: string;
  rowSelectAria: string;
  columnSelectAria: string;
  rowOption: (row: number) => string;
  columnOption: (column: number) => string;
  go: string;
  fixedCellLocated: string;
  /** 狀態與安全訊息 */
  emptyNoWritableCells: string;
  invalidGridSize: string;
  gridlineNotAlignedH: string;
  gridlineNotAlignedV: string;
  gridlineDisabledNote: string;
  gridlineMoveRejected: string;
  gestureActiveNote: string;
  /** aria-label */
  cellHandleAria: (row: number, column: number) => string;
  gridlineHandleAria: (axis: GridlineAxisText, boundary: number) => string;
  modeSwitchAria: string;
  groupNavAria: string;
  keyboardHint: string;
  /** 刪除整個表格欄位守護（S2-05 / S2-R2） */
  deleteTableTitle: string;
  deleteTableConfirm: (rows: number, columns: number, label: string) => string;
  /** S2-R2：選取集合含表格時的批次刪除確認（訊息對應實際 ID 集合） */
  deleteSelectionConfirm: (tableCount: number, names: string) => string;
  /** S2-R2：純非表格欄位的刪除確認（訊息對應實際 ID 集合） */
  deleteFieldConfirm: (count: number) => string;
  /** S2-R2：批次刪除中，除表格外還含非表格欄位的補充說明 */
  deleteAlsoOtherFields: (count: number) => string;
  /** 側欄表格分組入口 */
  sidebarTableGroup: string;
  tableEntryDimensions: (rows: number, columns: number) => string;
};

const ZH_HANT: TableEditingMessages = {
  modeField: "欄位模式",
  modeGridline: "格線模式",
  modeCell: "逐格模式",
  enterGridlineMode: "調整格線",
  enterCellMode: "逐格微調",
  modeHintField: "移動或縮放整張表；逐格把手不會干擾點擊。",
  modeHintGridline: "拖動加粗的分隔線調整整列高或整欄寬；對齊才可拖動。",
  modeHintCell: "調整個別格子的位置；公式格帶 fx 標記。",
  previousGroup: "上一組",
  nextGroup: "下一組",
  groupStatus: (current, total, firstRow, lastRow, handles) =>
    `第 ${current}/${total} 組 · 第 ${firstRow}–${lastRow} 列 · ${handles} 個控制點`,
  groupPagingNote:
    "一次只顯示一組的控制點，避免畫面雜亂。所有格子的角色與公式不受分頁影響；換組不會改動任何資料。",
  jumpToCell: "跳至格子",
  rowSelectAria: "選擇列",
  columnSelectAria: "選擇欄",
  rowOption: row => `第 ${row + 1} 列`,
  columnOption: column => `欄 ${columnIndexToName(column) || column + 1}`,
  go: "前往",
  fixedCellLocated:
    "這一格設定為不需填寫，已切換到它所在的組（角色未變更）。",
  emptyNoWritableCells: "目前沒有可調整的填寫格",
  invalidGridSize:
    "表格尺寸超出支援範圍（欄 1–30、列 1–100），已停止表格編輯互動並保留原資料。",
  gridlineNotAlignedH: "這一列的格線不完全對齊，請改用逐格模式調整。",
  gridlineNotAlignedV: "這一欄的格線不完全對齊，請改用逐格模式調整。",
  gridlineDisabledNote: "灰色分隔線代表該處格線不對齊，或沒有可證實的格線資料。",
  gridlineMoveRejected:
    "這條格線已安全拒絕：調整會讓某個格子變成 0 或超出範圍，已保留原資料。",
  gestureActiveNote:
    "拖動進行中：放開才套用，Esc 可取消；捲動與縮放不會中斷目前手勢。",
  cellHandleAria: (row, column) => `調整第 ${row + 1} 列第 ${column + 1} 格位置`,
  gridlineHandleAria: (axis, boundary) =>
    axis === "horizontal"
      ? `調整第 ${boundary} 條水平分隔線（第 ${boundary} 列與第 ${boundary + 1} 列之間）`
      : `調整第 ${boundary} 條垂直分隔線（第 ${boundary} 欄與第 ${boundary + 1} 欄之間）`,
  modeSwitchAria: "表格編輯模式",
  groupNavAria: "控制點分組",
  keyboardHint: "Esc 取消或返回；G 格線模式、C 逐格模式（輸入框中無效）。",
  deleteTableTitle: "刪除整個表格欄位",
  deleteTableConfirm: (rows, columns, label) =>
    `這會刪除整張表格欄位「${label}」（含全部 ${rows} 列 × ${columns} 欄的角色、公式與格線設定），不是只刪目前選取的格子或欄。原頁背景與已上傳資產不會被刪除。`,
  deleteSelectionConfirm: (tableCount, names) =>
    `這會刪除 ${tableCount} 個表格欄位（含「${names}」的全部角色、公式與格線設定），不是只刪目前選取的格子或欄。原頁背景與已上傳資產不會被刪除。`,
  deleteFieldConfirm: count =>
    `這會刪除 ${count} 個欄位（含其角色與設定），原頁背景與已上傳資產不會被刪除。`,
  deleteAlsoOtherFields: count => `另外還有 ${count} 個非表格欄位會一併刪除。`,
  sidebarTableGroup: "表格",
  tableEntryDimensions: (rows, columns) => `${rows} 列 × ${columns} 欄`,
};

const ZH_HANS: TableEditingMessages = {
  modeField: "栏位模式",
  modeGridline: "格线模式",
  modeCell: "逐格模式",
  enterGridlineMode: "调整格线",
  enterCellMode: "逐格微调",
  modeHintField: "移动或缩放整张表；逐格把手不会干扰点击。",
  modeHintGridline: "拖动加粗的分隔线调整整列高或整栏宽；对齐才可拖动。",
  modeHintCell: "调整个别格子的位置；公式格带 fx 标记。",
  previousGroup: "上一组",
  nextGroup: "下一组",
  groupStatus: (current, total, firstRow, lastRow, handles) =>
    `第 ${current}/${total} 组 · 第 ${firstRow}–${lastRow} 列 · ${handles} 个控制点`,
  groupPagingNote:
    "一次只显示一组的控制点，避免画面杂乱。所有格子的角色与公式不受分页影响；换组不会改动任何资料。",
  jumpToCell: "跳至格子",
  rowSelectAria: "选择列",
  columnSelectAria: "选择栏",
  rowOption: row => `第 ${row + 1} 列`,
  columnOption: column => `栏 ${columnIndexToName(column) || column + 1}`,
  go: "前往",
  fixedCellLocated: "这一格设定为不需填写，已切换到它所在的组（角色未变更）。",
  emptyNoWritableCells: "目前没有可调整的填写格",
  invalidGridSize:
    "表格尺寸超出支援范围（栏 1–30、列 1–100），已停止表格编辑互动并保留原资料。",
  gridlineNotAlignedH: "这一列的格线不完全对齐，请改用逐格模式调整。",
  gridlineNotAlignedV: "这一栏的格线不完全对齐，请改用逐格模式调整。",
  gridlineDisabledNote: "灰色分隔线代表该处格线不对齐，或没有可证实的格线资料。",
  gridlineMoveRejected:
    "这条格线已安全拒绝：调整会让某个格子变成 0 或超出范围，已保留原资料。",
  gestureActiveNote:
    "拖动进行中：放开才套用，Esc 可取消；滚动与缩放不会中断目前手势。",
  cellHandleAria: (row, column) => `调整第 ${row + 1} 列第 ${column + 1} 格位置`,
  gridlineHandleAria: (axis, boundary) =>
    axis === "horizontal"
      ? `调整第 ${boundary} 条水平分隔线（第 ${boundary} 列与第 ${boundary + 1} 列之间）`
      : `调整第 ${boundary} 条垂直分隔线（第 ${boundary} 栏与第 ${boundary + 1} 栏之间）`,
  modeSwitchAria: "表格编辑模式",
  groupNavAria: "控制点分组",
  keyboardHint: "Esc 取消或返回；G 格线模式、C 逐格模式（输入框中无效）。",
  deleteTableTitle: "删除整个表格栏位",
  deleteTableConfirm: (rows, columns, label) =>
    `这会删除整张表格栏位「${label}」（含全部 ${rows} 列 × ${columns} 栏的角色、公式与格线设定），不是只删目前选取的格子或栏。原页背景与已上传资产不会被删除。`,
  deleteSelectionConfirm: (tableCount, names) =>
    `这会删除 ${tableCount} 个表格栏位（含「${names}」的全部角色、公式与格线设定），不是只删目前选取的格子或栏。原页背景与已上传资产不会被删除。`,
  deleteFieldConfirm: count =>
    `这会删除 ${count} 个栏位（含其角色与设定），原页背景与已上传资产不会被删除。`,
  deleteAlsoOtherFields: count => `另外还有 ${count} 个非表格栏位会一并删除。`,
  sidebarTableGroup: "表格",
  tableEntryDimensions: (rows, columns) => `${rows} 列 × ${columns} 栏`,
};

const EN: TableEditingMessages = {
  modeField: "Field mode",
  modeGridline: "Gridline mode",
  modeCell: "Cell mode",
  enterGridlineMode: "Adjust gridlines",
  enterCellMode: "Fine-tune cells",
  modeHintField:
    "Move or resize the whole table; cell handles stay out of the way.",
  modeHintGridline:
    "Drag a bold separator to adjust a whole row height or column width; only proven aligned lines can move.",
  modeHintCell: "Adjust individual cells; formula cells carry an fx badge.",
  previousGroup: "Previous group",
  nextGroup: "Next group",
  groupStatus: (current, total, firstRow, lastRow, handles) =>
    `Group ${current}/${total} · rows ${firstRow}–${lastRow} · ${handles} handles`,
  groupPagingNote:
    "Only one group of handles shows at a time to keep the canvas readable. Roles and formulas are unaffected by paging; switching groups changes no data.",
  jumpToCell: "Jump to cell",
  rowSelectAria: "Choose a row",
  columnSelectAria: "Choose a column",
  rowOption: row => `Row ${row + 1}`,
  columnOption: column => `Column ${columnIndexToName(column) || column + 1}`,
  go: "Go",
  fixedCellLocated:
    "This cell is set to not-fill-in; switched to the group containing it (role not changed).",
  emptyNoWritableCells: "No fill-in cells to adjust right now",
  invalidGridSize:
    "This table's size is outside the supported range (columns 1–30, rows 1–100). Table editing interactions are stopped and the original data is kept.",
  gridlineNotAlignedH:
    "The gridlines of this row pair are not fully aligned; please use cell mode instead.",
  gridlineNotAlignedV:
    "The gridlines of this column pair are not fully aligned; please use cell mode instead.",
  gridlineDisabledNote:
    "A grey separator means its gridline is not aligned or has no provable guide data.",
  gridlineMoveRejected:
    "This gridline move was safely rejected: applying it would make a cell zero or out of range, so the original data is kept.",
  gestureActiveNote:
    "A drag is in progress: release to apply, Esc to cancel; scrolling and zooming will not interrupt the current gesture.",
  cellHandleAria: (row, column) => `Adjust cell row ${row + 1}, column ${column + 1}`,
  gridlineHandleAria: (axis, boundary) =>
    axis === "horizontal"
      ? `Adjust horizontal separator ${boundary} (between rows ${boundary} and ${boundary + 1})`
      : `Adjust vertical separator ${boundary} (between columns ${boundary} and ${boundary + 1})`,
  modeSwitchAria: "Table editing mode",
  groupNavAria: "Handle groups",
  keyboardHint:
    "Esc cancels or goes back; G for gridline mode, C for cell mode (ignored while typing).",
  deleteTableTitle: "Delete the whole table field",
  deleteTableConfirm: (rows, columns, label) =>
    `This deletes the entire table field "${label}", including all roles, formulas and gridline settings across ${rows} rows x ${columns} columns — not just the selected cells or columns. The page background and uploaded assets will not be deleted.`,
  deleteSelectionConfirm: (tableCount, names) =>
    `This deletes ${tableCount} table field(s) ("${names}") including all roles, formulas and gridline settings — not just the selected cells or columns. The page background and uploaded assets will not be deleted.`,
  deleteFieldConfirm: count =>
    `This deletes ${count} field(s) including their roles and settings. The page background and uploaded assets will not be deleted.`,
  deleteAlsoOtherFields: count =>
    `In addition, ${count} non-table field(s) will also be deleted.`,
  sidebarTableGroup: "Tables",
  tableEntryDimensions: (rows, columns) => `${rows} rows x ${columns} columns`,
};

/** 依目前 UI locale 取本輪新控制的人工字典；未知 locale 回退繁中。 */
export function tableEditingText(locale: string): TableEditingMessages {
  if (locale === "zh-Hans") return ZH_HANS;
  if (locale === "en") return EN;
  return ZH_HANT;
}

/**
 * 執行期讀取目前 UI locale（與 i18n.tsx 共用 `formdigital.locale` 鍵），
 * 回傳本輪新增控制的人工字典。元件直接呼叫，不依賴 i18n 的 hook／context。
 */
export function tableEditingMessagesForCurrentLocale(): TableEditingMessages {
  let locale = "zh-Hant";
  try {
    if (typeof localStorage !== "undefined") {
      const raw = localStorage.getItem("formdigital.locale");
      if (raw) locale = raw;
    }
  } catch {
    /* localStorage 不可用時回退繁中 */
  }
  return tableEditingText(locale);
}
