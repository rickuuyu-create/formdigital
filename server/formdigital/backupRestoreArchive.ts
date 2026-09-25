/**
 * Pure Atomic Restore Archive Builder.
 *
 * This module turns an already-verified `formdigital-portable-backup` source
 * archive AND a `ready:true` Combined Restore Plan into a brand-new,
 * target-owner scoped `formdigital-portable-backup` archive (ZIP). The output
 * archive is the single artifact a later executor hands to the existing Local
 * Data Service portable restore transaction (with `preserveExistingAssets:
 * true`), so the actual write stays atomic and server-side.
 *
 * Deterministic contract: identical input (source bytes + identical Combined
 * Plan + identical targetOwnerKeyHash / transactionArchiveId / createdAt)
 * produces byte-for-byte identical archive bytes. No clock, no Math.random, no
 * I/O, no environment read.
 *
 * Security contract: every validation / build error is a FIXED, VALUE-FREE
 * message. It never echoes an entry name, Windows path, owner hash, asset id,
 * content hash, template name, token, JSON, raw error or stack.
 *
 * Local Service contract: the produced backup manifest MUST carry the official
 * portable fields `id` and `kind`. The later Local Service portable restore
 * (and its success / rollback / rollback-failed journal) reads
 * `verified.manifest.id` as the `sourceBackupId`. Without `id`, that journal
 * field would be `undefined`. Therefore:
 *   - the provided `transactionArchiveId` is mapped onto the official
 *     `manifest.id` (the safe, bounded archive identifier),
 *   - `kind` is fixed to `"merge-restore"`,
 *   - the non-official `transactionArchiveId` field is never emitted.
 *
 * Immutability contract: it never mutates `sourceArchiveBytes`, the Combined
 * Plan, the final Workspace, the asset plan or any planned manifest. The
 * Workspace written to the archive is EXACTLY
 * `combinedPlan.finalWorkspacePlan.mergedWorkspace` — no re-merge, no default
 * fill, no collection filter, no id reconfiguration.
 *
 * Error-trust contract (R3): the ONLY errors that survive as fixed
 * `INVALID_ARCHIVE_*` messages are those created internally by this module via
 * `fail()`. `fail()` registers the error in a module-closure `WeakSet` and
 * locks only its fixed message, so a caller who obtains a thrown error's
 * constructor cannot
 * manufacture a trusted-looking error and cannot mutate a reused error's
 * message. Any error thrown by an external / untrusted object (Proxy trap,
 * accessor getter, structuredClone, the verifier, unzip or JSON) is NEVER
 * trusted — it is always converted into a fixed value-free error. The builder
 * never re-throws an externally-supplied message, and never decides trust by
 * `instanceof`, error name, message prefix or symbol brand.
 *
 * Snapshot contract (R3): BEFORE reading any nested property of the untrusted
 * `combinedPlan`, the builder builds a complete DESCRIPTOR-BASED safe snapshot
 * of the entire combined-plan data graph. The snapshot phase only inspects
 * property descriptors (`getOwnPropertyDescriptor` / `Reflect.ownKeys`) and
 * never executes a getter or triggers a Proxy trap beyond the guarded
 * reflection calls (which are caught and converted to a fixed error). After
 * the snapshot succeeds, every subsequent validation / build step operates
 * ONLY on the trusted snapshot — it never re-reads the original untrusted
 * `combinedPlan`.
 */
import { strToU8, strFromU8, zipSync, unzipSync } from "fflate";
import { sha256 } from "./domain";
import { verifyBackupArchive } from "./assetStore";

// ----------------------------------------------------------------------------
// Public input / output contract
// ----------------------------------------------------------------------------

export type BuildAtomicRestoreArchiveInput = {
  /** Already-verified `formdigital-portable-backup` source archive bytes. */
  sourceArchiveBytes: Uint8Array;
  /** A `ready:true` Combined Restore Plan (with a non-null finalWorkspacePlan). */
  combinedPlan: unknown;
  /** Target owner key hash: lowercase 64-hex. */
  targetOwnerKeyHash: string;
  /** A safe, bounded archive id, mapped onto the official `manifest.id`. */
  transactionArchiveId: string;
  /** Must satisfy the existing Portable Backup verifier's createdAt spec. */
  createdAt: number | string;
};

export type AtomicRestoreArchive = {
  archiveBytes: Uint8Array;
  manifest: {
    format: "formdigital-portable-backup";
    schemaVersion: 1;
    scope: "account";
    templateId: null;
    ownerKeyHash: string;
    /** Official backup id — the safe `transactionArchiveId` mapped here. */
    id: string;
    /** Fixed kind declaring this archive was produced by a merge-restore. */
    kind: "merge-restore";
    createdAt: number | string;
    files: Array<{ path: string; contentHash: string; size: number }>;
    summary: PortableSummary;
  };
  counts: {
    workspaceFiles: number;
    manifestsIncluded: number;
    objectsIncluded: number;
    reusedManifestsOmitted: number;
  };
  preserveExistingAssetsRequired: true;
  expectedWorkspaceRevision: number;
};

type PortableSummary = {
  templates: Array<{ id: string; name: string; versions: number; instances: number }>;
  templateCount: number;
  versionCount: number;
  instanceCount: number;
  mappingTemplateCount: number;
};

// ----------------------------------------------------------------------------
// Fixed, value-free error carrier (R3 trust mechanism)
// ----------------------------------------------------------------------------

/**
 * Errors that may carry a fixed `INVALID_ARCHIVE_*` message are tracked in a
 * module-closure `WeakSet`. Only `fail()` adds to this set, and it does so
 * after constructing the error and locking its message. A caller who captures a
 * thrown error and reads `error.constructor` therefore cannot:
 *   1) forge a new trusted error (the constructor is a plain `Error` subclass
 *      the caller can instantiate, but the instance is NOT in the WeakSet), nor
 *   2) mutate a reused error's fixed message, nor
 *   3) change the prototype or symbol brand to gain trust (only WeakSet
 *      membership — granted solely by `fail()` — decides trust).
 * Trust is decided by `isTrustedError(e)` which checks WeakSet membership; it
 * never uses `instanceof`, error name, message text or a symbol.
 */
const TRUSTED_ERRORS = new WeakSet<object>();

/** Throw a fixed, value-free error that is recognised as trusted internally. */
function fail(code: string): never {
  const err = new Error(code);
  // The WeakSet is the sole trust authority (see isTrustedError). To stop a
  // caller who captures this thrown error from mutating its message and reusing
  // it inside an external getter, we lock `message` as non-writable and
  // non-configurable. We deliberately do NOT call Object.freeze on the whole
  // error object: freezing would make it non-extensible, which breaks test
  // frameworks (e.g. Vitest) that attach reporting metadata to thrown errors.
  // Locking only `message` keeps the object extensible while preventing reuse.
  Object.defineProperty(err, "message", {
    value: code,
    writable: false,
    configurable: false,
    enumerable: false,
  });
  TRUSTED_ERRORS.add(err);
  throw err;
}

/** True only for an error created by THIS module's `fail()`. Safe against a
 *  captured constructor: instantiating `caughtError.constructor` yields an
 *  instance NOT in the WeakSet, so it is never trusted. */
function isTrustedError(e: unknown): boolean {
  return e !== null && typeof e === "object" && TRUSTED_ERRORS.has(e);
}

// ----------------------------------------------------------------------------
// Shared validators (fixed, value-free, fail closed)
// ----------------------------------------------------------------------------

const OWNER_HASH_RE = /^[a-f0-9]{64}$/;
// A safe transaction archive id: alphanumerics / underscore / hyphen, bounded,
// and must NOT look like a Windows path / URL / slash / traversal / blank.
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
const FORBIDDEN_ID_PART_RE = /[\\/:.\s]|^\.|^ | |\.\.|^[A-Za-z]+:\/\//;

// Planned manifest / object-plan / assetIdMap field rules.
const HEX64_RE = /^[a-f0-9]{64}$/;
const MANIFEST_ALLOWED_TOP_KEYS = [
  "schemaVersion",
  "id",
  "ownerKeyHash",
  "contentHash",
  "size",
  "mimeType",
  "originalFilename",
  "createdAt",
  "metadata",
] as const;

function isSafeArchiveId(value: unknown): boolean {
  if (typeof value !== "string" || !SAFE_ID_RE.test(value)) return false;
  if (FORBIDDEN_ID_PART_RE.test(value)) return false;
  return true;
}

/** createdAt rule: EXACTLY aligned with the official Portable Backup verifier
 *  (Web `verifyBackupArchive` + Local `verifyPortableBackup`). Any finite
 *  number >= 0 (including non-integer 1.5) and any parseable date string up to
 *  64 chars are accepted; NaN / Infinity / negative / bad string are rejected. */
function isValidCreatedAt(value: unknown): boolean {
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
  )
    return true;
  if (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 64 &&
    Number.isFinite(Date.parse(value))
  )
    return true;
  return false;
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

function asNonEmptyString(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : "";
}

// ----------------------------------------------------------------------------
// Descriptor-based safe snapshot (R3)
// ----------------------------------------------------------------------------

/**
 * Recursively copy an untrusted value into a TRUSTED plain snapshot using ONLY
 * property descriptors. Rules:
 *   - object: prototype MUST be exactly Object.prototype; own keys MUST be safe
 *     strings; no symbol key; no `__proto__`/`prototype`/`constructor`; every
 *     own property MUST be a data descriptor (no getter/setter); no
 *     non-enumerable data field. We read `descriptor.value` only — getters are
 *     never executed.
 *   - array: prototype MUST be Array.prototype; length MUST be a valid data
 *     descriptor; only canonical indices 0..length-1 (no holes, no extra
 *     own/symbol/accessor properties) are copied via their data descriptors.
 *     We never use `for...of`, spread, `.map`, `.sort`, `Object.entries` or
 *     `array[i]` directly before the check completes.
 *   - JSON data: reject undefined / function / symbol / bigint / NaN / Infinity
 *     / Date / Map / Set / class instance / cycle. The only compatibility
 *     exceptions are Date and JSON-style undefined omission/null conversion in
 *     explicitly selected Workspace serialization subtrees.
 * Any Proxy trap firing during descriptor reflection is caught and converted to
 * a fixed value-free error. Reflect operations may still trigger a trap, so we
 * never claim zero-trap detection — but a plain object/array accessor getter is
 * guaranteed NOT to run because we never read the property value before the
 * descriptor proves it is a data property.
 */
type SnapshotOptions = {
  /** Date is allowed only at or below this exact property path. */
  allowDateUnder?: readonly string[];
  /** Preserve legacy JSON serialization only in explicit Workspace subtrees. */
  allowJsonUndefinedUnder?: ReadonlyArray<readonly string[]>;
};

function safeSnapshot(
  value: unknown,
  field: string,
  options: SnapshotOptions = {}
): unknown {
  return snapshotValue(value, field, new Set(), options, []);
}

function pathIsAtOrBelow(
  path: readonly string[],
  prefix: readonly string[] | undefined
): boolean {
  return (
    prefix !== undefined &&
    path.length >= prefix.length &&
    prefix.every((part, index) => path[index] === part)
  );
}

function pathIsAtOrBelowAny(
  path: readonly string[],
  prefixes: ReadonlyArray<readonly string[]> | undefined
): boolean {
  return prefixes?.some((prefix) => pathIsAtOrBelow(path, prefix)) === true;
}

function snapshotValue(
  value: unknown,
  field: string,
  seen: Set<object>,
  options: SnapshotOptions,
  path: readonly string[]
): unknown {
  // Primitives + null are JSON-safe and copied as-is.
  const t = typeof value;
  if (value === null) return null;
  if (t === "boolean" || t === "number") {
    if (t === "number" && !Number.isFinite(value))
      fail(`INVALID_ARCHIVE_INPUT: ${field}`);
    return value;
  }
  if (t === "string") return value;
  // Reject every non-JSON primitive. In particular, do not silently apply
  // JSON.stringify's lossy undefined omission/null conversion to plan data.
  if (
    t === "undefined" ||
    t === "bigint" ||
    t === "symbol" ||
    t === "function"
  )
    fail(`INVALID_ARCHIVE_INPUT: ${field}`);

  // object / array
  if (value === null || typeof value !== "object")
    fail(`INVALID_ARCHIVE_INPUT: ${field}`);
  const obj = value as object;

  // Cycle guard (use Object.is reference identity, never read values).
  if (seen.has(obj)) fail(`INVALID_ARCHIVE_INPUT: ${field}`);

  let proto: object | null;
  let isArray: boolean;
  try {
    proto = Object.getPrototypeOf(obj);
    isArray = Array.isArray(obj);
  } catch {
    fail(`INVALID_ARCHIVE_INPUT: ${field}`);
  }

  // Date is the sole non-plain-object exception, and only below the merged
  // Workspace serialization subtree. Use intrinsic Date methods so caller
  // overrides are never invoked; reject custom own properties.
  if (proto === Date.prototype) {
    if (!pathIsAtOrBelow(path, options.allowDateUnder))
      fail(`INVALID_ARCHIVE_INPUT: ${field}`);
    let dateKeys: Array<string | symbol>;
    let time: number;
    let iso: string;
    try {
      dateKeys = Reflect.ownKeys(obj) as Array<string | symbol>;
      time = Date.prototype.getTime.call(obj);
      iso = Date.prototype.toISOString.call(obj);
    } catch {
      fail(`INVALID_ARCHIVE_INPUT: ${field}`);
    }
    if (dateKeys.length !== 0 || !Number.isFinite(time))
      fail(`INVALID_ARCHIVE_INPUT: ${field}`);
    return iso;
  }

  if (isArray) {
    if (proto !== Array.prototype) fail(`INVALID_ARCHIVE_INPUT: ${field}`);
    // length must be a plain data descriptor.
    let lenDesc: PropertyDescriptor | undefined;
    try {
      lenDesc = Object.getOwnPropertyDescriptor(obj, "length");
    } catch {
      fail(`INVALID_ARCHIVE_INPUT: ${field}`);
    }
    if (
      !lenDesc ||
      !("value" in lenDesc) ||
      typeof lenDesc.value !== "number" ||
      !Number.isSafeInteger(lenDesc.value) ||
      lenDesc.value < 0 ||
      typeof lenDesc.get === "function" ||
      typeof lenDesc.set === "function" ||
      lenDesc.enumerable !== false ||
      lenDesc.configurable !== false ||
      lenDesc.writable !== true
    )
      fail(`INVALID_ARCHIVE_INPUT: ${field}`);
    const len = lenDesc.value as number;
    // Reject symbol keys / extra own properties (only canonical indices allowed).
    let ownKeys: Array<string | symbol>;
    try {
      ownKeys = Reflect.ownKeys(obj) as Array<string | symbol>;
    } catch {
      fail(`INVALID_ARCHIVE_INPUT: ${field}`);
    }
    for (const k of ownKeys) {
      if (typeof k === "symbol") fail(`INVALID_ARCHIVE_INPUT: ${field}`);
      if (k === "length") continue;
      // Must be a canonical index in [0, len).
      if (!/^(0|[1-9]\d*)$/.test(k)) fail(`INVALID_ARCHIVE_INPUT: ${field}`);
      const idx = Number(k);
      if (!Number.isSafeInteger(idx) || idx >= len)
        fail(`INVALID_ARCHIVE_INPUT: ${field}`);
    }
    // Validate every index descriptor before consuming any descriptor value.
    const indexDescriptors: PropertyDescriptor[] = [];
    for (let i = 0; i < len; i++) {
      // Read each index via descriptor (data only). A hole (no own descriptor)
      // is rejected. Getter/setter index is rejected by the descriptor check.
      let idxDesc: PropertyDescriptor | undefined;
      try {
        idxDesc = Object.getOwnPropertyDescriptor(obj, i);
      } catch {
        fail(`INVALID_ARCHIVE_INPUT: ${field}`);
      }
      if (
        !idxDesc ||
        !("value" in idxDesc) ||
        typeof idxDesc.get === "function" ||
        typeof idxDesc.set === "function" ||
        !idxDesc.enumerable
      )
        fail(`INVALID_ARCHIVE_INPUT: ${field}`);
      indexDescriptors.push(idxDesc);
    }
    seen.add(obj);
    const out = new Array<unknown>(len);
    for (let i = 0; i < len; i++) {
      const childPath = [...path, String(i)];
      if (
        indexDescriptors[i].value === undefined &&
        pathIsAtOrBelowAny(childPath, options.allowJsonUndefinedUnder)
      ) {
        out[i] = null;
        continue;
      }
      out[i] = snapshotValue(
        indexDescriptors[i].value,
        field,
        seen,
        options,
        childPath
      );
    }
    seen.delete(obj);
    return out;
  }

  // Plain object.
  if (proto !== Object.prototype) fail(`INVALID_ARCHIVE_INPUT: ${field}`);
  let ownKeys: Array<string | symbol>;
  try {
    ownKeys = Reflect.ownKeys(obj) as Array<string | symbol>;
  } catch {
    fail(`INVALID_ARCHIVE_INPUT: ${field}`);
  }
  for (const k of ownKeys) {
    if (typeof k === "symbol") fail(`INVALID_ARCHIVE_INPUT: ${field}`);
    if (k === "__proto__" || k === "prototype" || k === "constructor")
      fail(`INVALID_ARCHIVE_INPUT: ${field}`);
  }
  // Validate every property descriptor before consuming any descriptor value.
  const descriptors: Array<[string, PropertyDescriptor]> = [];
  for (const k of ownKeys) {
    if (typeof k === "symbol") continue; // already rejected above
    let desc: PropertyDescriptor | undefined;
    try {
      desc = Object.getOwnPropertyDescriptor(obj, k);
    } catch {
      fail(`INVALID_ARCHIVE_INPUT: ${field}`);
    }
    if (
      !desc ||
      !desc.enumerable ||
      !("value" in desc) ||
      typeof desc.get === "function" ||
      typeof desc.set === "function"
    )
      fail(`INVALID_ARCHIVE_INPUT: ${field}`);
    descriptors.push([k, desc]);
  }
  seen.add(obj);
  const out: Record<string, unknown> = {};
  for (const [k, desc] of descriptors) {
    const childPath = [...path, k];
    if (
      desc.value === undefined &&
      pathIsAtOrBelowAny(childPath, options.allowJsonUndefinedUnder)
    )
      continue;
    out[k] = snapshotValue(
      desc.value,
      field,
      seen,
      options,
      childPath
    );
  }
  seen.delete(obj);
  return out;
}

// ----------------------------------------------------------------------------
// Snapshot-typed helpers (operate on the trusted snapshot only)
// ----------------------------------------------------------------------------

function snapIsPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}

function snapIsArray(v: unknown): v is Array<unknown> {
  return Array.isArray(v);
}

function snapRequireArray(v: unknown, field: string): Array<unknown> {
  if (!snapIsArray(v)) fail(`INVALID_ARCHIVE_INPUT: ${field}`);
  return v;
}

function snapRequireObject(v: unknown, field: string): Record<string, unknown> {
  if (!snapIsPlainObject(v)) fail(`INVALID_ARCHIVE_INPUT: ${field}`);
  return v;
}

/** Snapshot the top-level call envelope without recursively interpreting the
 * typed byte buffer. All descriptors are validated before any value is used. */
function snapshotInputRecord(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object")
    fail("INVALID_ARCHIVE_INPUT: input");

  let proto: object | null;
  let keys: Array<string | symbol>;
  try {
    if (Array.isArray(input)) fail("INVALID_ARCHIVE_INPUT: input");
    proto = Object.getPrototypeOf(input);
    keys = Reflect.ownKeys(input) as Array<string | symbol>;
  } catch (e) {
    if (isTrustedError(e)) throw e;
    fail("INVALID_ARCHIVE_INPUT: input");
  }
  if (proto !== Object.prototype) fail("INVALID_ARCHIVE_INPUT: input");

  const descriptors: Array<[string, PropertyDescriptor]> = [];
  for (const key of keys) {
    if (
      typeof key !== "string" ||
      key === "__proto__" ||
      key === "prototype" ||
      key === "constructor"
    )
      fail("INVALID_ARCHIVE_INPUT: input");
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(input, key);
    } catch {
      fail("INVALID_ARCHIVE_INPUT: input");
    }
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !("value" in descriptor) ||
      typeof descriptor.get === "function" ||
      typeof descriptor.set === "function"
    )
      fail("INVALID_ARCHIVE_INPUT: input");
    descriptors.push([key, descriptor]);
  }

  const snapshot: Record<string, unknown> = {};
  for (const [key, descriptor] of descriptors)
    snapshot[key] = descriptor.value;
  return snapshot;
}

// ----------------------------------------------------------------------------
// Summary derivation — MUST exactly match the official verifier's
// `derivePortableSummary` so the produced `summary` passes verification.
// Operates on a trusted (snapshotted) workspace object only.
// ----------------------------------------------------------------------------

function derivePortableSummary(
  workspace: Record<string, unknown>
): PortableSummary {
  for (const key of [
    "templates",
    "templateVersions",
    "instances",
    "mappingTemplates",
  ])
    if (!Array.isArray(workspace[key]))
      fail("INVALID_ARCHIVE_INPUT: finalWorkspace.derivedSummary");

  const templates = workspace.templates as Array<unknown>;
  const versions = workspace.templateVersions as Array<unknown>;
  const instances = workspace.instances as Array<unknown>;
  const mappings = workspace.mappingTemplates as Array<unknown>;
  const readRelationId = (item: unknown, field: string): string => {
    if (!snapIsPlainObject(item)) fail("INVALID_ARCHIVE_INPUT: finalWorkspace.derivedSummary");
    const value = item[field];
    if (typeof value !== "string" || value.length === 0)
      fail("INVALID_ARCHIVE_INPUT: finalWorkspace.derivedSummary");
    return value;
  };
  const versionTemplateIds = versions.map((item) =>
    readRelationId(item, "templateId")
  );
  const instanceTemplateIds = instances.map((item) =>
    readRelationId(item, "templateId")
  );
  for (const mapping of mappings) readRelationId(mapping, "templateVersionId");

  const previewTemplates = templates.map((item) => {
    if (!snapIsPlainObject(item))
      fail("INVALID_ARCHIVE_INPUT: finalWorkspace.derivedSummary");
    const template = item;
    if (
      typeof template.id !== "string" ||
      template.id.length === 0 ||
      typeof template.name !== "string"
    )
      fail("INVALID_ARCHIVE_INPUT: finalWorkspace.derivedSummary");
    return {
      id: template.id,
      name: template.name,
      versions: versionTemplateIds.filter((id) => id === template.id).length,
      instances: instanceTemplateIds.filter((id) => id === template.id).length,
    };
  });
  return {
    templates: previewTemplates,
    templateCount: templates.length,
    versionCount: versions.length,
    instanceCount: instances.length,
    mappingTemplateCount: mappings.length,
  };
}

// ----------------------------------------------------------------------------
// Combined-plan consistency validation (operates on the trusted snapshot only)
// ----------------------------------------------------------------------------

/**
 * Validate the Combined Restore Plan's cross-section consistency that the
 * builder depends on. All inputs are already-trusted snapshot values.
 */
function validateCombinedConsistency(
  plan: Record<string, unknown>,
  targetOwnerKeyHash: string
): void {
  if (plan.ready !== true)
    fail("INVALID_ARCHIVE_INPUT: combinedPlan.ready");
  const finalWsRaw = plan.finalWorkspacePlan;
  if (finalWsRaw === null || finalWsRaw === undefined)
    fail("INVALID_ARCHIVE_INPUT: finalWorkspacePlan");
  if (!snapIsArray(plan.blockers) || (plan.blockers as Array<unknown>).length > 0)
    fail("INVALID_ARCHIVE_INPUT: combinedPlan.blockers");

  const finalWs = snapRequireObject(finalWsRaw, "finalWorkspacePlan");
  if (
    !snapIsArray(finalWs.unresolvedAssetIds) ||
    (finalWs.unresolvedAssetIds as Array<unknown>).length > 0
  )
    fail("INVALID_ARCHIVE_INPUT: finalWorkspacePlan.unresolved");

  const preconditions = snapRequireObject(plan.preconditions, "preconditions");
  if (!isNonNegativeSafeInt(preconditions.expectedWorkspaceRevision))
    fail("INVALID_ARCHIVE_INPUT: expectedWorkspaceRevision");

  const assetPlan = snapRequireObject(plan.assetPlan, "assetPlan");
  if (assetPlan.ready !== true)
    fail("INVALID_ARCHIVE_INPUT: assetPlan.ready");
  if (!snapIsArray(assetPlan.conflicts) || (assetPlan.conflicts as Array<unknown>).length > 0)
    fail("INVALID_ARCHIVE_INPUT: asset.conflicts");
  if (
    !snapIsArray(assetPlan.unresolvedAssetIds) ||
    (assetPlan.unresolvedAssetIds as Array<unknown>).length > 0
  )
    fail("INVALID_ARCHIVE_INPUT: asset.unresolved");

  // assetIdMap: plain object, every source->target safe, no extra orphan mapping.
  if (!snapIsPlainObject(assetPlan.assetIdMap))
    fail("INVALID_ARCHIVE_INPUT: assetIdMap");
  const assetIdMapRec = assetPlan.assetIdMap as Record<string, unknown>;
  for (const [src, tgt] of Object.entries(assetIdMapRec)) {
    if (!isSafeArchiveId(src) || !isSafeArchiveId(tgt))
      fail("INVALID_ARCHIVE_INPUT: assetIdMap.entry");
  }

  // --- Array validation order: validate arrays BEFORE any iteration --------
  const manifestPlansArr = snapRequireArray(assetPlan.manifestPlans, "manifestPlans");
  const objectPlansArr = snapRequireArray(assetPlan.objectPlans, "objectPlans");
  const requiredAssetIdsArr = validateRequiredSet(assetPlan.requiredAssetIds, "requiredAssetIds");

  // manifestPlans consistency
  const seenManifestSource = new Set<string>();
  const seenManifestTarget = new Set<string>();
  const manifestSourceIds = new Set<string>();
  for (const mp of manifestPlansArr) {
    const m = snapRequireObject(mp, "manifestPlan");
    if (m.action !== "create" && m.action !== "reuse")
      fail("INVALID_ARCHIVE_INPUT: manifestPlan.action");
    const sourceAssetId = asNonEmptyString(m.sourceAssetId);
    const targetAssetId = asNonEmptyString(m.targetAssetId);
    if (!isSafeArchiveId(sourceAssetId))
      fail("INVALID_ARCHIVE_INPUT: manifestPlan.sourceAssetId");
    if (!isSafeArchiveId(targetAssetId))
      fail("INVALID_ARCHIVE_INPUT: manifestPlan.targetAssetId");
    if (seenManifestSource.has(sourceAssetId))
      fail("INVALID_ARCHIVE_INPUT: manifestPlan.sourceDuplicate");
    if (seenManifestTarget.has(targetAssetId))
      fail("INVALID_ARCHIVE_INPUT: manifestPlan.targetDuplicate");
    seenManifestSource.add(sourceAssetId);
    seenManifestTarget.add(targetAssetId);
    manifestSourceIds.add(sourceAssetId);
    const assetIdMapRec = assetPlan.assetIdMap as Record<string, unknown>;
    const mapped = asNonEmptyString(assetIdMapRec[sourceAssetId]);
    if (mapped !== targetAssetId)
      fail("INVALID_ARCHIVE_INPUT: manifestPlan.idMapMismatch");
    // plannedManifest (already a trusted snapshot)
    const pm = snapRequireObject(m.plannedManifest, "manifestPlan.plannedManifest");
    if (pm.schemaVersion !== 1)
      fail("INVALID_ARCHIVE_INPUT: plannedManifest.schemaVersion");
    if (asNonEmptyString(pm.id) !== m.targetAssetId)
      fail("INVALID_ARCHIVE_INPUT: plannedManifest.id");
    if (asNonEmptyString(pm.ownerKeyHash) !== targetOwnerKeyHash)
      fail("INVALID_ARCHIVE_INPUT: plannedManifest.ownerKeyHash");
    if (!isHex64(pm.contentHash))
      fail("INVALID_ARCHIVE_INPUT: plannedManifest.contentHash");
    if (!isNonNegativeSafeInt(pm.size))
      fail("INVALID_ARCHIVE_INPUT: plannedManifest.size");
    for (const key of Object.keys(pm)) {
      if (!(MANIFEST_ALLOWED_TOP_KEYS as readonly string[]).includes(key))
        fail("INVALID_ARCHIVE_INPUT: plannedManifest.unknownKey");
    }
  }

  // Every assetIdMap key MUST be backed by a manifest plan source id.
  for (const src of Object.keys(assetPlan.assetIdMap)) {
    if (!manifestSourceIds.has(src))
      fail("INVALID_ARCHIVE_INPUT: assetIdMap.orphanMapping");
  }

  // objectPlans consistency
  const seenObjectHash = new Set<string>();
  const objectPlanByHash = new Map<string, number>();
  for (const op of objectPlansArr) {
    const o = snapRequireObject(op, "objectPlan");
    if (!isHex64(o.contentHash))
      fail("INVALID_ARCHIVE_INPUT: objectPlan.contentHash");
    if (!isNonNegativeSafeInt(o.size))
      fail("INVALID_ARCHIVE_INPUT: objectPlan.size");
    if (o.action !== "copy" && o.action !== "reuse")
      fail("INVALID_ARCHIVE_INPUT: objectPlan.action");
    const h = asNonEmptyString(o.contentHash);
    if (seenObjectHash.has(h))
      fail("INVALID_ARCHIVE_INPUT: objectPlan.hashDuplicate");
    seenObjectHash.add(h);
    objectPlanByHash.set(h, o.size as number);
  }

  // Every create manifest's contentHash must have exactly one matching object
  // plan with EQUAL size; every object plan must be referenced by >=1 manifest.
  const referencedObjectHashes = new Set<string>();
  for (const mp of manifestPlansArr) {
    const m = snapRequireObject(mp, "manifestPlan");
    const pm = snapRequireObject(m.plannedManifest, "manifestPlan.plannedManifest");
    const h = asNonEmptyString(pm.contentHash);
    referencedObjectHashes.add(h);
    const opSize = objectPlanByHash.get(h);
    if (opSize === undefined)
      fail("INVALID_ARCHIVE_INPUT: objectPlan.missingForManifest");
    if (opSize !== (pm.size as number))
      fail("INVALID_ARCHIVE_INPUT: objectPlan.sizeMismatch");
  }
  seenObjectHash.forEach((h) => {
    if (!referencedObjectHashes.has(h))
      fail("INVALID_ARCHIVE_INPUT: objectPlan.unreferenced");
  });

  // --- Required-set precise cross validation (five sets must be equal) ------
  const preliminaryRequired = validateRequiredSet(
    plan.preliminaryWorkspacePlan && snapIsPlainObject(plan.preliminaryWorkspacePlan)
      ? plan.preliminaryWorkspacePlan.requiredAssetIds
      : [],
    "preliminaryWorkspacePlan.requiredAssetIds"
  );
  const finalRequired = validateRequiredSet(
    finalWs.requiredAssetIds,
    "finalWorkspacePlan.requiredAssetIds"
  );
  const manifestSourceSet = Array.from(manifestSourceIds).sort();
  const assetIdMapKeys = Array.from(Object.keys(assetPlan.assetIdMap)).sort();

  const allEqual =
    JSON.stringify(preliminaryRequired) === JSON.stringify(requiredAssetIdsArr) &&
    JSON.stringify(requiredAssetIdsArr) === JSON.stringify(finalRequired) &&
    JSON.stringify(finalRequired) === JSON.stringify(manifestSourceSet) &&
    JSON.stringify(manifestSourceSet) === JSON.stringify(assetIdMapKeys);
  if (!allEqual)
    fail("INVALID_ARCHIVE_INPUT: requiredSet.diverged");
}

/** Validate an ordered id set from a trusted snapshot value: plain array of
 *  safe ids, no duplicates, no blank / unsafe values. Returns sorted unique. */
function validateRequiredSet(value: unknown, field: string): string[] {
  const arr = snapRequireArray(value, field);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of arr) {
    if (!isSafeArchiveId(id)) fail(`INVALID_ARCHIVE_INPUT: ${field}.entry`);
    const safeId = id as string;
    if (seen.has(safeId)) fail(`INVALID_ARCHIVE_INPUT: ${field}.duplicate`);
    seen.add(safeId);
    out.push(safeId);
  }
  out.sort();
  return out;
}

// ----------------------------------------------------------------------------
// Main builder
// ----------------------------------------------------------------------------

export function buildAtomicRestoreArchive(
  input: BuildAtomicRestoreArchiveInput
): AtomicRestoreArchive {
  // --- Top-level plain-data snapshot (BEFORE any field read) ----------------
  const inputSnapshot = snapshotInputRecord(input);
  const sourceArchiveBytesRaw = inputSnapshot.sourceArchiveBytes;
  const combinedPlanRaw = inputSnapshot.combinedPlan;
  const targetOwnerKeyHashRaw = inputSnapshot.targetOwnerKeyHash;
  const transactionArchiveIdRaw = inputSnapshot.transactionArchiveId;
  const createdAtRaw = inputSnapshot.createdAt;

  // --- Field validation (fail closed, value-free) --------------------------
  let sourceArchiveBytes: Uint8Array;
  try {
    if (!(sourceArchiveBytesRaw instanceof Uint8Array))
      fail("INVALID_ARCHIVE_INPUT: sourceArchiveBytes");
    // Copy before verification/build so later work never depends on caller-
    // owned mutable bytes. Construction failures (including Proxy reflection
    // or iterator failures) are converted to the same fixed public error.
    sourceArchiveBytes = new Uint8Array(sourceArchiveBytesRaw);
  } catch (e) {
    if (isTrustedError(e)) throw e;
    fail("INVALID_ARCHIVE_INPUT: sourceArchiveBytes");
  }
  if (!isHex64(targetOwnerKeyHashRaw))
    fail("INVALID_ARCHIVE_INPUT: targetOwnerKeyHash");
  if (!isSafeArchiveId(transactionArchiveIdRaw))
    fail("INVALID_ARCHIVE_INPUT: transactionArchiveId");
  if (!isValidCreatedAt(createdAtRaw))
    fail("INVALID_ARCHIVE_INPUT: createdAt");

  const targetOwnerKeyHash = targetOwnerKeyHashRaw as string;
  const transactionArchiveId = transactionArchiveIdRaw as string;

  // --- Build a complete descriptor-based safe snapshot of the untrusted
  //     combinedPlan BEFORE reading any nested property. After this, we only
  //     touch the trusted snapshot. Any Proxy trap / accessor getter that fires
  //     during descriptor reflection is converted to a fixed value-free error;
  //     no getter value is ever executed. --------------------------------
  let combinedPlan: Record<string, unknown>;
  try {
    combinedPlan = safeSnapshot(combinedPlanRaw, "combinedPlan", {
      allowDateUnder: ["finalWorkspacePlan", "mergedWorkspace"],
      // Existing legal Workspace values use optional undefined fields which
      // JSON.stringify omits (or converts to null in arrays). Keep that exact
      // serialization behavior only in Workspace data; plan/control fields
      // still reject undefined.
      allowJsonUndefinedUnder: [
        ["preliminaryWorkspacePlan", "mergedWorkspace"],
        ["finalWorkspacePlan", "mergedWorkspace"],
      ],
    }) as Record<string, unknown>;
  } catch (e) {
    if (isTrustedError(e)) throw e;
    // An untrusted Proxy trap / getter threw — never trust its message.
    fail("INVALID_ARCHIVE_INPUT: combinedPlan");
  }
  if (!snapIsPlainObject(combinedPlan))
    fail("INVALID_ARCHIVE_INPUT: combinedPlan");

  // --- Combined plan consistency (trusted snapshot only) ------------------
  try {
    validateCombinedConsistency(combinedPlan, targetOwnerKeyHash);
  } catch (e) {
    if (isTrustedError(e)) throw e;
    // Defensive: any unexpected error from validation is fixed.
    fail("INVALID_ARCHIVE_INPUT: combinedPlan");
  }

  // --- Reject legacy / invalid source archive -----------------------------
  let sourceFormat: string | undefined;
  try {
    const verifiedManifest = verifyBackupArchive(sourceArchiveBytes);
    sourceFormat = verifiedManifest.format;
  } catch {
    fail("INVALID_ARCHIVE_INPUT: sourceArchive");
  }
  if (sourceFormat !== "formdigital-portable-backup")
    fail("INVALID_ARCHIVE_INPUT: sourceArchive");

  // Unzip the source IN MEMORY to copy required object bytes. No disk / service.
  let sourceEntries: Record<string, Uint8Array>;
  try {
    sourceEntries = unzipSync(sourceArchiveBytes);
  } catch {
    fail("INVALID_ARCHIVE_INPUT: sourceArchive");
  }

  // --- Workspace envelope (exact, no re-merge) ----------------------------
  const finalWorkspaceRaw = combinedPlan.finalWorkspacePlan;
  if (finalWorkspaceRaw === null || finalWorkspaceRaw === undefined)
    fail("INVALID_ARCHIVE_INPUT: finalWorkspacePlan");
  const finalWorkspace = snapRequireObject(finalWorkspaceRaw, "finalWorkspacePlan");
  // This subtree is already isolated by the complete plan snapshot above.
  // Its limited Date allowance was converted to the same ISO string that JSON
  // serialization would produce; no original plan object is read again.
  const mergedWorkspace = snapRequireObject(
    finalWorkspace.mergedWorkspace,
    "finalWorkspace.mergedWorkspace"
  );
  const workspaceEnvelope = { workspace: mergedWorkspace };
  let workspaceBytes: Uint8Array;
  try {
    workspaceBytes = strToU8(JSON.stringify(workspaceEnvelope));
  } catch {
    fail("INVALID_ARCHIVE_INPUT: finalWorkspace.serialize");
  }

  // --- Resolve manifests + objects to include (snapshot only) -------------
  const assetPlan = snapRequireObject(combinedPlan.assetPlan, "assetPlan");
  const manifestPlans = snapRequireArray(assetPlan.manifestPlans, "manifestPlans");
  const objectSizeMap = buildObjectSizeMap(assetPlan);
  const includedManifestEntries: Record<string, Uint8Array> = {};
  const includedObjectHashes = new Set<string>();
  let reusedManifestsOmitted = 0;

  // Deterministic iteration: sort manifest plans by target asset id.
  const sortedManifestPlans = [...manifestPlans]
    .map((mp) => snapRequireObject(mp, "manifestPlan"))
    .sort((a, b) =>
      (a.targetAssetId as string) < (b.targetAssetId as string)
        ? -1
        : (a.targetAssetId as string) > (b.targetAssetId as string)
          ? 1
          : 0
    );

  for (const mp of sortedManifestPlans) {
    if (mp.action === "reuse") {
      reusedManifestsOmitted++;
      continue;
    }
    // action === "create": emit an EXACT deep-cloned, validated planned manifest
    // named by target id. structuredClone is only reached AFTER full recursive
    // JSON-safe validation (via safeSnapshot) passed, and any clone error is
    // converted into a fixed value-free error. The clone is emitted verbatim —
    // no field is re-assigned or reshaped afterwards.
    const planned = snapRequireObject(mp.plannedManifest, "manifestPlan.plannedManifest");
    let manifestBody: Record<string, unknown>;
    try {
      manifestBody = structuredClone(planned);
    } catch {
      fail("INVALID_ARCHIVE_INPUT: plannedManifest.clone");
    }
    const targetId = mp.targetAssetId as string;
    let manifestBytes: Uint8Array;
    try {
      manifestBytes = strToU8(JSON.stringify(manifestBody));
    } catch {
      fail("INVALID_ARCHIVE_INPUT: plannedManifest.serialize");
    }
    const entryName = `manifests/${targetId}.json`;
    if (entryName in includedManifestEntries)
      fail("INVALID_ARCHIVE_INPUT: manifestEntryCollision");
    includedManifestEntries[entryName] = manifestBytes;
    const hash = asNonEmptyString(planned.contentHash);
    if (!isHex64(hash))
      fail("INVALID_ARCHIVE_INPUT: plannedManifest.contentHash");
    includedObjectHashes.add(hash);
  }

  // --- Collect + validate object bytes from the source archive ------------
  const includedObjectEntries: Record<string, Uint8Array> = {};
  const sortedObjectHashes = Array.from(includedObjectHashes).sort();
  for (const hash of sortedObjectHashes) {
    const objPath = `objects/${hash}`;
    const objBytes = sourceEntries[objPath];
    // Only absence is rejected. A zero-byte object is legal.
    if (objBytes === undefined)
      fail("INVALID_ARCHIVE_INPUT: missingSourceObject");
    if (sha256(objBytes) !== hash)
      fail("INVALID_ARCHIVE_INPUT: corruptSourceObject");
    // Mandatory size check from the authoritative object plan map. No nullable
    // branch: every included hash MUST have a deterministic size.
    const expectedSize = objectSizeMap.get(hash);
    if (expectedSize === undefined)
      fail("INVALID_ARCHIVE_INPUT: missingObjectSize");
    if (objBytes.byteLength !== expectedSize)
      fail("INVALID_ARCHIVE_INPUT: sourceObjectSizeMismatch");
    includedObjectEntries[objPath] = objBytes;
  }

  // --- Build deterministic entries ----------------------------------------
  const entries: Record<string, Uint8Array> = {
    "account/workspace.json": workspaceBytes,
    ...includedManifestEntries,
    ...includedObjectEntries,
  };

  // --- backup-manifest ------------------------------------------------
  const files: Array<{ path: string; contentHash: string; size: number }> = [];
  for (const [path, bytes] of Object.entries(entries)) {
    files.push({ path, contentHash: sha256(bytes), size: bytes.byteLength });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  let summary: PortableSummary;
  try {
    summary = derivePortableSummary(mergedWorkspace);
  } catch {
    fail("INVALID_ARCHIVE_INPUT: finalWorkspace.derivedSummary");
  }

  const manifest = {
    format: "formdigital-portable-backup" as const,
    schemaVersion: 1 as const,
    scope: "account" as const,
    templateId: null,
    ownerKeyHash: targetOwnerKeyHash,
    id: transactionArchiveId,
    kind: "merge-restore" as const,
    createdAt: createdAtRaw as number | string,
    files,
    summary,
  };

  entries["backup-manifest.json"] = strToU8(JSON.stringify(manifest));

  let archiveBytes: Uint8Array;
  try {
    archiveBytes = zipSync(entries, { level: 6 });
  } catch {
    fail("INVALID_ARCHIVE_OUTPUT: build");
  }

  // --- Self-verification BEFORE returning ---------------------------------
  let selfVerified;
  try {
    selfVerified = verifyBackupArchive(archiveBytes);
  } catch {
    fail("INVALID_ARCHIVE_OUTPUT: verification");
  }
  if (selfVerified.format !== "formdigital-portable-backup")
    fail("INVALID_ARCHIVE_OUTPUT: verification");
  if (selfVerified.schemaVersion !== 1)
    fail("INVALID_ARCHIVE_OUTPUT: verification");
  if (selfVerified.scope !== "account")
    fail("INVALID_ARCHIVE_OUTPUT: verification");
  if (selfVerified.templateId !== null)
    fail("INVALID_ARCHIVE_OUTPUT: verification");
  if (asNonEmptyString(selfVerified.ownerKeyHash) !== targetOwnerKeyHash)
    fail("INVALID_ARCHIVE_OUTPUT: verification");

  // Independently parse the ACTUAL produced backup-manifest.json and assert the
  // Local Service required fields (id / kind) plus the full contract.
  let realManifest: Record<string, unknown>;
  try {
    const out = unzipSync(archiveBytes);
    const raw = out["backup-manifest.json"];
    if (!raw) fail("INVALID_ARCHIVE_OUTPUT: verification");
    realManifest = JSON.parse(strFromU8(raw)) as Record<string, unknown>;
  } catch {
    fail("INVALID_ARCHIVE_OUTPUT: verification");
  }
  if (asNonEmptyString(realManifest.format) !== "formdigital-portable-backup")
    fail("INVALID_ARCHIVE_OUTPUT: verification");
  if (realManifest.schemaVersion !== 1)
    fail("INVALID_ARCHIVE_OUTPUT: verification");
  if (asNonEmptyString(realManifest.scope) !== "account")
    fail("INVALID_ARCHIVE_OUTPUT: verification");
  if (realManifest.templateId !== null)
    fail("INVALID_ARCHIVE_OUTPUT: verification");
  if (asNonEmptyString(realManifest.ownerKeyHash) !== targetOwnerKeyHash)
    fail("INVALID_ARCHIVE_OUTPUT: verification");
  if (asNonEmptyString(realManifest.id) !== transactionArchiveId)
    fail("INVALID_ARCHIVE_OUTPUT: verification");
  if (realManifest.kind !== "merge-restore")
    fail("INVALID_ARCHIVE_OUTPUT: verification");
  if ("transactionArchiveId" in realManifest)
    fail("INVALID_ARCHIVE_OUTPUT: verification");

  return {
    archiveBytes,
    manifest,
    counts: {
      workspaceFiles: 1,
      manifestsIncluded: Object.keys(includedManifestEntries).length,
      objectsIncluded: Object.keys(includedObjectEntries).length,
      reusedManifestsOmitted,
    },
    preserveExistingAssetsRequired: true,
    expectedWorkspaceRevision: (combinedPlan.preconditions as Record<string, unknown>).expectedWorkspaceRevision as number,
  };
}

/** Build the authoritative contentHash -> expected size map from the snapshot
 *  asset plan's objectPlans. Every entry is a non-negative safe integer. */
function buildObjectSizeMap(assetPlan: Record<string, unknown>): Map<string, number> {
  const map = new Map<string, number>();
  const plans = snapRequireArray(assetPlan.objectPlans, "objectPlans");
  for (const op of plans) {
    const o = snapRequireObject(op, "objectPlan");
    const h = asNonEmptyString(o.contentHash);
    const size = o.size;
    if (!isNonNegativeSafeInt(size)) fail("INVALID_ARCHIVE_INPUT: objectPlan.size");
    if (map.has(h)) fail("INVALID_ARCHIVE_INPUT: objectPlan.hashDuplicate");
    map.set(h, size as number);
  }
  return map;
}
