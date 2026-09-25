/** 長期資料契約提醒：雜湊與版本狀態是備份、migration 與輸出可重現性的底線。 */
import { describe, expect, it } from "vitest";
import {
  canonicalizeJson,
  createStableId,
  deriveStorageKey,
  hashVersionSnapshot,
  requireVersionTransition,
  sha256,
} from "./domain";

describe("formdigital domain contract", () => {
  it("canonicalizes object keys before hashing", () => {
    const left = { b: "second", a: [2, { z: true, y: null }] };
    const right = { a: [2, { y: null, z: true }], b: "second" };
    expect(canonicalizeJson(left)).toBe(canonicalizeJson(right));
    expect(sha256(left)).toBe(sha256(right));
  });

  it("keeps version snapshots reproducible", () => {
    const snapshot = {
      schemaVersion: 1,
      templateId: "tpl_01",
      pageManifest: [{ page: 1, widthMm: 210, heightMm: 297 }],
      fieldSnapshot: [{ id: "student-name", page: 1, xMm: 10, yMm: 20 }],
      printSettings: { xOffsetMm: 0, yOffsetMm: 0 },
    };
    expect(hashVersionSnapshot(snapshot)).toHaveLength(64);
    expect(hashVersionSnapshot(snapshot)).toBe(hashVersionSnapshot({ ...snapshot }));
  });

  it("never permits a published version to become a draft", () => {
    expect(() => requireVersionTransition("published", "draft")).toThrow("Invalid Template Version transition");
    expect(() => requireVersionTransition("draft", "published")).not.toThrow();
  });

  it("derives owner-isolated storage keys without using original filenames", () => {
    const hash = sha256("original bytes");
    expect(deriveStorageKey(42, "source", hash)).toBe(`formdigital/accounts/42/assets/source/${hash}`);
  });

  it("generates namespaced non-reusable IDs", () => {
    const first = createStableId("tpl");
    const second = createStableId("tpl");
    expect(first).toMatch(/^tpl_[a-f0-9]{32}$/);
    expect(first).not.toBe(second);
  });
});
