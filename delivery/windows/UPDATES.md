# Offline Windows updates

An existing local Windows package can receive a standalone update executable. It contains the new program files; the customer's computer does not need an internet connection, Node installation or package manager to apply it. Version 2026.09.30.1 also includes the offline Chromium engine used for MCP document conversion, so this update is larger than earlier layout-only fixes.

Save your work and close the Form Digital launcher first. Run the update executable. It looks beside itself and in the usual Desktop package locations. If it cannot find the package, select the folder containing `Form Digital.exe`, `app` and `runtime`. When the window says the update is complete, close it and reopen the usual launcher. Refresh the browser and export new PDFs to see layout fixes.

The updater replaces `app/dist` and two explicitly listed program files: `app/local-data-service.mjs` and `app/server/formdigital/portable-archive-stream.mjs`. These include the backup fixes needed for nested DOCX files and current database records. It does not read or change the local data configuration or the forms folder. It keeps the previous program under `.formdigital-update-backups`. A failed replacement restores the old directory and service files; an interrupted replacement is recovered on the next attempt. Keep these backup folders if an update fails. The original package's `SHA256SUMS.txt` describes the original build; each update verifies its own embedded file manifest and writes its release details inside `app/dist/formdigital-release.json`.

The update refuses packages with different runtime or service fingerprints. This is a compatibility check, not a digital signature. Builds made by this repository are unsigned unless the distributor signs them separately. A PDF reader may reflow editable fields after editing; exported appearances are verified before distribution.

## Build an update

Use the exact previously distributed package as the compatibility reference. Do not point the builder at customer data.

```powershell
./delivery/windows/build-updater.ps1 -BasePackage "C:\Existing Form Digital package" -Destination "C:\Form Digital update" -Version "2026.09.30.1"
```

Install the pinned dependencies and Playwright Chromium before building. The builder checks that existing runtime dependencies match, builds the local-only interface and server, includes the MCP SDK and conversion engine, embeds a compressed payload, and compiles the updater with the Windows .NET Framework C# compiler. The output folder must be new and outside the source and reference package. `-PreviousPackages` accepts older distributed program copies from the same runtime family so their frontend filenames are recognized. Changes outside the explicit program allowlist require a full package or a separately tested update path.

Run the regression tests against the build evidence folder reported by the builder:

```powershell
./delivery/windows/test-updater.ps1 -BuildEvidence "tmp\updater-build-..." -BasePackage "C:\Existing Form Digital package" -TestRoot "tmp\update-check"
```

The test creates a separate program copy and synthetic data. It checks replacement, rollback, interrupted updates, compatibility refusals, data retention and both updater window outcomes. Run `node delivery/windows/test-local-edition.mjs "tmp\update-check\Complete package" --direct-runtime` for the updated package's no-login form-to-PDF workflow. Never use real customer data for these checks.

Test DOCX import against the updated production package as well:

```powershell
node --import tsx delivery/windows/test-docx-import.mjs "tmp\update-check\Complete package" chromium
```

Repeat with `firefox` and `webkit` if those Playwright browsers are installed. This uses the package's real security policy and synthetic text/table and three-page image documents, with OCR on and off. It saves and reads the pages back, checks that the embedded image survives, and verifies that remote connections remain blocked. Run these package tests sequentially because they use the same isolated ports.

Run `node --import tsx delivery/windows/test-mcp.mjs "ABSOLUTE/PATH/TO/app/dist" "ABSOLUTE/PATH/TO/app"` for the optional MCP tools, both transports, OCR jobs, concurrency, local approvals and output tests. See [MCP setup](../../docs/MCP.md). Pass an absolute package path to the standalone local-edition smoke test.

## 繁體中文

先儲存工作並關閉 Form Digital 啟動視窗，再執行更新 exe。若找不到程式，選擇內有 `Form Digital.exe`、`app` 及 `runtime` 的原交付包資料夾。看到「更新完成，可以關閉此視窗」後，重新開啟原有程式並重新整理網站。舊 PDF 不會自動改動，請重新匯出。

更新檔已包含所需的新程式，不用連網下載。工具只替換程式檔，保留資料及設定，並留下舊程式副本。若更新失敗，請保留資料夾並把畫面訊息交給維護人員。

## 简体中文

先保存工作并关闭 Form Digital 启动窗口，再运行更新 exe。如果找不到程序，选择内有 `Form Digital.exe`、`app` 和 `runtime` 的原交付包文件夹。看到“更新完成，可以关闭此窗口”后，重新打开原程序并刷新网页。旧 PDF 不会自动改变，请重新导出。

更新文件已包含所需的新程序，不用联网下载。工具只替换程序文件，保留数据和设置，并留下旧程序副本。如果更新失败，请保留文件夹并把窗口信息交给维护人员。
