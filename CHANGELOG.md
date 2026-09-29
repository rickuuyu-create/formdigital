# Changes

## 2026-09-30 — optional local MCP

The local Windows edition now offers optional MCP connections, off by default. Authorized local clients can import or design templates, work with all 12 field types, fill individual records or CSV batches, inspect page previews and export PDFs. Versioned edits reject stale changes; local approval protects destructive maintenance. The website retains unsaved input when an agent edits the same record. Both stdio and Streamable HTTP are available without Google sign-in. [Setup and limitations](docs/MCP.md).

The offline updater includes the document conversion engine, DOCX image-import fix and earlier PDF alignment/wrapping fixes. Backup creation now handles DOCX archives nested in backup ZIPs and uses current database records when a legacy JSON projection is stale. The updater backs up and restores the corresponding program files along with the website.

### 繁體中文

新增可選的本機 MCP 連線，預設關閉。AI 可建立及匯入範本、填寫、批量處理 CSV、預覽和輸出 PDF，亦可按權限管理備份。網站與 AI 同時修改時會檢查版本，保留用戶未儲存的內容。刪除及還原等操作須在網站批准，不需要 Google 登入。

新版更新檔附離線轉換引擎，包含 DOCX 圖片匯入、PDF 置中及英文換行修正，並修正含 DOCX 的備份解析及舊資料投影核對問題。使用方式及尚未驗證的客戶端範圍見 MCP 說明。

### 简体中文

新增可选的本地 MCP 连接，默认关闭。AI 可以创建和导入模板、填写、批量处理 CSV、预览和导出 PDF，并按权限管理备份。网站与 AI 同时修改时会检查版本，保留用户未保存的内容。删除和恢复等操作需在网站批准，无需 Google 登录。

新版更新文件附带离线转换引擎，包含 DOCX 图片导入、PDF 居中及英文换行修复，同时修复含 DOCX 的备份解析和旧数据投影核对问题。使用方法及尚未验证的客户端范围见 MCP 说明。

## 2026-09-29 — DOCX images in the offline Windows edition

The local Windows edition now allows the document converter to read images embedded in DOCX files. Previously, its browser security policy blocked these local image URLs and the import showed “Template creation failed”. Remote network connections remain blocked.

The offline update `2026.09.29.1` includes the earlier PDF alignment and English wrapping fixes. Save your work, close Form Digital, run the update, then reopen the app and refresh the browser before importing the Word document again. Existing templates and filled forms stay in place.

### 繁體中文

修正本機 Windows 版無法匯入部分含圖片 Word 文件的問題。原本安全設定擋住了文件內嵌圖片的讀取，令介面顯示「Template 建立失敗」。修正後可讀取這些本機圖片，仍然禁止連接公網。

更新版 `2026.09.29.1` 同時包含之前的 PDF 置中及英文換行修正。先儲存並關閉程式，再執行更新；完成後重新開啟程式、重新整理網頁，再匯入 Word 文件。原有範本及填寫紀錄會保留。

### 简体中文

修正本地 Windows 版无法导入部分含图片 Word 文档的问题。原本安全设置阻止了读取文档内嵌图片，导致界面显示创建失败。修正后可读取这些本地图片，仍然禁止连接公网。

更新版 `2026.09.29.1` 同时包含之前的 PDF 居中及英文换行修正。先保存并关闭程序，再运行更新；完成后重新打开程序、刷新网页，再导入 Word 文档。原有模板及填写记录会保留。

## 2026-09-28 — PDF text layout

Windows users with the compatible local package can apply these fixes with the offline update executable. It keeps the old program as a backup and leaves form data and settings in place. See [update instructions](delivery/windows/UPDATES.md).

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
