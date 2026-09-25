/** Optional deployment probe. Unit tests remain offline when credentials are absent. */
import { describe, expect, it } from "vitest";

const configured = Boolean(
  process.env.GOOGLE_OAUTH_CLIENT_ID &&
    process.env.GOOGLE_OAUTH_CLIENT_SECRET &&
    (process.env.GOOGLE_OAUTH_REDIRECT_URIS ||
      process.env.GOOGLE_OAUTH_REDIRECT_URI)
);

describe("Google OAuth deployment credentials", () => {
  it.skipIf(!configured)(
    "are accepted by Google's token endpoint",
    async () => {
      const redirectUri = (process.env.GOOGLE_OAUTH_REDIRECT_URIS ||
        process.env.GOOGLE_OAUTH_REDIRECT_URI)!
        .split(",")[0]!
        .trim();
      const body = new URLSearchParams({
        client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
        client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET!,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        code: "formdigital-credential-validation-probe",
      });
      const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      const payload = (await response.json()) as { error?: string };
      expect(payload.error).toBe("invalid_grant");
    },
    15_000
  );
});
