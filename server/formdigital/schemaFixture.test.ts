import { describe, expect, it } from "vitest";
import { createBackupArchive, verifyBackupArchive } from "./assetStore";
import { hashVersionSnapshot, sha256 } from "./domain";

const schemaV1Fixture = {
  schemaVersion: 1,
  templateId: "tpl_fixture_v1",
  pageManifest: [{ page: 1, widthMm: 210, heightMm: 297, assetId: "asset_fixture_v1" }],
  fieldSnapshot: [{ stableFieldId: "name", coordinate: { page: 1, xMm: 30, yMm: 40, widthMm: 80, heightMm: 7 } }],
  printSettings: { xOffsetMm: 0, yOffsetMm: 0, xScale: 100, yScale: 100 },
};

describe("schema version fixtures", () => {
  it("keeps the supported v1 Template Version fixture deterministic", () => {
    const firstHash = hashVersionSnapshot(schemaV1Fixture);
    const replayed = JSON.parse(JSON.stringify(schemaV1Fixture));
    expect(replayed.schemaVersion).toBe(1);
    expect(hashVersionSnapshot(replayed)).toBe(firstHash);
  });

  it("round-trips the supported v1 fixture through a verified backup manifest", () => {
    const record = new TextEncoder().encode(JSON.stringify([schemaV1Fixture]));
    const manifest = {
      format: "formdigital-backup" as const,
      schemaVersion: 1,
      createdAt: 0,
      ownerId: 1,
      records: { templateVersions: { path: "records/templateVersions.json", contentHash: sha256(record), count: 1 } },
      assets: [],
    };
    const archive = createBackupArchive(manifest, { templateVersions: [schemaV1Fixture] }, {});
    const verified = verifyBackupArchive(archive);
    expect(verified.schemaVersion).toBe(1);
    expect(record.byteLength).toBeGreaterThan(0);
  });
});
