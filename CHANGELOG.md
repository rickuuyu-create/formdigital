# Changes

## 2026-09-28 — PDF text layout

Single-line text now stays vertically centred in exported PDFs, matching the fill preview more closely. English text wraps between words instead of splitting `is` into `i` and `s`. Single-line automatic shrinking reduces the font before introducing a line break; multiline fields keep their paragraph structure.

Editable PDFs now use the same initial wrapping rules, retain the original field value and enforce overflow checks. Text fields set to wrap also show a multiline control in the app. “Block input” has been renamed “Stop export on overflow”: you can still enter and save text, but export stops when it will not fit.

Wrap and warning modes still use the fixed box on the original form. Text below that box is clipped. Increase its height, shorten the text, or use automatic shrinking. A word or URL wider than an entire line can still be split in wrapping mode.

Validation: 1,299 unit tests passed, one skipped; six browser tests passed across Chromium, Firefox and WebKit. TypeScript and the production build passed. These checks use synthetic forms; they do not certify every document or printer.

### 繁體中文

修正 PDF 單行文字偏上的問題，並讓英文優先按完整單字換行。「自動縮小」的單行欄位會先縮字，多行欄位則保留段落。可編輯 PDF 亦套用換行及超限檢查，欄位原文不會因自動換行而改動。

選用多行換行的文字欄位，現在可以直接在畫面輸入多行。「禁止輸入」改名為「超限時停止輸出」，說明其實際行為。警告及換行模式仍受原表格的固定高度限制；若內容太多，請加高欄位、縮短文字或改用自動縮小。

### 简体中文

修正 PDF 单行文字偏上的问题，并让英文优先按完整单词换行。“自动缩小”的单行字段会先缩小字号，多行字段则保留段落。可编辑 PDF 也采用相同的换行及超限检查，字段原文不会因自动换行而改变。

采用多行换行的文本字段，现在可以直接在界面输入多行。“禁止输入”改名为“超限时停止输出”，说明其实际行为。警告及换行模式仍受原表格的固定高度限制；如果内容太多，请增加字段高度、缩短文字或改用自动缩小。
