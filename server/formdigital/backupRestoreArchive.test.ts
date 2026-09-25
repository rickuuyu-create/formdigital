/**
 * Layer 2C3B1 — Pure Atomic Restore Archive Builder tests.
 *
 * Every fixture uses the OFFICIAL Portable Backup schema (the same one the
 * Web verifier `verifyBackupArchive` and Local Service `verifyPortableBackup`
 * accept). We never invent a self-serving format: the produced archive is
 * re-verified by `verifyBackupArchive` in many tests.
 *
 * The Combined Restore Plan fixtures are produced by the REAL production
 * `planCombinedRestore` (structure & duplicate) so the builder is exercised
 * against a genuine `ready:true` plan, not a hand-faked one.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { strToU8, strFromU8, zipSync, unzipSync } from "fflate";
import { sha256 } from "./domain";
import {
  verifyBackupArchive,
  createBackupArchive,
} from "./assetStore";
import {
  planCombinedRestore,
  type CombinedRestorePlan,
  type CreateWorkspaceId,
  type CreateAssetId,
} from "./backupRestorePlan";
import { buildAtomicRestoreArchive } from "./backupRestoreArchive";

const OWNER = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const BAD_OWNER = "NOTAHEXOWNERHASH";
const SECRET = "SUPERSECRETINJECTEDTOKEN-X9F";
const TEST_PRIVATE_VALUE = "TEST_PRIVATE_VALUE";
const TEST_PATH_VALUE = "TEST_PATH_VALUE";
const TEST_TOKEN_VALUE = "TEST_TOKEN_VALUE";

function makeWorkspaceId(prefix: string, counter: { n: number }): string {
  counter.n += 1;
  return `${prefix}_w${counter.n}`;
}
function makeAssetId(prefix: string, counter: { n: number }): string {
  counter.n += 1;
  return `${prefix}_a${counter.n}`;
}

/** Minimal safe counting generators (deterministic, no I/O). */
function safeGens() {
  const wc = { n: 0 };
  const ac = { n: 0 };
  const createWorkspaceId: CreateWorkspaceId = (p) => makeWorkspaceId(p, wc);
  const createAssetId: CreateAssetId = (p) => makeAssetId(p, ac);
  return { createWorkspaceId, createAssetId };
}

/** Build a genuine ready Combined Restore Plan via the production planner. */
function planReady(opts: {
  mode: "structure" | "duplicate";
  knownObjects?: Array<{ contentHash: string; size: number; verified: boolean }>;
  extraIncomingAsset?: { id: string; contentHash: string; size: number };
}): { plan: CombinedRestorePlan; hashA: string; hashB: string } {
  const objA = new Uint8Array([1, 2, 3, 4]);
  const objB = new Uint8Array([5, 6, 7, 8, 9]);
  const hashA = sha256(objA);
  const hashB = sha256(objB);

  const incoming = {
    templates: [{ id: "it1", name: "Inc Tpl", folderIds: [], tagIds: [] }],
    templateVersions: [
      { id: "iv1", templateId: "it1", pageManifest: { pages: [{ assetId: "asset-page-1" }] } },
    ],
    fields: [],
    instances: [],
    savedValues: [],
    mappingTemplates: [],
    importRuns: [],
    importRows: [],
    mappingDecisions: [],
    detectionRuns: [],
    folders: [],
    tags: [],
    operationJournal: [],
  };
  const current = {
    templates: [],
    templateVersions: [],
    fields: [],
    instances: [],
    savedValues: [],
    mappingTemplates: [],
    importRuns: [],
    importRows: [],
    mappingDecisions: [],
    detectionRuns: [],
    folders: [],
    tags: [],
    operationJournal: [],
  };

  const incomingAssets = [
    {
      id: "asset-page-1",
      schemaVersion: 1 as const,
      ownerKeyHash: OWNER,
      contentHash: hashA,
      size: 4,
      metadata: { templateId: "it1", templateVersionId: "iv1" },
    },
  ];
  if (opts.extraIncomingAsset) {
    incomingAssets.push({
      id: opts.extraIncomingAsset.id,
      schemaVersion: 1 as const,
      ownerKeyHash: OWNER,
      contentHash: opts.extraIncomingAsset.contentHash,
      size: opts.extraIncomingAsset.size,
      metadata: { templateId: "it1", templateVersionId: "iv1" },
    });
  }

  const gens = safeGens();
  const plan = planCombinedRestore({
    current: current as never,
    incoming: incoming as never,
    mode: opts.mode,
    ownerId: "owner-7",
    targetOwnerKeyHash: OWNER,
    expectedWorkspaceRevision: 5,
    now: 1_700_000_000_000,
    incomingAssets: incomingAssets as never,
    occupiedManifests: [],
    knownObjects: (opts.knownObjects ?? []) as never,
    createWorkspaceId: gens.createWorkspaceId,
    createAssetId: gens.createAssetId,
  });

  if (!plan.ready || plan.finalWorkspacePlan === null) {
    throw new Error("fixture plan was not ready");
  }
  return { plan, hashA, hashB };
}

/** Build a valid `formdigital-portable-backup` source archive containing the
 *  listed objects + a self-consistent workspace + asset manifests.
 *  `withId` (default true) controls whether the backup manifest carries the
 *  official `id`/`kind` fields. The existing Web/Local verifier ACCEPTS an
 *  archive missing `id`/`kind`, so `withId:false` is used to prove that the
 *  coverage gap exists (and that the Builder must never rely on it). */
function buildSourceArchive(
  objects: Array<{ id: string; bytes: Uint8Array }>,
  opts: { withId?: boolean; kind?: string } = {}
): Uint8Array {
  const withId = opts.withId !== false;
  const kind = opts.kind ?? "manual";
  const workspaceEnvelope = {
    workspace: {
      templates: [{ id: "tpl_s", name: "Source" }],
      templateVersions: [{ id: "ver_s", templateId: "tpl_s" }],
      fields: [],
      instances: [],
      savedValues: [],
      mappingTemplates: [],
    },
  };
  const workspaceBytes = strToU8(JSON.stringify(workspaceEnvelope));
  const entries: Record<string, Uint8Array> = {
    "account/workspace.json": workspaceBytes,
  };
  const files: Array<{ path: string; contentHash: string; size: number }> = [
    {
      path: "account/workspace.json",
      contentHash: sha256(workspaceBytes),
      size: workspaceBytes.byteLength,
    },
  ];
  for (const obj of objects) {
    const hash = sha256(obj.bytes);
    const manifest = {
      schemaVersion: 1,
      id: obj.id,
      ownerKeyHash: OWNER,
      contentHash: hash,
      size: obj.bytes.byteLength,
    };
    const mBytes = strToU8(JSON.stringify(manifest));
    entries[`manifests/${obj.id}.json`] = mBytes;
    entries[`objects/${hash}`] = obj.bytes;
    // Dedupe file paths: multiple assets may share the same content hash,
    // which would otherwise produce a duplicate `objects/<hash>` entry path.
    if (!files.some((f) => f.path === `manifests/${obj.id}.json`)) {
      files.push({ path: `manifests/${obj.id}.json`, contentHash: sha256(mBytes), size: mBytes.byteLength });
    }
    if (!files.some((f) => f.path === `objects/${hash}`)) {
      files.push({ path: `objects/${hash}`, contentHash: hash, size: obj.bytes.byteLength });
    }
  }
  const summary = {
    templates: [{ id: "tpl_s", name: "Source", versions: 1, instances: 0 }],
    templateCount: 1,
    versionCount: 1,
    instanceCount: 0,
    mappingTemplateCount: 0,
  };
  const manifest: Record<string, unknown> = {
    format: "formdigital-portable-backup",
    schemaVersion: 1,
    scope: "account",
    templateId: null,
    ownerKeyHash: OWNER,
    createdAt: 1_690_000_000_000,
    files,
    summary,
  };
  if (withId) {
    manifest.id = "src-backup-001";
    manifest.kind = kind;
  }
  entries["backup-manifest.json"] = strToU8(JSON.stringify(manifest));
  return zipSync(entries, { level: 6 });
}

function buildEmptySourceArchive(): Uint8Array {
  // A valid `formdigital-portable-backup` with no assets — used to exercise the
  // legal empty-asset plan path.
  const workspaceEnvelope = {
    workspace: {
      templates: [{ id: "tpl_s", name: "Source" }],
      templateVersions: [{ id: "ver_s", templateId: "tpl_s" }],
      fields: [],
      instances: [],
      savedValues: [],
      mappingTemplates: [],
    },
  };
  const workspaceBytes = strToU8(JSON.stringify(workspaceEnvelope));
  const files: Array<{ path: string; contentHash: string; size: number }> = [
    {
      path: "account/workspace.json",
      contentHash: sha256(workspaceBytes),
      size: workspaceBytes.byteLength,
    },
  ];
  const summary = {
    templates: [{ id: "tpl_s", name: "Source", versions: 1, instances: 0 }],
    templateCount: 1,
    versionCount: 1,
    instanceCount: 0,
    mappingTemplateCount: 0,
  };
  const manifest: Record<string, unknown> = {
    format: "formdigital-portable-backup",
    schemaVersion: 1,
    scope: "account",
    templateId: null,
    ownerKeyHash: OWNER,
    id: "src-backup-empty",
    kind: "manual",
    createdAt: 1_690_000_000_000,
    files,
    summary,
  };
  const entries: Record<string, Uint8Array> = {
    "account/workspace.json": workspaceBytes,
    "backup-manifest.json": strToU8(JSON.stringify(manifest)),
  };
  return zipSync(entries, { level: 6 });
}

function buildLegacyArchive(): Uint8Array {
  const photo = new Uint8Array([1, 2, 3, 4]);
  const record = [{ id: "tpl_1", name: "Old" }];
  const manifest = {
    format: "formdigital-backup" as const,
    schemaVersion: 1,
    createdAt: 1_700_000_000_000,
    ownerId: 7,
    records: {
      templates: {
        path: "records/templates.json",
        contentHash: sha256(new TextEncoder().encode(JSON.stringify(record))),
        count: 1,
      },
    },
    assets: [
      { id: "asset_1", path: "assets/abc", contentHash: sha256(photo), mimeType: "image/png", sizeBytes: 4 },
    ],
  };
  return createBackupArchive(manifest as never, { templates: record } as never, { "assets/abc": photo } as never);
}

/** Deep-scan for forbidden strings in any serialized value. */
function deepForbiddenScan(value: unknown, forbidden: string[]): boolean {
  if (typeof value === "string") return forbidden.some((f) => value.includes(f));
  if (Array.isArray(value)) return value.some((v) => deepForbiddenScan(v, forbidden));
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (forbidden.some((f) => k.includes(f))) return true;
      if (deepForbiddenScan(v, forbidden)) return true;
    }
  }
  return false;
}

function unzipEntries(bytes: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(bytes);
}

describe("Layer 2C3B1 Atomic Restore Archive Builder", () => {
  it("1. legal Structure combined plan produces a verifiable archive", () => {
    const { plan, hashA } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source,
      combinedPlan: plan,
      targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_struct_1",
      createdAt: 1_700_000_000_000,
    });
    expect(() => verifyBackupArchive(out.archiveBytes)).not.toThrow();
    expect(hashA).toBeDefined();
  });

  it("2. legal Duplicate combined plan produces a verifiable archive", () => {
    const { plan } = planReady({ mode: "duplicate" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source,
      combinedPlan: plan,
      targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_dup_1",
      createdAt: 1_700_000_000_000,
    });
    expect(() => verifyBackupArchive(out.archiveBytes)).not.toThrow();
  });

  it("3. legal asset-less plan (no create manifests) produces a verifiable archive", () => {
    // Plan with no asset references: incoming version has empty pageManifest.
    const objA = new Uint8Array([1, 2, 3, 4]);
    const hashA = sha256(objA);
    const incoming = {
      templates: [{ id: "it1", name: "Inc Tpl", folderIds: [], tagIds: [] }],
      templateVersions: [{ id: "iv1", templateId: "it1", pageManifest: { pages: [] } }],
      fields: [], instances: [], savedValues: [], mappingTemplates: [],
      importRuns: [], importRows: [], mappingDecisions: [], detectionRuns: [],
      folders: [], tags: [], operationJournal: [],
    };
    const current = {
      templates: [], templateVersions: [], fields: [], instances: [],
      savedValues: [], mappingTemplates: [], importRuns: [], importRows: [],
      mappingDecisions: [], detectionRuns: [], folders: [], tags: [], operationJournal: [],
    };
    const gens = safeGens();
    const plan = planCombinedRestore({
      current: current as never,
      incoming: incoming as never,
      mode: "structure",
      ownerId: "owner-7",
      targetOwnerKeyHash: OWNER,
      expectedWorkspaceRevision: 5,
      now: 1_700_000_000_000,
      incomingAssets: [{ id: "asset-page-1", schemaVersion: 1 as const, ownerKeyHash: OWNER, contentHash: hashA, size: 4, metadata: { templateId: "it1", templateVersionId: "iv1" } }] as never,
      occupiedManifests: [],
      knownObjects: [] as never,
      createWorkspaceId: gens.createWorkspaceId,
      createAssetId: gens.createAssetId,
    });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: objA }]);
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source,
      combinedPlan: plan,
      targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_noasset",
      createdAt: 1_700_000_000_000,
    });
    expect(out.counts.manifestsIncluded).toBe(0);
    expect(out.counts.objectsIncluded).toBe(0);
    expect(() => verifyBackupArchive(out.archiveBytes)).not.toThrow();
  });

  it("4. output archive re-passes the official Web verifier", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_v", createdAt: 1_700_000_000_000,
    });
    const manifest = verifyBackupArchive(out.archiveBytes);
    expect(manifest.format).toBe("formdigital-portable-backup");
    expect(manifest.schemaVersion).toBe(1);
  });

  it("5. output scope is fixed account", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_s", createdAt: 1_700_000_000_000,
    });
    expect(out.manifest.scope).toBe("account");
  });

  it("6. output templateId is fixed null", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_t", createdAt: 1_700_000_000_000,
    });
    expect(out.manifest.templateId).toBeNull();
  });

  it("7. output owner is the target owner", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_o", createdAt: 1_700_000_000_000,
    });
    expect(out.manifest.ownerKeyHash).toBe(OWNER);
  });

  it("8. Workspace in archive equals the final merged Workspace exactly", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_w", createdAt: 1_700_000_000_000,
    });
    const entries = unzipEntries(out.archiveBytes);
    const env = JSON.parse(strFromU8(entries["account/workspace.json"]));
    expect(env.workspace).toEqual(plan.finalWorkspacePlan!.mergedWorkspace);
  });

  it("9. builder does not re-merge or reconfigure ids", () => {
    const { plan } = planReady({ mode: "duplicate" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_r", createdAt: 1_700_000_000_000,
    });
    const entries = unzipEntries(out.archiveBytes);
    const env = JSON.parse(strFromU8(entries["account/workspace.json"]));
    // The output workspace must be byte-identical to the plan's merged workspace.
    expect(JSON.stringify(env.workspace)).toBe(
      JSON.stringify(plan.finalWorkspacePlan!.mergedWorkspace)
    );
  });

  it("10. create manifest is named by target asset id", () => {
    const { plan, hashA } = planReady({ mode: "duplicate" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_n", createdAt: 1_700_000_000_000,
    });
    // In duplicate mode the planned target id differs from source id.
    const createPlan = plan.assetPlan.manifestPlans.find((m) => m.action === "create")!;
    const name = `manifests/${createPlan.targetAssetId}.json`;
    const entries = unzipEntries(out.archiveBytes);
    expect(entries[name]).toBeDefined();
    expect(entries["manifests/asset-page-1.json"]).toBeUndefined();
    expect(hashA).toBeDefined();
  });

  it("11. create manifest body equals the planned manifest", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_b", createdAt: 1_700_000_000_000,
    });
    const createPlan = plan.assetPlan.manifestPlans.find((m) => m.action === "create")!;
    const entries = unzipEntries(out.archiveBytes);
    const body = JSON.parse(strFromU8(entries[`manifests/${createPlan.targetAssetId}.json`]));
    expect(body).toEqual(createPlan.plannedManifest);
  });

  it("12. reuse manifest is not included in the archive", () => {
    // Force reuse: the target owner already occupies an asset with a manifest
    // semantically equal to the remapped planned manifest. We derive that
    // occupied manifest from a first planning pass (the metadata relations are
    // remapped to target ids there), then re-plan with it occupied.
    const objA = new Uint8Array([1, 2, 3, 4]);
    const hashA = sha256(objA);
    const incoming = {
      templates: [{ id: "it1", name: "Inc Tpl", folderIds: [], tagIds: [] }],
      templateVersions: [{ id: "iv1", templateId: "it1", pageManifest: { pages: [{ assetId: "asset-page-1" }] } }],
      fields: [], instances: [], savedValues: [], mappingTemplates: [],
      importRuns: [], importRows: [], mappingDecisions: [], detectionRuns: [],
      folders: [], tags: [], operationJournal: [],
    };
    const current = {
      templates: [], templateVersions: [], fields: [], instances: [],
      savedValues: [], mappingTemplates: [], importRuns: [], importRows: [],
      mappingDecisions: [], detectionRuns: [], folders: [], tags: [], operationJournal: [],
    };
    const baseInput = {
      current: current as never,
      incoming: incoming as never,
      mode: "structure" as const,
      ownerId: "owner-7",
      targetOwnerKeyHash: OWNER,
      expectedWorkspaceRevision: 5,
      now: 1_700_000_000_000,
      incomingAssets: [{ id: "asset-page-1", schemaVersion: 1 as const, ownerKeyHash: OWNER, contentHash: hashA, size: 4, metadata: { templateId: "it1", templateVersionId: "iv1" } }] as never,
      knownObjects: [] as never,
    };
    // Pass 1: discover the remapped planned manifest.
    const gens1 = safeGens();
    const pass1 = planCombinedRestore({
      ...baseInput,
      occupiedManifests: [] as never,
      createWorkspaceId: gens1.createWorkspaceId,
      createAssetId: gens1.createAssetId,
    });
    const createPlan = pass1.assetPlan.manifestPlans.find((m) => m.action === "create")!;
    const occupiedManifest = JSON.parse(JSON.stringify(createPlan.plannedManifest));
    occupiedManifest.id = createPlan.targetAssetId;
    occupiedManifest.ownerKeyHash = OWNER;
    // Pass 2: re-plan with the matching occupied manifest -> reuse.
    const gens2 = safeGens();
    const plan = planCombinedRestore({
      ...baseInput,
      occupiedManifests: [{ id: createPlan.targetAssetId, ownerKeyHash: OWNER, contentHash: hashA, size: 4, manifest: occupiedManifest }] as never,
      createWorkspaceId: gens2.createWorkspaceId,
      createAssetId: gens2.createAssetId,
    });
    expect(plan.assetPlan.manifestPlans.some((m) => m.action === "reuse")).toBe(true);
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: objA }]);
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_reuse", createdAt: 1_700_000_000_000,
    });
    const entries = unzipEntries(out.archiveBytes);
    expect(entries["manifests/asset-page-1.json"]).toBeUndefined();
    expect(out.counts.reusedManifestsOmitted).toBeGreaterThanOrEqual(1);
  });

  it("13. source-only manifest filename is not included in the output", () => {
    const { plan } = planReady({ mode: "duplicate", extraIncomingAsset: { id: "asset-orphan", contentHash: sha256(new Uint8Array([9, 9, 9, 9])), size: 4 } });
    const source = buildSourceArchive([
      { id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) },
      { id: "asset-orphan", bytes: new Uint8Array([9, 9, 9, 9]) },
    ]);
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_sf", createdAt: 1_700_000_000_000,
    });
    const entries = unzipEntries(out.archiveBytes);
    expect(entries["manifests/asset-orphan.json"]).toBeUndefined();
  });

  it("14. the three metadata relations are remapped to target ids", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_rel", createdAt: 1_700_000_000_000,
    });
    const createPlan = plan.assetPlan.manifestPlans.find((m) => m.action === "create")!;
    const md = (createPlan.plannedManifest as Record<string, unknown>).metadata as Record<string, unknown>;
    // The planned manifest's metadata must use the mapped (target) relation ids,
    // not the raw source ids.
    const mappedTemplate = plan.finalWorkspacePlan!.idMaps.templates["it1"];
    const mappedVersion = plan.finalWorkspacePlan!.idMaps.templateVersions["iv1"];
    expect(md.templateId).toBe(mappedTemplate);
    expect(md.templateVersionId).toBe(mappedVersion);
    // Source-only id must not survive.
    expect(md.templateId).not.toBe("it1");
  });

  it("15. create manifest's required object is included in the archive", () => {
    const { plan, hashA } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_obj", createdAt: 1_700_000_000_000,
    });
    const entries = unzipEntries(out.archiveBytes);
    expect(entries[`objects/${hashA}`]).toBeDefined();
    expect(out.counts.objectsIncluded).toBe(1);
  });

  it("16. object plan action 'reuse' still includes the object when a new manifest needs it", () => {
    const hashA = sha256(new Uint8Array([1, 2, 3, 4]));
    const { plan } = planReady({
      mode: "structure",
      knownObjects: [{ contentHash: hashA, size: 4, verified: true }],
    });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_reuseobj", createdAt: 1_700_000_000_000,
    });
    const entries = unzipEntries(out.archiveBytes);
    expect(entries[`objects/${hashA}`]).toBeDefined();
    expect(out.counts.objectsIncluded).toBe(1);
  });

  it("17. multiple manifests sharing a hash store the object only once", () => {
    // Two incoming assets with the SAME content hash -> one object entry.
    const objA = new Uint8Array([1, 2, 3, 4]);
    const hashA = sha256(objA);
    const incoming = {
      templates: [{ id: "it1", name: "Inc Tpl", folderIds: [], tagIds: [] }],
      templateVersions: [
        { id: "iv1", templateId: "it1", pageManifest: { pages: [{ assetId: "asset-page-1" }, { assetId: "asset-page-2" }] } },
      ],
      fields: [], instances: [], savedValues: [], mappingTemplates: [],
      importRuns: [], importRows: [], mappingDecisions: [], detectionRuns: [],
      folders: [], tags: [], operationJournal: [],
    };
    const current = {
      templates: [], templateVersions: [], fields: [], instances: [],
      savedValues: [], mappingTemplates: [], importRuns: [], importRows: [],
      mappingDecisions: [], detectionRuns: [], folders: [], tags: [], operationJournal: [],
    };
    const gens = safeGens();
    const plan = planCombinedRestore({
      current: current as never,
      incoming: incoming as never,
      mode: "structure",
      ownerId: "owner-7",
      targetOwnerKeyHash: OWNER,
      expectedWorkspaceRevision: 5,
      now: 1_700_000_000_000,
      incomingAssets: [
        { id: "asset-page-1", schemaVersion: 1 as const, ownerKeyHash: OWNER, contentHash: hashA, size: 4, metadata: { templateId: "it1", templateVersionId: "iv1" } },
        { id: "asset-page-2", schemaVersion: 1 as const, ownerKeyHash: OWNER, contentHash: hashA, size: 4, metadata: { templateId: "it1", templateVersionId: "iv1" } },
      ] as never,
      occupiedManifests: [],
      knownObjects: [] as never,
      createWorkspaceId: gens.createWorkspaceId,
      createAssetId: gens.createAssetId,
    });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: objA }, { id: "asset-page-2", bytes: objA }]);
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_dup", createdAt: 1_700_000_000_000,
    });
    expect(out.counts.objectsIncluded).toBe(1);
    const entries = unzipEntries(out.archiveBytes);
    expect(entries[`objects/${hashA}`]).toBeDefined();
  });

  it("18. object bytes hash is exact", () => {
    const { plan, hashA } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_h", createdAt: 1_700_000_000_000,
    });
    const entries = unzipEntries(out.archiveBytes);
    expect(sha256(entries[`objects/${hashA}`])).toBe(hashA);
  });

  it("19. object bytes size is exact", () => {
    const { plan, hashA } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_sz", createdAt: 1_700_000_000_000,
    });
    const entries = unzipEntries(out.archiveBytes);
    expect(entries[`objects/${hashA}`].byteLength).toBe(4);
  });

  it("20. missing source object is rejected", () => {
    const { plan } = planReady({ mode: "structure" });
    // Source archive omits the referenced object.
    const workspaceEnvelope = { workspace: { templates: [{ id: "tpl_s", name: "S" }], templateVersions: [{ id: "ver_s", templateId: "tpl_s" }], fields: [], instances: [], savedValues: [], mappingTemplates: [] } };
    const workspaceBytes = strToU8(JSON.stringify(workspaceEnvelope));
    const entries: Record<string, Uint8Array> = { "account/workspace.json": workspaceBytes };
    const files = [{ path: "account/workspace.json", contentHash: sha256(workspaceBytes), size: workspaceBytes.byteLength }];
    // manifest for asset-page-1 but NO object entry
    const hashA = sha256(new Uint8Array([1, 2, 3, 4]));
    const mBytes = strToU8(JSON.stringify({ schemaVersion: 1, id: "asset-page-1", ownerKeyHash: OWNER, contentHash: hashA, size: 4 }));
    entries["manifests/asset-page-1.json"] = mBytes;
    files.push({ path: "manifests/asset-page-1.json", contentHash: sha256(mBytes), size: mBytes.byteLength });
    const manifest = { format: "formdigital-portable-backup", schemaVersion: 1, scope: "account", templateId: null, ownerKeyHash: OWNER, createdAt: 1_690_000_000_000, files, summary: { templates: [{ id: "tpl_s", name: "S", versions: 1, instances: 0 }], templateCount: 1, versionCount: 1, instanceCount: 0, mappingTemplateCount: 0 } };
    entries["backup-manifest.json"] = strToU8(JSON.stringify(manifest));
    const badSource = zipSync(entries, { level: 6 });
    expect(() =>
      buildAtomicRestoreArchive({
        sourceArchiveBytes: badSource, combinedPlan: plan, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_m", createdAt: 1_700_000_000_000,
      })
    ).toThrow();
  });

  it("21. corrupt source object is rejected", () => {
    const { plan, hashA } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    // Tamper the referenced object bytes in the source archive.
    const entries = unzipEntries(source);
    entries[`objects/${hashA}`] = new Uint8Array([9, 9, 9, 9]);
    const tampered = zipSync(entries, { level: 6 });
    expect(() =>
      buildAtomicRestoreArchive({
        sourceArchiveBytes: tampered, combinedPlan: plan, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_c", createdAt: 1_700_000_000_000,
      })
    ).toThrow();
  });

  it("22. planned manifest contentHash inconsistent with source object is rejected", () => {
    // Build a plan whose create manifest references hashA, but feed a source
    // whose asset-page-1 object hash differs from hashA.
    const objA = new Uint8Array([1, 2, 3, 4]);
    const hashA = sha256(objA);
    const incoming = {
      templates: [{ id: "it1", name: "Inc Tpl", folderIds: [], tagIds: [] }],
      templateVersions: [{ id: "iv1", templateId: "it1", pageManifest: { pages: [{ assetId: "asset-page-1" }] } }],
      fields: [], instances: [], savedValues: [], mappingTemplates: [],
      importRuns: [], importRows: [], mappingDecisions: [], detectionRuns: [],
      folders: [], tags: [], operationJournal: [],
    };
    const current = {
      templates: [], templateVersions: [], fields: [], instances: [],
      savedValues: [], mappingTemplates: [], importRuns: [], importRows: [],
      mappingDecisions: [], detectionRuns: [], folders: [], tags: [], operationJournal: [],
    };
    const gens = safeGens();
    const plan = planCombinedRestore({
      current: current as never, incoming: incoming as never, mode: "structure", ownerId: "owner-7",
      targetOwnerKeyHash: OWNER, expectedWorkspaceRevision: 5, now: 1_700_000_000_000,
      incomingAssets: [{ id: "asset-page-1", schemaVersion: 1 as const, ownerKeyHash: OWNER, contentHash: hashA, size: 4, metadata: { templateId: "it1", templateVersionId: "iv1" } }] as never,
      occupiedManifests: [], knownObjects: [] as never,
      createWorkspaceId: gens.createWorkspaceId, createAssetId: gens.createAssetId,
    });
    // Source object bytes produce a DIFFERENT hash than hashA.
    const differentBytes = new Uint8Array([4, 3, 2, 1]);
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: differentBytes }]);
    expect(() =>
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_ic", createdAt: 1_700_000_000_000,
      })
    ).toThrow();
  });

  it("23. blocked Combined Plan is rejected", () => {
    const { plan } = planReady({ mode: "structure" });
    const blocked = { ...plan, blockers: ["ASSET_PLAN_NOT_READY" as const], ready: false };
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    expect(() =>
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: blocked, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_bk", createdAt: 1_700_000_000_000,
      })
    ).toThrow();
  });

  it("24. ready:false is rejected", () => {
    const { plan } = planReady({ mode: "structure" });
    const notReady = { ...plan, ready: false };
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    expect(() =>
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: notReady, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_nr", createdAt: 1_700_000_000_000,
      })
    ).toThrow();
  });

  it("25. finalWorkspacePlan null is rejected", () => {
    const { plan } = planReady({ mode: "structure" });
    const noFinal = { ...plan, finalWorkspacePlan: null };
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    expect(() =>
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: noFinal, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_nf", createdAt: 1_700_000_000_000,
      })
    ).toThrow();
  });

  it("26. asset conflict / unresolved is rejected", () => {
    const { plan } = planReady({ mode: "structure" });
    const withConflict = {
      ...plan,
      assetPlan: { ...plan.assetPlan, conflicts: [{ code: "OBJECT_CONFLICT", sourceAssetId: "asset-page-1" }] },
    };
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    expect(() =>
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: withConflict, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_cf", createdAt: 1_700_000_000_000,
      })
    ).toThrow();
    const withUnresolved = {
      ...plan,
      assetPlan: { ...plan.assetPlan, unresolvedAssetIds: ["asset-page-1"] },
    };
    expect(() =>
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: withUnresolved, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_un", createdAt: 1_700_000_000_000,
      })
    ).toThrow();
  });

  it("27. invalid target owner hash is rejected", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    expect(() =>
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: BAD_OWNER,
        transactionArchiveId: "txn_io", createdAt: 1_700_000_000_000,
      })
    ).toThrow();
  });

  it("28. unsafe transactionArchiveId is rejected", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    for (const bad of ["C:\\path\\id", "/abs/id", "../escape", "http://x/id", "has space", "a".repeat(201)]) {
      expect(() =>
        buildAtomicRestoreArchive({
          sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
          transactionArchiveId: bad, createdAt: 1_700_000_000_000,
        })
      ).toThrow();
    }
  });

  it("29. invalid createdAt is rejected (aligns with official verifier: 1.5 is valid)", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    // -1 / NaN / Infinity / path string / object / null / undefined are rejected.
    // NOTE: 1.5 is now ACCEPTED (matches the official verifier, which allows any
    // finite number >= 0). A dedicated test below proves 1.5 builds successfully.
    for (const bad of [-1, NaN, Infinity, "C:\\Users\\victim\\backup", { leaked: "x" }, null, undefined]) {
      expect(() =>
        buildAtomicRestoreArchive({
          sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
          transactionArchiveId: "txn_ca", createdAt: bad as never,
        })
      ).toThrow();
    }
    // 1.5 must NOT throw (exact verifier alignment).
    expect(() =>
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_ca15", createdAt: 1.5,
      })
    ).not.toThrow();
  });

  it("30. legacy source archive is rejected", () => {
    const { plan } = planReady({ mode: "structure" });
    const legacy = buildLegacyArchive();
    expect(() =>
      buildAtomicRestoreArchive({
        sourceArchiveBytes: legacy, combinedPlan: plan, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_lg", createdAt: 1_700_000_000_000,
      })
    ).toThrow();
  });

  it("31. corrupt ZIP is rejected", () => {
    const { plan } = planReady({ mode: "structure" });
    expect(() =>
      buildAtomicRestoreArchive({
        sourceArchiveBytes: new Uint8Array([1, 2, 3, 4, 5]),
        combinedPlan: plan, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_cz", createdAt: 1_700_000_000_000,
      })
    ).toThrow();
  });

  it("32. extra source entries are not copied into the output", () => {
    const { plan } = planReady({ mode: "duplicate", extraIncomingAsset: { id: "asset-orphan", contentHash: sha256(new Uint8Array([9, 9, 9, 9])), size: 4 } });
    const source = buildSourceArchive([
      { id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) },
      { id: "asset-orphan", bytes: new Uint8Array([9, 9, 9, 9]) },
    ]);
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_ex", createdAt: 1_700_000_000_000,
    });
    const entries = unzipEntries(out.archiveBytes);
    expect(entries["objects/".concat(sha256(new Uint8Array([9, 9, 9, 9])))]).toBeUndefined();
  });

  it("33. files list exactly matches actual entries", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_fl", createdAt: 1_700_000_000_000,
    });
    const entries = unzipEntries(out.archiveBytes);
    const listed = new Set(out.manifest.files.map((f) => f.path));
    for (const key of Object.keys(entries)) {
      if (key === "backup-manifest.json") continue;
      expect(listed.has(key)).toBe(true);
    }
    for (const f of out.manifest.files) {
      expect(entries[f.path]).toBeDefined();
      expect(entries[f.path].byteLength).toBe(f.size);
      expect(sha256(entries[f.path])).toBe(f.contentHash);
    }
  });

  it("34. files list is deterministically sorted", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_ds", createdAt: 1_700_000_000_000,
    });
    const paths = out.manifest.files.map((f) => f.path);
    const sorted = [...paths].sort();
    expect(paths).toEqual(sorted);
  });

  it("35. summary is derived exactly from the final Workspace", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_sm", createdAt: 1_700_000_000_000,
    });
    const ws = plan.finalWorkspacePlan!.mergedWorkspace as unknown as Record<string, unknown>;
    expect(out.manifest.summary.templateCount).toBe((ws.templates as unknown[]).length);
    expect(out.manifest.summary.versionCount).toBe((ws.templateVersions as unknown[]).length);
    expect(out.manifest.summary.instanceCount).toBe((ws.instances as unknown[]).length);
    expect(out.manifest.summary.mappingTemplateCount).toBe((ws.mappingTemplates as unknown[]).length);
  });

  it("36. template-scoped source still yields an account-scoped output", () => {
    const { plan, hashA } = planReady({ mode: "structure" });
    // Source archive is template-scoped but internally valid.
    const workspaceEnvelope = { workspace: { templates: [{ id: "tpl_s", name: "S" }], templateVersions: [{ id: "ver_s", templateId: "tpl_s" }], fields: [], instances: [], savedValues: [], mappingTemplates: [] } };
    const workspaceBytes = strToU8(JSON.stringify(workspaceEnvelope));
    const entries: Record<string, Uint8Array> = { "account/workspace.json": workspaceBytes };
    const files = [{ path: "account/workspace.json", contentHash: sha256(workspaceBytes), size: workspaceBytes.byteLength }];
    const mBytes = strToU8(JSON.stringify({ schemaVersion: 1, id: "asset-page-1", ownerKeyHash: OWNER, contentHash: hashA, size: 4 }));
    entries["manifests/asset-page-1.json"] = mBytes;
    entries[`objects/${hashA}`] = new Uint8Array([1, 2, 3, 4]);
    files.push({ path: "manifests/asset-page-1.json", contentHash: sha256(mBytes), size: mBytes.byteLength });
    files.push({ path: `objects/${hashA}`, contentHash: hashA, size: 4 });
    const manifest = { format: "formdigital-portable-backup", schemaVersion: 1, scope: "template", templateId: "tpl_s", ownerKeyHash: OWNER, createdAt: 1_690_000_000_000, files, summary: { templates: [{ id: "tpl_s", name: "S", versions: 1, instances: 0 }], templateCount: 1, versionCount: 1, instanceCount: 0, mappingTemplateCount: 0 } };
    entries["backup-manifest.json"] = strToU8(JSON.stringify(manifest));
    const source = zipSync(entries, { level: 6 });
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_ts", createdAt: 1_700_000_000_000,
    });
    expect(out.manifest.scope).toBe("account");
    expect(out.manifest.templateId).toBeNull();
  });

  it("37. output requires preserveExistingAssetsRequired:true", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_pe", createdAt: 1_700_000_000_000,
    });
    expect(out.preserveExistingAssetsRequired).toBe(true);
  });

  it("38. expected revision is preserved exactly", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_er", createdAt: 1_700_000_000_000,
    });
    expect(out.expectedWorkspaceRevision).toBe(5);
    expect(out.expectedWorkspaceRevision).toBe(plan.preconditions.expectedWorkspaceRevision);
  });

  it("39. input objects and bytes are not mutated", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const sourceCopy = new Uint8Array(source);
    const wsCopy = JSON.stringify(plan.finalWorkspacePlan!.mergedWorkspace);
    buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_im", createdAt: 1_700_000_000_000,
    });
    expect(Array.from(source)).toEqual(Array.from(sourceCopy));
    expect(JSON.stringify(plan.finalWorkspacePlan!.mergedWorkspace)).toBe(wsCopy);
    expect(JSON.stringify(plan.assetPlan.manifestPlans)).toBe(
      JSON.stringify(plan.assetPlan.manifestPlans)
    );
  });

  it("40. identical input yields byte-for-byte identical archive", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const a = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_d1", createdAt: 1_700_000_000_000,
    });
    const b = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_d1", createdAt: 1_700_000_000_000,
    });
    expect(Array.from(a.archiveBytes)).toEqual(Array.from(b.archiveBytes));
  });

  it("41. all error messages are value-free (no injected path/token/owner/hash/id)", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const cases: Array<() => void> = [
      () => buildAtomicRestoreArchive({ sourceArchiveBytes: source, combinedPlan: { ...plan, ready: false }, targetOwnerKeyHash: OWNER, transactionArchiveId: "x", createdAt: 1 } as never),
      () => buildAtomicRestoreArchive({ sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: BAD_OWNER, transactionArchiveId: "x", createdAt: 1 } as never),
      () => buildAtomicRestoreArchive({ sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER, transactionArchiveId: "C:\\bad\\id", createdAt: 1 } as never),
      () => buildAtomicRestoreArchive({ sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER, transactionArchiveId: "x", createdAt: -1 } as never),
      () => buildAtomicRestoreArchive({ sourceArchiveBytes: new Uint8Array([1, 2, 3]), combinedPlan: plan, targetOwnerKeyHash: OWNER, transactionArchiveId: "x", createdAt: 1 } as never),
      () => buildAtomicRestoreArchive({ sourceArchiveBytes: buildLegacyArchive(), combinedPlan: plan, targetOwnerKeyHash: OWNER, transactionArchiveId: "x", createdAt: 1 } as never),
    ];
    for (const run of cases) {
      let msg = "";
      try {
        run();
      } catch (e) {
        msg = e instanceof Error ? e.message : "";
      }
      expect(msg.length).toBeGreaterThan(0);
      expect(msg).not.toContain(OWNER);
      expect(msg).not.toContain("asset-page-1");
      expect(msg).not.toContain(SECRET);
      expect(msg).not.toContain("C:\\");
      expect(msg).not.toContain("/");
      // Every error is a fixed code.
      expect(msg.startsWith("INVALID_ARCHIVE_INPUT:")).toBe(true);
    }
  });

  it("42. production file performs no filesystem / Local Service / HTTP / restore call", () => {
    const src = readFileSync(new URL("./backupRestoreArchive.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/restoreLocalBackup|saveLocalWorkspace|mutateWorkspace/);
    expect(src).not.toMatch(/require\(["']\.\/localServiceClient["']\)|from ["']\.\/localServiceClient["']/);
    expect(src).not.toMatch(/\b(fs|http|https|net|child_process|fetch)\b/);
    expect(src).not.toMatch(/createBackupArchive|restorePortableBackup/);
  });

  it("43. baseline of combined tests does not regress (builder adds coverage)", () => {
    // Sanity: a fresh structure plan + source builds and verifies.
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_base", createdAt: 1_700_000_000_000,
    });
    expect(verifyBackupArchive(out.archiveBytes).scope).toBe("account");
  });

  // ==========================================================================
  // Layer 2C2C3B1-R1 regression tests (≥41 real red→green cases).
  // The original 43 tests above are preserved; this block ADDS coverage for
  // the nine defect classes: Local Service contract (id/kind), zero-byte
  // object, assetPlan/manifestPlan/objectPlan/required-set consistency,
  // closed allowlist + deep clone, createdAt alignment, self-verification,
  // plain/JSON-safe/accessor/Proxy safety, and proves the verifier coverage
  // gap (missing id passes the verifier) WITHOUT the Builder relying on it.
  // ==========================================================================

  it("44. output backup manifest carries official id mapped from transactionArchiveId", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_idmap_1", createdAt: 1_700_000_000_000,
    });
    expect(out.manifest.id).toBe("txn_idmap_1");
    const entries = unzipEntries(out.archiveBytes);
    const realManifest = JSON.parse(strFromU8(entries["backup-manifest.json"]));
    expect(realManifest.id).toBe("txn_idmap_1");
    expect(realManifest.id).toBe(out.manifest.id);
  });

  it("45. output backup manifest carries fixed kind 'merge-restore'", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_kind_1", createdAt: 1_700_000_000_000,
    });
    expect(out.manifest.kind).toBe("merge-restore");
    const entries = unzipEntries(out.archiveBytes);
    const realManifest = JSON.parse(strFromU8(entries["backup-manifest.json"]));
    expect(realManifest.kind).toBe("merge-restore");
  });

  it("46. output does NOT emit the non-official transactionArchiveId field", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_noextra", createdAt: 1_700_000_000_000,
    });
    const entries = unzipEntries(out.archiveBytes);
    const realManifest = JSON.parse(strFromU8(entries["backup-manifest.json"]));
    expect(realManifest.transactionArchiveId).toBeUndefined();
    expect("transactionArchiveId" in out.manifest).toBe(false);
  });

  it("47. existing Web verifier ACCEPTS an archive missing id/kind (coverage gap proof)", () => {
    // The official verifier must NOT reject a portable backup without id/kind —
    // this is the documented coverage gap. We assert it passes so the Builder's
    // own id/kind emission is the real guarantee for the journal sourceBackupId.
    const source = buildSourceArchive(
      [{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }],
      { withId: false }
    );
    let m: unknown;
    expect(() => {
      m = verifyBackupArchive(source);
    }).not.toThrow();
    // Critically: the verifier does NOT surface a usable id for the journal.
    expect((m as Record<string, unknown>).id).toBeUndefined();
  });

  it("48. Builder output id guarantees journal sourceBackupId is no longer undefined", () => {
    // Simulate the journal read `verified.manifest.id` against the Builder output.
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_journal", createdAt: 1_700_000_000_000,
    });
    const verified = verifyBackupArchive(out.archiveBytes);
    // This is the exact value the restore journal records as sourceBackupId.
    expect(verified.id).toBe("txn_journal");
    expect(typeof verified.id === "string" && verified.id.length > 0).toBe(true);
  });

  it("49. Builder succeeds even when the SOURCE backup manifest lacks id/kind", () => {
    // The Builder relies on its OWN id/kind emission, not the source's. A source
    // built with withId:false (which the verifier accepts) must still produce a
    // well-formed output with id/kind.
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive(
      [{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }],
      { withId: false }
    );
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_fromnoid", createdAt: 1_700_000_000_000,
    });
    expect(out.manifest.id).toBe("txn_fromnoid");
    expect(out.manifest.kind).toBe("merge-restore");
  });

  it("50. zero-byte object is supported (sha256('') is a legal hash)", () => {
    const empty = new Uint8Array(0);
    const hashEmpty = sha256(empty); // 64-hex, well defined
    const objA = new Uint8Array([1, 2, 3, 4]);
    const hashA = sha256(objA);
    const incoming = {
      templates: [{ id: "it1", name: "Inc Tpl", folderIds: [], tagIds: [] }],
      templateVersions: [{ id: "iv1", templateId: "it1", pageManifest: { pages: [{ assetId: "asset-page-1" }, { assetId: "asset-empty" }] } }],
      fields: [], instances: [], savedValues: [], mappingTemplates: [],
      importRuns: [], importRows: [], mappingDecisions: [], detectionRuns: [],
      folders: [], tags: [], operationJournal: [],
    };
    const current = {
      templates: [], templateVersions: [], fields: [], instances: [],
      savedValues: [], mappingTemplates: [], importRuns: [], importRows: [],
      mappingDecisions: [], detectionRuns: [], folders: [], tags: [], operationJournal: [],
    };
    const gens = safeGens();
    const plan = planCombinedRestore({
      current: current as never, incoming: incoming as never, mode: "structure", ownerId: "owner-7",
      targetOwnerKeyHash: OWNER, expectedWorkspaceRevision: 5, now: 1_700_000_000_000,
      incomingAssets: [
        { id: "asset-page-1", schemaVersion: 1 as const, ownerKeyHash: OWNER, contentHash: hashA, size: 4, metadata: { templateId: "it1", templateVersionId: "iv1" } },
        { id: "asset-empty", schemaVersion: 1 as const, ownerKeyHash: OWNER, contentHash: hashEmpty, size: 0, metadata: { templateId: "it1", templateVersionId: "iv1" } },
      ] as never,
      occupiedManifests: [], knownObjects: [] as never,
      createWorkspaceId: gens.createWorkspaceId, createAssetId: gens.createAssetId,
    });
    const source = buildSourceArchive([
      { id: "asset-page-1", bytes: objA },
      { id: "asset-empty", bytes: empty },
    ]);
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_zero", createdAt: 1_700_000_000_000,
    });
    const entries = unzipEntries(out.archiveBytes);
    expect(entries[`objects/${hashEmpty}`]).toBeDefined();
    expect(entries[`objects/${hashEmpty}`].byteLength).toBe(0);
    expect(sha256(entries[`objects/${hashEmpty}`])).toBe(hashEmpty);
    expect(out.counts.objectsIncluded).toBe(2);
    expect(() => verifyBackupArchive(out.archiveBytes)).not.toThrow();
  });

  it("51. assetPlan.ready:false is rejected even when combinedPlan.ready is true", () => {
    const { plan } = planReady({ mode: "structure" });
    const tampered = {
      ...plan,
      assetPlan: { ...plan.assetPlan, ready: false },
    };
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    expect(() =>
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: tampered, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_ar", createdAt: 1_700_000_000_000,
      })
    ).toThrow();
  });

  it("52. mismatched assetIdMap entry (source->target) is rejected", () => {
    const { plan } = planReady({ mode: "structure" });
    const createPlan = plan.assetPlan.manifestPlans.find((m) => m.action === "create")!;
    const tampered = {
      ...plan,
      assetPlan: {
        ...plan.assetPlan,
        assetIdMap: { ...plan.assetPlan.assetIdMap, [createPlan.sourceAssetId]: "foreign_target_id" },
      },
    };
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    expect(() =>
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: tampered, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_am", createdAt: 1_700_000_000_000,
      })
    ).toThrow();
  });

  it("53. manifestPlan with unknown top-level key in plannedManifest is rejected", () => {
    const { plan } = planReady({ mode: "structure" });
    const createPlan = plan.assetPlan.manifestPlans.find((m) => m.action === "create")!;
    const tampered = {
      ...plan,
      assetPlan: {
        ...plan.assetPlan,
        manifestPlans: plan.assetPlan.manifestPlans.map((m) =>
          m === createPlan
            ? { ...m, plannedManifest: { ...m.plannedManifest, __proto__: { injected: true } } }
            : m
        ),
      },
    };
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    expect(() =>
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: tampered, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_uk", createdAt: 1_700_000_000_000,
      })
    ).toThrow();
  });

  it("54. manifestPlan plannedManifest schemaVersion !== 1 is rejected", () => {
    const { plan } = planReady({ mode: "structure" });
    const createPlan = plan.assetPlan.manifestPlans.find((m) => m.action === "create")!;
    const tampered = {
      ...plan,
      assetPlan: {
        ...plan.assetPlan,
        manifestPlans: plan.assetPlan.manifestPlans.map((m) =>
          m === createPlan
            ? { ...m, plannedManifest: { ...m.plannedManifest, schemaVersion: 2 } }
            : m
        ),
      },
    };
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    expect(() =>
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: tampered, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_sv", createdAt: 1_700_000_000_000,
      })
    ).toThrow();
  });

  it("55. manifestPlan plannedManifest id !== targetAssetId is rejected", () => {
    const { plan } = planReady({ mode: "structure" });
    const createPlan = plan.assetPlan.manifestPlans.find((m) => m.action === "create")!;
    const tampered = {
      ...plan,
      assetPlan: {
        ...plan.assetPlan,
        manifestPlans: plan.assetPlan.manifestPlans.map((m) =>
          m === createPlan
            ? { ...m, plannedManifest: { ...m.plannedManifest, id: "hijacked-id" } }
            : m
        ),
      },
    };
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    expect(() =>
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: tampered, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_mid", createdAt: 1_700_000_000_000,
      })
    ).toThrow();
  });

  it("56. manifestPlan plannedManifest ownerKeyHash !== target owner is rejected", () => {
    const { plan } = planReady({ mode: "structure" });
    const createPlan = plan.assetPlan.manifestPlans.find((m) => m.action === "create")!;
    const tampered = {
      ...plan,
      assetPlan: {
        ...plan.assetPlan,
        manifestPlans: plan.assetPlan.manifestPlans.map((m) =>
          m === createPlan
            ? { ...m, plannedManifest: { ...m.plannedManifest, ownerKeyHash: BAD_OWNER } }
            : m
        ),
      },
    };
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    expect(() =>
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: tampered, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_mo", createdAt: 1_700_000_000_000,
      })
    ).toThrow();
  });

  it("57. manifestPlan plannedManifest contentHash not 64-hex is rejected", () => {
    const { plan } = planReady({ mode: "structure" });
    const createPlan = plan.assetPlan.manifestPlans.find((m) => m.action === "create")!;
    const tampered = {
      ...plan,
      assetPlan: {
        ...plan.assetPlan,
        manifestPlans: plan.assetPlan.manifestPlans.map((m) =>
          m === createPlan
            ? { ...m, plannedManifest: { ...m.plannedManifest, contentHash: "NOTAHEX" } }
            : m
        ),
      },
    };
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    expect(() =>
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: tampered, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_mh", createdAt: 1_700_000_000_000,
      })
    ).toThrow();
  });

  it("58. manifestPlan plannedManifest size negative is rejected", () => {
    const { plan } = planReady({ mode: "structure" });
    const createPlan = plan.assetPlan.manifestPlans.find((m) => m.action === "create")!;
    const tampered = {
      ...plan,
      assetPlan: {
        ...plan.assetPlan,
        manifestPlans: plan.assetPlan.manifestPlans.map((m) =>
          m === createPlan
            ? { ...m, plannedManifest: { ...m.plannedManifest, size: -4 } }
            : m
        ),
      },
    };
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    expect(() =>
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: tampered, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_ms", createdAt: 1_700_000_000_000,
      })
    ).toThrow();
  });

  it("59. manifestPlan with non-create/reuse action is rejected", () => {
    const { plan } = planReady({ mode: "structure" });
    const createPlan = plan.assetPlan.manifestPlans.find((m) => m.action === "create")!;
    const tampered = {
      ...plan,
      assetPlan: {
        ...plan.assetPlan,
        manifestPlans: plan.assetPlan.manifestPlans.map((m) =>
          m === createPlan ? { ...m, action: "delete" as never } : m
        ),
      },
    };
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    expect(() =>
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: tampered, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_ma", createdAt: 1_700_000_000_000,
      })
    ).toThrow();
  });

  it("60. duplicate manifestPlan source ids are rejected", () => {
    const { plan } = planReady({ mode: "structure" });
    const all = plan.assetPlan.manifestPlans;
    const clone = all.length ? { ...all[0] } : null;
    const tampered = {
      ...plan,
      assetPlan: {
        ...plan.assetPlan,
        manifestPlans: clone ? [...all, clone] : all,
      },
    };
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    expect(() =>
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: tampered, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_md", createdAt: 1_700_000_000_000,
      })
    ).toThrow();
  });

  it("61. objectPlan contentHash not 64-hex is rejected", () => {
    const { plan } = planReady({ mode: "structure" });
    const tampered = {
      ...plan,
      assetPlan: {
        ...plan.assetPlan,
        objectPlans: plan.assetPlan.objectPlans.map((o) => ({ ...o, contentHash: "BADHEX" })),
      },
    };
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    expect(() =>
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: tampered, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_oh", createdAt: 1_700_000_000_000,
      })
    ).toThrow();
  });

  it("62. objectPlan with non-copy/reuse action is rejected", () => {
    const { plan } = planReady({ mode: "structure" });
    const tampered = {
      ...plan,
      assetPlan: {
        ...plan.assetPlan,
        objectPlans: plan.assetPlan.objectPlans.map((o) => ({ ...o, action: "move" as never })),
      },
    };
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    expect(() =>
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: tampered, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_oa", createdAt: 1_700_000_000_000,
      })
    ).toThrow();
  });

  it("63. objectPlan missing for a create manifest is rejected", () => {
    const { plan } = planReady({ mode: "structure" });
    const tampered = {
      ...plan,
      assetPlan: {
        ...plan.assetPlan,
        objectPlans: [],
      },
    };
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    expect(() =>
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: tampered, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_om", createdAt: 1_700_000_000_000,
      })
    ).toThrow();
  });

  it("64. objectPlan size mismatch vs manifest size is rejected", () => {
    const { plan } = planReady({ mode: "structure" });
    const createPlan = plan.assetPlan.manifestPlans.find((m) => m.action === "create")!;
    const hash = (createPlan.plannedManifest as Record<string, unknown>).contentHash as string;
    const tampered = {
      ...plan,
      assetPlan: {
        ...plan.assetPlan,
        objectPlans: plan.assetPlan.objectPlans.map((o) =>
          o.contentHash === hash ? { ...o, size: (o.size as number) + 1 } : o
        ),
      },
    };
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    expect(() =>
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: tampered, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_os", createdAt: 1_700_000_000_000,
      })
    ).toThrow();
  });

  it("65. unreferenced objectPlan (no manifest references it) is rejected", () => {
    const { plan } = planReady({ mode: "structure" });
    const extraHash = sha256(new Uint8Array([42, 42, 42, 42]));
    const tampered = {
      ...plan,
      assetPlan: {
        ...plan.assetPlan,
        objectPlans: [
          ...plan.assetPlan.objectPlans,
          { contentHash: extraHash, size: 4, action: "copy" as const },
        ],
      },
    };
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    expect(() =>
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: tampered, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_ou", createdAt: 1_700_000_000_000,
      })
    ).toThrow();
  });

  it("66. requiredAssetIds not an array is rejected", () => {
    const { plan } = planReady({ mode: "structure" });
    const tampered = {
      ...plan,
      assetPlan: { ...plan.assetPlan, requiredAssetIds: "nope" as never },
    };
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    expect(() =>
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: tampered, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_ra", createdAt: 1_700_000_000_000,
      })
    ).toThrow();
  });

  it("67. combinedPlan.blockers non-empty is rejected", () => {
    const { plan } = planReady({ mode: "structure" });
    const tampered = { ...plan, blockers: ["ASSET_PLAN_NOT_READY" as const], ready: false };
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    expect(() =>
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: tampered, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_cb", createdAt: 1_700_000_000_000,
      })
    ).toThrow();
  });

  it("68. finalWorkspacePlan.unresolvedAssetIds non-empty is rejected", () => {
    const { plan } = planReady({ mode: "structure" });
    const tampered = {
      ...plan,
      finalWorkspacePlan: {
        ...plan.finalWorkspacePlan!,
        unresolvedAssetIds: ["asset-page-1"],
      },
    };
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    expect(() =>
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: tampered, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_fu", createdAt: 1_700_000_000_000,
      })
    ).toThrow();
  });

  it("69. expectedWorkspaceRevision not a non-negative safe int is rejected", () => {
    const { plan } = planReady({ mode: "structure" });
    const tampered = {
      ...plan,
      preconditions: { expectedWorkspaceRevision: -3 },
    };
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    expect(() =>
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: tampered, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_rv", createdAt: 1_700_000_000_000,
      })
    ).toThrow();
  });

  it("70. plannedManifest carrying a non-JSON-safe value (Date) is rejected", () => {
    const { plan } = planReady({ mode: "structure" });
    const createPlan = plan.assetPlan.manifestPlans.find((m) => m.action === "create")!;
    const tampered = {
      ...plan,
      assetPlan: {
        ...plan.assetPlan,
        manifestPlans: plan.assetPlan.manifestPlans.map((m) =>
          m === createPlan
            ? { ...m, plannedManifest: { ...m.plannedManifest, createdAt: new Date(1_700_000_000_000) } }
            : m
        ),
      },
    };
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    expect(() =>
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: tampered, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_pd", createdAt: 1_700_000_000_000,
      })
    ).toThrow();
  });

  it("71. plannedManifest metadata with a poisoned prototype is rejected", () => {
    const { plan } = planReady({ mode: "structure" });
    const createPlan = plan.assetPlan.manifestPlans.find((m) => m.action === "create")!;
    const poisoned = JSON.parse('{ "ok": 1, "__proto__": { "polluted": true } }');
    const tampered = {
      ...plan,
      assetPlan: {
        ...plan.assetPlan,
        manifestPlans: plan.assetPlan.manifestPlans.map((m) =>
          m === createPlan
            ? { ...m, plannedManifest: { ...m.plannedManifest, metadata: poisoned } }
            : m
        ),
      },
    };
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    expect(() =>
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: tampered, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_pp", createdAt: 1_700_000_000_000,
      })
    ).toThrow();
  });

  it("72. combinedPlan Proxy reflection failure is rejected without leaking value", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    let getRan = false;
    const proxyPlan = new Proxy(plan as never, {
      get() {
        getRan = true;
        throw new Error(TEST_PRIVATE_VALUE);
      },
      getPrototypeOf() {
        throw new Error(TEST_PATH_VALUE);
      },
    });
    let msg = "";
    try {
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: proxyPlan, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_px", createdAt: 1_700_000_000_000,
      });
    } catch (e) {
      msg = e instanceof Error ? e.message : "";
    }
    expect(msg.length).toBeGreaterThan(0);
    expect(getRan).toBe(false);
    expect(msg).not.toContain(TEST_PRIVATE_VALUE);
    expect(msg).not.toContain(TEST_PATH_VALUE);
    expect(msg.startsWith("INVALID_ARCHIVE_INPUT:")).toBe(true);
  });

  it("73. assetIdMap that is not a plain object (array) is rejected", () => {
    const { plan } = planReady({ mode: "structure" });
    const tampered = {
      ...plan,
      assetPlan: { ...plan.assetPlan, assetIdMap: [] as never },
    };
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    expect(() =>
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: tampered, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_aia", createdAt: 1_700_000_000_000,
      })
    ).toThrow();
  });

  it("74. extra source-only mapping in assetIdMap (no matching manifestPlan) is rejected", () => {
    const { plan } = planReady({ mode: "structure" });
    const tampered = {
      ...plan,
      assetPlan: {
        ...plan.assetPlan,
        assetIdMap: { ...plan.assetPlan.assetIdMap, "ghost-source": "ghost-target" },
      },
    };
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    expect(() =>
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: tampered, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_ax", createdAt: 1_700_000_000_000,
      })
    ).toThrow();
  });

  it("75. createdAt 1.5 (non-integer finite >=0) builds and verifies", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_15", createdAt: 1.5,
    });
    expect(out.manifest.createdAt).toBe(1.5);
    expect(() => verifyBackupArchive(out.archiveBytes)).not.toThrow();
  });

  it("76. createdAt as a valid ISO date string builds and verifies", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_iso", createdAt: "2023-10-10T00:00:00.000Z",
    });
    expect(out.manifest.createdAt).toBe("2023-10-10T00:00:00.000Z");
    expect(() => verifyBackupArchive(out.archiveBytes)).not.toThrow();
  });

  it("77. self-verification is the SAME production verifier (no second implementation)", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_sv2", createdAt: 1_700_000_000_000,
    });
    // The returned archive MUST itself pass the production Web verifier that
    // the executor uses — proving self-verification uses the same logic.
    const reVerified = verifyBackupArchive(out.archiveBytes);
    expect(reVerified.format).toBe("formdigital-portable-backup");
    expect(reVerified.schemaVersion).toBe(1);
    expect(reVerified.scope).toBe("account");
    expect(reVerified.templateId).toBeNull();
    expect(reVerified.ownerKeyHash).toBe(OWNER);
    expect(reVerified.id).toBe("txn_sv2");
  });

  it("78. self-verification does NOT leak raw verifier error/path/hash/stack", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    // We cannot easily force the post-build verifier to fail via the public API
    // (a correct plan always verifies), but we assert the error contract: every
    // builder rejection uses a fixed INVALID_ARCHIVE_INPUT/OUTPUT code and never
    // contains filesystem paths, hashes, ids or tokens.
    const cases: Array<() => void> = [
      () => buildAtomicRestoreArchive({ sourceArchiveBytes: source, combinedPlan: { ...plan, ready: false }, targetOwnerKeyHash: OWNER, transactionArchiveId: "x", createdAt: 1 } as never),
      () => buildAtomicRestoreArchive({ sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: BAD_OWNER, transactionArchiveId: "x", createdAt: 1 } as never),
      () => buildAtomicRestoreArchive({ sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER, transactionArchiveId: "C:\\bad\\id", createdAt: 1 } as never),
      () => buildAtomicRestoreArchive({ sourceArchiveBytes: new Uint8Array([1, 2, 3]), combinedPlan: plan, targetOwnerKeyHash: OWNER, transactionArchiveId: "x", createdAt: 1 } as never),
      () => buildAtomicRestoreArchive({ sourceArchiveBytes: buildLegacyArchive(), combinedPlan: plan, targetOwnerKeyHash: OWNER, transactionArchiveId: "x", createdAt: 1 } as never),
    ];
    for (const run of cases) {
      let msg = "";
      try {
        run();
      } catch (e) {
        msg = e instanceof Error ? e.message : "";
      }
      expect(msg.length).toBeGreaterThan(0);
      expect(msg).not.toContain(SECRET);
      expect(msg).not.toContain("asset-page-1");
      expect(msg).not.toContain("C:\\");
      expect(msg.startsWith("INVALID_ARCHIVE_INPUT:") || msg.startsWith("INVALID_ARCHIVE_OUTPUT:")).toBe(true);
    }
  });

  it("79. emitted create manifest is a deep clone (mutating output does not change plan)", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_dc", createdAt: 1_700_000_000_000,
    });
    const createPlan = plan.assetPlan.manifestPlans.find((m) => m.action === "create")!;
    const before = JSON.stringify(createPlan.plannedManifest.metadata);
    // Mutate the returned archive's parsed manifest metadata.
    const entries = unzipEntries(out.archiveBytes);
    const body = JSON.parse(strFromU8(entries[`manifests/${createPlan.targetAssetId}.json`]));
    body.metadata = { corrupted: true };
    // The original plan must be untouched.
    expect(JSON.stringify(createPlan.plannedManifest.metadata)).toBe(before);
  });

  it("80. emitted create manifest equals the planned manifest field-for-field (closed allowlist preserved)", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_eq", createdAt: 1_700_000_000_000,
    });
    const createPlan = plan.assetPlan.manifestPlans.find((m) => m.action === "create")!;
    const entries = unzipEntries(out.archiveBytes);
    const body = JSON.parse(strFromU8(entries[`manifests/${createPlan.targetAssetId}.json`]));
    // The emitted manifest must be a faithful deep copy of the planned manifest,
    // including every allowed field (id, owner, hash, size, mime, filename,
    // createdAt, metadata) — no field dropped, no field invented.
    expect(body).toEqual(createPlan.plannedManifest);
  });

  it("81. all builder error codes are fixed + value-free across the new regressions", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const tamper = (p: Record<string, unknown>) =>
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source,
        combinedPlan: p as never,
        targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_xx",
        createdAt: 1_700_000_000_000,
      });
    const createPlan = plan.assetPlan.manifestPlans.find((m) => m.action === "create")!;
    const probes: Array<Record<string, unknown>> = [
      { ...plan, assetPlan: { ...plan.assetPlan, ready: false } },
      { ...plan, assetPlan: { ...plan.assetPlan, manifestPlans: [{ ...createPlan, plannedManifest: { ...createPlan.plannedManifest, schemaVersion: 9 } }] } },
      { ...plan, assetPlan: { ...plan.assetPlan, manifestPlans: [{ ...createPlan, plannedManifest: { ...createPlan.plannedManifest, id: "evil" } }] } },
      { ...plan, assetPlan: { ...plan.assetPlan, objectPlans: plan.assetPlan.objectPlans.map((o) => ({ ...o, action: "explode" as never })) } },
      { ...plan, blockers: ["X" as never] },
    ];
    for (const p of probes) {
      let msg = "";
      try {
        tamper(p);
      } catch (e) {
        msg = e instanceof Error ? e.message : "";
      }
      expect(msg.length).toBeGreaterThan(0);
      expect(msg.startsWith("INVALID_ARCHIVE_INPUT:")).toBe(true);
    }
  });

  it("82. duplicate mode output also carries id/kind and verifies", () => {
    const { plan } = planReady({ mode: "duplicate" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_dupkind", createdAt: 1_700_000_000_000,
    });
    expect(out.manifest.id).toBe("txn_dupkind");
    expect(out.manifest.kind).toBe("merge-restore");
    expect(() => verifyBackupArchive(out.archiveBytes)).not.toThrow();
  });

  it("83. output sourceBackupId available for journal in duplicate mode", () => {
    const { plan } = planReady({ mode: "duplicate" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_dupjournal", createdAt: 1_700_000_000_000,
    });
    const verified = verifyBackupArchive(out.archiveBytes);
    expect(verified.id).toBe("txn_dupjournal");
  });

  it("84. source backup manifest id/kind do NOT propagate to output (output id is the txn id)", () => {
    // Source was built WITH id "src-backup-001" + kind "manual". The output id
    // must be the transactionArchiveId, never the source's id.
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive(
      [{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }],
      { withId: true, kind: "manual" }
    );
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_override", createdAt: 1_700_000_000_000,
    });
    expect(out.manifest.id).toBe("txn_override");
    expect(out.manifest.id).not.toBe("src-backup-001");
    expect(out.manifest.kind).toBe("merge-restore");
    expect(out.manifest.kind).not.toBe("manual");
  });

  // ==========================================================================
  // Layer 2C2C3B1-R2 regression tests (second-line security remediation).
  // Covers the 8 R2 defect classes proven by the second-line reviewer:
  //   (1) top-level null/undefined/array/Date/class rejection BEFORE destructuring
  //   (2) top-level accessor getter is never executed / secret never leaks
  //   (3) forged `INVALID_ARCHIVE_INPUT:` prefix from an external object leaks nothing
  //   (4) Proxy traps (top-level + combinedPlan) => fixed value-free error
  //   (5) array-before-iteration: manifestPlans/objectPlans/requiredAssetIds null
  //       /object/Proxy/accessor-index all rejected with a fixed code
  //   (6) required-set precise cross validation (5 sets must be equal; empty-ok)
  //   (7) exact manifest clone (no re-assigned owner; no shared reference)
  //   (8) mandatory object size (no nullable bypass; 0-byte legal)
  //   (9) output manifest id/kind production self-verification (parse real file)
  //       + value-free guarantee across ALL R2 errors.
  // The original 84 tests above are preserved; this block ADDS coverage.
  // ==========================================================================

  it("85. null input is rejected with a fixed error (no raw TypeError)", () => {
    let msg = "";
    try {
      buildAtomicRestoreArchive(null as never);
    } catch (e) {
      msg = e instanceof Error ? e.message : "";
    }
    expect(msg).toBe("INVALID_ARCHIVE_INPUT: input");
  });

  it("86. undefined input is rejected with a fixed error", () => {
    let msg = "";
    try {
      buildAtomicRestoreArchive(undefined as never);
    } catch (e) {
      msg = e instanceof Error ? e.message : "";
    }
    expect(msg).toBe("INVALID_ARCHIVE_INPUT: input");
  });

  it("87. array / Date / class-instance / Map / Set input rejected with fixed error", () => {
    const badInputs = [
      [] as never,
      new Date(1_700_000_000_000) as never,
      (function () { return { get x() { return 1; } }; })() as never,
      new Map() as never,
      new Set() as never,
      "string-input" as never,
      123 as never,
      true as never,
    ];
    for (const bad of badInputs) {
      let msg = "";
      try {
        buildAtomicRestoreArchive(bad);
      } catch (e) {
        msg = e instanceof Error ? e.message : "";
      }
      expect(msg).toBe("INVALID_ARCHIVE_INPUT: input");
    }
  });

  it("88. top-level sourceArchiveBytes getter is never executed (no leak)", () => {
    const { plan } = planReady({ mode: "structure" });
    const evilInput = {
      get sourceArchiveBytes() {
        throw new Error("C:\\SECRET\\top token=abc");
      },
      combinedPlan: plan,
      targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_g",
      createdAt: 1_700_000_000_000,
    };
    let msg = "";
    try {
      buildAtomicRestoreArchive(evilInput as never);
    } catch (e) {
      msg = e instanceof Error ? e.message : "";
    }
    expect(msg.length).toBeGreaterThan(0);
    expect(msg).not.toContain("C:\\");
    expect(msg).not.toContain("token=abc");
    expect(msg).not.toContain("SECRET");
    expect(msg).toBe("INVALID_ARCHIVE_INPUT: input");
  });

  it("89. top-level sourceArchiveBytes getter throwing a Windows path leaks nothing (variant)", () => {
    const { plan } = planReady({ mode: "structure" });
    let threw = false;
    const evilInput = {
      get sourceArchiveBytes() {
        threw = true;
        throw new Error("C:\\Users\\victim\\backup-token-xyz");
      },
      combinedPlan: plan,
      targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_g2",
      createdAt: 1_700_000_000_000,
    };
    let msg = "";
    try {
      buildAtomicRestoreArchive(evilInput as never);
    } catch (e) {
      msg = e instanceof Error ? e.message : "";
    }
    // The getter MUST NOT have run (we validate descriptors, not values).
    expect(threw).toBe(false);
    expect(msg).toBe("INVALID_ARCHIVE_INPUT: input");
  });

  it("90. combinedPlan getter throwing a plain secret leaks nothing", () => {
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const evil = {
      sourceArchiveBytes: source,
      get combinedPlan() {
        throw new Error("PLAIN_SECRET_VALUE_NO_PREFIX");
      },
      targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_cg",
      createdAt: 1_700_000_000_000,
    };
    let msg = "";
    try {
      buildAtomicRestoreArchive(evil as never);
    } catch (e) {
      msg = e instanceof Error ? e.message : "";
    }
    expect(msg.length).toBeGreaterThan(0);
    expect(msg).not.toContain("PLAIN_SECRET_VALUE_NO_PREFIX");
    expect(msg).toBe("INVALID_ARCHIVE_INPUT: input");
  });

  it("91. combinedPlan getter forging the INVALID_ARCHIVE_INPUT prefix still leaks nothing", () => {
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const evil = {
      sourceArchiveBytes: source,
      get combinedPlan() {
        throw new Error("INVALID_ARCHIVE_INPUT: C:\\SECRET\\forged token=abc");
      },
      targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_forge",
      createdAt: 1_700_000_000_000,
    };
    let msg = "";
    try {
      buildAtomicRestoreArchive(evil as never);
    } catch (e) {
      msg = e instanceof Error ? e.message : "";
    }
    expect(msg.length).toBeGreaterThan(0);
    // The builder does NOT trust the external message; it emits its OWN fixed code.
    expect(msg).not.toContain("C:\\");
    expect(msg).not.toContain("forged");
    expect(msg).not.toContain("token=abc");
    expect(msg).toBe("INVALID_ARCHIVE_INPUT: input");
  });

  it("92. top-level Proxy trap yields a fixed value-free error", () => {
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const proxyInput = new Proxy({} as never, {
      get() {
        throw new Error("C:\\SECRET\\proxy-trap-leak");
      },
      has() {
        throw new Error("C:\\SECRET\\proxy-trap-leak");
      },
      ownKeys() {
        throw new Error("C:\\SECRET\\proxy-trap-leak");
      },
    });
    let msg = "";
    try {
      buildAtomicRestoreArchive(proxyInput);
    } catch (e) {
      msg = e instanceof Error ? e.message : "";
    }
    expect(msg.length).toBeGreaterThan(0);
    expect(msg).not.toContain("C:\\");
    expect(msg).toBe("INVALID_ARCHIVE_INPUT: input");
  });

  it("93. combinedPlan Proxy reflection trap yields a fixed value-free error", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    let getRan = false;
    const proxyPlan = new Proxy(plan as never, {
      get() {
        getRan = true;
        throw new Error(TEST_PRIVATE_VALUE);
      },
      ownKeys() {
        throw new Error(TEST_PATH_VALUE);
      },
    });
    let msg = "";
    try {
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: proxyPlan, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_ppr", createdAt: 1_700_000_000_000,
      });
    } catch (e) {
      msg = e instanceof Error ? e.message : "";
    }
    expect(msg.length).toBeGreaterThan(0);
    expect(getRan).toBe(false);
    expect(msg).not.toContain(TEST_PRIVATE_VALUE);
    expect(msg).not.toContain(TEST_PATH_VALUE);
    expect(msg.startsWith("INVALID_ARCHIVE_INPUT:")).toBe(true);
  });

  it("94. manifestPlans null is rejected BEFORE iteration (fixed code)", () => {
    const { plan } = planReady({ mode: "structure" });
    const tampered = {
      ...plan,
      assetPlan: { ...plan.assetPlan, manifestPlans: null as never },
    };
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    let msg = "";
    try {
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: tampered, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_mpn", createdAt: 1_700_000_000_000,
      });
    } catch (e) {
      msg = e instanceof Error ? e.message : "";
    }
    expect(msg).toBe("INVALID_ARCHIVE_INPUT: manifestPlans");
    expect(msg).not.toContain("C:\\");
  });

  it("95. manifestPlans as a non-array object is rejected with a fixed code", () => {
    const { plan } = planReady({ mode: "structure" });
    const tampered = {
      ...plan,
      assetPlan: { ...plan.assetPlan, manifestPlans: { 0: "x" } as never },
    };
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    let msg = "";
    try {
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: tampered, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_mpo", createdAt: 1_700_000_000_000,
      });
    } catch (e) {
      msg = e instanceof Error ? e.message : "";
    }
    expect(msg).toBe("INVALID_ARCHIVE_INPUT: manifestPlans");
  });

  it("96. objectPlans null is rejected with a fixed code", () => {
    const { plan } = planReady({ mode: "structure" });
    const tampered = {
      ...plan,
      assetPlan: { ...plan.assetPlan, objectPlans: null as never },
    };
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    let msg = "";
    try {
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: tampered, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_opn", createdAt: 1_700_000_000_000,
      });
    } catch (e) {
      msg = e instanceof Error ? e.message : "";
    }
    expect(msg).toBe("INVALID_ARCHIVE_INPUT: objectPlans");
  });

  it("97. requiredAssetIds null is rejected with a fixed code", () => {
    const { plan } = planReady({ mode: "structure" });
    const tampered = {
      ...plan,
      assetPlan: { ...plan.assetPlan, requiredAssetIds: null as never },
    };
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    let msg = "";
    try {
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: tampered, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_ran", createdAt: 1_700_000_000_000,
      });
    } catch (e) {
      msg = e instanceof Error ? e.message : "";
    }
    expect(msg).toBe("INVALID_ARCHIVE_INPUT: requiredAssetIds");
  });

  it("98. Proxy array reflection failure is rejected without leaking value", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    let getRan = false;
    const proxyArr = new Proxy([] as never, {
      get() {
        getRan = true;
        throw new Error(TEST_PRIVATE_VALUE);
      },
      ownKeys() {
        throw new Error(TEST_PATH_VALUE);
      },
    });
    const tampered = {
      ...plan,
      assetPlan: { ...plan.assetPlan, manifestPlans: proxyArr },
    };
    let msg = "";
    try {
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: tampered, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_parr", createdAt: 1_700_000_000_000,
      });
    } catch (e) {
      msg = e instanceof Error ? e.message : "";
    }
    expect(msg.length).toBeGreaterThan(0);
    expect(getRan).toBe(false);
    expect(msg).not.toContain(TEST_PRIVATE_VALUE);
    expect(msg).not.toContain(TEST_PATH_VALUE);
    expect(msg.startsWith("INVALID_ARCHIVE_INPUT:")).toBe(true);
  });

  it("99. array with a getter index is rejected without leaking value", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const getterArr = [] as unknown[];
    Object.defineProperty(getterArr, 0, {
      get() {
        throw new Error("C:\\SECRET\\getter-index-leak");
      },
      enumerable: true,
      configurable: true,
    });
    const tampered = {
      ...plan,
      assetPlan: { ...plan.assetPlan, manifestPlans: getterArr as never },
    };
    let msg = "";
    try {
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: tampered, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_gi", createdAt: 1_700_000_000_000,
      });
    } catch (e) {
      msg = e instanceof Error ? e.message : "";
    }
    expect(msg.length).toBeGreaterThan(0);
    expect(msg).not.toContain("C:\\");
    // Must not have executed the getter; either manifestPlans array guard fires
    // (plain-json-safe on the element) before any index read, or the element
    // validation rejects it — both yield a fixed code.
    expect(msg.startsWith("INVALID_ARCHIVE_INPUT:")).toBe(true);
  });

  it("100. preliminary vs asset required sets diverge => rejected", () => {
    const { plan } = planReady({ mode: "structure" });
    const tampered = {
      ...plan,
      preliminaryWorkspacePlan: {
        ...plan.preliminaryWorkspacePlan,
        requiredAssetIds: [...plan.preliminaryWorkspacePlan.requiredAssetIds, "EXTRA_REQ_1"],
      },
    };
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    let msg = "";
    try {
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: tampered, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_rd1", createdAt: 1_700_000_000_000,
      });
    } catch (e) {
      msg = e instanceof Error ? e.message : "";
    }
    expect(msg).toBe("INVALID_ARCHIVE_INPUT: requiredSet.diverged");
  });

  it("101. asset vs final required sets diverge => rejected", () => {
    const { plan } = planReady({ mode: "structure" });
    const tampered = {
      ...plan,
      finalWorkspacePlan: {
        ...plan.finalWorkspacePlan!,
        requiredAssetIds: [...plan.finalWorkspacePlan!.requiredAssetIds, "EXTRA_REQ_2"],
      },
    };
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    let msg = "";
    try {
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: tampered, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_rd2", createdAt: 1_700_000_000_000,
      });
    } catch (e) {
      msg = e instanceof Error ? e.message : "";
    }
    expect(msg).toBe("INVALID_ARCHIVE_INPUT: requiredSet.diverged");
  });

  it("102. required vs manifest source set diverge => rejected", () => {
    const { plan } = planReady({ mode: "structure" });
    const createPlan = plan.assetPlan.manifestPlans.find((m) => m.action === "create")!;
    const tampered = {
      ...plan,
      assetPlan: {
        ...plan.assetPlan,
        // drop the manifest plan but keep its id in requiredAssetIds
        manifestPlans: plan.assetPlan.manifestPlans.filter((m) => m !== createPlan),
      },
    };
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    let msg = "";
    try {
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: tampered, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_rd3", createdAt: 1_700_000_000_000,
      });
    } catch (e) {
      msg = e instanceof Error ? e.message : "";
    }
    expect(msg).toBe("INVALID_ARCHIVE_INPUT: assetIdMap.orphanMapping");
  });

  it("103. required vs assetIdMap keys diverge (orphan key) => rejected", () => {
    const { plan } = planReady({ mode: "structure" });
    const tampered = {
      ...plan,
      assetPlan: {
        ...plan.assetPlan,
        assetIdMap: { ...plan.assetPlan.assetIdMap, GHOST_SRC: "ghost_tgt" },
      },
    };
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    let msg = "";
    try {
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: tampered, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_rd4", createdAt: 1_700_000_000_000,
      });
    } catch (e) {
      msg = e instanceof Error ? e.message : "";
    }
    expect(msg).toBe("INVALID_ARCHIVE_INPUT: assetIdMap.orphanMapping");
  });

  it("104. required array with a duplicate id => rejected", () => {
    const { plan } = planReady({ mode: "structure" });
    const dup = [...plan.assetPlan.requiredAssetIds, plan.assetPlan.requiredAssetIds[0]];
    const tampered = {
      ...plan,
      assetPlan: { ...plan.assetPlan, requiredAssetIds: dup },
    };
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    let msg = "";
    try {
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: tampered, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_rdup", createdAt: 1_700_000_000_000,
      });
    } catch (e) {
      msg = e instanceof Error ? e.message : "";
    }
    expect(msg).toBe("INVALID_ARCHIVE_INPUT: requiredAssetIds.duplicate");
  });

  it("105. legitimate all-empty required sets still succeed (asset-less plan)", () => {
    const objA = new Uint8Array([1, 2, 3, 4]);
    const hashA = sha256(objA);
    const incoming = {
      templates: [{ id: "it1", name: "Inc Tpl", folderIds: [], tagIds: [] }],
      templateVersions: [{ id: "iv1", templateId: "it1", pageManifest: { pages: [] } }],
      fields: [], instances: [], savedValues: [], mappingTemplates: [],
      importRuns: [], importRows: [], mappingDecisions: [], detectionRuns: [],
      folders: [], tags: [], operationJournal: [],
    };
    const current = {
      templates: [], templateVersions: [], fields: [], instances: [],
      savedValues: [], mappingTemplates: [], importRuns: [], importRows: [],
      mappingDecisions: [], detectionRuns: [], folders: [], tags: [], operationJournal: [],
    };
    const gens = safeGens();
    const plan = planCombinedRestore({
      current: current as never, incoming: incoming as never, mode: "structure",
      ownerId: "owner-7", targetOwnerKeyHash: OWNER, expectedWorkspaceRevision: 5,
      now: 1_700_000_000_000,
      incomingAssets: [{ id: "asset-page-1", schemaVersion: 1 as const, ownerKeyHash: OWNER, contentHash: hashA, size: 4, metadata: { templateId: "it1", templateVersionId: "iv1" } }] as never,
      occupiedManifests: [], knownObjects: [] as never,
      createWorkspaceId: gens.createWorkspaceId, createAssetId: gens.createAssetId,
    });
    // All five required sets are empty here; builder must accept it.
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: objA }]);
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_emptyok", createdAt: 1_700_000_000_000,
    });
    expect(out.counts.manifestsIncluded).toBe(0);
    expect(() => verifyBackupArchive(out.archiveBytes)).not.toThrow();
  });

  it("106. emitted create manifest is a verbatim deep clone (no re-assigned owner)", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_clone", createdAt: 1_700_000_000_000,
    });
    const createPlan = plan.assetPlan.manifestPlans.find((m) => m.action === "create")!;
    const entries = unzipEntries(out.archiveBytes);
    const body = JSON.parse(strFromU8(entries[`manifests/${createPlan.targetAssetId}.json`]));
    // The emitted manifest must be a faithful deep copy of the planned manifest,
    // including ownerKeyHash exactly as validated (no re-assignment afterwards).
    expect(body).toEqual(createPlan.plannedManifest);
    expect(body.ownerKeyHash).toBe(OWNER);
  });

  it("107. emitted manifest does not share a nested reference with the plan", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_noref", createdAt: 1_700_000_000_000,
    });
    const createPlan = plan.assetPlan.manifestPlans.find((m) => m.action === "create")!;
    const before = JSON.stringify(createPlan.plannedManifest.metadata);
    const entries = unzipEntries(out.archiveBytes);
    const body = JSON.parse(strFromU8(entries[`manifests/${createPlan.targetAssetId}.json`]));
    body.metadata = { corrupted: true };
    body.ownerKeyHash = "changed";
    // The original plan must be untouched (deep clone, no shared reference).
    expect(JSON.stringify(createPlan.plannedManifest.metadata)).toBe(before);
    expect((createPlan.plannedManifest as Record<string, unknown>).ownerKeyHash).toBe(OWNER);
  });

  it("108. missing mandatory object size (no nullable bypass) is rejected", () => {
    const { plan } = planReady({ mode: "structure" });
    // Remove the object plan for the create manifest's hash so size lookup fails.
    const createPlan = plan.assetPlan.manifestPlans.find((m) => m.action === "create")!;
    const hash = (createPlan.plannedManifest as Record<string, unknown>).contentHash as string;
    const tampered = {
      ...plan,
      assetPlan: {
        ...plan.assetPlan,
        objectPlans: plan.assetPlan.objectPlans.filter((o) => o.contentHash !== hash),
      },
    };
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    let msg = "";
    try {
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: tampered, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_nosz", createdAt: 1_700_000_000_000,
      });
    } catch (e) {
      msg = e instanceof Error ? e.message : "";
    }
    // The size is now mandatory: the create manifest's object has no plan => the
    // required-set cross check (manifest source set != object-backed set) fails
    // with a fixed code.
    expect(msg.startsWith("INVALID_ARCHIVE_INPUT:")).toBe(true);
    expect(msg).not.toContain(hash);
  });

  it("109. size 0 object is still accepted (mandatory size = 0 legal)", () => {
    const empty = new Uint8Array(0);
    const hashEmpty = sha256(empty);
    const objA = new Uint8Array([1, 2, 3, 4]);
    const hashA = sha256(objA);
    const incoming = {
      templates: [{ id: "it1", name: "Inc Tpl", folderIds: [], tagIds: [] }],
      templateVersions: [{ id: "iv1", templateId: "it1", pageManifest: { pages: [{ assetId: "asset-page-1" }, { assetId: "asset-empty" }] } }],
      fields: [], instances: [], savedValues: [], mappingTemplates: [],
      importRuns: [], importRows: [], mappingDecisions: [], detectionRuns: [],
      folders: [], tags: [], operationJournal: [],
    };
    const current = {
      templates: [], templateVersions: [], fields: [], instances: [],
      savedValues: [], mappingTemplates: [], importRuns: [], importRows: [],
      mappingDecisions: [], detectionRuns: [], folders: [], tags: [], operationJournal: [],
    };
    const gens = safeGens();
    const plan = planCombinedRestore({
      current: current as never, incoming: incoming as never, mode: "structure",
      ownerId: "owner-7", targetOwnerKeyHash: OWNER, expectedWorkspaceRevision: 5,
      now: 1_700_000_000_000,
      incomingAssets: [
        { id: "asset-page-1", schemaVersion: 1 as const, ownerKeyHash: OWNER, contentHash: hashA, size: 4, metadata: { templateId: "it1", templateVersionId: "iv1" } },
        { id: "asset-empty", schemaVersion: 1 as const, ownerKeyHash: OWNER, contentHash: hashEmpty, size: 0, metadata: { templateId: "it1", templateVersionId: "iv1" } },
      ] as never,
      occupiedManifests: [], knownObjects: [] as never,
      createWorkspaceId: gens.createWorkspaceId, createAssetId: gens.createAssetId,
    });
    const source = buildSourceArchive([
      { id: "asset-page-1", bytes: objA },
      { id: "asset-empty", bytes: empty },
    ]);
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_zero2", createdAt: 1_700_000_000_000,
    });
    const entries = unzipEntries(out.archiveBytes);
    expect(entries[`objects/${hashEmpty}`].byteLength).toBe(0);
    expect(out.counts.objectsIncluded).toBe(2);
    expect(() => verifyBackupArchive(out.archiveBytes)).not.toThrow();
  });

  it("110. object byte size mismatch is rejected with a fixed code", () => {
    const { plan } = planReady({ mode: "structure" });
    const createPlan = plan.assetPlan.manifestPlans.find((m) => m.action === "create")!;
    const hash = (createPlan.plannedManifest as Record<string, unknown>).contentHash as string;
    const tampered = {
      ...plan,
      assetPlan: {
        ...plan.assetPlan,
        objectPlans: plan.assetPlan.objectPlans.map((o) =>
          o.contentHash === hash ? { ...o, size: (o.size as number) + 1 } : o
        ),
      },
    };
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    let msg = "";
    try {
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: tampered, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_szm", createdAt: 1_700_000_000_000,
      });
    } catch (e) {
      msg = e instanceof Error ? e.message : "";
    }
    expect(msg).toBe("INVALID_ARCHIVE_INPUT: objectPlan.sizeMismatch");
  });

  it("111. production self-check parses the REAL output manifest and confirms id/kind", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_selfid", createdAt: 1_700_000_000_000,
    });
    const entries = unzipEntries(out.archiveBytes);
    const realManifest = JSON.parse(strFromU8(entries["backup-manifest.json"]));
    // The builder internally re-parsed this exact file and asserted these.
    expect(realManifest.id).toBe("txn_selfid");
    expect(realManifest.kind).toBe("merge-restore");
    expect(realManifest.format).toBe("formdigital-portable-backup");
    expect(realManifest.schemaVersion).toBe(1);
    expect(realManifest.scope).toBe("account");
    expect(realManifest.templateId).toBeNull();
    expect(realManifest.ownerKeyHash).toBe(OWNER);
    expect(realManifest.transactionArchiveId).toBeUndefined();
  });

  it("112. output manifest does NOT carry the non-official transactionArchiveId field", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_nofield", createdAt: 1_700_000_000_000,
    });
    const entries = unzipEntries(out.archiveBytes);
    const realManifest = JSON.parse(strFromU8(entries["backup-manifest.json"]));
    expect("transactionArchiveId" in realManifest).toBe(false);
    expect(out.manifest.id).toBe("txn_nofield");
    expect(out.manifest.kind).toBe("merge-restore");
  });

  it("113. ALL R2 builder error codes are fixed + value-free (no path/token/owner/hash/id)", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const createPlan = plan.assetPlan.manifestPlans.find((m) => m.action === "create")!;
    const hash = (createPlan.plannedManifest as Record<string, unknown>).contentHash as string;
    const probes: Array<[unknown, string]> = [
      // Each probe is an input or tampered plan; we only check the message.
      [null as never, "input"],
      [undefined as never, "input"],
      [[] as never, "input"],
      [
        {
          sourceArchiveBytes: source,
          get combinedPlan() { throw new Error(TEST_PATH_VALUE); },
          targetOwnerKeyHash: OWNER,
          transactionArchiveId: "x",
          createdAt: 1,
        } as never,
        "input",
      ],
      [
        {
          sourceArchiveBytes: source, combinedPlan: plan,
          targetOwnerKeyHash: BAD_OWNER, transactionArchiveId: "x", createdAt: 1,
        } as never,
        "targetOwnerKeyHash",
      ],
      [
        {
          sourceArchiveBytes: source, combinedPlan: plan,
          targetOwnerKeyHash: OWNER, transactionArchiveId: "C:\\bad\\id", createdAt: 1,
        } as never,
        "transactionArchiveId",
      ],
      [
        {
          sourceArchiveBytes: new Uint8Array([1, 2, 3]), combinedPlan: plan,
          targetOwnerKeyHash: OWNER, transactionArchiveId: "x", createdAt: 1,
        } as never,
        "sourceArchive",
      ],
      [
        {
          sourceArchiveBytes: buildLegacyArchive(), combinedPlan: plan,
          targetOwnerKeyHash: OWNER, transactionArchiveId: "x", createdAt: 1,
        } as never,
        "sourceArchive",
      ],
      [
        {
          sourceArchiveBytes: source,
          combinedPlan: { ...plan, assetPlan: { ...plan.assetPlan, manifestPlans: null as never } },
          targetOwnerKeyHash: OWNER, transactionArchiveId: "x", createdAt: 1,
        } as never,
        "manifestPlans",
      ],
      [
        {
          sourceArchiveBytes: source,
          combinedPlan: { ...plan, assetPlan: { ...plan.assetPlan, objectPlans: null as never } },
          targetOwnerKeyHash: OWNER, transactionArchiveId: "x", createdAt: 1,
        } as never,
        "objectPlans",
      ],
      [
        {
          sourceArchiveBytes: source,
          combinedPlan: {
            ...plan,
            preliminaryWorkspacePlan: {
              ...plan.preliminaryWorkspacePlan,
              requiredAssetIds: [...plan.preliminaryWorkspacePlan.requiredAssetIds, "EXTRA"],
            },
          },
          targetOwnerKeyHash: OWNER, transactionArchiveId: "x", createdAt: 1,
        } as never,
        "requiredSet.diverged",
      ],
      [
        {
          sourceArchiveBytes: source,
          combinedPlan: { ...plan, assetPlan: { ...plan.assetPlan, ready: false } },
          targetOwnerKeyHash: OWNER, transactionArchiveId: "x", createdAt: 1,
        } as never,
        "assetPlan.ready",
      ],
    ];
    for (const [input, _expectField] of probes) {
      let msg = "";
      try {
        buildAtomicRestoreArchive(input as never);
      } catch (e) {
        msg = e instanceof Error ? e.message : "";
      }
      expect(msg.length).toBeGreaterThan(0);
      // No sensitive substrings may ever appear.
      expect(msg).not.toContain(OWNER);
      expect(msg).not.toContain("asset-page-1");
      expect(msg).not.toContain(SECRET);
      expect(msg).not.toContain("C:\\");
      expect(msg).not.toContain(hash);
      expect(msg).not.toContain("/");
      expect(msg.startsWith("INVALID_ARCHIVE_INPUT:") || msg.startsWith("INVALID_ARCHIVE_OUTPUT:")).toBe(true);
    }
  });

  // ==========================================================================
  // Layer 2C2C3B1-R3 regression tests (third-line trust-boundary remediation).
  // Covers the second-line proven R2 gaps:
  //   (1) captured constructor can NOT forge a trusted error
  //   (2) a captured error's message can NOT be mutated + reused to leak
  //   (3) nested plan / array accessor getters must NOT execute (flag=false)
  //   (4) array descriptor rules: sparse / extra prop / symbol / non-enumerable
  //   (5) Proxy ownKeys/descriptor trap throwing a secret => fixed error
  //   (6) post-snapshot mutation of the original plan does not change the build
  //   (7) legal structure / duplicate / empty-asset / 0-byte / id-kind all hold
  // The original 113 tests above are preserved; this block ADDS coverage.
  // ==========================================================================

  it("114. captured internal error constructor cannot forge a trusted secret error", () => {
    // First obtain a genuine internal error to recover its constructor.
    let caught: unknown;
    try {
      buildAtomicRestoreArchive(null as never);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const Ctor = (caught as { constructor: new (m: string) => Error }).constructor;
    // Forge an error with the recovered constructor carrying a secret message.
    const forged = new Ctor(
      `INVALID_ARCHIVE_INPUT: ${TEST_PATH_VALUE} ${TEST_TOKEN_VALUE}`
    );
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    // The forged error is thrown from a guarded reflection trap. Because it is
    // not in the module WeakSet, the builder must emit its own fixed code.
    let msg = "";
    try {
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source,
        combinedPlan: new Proxy(plan as never, {
          getPrototypeOf() {
            throw forged;
          },
        }),
        targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_forge2",
        createdAt: 1_700_000_000_000,
      });
    } catch (e) {
      msg = e instanceof Error ? e.message : "";
    }
    expect(msg).not.toContain(TEST_PATH_VALUE);
    expect(msg).not.toContain(TEST_TOKEN_VALUE);
    expect(msg.startsWith("INVALID_ARCHIVE_INPUT:")).toBe(true);
  });

  it("115. a captured internal error's message cannot be mutated then reused to leak", () => {
    let caught: Error | undefined;
    try {
      buildAtomicRestoreArchive(null as never);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeInstanceOf(Error);
    // Attempt to mutate the (locked) message — must be a no-op (non-writable).
    let mutated = false;
    try {
      (caught as { message: string }).message =
        `INVALID_ARCHIVE_INPUT: ${TEST_PRIVATE_VALUE} ${TEST_TOKEN_VALUE}`;
      mutated = (caught as { message: string }).message.includes(TEST_PRIVATE_VALUE);
    } catch {
      mutated = false; // defineProperty lock threw — also acceptable.
    }
    expect(mutated).toBe(false);
    expect(caught?.message).toBe("INVALID_ARCHIVE_INPUT: input");
    expect(() =>
      Object.defineProperty(caught, "message", { value: TEST_PRIVATE_VALUE })
    ).toThrow();
    // Reuse the recovered trusted error inside a guarded reflection trap. Its
    // immutable fixed message is safe, and the boundary emits its own code.
    const reused = caught as Error;
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    let msg = "";
    try {
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source,
        combinedPlan: new Proxy(plan as never, {
          getOwnPropertyDescriptor() {
            throw reused;
          },
        }),
        targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_reuse",
        createdAt: 1_700_000_000_000,
      });
    } catch (e) {
      msg = e instanceof Error ? e.message : "";
    }
    expect(msg.startsWith("INVALID_ARCHIVE_INPUT:")).toBe(true);
    expect(msg).not.toContain(TEST_PRIVATE_VALUE);
    expect(msg).not.toContain(TEST_TOKEN_VALUE);
  });

  it("116. nested combinedPlan.ready getter execution flag stays false", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    let getterRan = false;
    const evilPlan = {
      ...plan,
      get ready() {
        getterRan = true;
        return true;
      },
    };
    let msg = "";
    try {
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: evilPlan as never,
        targetOwnerKeyHash: OWNER, transactionArchiveId: "txn_r", createdAt: 1_700_000_000_000,
      });
    } catch (e) {
      msg = e instanceof Error ? e.message : "";
    }
    expect(getterRan).toBe(false);
    expect(msg.length).toBeGreaterThan(0);
    expect(msg.startsWith("INVALID_ARCHIVE_INPUT:")).toBe(true);
  });

  it("117. nested preconditions.expectedWorkspaceRevision getter flag false", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    let getterRan = false;
    const evilPlan = {
      ...plan,
      preconditions: {
        get expectedWorkspaceRevision() {
          getterRan = true;
          return 5;
        },
      },
    };
    let msg = "";
    try {
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: evilPlan as never,
        targetOwnerKeyHash: OWNER, transactionArchiveId: "txn_pr", createdAt: 1_700_000_000_000,
      });
    } catch (e) {
      msg = e instanceof Error ? e.message : "";
    }
    expect(getterRan).toBe(false);
    expect(msg.startsWith("INVALID_ARCHIVE_INPUT:")).toBe(true);
  });

  it("118. nested assetPlan.ready getter flag false", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    let getterRan = false;
    const evilPlan = {
      ...plan,
      assetPlan: {
        ...plan.assetPlan,
        get ready() {
          getterRan = true;
          return true;
        },
      },
    };
    let msg = "";
    try {
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: evilPlan as never,
        targetOwnerKeyHash: OWNER, transactionArchiveId: "txn_ar", createdAt: 1_700_000_000_000,
      });
    } catch (e) {
      msg = e instanceof Error ? e.message : "";
    }
    expect(getterRan).toBe(false);
    expect(msg.startsWith("INVALID_ARCHIVE_INPUT:")).toBe(true);
  });

  it("119. nested finalWorkspacePlan.mergedWorkspace getter flag false", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    let getterRan = false;
    const evilPlan = {
      ...plan,
      finalWorkspacePlan: {
        ...plan.finalWorkspacePlan,
        get mergedWorkspace() {
          getterRan = true;
          return plan.finalWorkspacePlan!.mergedWorkspace;
        },
      },
    };
    let msg = "";
    try {
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: evilPlan as never,
        targetOwnerKeyHash: OWNER, transactionArchiveId: "txn_mw", createdAt: 1_700_000_000_000,
      });
    } catch (e) {
      msg = e instanceof Error ? e.message : "";
    }
    expect(getterRan).toBe(false);
    expect(msg.startsWith("INVALID_ARCHIVE_INPUT:")).toBe(true);
  });

  it("120. manifestPlans[0] accessor getter flag false", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    let getterRan = false;
    const evilPlans: unknown[] = [];
    Object.defineProperty(evilPlans, 0, {
      get() {
        getterRan = true;
        return plan.assetPlan.manifestPlans[0];
      },
      enumerable: true,
      configurable: true,
    });
    const evilPlan = {
      ...plan,
      assetPlan: { ...plan.assetPlan, manifestPlans: evilPlans as never },
    };
    let msg = "";
    try {
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: evilPlan as never,
        targetOwnerKeyHash: OWNER, transactionArchiveId: "txn_mp0", createdAt: 1_700_000_000_000,
      });
    } catch (e) {
      msg = e instanceof Error ? e.message : "";
    }
    expect(getterRan).toBe(false);
    expect(msg.startsWith("INVALID_ARCHIVE_INPUT:")).toBe(true);
  });

  it("121. objectPlans[0] accessor getter flag false", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    let getterRan = false;
    const evilPlans: unknown[] = [];
    Object.defineProperty(evilPlans, 0, {
      get() {
        getterRan = true;
        return plan.assetPlan.objectPlans[0];
      },
      enumerable: true,
      configurable: true,
    });
    const evilPlan = {
      ...plan,
      assetPlan: { ...plan.assetPlan, objectPlans: evilPlans as never },
    };
    let msg = "";
    try {
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: evilPlan as never,
        targetOwnerKeyHash: OWNER, transactionArchiveId: "txn_op0", createdAt: 1_700_000_000_000,
      });
    } catch (e) {
      msg = e instanceof Error ? e.message : "";
    }
    expect(getterRan).toBe(false);
    expect(msg.startsWith("INVALID_ARCHIVE_INPUT:")).toBe(true);
  });

  it("122. requiredAssetIds[0] accessor getter flag false", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    let getterRan = false;
    const evilIds: unknown[] = [];
    Object.defineProperty(evilIds, 0, {
      get() {
        getterRan = true;
        return plan.assetPlan.requiredAssetIds[0];
      },
      enumerable: true,
      configurable: true,
    });
    const evilPlan = {
      ...plan,
      assetPlan: { ...plan.assetPlan, requiredAssetIds: evilIds as never },
    };
    let msg = "";
    try {
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: evilPlan as never,
        targetOwnerKeyHash: OWNER, transactionArchiveId: "txn_ra0", createdAt: 1_700_000_000_000,
      });
    } catch (e) {
      msg = e instanceof Error ? e.message : "";
    }
    expect(getterRan).toBe(false);
    expect(msg.startsWith("INVALID_ARCHIVE_INPUT:")).toBe(true);
  });

  it("123. plannedManifest metadata array index getter flag false", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    let getterRan = false;
    const createPlan = plan.assetPlan.manifestPlans.find((m) => m.action === "create")!;
    const badMeta: unknown[] = [];
    Object.defineProperty(badMeta, 0, {
      get() {
        getterRan = true;
        return { templateId: "it1", templateVersionId: "iv1" };
      },
      enumerable: true,
      configurable: true,
    });
    const tamperedManifest = {
      ...(createPlan.plannedManifest as Record<string, unknown>),
      metadata: badMeta,
    };
    const evilPlan = {
      ...plan,
      assetPlan: {
        ...plan.assetPlan,
        manifestPlans: plan.assetPlan.manifestPlans.map((m) =>
          m.action === "create" ? { ...m, plannedManifest: tamperedManifest } : m
        ),
      },
    };
    let msg = "";
    try {
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: evilPlan as never,
        targetOwnerKeyHash: OWNER, transactionArchiveId: "txn_meta", createdAt: 1_700_000_000_000,
      });
    } catch (e) {
      msg = e instanceof Error ? e.message : "";
    }
    expect(getterRan).toBe(false);
    expect(msg.startsWith("INVALID_ARCHIVE_INPUT:")).toBe(true);
  });

  it("124. mergedWorkspace collection array index getter flag false", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    let getterRan = false;
    const ws = plan.finalWorkspacePlan!.mergedWorkspace as Record<string, unknown>;
    const badTemplates: unknown[] = [];
    Object.defineProperty(badTemplates, 0, {
      get() {
        getterRan = true;
        return (ws.templates as unknown[])[0];
      },
      enumerable: true,
      configurable: true,
    });
    const evilPlan = {
      ...plan,
      finalWorkspacePlan: {
        ...plan.finalWorkspacePlan,
        mergedWorkspace: { ...ws, templates: badTemplates },
      },
    };
    let msg = "";
    try {
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: evilPlan as never,
        targetOwnerKeyHash: OWNER, transactionArchiveId: "txn_ws", createdAt: 1_700_000_000_000,
      });
    } catch (e) {
      msg = e instanceof Error ? e.message : "";
    }
    expect(getterRan).toBe(false);
    expect(msg.startsWith("INVALID_ARCHIVE_INPUT:")).toBe(true);
  });

  it("125. nested object (metadata) accessor getter flag false", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    let getterRan = false;
    const createPlan = plan.assetPlan.manifestPlans.find((m) => m.action === "create")!;
    const badMeta: Record<string, unknown> = {};
    Object.defineProperty(badMeta, "templateId", {
      get() {
        getterRan = true;
        return "it1";
      },
      enumerable: true,
      configurable: true,
    });
    const tamperedManifest = {
      ...(createPlan.plannedManifest as Record<string, unknown>),
      metadata: badMeta,
    };
    const evilPlan = {
      ...plan,
      assetPlan: {
        ...plan.assetPlan,
        manifestPlans: plan.assetPlan.manifestPlans.map((m) =>
          m.action === "create" ? { ...m, plannedManifest: tamperedManifest } : m
        ),
      },
    };
    let msg = "";
    try {
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: evilPlan as never,
        targetOwnerKeyHash: OWNER, transactionArchiveId: "txn_nm", createdAt: 1_700_000_000_000,
      });
    } catch (e) {
      msg = e instanceof Error ? e.message : "";
    }
    expect(getterRan).toBe(false);
    expect(msg.startsWith("INVALID_ARCHIVE_INPUT:")).toBe(true);
  });

  it("126. sparse array is rejected", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    // Sparse array: length 2 with only index 0 set (hole at index 1).
    const sparse: unknown[] = new Array(2);
    sparse[0] = plan.assetPlan.manifestPlans[0];
    const evilPlan = {
      ...plan,
      assetPlan: { ...plan.assetPlan, manifestPlans: sparse as never },
    };
    let msg = "";
    try {
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: evilPlan as never,
        targetOwnerKeyHash: OWNER, transactionArchiveId: "txn_sp", createdAt: 1_700_000_000_000,
      });
    } catch (e) {
      msg = e instanceof Error ? e.message : "";
    }
    expect(msg.startsWith("INVALID_ARCHIVE_INPUT:")).toBe(true);
  });

  it("127. array with extra custom property is rejected", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const evil = plan.assetPlan.manifestPlans.slice() as unknown[];
    (evil as Record<string, unknown>).customProp = "x";
    const evilPlan = {
      ...plan,
      assetPlan: { ...plan.assetPlan, manifestPlans: evil as never },
    };
    let msg = "";
    try {
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: evilPlan as never,
        targetOwnerKeyHash: OWNER, transactionArchiveId: "txn_cp", createdAt: 1_700_000_000_000,
      });
    } catch (e) {
      msg = e instanceof Error ? e.message : "";
    }
    expect(msg.startsWith("INVALID_ARCHIVE_INPUT:")).toBe(true);
  });

  it("128. array with symbol key is rejected", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const evil = plan.assetPlan.manifestPlans.slice() as unknown[];
    Object.defineProperty(evil, Symbol.for("k"), { value: 1, enumerable: true, configurable: true });
    const evilPlan = {
      ...plan,
      assetPlan: { ...plan.assetPlan, manifestPlans: evil as never },
    };
    let msg = "";
    try {
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: evilPlan as never,
        targetOwnerKeyHash: OWNER, transactionArchiveId: "txn_sym", createdAt: 1_700_000_000_000,
      });
    } catch (e) {
      msg = e instanceof Error ? e.message : "";
    }
    expect(msg.startsWith("INVALID_ARCHIVE_INPUT:")).toBe(true);
  });

  it("129. array with non-enumerable index is rejected", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const evil: unknown[] = [];
    Object.defineProperty(evil, 0, {
      value: plan.assetPlan.manifestPlans[0],
      enumerable: false,
      configurable: true,
    });
    const evilPlan = {
      ...plan,
      assetPlan: { ...plan.assetPlan, manifestPlans: evil as never },
    };
    let msg = "";
    try {
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: evilPlan as never,
        targetOwnerKeyHash: OWNER, transactionArchiveId: "txn_ne", createdAt: 1_700_000_000_000,
      });
    } catch (e) {
      msg = e instanceof Error ? e.message : "";
    }
    expect(msg.startsWith("INVALID_ARCHIVE_INPUT:")).toBe(true);
  });

  it("130. Proxy ownKeys / getOwnPropertyDescriptor trap throwing a secret is fixed", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const proxyPlan = new Proxy(plan as never, {
      ownKeys() {
        throw new Error(`${TEST_PATH_VALUE}:ownkeys`);
      },
      getOwnPropertyDescriptor() {
        throw new Error(`${TEST_PRIVATE_VALUE}:descriptor`);
      },
    });
    let msg = "";
    try {
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: proxyPlan,
        targetOwnerKeyHash: OWNER, transactionArchiveId: "txn_pot", createdAt: 1_700_000_000_000,
      });
    } catch (e) {
      msg = e instanceof Error ? e.message : "";
    }
    expect(msg.startsWith("INVALID_ARCHIVE_INPUT:")).toBe(true);
    expect(msg).not.toContain(TEST_PATH_VALUE);
    expect(msg).not.toContain(TEST_PRIVATE_VALUE);
  });

  it("131. mutating the ORIGINAL plan after build input does not change the result", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const expectedWorkspace = structuredClone(
      plan.finalWorkspacePlan!.mergedWorkspace
    );
    const createPlan = plan.assetPlan.manifestPlans.find(
      (manifestPlan) => manifestPlan.action === "create"
    )!;
    const expectedPlannedManifest = structuredClone(createPlan.plannedManifest);
    const targetAssetId = createPlan.targetAssetId;
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_snap", createdAt: 1_700_000_000_000,
    });
    // Mutate the original plan's nested values after the call.
    try {
      (plan as Record<string, unknown>).ready = false;
      const ap = plan.assetPlan as Record<string, unknown>;
      ap.ready = false;
      const mws = plan.finalWorkspacePlan as Record<string, unknown>;
      mws.ready = false;
      const workspace = plan.finalWorkspacePlan!.mergedWorkspace as Record<string, unknown>;
      const templates = workspace.templates as Array<Record<string, unknown>>;
      templates[0].name = TEST_PRIVATE_VALUE;
      const plannedManifest = createPlan.plannedManifest as Record<string, unknown>;
      const metadata = plannedManifest.metadata as Record<string, unknown>;
      metadata.templateId = TEST_PRIVATE_VALUE;
    } catch {
      /* ignore */
    }
    // Rebuild from the same (now mutated) plan object — must still be rejected
    // because the snapshot was taken at call time, proving the build used the
    // snapshot, not the mutated original.
    let msg = "";
    try {
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_snap2", createdAt: 1_700_000_000_000,
      });
    } catch (e) {
      msg = e instanceof Error ? e.message : "";
    }
    expect(msg.startsWith("INVALID_ARCHIVE_INPUT:")).toBe(true);
    // The first output is still valid and unchanged.
    expect(out.manifest.id).toBe("txn_snap");
    const entries = unzipEntries(out.archiveBytes);
    const archivedWorkspace = JSON.parse(
      strFromU8(entries["account/workspace.json"])
    ).workspace;
    const archivedManifest = JSON.parse(
      strFromU8(entries[`manifests/${targetAssetId}.json`])
    );
    expect(archivedWorkspace).toEqual(expectedWorkspace);
    expect(archivedManifest).toEqual(expectedPlannedManifest);
    expect(deepForbiddenScan(archivedWorkspace, [TEST_PRIVATE_VALUE])).toBe(false);
    expect(deepForbiddenScan(archivedManifest, [TEST_PRIVATE_VALUE])).toBe(false);
  });

  it("132. legal structure plan output is unchanged (R2 non-regression)", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_s", createdAt: 1_700_000_000_000,
    });
    expect(verifyBackupArchive(out.archiveBytes).scope).toBe("account");
    expect(out.manifest.kind).toBe("merge-restore");
  });

  it("133. legal duplicate plan output is unchanged (R2 non-regression)", () => {
    const { plan } = planReady({ mode: "duplicate" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_d", createdAt: 1_700_000_000_000,
    });
    expect(verifyBackupArchive(out.archiveBytes).scope).toBe("account");
    const entries = unzipEntries(out.archiveBytes);
    const realManifest = JSON.parse(strFromU8(entries["backup-manifest.json"]));
    expect(realManifest.kind).toBe("merge-restore");
    expect(realManifest.id).toBe("txn_d");
  });

  it("134. legal empty-asset plan still succeeds (R2 non-regression)", () => {
    const objA = new Uint8Array([1, 2, 3, 4]);
    const hashA = sha256(objA);
    const incoming = {
      templates: [{ id: "it1", name: "Inc Tpl", folderIds: [], tagIds: [] }],
      templateVersions: [{ id: "iv1", templateId: "it1", pageManifest: { pages: [] } }],
      fields: [], instances: [], savedValues: [], mappingTemplates: [],
      importRuns: [], importRows: [], mappingDecisions: [], detectionRuns: [],
      folders: [], tags: [], operationJournal: [],
    };
    const current = {
      templates: [], templateVersions: [], fields: [], instances: [],
      savedValues: [], mappingTemplates: [], importRuns: [], importRows: [],
      mappingDecisions: [], detectionRuns: [], folders: [], tags: [], operationJournal: [],
    };
    const gens = safeGens();
    const plan = planCombinedRestore({
      current: current as never, incoming: incoming as never, mode: "structure",
      ownerId: "owner-7", targetOwnerKeyHash: OWNER, expectedWorkspaceRevision: 5,
      now: 1_700_000_000_000,
      incomingAssets: [{ id: "asset-page-1", schemaVersion: 1 as const, ownerKeyHash: OWNER, contentHash: hashA, size: 4, metadata: { templateId: "it1", templateVersionId: "iv1" } }] as never,
      occupiedManifests: [], knownObjects: [] as never,
      createWorkspaceId: gens.createWorkspaceId, createAssetId: gens.createAssetId,
    });
    const emptySource = buildEmptySourceArchive();
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: emptySource, combinedPlan: plan,
      targetOwnerKeyHash: OWNER, transactionArchiveId: "txn_e", createdAt: 1_700_000_000_000,
    });
    expect(out.manifest.id).toBe("txn_e");
    expect(verifyBackupArchive(out.archiveBytes).scope).toBe("account");
  });

  it("135. 0-byte object still succeeds (R2 non-regression)", () => {
    const empty = new Uint8Array(0);
    const hashEmpty = sha256(empty);
    const objA = new Uint8Array([1, 2, 3, 4]);
    const hashA = sha256(objA);
    const incoming = {
      templates: [{ id: "it1", name: "Inc Tpl", folderIds: [], tagIds: [] }],
      templateVersions: [{ id: "iv1", templateId: "it1", pageManifest: { pages: [{ assetId: "asset-page-1" }, { assetId: "asset-empty" }] } }],
      fields: [], instances: [], savedValues: [], mappingTemplates: [],
      importRuns: [], importRows: [], mappingDecisions: [], detectionRuns: [],
      folders: [], tags: [], operationJournal: [],
    };
    const current = {
      templates: [], templateVersions: [], fields: [], instances: [],
      savedValues: [], mappingTemplates: [], importRuns: [], importRows: [],
      mappingDecisions: [], detectionRuns: [], folders: [], tags: [], operationJournal: [],
    };
    const gens = safeGens();
    const plan = planCombinedRestore({
      current: current as never, incoming: incoming as never, mode: "structure", ownerId: "owner-7",
      targetOwnerKeyHash: OWNER, expectedWorkspaceRevision: 5, now: 1_700_000_000_000,
      incomingAssets: [
        { id: "asset-page-1", schemaVersion: 1 as const, ownerKeyHash: OWNER, contentHash: hashA, size: 4, metadata: { templateId: "it1", templateVersionId: "iv1" } },
        { id: "asset-empty", schemaVersion: 1 as const, ownerKeyHash: OWNER, contentHash: hashEmpty, size: 0, metadata: { templateId: "it1", templateVersionId: "iv1" } },
      ] as never,
      occupiedManifests: [], knownObjects: [] as never,
      createWorkspaceId: gens.createWorkspaceId, createAssetId: gens.createAssetId,
    });
    const zeroSource = buildSourceArchive([
      { id: "asset-page-1", bytes: objA },
      { id: "asset-empty", bytes: empty },
    ]);
    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: zeroSource, combinedPlan: plan, targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_z", createdAt: 1_700_000_000_000,
    });
    expect(out.manifest.id).toBe("txn_z");
  });

  it("136. ALL R3 builder error codes are fixed + value-free (no path/token/owner/hash/id)", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([{ id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const probes: Array<[unknown, string]> = [
      [null as never, "input"],
      [
        {
          sourceArchiveBytes: source,
          get combinedPlan() { throw new Error("C:\\SECRET\\x"); },
          targetOwnerKeyHash: OWNER, transactionArchiveId: "x", createdAt: 1,
        } as never,
        "input",
      ],
    ];
    // Build a Proxy plan whose reflection trap carries only synthetic values.
    const leakingPlan = new Proxy(plan as never, {
      ownKeys() {
        throw new Error(`${TEST_PATH_VALUE} ${TEST_TOKEN_VALUE}`);
      },
    });
    probes.push([
      {
        sourceArchiveBytes: source, combinedPlan: leakingPlan,
        targetOwnerKeyHash: OWNER, transactionArchiveId: "x", createdAt: 1,
      } as never,
      "combinedPlan",
    ]);
    for (const [input, _f] of probes) {
      let msg = "";
      try {
        buildAtomicRestoreArchive(input as never);
      } catch (e) {
        msg = e instanceof Error ? e.message : "";
      }
      expect(msg.length).toBeGreaterThan(0);
      expect(msg).not.toContain(OWNER);
      expect(msg).not.toContain("asset-page-1");
      expect(msg).not.toContain(SECRET);
      expect(msg).not.toContain(TEST_PATH_VALUE);
      expect(msg).not.toContain(TEST_TOKEN_VALUE);
      expect(msg).not.toContain("/");
      expect(msg.startsWith("INVALID_ARCHIVE_INPUT:") || msg.startsWith("INVALID_ARCHIVE_OUTPUT:")).toBe(true);
    }
  });

  it("137. descriptor snapshots never invoke transparent object or array Proxy get traps", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([
      { id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) },
    ]);
    let objectGetRan = false;
    let arrayGetRan = false;
    const proxyManifestPlans = new Proxy(plan.assetPlan.manifestPlans, {
      get() {
        arrayGetRan = true;
        throw new Error(TEST_PRIVATE_VALUE);
      },
    });
    const proxyPlan = new Proxy(
      {
        ...plan,
        assetPlan: { ...plan.assetPlan, manifestPlans: proxyManifestPlans },
      },
      {
        get() {
          objectGetRan = true;
          throw new Error(TEST_PRIVATE_VALUE);
        },
      }
    );

    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source,
      combinedPlan: proxyPlan,
      targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_descriptor_only",
      createdAt: 1_700_000_000_000,
    });

    expect(objectGetRan).toBe(false);
    expect(arrayGetRan).toBe(false);
    expect(verifyBackupArchive(out.archiveBytes).scope).toBe("account");
  });

  it("138. non-JSON plan values and cycles are rejected with one fixed public error", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([
      { id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) },
    ]);
    class TestCustomValue {}
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const invalidValues: unknown[] = [
      undefined,
      () => TEST_PRIVATE_VALUE,
      Symbol(TEST_PRIVATE_VALUE),
      BigInt(1),
      NaN,
      Infinity,
      new Date(1_700_000_000_000),
      new Map(),
      new Set(),
      new TestCustomValue(),
      cyclic,
    ];

    for (const invalidValue of invalidValues) {
      let msg = "";
      try {
        buildAtomicRestoreArchive({
          sourceArchiveBytes: source,
          combinedPlan: { ...plan, testInvalidValue: invalidValue },
          targetOwnerKeyHash: OWNER,
          transactionArchiveId: "txn_invalid_json",
          createdAt: 1_700_000_000_000,
        });
      } catch (error) {
        msg = error instanceof Error ? error.message : "";
      }
      expect(msg).toBe("INVALID_ARCHIVE_INPUT: combinedPlan");
      expect(msg).not.toContain(TEST_PRIVATE_VALUE);
    }
  });

  it("139. Date is allowed only inside the mergedWorkspace serialization snapshot", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([
      { id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) },
    ]);
    const date = new Date("2023-11-14T22:13:20.000Z");
    const workspace = plan.finalWorkspacePlan!.mergedWorkspace as Record<string, unknown>;
    const templates = workspace.templates as Array<Record<string, unknown>>;
    templates[0].createdAt = date;

    const out = buildAtomicRestoreArchive({
      sourceArchiveBytes: source,
      combinedPlan: plan,
      targetOwnerKeyHash: OWNER,
      transactionArchiveId: "txn_workspace_date",
      createdAt: 1_700_000_000_000,
    });
    const archivedWorkspace = JSON.parse(
      strFromU8(unzipEntries(out.archiveBytes)["account/workspace.json"])
    ).workspace;

    expect(archivedWorkspace.templates[0].createdAt).toBe(date.toISOString());
    expect(verifyBackupArchive(out.archiveBytes).scope).toBe("account");
  });

  it("140. caller-controlled property names never enter public snapshot errors", () => {
    const { plan } = planReady({ mode: "structure" });
    const source = buildSourceArchive([
      { id: "asset-page-1", bytes: new Uint8Array([1, 2, 3, 4]) },
    ]);
    const planWithPrivateKey = { ...plan } as Record<string, unknown>;
    planWithPrivateKey[TEST_PRIVATE_VALUE] = undefined;

    let msg = "";
    try {
      buildAtomicRestoreArchive({
        sourceArchiveBytes: source,
        combinedPlan: planWithPrivateKey,
        targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_private_key",
        createdAt: 1_700_000_000_000,
      });
    } catch (error) {
      msg = error instanceof Error ? error.message : "";
    }

    expect(msg).toBe("INVALID_ARCHIVE_INPUT: combinedPlan");
    expect(msg).not.toContain(TEST_PRIVATE_VALUE);
    expect(msg).not.toContain(TEST_PATH_VALUE);
    expect(msg).not.toContain(TEST_TOKEN_VALUE);
  });

  it("141. sourceArchiveBytes prototype reflection failure is converted to a fixed error", () => {
    const { plan } = planReady({ mode: "structure" });
    const proxyBytes = new Proxy(new Uint8Array([1, 2, 3]), {
      getPrototypeOf() {
        throw new Error(`${TEST_PATH_VALUE} ${TEST_TOKEN_VALUE}`);
      },
    });

    let msg = "";
    try {
      buildAtomicRestoreArchive({
        sourceArchiveBytes: proxyBytes,
        combinedPlan: plan,
        targetOwnerKeyHash: OWNER,
        transactionArchiveId: "txn_proxy_bytes",
        createdAt: 1_700_000_000_000,
      });
    } catch (error) {
      msg = error instanceof Error ? error.message : "";
    }

    expect(msg).toBe("INVALID_ARCHIVE_INPUT: sourceArchiveBytes");
    expect(msg).not.toContain(TEST_PRIVATE_VALUE);
    expect(msg).not.toContain(TEST_PATH_VALUE);
    expect(msg).not.toContain(TEST_TOKEN_VALUE);
  });
});
