# Local AI connections (MCP)

Form Digital can expose its form tools to an MCP client running on the same computer. MCP is **off by default**. The local edition still works without a Google account or an AI connection.

## Connect an agent

1. Open Form Digital and keep its launcher running.
2. Open **Settings & Backup → AI connections (MCP)** and enable MCP.
3. Enter the folders the agent may import from and save to, one full path per line. Save the list. These folders must already exist.
4. Give the connection a name and choose its permissions. Read, create/fill and export cover everyday work. Backup and manage is needed for maintenance.
5. Select **Create connection settings**. Add the generated Codex TOML or generic stdio JSON to the client. Keep its other MCP entries. The generated command uses the bundled Node runtime; no separate Node installation is needed on the customer's computer.
6. Ask the agent to read `formdigital://guide`, list templates, or create a synthetic practice form first.

For WorkBuddy, use the stdio command and arguments shown by the site in its custom MCP connection screen. A client that asks for a URL and headers can use the Streamable HTTP configuration instead. The address uses the actual Form Digital port. Cloud agents cannot reach your PC through their own `localhost`; this release does not open a public endpoint.

Each connection has its own local credential and permissions. Revoke it in the same settings section, or switch MCP off to stop new requests. A conversion in progress checks for cancellation at safe boundaries. The standard website remains available. Do not share connection files or HTTP authorization headers.

## What you can ask for

For example: “Create a two-page equipment request form, with a required name, date, single-choice department, multiple-choice accessories, quantity × price table and signature field. Show me the layout before publishing. Fill a sample record and save its PDF in my allowed folder.”

| Workflow | Tools and behavior |
| --- | --- |
| Find existing work | `templates_search`, `templates_versions`, `templates_getVersionDetails`, `instances_search`, `instances_get` |
| Import documents | `asset_import`, `source_import_start`, `job_get`, `job_cancel`; PDF, DOCX, PNG/JPG, local OCR and preprocessing |
| Create or revise a template | `form_design_create`, `draft_patch`, `draft_layout`, `draft_pages`, `template_validate`, `template_diff`, clone/publish and metadata tools |
| Fill records | Create, clone, partial value changes, validation and status tools; all 12 existing field types, choice marks and table formulas |
| Batch data | CSV preview, analysis, mapping templates, create/resume; existing duplicate and row-correction rules apply |
| Export and check | Full, overlay and editable PDF; batch PDFs; JSON/CSV; `page_preview`, `output_preview`, `asset_save`; printer calibration |
| Organize work | Folders, tags, favourites, saved values, interface language |
| Maintain data | Template or workspace backups, verified restore, integrity scan/repair and data-folder move/reconnect |
| Inspect changes | `history_list`, `approval_status`, `change_preview`, guarded `change_revert`; independent `practice_create` |

Draft and value edits use current record revision hashes. Changes from another window or agent cause a conflict instead of silently overwriting data. Retrying a write uses the same `operationKey` and identical arguments; inspect failed or interrupted operations before attempting another write. Partial value changes retain fields you did not mention. Guarded undo is available for draft edits and `instance_patch` while the target still matches that operation's result.

Deletion, restore, page removal/reordering, bulk overwrites and other destructive maintenance appear in the website's approval list. Approval applies to the exact request and expires after 15 minutes. The agent repeats that request after approval. Before deleting records, create a workspace backup; deletion is not a general-purpose undo operation.

Import returns an asynchronous job. OCR fields are candidates and start unconfirmed. Inspect page previews and correct fields before publishing. An interrupted process leaves a failed job with any retained draft identified; inspect or remove that draft before starting again. The agent cannot mark the user's output review or tutorial as completed. Producing a PDF does not record a successful physical print.

## Boundaries

The offline conversion engine, OCR models and fonts travel with the Windows package. No download is needed when a customer first imports through MCP. A cloud AI provider may nevertheless receive the tool results in the conversation; use a suitable local agent/model if the complete workflow must stay offline.

Existing product limits still apply: fixed page sizes, bounded arithmetic and SUM rather than full Excel, PDF rather than editable Word output, and manual camera/signature capture and physical printing. A word wider than an entire text box may still split; oversized content needs a taller field, a smaller font or shorter text.

MCP additionally limits source files to 50 MB each, 20 files per import request, eight pending conversions and one active conversion, with a ten-minute conversion deadline. Preview size is bounded. The first release stops new writes at 10,000 operation records; it does not silently discard retry history. Keep its private `mcp` folder when maintaining an installation. Contact the maintainer before clearing history: deleting it can remove replay protection and undo snapshots.

The tested protocol implementation uses official `@modelcontextprotocol/sdk` **1.31.0**, through stdio and Streamable HTTP. The integration suite exercises both against the updated Windows package. The WorkBuddy desktop connection screen and a natural-language end-to-end run in every agent are **not verified**; client versions differ. Do not describe this as a guarantee for every MCP application or for old SSE-only clients.

## Development and verification

Use Node 24 and the pinned pnpm dependencies. `pnpm exec playwright install chromium` installs the browser required at build time. Windows packaging copies the engine and Playwright license files into `app/dist/mcp-runtime`. The converter blocks external requests and has no access to your normal browser profile. Run the source in local mode with `FORMDIGITAL_LOCAL_ONLY=1` and `VITE_FORMDIGITAL_LOCAL_ONLY=1`. `pnpm build` builds the website and stdio bridge; package builders also bundle Chromium.

Run `node --import tsx delivery/windows/test-mcp.mjs "PATH/TO/app/dist" "PATH/TO/app"` from this repository. The test creates isolated synthetic data, uses ports 32127/43217 and closes only the processes it started. See [offline update tests](../delivery/windows/UPDATES.md) for the updater and three-browser DOCX checks.

## 繁體中文

更新後開啟 Form Digital，到「設定與備份 → AI 連線（MCP）」啟用功能。填入允許匯入及儲存的資料夾，設定連線名稱與權限，再按「建立連線設定」。Codex 使用畫面上的 TOML；WorkBuddy 或其他客戶端可使用 stdio JSON，或按其設定畫面填入 command 和 args。程式已附 Node 和轉換引擎，客戶毋須另行安裝。

使用時保持 Form Digital 開啟。可以先請 AI 建立一份測試表，再試填和輸出 PDF。匯入文件後仍要核對欄位，正式版本不能直接改；先複製成新草稿。刪除、還原等操作要回網站批准，刪除前先備份。停用 MCP 或撤銷個別連線後，原網站仍可正常使用。

本機處理不等於雲端 AI 不會收到資料。連線資訊請勿公開。WorkBuddy 桌面版仍需接上實機確認；這次已驗證標準 MCP 的 stdio、HTTP 和網站三語設定流程。

## 简体中文

更新后打开 Form Digital，到“设置与备份 → AI 连线（MCP）”启用功能。填写允许导入和保存的文件夹，设置连接名称与权限，再创建连接配置。Codex 使用页面中的 TOML；WorkBuddy 或其他客户端可使用 stdio JSON，或在其设置中填写 command 和 args。程序已附 Node 和转换引擎，客户无需另外安装。

使用时保持 Form Digital 打开。可以先让 AI 创建测试表，再试填并导出 PDF。导入后仍需核对字段；正式版本需要先复制成新草稿才能修改。删除、恢复等操作需要回到网站批准，删除前先备份。关闭 MCP 或撤销连接后，原网站仍可正常使用。

本地处理不代表云端 AI 不会收到数据。请勿公开连接信息。WorkBuddy 桌面版仍需实际连接确认；本次已验证标准 MCP 的 stdio、HTTP 和网站三语设置流程。
