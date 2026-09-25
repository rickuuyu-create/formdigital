import type { Express, Request, Response } from "express";
import { pipeline } from "node:stream/promises";
import { authenticateAppRequest } from "./localOnly";
import {
  createLocalPortableRestoreSessionFromRequest,
  deleteLocalPortableRestoreSession,
  getLocalHealth,
  loadLocalAsset,
  LocalServiceRequestError,
  openLocalStreamingBackup,
  reconnectLocalDataFolder,
  runLocalIntegrityScan,
  storeLocalAssetFromRequest,
} from "./localServiceClient";
import {
  hasForwardedHeader,
  hasRecoveryHeader,
  isJsonContentType,
  isLocalHostHeader,
  isLoopbackAddress,
  isSameOrigin,
  isSecFetchSiteAllowed,
  validateDataFolderInput,
} from "./localRecoverySecurity";

const RAW_ASSET_KINDS = ["source", "page", "signature", "image", "export"];
const RAW_ASSET_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/png",
  "image/jpeg",
  "application/octet-stream",
];
/**
 * Provenance travels in the request line, so an import keeps its original
 * source list small enough to stay inside the header budget instead of
 * silently dropping it.
 */
const MAX_RAW_SOURCE_ASSET_IDS = 40;
const MAX_PORTABLE_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;

function lowercasedHeaders(request: Request): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) out[key.toLowerCase()] = value[0];
    else out[key.toLowerCase()] = value;
  }
  return out;
}

async function requireUser(request: Request, response: Response) {
  const user = await authenticateAppRequest(request);
  if (!user) response.status(401).json({ error: "Google authentication required." });
  return user;
}

export function registerLocalDataRoutes(app: Express) {
  // Login-screen readiness probe. Deliberately exposes only a minimal status
  // (`ok` | `reconnect_required` | `unavailable`) and never the folder path,
  // token, account identifier, revision, asset information, health message,
  // error detail, or stack trace returned by getLocalHealth().
  app.get("/api/local/preflight", async (_request: Request, response: Response) => {
    try {
      const health = await getLocalHealth();
      if (health.status === "reconnect_required") {
        response.json({ status: "reconnect_required" });
        return;
      }
      response.json({ status: "ok" });
    } catch {
      response.status(503).json({ status: "unavailable" });
    }
  });

  app.get("/api/local/health", async (request: Request, response: Response) => {
    try {
      if (!await requireUser(request, response)) return;
      response.json(await getLocalHealth());
    } catch (error) {
      response.status(503).json({ status: "unavailable", error: error instanceof Error ? error.message : "Local Data Folder unavailable" });
    }
  });

  app.get("/api/local/assets/:assetId", async (request: Request, response: Response) => {
    try {
      const user = await requireUser(request, response);
      if (!user) return;
      const assetId = String(request.params.assetId || "");
      if (!/^asset-[\w-]+$/.test(assetId)) {
        response.status(400).json({ error: "Invalid local asset identifier." });
        return;
      }
      const result = await loadLocalAsset(user.id, assetId);
      const bytes = Buffer.from(result.base64, "base64");
      response.setHeader("content-type", result.asset.mimeType || "application/octet-stream");
      response.setHeader("content-length", String(bytes.byteLength));
      response.setHeader("cache-control", "private, max-age=300");
      response.setHeader("x-content-type-options", "nosniff");
      response.send(bytes);
    } catch (error) {
      response.status(404).json({ error: error instanceof Error ? error.message : "Local asset unavailable" });
    }
  });

  app.get(
    "/api/local/portable-backups/:backupId",
    async (request: Request, response: Response) => {
      try {
        const user = await requireUser(request, response);
        if (!user) return;
        const backupId = String(request.params.backupId || "");
        if (!/^backup-[A-Za-z0-9_-]{1,240}$/.test(backupId)) {
          response.status(400).json({ status: "invalid_request" });
          return;
        }
        const result = await openLocalStreamingBackup(user.id, backupId);
        response.setHeader("content-type", "application/octet-stream");
        if (result.contentLength !== null)
          response.setHeader("content-length", String(result.contentLength));
        response.setHeader(
          "content-disposition",
          `attachment; filename="${result.filename}"`
        );
        response.setHeader("cache-control", "no-store");
        response.setHeader("x-content-type-options", "nosniff");
        await pipeline(result.stream, response);
      } catch (error) {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        const notFound =
          error instanceof LocalServiceRequestError && error.status === 404;
        response
          .status(notFound ? 404 : 503)
          .json({ status: notFound ? "not_found" : "download_unavailable" });
      }
    }
  );

  app.post(
    "/api/local/portable-restore-sessions",
    async (request: Request, response: Response) => {
      try {
        const user = await requireUser(request, response);
        if (!user) return;
        const headers = lowercasedHeaders(request);
        const expectedOrigin = `${request.protocol}://${request.get("host")}`;
        const contentType = String(request.get("content-type") || "");
        const declaredLength = request.get("content-length");
        const parsedLength = declaredLength ? Number(declaredLength) : null;
        if (
          request.headers["x-formdigital-portable-restore"] !== "1" ||
          !/^application\/octet-stream(?:\s*;|$)/i.test(contentType) ||
          headers["sec-fetch-site"]?.trim().toLowerCase() !== "same-origin" ||
          !isSameOrigin(request.get("origin"), expectedOrigin) ||
          (parsedLength !== null &&
            (!Number.isSafeInteger(parsedLength) ||
              parsedLength < 1 ||
              parsedLength > MAX_PORTABLE_ARCHIVE_BYTES))
        ) {
          response.status(403).json({ status: "forbidden" });
          return;
        }
        request.setTimeout(30 * 60 * 1000);
        const result = await createLocalPortableRestoreSessionFromRequest(
          user.id,
          request
        );
        response.status(201).json(result);
      } catch (error) {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        const rejected =
          error instanceof LocalServiceRequestError &&
          error.status >= 400 &&
          error.status < 500;
        response
          .status(rejected ? 422 : 503)
          .json({ status: rejected ? "archive_rejected" : "upload_unavailable" });
      }
    }
  );

  app.delete(
    "/api/local/portable-restore-sessions/:sessionId",
    async (request: Request, response: Response) => {
      try {
        const user = await requireUser(request, response);
        if (!user) return;
        const headers = lowercasedHeaders(request);
        const expectedOrigin = `${request.protocol}://${request.get("host")}`;
        const sessionId = String(request.params.sessionId || "");
        if (
          request.headers["x-formdigital-portable-restore"] !== "1" ||
          headers["sec-fetch-site"]?.trim().toLowerCase() !== "same-origin" ||
          !isSameOrigin(request.get("origin"), expectedOrigin) ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            sessionId
          )
        ) {
          response.status(403).json({ status: "forbidden" });
          return;
        }
        await deleteLocalPortableRestoreSession(user.id, sessionId);
        response.json({ deleted: true });
      } catch {
        response.status(404).json({ status: "not_found" });
      }
    }
  );

  // CSV uploads are streamed as raw octet-stream bodies. The browser never
  // base64-encodes the file and the server never buffers the whole upload.
  app.post("/api/local/csv-assets", async (request: Request, response: Response) => {
    try {
      const user = await requireUser(request, response);
      if (!user) return;
      const headers = lowercasedHeaders(request);
      const expectedOrigin = `${request.protocol}://${request.get("host")}`;
      const contentType = String(request.get("content-type") || "");
      if (
        request.headers["x-formdigital-csv-upload"] !== "1" ||
        !/^application\/octet-stream/i.test(contentType) ||
        !isSecFetchSiteAllowed(headers) ||
        (request.get("origin") && !isSameOrigin(request.get("origin"), expectedOrigin))
      ) {
        response.status(403).json({ status: "forbidden" });
        return;
      }
      const filename = String(request.query.filename || "import.csv");
      const templateId = String(request.query.templateId || "");
      const versionId = String(request.query.versionId || "");
      if (
        filename.length > 255 ||
        (templateId && !/^[a-z0-9_-]+$/i.test(templateId)) ||
        (versionId && !/^[a-z0-9_-]+$/i.test(versionId))
      ) {
        response.status(400).json({ status: "invalid_request" });
        return;
      }
      request.setTimeout(30 * 60 * 1000);
      const result = await storeLocalAssetFromRequest(user.id, request, {
        filename,
        metadata: {
          kind: "source",
          purpose: "csv-import",
          ...(templateId ? { templateId } : {}),
          ...(versionId ? { templateVersionId: versionId } : {}),
        },
      });
      response.status(result.deduplicated ? 200 : 201).json({
        assetId: result.asset.id,
        originalFilename: result.asset.originalFilename,
        mimeType: result.asset.mimeType,
        size: result.asset.size,
        deduplicated: result.deduplicated,
      });
    } catch {
      if (!response.headersSent)
        response.status(503).json({ status: "upload_unavailable" });
      else response.destroy();
    }
  });

  // Template sources and rasterised pages stream through the same raw asset
  // path as CSV imports, so a large import never needs a base64 copy in the
  // browser or a buffered body on the server.
  app.post("/api/local/raw-assets", async (request: Request, response: Response) => {
    try {
      const user = await requireUser(request, response);
      if (!user) return;
      const headers = lowercasedHeaders(request);
      const expectedOrigin = `${request.protocol}://${request.get("host")}`;
      const contentType = String(request.get("content-type") || "");
      if (
        request.headers["x-formdigital-raw-upload"] !== "1" ||
        !/^application\/octet-stream/i.test(contentType) ||
        !isSecFetchSiteAllowed(headers) ||
        (request.get("origin") && !isSameOrigin(request.get("origin"), expectedOrigin))
      ) {
        response.status(403).json({ status: "forbidden" });
        return;
      }
      const filename = String(request.query.filename || "source");
      const kind = String(request.query.kind || "");
      const mimeType = String(request.query.mimeType || "");
      const purpose = String(request.query.purpose || "");
      const templateId = String(request.query.templateId || "");
      const versionId = String(request.query.versionId || "");
      const originalAssetIds = String(request.query.originalAssetIds || "");
      const preprocessing = String(request.query.preprocessing || "");
      const sourceIds = originalAssetIds
        ? originalAssetIds.split(",").filter(Boolean)
        : [];
      if (
        filename.length > 255 ||
        !RAW_ASSET_KINDS.includes(kind) ||
        !RAW_ASSET_MIME_TYPES.includes(mimeType) ||
        purpose.length > 64 ||
        !/^[a-z0-9_-]*$/i.test(purpose) ||
        (templateId && !/^[a-z0-9_-]+$/i.test(templateId)) ||
        (versionId && !/^[a-z0-9_-]+$/i.test(versionId)) ||
        sourceIds.length > MAX_RAW_SOURCE_ASSET_IDS ||
        sourceIds.some(assetId => !/^asset-[\w-]+$/.test(assetId)) ||
        preprocessing.length > 256
      ) {
        response.status(400).json({ status: "invalid_request" });
        return;
      }
      let preprocessingMetadata: unknown;
      if (preprocessing) {
        try {
          preprocessingMetadata = JSON.parse(preprocessing);
        } catch {
          response.status(400).json({ status: "invalid_request" });
          return;
        }
        if (
          !preprocessingMetadata ||
          typeof preprocessingMetadata !== "object" ||
          Array.isArray(preprocessingMetadata)
        ) {
          response.status(400).json({ status: "invalid_request" });
          return;
        }
      }
      request.setTimeout(30 * 60 * 1000);
      const result = await storeLocalAssetFromRequest(user.id, request, {
        filename,
        mimeType,
        metadata: {
          kind,
          templateId: templateId || null,
          templateVersionId: versionId || null,
          instanceId: null,
          ...(purpose ? { purpose } : {}),
          ...(sourceIds.length ? { originalAssetIds: sourceIds } : {}),
          ...(preprocessingMetadata
            ? { preprocessing: preprocessingMetadata }
            : {}),
        },
      });
      response.status(result.deduplicated ? 200 : 201).json({
        assetId: result.asset.id,
        originalFilename: result.asset.originalFilename,
        mimeType: result.asset.mimeType,
        size: result.asset.size,
        deduplicated: result.deduplicated,
      });
    } catch {
      if (!response.headersSent)
        response.status(503).json({ status: "upload_unavailable" });
      else response.destroy();
    }
  });

  app.post("/api/local/integrity-scan", async (request: Request, response: Response) => {
    try {
      if (!await requireUser(request, response)) return;
      response.json(await runLocalIntegrityScan());
    } catch (error) {
      response.status(503).json({ healthy: false, error: error instanceof Error ? error.message : "Integrity scan unavailable" });
    }
  });

  // Layer 1B — Unauthenticated, local-only recovery reconnect.
  //
  // This is the only endpoint that may run with no Google Session, and only to
  // break the "lost folder + lost session" dead-end. It is deliberately locked
  // down: a real loopback socket, no proxy/tunnel headers, a strictly local
  // Host, an exact same-origin Origin, JSON + a custom recovery header, and the
  // Local Data Service must already report `reconnect_required`. The bearer
  // token stays server-side (never sent to the browser). Every response is a
  // minimal status object — no folder path, token, account, revision, asset,
  // raw service payload, error detail, or stack trace.
  app.post("/api/local/recovery/reconnect", async (request: Request, response: Response) => {
    const headers = lowercasedHeaders(request);

    // 1-3. Source must be a genuine loopback socket, not a proxy or tunnel.
    if (
      !isLoopbackAddress(request.socket.remoteAddress) ||
      hasForwardedHeader(headers) ||
      !isLocalHostHeader(request.get("host"))
    ) {
      response.status(403).json({ status: "forbidden" });
      return;
    }

    // 4. Origin must be present and exactly same-origin with the request Host.
    const expectedOrigin = `${request.protocol}://${request.get("host")}`;
    if (!isSameOrigin(request.get("origin"), expectedOrigin)) {
      response.status(403).json({ status: "forbidden" });
      return;
    }

    // 5. CSRF: JSON content-type, required custom header, safe Sec-Fetch-Site.
    if (
      !isJsonContentType(request.get("content-type")) ||
      !hasRecoveryHeader(headers) ||
      !isSecFetchSiteAllowed(headers)
    ) {
      response.status(403).json({ status: "forbidden" });
      return;
    }

    // 7. Input must be a trimmed, bounded, NUL-free Windows absolute path.
    const input = validateDataFolderInput(
      (request.body as { dataFolder?: unknown } | undefined)?.dataFolder
    );
    if (!input.ok || !input.value) {
      response.status(400).json({ status: "invalid_request" });
      return;
    }

    // 6. State gate: recovery is only valid while the service is lost.
    let health;
    try {
      health = await getLocalHealth();
    } catch {
      response.status(503).json({ status: "unavailable" });
      return;
    }
    if (health.status !== "reconnect_required") {
      response.status(409).json({ status: "not_required" });
      return;
    }

    // 8. Perform reconnect via the existing Local Data Service validator.
    try {
      await reconnectLocalDataFolder(input.value);
    } catch {
      response.status(400).json({ status: "reconnect_failed" });
      return;
    }

    // 8. Re-verify: only report success once the service is actually healthy.
    try {
      const after = await getLocalHealth();
      if (after.status === "ok") {
        response.json({ status: "reconnected" });
        return;
      }
    } catch {
      // fall through to a generic failure below
    }
    response.status(400).json({ status: "reconnect_failed" });
  });
}
