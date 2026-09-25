# Formdigital Local Data Folder Service

This local companion keeps Formdigital source assets, manifests, journal records, and emergency backups on this Windows computer. It binds only to `127.0.0.1` and requires a random bearer token from `local-service-config.json`.

For ordinary Windows development, double-click `start-formdigital-dev.cmd`; it starts the Local Data Service first, verifies it, then starts the Web app. `start-local-service.cmd` remains available for service-only diagnostics. The first service run creates a configuration file and the `../FormdigitalData` folder structure; onboarding then requires the user to confirm or move that folder before entering the workspace. Before connecting a separately deployed origin, add its exact value to `allowedOrigins`; do not use `*`.

The service supports `GET /health`, authenticated `POST /api/v1/assets`, `POST /api/v1/integrity-scan`, `POST /api/v1/backups`, `POST /api/v1/restore`, and `POST /api/v1/ocr/tesseract`. It uses staging-file plus rename writes and records operations in `FormdigitalData/journal/operations.ndjson`.

## Free local OCR

OCR has two free, local providers. If a system Tesseract executable is present, the Local Data Service uses it first. Otherwise the browser uses the bundled Tesseract.js worker, LSTM core and pinned `tessdata_fast` models for Traditional Chinese, Simplified Chinese and English from `client/public/ocr-runtime`; this fallback makes no CDN or paid-API request. The `/api/v1/ocr/tesseract` endpoint and browser fallback both return **unconfirmed suggestions** only. See `client/public/ocr-runtime/README.md` for pinned revisions, checksums and license files.
