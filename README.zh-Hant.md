# Form Digital：本機表格數碼化

繁體中文 · [简体中文](README.zh-Hans.md) · [English](README.md)

Form Digital 是在 Windows 本機使用的表格數碼化程式。你可以匯入紙本掃描圖、PDF、DOCX 或圖片，核對欄位後製成可重用的範本，再逐份填寫和輸出 PDF。程式亦支援離線 OCR、單選與多選圈選、表格公式和套印校準。

本機版透過 `localhost` 運行，不需要 Google 登入，也不會把表格上傳到 Form Digital 的網上服務。OCR 只提供建議；掃描品質和表格格式各有不同，欄位名稱與位置仍要人手核對。

## 在 Windows 使用

這個儲存庫提供原始碼及交付包建置工具，不包含客戶表格、已填紀錄或預先製作的安裝程式。

1. 在 Windows 10 或 11 安裝 Node.js 24、pnpm 10.4.1。建置工具亦需要 Windows .NET Framework 的 C# 編譯器。安裝依賴時需要網絡；建成後的程式在本機運行。
2. 在專案資料夾執行 `pnpm install --frozen-lockfile`。
3. 在 PowerShell 執行 `./delivery/windows/build-package.ps1 -Destination "C:\Form Digital package"`，目的地須是專案以外的新資料夾。
4. 將整個交付包資料夾複製到使用者電腦，雙擊 `Form Digital.exe`。使用期間保持啟動視窗開啟。

程式會開啟 `http://localhost:3210/`。首次使用指南最後會指向「開始新的範本實習」；建議先用八頁示範表格練習，再匯入自己的文件。介面語言可在「設定與備份」選擇繁體中文、簡體中文或英文。

資料預設儲存在 `%LOCALAPPDATA%\FormDigital\Data`，與程式資料夾分開。更換程式時請保留這個資料夾，並定期在「設定與備份」建立備份。日常操作可參考[首次使用說明](delivery/windows/首次使用說明.txt)。

## 開發與授權

一般開發模式仍保留可選的 Google 驗證流程；本機交付包使用 `FORMDIGITAL_LOCAL_ONLY=1`，介面建置亦使用 `VITE_FORMDIGITAL_LOCAL_ONLY=1`，毋須 Google 憑證。密鑰只應放在本機環境檔，切勿提交到公開儲存庫。

原始碼採用 [Apache License 2.0](LICENSE)。內置 OCR 元件及語言模型各有授權說明，見 [`client/public/ocr-runtime`](client/public/ocr-runtime/README.md)。

如要報告問題或提交修改，請參閱[貢獻說明](CONTRIBUTING.md)，並使用自製測試表格，勿上傳客戶資料。
