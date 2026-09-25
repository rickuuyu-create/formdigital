import { Readable } from "node:stream";
import type { AddressInfo, Server } from "node:net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerLocalDataRoutes } from "./localAssetRoutes";

const {
  mockAuthenticate,
  mockDeleteSession,
  mockOpenBackup,
  mockUploadSession,
} = vi.hoisted(() => ({
  mockAuthenticate: vi.fn(),
  mockDeleteSession: vi.fn(),
  mockOpenBackup: vi.fn(),
  mockUploadSession: vi.fn(),
}));

vi.mock("./localServiceClient", () => ({
  LocalServiceRequestError: class LocalServiceRequestError extends Error {
    constructor(readonly status: number) {
      super("fixed");
    }
  },
  createLocalPortableRestoreSessionFromRequest: (...args: unknown[]) =>
    mockUploadSession(...args),
  deleteLocalPortableRestoreSession: (...args: unknown[]) =>
    mockDeleteSession(...args),
  openLocalStreamingBackup: (...args: unknown[]) => mockOpenBackup(...args),
  getLocalHealth: vi.fn(),
  reconnectLocalDataFolder: vi.fn(),
  loadLocalAsset: vi.fn(),
  runLocalIntegrityScan: vi.fn(),
  storeLocalAssetFromRequest: vi.fn(),
}));

vi.mock("./googleAuth", () => ({
  authenticateGoogleRequest: (...args: unknown[]) => mockAuthenticate(...args),
}));

let server: Server;
let baseUrl: string;
const backupId = "backup-2026-08-31T00-00-00-000Z-test1234";
const sessionId = "123e4567-e89b-42d3-a456-426614174000";

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  registerLocalDataRoutes(app);
  await new Promise<void>(resolve => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server?.close());

beforeEach(() => {
  mockAuthenticate.mockReset();
  mockDeleteSession.mockReset();
  mockOpenBackup.mockReset();
  mockUploadSession.mockReset();
  mockAuthenticate.mockResolvedValue({ id: "owner-1" });
  mockOpenBackup.mockResolvedValue({
    stream: Readable.from([Buffer.from("PART-1"), Buffer.from("-PART-2")]),
    contentLength: 13,
    filename: `${backupId}.formdigital-backup`,
  });
  mockUploadSession.mockImplementation(
    async (_owner: string, source: NodeJS.ReadableStream) => {
      const chunks: Buffer[] = [];
      for await (const chunk of source) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toBe("STREAMED-ARCHIVE");
      return {
        sessionId,
        archiveBytes: 16,
        expiresAt: "2026-08-31T01:00:00.000Z",
        manifest: {
          id: backupId,
          schemaVersion: 2,
          scope: "account",
          templateId: null,
          createdAt: "2026-08-31T00:00:00.000Z",
          summary: {
            templates: [],
            templateCount: 0,
            versionCount: 0,
            instanceCount: 0,
            mappingTemplateCount: 0,
          },
        },
      };
    }
  );
  mockDeleteSession.mockResolvedValue({ deleted: true });
});

function portableHeaders(extra: Record<string, string> = {}) {
  return {
    origin: baseUrl,
    "sec-fetch-site": "same-origin",
    "x-formdigital-portable-restore": "1",
    ...extra,
  };
}

describe("authenticated Portable Backup streaming routes", () => {
  it("streams downloads with fixed private attachment headers", async () => {
    const response = await fetch(
      `${baseUrl}/api/local/portable-backups/${backupId}`
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("PART-1-PART-2");
    expect(response.headers.get("content-length")).toBe("13");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toContain(
      `${backupId}.formdigital-backup`
    );
    expect(mockOpenBackup).toHaveBeenCalledWith("owner-1", backupId);
  });

  it("rejects unauthenticated and malformed download identifiers", async () => {
    mockAuthenticate.mockResolvedValueOnce(null);
    const unauthenticated = await fetch(
      `${baseUrl}/api/local/portable-backups/${backupId}`
    );
    const malformed = await fetch(
      `${baseUrl}/api/local/portable-backups/not-a-backup`
    );

    expect(unauthenticated.status).toBe(401);
    expect(malformed.status).toBe(400);
    expect(mockOpenBackup).not.toHaveBeenCalled();
  });

  it("forwards an upload as raw bytes and returns only the verified preview", async () => {
    const response = await fetch(
      `${baseUrl}/api/local/portable-restore-sessions`,
      {
        method: "POST",
        headers: portableHeaders({
          "content-type": "application/octet-stream",
        }),
        body: "STREAMED-ARCHIVE",
      }
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(201);
    expect(body.sessionId).toBe(sessionId);
    expect(JSON.stringify(body)).not.toContain("owner-1");
    expect(JSON.stringify(body)).not.toContain("contentHash");
    expect(mockUploadSession).toHaveBeenCalledTimes(1);
  });

  it("requires exact origin, fetch metadata, custom header, and content type", async () => {
    const cases = [
      portableHeaders({
        origin: "",
        "content-type": "application/octet-stream",
      }),
      portableHeaders({
        "sec-fetch-site": "cross-site",
        "content-type": "application/octet-stream",
      }),
      portableHeaders({
        "x-formdigital-portable-restore": "",
        "content-type": "application/octet-stream",
      }),
      portableHeaders({ "content-type": "application/json" }),
    ];
    for (const headers of cases) {
      const response = await fetch(
        `${baseUrl}/api/local/portable-restore-sessions`,
        {
          method: "POST",
          headers,
          body:
            headers["content-type"] === "application/json"
              ? "{}"
              : "STREAMED-ARCHIVE",
        }
      );
      expect(response.status).toBe(403);
      expect(response.headers.has("access-control-allow-origin")).toBe(false);
    }
    expect(mockUploadSession).not.toHaveBeenCalled();
  });

  it("turns upstream rejection into a fixed, value-free response", async () => {
    mockUploadSession.mockRejectedValue(
      new Error("C:\\TEST_PATH_VALUE token=TEST_TOKEN_VALUE")
    );
    const response = await fetch(
      `${baseUrl}/api/local/portable-restore-sessions`,
      {
        method: "POST",
        headers: portableHeaders({
          "content-type": "application/octet-stream",
        }),
        body: "STREAMED-ARCHIVE",
      }
    );
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).toContain("upload_unavailable");
    expect(body).not.toContain("TEST_PATH_VALUE");
    expect(body).not.toContain("TEST_TOKEN_VALUE");
  });

  it("deletes only a same-origin, authenticated UUID session", async () => {
    const response = await fetch(
      `${baseUrl}/api/local/portable-restore-sessions/${sessionId}`,
      { method: "DELETE", headers: portableHeaders() }
    );
    const bad = await fetch(
      `${baseUrl}/api/local/portable-restore-sessions/not-a-uuid`,
      { method: "DELETE", headers: portableHeaders() }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
    expect(bad.status).toBe(403);
    expect(mockDeleteSession).toHaveBeenCalledWith("owner-1", sessionId);
    expect(mockDeleteSession).toHaveBeenCalledTimes(1);
  });
});
