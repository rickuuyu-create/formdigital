import { describe, expect, it } from "vitest";

import {
  CURRENT_WORKSPACE_SCHEMA_VERSION,
  normalizeWorkspace,
} from "./workspaceStore";

describe("workspace schema compatibility", () => {
  it("migrates an older workspace to the current schema with safe defaults", () => {
    const normalized = normalizeWorkspace("owner-test", {
      schemaVersion: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      templates: [],
    });

    expect(normalized.schemaVersion).toBe(CURRENT_WORKSPACE_SCHEMA_VERSION);
    expect(normalized.ownerKey).toBe("owner-test");
    expect(normalized.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(normalized.instances).toEqual([]);
    expect(normalized.importRows).toEqual([]);
  });

  it("fails closed instead of silently downgrading a future workspace", () => {
    expect(() =>
      normalizeWorkspace("owner-test", {
        schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION + 1,
      })
    ).toThrowError("UNSUPPORTED_WORKSPACE_SCHEMA");
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an invalid schema version (%s)",
    schemaVersion => {
      expect(() =>
        normalizeWorkspace("owner-test", { schemaVersion })
      ).toThrowError("UNSUPPORTED_WORKSPACE_SCHEMA");
    }
  );
});
