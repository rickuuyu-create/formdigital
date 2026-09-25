import type { Request } from "express";
import { authenticateGoogleRequest, type AuthenticatedUser } from "./googleAuth";
import {
  hasForwardedHeader,
  isLocalHostHeader,
  isLoopbackAddress,
  parseHostHeader,
} from "./localRecoverySecurity";

export function isLocalOnlyMode() {
  return process.env.FORMDIGITAL_LOCAL_ONLY === "1";
}

/** Stable owner namespace for one offline Windows profile, never a Google account. */
export const LOCAL_OWNER_ID = "local-owner";

export async function authenticateAppRequest(request: Request): Promise<AuthenticatedUser | null> {
  if (!isLocalOnlyMode()) return authenticateGoogleRequest(request);
  if (!isLoopbackAddress(request.socket.remoteAddress) || !isLocalHostHeader(request.headers.host))
    return null;
  return {
    id: LOCAL_OWNER_ID,
    openId: "local:owner",
    googleUserId: null,
    name: "本機工作區",
    email: null,
    avatarUrl: null,
    loginMethod: "local",
    role: "user",
  };
}

type LocalRequest = {
  remoteAddress: string | undefined;
  host: string | undefined;
  port: number;
  method: string;
  headers: Record<string, string | undefined>;
};

/** Prevent browser cross-site requests and DNS rebinding in the no-login edition. */
export function localOnlyRequestAllowed(input: LocalRequest): boolean {
  if (!isLoopbackAddress(input.remoteAddress) || !isLocalHostHeader(input.host)) return false;
  if (parseHostHeader(input.host)?.port !== String(input.port)) return false;
  if (hasForwardedHeader(input.headers)) return false;
  const site = input.headers["sec-fetch-site"]?.toLowerCase();
  if (site && site !== "same-origin" && site !== "none") return false;
  const expectedOrigin = `http://${input.host}`;
  const origin = input.headers.origin;
  if (origin && origin !== expectedOrigin) return false;
  if (!/^(GET|HEAD|OPTIONS)$/i.test(input.method) && origin !== expectedOrigin)
    return false;
  return true;
}
