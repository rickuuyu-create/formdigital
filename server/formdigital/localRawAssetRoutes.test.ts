/**
 * POST /api/local/raw-assets — streamed template source and page uploads.
 *
 * The browser never base64-encodes a large import, so this route must keep the
 * same CSRF / same-origin gate as the CSV route, validate every request-line
 * field, and pass only allow-listed provenance to the Local Data Service. The
 * Local Data Service and Google auth are mocked; no real service or secret
 * config is contacted.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo, Server } from "node:net";
import { registerLocalDataRoutes } from "./localAssetRoutes";

const { mockStoreFromRequest, mockAuthenticate } = vi.hoisted(() => ({
  mockStoreFromRequest: vi.fn(),
  mockAuthenticate: vi.fn(),
}));

vi.mock("./localServiceClient", () => ({
  LocalServiceRequestError: class LocalServiceRequestError extends Error {
    status = 503;
  },
  createLocalPortableRestoreSessionFromRequest: vi.fn(),
  deleteLocalPortableRestoreSession: vi.fn(),
  getLocalHealth: vi.fn(),
  reconnectLocalDataFolder: vi.fn(),
  loadLocalAsset: vi.fn(),
  openLocalStreamingBackup: vi.fn(),
  runLocalIntegrityScan: vi.fn(),
  storeLocalAssetFromRequest: (...args: unknown[]) =>
    mockStoreFromRequest(...args),
}));

vi.mock("./googleAuth", () => ({
  authenticateGoogleRequest: (...args: unknown[]) => mockAuthenticate(...args),
}));

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  registerLocalDataRoutes(app);
  await new Promise<void>(resolve => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
});

beforeEach(() => {
  mockStoreFromRequest.mockReset();
  mockAuthenticate.mockReset();
  mockAuthenticate.mockResolvedValue({ id: "owner-1" });
  mockStoreFromRequest.mockImplementation(
    async (_owner: string, source: NodeJS.ReadableStream) => {
      // Drain the streamed body the way the real client does.
      for await (const _chunk of source) void _chunk;
      return {
        asset: {
          id: "asset-new",
          originalFilename: "source.pdf",
          mimeType: "application/pdf",
          size: 12,
        },
        deduplicated: false,
      };
    }
  );
});

function upload(
  query: Record<string, string>,
  init: { headers?: Record<string, string>; body?: string } = {}
) {
  return fetch(
    `${baseUrl}/api/local/raw-assets?${new URLSearchParams(query).toString()}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-formdigital-raw-upload": "1",
        "sec-fetch-site": "same-origin",
        ...init.headers,
      },
      body: init.body ?? "PDFBYTES",
    }
  );
}

const validQuery = {
  filename: "source.pdf",
  kind: "source",
  mimeType: "application/pdf",
  purpose: "original-source",
  templateId: "tpl-1",
  versionId: "ver-1",
};

describe("POST /api/local/raw-assets", () => {
  it("streams a source upload and returns only asset metadata", async () => {
    const res = await upload(validQuery);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(201);
    expect(body).toEqual({
      assetId: "asset-new",
      originalFilename: "source.pdf",
      mimeType: "application/pdf",
      size: 12,
      deduplicated: false,
    });
    expect(mockStoreFromRequest).toHaveBeenCalledTimes(1);
    const input = mockStoreFromRequest.mock.calls[0]![2] as {
      mimeType: string;
      metadata: Record<string, unknown>;
    };
    expect(input.mimeType).toBe("application/pdf");
    expect(input.metadata).toEqual({
      kind: "source",
      templateId: "tpl-1",
      templateVersionId: "ver-1",
      instanceId: null,
      purpose: "original-source",
    });
  });

  it("carries page provenance without a base64 envelope", async () => {
    const res = await upload({
      filename: "page-1.png",
      kind: "page",
      mimeType: "image/png",
      purpose: "template-page",
      templateId: "tpl-1",
      versionId: "ver-1",
      originalAssetIds: "asset-a,asset-b",
      preprocessing: JSON.stringify({ rotation: 0, autoCrop: true }),
    });

    expect(res.status).toBe(201);
    const input = mockStoreFromRequest.mock.calls[0]![2] as {
      metadata: Record<string, unknown>;
    };
    expect(input.metadata.originalAssetIds).toEqual(["asset-a", "asset-b"]);
    expect(input.metadata.preprocessing).toEqual({
      rotation: 0,
      autoCrop: true,
    });
  });

  it("requires Google authentication", async () => {
    mockAuthenticate.mockResolvedValue(null);
    const res = await upload(validQuery);

    expect(res.status).toBe(401);
    expect(mockStoreFromRequest).not.toHaveBeenCalled();
  });

  it("rejects a missing upload header, wrong content type, or cross-site fetch", async () => {
    const withoutHeader = await upload(validQuery, {
      headers: { "x-formdigital-raw-upload": "" },
    });
    const wrongType = await upload(validQuery, {
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const crossSite = await upload(validQuery, {
      headers: { "sec-fetch-site": "cross-site" },
    });

    expect(withoutHeader.status).toBe(403);
    expect(wrongType.status).toBe(403);
    expect(crossSite.status).toBe(403);
    expect(mockStoreFromRequest).not.toHaveBeenCalled();
  });

  it("rejects unsupported kinds, types, ids, and oversized provenance", async () => {
    const cases: Array<Record<string, string>> = [
      { ...validQuery, kind: "backup" },
      { ...validQuery, mimeType: "text/html" },
      { ...validQuery, mimeType: "" },
      { ...validQuery, templateId: "../escape" },
      { ...validQuery, versionId: "ver 1" },
      { ...validQuery, purpose: "not a purpose" },
      { ...validQuery, filename: "x".repeat(256) },
      { ...validQuery, originalAssetIds: "not-an-asset-id" },
      {
        ...validQuery,
        originalAssetIds: Array.from(
          { length: 41 },
          (_, index) => `asset-${index}`
        ).join(","),
      },
      { ...validQuery, preprocessing: "{" },
      { ...validQuery, preprocessing: "[1,2,3]" },
      { ...validQuery, preprocessing: "x".repeat(257) },
    ];

    for (const query of cases) {
      const res = await upload(query);
      expect({ query: query.kind, status: res.status }).toEqual({
        query: query.kind,
        status: 400,
      });
    }
    expect(mockStoreFromRequest).not.toHaveBeenCalled();
  });

  it("reports a fixed status when the Local Data Service refuses, leaking nothing", async () => {
    mockStoreFromRequest.mockRejectedValue(
      new Error("C:\\Users\\secret\\LocalData token=abc")
    );
    const res = await upload(validQuery);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(503);
    expect(body).toEqual({ status: "upload_unavailable" });
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(JSON.stringify(body)).not.toContain("token");
  });

  it("reports object-byte de-duplication while returning the new lifecycle manifest", async () => {
    mockStoreFromRequest.mockImplementation(
      async (_owner: string, source: NodeJS.ReadableStream) => {
        for await (const _chunk of source) void _chunk;
        return {
          asset: {
            id: "asset-new-reference",
            originalFilename: "source.pdf",
            mimeType: "application/pdf",
            size: 12,
          },
          deduplicated: true,
        };
      }
    );
    const res = await upload(validQuery);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      assetId: "asset-new-reference",
      deduplicated: true,
    });
  });
});
