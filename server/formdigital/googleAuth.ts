/**
 * 安全邊界：Google 授權碼只在伺服器交換，client secret 永不傳至瀏覽器；
 * state 與 HttpOnly session cookie 將回呼綁定到發起登入的瀏覽器及帳號 namespace。
 */
import { createHash, randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import { SignJWT, jwtVerify } from "jose";
import { getHostAccount, setHostAccount } from "./localServiceClient";

export type AuthenticatedUser = {
  id: string;
  openId: string;
  googleUserId: string | null;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  loginMethod: "google" | "local";
  role: "user" | "admin";
};

const GOOGLE_STATE_COOKIE = "fd_google_oauth_state";
export const GOOGLE_SESSION_COOKIE = "fd_google_session";
const googleAuthUrl = "https://accounts.google.com/o/oauth2/v2/auth";
const googleTokenUrl = "https://oauth2.googleapis.com/token";
const googleUserInfoUrl = "https://openidconnect.googleapis.com/v1/userinfo";

type GoogleAuthErrorCode =
  | "oauth_not_configured"
  | "oauth_origin_not_allowed"
  | "oauth_state_invalid"
  | "oauth_account_mismatch"
  | "oauth_token_exchange_failed"
  | "oauth_profile_failed"
  | "oauth_local_account_failed"
  | "oauth_session_failed"
  | "oauth_failed";

class GoogleAuthSetupError extends Error {
  constructor(readonly code: Extract<GoogleAuthErrorCode, "oauth_not_configured" | "oauth_origin_not_allowed">) {
    super(code);
  }
}

class GoogleAuthFlowError extends Error {
  constructor(
    readonly code: Extract<
      GoogleAuthErrorCode,
      | "oauth_token_exchange_failed"
      | "oauth_profile_failed"
      | "oauth_local_account_failed"
      | "oauth_session_failed"
    >
  ) {
    super(code);
  }
}

function redirectGoogleAuthError(response: Response, code: GoogleAuthErrorCode) {
  response.redirect(303, `/?authError=${code}`);
}

function canonicalOrigin(value: string) {
  return new URL(value).origin.toLowerCase();
}

export function isTrustedGoogleOAuthOrigin(
  requestOrigin: string,
  redirectUri: string,
  configuredOrigins = process.env.FORMDIGITAL_GOOGLE_OAUTH_ALLOWED_ORIGINS
) {
  try {
    const expectedOrigin = canonicalOrigin(redirectUri);
    const actualOrigin = canonicalOrigin(requestOrigin);
    const configured = configuredOrigins
      ?.split(",")
      .map(value => canonicalOrigin(value.trim()))
      .filter(Boolean) ?? [expectedOrigin];
    return actualOrigin === expectedOrigin && configured.includes(actualOrigin);
  } catch {
    return false;
  }
}

function requestOrigin(request: Request) {
  const host = request.get("host");
  if (!host) return "";
  const forwardedProtocol = request
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim();
  const protocol = forwardedProtocol || request.protocol;
  return `${protocol}://${host}`;
}

function isLocalRequest(request: Request) {
  try {
    const hostname = new URL(requestOrigin(request)).hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]" ||
      hostname === "::1"
    );
  } catch {
    return false;
  }
}

function requireGoogleConfig() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUris = (
    process.env.GOOGLE_OAUTH_REDIRECT_URIS ||
    process.env.GOOGLE_OAUTH_REDIRECT_URI ||
    ""
  )
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
  if (!clientId || !clientSecret || !redirectUris.length)
    throw new GoogleAuthSetupError("oauth_not_configured");
  return { clientId, clientSecret, redirectUris };
}

function callbackUriForRequest(request: Request, redirectUris: string[]) {
  const requested = `${requestOrigin(request)}/api/auth/google/callback`;
  const exact = redirectUris.find(value => {
    try {
      return new URL(value).toString() === new URL(requested).toString();
    } catch {
      return false;
    }
  });
  if (!exact) throw new GoogleAuthSetupError("oauth_origin_not_allowed");
  return exact;
}

function jwtSecret() {
  const raw = process.env.JWT_SECRET;
  if (!raw) throw new Error("JWT_SECRET 未設定。");
  return new TextEncoder().encode(raw);
}

function parseCookie(request: Request, name: string) {
  const cookies = request.headers.cookie?.split(";") ?? [];
  const found = cookies.find(part => part.trim().startsWith(`${name}=`));
  return found
    ? decodeURIComponent(found.trim().slice(name.length + 1))
    : undefined;
}

function secureCookieOptions(request: Request) {
  return {
    httpOnly: true,
    secure: !isLocalRequest(request),
    sameSite: "lax" as const,
    path: "/",
  };
}

export function clearGoogleSession(request: Request, response: Response) {
  response.clearCookie(GOOGLE_SESSION_COOKIE, secureCookieOptions(request));
}

function stateDigest(state: string) {
  return createHash("sha256").update(state).digest("hex");
}

export async function authenticateGoogleRequest(
  request: Request
): Promise<AuthenticatedUser | null> {
  const token = parseCookie(request, GOOGLE_SESSION_COOKIE);
  if (!token) return null;
  try {
    const verified = await jwtVerify(token, jwtSecret());
    const openId =
      typeof verified.payload.sub === "string" ? verified.payload.sub : null;
    if (!openId?.startsWith("google:")) return null;
    const googleUserId = openId.slice("google:".length);
    if (!isLocalRequest(request)) {
      const activeHost = await getHostAccount();
      if (!activeHost.googleUserId || activeHost.googleUserId !== googleUserId)
        return null;
    }
    return {
      id: googleUserId,
      openId,
      googleUserId,
      name:
        typeof verified.payload.name === "string"
          ? verified.payload.name
          : null,
      email:
        typeof verified.payload.email === "string"
          ? verified.payload.email
          : null,
      avatarUrl:
        typeof verified.payload.picture === "string"
          ? verified.payload.picture
          : null,
      loginMethod: "google",
      role: "user",
    };
  } catch {
    return null;
  }
}

export function registerGoogleAuthRoutes(app: Express) {
  app.get("/api/auth/google/start", (request: Request, response: Response) => {
    try {
      const { clientId, redirectUris } = requireGoogleConfig();
      const redirectUri = callbackUriForRequest(request, redirectUris);
      if (!isTrustedGoogleOAuthOrigin(requestOrigin(request), redirectUri)) {
        redirectGoogleAuthError(response, "oauth_origin_not_allowed");
        return;
      }
      const state = randomUUID();
      response.cookie(GOOGLE_STATE_COOKIE, stateDigest(state), {
        ...secureCookieOptions(request),
        maxAge: 10 * 60 * 1000,
      });
      const authorizationUrl = new URL(googleAuthUrl);
      authorizationUrl.searchParams.set("client_id", clientId);
      authorizationUrl.searchParams.set("redirect_uri", redirectUri);
      authorizationUrl.searchParams.set("response_type", "code");
      authorizationUrl.searchParams.set("scope", "openid email profile");
      authorizationUrl.searchParams.set("state", state);
      authorizationUrl.searchParams.set("prompt", "select_account");
      response.redirect(authorizationUrl.toString());
    } catch (error) {
      redirectGoogleAuthError(
        response,
        error instanceof GoogleAuthSetupError ? error.code : "oauth_failed"
      );
    }
  });

  app.get(
    "/api/auth/google/callback",
    async (request: Request, response: Response) => {
      const code =
        typeof request.query.code === "string" ? request.query.code : "";
      const state =
        typeof request.query.state === "string" ? request.query.state : "";
      const expectedStateDigest = parseCookie(request, GOOGLE_STATE_COOKIE);
      response.clearCookie(GOOGLE_STATE_COOKIE, secureCookieOptions(request));
      if (
        !code ||
        !state ||
        !expectedStateDigest ||
        stateDigest(state) !== expectedStateDigest
      ) {
        redirectGoogleAuthError(response, "oauth_state_invalid");
        return;
      }

      try {
        const { clientId, clientSecret, redirectUris } = requireGoogleConfig();
        const redirectUri = callbackUriForRequest(request, redirectUris);
        if (!isTrustedGoogleOAuthOrigin(requestOrigin(request), redirectUri)) {
          redirectGoogleAuthError(response, "oauth_origin_not_allowed");
          return;
        }
        const tokenBody = new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        });
        let token: { access_token?: string };
        try {
          const tokenResponse = await fetch(googleTokenUrl, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: tokenBody,
          });
          if (!tokenResponse.ok)
            throw new GoogleAuthFlowError("oauth_token_exchange_failed");
          token = (await tokenResponse.json()) as { access_token?: string };
          if (!token.access_token)
            throw new GoogleAuthFlowError("oauth_token_exchange_failed");
        } catch (error) {
          if (error instanceof GoogleAuthFlowError) throw error;
          throw new GoogleAuthFlowError("oauth_token_exchange_failed");
        }

        let profile: {
          sub?: string;
          email?: string;
          name?: string;
          picture?: string;
        };
        try {
          const profileResponse = await fetch(googleUserInfoUrl, {
            headers: { Authorization: `Bearer ${token.access_token}` },
          });
          if (!profileResponse.ok)
            throw new GoogleAuthFlowError("oauth_profile_failed");
          profile = (await profileResponse.json()) as typeof profile;
          if (!profile.sub)
            throw new GoogleAuthFlowError("oauth_profile_failed");
        } catch (error) {
          if (error instanceof GoogleAuthFlowError) throw error;
          throw new GoogleAuthFlowError("oauth_profile_failed");
        }
        if (isLocalRequest(request)) {
          try {
            await setHostAccount({
              googleUserId: profile.sub,
              email: profile.email ?? null,
            });
          } catch {
            throw new GoogleAuthFlowError("oauth_local_account_failed");
          }
        } else {
          let activeHost;
          try {
            activeHost = await getHostAccount();
          } catch {
            throw new GoogleAuthFlowError("oauth_local_account_failed");
          }
          if (
            !activeHost.googleUserId ||
            activeHost.googleUserId !== profile.sub
          ) {
            redirectGoogleAuthError(response, "oauth_account_mismatch");
            return;
          }
        }
        const openId = `google:${profile.sub}`;
        let session: string;
        try {
          session = await new SignJWT({
            provider: "google",
            name: profile.name ?? null,
            email: profile.email ?? null,
            picture: profile.picture ?? null,
          })
            .setProtectedHeader({ alg: "HS256" })
            .setSubject(openId)
            .setIssuedAt()
            .setExpirationTime(isLocalRequest(request) ? "14d" : "12h")
            .sign(jwtSecret());
        } catch {
          throw new GoogleAuthFlowError("oauth_session_failed");
        }
        const cookie = isLocalRequest(request)
          ? {
              ...secureCookieOptions(request),
              maxAge: 14 * 24 * 60 * 60 * 1000,
            }
          : secureCookieOptions(request);
        response.cookie(GOOGLE_SESSION_COOKIE, session, cookie);
        response.redirect(new URL("/", redirectUri).toString());
      } catch (error) {
        redirectGoogleAuthError(
          response,
          error instanceof GoogleAuthSetupError ||
            error instanceof GoogleAuthFlowError
            ? error.code
            : "oauth_failed"
        );
      }
    }
  );

  app.post(
    "/api/auth/google/logout",
    (request: Request, response: Response) => {
      clearGoogleSession(request, response);
      response.status(204).end();
    }
  );
}
