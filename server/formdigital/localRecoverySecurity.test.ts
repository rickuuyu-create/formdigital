/**
 * Layer 1B — Pure security-guard unit tests.
 *
 * These table-drive every predicate in localRecoverySecurity.ts so the
 * loopback / forwarded / host / origin / csrf / input decisions are verified
 * exhaustively without standing up an Express server or touching the real
 * Local Data Service or secret config.
 */
import { describe, expect, it } from "vitest";
import {
  hasForwardedHeader,
  hasRecoveryHeader,
  isJsonContentType,
  isLocalHostHeader,
  isLoopbackAddress,
  isSameOrigin,
  isSecFetchSiteAllowed,
  parseHostHeader,
  validateDataFolderInput,
} from "./localRecoverySecurity";

describe("isLoopbackAddress", () => {
  const accepted = [
    "127.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
  ];
  const rejected = [
    undefined,
    null,
    "",
    "0.0.0.0",
    "192.168.0.5",
    "10.0.0.1",
    "169.254.1.1",
    "8.8.8.8",
    "::2",
    "fe80::1",
    "::ffff:8.8.8.8",
    "::1%lo",
    "::ffff:127.0.0.1%eth0",
    "localhost",
    "example.com",
  ];

  it.each(accepted)("accepts loopback address %s", (addr) => {
    expect(isLoopbackAddress(addr)).toBe(true);
  });

  it.each(rejected)("rejects non-loopback address %s", (addr) => {
    expect(isLoopbackAddress(addr)).toBe(false);
  });
});

describe("hasForwardedHeader", () => {
  const keys = [
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-real-ip",
  ];

  it.each(keys)("detects present %s header", (key) => {
    expect(hasForwardedHeader({ [key]: "1.2.3.4" })).toBe(true);
  });

  it("rejects forwarded headers even when their value is empty", () => {
    expect(hasForwardedHeader({ "x-forwarded-for": "" })).toBe(true);
    expect(hasForwardedHeader({ "x-forwarded-for": "   " })).toBe(true);
    expect(hasForwardedHeader({ "x-forwarded-for": undefined })).toBe(true);
  });

  it("returns false when no proxy headers are present", () => {
    expect(hasForwardedHeader({ host: "localhost:3000" })).toBe(false);
  });
});

describe("parseHostHeader / isLocalHostHeader", () => {
  it("parses IPv4 host with and without port", () => {
    expect(parseHostHeader("127.0.0.1:3000")).toEqual({ hostname: "127.0.0.1", port: "3000" });
    expect(parseHostHeader("127.0.0.1")).toEqual({ hostname: "127.0.0.1", port: null });
  });

  it("parses bracketed IPv6 host with and without port", () => {
    expect(parseHostHeader("[::1]:3000")).toEqual({ hostname: "[::1]", port: "3000" });
    expect(parseHostHeader("[::1]")).toEqual({ hostname: "[::1]", port: null });
  });

  it("accepts only numeric ports in the valid TCP range", () => {
    expect(parseHostHeader("localhost:1")).toEqual({ hostname: "localhost", port: "1" });
    expect(parseHostHeader("localhost:65535")).toEqual({ hostname: "localhost", port: "65535" });
    expect(parseHostHeader("localhost:0")).toBeNull();
    expect(parseHostHeader("localhost:65536")).toBeNull();
    expect(parseHostHeader("localhost:abc")).toBeNull();
    expect(parseHostHeader("[::1]:abc")).toBeNull();
  });

  it("returns null for malformed host values", () => {
    expect(parseHostHeader(undefined)).toBeNull();
    expect(parseHostHeader("")).toBeNull();
    expect(parseHostHeader("[::1")).toBeNull();
    expect(parseHostHeader("[::1]garbage")).toBeNull();
    expect(parseHostHeader("[::1]:")).toBeNull();
    expect(parseHostHeader("localhost:")).toBeNull();
    expect(parseHostHeader(":3000")).toBeNull();
  });

  const local = ["localhost", "localhost:3000", "127.0.0.1", "127.0.0.1:3000", "[::1]", "[::1]:3000"];
  const notLocal = [
    "localhost.example.com",
    "127.0.0.1.example.com",
    "example.com",
    "example.com:3000",
    "192.168.0.5",
    "192.168.0.5:3000",
    "tunnel.example.dev",
    "[::1",
    "localhost:",
    "localhost:abc",
    "localhost:65536",
    "[::1]garbage",
    "[::1]:",
    "",
    undefined,
  ];

  it.each(local)("accepts local Host %s", (host) => {
    expect(isLocalHostHeader(host)).toBe(true);
  });

  it.each(notLocal)("rejects non-local Host %s", (host) => {
    expect(isLocalHostHeader(host)).toBe(false);
  });
});

describe("isSameOrigin", () => {
  const expected = "http://127.0.0.1:3000";

  it("accepts an exact same-origin match", () => {
    expect(isSameOrigin("http://127.0.0.1:3000", expected)).toBe(true);
  });

  it("treats localhost / 127.0.0.1 / [::1] as non-interchangeable", () => {
    expect(isSameOrigin("http://localhost:3000", "http://127.0.0.1:3000")).toBe(false);
    expect(isSameOrigin("http://[::1]:3000", "http://127.0.0.1:3000")).toBe(false);
  });

  const rejected: Array<[string | undefined, string]> = [
    [undefined, expected],
    ["null", expected],
    ["http://127.0.0.1:3001", expected], // port differs
    ["https://127.0.0.1:3000", expected], // protocol differs
    ["http://localhost:3000", expected], // hostname differs
    ["http://127.0.0.1.example.com:3000", expected], // subdomain
    ["http://tunnel.dev:3000", expected], // tunnel
  ];

  it.each(rejected)("rejects origin %s against %s", (origin, exp) => {
    expect(isSameOrigin(origin, exp)).toBe(false);
  });
});

describe("isJsonContentType", () => {
  it.each(["application/json", "application/json; charset=utf-8", "Application/JSON"])(
    "accepts %s",
    (ct) => {
      expect(isJsonContentType(ct)).toBe(true);
    }
  );

  it.each([
    undefined,
    "",
    "text/plain",
    "application/x-www-form-urlencoded",
    "application/jsonevil",
    "application/jsonp",
  ])(
    "rejects %s",
    (ct) => {
      expect(isJsonContentType(ct)).toBe(false);
    }
  );
});

describe("hasRecoveryHeader", () => {
  it("accepts the exact custom header value '1'", () => {
    expect(hasRecoveryHeader({ "x-formdigital-recovery": "1" })).toBe(true);
    expect(hasRecoveryHeader({ "x-formdigital-recovery": "  1  " })).toBe(true);
  });

  it.each([undefined, "", "0", "true", "yes"])("rejects %s", (value) => {
    expect(hasRecoveryHeader({ "x-formdigital-recovery": value })).toBe(false);
  });
});

describe("isSecFetchSiteAllowed", () => {
  it("allows when the header is absent", () => {
    expect(isSecFetchSiteAllowed({})).toBe(true);
  });

  it.each(["same-origin", "Same-Origin"])("allows %s", (value) => {
    expect(isSecFetchSiteAllowed({ "sec-fetch-site": value })).toBe(true);
  });

  it.each(["cross-site", "none", "same-site"])("rejects %s", (value) => {
    expect(isSecFetchSiteAllowed({ "sec-fetch-site": value })).toBe(false);
  });
});

describe("validateDataFolderInput", () => {
  const valid = [
    "C:\\Users\\test\\LocalData",
    "C:/Users/test/LocalData",
    "D:\\data",
    "\\\\server\\share",
    "  C:\\Users\\test\\LocalData  ",
    "C:\\", // length 3 — the minimum allowed by the spec
  ];

  it.each(valid)("accepts Windows absolute path %s", (raw) => {
    const result = validateDataFolderInput(raw);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(raw.trim());
  });

  const invalid: Array<[string, unknown]> = [
    ["non-string", 123],
    ["undefined", undefined],
    ["null", null],
    ["relative path", "relative/path"],
    ["root-relative windows", "\\Users\\test"],
    ["unix path", "/usr/local"],
    ["drive no slash", "C:relative"],
    ["too short", "C:"],
    ["nul char", "C:\\test\0bad"],
    ["over 1024", "C:\\" + "a".repeat(1100)],
    ["empty after trim", "   "],
  ];

  it.each(invalid)("rejects %s", (_label, raw) => {
    expect(validateDataFolderInput(raw).ok).toBe(false);
  });
});
