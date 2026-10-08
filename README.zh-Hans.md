# Form Digital：本地表格数字化

[繁體中文](README.zh-Hant.md) · 简体中文 · [English](README.md)

Form Digital 是一款在 Windows 本地运行的表格数字化程序。你可以导入纸质表格的扫描图、PDF、DOCX 或图片，核对字段后制作可重复使用的模板，再逐份填写并导出 PDF。程序也支持离线 OCR、单选与多选标记、表格公式和套印校准。

本地版通过 `localhost` 运行，不需要 Google 登录，也不会把表格上传到 Form Digital 的在线服务。OCR 只提供建议；扫描质量和表格格式各不相同，字段名称与位置仍需人工检查。

## 在 Windows 上使用

到 [GitHub Releases](https://github.com/rickuuyu-create/formdigital/releases/latest) 下载 Windows 版。新用户选择完整的 **FormDigital-Windows-x64-*.zip**，解压整个文件夹，再双击 `Form Digital.exe`。包内已有 Node、OCR 和文档转换引擎，无需另外安装。已有程序的用户选择 **FormDigital-Update-*.exe**，先保存工作并关闭 Form Digital，再更新原程序文件夹。

请下载上述程序文件；GitHub 自动附加的 Source code 是源代码。两份下载提供相同版本的功能。

如果需要自行从源代码构建：

1. 在 Windows 10 或 11 安装 Node.js 24、pnpm 10.4.1。构建工具还需要 Windows .NET Framework 的 C# 编译器。安装依赖时需要网络；构建后的程序在本地运行。
2. 在项目文件夹运行 `pnpm install --frozen-lockfile`，再运行 `pnpm exec playwright install chromium` 安装构建时需要的文档转换引擎。
3. 在 PowerShell 运行 `./delivery/windows/build-package.ps1 -Destination "C:\Form Digital package"`，目标必须是项目外的新文件夹。
4. 将整个交付包文件夹复制到用户电脑，双击 `Form Digital.exe`。使用时保持启动窗口打开。

程序会打开 `http://localhost:3210/`。首次使用指南最后会指向“开始新的模板实习”；建议先用八页示例表格练习，再导入自己的文件。界面语言可以在“设置与备份”中切换为繁体中文、简体中文或英文。

数据默认保存在 `%LOCALAPPDATA%\FormDigital\Data`，与程序文件夹分开。更新程序时请保留该文件夹，并定期在“设置与备份”中创建备份。日常操作可参考[首次使用说明](delivery/windows/首次使用说明.zh-Hans.txt)。

已有 Windows 交付包的用户，可参考[离线更新说明](delivery/windows/UPDATES.md)。独立更新 exe 会核对现有版本，只替换程序文件并保留旧版副本；版本不兼容时不会更新。PDF 排版修正见[更新记录](CHANGELOG.md)。

## 可选的 MCP 连接

在“设置与备份 → AI 连线（MCP）”启用功能，选择允许使用的文件夹和权限，再把生成的配置加入 Codex、WorkBuddy 或兼容的本地 MCP 客户端。AI 可以创建和导入模板、填写、批量处理 CSV、导出 PDF 和管理备份。MCP 默认关闭，无需 Google 登录。[连接说明、功能和验证范围](docs/MCP.md)列出了使用方法及限制。

## 开发与许可

普通开发模式保留了可选的 Google 身份验证流程；本地交付包使用 `FORMDIGITAL_LOCAL_ONLY=1`，界面构建时也使用 `VITE_FORMDIGITAL_LOCAL_ONLY=1`，无需 Google 凭据。密钥只能放在本地环境文件中，不要提交到公开仓库。

源代码采用 [Apache License 2.0](LICENSE)。内置 OCR 组件及语言模型有各自的许可说明，见 [`client/public/ocr-runtime`](client/public/ocr-runtime/README.md)。

如需报告问题或提交修改，请阅读[贡献说明](CONTRIBUTING.md)，并使用自己制作的测试表格，不要上传客户数据。
