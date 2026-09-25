/**
 * Layer 1B — Pure, dependency-free security checks for the unauthenticated
 * local-only recovery reconnect endpoint.
 *
 * Every function here is a pure predicate so it can be exhaustively
 * table-driven in unit tests without standing up an Express server or
 * touching the real Local Data Service / secret config file.
 *
 * Design invariants (per the approved Layer 1B instruction):
 *  - We ONLY ever trust the raw socket remote address, never X-Forwarded-*.
 *  - localhost / 127.0.0.1 / [::1] are NOT interchangeable as origins.
 *  - No folder contents, hashes, tokens, or error text ever leave this module.
 */

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

const ALLOWED_HOST_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

const FORWARDED_HEADER_KEYS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
];

export interface ParsedHost {
  hostname: string;
  port: string | null;
}

/** True only for a real loopback socket address. Never trusts proxy headers. */
export function isLoopbackAddress(remoteAddress: string | null | undefined): boolean {
  if (!remoteAddress) return false;
  return LOOPBACK_ADDRESSES.has(remoteAddress);
}

/** True if any proxy / tunnel header is present, even with an empty value. */
export function hasForwardedHeader(
  headers: Record<string, string | undefined>
): boolean {
  return FORWARDED_HEADER_KEYS.some(key =>
    Object.prototype.hasOwnProperty.call(headers, key)
  );
}

function isValidPort(port: string): boolean {
  if (!/^\d+$/.test(port)) return false;
  const numeric = Number(port);
  return numeric >= 1 && numeric <= 65_535;
}

/**
 * Parses a Host header into hostname + port. Handles bracketed IPv6 like
 * "[::1]:3000". Returns null for malformed input so callers can reject safely.
 */
export function parseHostHeader(host: string | undefined): ParsedHost | null {
  if (typeof host !== "string") return null;
  const trimmed = host.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith("[")) {
    const close = trimmed.indexOf("]");
    if (close === -1) return null;
    const hostname = trimmed.slice(0, close + 1).toLowerCase();
    const rest = trimmed.slice(close + 1);
    if (rest.length === 0) return { hostname, port: null };
    if (!rest.startsWith(":")) return null;
    const port = rest.slice(1);
    if (!isValidPort(port)) return null;
    return { hostname, port };
  }
  const idx = trimmed.lastIndexOf(":");
  if (idx === -1) return { hostname: trimmed.toLowerCase(), port: null };
  const hostname = trimmed.slice(0, idx).toLowerCase();
  const port = trimmed.slice(idx + 1);
  if (hostname.length === 0 || hostname.includes(":") || !isValidPort(port))
    return null;
  return { hostname, port };
}

/** True only when the Host hostname is exactly localhost / 127.0.0.1 / [::1]. */
export function isLocalHostHeader(host: string | undefined): boolean {
  const parsed = parseHostHeader(host);
  if (!parsed) return false;
  return ALLOWED_HOST_HOSTNAMES.has(parsed.hostname);
}

/**
 * True only when the Origin header is present, not the literal "null", and
 * exactly equals the expected same-origin value. localhost / 127.0.0.1 / [::1]
 * are intentionally NOT interchangeable — exact string equality enforces this.
 */
export function isSameOrigin(
  origin: string | undefined,
  expectedOrigin: string
): boolean {
  if (typeof origin !== "string" || origin.length === 0) return false;
  if (origin === "null") return false;
  return origin === expectedOrigin;
}

/** True only for an application/json content type (case-insensitive). */
export function isJsonContentType(contentType: string | undefined): boolean {
  if (typeof contentType !== "string") return false;
  return contentType.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

/** True only when the custom recovery header "X-Formdigital-Recovery: 1" is present. */
export function hasRecoveryHeader(
  headers: Record<string, string | undefined>
): boolean {
  const value = headers["x-formdigital-recovery"];
  return typeof value === "string" && value.trim() === "1";
}

/**
 * Sec-Fetch-Site is optional, but when present it must be "same-origin".
 * Browsers send this automatically for same-origin requests.
 */
export function isSecFetchSiteAllowed(
  headers: Record<string, string | undefined>
): boolean {
  const value = headers["sec-fetch-site"];
  if (value === undefined || value === null) return true;
  return value.trim().toLowerCase() === "same-origin";
}

export interface DataFolderValidation {
  ok: boolean;
  value?: string;
}

/**
 * Validates the reconnect target path: must be a string, 3..1024 chars after
 * trim, no NUL character, and a Windows absolute path (drive or UNC). It does
 * NOT inspect folder contents or re-implement the Local Data Service validator.
 */
export function validateDataFolderInput(raw: unknown): DataFolderValidation {
  if (typeof raw !== "string") return { ok: false };
  const trimmed = raw.trim();
  if (trimmed.length < 3 || trimmed.length > 1024) return { ok: false };
  if (trimmed.includes("\0")) return { ok: false };
  if (!isWindowsAbsolutePath(trimmed)) return { ok: false };
  return { ok: true, value: trimmed };
}

function isWindowsAbsolutePath(p: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(p)) return true; // C:\ or C:/
  if (/^\\\\[^\\]/.test(p)) return true; // \\server\share (UNC)
  return false;
}
