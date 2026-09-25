import { afterEach, describe, expect, it } from "vitest";
import {
  authenticateAppRequest,
  isLocalOnlyMode,
  localOnlyRequestAllowed,
} from "./localOnly";

const original = process.env.FORMDIGITAL_LOCAL_ONLY;
afterEach(() => {
  if (original === undefined) delete process.env.FORMDIGITAL_LOCAL_ONLY;
  else process.env.FORMDIGITAL_LOCAL_ONLY = original;
});

describe("packaged local-only mode", () => {
  it("is opt-in and gives every local browser the same owner", async () => {
    delete process.env.FORMDIGITAL_LOCAL_ONLY;
    expect(isLocalOnlyMode()).toBe(false);
    process.env.FORMDIGITAL_LOCAL_ONLY = "1";
    expect(isLocalOnlyMode()).toBe(true);
    const request = {
      socket: { remoteAddress: "127.0.0.1" },
      headers: { host: "localhost:3210" },
    };
    const user = await authenticateAppRequest(request as never);
    expect(user).toMatchObject({ id: "local-owner", loginMethod: "local" });
  });

  it("rejects nonlocal, rebinding and cross-site requests", () => {
    const base = { remoteAddress: "127.0.0.1", host: "localhost:3210", port: 3210, method: "GET", headers: {} };
    expect(localOnlyRequestAllowed(base)).toBe(true);
    expect(localOnlyRequestAllowed({ ...base, remoteAddress: "192.0.2.4" })).toBe(false);
    expect(localOnlyRequestAllowed({ ...base, host: "evil.example:3210" })).toBe(false);
    expect(localOnlyRequestAllowed({ ...base, host: "localhost:3000" })).toBe(false);
    expect(localOnlyRequestAllowed({ ...base, headers: { origin: "http://evil.example" } })).toBe(false);
    expect(localOnlyRequestAllowed({ ...base, headers: { "sec-fetch-site": "cross-site" } })).toBe(false);
    expect(localOnlyRequestAllowed({ ...base, headers: { "x-forwarded-host": "localhost" } })).toBe(false);
    expect(localOnlyRequestAllowed({ ...base, method: "POST" })).toBe(false);
    expect(localOnlyRequestAllowed({ ...base, method: "POST", headers: { origin: "http://localhost:3210" } })).toBe(true);
  });
});
