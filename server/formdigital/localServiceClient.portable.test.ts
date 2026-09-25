import fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type ClientModule = typeof import("./localServiceClient");
type Handler = (request: IncomingMessage, response: ServerResponse) => void;

let client: ClientModule;
let server: http.Server;
let scratch: string;
let handler: Handler;
let receivedBody = Buffer.alloc(0);
let receivedHeaders: http.IncomingHttpHeaders = {};
const token = "TEST_TOKEN_VALUE";
const owner = "TEST_OWNER_VALUE";
const backupId = "backup-2026-08-31T00-00-00-000Z-test1234";
const sessionId = "123e4567-e89b-42d3-a456-426614174000";
const previousConfig = process.env.FORMDIGITAL_LOCAL_CONFIG;

function validPreview() {
  return {
    sessionId,
    archiveBytes: 19,
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

function sourceFrom(bytes: Buffer, complete = true) {
  const source = new PassThrough() as PassThrough & {
    headers: Record<string, string>;
    complete: boolean;
  };
  source.headers = { "content-length": String(bytes.byteLength) };
  source.complete = complete;
  queueMicrotask(() => source.end(bytes));
  return source as unknown as IncomingMessage;
}

async function withDeadline<T>(promise: Promise<T>, milliseconds = 2_000) {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("TEST_TIMEOUT")), milliseconds);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

beforeAll(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "formdigital-local-client-"));
  handler = (_request, response) => response.end();
  server = http.createServer((request, response) => handler(request, response));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const configPath = path.join(scratch, "config.json");
  await fs.writeFile(configPath, JSON.stringify({
    schemaVersion: 1,
    port,
    dataFolder: path.join(scratch, "data"),
    token,
    allowedOrigins: [],
  }));
  process.env.FORMDIGITAL_LOCAL_CONFIG = configPath;
  vi.resetModules();
  client = await import("./localServiceClient");
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await fs.rm(scratch, { recursive: true, force: true });
  if (previousConfig === undefined) delete process.env.FORMDIGITAL_LOCAL_CONFIG;
  else process.env.FORMDIGITAL_LOCAL_CONFIG = previousConfig;
});

beforeEach(() => {
  receivedBody = Buffer.alloc(0);
  receivedHeaders = {};
  handler = async (request, response) => {
    receivedHeaders = request.headers;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    receivedBody = Buffer.concat(chunks);
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify(validPreview()));
  };
});

describe("Local Service Portable Backup streaming client", () => {
  it("forwards exact raw bytes with credentials only to the loopback service", async () => {
    const raw = Buffer.from([0, 1, 2, 3, 0xff, 0x00, 0x7f]);
    const result = await withDeadline(
      client.createLocalPortableRestoreSessionFromRequest(
        owner,
        sourceFrom(raw),
      ),
    );

    expect(result.sessionId).toBe(sessionId);
    expect(receivedBody).toEqual(raw);
    expect(receivedHeaders.authorization).toBe(`Bearer ${token}`);
    expect(receivedHeaders["x-formdigital-owner"]).toBe(owner);
    expect(receivedHeaders["content-type"]).toBe("application/octet-stream");
  });

  it("returns a Node stream for downloads without materialising a Buffer", async () => {
    const chunks = [Buffer.from("STREAM-"), Buffer.from("DOWNLOAD")];
    handler = (request, response) => {
      expect(request.url).toContain(backupId);
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": "15",
      });
      response.write(chunks[0]);
      response.end(chunks[1]);
    };

    const result = await client.openLocalStreamingBackup(owner, backupId);
    expect(Buffer.isBuffer(result.stream)).toBe(false);
    const received: Buffer[] = [];
    for await (const chunk of result.stream) received.push(Buffer.from(chunk));
    expect(Buffer.concat(received).toString()).toBe("STREAM-DOWNLOAD");
    expect(result.contentLength).toBe(15);
  });

  it("settles with a fixed error when the JSON response exceeds its bound", async () => {
    handler = (request, response) => {
      request.resume();
      response.writeHead(201, { "content-type": "application/json" });
      response.end(Buffer.alloc(16 * 1024 * 1024 + 1, 0x41));
    };

    await expect(withDeadline(
      client.createLocalPortableRestoreSessionFromRequest(
        owner,
        sourceFrom(Buffer.from("archive")),
      ),
    )).rejects.toMatchObject({
      code: "portable_restore_response_too_large",
    });
  });

  it("settles when the upstream response is aborted", async () => {
    handler = (request, response) => {
      request.resume();
      response.writeHead(201, { "content-type": "application/json" });
      response.write('{"sessionId":"TEST_PRIVATE_VALUE"');
      response.socket?.destroy();
    };

    await expect(withDeadline(
      client.createLocalPortableRestoreSessionFromRequest(
        owner,
        sourceFrom(Buffer.from("archive")),
      ),
    )).rejects.toMatchObject({
      code: expect.stringMatching(/^portable_restore_/),
    });
  });

  it("settles and aborts upstream when the browser source closes early", async () => {
    handler = request => request.resume();
    const source = new PassThrough() as PassThrough & {
      headers: Record<string, string>;
      complete: boolean;
    };
    source.headers = { "content-length": "100" };
    source.complete = false;
    const pending = client.createLocalPortableRestoreSessionFromRequest(
      owner,
      source as unknown as IncomingMessage,
    );
    await new Promise(resolve => setTimeout(resolve, 25));
    source.write("partial");
    source.emit("close");

    await expect(withDeadline(pending)).rejects.toMatchObject({
      code: "portable_restore_upload_aborted",
    });
  });

  it("does not forward an upstream raw error message", async () => {
    handler = (request, response) => {
      request.resume();
      response.writeHead(422, { "content-type": "application/json" });
      response.end(JSON.stringify({
        error: {
          code: "portable_archive_rejected",
          message: "C:\\TEST_PATH_VALUE TEST_TOKEN_VALUE",
        },
      }));
    };

    const failure = await withDeadline(
      client.createLocalPortableRestoreSessionFromRequest(
        owner,
        sourceFrom(Buffer.from("archive")),
      ).then(() => null, error => error as Error & { code?: string }),
    );
    expect(failure?.code).toBe("portable_archive_rejected");
    expect(failure?.message).not.toContain("TEST_PATH_VALUE");
    expect(failure?.message).not.toContain("TEST_TOKEN_VALUE");
  });
});
