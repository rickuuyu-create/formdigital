import express from "express";
import type { AddressInfo, Server } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { registerGoogleAuthRoutes } from "./googleAuth";

const ENV_KEYS = [
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_OAUTH_REDIRECT_URIS",
  "GOOGLE_OAUTH_REDIRECT_URI",
  "FORMDIGITAL_GOOGLE_OAUTH_ALLOWED_ORIGINS",
] as const;

const originalEnv = new Map(
  ENV_KEYS.map(key => [key, process.env[key]] as const)
);
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  registerGoogleAuthRoutes(app);
  await new Promise<void>(resolve => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const original = originalEnv.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

afterAll(() => {
  server?.close();
});

function clearGoogleConfig() {
  for (const key of ENV_KEYS) delete process.env[key];
}

describe("Google OAuth browser redirects", () => {
  it("returns to the login UI with a fixed code when configuration is absent", async () => {
    clearGoogleConfig();
    const response = await fetch(`${baseUrl}/api/auth/google/start`, {
      redirect: "manual",
    });
    const body = await response.text();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "/?authError=oauth_not_configured"
    );
    expect(body).not.toContain("TEST_PRIVATE_VALUE");
    expect(body).not.toContain("stack");
  });

  it("returns a fixed origin code instead of a raw server error", async () => {
    clearGoogleConfig();
    process.env.GOOGLE_OAUTH_CLIENT_ID = "TEST_CLIENT_ID";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "TEST_CLIENT_SECRET";
    process.env.GOOGLE_OAUTH_REDIRECT_URIS =
      "http://localhost:65530/api/auth/google/callback";
    const response = await fetch(`${baseUrl}/api/auth/google/start`, {
      redirect: "manual",
    });
    const body = await response.text();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "/?authError=oauth_origin_not_allowed"
    );
    expect(body).not.toContain("TEST_CLIENT_SECRET");
  });

  it("preserves the valid Google authorization redirect without exposing the secret", async () => {
    clearGoogleConfig();
    process.env.GOOGLE_OAUTH_CLIENT_ID = "TEST_CLIENT_ID";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "TEST_CLIENT_SECRET";
    process.env.GOOGLE_OAUTH_REDIRECT_URIS = `${baseUrl}/api/auth/google/callback`;
    process.env.FORMDIGITAL_GOOGLE_OAUTH_ALLOWED_ORIGINS = baseUrl;
    const response = await fetch(`${baseUrl}/api/auth/google/start`, {
      redirect: "manual",
    });
    const location = response.headers.get("location") ?? "";
    expect(response.status).toBe(302);
    expect(location).toContain("https://accounts.google.com/o/oauth2/v2/auth");
    expect(location).toContain("client_id=TEST_CLIENT_ID");
    expect(location).not.toContain("TEST_CLIENT_SECRET");
  });
});
