/**
 * Pure Backup Asset Import Planner.
 *
 * This module turns the C2C1 preliminary Workspace plan's `requiredAssetIds`
 * into safe target asset ids, manifest plans and content-addressed object
 * plans. It is intentionally side-effect free: it never reads asset bytes,
 * never computes a hash, never writes a manifest/object, never creates staging
 * and never touches the Local Data Service, Workspace or filesystem.
 *
 * Deterministic contract: for identical `input` (including an identical
 * `createAssetId` call sequence) the result is byte-for-byte identical. No
 * clock, no Math.random, no I/O.
 *
 * Security contract: every validation error is a FIXED, VALUE-FREE message.
 * It may name the failing field/check, but it MUST NEVER echo the offending
 * asset id, content hash, owner hash, path, filename, metadata value or any
 * generated id — those may be attacker-controlled secrets (Windows paths, etc.).
 */
import type { IdMaps } from "./backupMerge";

export type AssetPlanMode = "structure" | "duplicate";

export type VerifiedIncomingAsset = {
  id: string;
  schemaVersion: 1;
  ownerKeyHash: string;
  contentHash: string;
  size: number;
  mimeType?: string;
  originalFilename?: string;
  createdAt?: number | string;
  metadata?: Record<string, unknown>;
};

export type OccupiedAssetManifest = {
  id: string;
  ownerKeyHash: string;
  contentHash: string;
  size: number;
  manifest?: Record<string, unknown>;
};

export type KnownObject = {
  contentHash: string;
  size: number;
  verified: boolean;
};

export type PlanBackupAssetImportInput = {
  mode: AssetPlanMode;
  targetOwnerKeyHash: string;
  requiredAssetIds: string[];
  incomingAssets: VerifiedIncomingAsset[];
  occupiedManifests: OccupiedAssetManifest[];
  knownObjects: KnownObject[];
  workspaceIdMaps: IdMaps;
  createAssetId: (prefix: string) => string;
};

export type AssetManifestPlan = {
  sourceAssetId: string;
  targetAssetId: string;
  action: "create" | "reuse";
  plannedManifest: Record<string, unknown>;
};

export type AssetObjectPlan = {
  contentHash: string;
  size: number;
  action: "copy" | "reuse";
};

export type BackupAssetImportPlan = {
  ready: boolean;
  assetIdMap: Record<string, string>;
  manifestPlans: AssetManifestPlan[];
  objectPlans: AssetObjectPlan[];
  requiredAssetIds: string[];
  unresolvedAssetIds: string[];
  conflicts: Array<{ code: string; sourceAssetId?: string }>;
  counts: {
    required: number;
    manifestsToCreate: number;
    manifestsReused: number;
    objectsToCopy: number;
    objectsReused: number;
    unresolved: number;
    conflicts: number;
  };
};

// ----------------------------------------------------------------------------
// Constants & validators
// ----------------------------------------------------------------------------

const HEX64_RE = /^[a-f0-9]{64}$/;

/** A "safe non-empty id" is a non-empty string made of common id characters
 *  (alphanumerics, underscore, hyphen) and bounded length. It is deliberately
 *  conservative so we never pass a Windows path / URL / object into an id slot.
 *  The same rule applies to both input ids and generated (createAssetId) ids:
 *  a generated id that fails this regex is rejected, never accepted. */
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;

/** Candidates that must never be accepted as an id even if they matched
 *  SAFE_ID_RE structurally (defence-in-depth against paths / urls / slashes). */
const FORBIDDEN_ID_PART_RE = /[\\/:.\s]|^\.|^ | $|\.\.|^[A-Za-z]+:\/\//;

function asNonEmptyString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "";
  return value;
}

function isSafeId(value: unknown): boolean {
  if (typeof value !== "string" || !SAFE_ID_RE.test(value)) return false;
  // Reject things that merely look like a Windows path / URL / dotted / blank
  // even though they slipped through the character class (e.g. "a.b" is fine
  // but "C:\\x", "http://x", ".hidden", "a b" must never be an id).
  if (FORBIDDEN_ID_PART_RE.test(value)) return false;
  return true;
}

function isHex64(value: unknown): boolean {
  return typeof value === "string" && HEX64_RE.test(value);
}

function isNonNegativeSafeInt(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

/** True only for plain JSON objects (own enumerable string keys, prototype is
 *  exactly Object.prototype, no poison). Rejects arrays, null, class
 *  instances, Date, Map, Set and __proto__-polluted objects. */
function isPlainSafeObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype) return false;
  // Reject __proto__ / prototype / constructor own-keys (prototype pollution).
  for (const ownKey of Object.keys(value)) {
    if (
      ownKey === "__proto__" ||
      ownKey === "prototype" ||
      ownKey === "constructor"
    ) {
      return false;
    }
  }
  return true;
}

// ----------------------------------------------------------------------------
// Recursive stable canonicalizer (for exact-reuse semantic comparison)
// ----------------------------------------------------------------------------

/**
 * Produce a deterministic, comparison-safe canonical string for a manifest.
 *
 * Rules:
 *  - Object keys are sorted lexicographically.
 *  - Arrays keep their order.
 *  - Supports JSON-safe null / boolean / finite number / string / array /
 *    plain object.
 *  - Rejects (returns null) function, symbol, BigInt, NaN, Infinity, cycles
 *    and unsafe (non-plain, poisoned) prototypes.
 *  - Never echoes the input value into an error; on rejection it returns null
 *    without throwing a value-bearing message.
 */
function canonicalize(value: unknown, seen: Set<object>): string | null {
  if (value === null) return JSON.stringify(null); // "null"
  const t = typeof value;
  if (t === "boolean") return JSON.stringify(value); // "true" / "false"
  if (t === "number") {
    if (!Number.isFinite(value)) return null; // NaN / Infinity rejected
    return JSON.stringify(value);
  }
  if (t === "string") return JSON.stringify(value); // "\"a,s:b\"" etc.
  if (t === "bigint" || t === "symbol" || t === "function" || t === "undefined") {
    return null; // never accepted
  }
  if (Array.isArray(value)) {
    // Guard against cycles before recursing into the array. Shared (non-cyclic)
    // sub-objects are allowed: we drop the entry on completion so a later
    // reference in another branch is re-canonicalized by value, not misjudged
    // as a cycle.
    const arr = value as object;
    if (seen.has(arr)) return null; // cyclic array rejected
    seen.add(arr);
    const parts: string[] = [];
    for (const item of value as unknown[]) {
      const c = canonicalize(item, seen);
      if (c === null) {
        seen.delete(arr);
        return null;
      }
      parts.push(c);
    }
    seen.delete(arr);
    return "[" + parts.join(",") + "]";
  }
  if (t === "object") {
    const obj = value as object;
    if (seen.has(obj)) return null; // cycle rejected
    if (!isPlainSafeObject(value)) return null; // class / Date / Map / Set / poisoned
    seen.add(obj);
    const keys = Object.keys(value).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const c = canonicalize((value as Record<string, unknown>)[k], seen);
      if (c === null) {
        seen.delete(obj);
        return null;
      }
      parts.push(JSON.stringify(k) + ":" + c);
    }
    seen.delete(obj);
    return "{" + parts.join(",") + "}";
  }
  return null;
}

// ----------------------------------------------------------------------------
// Input validation (throw on any malformed input — never partially plan)
// ----------------------------------------------------------------------------

function validateInput(input: PlanBackupAssetImportInput): void {
  const {
    mode,
    targetOwnerKeyHash,
    requiredAssetIds,
    incomingAssets,
    occupiedManifests,
    knownObjects,
    workspaceIdMaps,
    createAssetId,
  } = input;

  // 1. mode
  if (mode !== "structure" && mode !== "duplicate") {
    throw new Error("INVALID_ASSET_INPUT: mode");
  }
  // 2. targetOwnerKeyHash
  if (!isHex64(targetOwnerKeyHash)) {
    throw new Error("INVALID_ASSET_INPUT: targetOwnerKeyHash");
  }
  // 3-5. requiredAssetIds must be an array of safe, unique ids.
  if (!Array.isArray(requiredAssetIds)) {
    throw new Error("INVALID_ASSET_INPUT: requiredAssetIds");
  }
  {
    const seen = new Set<string>();
    for (const id of requiredAssetIds) {
      if (!isSafeId(id)) {
        throw new Error("INVALID_ASSET_INPUT: requiredAssetIds.entry");
      }
      if (seen.has(id)) {
        throw new Error("INVALID_ASSET_INPUT: requiredAssetIds.duplicate");
      }
      seen.add(id);
    }
  }
  // 6-7. incoming / occupied must be arrays (fail closed, never TypeError).
  if (!Array.isArray(incomingAssets)) {
    throw new Error("INVALID_ASSET_INPUT: incomingAssets");
  }
  if (!Array.isArray(occupiedManifests)) {
    throw new Error("INVALID_ASSET_INPUT: occupiedManifests");
  }
  if (!Array.isArray(knownObjects)) {
    throw new Error("INVALID_ASSET_INPUT: knownObjects");
  }
  // 8-11. incoming asset id unique + shape.
  {
    const seen = new Set<string>();
    for (const a of incomingAssets) {
      if (!isPlainSafeObject(a)) {
        throw new Error("INVALID_ASSET_INPUT: incomingAssets.entry");
      }
      const id = asNonEmptyString(a.id);
      if (!id || !isSafeId(id)) {
        throw new Error("INVALID_ASSET_INPUT: incomingAssets.id");
      }
      if (seen.has(id)) {
        throw new Error("INVALID_ASSET_INPUT: incomingAssets.duplicate");
      }
      seen.add(id);
      if (a.schemaVersion !== 1) {
        throw new Error("INVALID_ASSET_INPUT: incomingAssets.schemaVersion");
      }
      if (!isHex64(a.ownerKeyHash)) {
        throw new Error("INVALID_ASSET_INPUT: incomingAssets.ownerKeyHash");
      }
      if (!isHex64(a.contentHash)) {
        throw new Error("INVALID_ASSET_INPUT: incomingAssets.contentHash");
      }
      if (!isNonNegativeSafeInt(a.size)) {
        throw new Error("INVALID_ASSET_INPUT: incomingAssets.size");
      }
      // Optional fields: type-checked, never silently dropped.
      if (a.mimeType !== undefined && typeof a.mimeType !== "string") {
        throw new Error("INVALID_ASSET_INPUT: incomingAssets.mimeType");
      }
      if (
        a.originalFilename !== undefined &&
        typeof a.originalFilename !== "string"
      ) {
        throw new Error("INVALID_ASSET_INPUT: incomingAssets.originalFilename");
      }
      if (a.createdAt !== undefined) {
        const c = a.createdAt;
        if (
          !(typeof c === "number" && Number.isFinite(c)) &&
          !(typeof c === "string" && c.length > 0)
        ) {
          throw new Error("INVALID_ASSET_INPUT: incomingAssets.createdAt");
        }
      }
      // metadata must be plain & recursive JSON-safe (reject prototype/cycle).
      if (a.metadata !== undefined && a.metadata !== null) {
        if (!isPlainSafeObject(a.metadata)) {
          throw new Error("INVALID_ASSET_INPUT: incomingAssets.metadata");
        }
        if (canonicalize(a.metadata, new Set()) === null) {
          throw new Error("INVALID_ASSET_INPUT: incomingAssets.metadata");
        }
      }
      // The entire entry must be recursive JSON-safe: reject any nested
      // function / symbol / BigInt / undefined / NaN / Infinity / cycle /
      // Date / Map / Set / class instance / poisoned prototype anywhere.
      if (canonicalize(a, new Set()) === null) {
        throw new Error("INVALID_ASSET_INPUT: incomingAssets.entry");
      }
    }
    // Two incoming manifests that share a contentHash but declare a different
    // size are an input inconsistency; never pick one arbitrarily.
    {
      const seen = new Map<string, number>();
      for (const a of incomingAssets) {
        const h = asNonEmptyString(a.contentHash);
        const prev = seen.get(h);
        if (prev !== undefined && prev !== a.size) {
          throw new Error("INVALID_ASSET_INPUT: incomingAssets.size.conflict");
        }
        seen.set(h, a.size);
      }
    }
  }
  // 12-13. occupied manifest id unique + shape + descriptor consistency.
  {
    const seen = new Set<string>();
    for (const m of occupiedManifests) {
      if (!isPlainSafeObject(m)) {
        throw new Error("INVALID_ASSET_INPUT: occupiedManifests.entry");
      }
      const id = asNonEmptyString(m.id);
      if (!id || !isSafeId(id)) {
        throw new Error("INVALID_ASSET_INPUT: occupiedManifests.id");
      }
      if (seen.has(id)) {
        throw new Error("INVALID_ASSET_INPUT: occupiedManifests.duplicate");
      }
      seen.add(id);
      if (!isHex64(m.ownerKeyHash)) {
        throw new Error("INVALID_ASSET_INPUT: occupiedManifests.ownerKeyHash");
      }
      if (!isHex64(m.contentHash)) {
        throw new Error("INVALID_ASSET_INPUT: occupiedManifests.contentHash");
      }
      if (!isNonNegativeSafeInt(m.size)) {
        throw new Error("INVALID_ASSET_INPUT: occupiedManifests.size");
      }
      // If a manifest body is supplied it must be a plain JSON object with a
      // schemaVersion exactly 1 and with id / ownerKeyHash / contentHash / size
      // that EXACTLY match the outer descriptor. metadata must be plain.
      if (m.manifest !== undefined && m.manifest !== null) {
        if (!isPlainSafeObject(m.manifest)) {
          throw new Error("INVALID_ASSET_INPUT: occupiedManifests.manifest");
        }
        const body = m.manifest;
        if (body.schemaVersion !== 1) {
          throw new Error(
            "INVALID_ASSET_INPUT: occupiedManifests.manifest.schemaVersion"
          );
        }
        if (asNonEmptyString(body.id) !== id) {
          throw new Error("INVALID_ASSET_INPUT: occupiedManifests.manifest.id");
        }
        if (asNonEmptyString(body.ownerKeyHash) !== m.ownerKeyHash) {
          throw new Error(
            "INVALID_ASSET_INPUT: occupiedManifests.manifest.ownerKeyHash"
          );
        }
        if (asNonEmptyString(body.contentHash) !== m.contentHash) {
          throw new Error(
            "INVALID_ASSET_INPUT: occupiedManifests.manifest.contentHash"
          );
        }
        if (body.size !== m.size) {
          throw new Error(
            "INVALID_ASSET_INPUT: occupiedManifests.manifest.size"
          );
        }
        // The entire manifest body (including every nested field) must be
        // recursive JSON-safe. Any function / symbol / BigInt / undefined /
        // NaN / Infinity / cycle / Date / Map / Set / class / poisoned
        // prototype must be rejected here, NOT silently downgraded to a rekey.
        if (canonicalize(body, new Set()) === null) {
          throw new Error("INVALID_ASSET_INPUT: occupiedManifests.manifest");
        }
      }
    }
  }
  // 14. knownObjects
  {
    const byHash = new Map<string, KnownObject>();
    for (const o of knownObjects) {
      if (!isPlainSafeObject(o)) {
        throw new Error("INVALID_ASSET_INPUT: knownObjects.entry");
      }
      if (!isHex64(o.contentHash)) {
        throw new Error("INVALID_ASSET_INPUT: knownObjects.contentHash");
      }
      if (!isNonNegativeSafeInt(o.size)) {
        throw new Error("INVALID_ASSET_INPUT: knownObjects.size");
      }
      if (typeof o.verified !== "boolean") {
        throw new Error("INVALID_ASSET_INPUT: knownObjects.verified");
      }
      const prev = byHash.get(o.contentHash);
      if (prev) {
        if (prev.size !== o.size || prev.verified !== o.verified) {
          throw new Error("INVALID_ASSET_INPUT: knownObjects.conflict");
        }
      } else {
        byHash.set(o.contentHash, o);
      }
    }
  }
  // 15. createAssetId is a function
  if (typeof createAssetId !== "function") {
    throw new Error("INVALID_ASSET_INPUT: createAssetId");
  }
  // 16. workspaceIdMaps: must be a plain object of 12 plain records, each
  //     mapping safe non-empty ids -> safe non-empty ids. No Date / Map / Set /
  //     class / array / poisoned prototype; no __proto__/prototype/constructor
  //     pollution in keys or target values.
  {
    const requiredCollections = [
      "templates",
      "templateVersions",
      "fields",
      "instances",
      "savedValues",
      "mappingTemplates",
      "importRuns",
      "importRows",
      "mappingDecisions",
      "detectionRuns",
      "folders",
      "tags",
    ] as const;
    if (
      !workspaceIdMaps ||
      typeof workspaceIdMaps !== "object" ||
      Array.isArray(workspaceIdMaps)
    ) {
      throw new Error("INVALID_ASSET_INPUT: workspaceIdMaps");
    }
    if (!isPlainSafeObject(workspaceIdMaps)) {
      throw new Error("INVALID_ASSET_INPUT: workspaceIdMaps");
    }
    for (const key of requiredCollections) {
      const v = (workspaceIdMaps as Record<string, unknown>)[key];
      if (!isPlainSafeObject(v)) {
        throw new Error("INVALID_ASSET_INPUT: workspaceIdMaps.collection");
      }
      for (const [k, val] of Object.entries(v)) {
        if (!isSafeId(k) || !isSafeId(val)) {
          throw new Error(
            "INVALID_ASSET_INPUT: workspaceIdMaps.entry"
          );
        }
      }
    }
  }
}

// ----------------------------------------------------------------------------
// Metadata helpers
// ----------------------------------------------------------------------------

/** Deep clone metadata but only plain objects; reject unsafe before clone. */
function cloneMetadata(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!metadata || typeof metadata !== "object") return {};
  if (!isPlainSafeObject(metadata)) return {};
  return JSON.parse(JSON.stringify(metadata)) as Record<string, unknown>;
}

/** Remap the three officially-confirmed direct metadata relations in place on
 *  a deep clone. We do NOT recurse into other keys. Returns a conflict if any
 *  relation map is missing so the caller can refuse to build an unusable
 *  planned manifest. */
function remapMetadataRelations(
  metadata: Record<string, unknown>,
  workspaceIdMaps: IdMaps
): Array<{ code: string; sourceAssetId?: string }> {
  const conflicts: Array<{ code: string; sourceAssetId?: string }> = [];
  const relationMap: Array<[string, keyof IdMaps]> = [
    ["templateId", "templates"],
    ["templateVersionId", "templateVersions"],
    ["instanceId", "instances"],
  ];
  for (const [field, collection] of relationMap) {
    const raw = metadata[field];
    if (raw === undefined || raw === null) continue;
    const src = asNonEmptyString(raw);
    if (!isSafeId(src)) {
      conflicts.push({ code: "MISSING_RELATION_MAP", sourceAssetId: undefined });
      return conflicts;
    }
    const map = (workspaceIdMaps as Record<string, Record<string, string>>)[
      collection
    ];
    const target = map ? map[src] : undefined;
    if (!target || !isSafeId(target)) {
      conflicts.push({ code: "MISSING_RELATION_MAP", sourceAssetId: undefined });
      return conflicts;
    }
    metadata[field] = target;
  }
  return conflicts;
}

/** Build the full, deterministic, remap-completed planned manifest for a
 *  create action. Includes owner, the three remapped relations and ALL other
 *  verified incoming fields (mimeType, originalFilename, createdAt, full
 *  metadata). Never includes bytes / path / filesystem info. */
function buildPlannedManifest(
  incoming: VerifiedIncomingAsset,
  targetId: string,
  targetOwnerKeyHash: string
): Record<string, unknown> {
  const planned: Record<string, unknown> = {
    schemaVersion: 1,
    id: targetId,
    ownerKeyHash: targetOwnerKeyHash,
    contentHash: incoming.contentHash,
    size: incoming.size,
  };
  if (typeof incoming.mimeType === "string") {
    planned.mimeType = incoming.mimeType;
  }
  if (typeof incoming.originalFilename === "string") {
    planned.originalFilename = incoming.originalFilename;
  }
  if (incoming.createdAt !== undefined) {
    planned.createdAt = incoming.createdAt;
  }
  planned.metadata = cloneMetadata(incoming.metadata);
  return planned;
}

/** Deterministic semantic comparison of two manifests after metadata relation
 *  remap. Returns true only when every comparable field (schemaVersion, id,
 *  ownerKeyHash, contentHash, size, mimeType, originalFilename, createdAt and
 *  the FULL metadata, including all three remapped relations and arbitrary
 *  user metadata) is present, equal and order-independent. Returns false if any
 *  field is added, missing or differs, or if canonicalization rejects either
 *  manifest. */
function manifestsSemanticallyEqual(
  a: Record<string, unknown>,
  b: Record<string, unknown>
): boolean {
  const ca = canonicalize(a, new Set());
  const cb = canonicalize(b, new Set());
  if (ca === null || cb === null) return false;
  return ca === cb;
}

// ----------------------------------------------------------------------------
// Main planner
// ----------------------------------------------------------------------------

export function planBackupAssetImport(
  input: PlanBackupAssetImportInput
): BackupAssetImportPlan {
  validateInput(input);

  const {
    mode,
    targetOwnerKeyHash,
    requiredAssetIds,
    incomingAssets,
    occupiedManifests,
    knownObjects,
    workspaceIdMaps,
    createAssetId,
  } = input;

  // Index incoming assets by id (already validated unique).
  const incomingById = new Map<string, VerifiedIncomingAsset>();
  for (const a of incomingAssets) incomingById.set(a.id, a);

  // Index occupied manifests by id (already validated unique).
  const occupiedById = new Map<string, OccupiedAssetManifest>();
  for (const m of occupiedManifests) occupiedById.set(m.id, m);

  // Known objects by hash (already validated: same hash => same descriptor).
  const knownByHash = new Map<string, KnownObject>();
  for (const o of knownObjects) knownByHash.set(o.contentHash, o);

  const assetIdMap: Record<string, string> = {};
  const manifestPlans: AssetManifestPlan[] = [];
  const objectPlans: AssetObjectPlan[] = [];
  const conflicts: Array<{ code: string; sourceAssetId?: string }> = [];
  const unresolved = new Set<string>();

  // Ids already in use: required ids + all incoming ids + all occupied ids +
  // any target we allocate, so a generated id never collides with an existing
  // asset or a prior allocation (and never equals a source id).
  const used = new Set<string>();
  for (const id of Array.from(requiredAssetIds)) used.add(id);
  for (const id of Array.from(incomingById.keys())) used.add(id);
  for (const id of Array.from(occupiedById.keys())) used.add(id);

  const newAssetId = (sourceId: string): string => {
    for (let attempt = 0; attempt < 64; attempt++) {
      const id = createAssetId("asset");
      if (typeof id !== "string" || id.trim().length === 0) {
        throw new Error("INVALID_ASSET_INPUT: createAssetId.empty");
      }
      if (!isSafeId(id)) {
        throw new Error("INVALID_ASSET_INPUT: createAssetId.unsafe");
      }
      // Must not collide with any used id (incl. source id) and must differ
      // from the source id in the duplicate path (i.e. always a NEW id).
      if (used.has(id)) continue;
      if (id === sourceId) continue;
      used.add(id);
      return id;
    }
    throw new Error("INVALID_ASSET_INPUT: createAssetId.collision");
  };

  // Track which content hashes already have an object plan (dedupe objects).
  const objectPlanHashes = new Set<string>();

  // Build an object plan for a resolved required manifest (create OR reuse).
  // Covers known / missing / corrupt / size-mismatch per the spec. If a hash
  // already has a plan but this resolution claims a DIFFERENT size, that is an
  // input inconsistency and must fail closed (never silently pick the first).
  const ensureObjectPlan = (
    contentHash: string,
    size: number,
    sourceAssetId: string
  ): void => {
    if (objectPlanHashes.has(contentHash)) {
      const existing = objectPlans.find((o) => o.contentHash === contentHash);
      if (existing && existing.size !== size) {
        conflicts.push({
          code: "OBJECT_CONFLICT",
          sourceAssetId,
        });
      }
      return;
    }
    objectPlanHashes.add(contentHash);
    const known = knownByHash.get(contentHash);
    if (!known) {
      objectPlans.push({ contentHash, size, action: "copy" });
      return;
    }
    if (known.verified === true && known.size === size) {
      objectPlans.push({ contentHash, size, action: "reuse" });
    } else {
      // known object exists but is corrupt / size-mismatched -> conflict.
      conflicts.push({
        code: "OBJECT_CONFLICT",
        sourceAssetId,
      });
    }
  };

  // Process only required assets; never plan assets not in requiredAssetIds.
  for (const srcId of requiredAssetIds) {
    const incoming = incomingById.get(srcId);
    if (!incoming) {
      // Required asset has no corresponding incoming manifest.
      unresolved.add(srcId);
      continue;
    }

    // --- Relation remap FIRST, before any id allocation -------------------
    // 1. deep clone + validate incoming manifest (buildPlannedManifest clones
    //    metadata and copies all verified fields onto the planned shape).
    // 2. owner is set to the target owner.
    // 3. remap the three confirmed metadata relations.
    // 4. If a relation map is missing, we refuse the asset: no createAssetId
    //    call, no assetIdMap, no manifest plan, no object plan, no reuse.
    const planned = buildPlannedManifest(incoming, srcId, targetOwnerKeyHash);
    const mdConflicts = remapMetadataRelations(
      planned.metadata as Record<string, unknown>,
      workspaceIdMaps
    );
    if (mdConflicts.length > 0) {
      for (const c of mdConflicts) conflicts.push(c);
      unresolved.add(srcId);
      continue;
    }

    // --- Only after relations resolve do we allocate a target id ----------
    const occupied = occupiedById.get(srcId);
    let targetId: string;
    let action: "create" | "reuse";

    if (mode === "duplicate") {
      // Duplicate: every resolved required asset gets a brand-new target id.
      targetId = newAssetId(srcId);
      action = "create";
    } else if (!occupied) {
      // Structure, unoccupied -> keep same id, create.
      targetId = srcId;
      used.add(srcId);
      action = "create";
    } else if (occupied.ownerKeyHash === targetOwnerKeyHash) {
      // Same owner: exact-reuse check against the occupied manifest (both are
      // relation-remapped). Missing/unsafe occupied.manifest -> safe rekey.
      if (!occupied.manifest || !isPlainSafeObject(occupied.manifest)) {
        targetId = newAssetId(srcId);
        action = "create";
      } else if (
        manifestsSemanticallyEqual(planned, occupied.manifest)
      ) {
        // Exact reuse. `planned` already carries the full, remap-completed
        // metadata; it is the single canonical source for both the reuse
        // decision and the emitted planned manifest.
        targetId = srcId;
        used.add(srcId);
        action = "reuse";
      } else {
        // Same id occupied by same owner but manifest differs -> rekey.
        targetId = newAssetId(srcId);
        action = "create";
      }
    } else {
      // Occupied by a different owner -> must rekey, never overwrite/reuse.
      targetId = newAssetId(srcId);
      action = "create";
    }

    // Finalize the planned manifest id and emit plans. Because `planned` is the
    // same remap-completed clone used for the reuse decision, create and reuse
    // outputs both carry identical relation-remapped metadata.
    planned.id = targetId;
    manifestPlans.push({
      sourceAssetId: srcId,
      targetAssetId: targetId,
      action,
      plannedManifest: planned,
    });
    // assetIdMap only reflects a successfully planned asset.
    assetIdMap[srcId] = targetId;

    // Object plan must be established for every resolved asset (create or
    // reuse); the object may still be missing / corrupt -> conflict there.
    ensureObjectPlan(incoming.contentHash, incoming.size, srcId);
  }

  // Sort object plans by content hash (deterministic).
  objectPlans.sort((a, b) =>
    a.contentHash < b.contentHash ? -1 : a.contentHash > b.contentHash ? 1 : 0
  );

  // Sort manifest plans deterministically (by source id) for stable output.
  manifestPlans.sort((a, b) =>
    a.sourceAssetId < b.sourceAssetId
      ? -1
      : a.sourceAssetId > b.sourceAssetId
      ? 1
      : 0
  );

  // Sort conflicts by code then source id (deterministic).
  conflicts.sort((a, b) => {
    const ca = a.code + "|" + (a.sourceAssetId ?? "");
    const cb = b.code + "|" + (b.sourceAssetId ?? "");
    return ca < cb ? -1 : ca > cb ? 1 : 0;
  });

  // Counts.
  let manifestsToCreate = 0;
  let manifestsReused = 0;
  for (const mp of manifestPlans) {
    if (mp.action === "create") manifestsToCreate++;
    else manifestsReused++;
  }
  let objectsToCopy = 0;
  let objectsReused = 0;
  for (const op of objectPlans) {
    if (op.action === "copy") objectsToCopy++;
    else objectsReused++;
  }

  // ready: no unresolved and no conflicts. An empty plan (no required assets,
  // no conflicts) is ready.
  const ready = unresolved.size === 0 && conflicts.length === 0;

  return {
    ready,
    assetIdMap,
    manifestPlans,
    objectPlans,
    requiredAssetIds: Array.from(new Set(requiredAssetIds)).sort(),
    unresolvedAssetIds: Array.from(unresolved).sort(),
    conflicts,
    counts: {
      required: requiredAssetIds.length,
      manifestsToCreate,
      manifestsReused,
      objectsToCopy,
      objectsReused,
      unresolved: unresolved.size,
      conflicts: conflicts.length,
    },
  };
}
