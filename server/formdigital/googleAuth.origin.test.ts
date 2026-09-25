import { describe, expect, it } from "vitest";
import { isTrustedGoogleOAuthOrigin } from "./googleAuth";

describe("Google OAuth Local Host／Tunnel identity rule", () => {
  it("accepts localhost only when its exact callback origin is configured", () => {
    const redirect = "http://localhost:3000/api/auth/google/callback";
    expect(isTrustedGoogleOAuthOrigin("http://localhost:3000", redirect)).toBe(
      true
    );
    expect(isTrustedGoogleOAuthOrigin("http://127.0.0.1:3000", redirect)).toBe(
      false
    );
    expect(isTrustedGoogleOAuthOrigin("http://localhost:3001", redirect)).toBe(
      false
    );
  });

  it("accepts an explicit HTTPS tunnel without trusting lookalikes", () => {
    const redirect = "https://forms.example.test/api/auth/google/callback";
    const allowed = "http://localhost:3000,https://forms.example.test";
    expect(
      isTrustedGoogleOAuthOrigin(
        "https://forms.example.test/any-path",
        redirect,
        allowed
      )
    ).toBe(true);
    expect(
      isTrustedGoogleOAuthOrigin(
        "https://forms.example.test.evil.invalid",
        redirect,
        allowed
      )
    ).toBe(false);
    expect(
      isTrustedGoogleOAuthOrigin("http://forms.example.test", redirect, allowed)
    ).toBe(false);
  });

  it("rejects malformed origins and callbacks", () => {
    expect(
      isTrustedGoogleOAuthOrigin(
        "not-a-url",
        "http://localhost:3000/api/auth/google/callback"
      )
    ).toBe(false);
    expect(
      isTrustedGoogleOAuthOrigin("http://localhost:3000", "not-a-url")
    ).toBe(false);
  });
});
