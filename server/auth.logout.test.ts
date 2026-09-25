import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import { GOOGLE_SESSION_COOKIE } from "./formdigital/googleAuth";
import type { TrpcContext } from "./_core/context";

describe("auth.logout", () => {
  it("clears the local Google session cookie with host-safe options", async () => {
    const cleared: Array<{ name: string; options: Record<string, unknown> }> =
      [];
    const ctx = {
      user: {
        id: "google-user-1",
        openId: "google:google-user-1",
        googleUserId: "google-user-1",
        email: "sample@example.com",
        name: "Sample User",
        avatarUrl: null,
        loginMethod: "google",
        role: "user",
      },
      req: {
        protocol: "http",
        headers: { host: "localhost:3000" },
        get(name: string) {
          return name.toLowerCase() === "host" ? "localhost:3000" : undefined;
        },
      },
      res: {
        clearCookie(name: string, options: Record<string, unknown>) {
          cleared.push({ name, options });
        },
      },
    } as unknown as TrpcContext;

    await expect(appRouter.createCaller(ctx).auth.logout()).resolves.toEqual({
      success: true,
    });
    expect(cleared).toEqual([
      {
        name: GOOGLE_SESSION_COOKIE,
        options: { httpOnly: true, secure: false, sameSite: "lax", path: "/" },
      },
    ]);
  });
});
