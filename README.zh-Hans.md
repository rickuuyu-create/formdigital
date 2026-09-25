# Form Digital：本地表格数字化

[繁體中文](README.zh-Hant.md) · 简体中文 · [English](README.md)

Form Digital 是一款在 Windows 本地运行的表格数字化程序。你可以导入纸质表格的扫描图、PDF、DOCX 或图片，核对字段后制作可重复使用的模板，再逐份填写并导出 PDF。程序也支持离线 OCR、单选与多选标记、表格公式和套印校准。

本地版通过 `localhost` 运行，不需要 Google 登录，也不会把表格上传到 Form Digital 的在线服务。OCR 只提供建议；扫描质量和表格格式各不相同，字段名称与位置仍需人工检查。

## 在 Windows 上使用

这个仓库提供源代码和交付包构建工具，不包含客户表格、已填记录或预先制作的安装程序。

1. 在 Windows 10 或 11 安装 Node.js 24、pnpm 10.4.1。构建工具还需要 Windows .NET Framework 的 C# 编译器。安装依赖时需要网络；构建后的程序在本地运行。
2. 在项目文件夹运行 `pnpm install --frozen-lockfile`。
3. 在 PowerShell 运行 `./delivery/windows/build-package.ps1 -Destination "C:\Form Digital package"`，目标必须是项目外的新文件夹。
4. 将整个交付包文件夹复制到用户电脑，双击 `Form Digital.exe`。使用时保持启动窗口打开。

程序会打开 `http://localhost:3210/`。首次使用指南最后会指向“开始新的模板实习”；建议先用八页示例表格练习，再导入自己的文件。界面语言可以在“设置与备份”中切换为繁体中文、简体中文或英文。

数据默认保存在 `%LOCALAPPDATA%\FormDigital\Data`，与程序文件夹分开。更新程序时请保留该文件夹，并定期在“设置与备份”中创建备份。日常操作可参考[首次使用说明](delivery/windows/首次使用说明.zh-Hans.txt)。

## 开发与许可

普通开发模式保留了可选的 Google 身份验证流程；本地交付包使用 `FORMDIGITAL_LOCAL_ONLY=1`，界面构建时也使用 `VITE_FORMDIGITAL_LOCAL_ONLY=1`，无需 Google 凭据。密钥只能放在本地环境文件中，不要提交到公开仓库。

源代码采用 [Apache License 2.0](LICENSE)。内置 OCR 组件及语言模型有各自的许可说明，见 [`client/public/ocr-runtime`](client/public/ocr-runtime/README.md)。

如需报告问题或提交修改，请阅读[贡献说明](CONTRIBUTING.md)，并使用自己制作的测试表格，不要上传客户数据。
