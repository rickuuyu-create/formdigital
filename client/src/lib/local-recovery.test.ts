// Layer 1C — deterministic client helper tests.
//
// Every assertion here runs without a DOM, a running server, or the secret
// config. `Response` is a global in the Node test runtime, so we build fake
// responses directly and assert on parsing / request building / status mapping.
import { describe, expect, it } from "vitest";
import {
  buildPreflightRequestInit,
  buildRecoveryRequestInit,
  interpretPreflightResponse,
  interpretRecoveryResponse,
  isLikelyWindowsAbsolutePath,
  RECOVERY_ENDPOINT,
  PREFLIGHT_ENDPOINT,
  recoveryUserMessage,
  type RecoveryStatus,
} from "./local-recovery";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("interpretPreflightResponse", () => {
  it("parses 200 {status:'ok'} as ok (not misjudged as reconnect)", async () => {
    const state = await interpretPreflightResponse(jsonResponse({ status: "ok" }));
    expect(state).toBe("ok");
  });

  it("parses 200 {status:'reconnect_required'} as reconnect_required", async () => {
    const state = await interpretPreflightResponse(
      jsonResponse({ status: "reconnect_required", root: "C:\\secret", message: "x" })
    );
    expect(state).toBe("reconnect_required");
  });

  it("parses 503 {status:'unavailable'} as unavailable", async () => {
    const state = await interpretPreflightResponse(
      jsonResponse({ status: "unavailable" }, 503)
    );
    expect(state).toBe("unavailable");
  });

  it("treats unknown status as unavailable", async () => {
    const state = await interpretPreflightResponse(
      jsonResponse({ status: "weird" })
    );
    expect(state).toBe("unavailable");
  });

  it("treats invalid JSON as unavailable (no throw)", async () => {
    const broken = new Response("{not json", { status: 200 });
    const state = await interpretPreflightResponse(broken);
    expect(state).toBe("unavailable");
  });

  it("treats non-200 / non-503 as unavailable", async () => {
    const state = await interpretPreflightResponse(jsonResponse({ status: "ok" }, 500));
    expect(state).toBe("unavailable");
  });
});

describe("buildPreflightRequestInit", () => {
  it("sets no-store cache and same-origin credentials", () => {
    const init = buildPreflightRequestInit();
    expect(init.cache).toBe("no-store");
    expect(init.credentials).toBe("same-origin");
    expect(init.method ?? "GET").toBe("GET");
  });
});

describe("buildRecoveryRequestInit", () => {
  it("targets the recovery endpoint URL constant", () => {
    expect(PREFLIGHT_ENDPOINT).toBe("/api/local/preflight");
    expect(RECOVERY_ENDPOINT).toBe("/api/local/recovery/reconnect");
  });

  it("uses method POST", () => {
    const init = buildRecoveryRequestInit("C:\\data");
    expect(init.method).toBe("POST");
  });

  it("sets Content-Type to application/json", () => {
    const init = buildRecoveryRequestInit("C:\\data");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json"
    );
  });

  it("sets X-Formdigital-Recovery to 1", () => {
    const init = buildRecoveryRequestInit("C:\\data");
    expect((init.headers as Record<string, string>)["X-Formdigital-Recovery"]).toBe(
      "1"
    );
  });

  it("does not manually add Origin, Host, Forwarded, or token headers", () => {
    const init = buildRecoveryRequestInit("C:\\data");
    const keys = Object.keys(init.headers as Record<string, string>).map(k =>
      k.toLowerCase()
    );
    for (const forbidden of [
      "origin",
      "host",
      "forwarded",
      "x-forwarded-for",
      "x-forwarded-host",
      "x-forwarded-proto",
      "x-real-ip",
      "sec-fetch-site",
      "authorization",
      "token",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("sends only the trimmed dataFolder in the body", () => {
    const init = buildRecoveryRequestInit("  C:\\Users\\me\\LocalData  ");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["dataFolder"]);
    expect(body.dataFolder).toBe("C:\\Users\\me\\LocalData");
  });

  it("uses credentials same-origin", () => {
    const init = buildRecoveryRequestInit("C:\\data");
    expect(init.credentials).toBe("same-origin");
  });

  it("uses cache no-store", () => {
    const init = buildRecoveryRequestInit("C:\\data");
    expect(init.cache).toBe("no-store");
  });
});

describe("interpretRecoveryResponse", () => {
  const statuses: RecoveryStatus[] = [
    "reconnected",
    "not_required",
    "invalid_request",
    "reconnect_failed",
    "unavailable",
    "forbidden",
  ];
  const httpStatus: Record<RecoveryStatus, number> = {
    reconnected: 200,
    not_required: 409,
    invalid_request: 400,
    reconnect_failed: 400,
    unavailable: 503,
    forbidden: 403,
  };
  for (const status of statuses) {
    it(`maps {status:'${status}'} to ${status}`, async () => {
      const result = await interpretRecoveryResponse(
        jsonResponse({ status }, httpStatus[status])
      );
      expect(result).toBe(status);
    });
  }

  it("rejects a known status paired with the wrong HTTP status", async () => {
    expect(
      await interpretRecoveryResponse(
        jsonResponse({ status: "reconnected" }, 500)
      )
    ).toBe("reconnect_failed");
    expect(
      await interpretRecoveryResponse(jsonResponse({ status: "forbidden" }, 200))
    ).toBe("reconnect_failed");
  });

  it("falls back to reconnect_failed on unknown status", async () => {
    const result = await interpretRecoveryResponse(jsonResponse({ status: "nope" }));
    expect(result).toBe("reconnect_failed");
  });

  it("falls back to reconnect_failed on invalid JSON without throwing", async () => {
    const broken = new Response("{not json", { status: 400 });
    const result = await interpretRecoveryResponse(broken);
    expect(result).toBe("reconnect_failed");
  });
});

describe("recoveryUserMessage", () => {
  it("maps each status to safe Chinese copy", () => {
    expect(recoveryUserMessage("invalid_request")).toBe(
      "請輸入有效的 Windows 完整路徑。"
    );
    expect(recoveryUserMessage("reconnect_failed")).toBe(
      "無法驗證或重新連接該資料夾。請確認這是原有的 FormdigitalData，而且資料完整及有存取權限。"
    );
    expect(recoveryUserMessage("unavailable")).toBe(
      "本機資料服務目前無法連線，請確認服務已啟動後再試。"
    );
    expect(recoveryUserMessage("forbidden")).toBe(
      "安全檢查未通過。請只從本機 Formdigital 頁面執行重新連接。"
    );
    expect(recoveryUserMessage("network_error")).toBe(
      "重新連接失敗，請確認本機 Formdigital 服務仍在執行，然後重試。"
    );
  });

  it("returns empty copy for reconnected / not_required (UI re-checks preflight)", () => {
    expect(recoveryUserMessage("reconnected")).toBe("");
    expect(recoveryUserMessage("not_required")).toBe("");
  });

  it("never leaks path, token, or raw error into the message", () => {
    for (const status of [
      "invalid_request",
      "reconnect_failed",
      "unavailable",
      "forbidden",
      "network_error",
    ] as const) {
      const message = recoveryUserMessage(status);
      expect(message).not.toContain("C:\\");
      expect(message.toLowerCase()).not.toContain("token");
      expect(message).not.toContain("stack");
    }
  });
});

describe("isLikelyWindowsAbsolutePath", () => {
  it("accepts drive-letter and UNC paths", () => {
    expect(isLikelyWindowsAbsolutePath("C:\\Users\\me\\LocalData")).toBe(true);
    expect(isLikelyWindowsAbsolutePath("C:/Users/me/LocalData")).toBe(true);
    expect(isLikelyWindowsAbsolutePath("\\\\server\\share")).toBe(true);
    expect(isLikelyWindowsAbsolutePath("D:\\data")).toBe(true);
  });

  it("accepts trimmed value and bare drive root", () => {
    expect(isLikelyWindowsAbsolutePath("  C:\\data  ")).toBe(true);
    expect(isLikelyWindowsAbsolutePath("C:\\")).toBe(true);
  });

  it("rejects relative, too short, too long, NUL, and non-Windows paths", () => {
    expect(isLikelyWindowsAbsolutePath("relative/path")).toBe(false);
    expect(isLikelyWindowsAbsolutePath("C:")).toBe(false); // length 2
    expect(isLikelyWindowsAbsolutePath("/usr/local")).toBe(false);
    expect(isLikelyWindowsAbsolutePath("\\Users\\me")).toBe(false);
    expect(isLikelyWindowsAbsolutePath("C:\\a\0b")).toBe(false);
    expect(isLikelyWindowsAbsolutePath("C:\\" + "a".repeat(2000))).toBe(false);
  });
});
