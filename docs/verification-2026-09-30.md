# Windows MCP update verification

Version: 2026.09.30.1. These checks used isolated synthetic data and the Windows package produced by applying the updater, without accessing customer data.

| DOCX case | Chromium | Firefox | WebKit |
| --- | --- | --- | --- |
| Text/table, OCR off | Pass | Pass | Pass |
| Three pages with embedded PNG, OCR off | Pass | Pass | Pass |
| Text/table, OCR on | Pass | Pass | Pass |
| Three pages with embedded PNG, OCR on | Pass | Pass | Pass |

All **12 cases passed**. Each case saved and reopened its pages; the image cases retained three pages and the expected image pixels. The production content security policy was unchanged during tests and continued to block deliberate remote requests.

The updated website passed its no-login onboarding → create → save → publish → fill → PDF workflow. The MCP integration suite passed **36 checks** for both transports, all 12 field types, image and text-signature values, three PDF modes, actual page previews, OCR and cancellation, invalid documents, CSV analysis/import and retry, organization tools, validation, calibration, backup/restore, revision conflicts, guarded undo, approvals, three-language settings and preserved unsaved website input. A two-page exported fixture was also visually inspected for Chinese/English text, choice circles, leading zeros, computed table values and its image.

The updater passed **18 checks**, including normal/repeated updates, rollback, interrupted service-file recovery, data/configuration retention, compatibility refusals, exclusive access, unexpected-file protection, long paths, downgrade refusal and actual window completion/busy states.

Source validation: TypeScript and production build passed; 1,299 unit tests passed and one Google secret-environment test was skipped. Streaming backup tests passed 45 assertions, restore-crash recovery 84, and nested ZIP/DOCX handling seven.

These results do not certify all Word documents, every PDF reader, the customer's PC or a physical printer. WorkBuddy's desktop connection and natural-language tool use in every agent remain unverified. See [MCP instructions and limits](MCP.md) and [repeatable update tests](../delivery/windows/UPDATES.md).
