/**
 * Layer 1A — Public preflight status probe.
 * Layer 1B — Unauthenticated, local-only recovery reconnect endpoint.
 *
 * Verifies that GET /api/local/preflight returns only a minimal status and
 * never leaks folder paths, tokens, accounts, revisions, assets, messages,
 * errors, or stack traces; that the authenticated routes keep their auth gate;
 * and that POST /api/local/recovery/reconnect enforces every loopback /
 * same-origin / CSRF / state / input guard while returning only minimal
 * status objects.
 *
 * localServiceClient is mocked so no real Local Data Service (127.0.0.1:4317)
 * or secret config file is contacted during these tests.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo, Server } from "node:net";
import { registerLocalDataRoutes } from "./localAssetRoutes";

const { mockGetLocalHealth, mockReconnectLocalDataFolder } = vi.hoisted(() => ({
  mockGetLocalHealth: vi.fn(),
  mockReconnectLocalDataFolder: vi.fn(),
}));

vi.mock("./localServiceClient", () => ({
  LocalServiceRequestError: class LocalServiceRequestError extends Error {
    status = 503;
  },
  createLocalPortableRestoreSessionFromRequest: vi.fn(),
  deleteLocalPortableRestoreSession: vi.fn(),
  getLocalHealth: (...args: unknown[]) => mockGetLocalHealth(...args),
  reconnectLocalDataFolder: (...args: unknown[]) => mockReconnectLocalDataFolder(...args),
  loadLocalAsset: vi.fn(),
  openLocalStreamingBackup: vi.fn(),
  runLocalIntegrityScan: vi.fn(),
  storeLocalAssetFromRequest: vi.fn(),
  getHostAccount: vi.fn(),
  setHostAccount: vi.fn(),
}));

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  registerLocalDataRoutes(app);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(() => {
  server?.close();
});

beforeEach(() => {
  mockGetLocalHealth.mockReset();
  mockReconnectLocalDataFolder.mockReset();
});

async function preflight() {
  const res = await fetch(`${baseUrl}/api/local/preflight`, { cache: "no-store" });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

describe("GET /api/local/preflight", () => {
  it("returns 200 {\"status\":\"ok\"} when the local service is healthy", async () => {
    mockGetLocalHealth.mockResolvedValue({
      status: "ok",
      root: "C:\\Users\\secret\\LocalData",
      dataFolder: "C:\\Users\\secret\\LocalData\\data",
      schemaVersion: 1,
      message: "all good",
    });
    const { status, body } = await preflight();
    expect(status).toBe(200);
    expect(body).toEqual({ status: "ok" });
  });

  it("returns 200 {\"status\":\"reconnect_required\"} and does not leak extra health fields", async () => {
    mockGetLocalHealth.mockResolvedValue({
      status: "reconnect_required",
      root: "C:\\Users\\secret\\LocalData",
      dataFolder: "C:\\Users\\secret\\LocalData\\data",
      schemaVersion: 1,
      message: "Local Data Folder unavailable",
    });
    const { status, body } = await preflight();
    expect(status).toBe(200);
    expect(body).toEqual({ status: "reconnect_required" });
    expect(Object.keys(body)).toEqual(["status"]);
    expect((body as Record<string, unknown>).root).toBeUndefined();
    expect((body as Record<string, unknown>).dataFolder).toBeUndefined();
    expect((body as Record<string, unknown>).message).toBeUndefined();
  });

  it("returns 503 {\"status\":\"unavailable\"} when getLocalHealth throws, hiding the error", async () => {
    mockGetLocalHealth.mockRejectedValue(
      new Error("connect ECONNREFUSED 127.0.0.1:4317 (root C:\\Users\\secret\\LocalData)")
    );
    const { status, body } = await preflight();
    expect(status).toBe(503);
    expect(body).toEqual({ status: "unavailable" });
    expect(Object.keys(body)).toEqual(["status"]);
  });

  it("never returns more than the status key across all three states", async () => {
    const healthy = {
      status: "ok",
      root: "C:\\secret",
      dataFolder: "C:\\secret\\d",
      schemaVersion: 1,
    };
    const reconnect = {
      status: "reconnect_required",
      root: "C:\\secret",
      dataFolder: "C:\\secret\\d",
    };
    for (const health of [healthy, reconnect]) {
      mockGetLocalHealth.mockResolvedValue(health);
      const { body } = await preflight();
      expect(Object.keys(body)).toEqual(["status"]);
    }
    mockGetLocalHealth.mockRejectedValue(new Error("boom C:\\secret"));
    const { body } = await preflight();
    expect(Object.keys(body)).toEqual(["status"]);
  });
});

describe("Layer 1A non-regression: authenticated routes stay protected", () => {
  it("GET /api/local/health still requires Google authentication (401, no leak)", async () => {
    const res = await fetch(`${baseUrl}/api/local/health`, { cache: "no-store" });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(401);
    expect(body).toEqual({ error: "Google authentication required." });
  });
});

/**
 * Sends a POST to the recovery endpoint over a genuine 127.0.0.1 loopback
 * socket with valid default headers. Individual tests override or omit
 * headers to exercise each guard.
 */
async function postRecovery(opts: {
  body?: string;
  headers?: Record<string, string>;
  omitOrigin?: boolean;
} = {}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Formdigital-Recovery": "1",
    "Sec-Fetch-Site": "same-origin",
    ...(opts.omitOrigin ? {} : { Origin: baseUrl }),
    ...(opts.headers ?? {}),
  };
  return fetch(`${baseUrl}/api/local/recovery/reconnect`, {
    method: "POST",
    headers,
    body: opts.body ?? JSON.stringify({ dataFolder: "C:\\Users\\test\\LocalData" }),
  });
}

describe("POST /api/local/recovery/reconnect", () => {
  it("reconnects successfully from a genuine loopback same-origin request", async () => {
    mockGetLocalHealth
      .mockResolvedValueOnce({ status: "reconnect_required", root: "C:\\secret", dataFolder: "C:\\secret\\d" })
      .mockResolvedValueOnce({ status: "ok", root: "C:\\secret", dataFolder: "C:\\secret\\d" });
    mockReconnectLocalDataFolder.mockResolvedValue({ reconnected: true, dataFolder: "C:\\secret\\d" });

    const res = await postRecovery();
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toEqual({ status: "reconnected" });
    expect(Object.keys(body)).toEqual(["status"]);
    expect(mockReconnectLocalDataFolder).toHaveBeenCalledTimes(1);
    expect(mockReconnectLocalDataFolder).toHaveBeenCalledWith("C:\\Users\\test\\LocalData");
    expect(mockGetLocalHealth).toHaveBeenCalledTimes(2);
  });

  it("passes only the trimmed path to reconnectLocalDataFolder", async () => {
    mockGetLocalHealth
      .mockResolvedValueOnce({ status: "reconnect_required" })
      .mockResolvedValueOnce({ status: "ok" });
    mockReconnectLocalDataFolder.mockResolvedValue({ reconnected: true, dataFolder: "x" });

    const res = await postRecovery({
      body: JSON.stringify({ dataFolder: "  C:\\Users\\test\\LocalData  " }),
    });

    expect(res.status).toBe(200);
    expect(mockReconnectLocalDataFolder).toHaveBeenCalledTimes(1);
    expect(mockReconnectLocalDataFolder).toHaveBeenCalledWith("C:\\Users\\test\\LocalData");
  });

  it("returns 409 not_required and never calls reconnect when the service is healthy", async () => {
    mockGetLocalHealth.mockResolvedValue({ status: "ok", root: "C:\\secret" });

    const res = await postRecovery();
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(409);
    expect(body).toEqual({ status: "not_required" });
    expect(mockReconnectLocalDataFolder).not.toHaveBeenCalled();
  });

  it("returns 503 unavailable without leaking when the health check fails", async () => {
    mockGetLocalHealth.mockRejectedValue(
      new Error("ECONNREFUSED 127.0.0.1:4317 (root C:\\secret token=abc)")
    );

    const res = await postRecovery();
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(503);
    expect(body).toEqual({ status: "unavailable" });
    expect(Object.keys(body)).toEqual(["status"]);
    expect(mockReconnectLocalDataFolder).not.toHaveBeenCalled();
  });

  it("returns 400 reconnect_failed without leaking when reconnect throws", async () => {
    mockGetLocalHealth.mockResolvedValue({ status: "reconnect_required", root: "C:\\secret" });
    mockReconnectLocalDataFolder.mockRejectedValue(
      new Error("invalid manifest at C:\\secret\\manifest.json token=abc")
    );

    const res = await postRecovery();
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(400);
    expect(body).toEqual({ status: "reconnect_failed" });
    expect(Object.keys(body)).toEqual(["status"]);
  });

  it("does not report success when the re-check is still not ok", async () => {
    mockGetLocalHealth
      .mockResolvedValueOnce({ status: "reconnect_required" })
      .mockResolvedValueOnce({ status: "reconnect_required" });
    mockReconnectLocalDataFolder.mockResolvedValue({ reconnected: true, dataFolder: "x" });

    const res = await postRecovery();
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(400);
    expect(body).toEqual({ status: "reconnect_failed" });
    expect(mockReconnectLocalDataFolder).toHaveBeenCalledTimes(1);
  });

  it("rejects requests carrying forwarded/proxy headers", async () => {
    const res = await postRecovery({ headers: { "X-Forwarded-For": "1.2.3.4" } });

    expect(res.status).toBe(403);
    expect(mockReconnectLocalDataFolder).not.toHaveBeenCalled();
    expect(mockGetLocalHealth).not.toHaveBeenCalled();
  });

  it("rejects a forwarded/proxy header even when its value is empty", async () => {
    const res = await postRecovery({ headers: { "X-Forwarded-For": "" } });

    expect(res.status).toBe(403);
    expect(mockReconnectLocalDataFolder).not.toHaveBeenCalled();
    expect(mockGetLocalHealth).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin request (different port)", async () => {
    const res = await postRecovery({ headers: { Origin: "http://127.0.0.1:9999" } });

    expect(res.status).toBe(403);
    expect(mockReconnectLocalDataFolder).not.toHaveBeenCalled();
  });

  it("rejects a request with no Origin header", async () => {
    const res = await postRecovery({ omitOrigin: true });

    expect(res.status).toBe(403);
    expect(mockReconnectLocalDataFolder).not.toHaveBeenCalled();
  });

  it("rejects requests without the recovery header", async () => {
    const res = await fetch(`${baseUrl}/api/local/recovery/reconnect`, {
      method: "POST",
      headers: { Origin: baseUrl, "Content-Type": "application/json" },
      body: JSON.stringify({ dataFolder: "C:\\Users\\test\\LocalData" }),
    });

    expect(res.status).toBe(403);
    expect(mockReconnectLocalDataFolder).not.toHaveBeenCalled();
  });

  it("rejects non-JSON content types", async () => {
    const res = await fetch(`${baseUrl}/api/local/recovery/reconnect`, {
      method: "POST",
      headers: {
        Origin: baseUrl,
        "Content-Type": "text/plain",
        "X-Formdigital-Recovery": "1",
      },
      body: "dataFolder=C:\\Users\\test\\LocalData",
    });

    expect(res.status).toBe(403);
    expect(mockReconnectLocalDataFolder).not.toHaveBeenCalled();
  });

  it("rejects a Sec-Fetch-Site that is not same-origin", async () => {
    const res = await postRecovery({ headers: { "Sec-Fetch-Site": "cross-site" } });

    expect(res.status).toBe(403);
    expect(mockReconnectLocalDataFolder).not.toHaveBeenCalled();
  });

  it("rejects an invalid dataFolder without calling reconnect", async () => {
    const res = await postRecovery({ body: JSON.stringify({ dataFolder: "relative/path" }) });
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(400);
    expect(body).toEqual({ status: "invalid_request" });
    expect(mockReconnectLocalDataFolder).not.toHaveBeenCalled();
  });

  it("never emits Access-Control-Allow-Origin", async () => {
    mockGetLocalHealth
      .mockResolvedValueOnce({ status: "reconnect_required" })
      .mockResolvedValueOnce({ status: "ok" });
    mockReconnectLocalDataFolder.mockResolvedValue({ reconnected: true, dataFolder: "x" });

    const res = await postRecovery();

    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
