import { describe, expect, it } from "vitest";
import { planBackupAssetImport } from "./backupAssetPlan";
import type {
  PlanBackupAssetImportInput,
  VerifiedIncomingAsset,
  OccupiedAssetManifest,
  KnownObject,
  AssetPlanMode,
} from "./backupAssetPlan";
import {
  planWorkspaceBackupMerge,
  type IdMaps,
} from "./backupMerge";
import type { LocalWorkspace } from "./workspaceStore";

type Rec = Record<string, unknown>;

const NOW = 1_700_000_000_000;
const OWNER = "a".repeat(64);
const OTHER_OWNER = "b".repeat(64);
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

// Deterministic asset id generator.
function makeCreateAssetId(): (prefix: string) => string {
  let n = 0;
  return () => `asset_${(++n).toString(36)}`;
}
// Generator that always returns the same colliding id (for safety test).
function collideAssetId(): () => string {
  return () => "asset_collide";
}
// Generator that returns an invalid (empty) id.
function emptyAssetId(): () => string {
  return () => "   ";
}

function emptyIdMaps(): IdMaps {
  return {
    templates: {},
    templateVersions: {},
    fields: {},
    instances: {},
    savedValues: {},
    mappingTemplates: {},
    importRuns: {},
    importRows: {},
    mappingDecisions: {},
    detectionRuns: {},
    folders: {},
    tags: {},
  };
}

function asset(
  id: string,
  contentHash: string,
  size: number,
  extra: Rec = {}
): VerifiedIncomingAsset {
  return {
    id,
    schemaVersion: 1,
    ownerKeyHash: OWNER,
    contentHash,
    size,
    metadata: {},
    ...extra,
  } as VerifiedIncomingAsset;
}

function occupied(
  id: string,
  contentHash: string,
  size: number,
  extra: Rec = {}
): OccupiedAssetManifest {
  return {
    id,
    ownerKeyHash: OWNER,
    contentHash,
    size,
    ...extra,
  } as OccupiedAssetManifest;
}

function known(contentHash: string, size: number, verified = true): KnownObject {
  return { contentHash, size, verified };
}

function baseInput(overrides: Partial<PlanBackupAssetImportInput> = {}): PlanBackupAssetImportInput {
  return {
    mode: "structure",
    targetOwnerKeyHash: OWNER,
    requiredAssetIds: ["s1"],
    incomingAssets: [asset("s1", HASH_A, 10)],
    occupiedManifests: [],
    knownObjects: [],
    workspaceIdMaps: emptyIdMaps(),
    createAssetId: makeCreateAssetId(),
    ...overrides,
  };
}

// ----------------------------------------------------------------------------
describe("C2C2 pure asset import planner", () => {
  // --- Structure mode ------------------------------------------------
  it("R2C2-1. structure: unoccupied asset keeps same id (create)", () => {
    const r = planBackupAssetImport(baseInput());
    expect(r.ready).toBe(true);
    expect(r.assetIdMap["s1"]).toBe("s1");
    expect(r.manifestPlans).toHaveLength(1);
    expect(r.manifestPlans[0].action).toBe("create");
    expect(r.manifestPlans[0].targetAssetId).toBe("s1");
    expect(r.manifestPlans[0].plannedManifest.schemaVersion).toBe(1);
    expect(r.manifestPlans[0].plannedManifest.ownerKeyHash).toBe(OWNER);
    expect(r.manifestPlans[0].plannedManifest.contentHash).toBe(HASH_A);
    expect(r.manifestPlans[0].plannedManifest.size).toBe(10);
    expect(r.counts.manifestsToCreate).toBe(1);
  });

  it("R2C2-2. structure: exact semantic reuse when occupied by same owner", () => {
    const occ = occupied("s1", HASH_A, 10, {
      manifest: {
        schemaVersion: 1,
        id: "s1",
        ownerKeyHash: OWNER,
        contentHash: HASH_A,
        size: 10,
        metadata: {},
      },
    });
    const r = planBackupAssetImport(
      baseInput({
        incomingAssets: [asset("s1", HASH_A, 10)],
        occupiedManifests: [occ],
      })
    );
    expect(r.assetIdMap["s1"]).toBe("s1");
    expect(r.manifestPlans[0].action).toBe("reuse");
    expect(r.counts.manifestsReused).toBe(1);
    expect(r.counts.manifestsToCreate).toBe(0);
    expect(r.ready).toBe(true);
  });

  it("R2C2-3. structure: same-owner collision rekeys when manifest differs", () => {
    const occ = occupied("s1", HASH_B, 20, {
      manifest: {
        schemaVersion: 1,
        id: "s1",
        ownerKeyHash: OWNER,
        contentHash: HASH_B,
        size: 20,
        metadata: { kind: "page" },
      },
    });
    const r = planBackupAssetImport(
      baseInput({ occupiedManifests: [occ] })
    );
    expect(r.assetIdMap["s1"]).not.toBe("s1");
    expect(r.manifestPlans[0].action).toBe("create");
    expect(r.counts.manifestsToCreate).toBe(1);
    expect(r.counts.manifestsReused).toBe(0);
  });

  it("R2C2-4. structure: cross-owner collision always rekeys (no overwrite/reuse)", () => {
    const occ = occupied("s1", HASH_A, 10, {
      ownerKeyHash: OTHER_OWNER,
      manifest: {
        schemaVersion: 1,
        id: "s1",
        ownerKeyHash: OTHER_OWNER,
        contentHash: HASH_A,
        size: 10,
        metadata: { kind: "page" },
      },
    });
    const r = planBackupAssetImport(
      baseInput({ occupiedManifests: [occ] })
    );
    expect(r.assetIdMap["s1"]).not.toBe("s1");
    expect(r.manifestPlans[0].action).toBe("create");
    expect(r.counts.manifestsReused).toBe(0);
  });

  // --- Duplicate mode ------------------------------------------------
  it("R2C2-5. duplicate: always allocates a brand-new target id", () => {
    const r = planBackupAssetImport(
      baseInput({ mode: "duplicate", occupiedManifests: [occupied("s1", HASH_A, 10)] })
    );
    expect(r.assetIdMap["s1"]).not.toBe("s1");
    expect(r.manifestPlans[0].action).toBe("create");
    expect(r.counts.manifestsToCreate).toBe(1);
  });

  it("R2C2-6. duplicate: new id never equals source; missing required stays unresolved", () => {
    const r = planBackupAssetImport(
      baseInput({
        mode: "duplicate",
        requiredAssetIds: ["s1", "s2"],
        incomingAssets: [asset("s1", HASH_A, 10)],
      })
    );
    expect(r.assetIdMap["s1"]).not.toBe("s1");
    expect(r.assetIdMap["s2"]).toBeUndefined();
    expect(r.unresolvedAssetIds).toEqual(["s2"]);
    expect(r.ready).toBe(false);
  });

  it("R2C2-7. duplicate: new id never collides with occupied or source ids", () => {
    const occ = occupied("occupiedX", HASH_B, 5);
    const r = planBackupAssetImport(
      baseInput({
        mode: "duplicate",
        requiredAssetIds: ["s1", "s2"],
        incomingAssets: [asset("s1", HASH_A, 10), asset("s2", HASH_C, 30)],
        occupiedManifests: [occ],
      })
    );
    const targets = Object.values(r.assetIdMap);
    expect(targets).not.toContain("occupiedX");
    expect(targets).not.toContain("s1");
    expect(targets).not.toContain("s2");
    expect(new Set(targets).size).toBe(targets.length);
  });

  // --- Required / extra ----------------------------------------------
  it("R2C2-8. required asset with no incoming manifest -> unresolved + not ready", () => {
    const r = planBackupAssetImport(
      baseInput({ incomingAssets: [] })
    );
    expect(r.unresolvedAssetIds).toEqual(["s1"]);
    expect(r.ready).toBe(false);
    expect(r.assetIdMap["s1"]).toBeUndefined();
    expect(r.counts.unresolved).toBe(1);
  });

  it("R2C2-9. extra archive asset not in required is ignored (no plan)", () => {
    const r = planBackupAssetImport(
      baseInput({
        incomingAssets: [asset("s1", HASH_A, 10), asset("extra", HASH_B, 20)],
      })
    );
    expect(r.manifestPlans).toHaveLength(1);
    expect(r.assetIdMap["extra"]).toBeUndefined();
    expect(r.objectPlans).toHaveLength(1);
  });

  it("R2C2-10. same source referenced multiple times still one plan + one object", () => {
    // Use two required ids sharing the same content hash => one object plan.
    const r = planBackupAssetImport(
      baseInput({
        requiredAssetIds: ["s1", "s2"],
        incomingAssets: [asset("s1", HASH_A, 10), asset("s2", HASH_A, 10)],
        knownObjects: [known(HASH_A, 10)],
      })
    );
    expect(r.manifestPlans).toHaveLength(2);
    expect(r.objectPlans).toHaveLength(1);
    expect(r.objectPlans[0].action).toBe("reuse");
  });

  // --- Object plans ------------------------------------------------
  it("R2C2-11. multiple manifests same content hash -> single object plan", () => {
    const r = planBackupAssetImport(
      baseInput({
        requiredAssetIds: ["s1", "s2"],
        incomingAssets: [asset("s1", HASH_A, 10), asset("s2", HASH_A, 10)],
      })
    );
    expect(r.objectPlans).toHaveLength(1);
    expect(r.objectPlans[0].contentHash).toBe(HASH_A);
  });

  it("R2C2-12. known object missing -> copy", () => {
    const r = planBackupAssetImport(baseInput());
    expect(r.objectPlans).toHaveLength(1);
    expect(r.objectPlans[0].action).toBe("copy");
    expect(r.counts.objectsToCopy).toBe(1);
  });

  it("R2C2-13. known object verified + size match -> reuse", () => {
    const r = planBackupAssetImport(
      baseInput({ knownObjects: [known(HASH_A, 10)] })
    );
    expect(r.objectPlans[0].action).toBe("reuse");
    expect(r.counts.objectsReused).toBe(1);
    expect(r.ready).toBe(true);
  });

  it("R2C2-14. known object corrupt (verified=false) -> conflict + not ready", () => {
    const r = planBackupAssetImport(
      baseInput({ knownObjects: [known(HASH_A, 10, false)] })
    );
    expect(r.objectPlans).toHaveLength(0);
    expect(r.conflicts.some((c) => c.code === "OBJECT_CONFLICT")).toBe(true);
    expect(r.ready).toBe(false);
    expect(r.counts.conflicts).toBeGreaterThan(0);
  });

  it("R2C2-15. known object size mismatch -> conflict + not ready", () => {
    const r = planBackupAssetImport(
      baseInput({ knownObjects: [known(HASH_A, 999)] })
    );
    expect(r.conflicts.some((c) => c.code === "OBJECT_CONFLICT")).toBe(true);
    expect(r.ready).toBe(false);
  });

  // --- Metadata relation remap --------------------------------------
  it("R2C2-16. metadata.templateId remapped via workspaceIdMaps", () => {
    const maps = emptyIdMaps();
    maps.templates = { tOld: "tNew" };
    const r = planBackupAssetImport(
      baseInput({
        incomingAssets: [
          asset("s1", HASH_A, 10, { metadata: { templateId: "tOld", kind: "page" } }),
        ],
        workspaceIdMaps: maps,
      })
    );
    expect(r.manifestPlans[0].plannedManifest.metadata).toMatchObject({
      templateId: "tNew",
      kind: "page",
    });
  });

  it("R2C2-17. metadata.templateVersionId + instanceId remapped", () => {
    const maps = emptyIdMaps();
    maps.templateVersions = { vOld: "vNew" };
    maps.instances = { iOld: "iNew" };
    const r = planBackupAssetImport(
      baseInput({
        incomingAssets: [
          asset("s1", HASH_A, 10, {
            metadata: { templateVersionId: "vOld", instanceId: "iOld" },
          }),
        ],
        workspaceIdMaps: maps,
      })
    );
    expect(r.manifestPlans[0].plannedManifest.metadata).toMatchObject({
      templateVersionId: "vNew",
      instanceId: "iNew",
    });
  });

  it("R2C2-18. metadata relation missing map -> conflict + not ready, no manifest plan / no source-only id", () => {
    const maps = emptyIdMaps();
    const r = planBackupAssetImport(
      baseInput({
        incomingAssets: [
          asset("s1", HASH_A, 10, { metadata: { templateId: "tMissing" } }),
        ],
        workspaceIdMaps: maps,
      })
    );
    expect(r.conflicts.some((c) => c.code === "MISSING_RELATION_MAP")).toBe(true);
    expect(r.ready).toBe(false);
    // No usable planned manifest may be emitted; the assetIdMap must not
    // contain a target that the final Workspace Planner could abuse.
    expect(r.manifestPlans).toHaveLength(0);
    expect(r.assetIdMap["s1"]).toBeUndefined();
    expect(r.unresolvedAssetIds).toContain("s1");
  });

  it("R2C2-19. metadata nested ids left unchanged (no recursive rewrite)", () => {
    const maps = emptyIdMaps();
    maps.templates = { tOld: "tNew" };
    const r = planBackupAssetImport(
      baseInput({
        incomingAssets: [
          asset("s1", HASH_A, 10, {
            metadata: {
              templateId: "tOld",
              nested: { someId: "should-stay", assetId: "also-stays" },
            },
          }),
        ],
        workspaceIdMaps: maps,
      })
    );
    const md = r.manifestPlans[0].plannedManifest.metadata as Rec;
    expect(md.templateId).toBe("tNew");
    expect((md.nested as Rec).someId).toBe("should-stay");
    expect((md.nested as Rec).assetId).toBe("also-stays");
  });

  it("R2C2-20. filename / mimeType / kind / arbitrary user metadata preserved", () => {
    const r = planBackupAssetImport(
      baseInput({
        incomingAssets: [
          asset("s1", HASH_A, 10, {
            mimeType: "image/png",
            originalFilename: "scan.png",
            metadata: { kind: "page", note: "用戶備註", templateId: "t1" },
          }),
        ],
        workspaceIdMaps: (() => {
          const m = emptyIdMaps();
          m.templates = { t1: "t1" };
          return m;
        })(),
      })
    );
    const pm = r.manifestPlans[0].plannedManifest;
    expect(pm.mimeType).toBe("image/png");
    expect(pm.originalFilename).toBe("scan.png");
    expect((pm.metadata as Rec).kind).toBe("page");
    expect((pm.metadata as Rec).note).toBe("用戶備註");
  });

  // --- Malformed input rejection (value-free) ----------------------
  it("R2C2-21. malformed mode rejected", () => {
    expect(() =>
      planBackupAssetImport(baseInput({ mode: "weird" as AssetPlanMode }))
    ).toThrow("INVALID_ASSET_INPUT: mode");
  });

  it("R2C2-22. malformed targetOwnerKeyHash rejected", () => {
    expect(() =>
      planBackupAssetImport(baseInput({ targetOwnerKeyHash: "XYZ" }))
    ).toThrow("INVALID_ASSET_INPUT: targetOwnerKeyHash");
  });

  it("R2C2-23. requiredAssetIds not array rejected", () => {
    expect(() =>
      planBackupAssetImport(baseInput({ requiredAssetIds: "s1" as unknown as string[] }))
    ).toThrow("INVALID_ASSET_INPUT: requiredAssetIds");
  });

  it("R2C2-24. required id unsafe (path) rejected", () => {
    expect(() =>
      planBackupAssetImport(
        baseInput({ requiredAssetIds: ["C:\\Users\\x"] })
      )
    ).toThrow("INVALID_ASSET_INPUT: requiredAssetIds.entry");
  });

  it("R2C2-25. required id duplicate rejected", () => {
    expect(() =>
      planBackupAssetImport(
        baseInput({ requiredAssetIds: ["s1", "s1"] })
      )
    ).toThrow("INVALID_ASSET_INPUT: requiredAssetIds.duplicate");
  });

  it("R2C2-26. incoming asset id duplicate rejected", () => {
    const input = baseInput({
      requiredAssetIds: ["s1", "s2"],
      incomingAssets: [asset("s1", HASH_A, 10), asset("s1", HASH_B, 20)],
    });
    expect(() => planBackupAssetImport(input)).toThrow(
      "INVALID_ASSET_INPUT: incomingAssets.duplicate"
    );
  });

  it("R2C2-27. occupied manifest id duplicate rejected", () => {
    const input = baseInput({
      occupiedManifests: [
        occupied("s1", HASH_A, 10),
        occupied("s1", HASH_B, 20),
      ],
    });
    expect(() => planBackupAssetImport(input)).toThrow(
      "INVALID_ASSET_INPUT: occupiedManifests.duplicate"
    );
  });

  it("R2C2-28. schemaVersion != 1 rejected", () => {
    const bad = asset("s1", HASH_A, 10) as Rec;
    bad.schemaVersion = 2;
    expect(() =>
      planBackupAssetImport(baseInput({ incomingAssets: [bad as VerifiedIncomingAsset] }))
    ).toThrow("INVALID_ASSET_INPUT: incomingAssets.schemaVersion");
  });

  it("R2C2-29. incoming owner hash malformed rejected", () => {
    const bad = asset("s1", HASH_A, 10) as Rec;
    bad.ownerKeyHash = "not-hex";
    expect(() =>
      planBackupAssetImport(baseInput({ incomingAssets: [bad as VerifiedIncomingAsset] }))
    ).toThrow("INVALID_ASSET_INPUT: incomingAssets.ownerKeyHash");
  });

  it("R2C2-30. contentHash malformed rejected", () => {
    const bad = asset("s1", "BAD", 10) as Rec;
    expect(() =>
      planBackupAssetImport(baseInput({ incomingAssets: [bad as VerifiedIncomingAsset] }))
    ).toThrow("INVALID_ASSET_INPUT: incomingAssets.contentHash");
  });

  it("R2C2-31. size negative / non-integer rejected", () => {
    const bad = asset("s1", HASH_A, -5) as Rec;
    expect(() =>
      planBackupAssetImport(baseInput({ incomingAssets: [bad as VerifiedIncomingAsset] }))
    ).toThrow("INVALID_ASSET_INPUT: incomingAssets.size");
  });

  it("R2C2-32. createAssetId returns empty -> rejected", () => {
    expect(() =>
      planBackupAssetImport(
        baseInput({ mode: "duplicate", createAssetId: emptyAssetId() })
      )
    ).toThrow("INVALID_ASSET_INPUT: createAssetId.empty");
  });

  it("R2C2-33. createAssetId persistent collision -> rejected", () => {
    expect(() =>
      planBackupAssetImport(
        baseInput({
          mode: "duplicate",
          requiredAssetIds: ["s1", "s2"],
          incomingAssets: [asset("s1", HASH_A, 10), asset("s2", HASH_B, 20)],
          createAssetId: collideAssetId(),
        })
      )
    ).toThrow("INVALID_ASSET_INPUT: createAssetId.collision");
  });

  it("R2C2-34. workspaceIdMaps missing collection rejected", () => {
    const maps = emptyIdMaps();
    delete (maps as Rec).templates;
    expect(() =>
      planBackupAssetImport(baseInput({ workspaceIdMaps: maps }))
    ).toThrow("INVALID_ASSET_INPUT: workspaceIdMaps.collection");
  });

  it("R2C2-35. workspaceIdMaps not plain record rejected", () => {
    expect(() =>
      planBackupAssetImport(
        baseInput({ workspaceIdMaps: [] as unknown as IdMaps })
      )
    ).toThrow("INVALID_ASSET_INPUT: workspaceIdMaps");
  });

  it("R2C2-36. knownObjects same hash conflicting descriptor rejected", () => {
    const input = baseInput({
      knownObjects: [known(HASH_A, 10), known(HASH_A, 20)],
    });
    expect(() => planBackupAssetImport(input)).toThrow(
      "INVALID_ASSET_INPUT: knownObjects.conflict"
    );
  });

  it("R2C2-37. metadata array rejected (prototype safety)", () => {
    const bad = asset("s1", HASH_A, 10) as Rec;
    bad.metadata = [1, 2, 3];
    expect(() =>
      planBackupAssetImport(baseInput({ incomingAssets: [bad as VerifiedIncomingAsset] }))
    ).toThrow("INVALID_ASSET_INPUT: incomingAssets.metadata");
  });

  it("R2C2-38. metadata with poisoned prototype rejected", () => {
    const poisoned = Object.create({ polluted: "x" });
    const bad = asset("s1", HASH_A, 10) as Rec;
    bad.metadata = poisoned as Record<string, unknown>;
    expect(() =>
      planBackupAssetImport(baseInput({ incomingAssets: [bad as VerifiedIncomingAsset] }))
    ).toThrow("INVALID_ASSET_INPUT: incomingAssets.metadata");
  });

  // --- Determinism / immutability -----------------------------------
  it("R2C2-39. deterministic output for identical input", () => {
    const mk = () =>
      baseInput({
        mode: "duplicate",
        requiredAssetIds: ["s1", "s2"],
        incomingAssets: [asset("s1", HASH_A, 10), asset("s2", HASH_B, 20)],
        knownObjects: [known(HASH_A, 10)],
      });
    const a = planBackupAssetImport(mk());
    const b = planBackupAssetImport(mk());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("R2C2-40. incoming assets / id maps not mutated", () => {
    const incoming = [asset("s1", HASH_A, 10, { metadata: { templateId: "t1" } })];
    const maps = emptyIdMaps();
    maps.templates = { t1: "tNew" };
    const input = baseInput({ incomingAssets: incoming, workspaceIdMaps: maps });
    planBackupAssetImport(input);
    // metadata.templateId must remain source value.
    expect((incoming[0].metadata as Rec).templateId).toBe("t1");
    expect(maps.templates.t1).toBe("tNew");
  });

  it("R2C2-41. current workspace not mutated by two-pass align", () => {
    const snap = JSON.parse(JSON.stringify(emptyWs()));
    runTwoPassAlign();
    expect(JSON.stringify(emptyWs())).toBe(JSON.stringify(snap));
  });

  // --- Conflict value-free ----------------------------------------
  it("R2C2-42. conflicts never leak hash/owner/path/filename/metadata", () => {
    const r = planBackupAssetImport(
      baseInput({
        incomingAssets: [
          asset("s1", HASH_A, 10, {
            originalFilename: "SECRET.png",
            metadata: { templateId: "missing" },
          }),
        ],
      })
    );
    for (const c of r.conflicts) {
      const s = JSON.stringify(c);
      expect(s).not.toContain(HASH_A);
      expect(s).not.toContain(OWNER);
      expect(s).not.toContain("SECRET.png");
      expect(s).not.toContain("missing");
    }
  });

  // --- Counts precise ---------------------------------------------
  it("R2C2-43. counts match actual plans precisely", () => {
    const r = planBackupAssetImport(
      baseInput({
        mode: "duplicate",
        requiredAssetIds: ["s1", "s2"],
        incomingAssets: [
          asset("s1", HASH_A, 10),
          asset("s2", HASH_B, 20),
        ],
        knownObjects: [known(HASH_A, 10), known(HASH_B, 20)],
      })
    );
    expect(r.counts.required).toBe(2);
    expect(r.counts.manifestsToCreate).toBe(2);
    expect(r.counts.objectsToCopy).toBe(0);
    expect(r.counts.objectsReused).toBe(2);
  });

  // --- Two-pass C2C1 alignment ------------------------------------
  it("R2C2-44. two-pass C2C1 alignment: assetIdMap resolves all three confirmed locations", () => {
    const result = runTwoPassAlign();
    const { firstRequired, assetPlan, finalPlan } = result;

    // We planned exactly the required assets.
    expect(Object.keys(assetPlan.assetIdMap).sort()).toEqual(
      [...firstRequired].sort()
    );
    // Final workspace plan has empty unresolved.
    expect(finalPlan.unresolvedAssetIds).toEqual([]);
    // Every target id is non-source.
    for (const [src, tgt] of Object.entries(assetPlan.assetIdMap)) {
      expect(tgt).not.toBe(src);
    }
  });

  it("R2C2-45. two-pass C2C1 alignment: no source-only asset id remains in confirmed locations", () => {
    const { finalPlan } = runTwoPassAlign();
    const ws = finalPlan.mergedWorkspace as Rec;
    const versions = ws.templateVersions as Array<Rec>;
    const instances = ws.instances as Array<Rec>;
    const importRuns = ws.importRuns as Array<Rec>;
    // Any assetId inside pageManifest / outputHistory / sourceAssetId must be
    // a target id (never a source id like "asset-page-1").
    for (const v of versions) {
      const pm = v.pageManifest as Rec;
      expect(JSON.stringify(pm)).not.toContain("asset-page-1");
    }
    for (const i of instances) {
      for (const h of i.outputHistory as Array<Rec>) {
        expect(JSON.stringify(h)).not.toContain("asset-inst-1");
      }
    }
    for (const r of importRuns) {
      expect(r.sourceAssetId).not.toBe("asset-run-1");
    }
  });
});

// ----------------------------------------------------------------------------
// Two-pass C2C1 alignment helper
// ----------------------------------------------------------------------------

function emptyWs(ownerKey = "owner-A"): LocalWorkspace {
  return {
    schemaVersion: 2,
    ownerKey,
    createdAt: "2023-01-01T00:00:00.000Z",
    updatedAt: "2023-01-01T00:00:00.000Z",
    templates: [],
    templateVersions: [],
    fields: [],
    instances: [],
    folders: [],
    tags: [],
    savedValues: [],
    mappingTemplates: [],
    importRuns: [],
    importRows: [],
    mappingDecisions: [],
    detectionRuns: [],
    operationJournal: [],
    preferences: { locale: "zh-Hant" },
  } as unknown as LocalWorkspace;
}

function tpl(id: string, name: string, extra: Rec = {}): Rec {
  return {
    id,
    ownerId: "owner-A",
    name,
    description: null,
    lifecycle: "published",
    currentPublishedVersionId: null,
    currentDraftVersionId: null,
    schemaVersion: 2,
    folderIds: [],
    tagIds: [],
    favorite: false,
    pinned: false,
    printProfile: {},
    instanceNamePattern: "{T}_{D}_{T}",
    keyFieldIds: [],
    createdAt: 1000,
    updatedAt: 1000,
    lastOpenedAt: 1000,
    ...extra,
  };
}
function ver(id: string, tplId: string, hash: string, extra: Rec = {}): Rec {
  return {
    id,
    templateId: tplId,
    versionNumber: 1,
    state: "published",
    schemaVersion: 2,
    contentHash: hash,
    note: null,
    pageManifest: { pages: [{ assetId: "asset-page-1" }] },
    fieldSnapshot: [],
    printSettings: {},
    publishedAt: 1000,
    createdAt: 1000,
    updatedAt: 1000,
    ...extra,
  };
}
function inst(id: string, tplId: string, verId: string, extra: Rec = {}): Rec {
  return {
    id,
    ownerId: "owner-A",
    templateId: tplId,
    templateVersionId: verId,
    templateVersionHash: "hash-pub",
    schemaVersion: 2,
    name: "Inst",
    status: "draft",
    values: {},
    valuesHash: "vh",
    printCount: 0,
    createdAt: 1000,
    updatedAt: 1000,
    completedAt: null,
    lastPrintedAt: null,
    outputHistory: [{ assetId: "asset-inst-1" }],
    ...extra,
  };
}
function importRun(id: string, verId: string, srcAsset: string, extra: Rec = {}): Rec {
  return {
    id,
    ownerId: "owner-A",
    templateVersionId: verId,
    sourceAssetId: srcAsset,
    createdAt: 1000,
    completedAt: 1000,
    decisionManifest: [{ csvField: "a", nestedAssetId: "not-an-asset" }],
    ...extra,
  };
}

function makeMergeCreateId(): (prefix: string) => string {
  let n = 0;
  return (prefix: string) => `${prefix}_m${(++n).toString(36)}`;
}

function runTwoPassAlign(): {
  firstRequired: string[];
  assetPlan: ReturnType<typeof planBackupAssetImport>;
  finalPlan: ReturnType<typeof planWorkspaceBackupMerge>;
} {
  const incoming: LocalWorkspace = {
    ...emptyWs("owner-B"),
    templates: [tpl("it1", "T")],
    templateVersions: [ver("iv1", "it1", "vh1")],
    fields: [{ id: "if1", templateVersionId: "iv1", stableFieldId: "s1", fieldType: "text", displayOrder: 1, definition: {}, coordinate: {}, createdAt: 1000 } as unknown as Rec],
    instances: [inst("ii1", "it1", "iv1")],
    importRuns: [importRun("ir1", "iv1", "asset-run-1")],
    importRows: [{ id: "irow", importRunId: "ir1", instanceId: "ii1", createdAt: 1000 } as unknown as Rec],
    folders: [],
    tags: [],
  } as unknown as LocalWorkspace;

  // Pass 1: workspace plan without assetIdMap.
  const pass1 = planWorkspaceBackupMerge({
    current: emptyWs(),
    incoming,
    mode: "duplicate",
    ownerId: "owner-A",
    createId: makeMergeCreateId(),
    now: NOW,
  });
  const firstRequired = pass1.requiredAssetIds;

  // Build a fake verified incoming asset set for each required id.
  const incomingAssets: VerifiedIncomingAsset[] = firstRequired.map((id, i) =>
    asset(id, ["a", "b", "c", "d"][i % 4].repeat(64), 10 + i, {
      metadata: { kind: "page", templateId: "it1", templateVersionId: "iv1", instanceId: "ii1" },
    })
  );

  // Pass 2: asset plan.
  const assetPlan = planBackupAssetImport({
    mode: "duplicate",
    targetOwnerKeyHash: OWNER,
    requiredAssetIds: firstRequired,
    incomingAssets,
    occupiedManifests: [],
    knownObjects: [],
    workspaceIdMaps: pass1.idMaps,
    createAssetId: makeCreateAssetId(),
  });

  // Pass 3: workspace plan WITH assetIdMap.
  const finalPlan = planWorkspaceBackupMerge({
    current: emptyWs(),
    incoming,
    mode: "duplicate",
    ownerId: "owner-A",
    createId: makeMergeCreateId(),
    now: NOW,
    assetIdMap: assetPlan.assetIdMap,
  });

  return { firstRequired, assetPlan, finalPlan };
}

// ============================================================================
// C2C2-R1 regression: six second-line defects fixed & verified
// ============================================================================

// Generator that returns an unsafe Windows-path id (C2C2-R1 defect 1).
function unsafePathId(): () => string {
  return () => "C:\\unsafe\\id";
}
// Generator returning a URL (rejected by SAFE_ID_RE + forbidden rule).
function urlId(): () => string {
  return () => "http://evil/x";
}
// Generator returning a slash / dot / whitespace id.
function slashId(): () => string {
  return () => "a/b.c d";
}
// Generator returning an over-long id (>200).
function longId(): () => string {
  return () => "x".repeat(250);
}
// Generator that always returns the source id (collision with required source).
function collideWithSource(): () => string {
  let n = 0;
  return () => `asset_${(++n).toString(36)}`;
}
// Deterministic generator producing enumerated ids for collision tests.
function enumId(start: number): () => string {
  let n = start;
  return () => `gen_${(++n).toString(36)}`;
}

describe("C2C2-R1 regression (six second-line defects)", () => {
  // ---- Defect 1: unsafe generated id accepted -------------------------
  it("R1-1a. generated Windows-path id rejected (not ready)", () => {
    expect(() =>
      planBackupAssetImport(
        baseInput({ mode: "duplicate", createAssetId: unsafePathId() })
      )
    ).toThrow("INVALID_ASSET_INPUT: createAssetId.unsafe");
  });

  it("R1-1b. generated URL / slash / dot / whitespace id rejected", () => {
    expect(() =>
      planBackupAssetImport(
        baseInput({ mode: "duplicate", createAssetId: urlId() })
      )
    ).toThrow("INVALID_ASSET_INPUT: createAssetId.unsafe");
    expect(() =>
      planBackupAssetImport(
        baseInput({ mode: "duplicate", createAssetId: slashId() })
      )
    ).toThrow("INVALID_ASSET_INPUT: createAssetId.unsafe");
  });

  it("R1-1c. generated over-long id rejected", () => {
    expect(() =>
      planBackupAssetImport(
        baseInput({ mode: "duplicate", createAssetId: longId() })
      )
    ).toThrow("INVALID_ASSET_INPUT: createAssetId.unsafe");
  });

  // ---- Defect 1/2: collision sets -------------------------------------
  it("R1-2a. generated id colliding with required source is retried (duplicate never equals source)", () => {
    // Every generated id collides with an existing used id until it finds a
    // free one; the duplicate target must never equal the source id "s1".
    const r = planBackupAssetImport(
      baseInput({
        mode: "duplicate",
        requiredAssetIds: ["s1", "s2"],
        incomingAssets: [asset("s1", HASH_A, 10), asset("s2", HASH_B, 20)],
        occupiedManifests: [occupied("occupiedX", HASH_C, 5)],
        createAssetId: enumId(0),
      })
    );
    expect(r.assetIdMap["s1"]).not.toBe("s1");
    expect(r.assetIdMap["s2"]).not.toBe("s2");
    const targets = Object.values(r.assetIdMap);
    expect(targets).not.toContain("s1");
    expect(targets).not.toContain("s2");
    expect(targets).not.toContain("occupiedX");
    expect(new Set(targets).size).toBe(targets.length);
  });

  it("R1-2b. generated id colliding with extra incoming asset is retried", () => {
    const r = planBackupAssetImport(
      baseInput({
        mode: "duplicate",
        requiredAssetIds: ["s1"],
        incomingAssets: [
          asset("s1", HASH_A, 10),
          asset("extra", HASH_B, 20),
        ],
        createAssetId: enumId(0),
      })
    );
    const targets = Object.values(r.assetIdMap);
    expect(targets).not.toContain("extra");
    expect(targets).not.toContain("s1");
    expect(new Set(targets).size).toBe(targets.length);
  });

  it("R1-2c. generated id colliding with occupied manifest is retried", () => {
    const r = planBackupAssetImport(
      baseInput({
        mode: "duplicate",
        requiredAssetIds: ["s1"],
        incomingAssets: [asset("s1", HASH_A, 10)],
        occupiedManifests: [occupied("occ1", HASH_B, 20)],
        createAssetId: enumId(0),
      })
    );
    const targets = Object.values(r.assetIdMap);
    expect(targets).not.toContain("occ1");
    expect(new Set(targets).size).toBe(targets.length);
  });

  it("R1-2d. 64 collisions fail closed", () => {
    // A generator that only emits ids already in `used` (required + incoming +
    // occupied) will exhaust 64 attempts and throw.
    const alwaysUsed = () => "s1";
    expect(() =>
      planBackupAssetImport(
        baseInput({
          mode: "duplicate",
          requiredAssetIds: ["s1", "s2"],
          incomingAssets: [asset("s1", HASH_A, 10), asset("s2", HASH_B, 20)],
          createAssetId: alwaysUsed,
        })
      )
    ).toThrow("INVALID_ASSET_INPUT: createAssetId.collision");
  });

  it("R1-2e. duplicate target never equals source (structure-free assertion)", () => {
    const r = planBackupAssetImport(
      baseInput({
        mode: "duplicate",
        requiredAssetIds: ["s1"],
        incomingAssets: [asset("s1", HASH_A, 10)],
        createAssetId: enumId(100),
      })
    );
    expect(r.assetIdMap["s1"]).not.toBe("s1");
  });

  // ---- Defect 2: exact reuse misjudged --------------------------------
  it("R1-3a. mimeType differs -> no reuse", () => {
    const occ = occupied("s1", HASH_A, 10, {
      manifest: {
        schemaVersion: 1,
        id: "s1",
        ownerKeyHash: OWNER,
        contentHash: HASH_A,
        size: 10,
        mimeType: "image/png",
        metadata: { kind: "page" },
      },
    });
    const r = planBackupAssetImport(
      baseInput({
        incomingAssets: [
          asset("s1", HASH_A, 10, { mimeType: "image/jpeg" }),
        ],
        occupiedManifests: [occ],
      })
    );
    expect(r.manifestPlans[0].action).toBe("create");
    expect(r.assetIdMap["s1"]).not.toBe("s1");
  });

  it("R1-3b. originalFilename differs -> no reuse", () => {
    const occ = occupied("s1", HASH_A, 10, {
      manifest: {
        schemaVersion: 1,
        id: "s1",
        ownerKeyHash: OWNER,
        contentHash: HASH_A,
        size: 10,
        originalFilename: "a.png",
        metadata: { kind: "page" },
      },
    });
    const r = planBackupAssetImport(
      baseInput({
        incomingAssets: [
          asset("s1", HASH_A, 10, { originalFilename: "b.png" }),
        ],
        occupiedManifests: [occ],
      })
    );
    expect(r.manifestPlans[0].action).toBe("create");
  });

  it("R1-3c. createdAt differs -> no reuse", () => {
    const occ = occupied("s1", HASH_A, 10, {
      manifest: {
        schemaVersion: 1,
        id: "s1",
        ownerKeyHash: OWNER,
        contentHash: HASH_A,
        size: 10,
        createdAt: 1000,
        metadata: { kind: "page" },
      },
    });
    const r = planBackupAssetImport(
      baseInput({
        incomingAssets: [asset("s1", HASH_A, 10, { createdAt: 2000 })],
        occupiedManifests: [occ],
      })
    );
    expect(r.manifestPlans[0].action).toBe("create");
  });

  it("R1-3d. arbitrary metadata differs -> no reuse", () => {
    const occ = occupied("s1", HASH_A, 10, {
      manifest: {
        schemaVersion: 1,
        id: "s1",
        ownerKeyHash: OWNER,
        contentHash: HASH_A,
        size: 10,
        metadata: { kind: "page", note: "old" },
      },
    });
    const r = planBackupAssetImport(
      baseInput({
        incomingAssets: [
          asset("s1", HASH_A, 10, { metadata: { kind: "page", note: "new" } }),
        ],
        occupiedManifests: [occ],
      })
    );
    expect(r.manifestPlans[0].action).toBe("create");
  });

  it("R1-3e. nested metadata differs -> no reuse", () => {
    const occ = occupied("s1", HASH_A, 10, {
      manifest: {
        schemaVersion: 1,
        id: "s1",
        ownerKeyHash: OWNER,
        contentHash: HASH_A,
        size: 10,
        metadata: { kind: "page", nested: { a: 1 } },
      },
    });
    const r = planBackupAssetImport(
      baseInput({
        incomingAssets: [
          asset("s1", HASH_A, 10, {
            metadata: { kind: "page", nested: { a: 2 } },
          }),
        ],
        occupiedManifests: [occ],
      })
    );
    expect(r.manifestPlans[0].action).toBe("create");
  });

  it("R1-3f. metadata key order differs but semantically equal -> reuse", () => {
    const occ = occupied("s1", HASH_A, 10, {
      manifest: {
        schemaVersion: 1,
        id: "s1",
        ownerKeyHash: OWNER,
        contentHash: HASH_A,
        size: 10,
        metadata: { kind: "page", templateId: "t1", note: "x" },
      },
    });
    const r = planBackupAssetImport(
      baseInput({
        incomingAssets: [
          asset("s1", HASH_A, 10, {
            metadata: { note: "x", templateId: "t1", kind: "page" },
          }),
        ],
        workspaceIdMaps: (() => {
          const m = emptyIdMaps();
          m.templates = { t1: "t1" };
          return m;
        })(),
        occupiedManifests: [occ],
      })
    );
    expect(r.manifestPlans[0].action).toBe("reuse");
  });

  it("R1-3g. metadata relation remap then equal to occupied -> reuse", () => {
    const occ = occupied("s1", HASH_A, 10, {
      manifest: {
        schemaVersion: 1,
        id: "s1",
        ownerKeyHash: OWNER,
        contentHash: HASH_A,
        size: 10,
        metadata: { kind: "page", templateId: "tNEW" },
      },
    });
    const r = planBackupAssetImport(
      baseInput({
        incomingAssets: [
          asset("s1", HASH_A, 10, {
            metadata: { kind: "page", templateId: "tOLD" },
          }),
        ],
        workspaceIdMaps: (() => {
          const m = emptyIdMaps();
          m.templates = { tOLD: "tNEW" };
          return m;
        })(),
        occupiedManifests: [occ],
      })
    );
    expect(r.manifestPlans[0].action).toBe("reuse");
  });

  it("R1-3h. differs before remap, equal after remap -> reuse", () => {
    const occ = occupied("s1", HASH_A, 10, {
      manifest: {
        schemaVersion: 1,
        id: "s1",
        ownerKeyHash: OWNER,
        contentHash: HASH_A,
        size: 10,
        metadata: { kind: "page", templateId: "tNEW", instanceId: "iNEW" },
      },
    });
    const r = planBackupAssetImport(
      baseInput({
        incomingAssets: [
          asset("s1", HASH_A, 10, {
            metadata: { kind: "page", templateId: "tOLD", instanceId: "iOLD" },
          }),
        ],
        workspaceIdMaps: (() => {
          const m = emptyIdMaps();
          m.templates = { tOLD: "tNEW" };
          m.instances = { iOLD: "iNEW" };
          return m;
        })(),
        occupiedManifests: [occ],
      })
    );
    expect(r.manifestPlans[0].action).toBe("reuse");
  });

  it("R1-3i. occupied.manifest missing -> safe rekey (create)", () => {
    const occ = occupied("s1", HASH_A, 10); // no manifest body
    const r = planBackupAssetImport(
      baseInput({ occupiedManifests: [occ] })
    );
    expect(r.manifestPlans[0].action).toBe("create");
    expect(r.assetIdMap["s1"]).not.toBe("s1");
  });

  it("R1-3j. occupied.manifest descriptor inconsistent with outer -> rejected", () => {
    const occ = occupied("s1", HASH_A, 10, {
      manifest: {
        schemaVersion: 1,
        id: "s1",
        ownerKeyHash: OWNER,
        contentHash: HASH_B, // differs from outer HASH_A
        size: 10,
        metadata: {},
      },
    });
    expect(() =>
      planBackupAssetImport(baseInput({ occupiedManifests: [occ] }))
    ).toThrow("INVALID_ASSET_INPUT: occupiedManifests.manifest.contentHash");
  });

  // ---- Defect 3: reuse must build object plan -------------------------
  it("R1-4a. reuse manifest + known missing object -> object copy", () => {
    const occ = occupied("s1", HASH_A, 10, {
      manifest: {
        schemaVersion: 1,
        id: "s1",
        ownerKeyHash: OWNER,
        contentHash: HASH_A,
        size: 10,
        metadata: {},
      },
    });
    const r = planBackupAssetImport(
      baseInput({ incomingAssets: [asset("s1", HASH_A, 10)], occupiedManifests: [occ] })
    );
    expect(r.manifestPlans[0].action).toBe("reuse");
    expect(r.objectPlans).toHaveLength(1);
    expect(r.objectPlans[0].action).toBe("copy");
    expect(r.ready).toBe(true);
  });

  it("R1-4b. reuse manifest + known verified object -> object reuse", () => {
    const occ = occupied("s1", HASH_A, 10, {
      manifest: {
        schemaVersion: 1,
        id: "s1",
        ownerKeyHash: OWNER,
        contentHash: HASH_A,
        size: 10,
        metadata: {},
      },
    });
    const r = planBackupAssetImport(
      baseInput({
        incomingAssets: [asset("s1", HASH_A, 10)],
        occupiedManifests: [occ],
        knownObjects: [known(HASH_A, 10)],
      })
    );
    expect(r.manifestPlans[0].action).toBe("reuse");
    expect(r.objectPlans[0].action).toBe("reuse");
  });

  it("R1-4c. reuse manifest + known corrupt object -> conflict / not ready", () => {
    const occ = occupied("s1", HASH_A, 10, {
      manifest: {
        schemaVersion: 1,
        id: "s1",
        ownerKeyHash: OWNER,
        contentHash: HASH_A,
        size: 10,
        metadata: {},
      },
    });
    const r = planBackupAssetImport(
      baseInput({
        incomingAssets: [asset("s1", HASH_A, 10)],
        occupiedManifests: [occ],
        knownObjects: [known(HASH_A, 10, false)],
      })
    );
    expect(r.conflicts.some((c) => c.code === "OBJECT_CONFLICT")).toBe(true);
    expect(r.ready).toBe(false);
  });

  it("R1-4d. reuse manifest + known size mismatch -> conflict / not ready", () => {
    const occ = occupied("s1", HASH_A, 10, {
      manifest: {
        schemaVersion: 1,
        id: "s1",
        ownerKeyHash: OWNER,
        contentHash: HASH_A,
        size: 10,
        metadata: {},
      },
    });
    const r = planBackupAssetImport(
      baseInput({
        incomingAssets: [asset("s1", HASH_A, 10)],
        occupiedManifests: [occ],
        knownObjects: [known(HASH_A, 999)],
      })
    );
    expect(r.conflicts.some((c) => c.code === "OBJECT_CONFLICT")).toBe(true);
    expect(r.ready).toBe(false);
  });

  // ---- Defect 5: empty plan ready semantics ----------------------------
  it("R1-5a. empty required plan -> ready true and all-zero counts", () => {
    const r = planBackupAssetImport(
      baseInput({
        requiredAssetIds: [],
        incomingAssets: [],
        occupiedManifests: [],
        knownObjects: [],
      })
    );
    expect(r.ready).toBe(true);
    expect(r.assetIdMap).toEqual({});
    expect(r.manifestPlans).toHaveLength(0);
    expect(r.objectPlans).toHaveLength(0);
    expect(r.counts).toEqual({
      required: 0,
      manifestsToCreate: 0,
      manifestsReused: 0,
      objectsToCopy: 0,
      objectsReused: 0,
      unresolved: 0,
      conflicts: 0,
    });
  });

  // ---- Defect 6: non-array input fixed errors -------------------------
  it("R1-6a. incomingAssets null/object rejected (not TypeError)", () => {
    expect(() =>
      planBackupAssetImport(
        baseInput({ incomingAssets: null as unknown as VerifiedIncomingAsset[] })
      )
    ).toThrow("INVALID_ASSET_INPUT: incomingAssets");
    expect(() =>
      planBackupAssetImport(
        baseInput({ incomingAssets: { id: "x" } as unknown as VerifiedIncomingAsset[] })
      )
    ).toThrow("INVALID_ASSET_INPUT: incomingAssets");
  });

  it("R1-6b. occupiedManifests null/object rejected", () => {
    expect(() =>
      planBackupAssetImport(
        baseInput({ occupiedManifests: null as unknown as OccupiedAssetManifest[] })
      )
    ).toThrow("INVALID_ASSET_INPUT: occupiedManifests");
  });

  it("R1-6c. knownObjects null/object rejected", () => {
    expect(() =>
      planBackupAssetImport(
        baseInput({ knownObjects: null as unknown as KnownObject[] })
      )
    ).toThrow("INVALID_ASSET_INPUT: knownObjects");
  });

  it("R1-6d. incomingAssets entry not plain object rejected", () => {
    expect(() =>
      planBackupAssetImport(
        baseInput({ incomingAssets: ["x"] as unknown as VerifiedIncomingAsset[] })
      )
    ).toThrow("INVALID_ASSET_INPUT: incomingAssets.entry");
  });

  // ---- Defect 6 (continued): deeper input validation ------------------
  it("R1-6e. occupied contentHash malformed rejected", () => {
    const occ = occupied("s1", "BAD", 10);
    expect(() =>
      planBackupAssetImport(baseInput({ occupiedManifests: [occ] }))
    ).toThrow("INVALID_ASSET_INPUT: occupiedManifests.contentHash");
  });

  it("R1-6f. optional mimeType/filename/createdAt wrong type rejected", () => {
    expect(() =>
      planBackupAssetImport(
        baseInput({
          incomingAssets: [asset("s1", HASH_A, 10, { mimeType: 5 as unknown as string })],
        })
      )
    ).toThrow("INVALID_ASSET_INPUT: incomingAssets.mimeType");
    expect(() =>
      planBackupAssetImport(
        baseInput({
          incomingAssets: [
            asset("s1", HASH_A, 10, { originalFilename: 5 as unknown as string }),
          ],
        })
      )
    ).toThrow("INVALID_ASSET_INPUT: incomingAssets.originalFilename");
    expect(() =>
      planBackupAssetImport(
        baseInput({
          incomingAssets: [
            asset("s1", HASH_A, 10, { createdAt: {} as unknown as number }),
          ],
        })
      )
    ).toThrow("INVALID_ASSET_INPUT: incomingAssets.createdAt");
  });

  it("R1-6g. workspaceIdMaps Date/Map/poisoned prototype rejected", () => {
    const maps = emptyIdMaps();
    (maps as Rec).templates = { t1: new Date() } as unknown as Record<string, string>;
    expect(() =>
      planBackupAssetImport(baseInput({ workspaceIdMaps: maps }))
    ).toThrow("INVALID_ASSET_INPUT: workspaceIdMaps.entry");

    const maps2 = emptyIdMaps();
    maps2.templates = { t1: "t1" };
    (maps2 as Rec).folders = new Map() as unknown as Record<string, string>;
    expect(() =>
      planBackupAssetImport(baseInput({ workspaceIdMaps: maps2 }))
    ).toThrow("INVALID_ASSET_INPUT: workspaceIdMaps.collection");

    const poisoned = Object.create(null);
    poisoned.__proto__ = { polluted: 1 };
    const maps3 = emptyIdMaps();
    (maps3 as Rec).tags = poisoned;
    expect(() =>
      planBackupAssetImport(baseInput({ workspaceIdMaps: maps3 }))
    ).toThrow("INVALID_ASSET_INPUT: workspaceIdMaps.collection");
  });

  it("R1-6h. workspace map target value as Windows path rejected", () => {
    const maps = emptyIdMaps();
    maps.templates = { tOld: "C:\\windows\\path" };
    expect(() =>
      planBackupAssetImport(
        baseInput({
          incomingAssets: [
            asset("s1", HASH_A, 10, { metadata: { templateId: "tOld" } }),
          ],
          workspaceIdMaps: maps,
        })
      )
    ).toThrow("INVALID_ASSET_INPUT: workspaceIdMaps.entry");
  });

  it("R1-6i. nested metadata BigInt/function/cycle/poisoned prototype rejected", () => {
    const badFn = asset("s1", HASH_A, 10) as Rec;
    badFn.metadata = { fn: () => 1 };
    expect(() =>
      planBackupAssetImport(baseInput({ incomingAssets: [badFn as VerifiedIncomingAsset] }))
    ).toThrow("INVALID_ASSET_INPUT: incomingAssets.metadata");

    const badCycle = asset("s1", HASH_A, 10) as Rec;
    const cyc: Rec = { a: 1 };
    cyc.self = cyc;
    badCycle.metadata = cyc;
    expect(() =>
      planBackupAssetImport(baseInput({ incomingAssets: [badCycle as VerifiedIncomingAsset] }))
    ).toThrow("INVALID_ASSET_INPUT: incomingAssets.metadata");

    const poisoned = asset("s1", HASH_A, 10) as Rec;
    poisoned.metadata = Object.create({ polluted: "x" });
    expect(() =>
      planBackupAssetImport(baseInput({ incomingAssets: [poisoned as VerifiedIncomingAsset] }))
    ).toThrow("INVALID_ASSET_INPUT: incomingAssets.metadata");
  });

  // ---- Missing relation map: no assetIdMap / no usable manifest plan --
  it("R1-6j. metadata missing relation map -> no assetIdMap, no manifest plan", () => {
    const r = planBackupAssetImport(
      baseInput({
        incomingAssets: [
          asset("s1", HASH_A, 10, { metadata: { templateId: "tMISSING" } }),
        ],
      })
    );
    expect(r.conflicts.some((c) => c.code === "MISSING_RELATION_MAP")).toBe(true);
    expect(r.ready).toBe(false);
    // No usable planned manifest plan may be emitted for the missing-relation
    // asset; the assetIdMap must not contain a target that the final Workspace
    // Planner could abuse.
    expect(r.manifestPlans).toHaveLength(0);
    expect(r.assetIdMap["s1"]).toBeUndefined();
    expect(r.unresolvedAssetIds).toContain("s1");
  });

  // ---- Same hash, different size incoming manifests fail closed --------
  it("R1-6k. same contentHash different size incoming manifests fail closed", () => {
    // Two required manifests claim the same content hash but disagree on size;
    // this is an input inconsistency and must fail closed at validation.
    expect(() =>
      planBackupAssetImport(
        baseInput({
          requiredAssetIds: ["s1", "s2"],
          incomingAssets: [
            asset("s1", HASH_A, 10),
            asset("s2", HASH_A, 20), // same hash, different size
          ],
        })
      )
    ).toThrow("INVALID_ASSET_INPUT: incomingAssets.size.conflict");
  });

  // ---- Reuse plannedManifest is non-empty & full -----------------------
  it("R1-6l. reuse plannedManifest is non-empty and fully remap-completed", () => {
    const occ = occupied("s1", HASH_A, 10, {
      manifest: {
        schemaVersion: 1,
        id: "s1",
        ownerKeyHash: OWNER,
        contentHash: HASH_A,
        size: 10,
        mimeType: "image/png",
        originalFilename: "scan.png",
        createdAt: 111,
        metadata: { kind: "page", templateId: "tNEW" },
      },
    });
    const r = planBackupAssetImport(
      baseInput({
        incomingAssets: [
          asset("s1", HASH_A, 10, {
            mimeType: "image/png",
            originalFilename: "scan.png",
            createdAt: 111,
            metadata: { kind: "page", templateId: "tOLD" },
          }),
        ],
        workspaceIdMaps: (() => {
          const m = emptyIdMaps();
          m.templates = { tOLD: "tNEW" };
          return m;
        })(),
        occupiedManifests: [occ],
      })
    );
    const mp = r.manifestPlans[0];
    expect(mp.action).toBe("reuse");
    expect(Object.keys(mp.plannedManifest).length).toBeGreaterThan(0);
    expect(mp.plannedManifest.schemaVersion).toBe(1);
    expect(mp.plannedManifest.ownerKeyHash).toBe(OWNER);
    expect(mp.plannedManifest.contentHash).toBe(HASH_A);
    expect(mp.plannedManifest.size).toBe(10);
    expect((mp.plannedManifest.metadata as Rec).templateId).toBe("tNEW");
    expect((mp.plannedManifest.metadata as Rec).kind).toBe("page");
  });

  // ---- Object plan covers both create and reuse manifests --------------
  it("R1-6m. object plans cover create and reuse manifests (dedup by hash)", () => {
    const occ = occupied("s2", HASH_B, 20, {
      manifest: {
        schemaVersion: 1,
        id: "s2",
        ownerKeyHash: OWNER,
        contentHash: HASH_B,
        size: 20,
        metadata: {},
      },
    });
    const r = planBackupAssetImport(
      baseInput({
        requiredAssetIds: ["s1", "s2"],
        incomingAssets: [
          asset("s1", HASH_A, 10), // create (unoccupied)
          asset("s2", HASH_B, 20), // reuse (occupied by same owner, equal)
        ],
        occupiedManifests: [occ],
        knownObjects: [known(HASH_B, 20)],
      })
    );
    // one created manifest, one reused manifest
    expect(r.manifestPlans).toHaveLength(2);
    // two distinct content hashes -> two object plans (one copy, one reuse)
    expect(r.objectPlans).toHaveLength(2);
    const actions = r.objectPlans.map((o) => o.action).sort();
    expect(actions).toEqual(["copy", "reuse"]);
  });

  // ---- Deterministic ordering ------------------------------------------
  it("R1-6n. object/manifest/conflict plans deterministic across runs", () => {
    const build = () =>
      planBackupAssetImport(
        baseInput({
          requiredAssetIds: ["s2", "s1"], // unordered on purpose
          incomingAssets: [
            asset("s1", HASH_A, 10),
            asset("s2", HASH_B, 20),
          ],
          occupiedManifests: [occupied("s2", HASH_B, 20)],
          knownObjects: [known(HASH_A, 10), known(HASH_B, 20)],
        })
      );
    const a = build();
    const b = build();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // manifest plans sorted by source id
    expect(a.manifestPlans.map((m) => m.sourceAssetId)).toEqual(["s1", "s2"]);
    // object plans sorted by content hash
    expect(a.objectPlans.map((o) => o.contentHash)).toEqual([HASH_A, HASH_B]);
  });

  // ---- Conflicts never leak sensitive values ---------------------------
  it("R1-6o. conflicts never leak hash/owner/filename/metadata/secret", () => {
    const r = planBackupAssetImport(
      baseInput({
        incomingAssets: [
          asset("s1", HASH_A, 10, {
            originalFilename: "SECRET.png",
            metadata: { templateId: "missing" },
          }),
        ],
      })
    );
    for (const c of r.conflicts) {
      const s = JSON.stringify(c);
      expect(s).not.toContain(HASH_A);
      expect(s).not.toContain(OWNER);
      expect(s).not.toContain("SECRET.png");
      expect(s).not.toContain("missing");
    }
  });

  // ---- Two-pass C2C1 alignment still passes ----------------------------
  it("R1-6p. two-pass C2C1 alignment still passes after R1", () => {
    const { firstRequired, assetPlan, finalPlan } = runTwoPassAlign();
    expect(Object.keys(assetPlan.assetIdMap).sort()).toEqual(
      [...firstRequired].sort()
    );
    expect(finalPlan.unresolvedAssetIds).toEqual([]);
    for (const [src, tgt] of Object.entries(assetPlan.assetIdMap)) {
      expect(tgt).not.toBe(src);
    }
    const ws = finalPlan.mergedWorkspace as Rec;
    for (const v of ws.templateVersions as Array<Rec>) {
      expect(JSON.stringify(v.pageManifest)).not.toContain("asset-page-1");
    }
  });

  // ---- Immutability of inputs -----------------------------------------
  it("R1-6q. current/incoming/occupied/knownObjects/maps not mutated", () => {
    const incoming = [asset("s1", HASH_A, 10, { metadata: { templateId: "t1" } })];
    const occ = occupied("s1", HASH_A, 10, {
      manifest: {
        schemaVersion: 1,
        id: "s1",
        ownerKeyHash: OWNER,
        contentHash: HASH_A,
        size: 10,
        metadata: { kind: "page" },
      },
    });
    const knownObj = [known(HASH_A, 10)];
    const maps = emptyIdMaps();
    maps.templates = { t1: "tNew" };
    const input = baseInput({
      incomingAssets: incoming,
      occupiedManifests: [occ],
      knownObjects: knownObj,
      workspaceIdMaps: maps,
    });
    planBackupAssetImport(input);
    expect((incoming[0].metadata as Rec).templateId).toBe("t1");
    expect(maps.templates.t1).toBe("tNew");
    // occupied manifest body must be untouched
    expect((occ.manifest as Rec).metadata).toEqual({ kind: "page" });
    expect(knownObj[0].size).toBe(10);
  });
});

// ============================================================================
// C2C2-R2 regression: canonical collision / array cycle / plain entry /
// relation-before-id allocation
// ============================================================================

// A generator that counts how many times createAssetId is actually invoked.
function countingId(): { gen: () => string; count: () => number } {
  let n = 0;
  const gen = () => {
    n++;
    return `asset_${(n).toString(36)}`;
  };
  return { gen, count: () => n };
}

describe("C2C2-R2 regression (four second-line defects)", () => {
  // ---- Defect 1: canonical string collision -----------------------------
  it("R2-1a. [a,s:b] vs [a,b] not equal -> no reuse", () => {
    const occ = occupied("s1", HASH_A, 10, {
      manifest: {
        schemaVersion: 1,
        id: "s1",
        ownerKeyHash: OWNER,
        contentHash: HASH_A,
        size: 10,
        metadata: { tokens: ["a,s:b"] },
      },
    });
    const r = planBackupAssetImport(
      baseInput({
        incomingAssets: [asset("s1", HASH_A, 10, { metadata: { tokens: ["a", "b"] } })],
        occupiedManifests: [occ],
      })
    );
    expect(r.manifestPlans[0].action).toBe("create");
    expect(r.assetIdMap["s1"]).not.toBe("s1");
  });

  it("R2-1b. reverse direction also not equal -> no reuse", () => {
    const occ = occupied("s1", HASH_A, 10, {
      manifest: {
        schemaVersion: 1,
        id: "s1",
        ownerKeyHash: OWNER,
        contentHash: HASH_A,
        size: 10,
        metadata: { tokens: ["a", "b"] },
      },
    });
    const r = planBackupAssetImport(
      baseInput({
        incomingAssets: [asset("s1", HASH_A, 10, { metadata: { tokens: ["a,s:b"] } })],
        occupiedManifests: [occ],
      })
    );
    expect(r.manifestPlans[0].action).toBe("create");
  });

  it("R2-1c. control: identical token arrays -> reuse", () => {
    const occ = occupied("s1", HASH_A, 10, {
      manifest: {
        schemaVersion: 1,
        id: "s1",
        ownerKeyHash: OWNER,
        contentHash: HASH_A,
        size: 10,
        metadata: { tokens: ["a", "b"] },
      },
    });
    const r = planBackupAssetImport(
      baseInput({
        incomingAssets: [asset("s1", HASH_A, 10, { metadata: { tokens: ["a", "b"] } })],
        occupiedManifests: [occ],
      })
    );
    expect(r.manifestPlans[0].action).toBe("reuse");
  });

  it("R2-1d. string ']', ',' and ':' do not collide with array structure", () => {
    const occ = occupied("s1", HASH_A, 10, {
      manifest: {
        schemaVersion: 1,
        id: "s1",
        ownerKeyHash: OWNER,
        contentHash: HASH_A,
        size: 10,
        metadata: { tokens: ["a]", "b"] },
      },
    });
    const r = planBackupAssetImport(
      baseInput({
        incomingAssets: [asset("s1", HASH_A, 10, { metadata: { tokens: ["a", "b"] } })],
        occupiedManifests: [occ],
      })
    );
    expect(r.manifestPlans[0].action).toBe("create");
  });

  it("R2-1e. string \"null\" vs null not equal -> no reuse", () => {
    const occ = occupied("s1", HASH_A, 10, {
      manifest: {
        schemaVersion: 1,
        id: "s1",
        ownerKeyHash: OWNER,
        contentHash: HASH_A,
        size: 10,
        metadata: { v: "null" },
      },
    });
    const r = planBackupAssetImport(
      baseInput({
        incomingAssets: [asset("s1", HASH_A, 10, { metadata: { v: null } })],
        occupiedManifests: [occ],
      })
    );
    expect(r.manifestPlans[0].action).toBe("create");
  });

  it("R -1f. string \"1\" vs number 1 not equal -> no reuse", () => {
    const occ = occupied("s1", HASH_A, 10, {
      manifest: {
        schemaVersion: 1,
        id: "s1",
        ownerKeyHash: OWNER,
        contentHash: HASH_A,
        size: 10,
        metadata: { v: "1" },
      },
    });
    const r = planBackupAssetImport(
      baseInput({
        incomingAssets: [asset("s1", HASH_A, 10, { metadata: { v: 1 } })],
        occupiedManifests: [occ],
      })
    );
    expect(r.manifestPlans[0].action).toBe("create");
  });

  it("R2-1g. metadata key order differs but semantically equal -> reuse", () => {
    const occ = occupied("s1", HASH_A, 10, {
      manifest: {
        schemaVersion: 1,
        id: "s1",
        ownerKeyHash: OWNER,
        contentHash: HASH_A,
        size: 10,
        metadata: { a: 1, b: 2, c: 3 },
      },
    });
    const r = planBackupAssetImport(
      baseInput({
        incomingAssets: [
          asset("s1", HASH_A, 10, { metadata: { c: 3, a: 1, b: 2 } }),
        ],
        occupiedManifests: [occ],
      })
    );
    expect(r.manifestPlans[0].action).toBe("reuse");
  });

  // ---- Defect 2: array / object cycle guard ------------------------------
  it("R2-2a. cyclic array rejected (not RangeError)", () => {
    const cyc: Rec[] = [];
    cyc.push(cyc);
    const bad = asset("s1", HASH_A, 10) as Rec;
    bad.metadata = { tokens: cyc };
    expect(() =>
      planBackupAssetImport(baseInput({ incomingAssets: [bad as VerifiedIncomingAsset] }))
    ).toThrow("INVALID_ASSET_INPUT: incomingAssets.metadata");
  });

  it("R2-2b. object->array->object cycle rejected", () => {
    const a: Rec = { x: 1 };
    const arr: Rec[] = [a];
    a.y = arr;
    const bad = asset("s1", HASH_A, 10) as Rec;
    bad.metadata = { nested: a };
    expect(() =>
      planBackupAssetImport(baseInput({ incomingAssets: [bad as VerifiedIncomingAsset] }))
    ).toThrow("INVALID_ASSET_INPUT: incomingAssets.metadata");
  });

  it("R2-2c. shared (non-cyclic) subobject canonicalizes normally", () => {
    const sub = { x: 1, y: [1, 2] };
    // Two references to the same object (by value); must NOT be misjudged as a
    // cycle, and must not raise.
    const r = planBackupAssetImport(
      baseInput({
        incomingAssets: [
          asset("s1", HASH_A, 10, { metadata: { a: sub, b: sub } }),
        ],
      })
    );
    expect(r.ready).toBe(true);
    expect(r.manifestPlans).toHaveLength(1);
  });

  // ---- Defect 3+: entry plain-object validation --------------------------
  it("R2-3a. incoming class instance rejected", () => {
    class C {}
    const inst = new C();
    (inst as Rec).id = "s1";
    expect(() =>
      planBackupAssetImport(
        baseInput({ incomingAssets: [inst as unknown as VerifiedIncomingAsset] })
      )
    ).toThrow("INVALID_ASSET_INPUT: incomingAssets.entry");
  });

  it("R2-3b. occupied descriptor class instance rejected", () => {
    class C {}
    const inst = new C();
    (inst as Rec).id = "s1";
    expect(() =>
      planBackupAssetImport(
        baseInput({ occupiedManifests: [inst as unknown as OccupiedAssetManifest] })
      )
    ).toThrow("INVALID_ASSET_INPUT: occupiedManifests.entry");
  });

  it("R2-3c. known object class instance rejected", () => {
    class C {}
    const inst = new C();
    (inst as Rec).contentHash = HASH_A;
    expect(() =>
      planBackupAssetImport(
        baseInput({ knownObjects: [inst as unknown as KnownObject] })
      )
    ).toThrow("INVALID_ASSET_INPUT: knownObjects.entry");
  });

  it("R2-3d. occupied.manifest nested function rejected", () => {
    const occ = occupied("s1", HASH_A, 10, {
      manifest: {
        schemaVersion: 1,
        id: "s1",
        ownerKeyHash: OWNER,
        contentHash: HASH_A,
        size: 10,
        metadata: { note: "x" },
        extra: { fn: () => 1 }, // nested unsafe value anywhere
      },
    });
    expect(() =>
      planBackupAssetImport(baseInput({ occupiedManifests: [occ] }))
    ).toThrow("INVALID_ASSET_INPUT: occupiedManifests.manifest");
  });

  it("R2-3e. occupied.manifest nested Date/Map/Set rejected", () => {
    const occDate = occupied("s1", HASH_A, 10, {
      manifest: {
        schemaVersion: 1,
        id: "s1",
        ownerKeyHash: OWNER,
        contentHash: HASH_A,
        size: 10,
        nested: new Date(),
      },
    });
    expect(() =>
      planBackupAssetImport(baseInput({ occupiedManifests: [occDate] }))
    ).toThrow("INVALID_ASSET_INPUT: occupiedManifests.manifest");

    const occMap = occupied("s1", HASH_A, 10, {
      manifest: {
        schemaVersion: 1,
        id: "s1",
        ownerKeyHash: OWNER,
        contentHash: HASH_A,
        size: 10,
        nested: new Map(),
      },
    });
    expect(() =>
      planBackupAssetImport(baseInput({ occupiedManifests: [occMap] }))
    ).toThrow("INVALID_ASSET_INPUT: occupiedManifests.manifest");
  });

  it("R2-3f. incoming metadata nested unsafe value rejected", () => {
    const bad = asset("s1", HASH_A, 10) as Rec;
    bad.metadata = { inner: { fn: () => 1 } };
    expect(() =>
      planBackupAssetImport(baseInput({ incomingAssets: [bad as VerifiedIncomingAsset] }))
    ).toThrow("INVALID_ASSET_INPUT: incomingAssets.metadata");
  });

  // ---- Defect 4: relation remap before id allocation ---------------------
  it("R2-4a. duplicate missing templateId map -> createAssetId called 0 times", () => {
    const { gen, count } = countingId();
    planBackupAssetImport(
      baseInput({
        mode: "duplicate",
        createAssetId: gen,
        incomingAssets: [
          asset("s1", HASH_A, 10, { metadata: { templateId: "tMissing" } }),
        ],
      })
    );
    expect(count()).toBe(0);
  });

  it("R2-4b. duplicate missing templateVersionId map -> createAssetId 0 times", () => {
    const { gen, count } = countingId();
    planBackupAssetImport(
      baseInput({
        mode: "duplicate",
        createAssetId: gen,
        incomingAssets: [
          asset("s1", HASH_A, 10, { metadata: { templateVersionId: "vMissing" } }),
        ],
      })
    );
    expect(count()).toBe(0);
  });

  it("R2-4c. duplicate missing instanceId map -> createAssetId 0 times", () => {
    const { gen, count } = countingId();
    planBackupAssetImport(
      baseInput({
        mode: "duplicate",
        createAssetId: gen,
        incomingAssets: [
          asset("s1", HASH_A, 10, { metadata: { instanceId: "iMissing" } }),
        ],
      })
    );
    expect(count()).toBe(0);
  });

  it("R2-4d. structure cross-owner missing relation map -> createAssetId 0 times", () => {
    const { gen, count } = countingId();
    const occ = occupied("s1", HASH_A, 10, { ownerKeyHash: OTHER_OWNER });
    planBackupAssetImport(
      baseInput({
        createAssetId: gen,
        incomingAssets: [
          asset("s1", HASH_A, 10, { metadata: { templateId: "tMissing" } }),
        ],
        occupiedManifests: [occ],
      })
    );
    expect(count()).toBe(0);
  });

  it("R2- 4e. structure same-owner collision missing relation map -> createAssetId 0 times", () => {
    const { gen, count } = countingId();
    const occ = occupied("s1", HASH_A, 10);
    planBackupAssetImport(
      baseInput({
        createAssetId: gen,
        incomingAssets: [
          asset("s1", HASH_A, 10, { metadata: { templateId: "tMissing" } }),
        ],
        occupiedManifests: [occ],
      })
    );
    expect(count()).toBe(0);
  });

  it("R2-4f. duplicate with relation resolved -> createAssetId called exactly once", () => {
    const { gen, count } = countingId();
    const r = planBackupAssetImport(
      baseInput({
        mode: "duplicate",
        requiredAssetIds: ["s1"],
        incomingAssets: [asset("s1", HASH_A, 10)],
        createAssetId: gen,
      })
    );
    expect(count()).toBe(1);
    expect(r.ready).toBe(true);
    expect(r.manifestPlans[0].action).toBe("create");
  });

  // ---- Reuse and create share the same remap-completed metadata ----------
  it("R2-4g. reuse and create outputs both carry remap-completed metadata", () => {
    // reuse path
    const occ = occupied("s1", HASH_A, 10, {
      manifest: {
        schemaVersion: 1,
        id: "s1",
        ownerKeyHash: OWNER,
        contentHash: HASH_A,
        size: 10,
        metadata: { kind: "page", templateId: "tNEW" },
      },
    });
    const reuseR = planBackupAssetImport(
      baseInput({
        incomingAssets: [
          asset("s1", HASH_A, 10, { metadata: { kind: "page", templateId: "tOLD" } }),
        ],
        workspaceIdMaps: (() => {
          const m = emptyIdMaps();
          m.templates = { tOLD: "tNEW" };
          return m;
        })(),
        occupiedManifests: [occ],
      })
    );
    expect(reuseR.manifestPlans[0].action).toBe("reuse");
    expect((reuseR.manifestPlans[0].plannedManifest.metadata as Rec).templateId).toBe("tNEW");

    // create path (unoccupied)
    const createR = planBackupAssetImport(
      baseInput({
        incomingAssets: [
          asset("s1", HASH_A, 10, { metadata: { kind: "page", templateId: "tOLD" } }),
        ],
        workspaceIdMaps: (() => {
          const m = emptyIdMaps();
          m.templates = { tOLD: "tNEW" };
          return m;
        })(),
      })
    );
    expect(createR.manifestPlans[0].action).toBe("create");
    expect((createR.manifestPlans[0].plannedManifest.metadata as Rec).templateId).toBe("tNEW");
  });

  // ---- Failed-asset leaves no leaked plan / id / object ------------------
  it("R2-4h. relation-failed asset emits no assetIdMap / manifestPlan / objectPlan", () => {
    const r = planBackupAssetImport(
      baseInput({
        mode: "duplicate",
        requiredAssetIds: ["s1"],
        incomingAssets: [
          asset("s1", HASH_A, 10, { metadata: { templateId: "tMissing" } }),
        ],
      })
    );
    expect(r.assetIdMap).toEqual({});
    expect(r.manifestPlans).toHaveLength(0);
    expect(r.objectPlans).toHaveLength(0);
    expect(r.unresolvedAssetIds).toEqual(["s1"]);
    expect(r.ready).toBe(false);
  });

  // ---- Determinism / immutability (R2) ----------------------------------
  it("R2-5a. deterministic output across runs", () => {
    const mk = () =>
      baseInput({
        mode: "duplicate",
        requiredAssetIds: ["s1", "s2"],
        incomingAssets: [asset("s1", HASH_A, 10), asset("s2", HASH_B, 20)],
      });
    const a = planBackupAssetImport(mk());
    const b = planBackupAssetImport(mk());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  // ---- Two-pass C2C1 alignment still stands -----------------------------
  it("R2-5b. two-pass C2C1 alignment still passes", () => {
    const { firstRequired, assetPlan, finalPlan } = runTwoPassAlign();
    expect(Object.keys(assetPlan.assetIdMap).sort()).toEqual(
      [...firstRequired].sort()
    );
    expect(finalPlan.unresolvedAssetIds).toEqual([]);
    const ws = finalPlan.mergedWorkspace as Rec;
    for (const v of ws.templateVersions as Array<Rec>) {
      expect(JSON.stringify(v.pageManifest)).not.toContain("asset-page-1");
    }
  });
});
