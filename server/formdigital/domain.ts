/**
 * 長期資料契約提醒：這裡的函式不得依賴 UI 狀態、欄位顯示順序或檔名；
 * canonical JSON 和 stable hash 讓版本、備份與輸出可以被可重複地驗證。
 */
import { createHash, randomUUID } from "node:crypto";

export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };

export type VersionState = "draft" | "published" | "superseded";

function ensureFinite(value: number): number {
  if (!Number.isFinite(value)) throw new Error("Non-finite numbers are not valid canonical JSON");
  return Object.is(value, -0) ? 0 : value;
}

export function canonicalizeJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return JSON.stringify(ensureFinite(value));
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(",")} ]`.replace(", ]", "]");

  const record = value as { [key: string]: JsonValue };
  const entries = Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key]!)}`);
  return `{${entries.join(",")}}`;
}

export function sha256(value: JsonValue | string | Uint8Array): string {
  const source = typeof value === "string" || value instanceof Uint8Array ? value : canonicalizeJson(value);
  return createHash("sha256").update(source).digest("hex");
}

export function createStableId(prefix: string): string {
  if (!/^[a-z][a-z0-9-]{1,15}$/i.test(prefix)) throw new Error("Stable ID prefix is invalid");
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

export function deriveStorageKey(ownerId: number, kind: string, contentHash: string): string {
  if (!Number.isSafeInteger(ownerId) || ownerId < 1) throw new Error("ownerId must be a positive integer");
  if (!/^[a-z0-9-]{2,48}$/i.test(kind)) throw new Error("Asset kind is invalid");
  if (!/^[a-f0-9]{64}$/i.test(contentHash)) throw new Error("contentHash must be SHA-256");
  return `formdigital/accounts/${ownerId}/assets/${kind}/${contentHash}`;
}

export function canTransitionVersion(from: VersionState, to: VersionState): boolean {
  return (from === "draft" && (to === "published" || to === "superseded")) ||
    (from === "published" && to === "superseded") || from === to;
}

export function requireVersionTransition(from: VersionState, to: VersionState): void {
  if (!canTransitionVersion(from, to)) throw new Error(`Invalid Template Version transition: ${from} → ${to}`);
}

export interface SnapshotEnvelope {
  schemaVersion: number;
  templateId: string;
  pageManifest: JsonValue;
  fieldSnapshot: JsonValue;
  printSettings: JsonValue;
}

export function hashVersionSnapshot(snapshot: SnapshotEnvelope): string {
  if (!Number.isInteger(snapshot.schemaVersion) || snapshot.schemaVersion < 1) throw new Error("schemaVersion must be a positive integer");
  if (!snapshot.templateId) throw new Error("templateId is required");
  return sha256(snapshot as unknown as JsonValue);
}
