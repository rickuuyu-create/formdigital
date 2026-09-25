/**
 * Pure Combined Restore Planner.
 *
 * This module safely coordinates the two-pass Workspace plan with the Asset
 * Import plan into a single, declarative Combined Restore Plan. It is the
 * orchestration layer that resolves the "dual Workspace planning ID generator
 * consistency" problem: the same `createWorkspaceId` call sequence MUST be
 * produced in both the preliminary and the final Workspace pass, otherwise the
 * final Workspace could allocate different IDs than the Asset Planner was told
 * to expect.
 *
 * The contract is:
 *   1. Phase 1 (preliminary Workspace): call `planWorkspaceBackupMerge`
 *      WITHOUT an assetIdMap, while recording every `createWorkspaceId` call
 *      (prefix, generated id, call order) via a recording wrapper. The external
 *      `createWorkspaceId` is invoked ONLY here.
 *   2. Phase 2 (Asset): call `planBackupAssetImport` using the preliminary
 *      `requiredAssetIds` + `idMaps`. If the asset plan is not fully ready, the
 *      Combined Plan is `ready:false` with `finalWorkspacePlan:null`, and we
 *      NEVER start Phase 3 and NEVER call `createWorkspaceId` again.
 *   3. Phase 3 (final Workspace): call `planWorkspaceBackupMerge` WITH the
 *      asset plan's `assetIdMap`, using a REPLAY generator that returns the
 *      recorded IDs in the recorded order. The external `createWorkspaceId`
 *      must NOT be called again. Replay is fail-closed: any divergence
 *      (prefix order, extra/fewer IDs, idMaps/counts/conflicts/required
 *      mismatch) throws a fixed, value-free error.
 *
 * This module is intentionally side-effect free: it never touches the
 * filesystem, never calls the Local Data Service, never calls
 * `restoreLocalBackup` / `saveLocalWorkspace` / `mutateWorkspace`, never imports
 * `assetStore` / `workspaceStore` runtime functions, and contains no clock /
 * random / crypto / env access. All `LocalWorkspace` imports are type-only.
 *
 * Deterministic contract: identical input + identical generator sequences
 * produce byte-for-byte identical output.
 *
 * Security contract: every validation / replay error is a FIXED, VALUE-FREE
 * message. It never echoes an id, prefix, template name, path, token, owner
 * hash, asset id or stack detail. The external `createWorkspaceId` /
 * `createAssetId` generators are wrapped so any error or unsafe value they
 * produce is converted into a fixed, value-free error at the boundary.
 */
import type {
  IdMaps,
  MergePlan,
  MergeMode,
  CreateId,
} from "./backupMerge";
import { planWorkspaceBackupMerge } from "./backupMerge";
import { planBackupAssetImport } from "./backupAssetPlan";
import type {
  BackupAssetImportPlan,
  VerifiedIncomingAsset,
  OccupiedAssetManifest,
  KnownObject,
  AssetPlanMode,
} from "./backupAssetPlan";
import type { LocalWorkspace } from "./workspaceStore";

// ----------------------------------------------------------------------------
// Public input / output contract
// ----------------------------------------------------------------------------

export type CreateWorkspaceId = (prefix: string) => string;
export type CreateAssetId = (prefix: string) => string;

export type PlanCombinedRestoreInput = {
  current: LocalWorkspace;
  incoming: LocalWorkspace;
  mode: MergeMode;
  ownerId: string;
  targetOwnerKeyHash: string;
  /** Must be a non-negative safe integer. Malformed => fail closed. */
  expectedWorkspaceRevision: number;
  /** Injected fixed epoch-ms time. Never read from the system clock. */
  now: number;
  incomingAssets: VerifiedIncomingAsset[];
  occupiedManifests: OccupiedAssetManifest[];
  knownObjects: KnownObject[];
  createWorkspaceId: CreateWorkspaceId;
  createAssetId: CreateAssetId;
};

export type BlockerCode =
  | "ASSET_PLAN_NOT_READY"
  | "ASSET_REQUIREMENTS_DIVERGED"
  | "WORKSPACE_ASSETS_UNRESOLVED"
  | "WORKSPACE_PLAN_DIVERGED";

export type CombinedRestorePlan = {
  ready: boolean;
  preconditions: {
    expectedWorkspaceRevision: number;
  };
  /** Result of the preliminary (pass 1) Workspace plan. Present even when blocked. */
  preliminaryWorkspacePlan: MergePlan;
  /** Result of the Asset Import plan. Present even when blocked. */
  assetPlan: BackupAssetImportPlan;
  /** The final (pass 2) Workspace plan, or `null` when blocked / not ready. */
  finalWorkspacePlan: MergePlan | null;
  /** Fixed, deduped, deterministically-sorted blocker codes. */
  blockers: BlockerCode[];
  counts: {
    preliminaryRequiredAssetIds: number;
    assetPlannedManifestCount: number;
    assetObjectPlanCount: number;
    finalRequiredAssetIds: number;
    finalUnresolvedAssetIds: number;
  };
  /** Declarative application contract. Never executed by this planner. */
  applicationPhases: Array<{
    phase: string;
    description: string;
  }>;
};

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/** A single recorded Workspace-id generation from the preliminary pass. */
type RecordedId = {
  prefix: string;
  id: string;
};

/**
 * A safe non-empty id is made only of alphanumerics, underscore and hyphen,
 * bounded to 200 chars, and must NOT look like a Windows path / URL / dotfile /
 * relative traversal / blank. This is the SAME rule the underlying asset
 * planner applies to generated ids. The Combined wrapper enforces it on
 * Workspace-generated ids too, and rejects any unsafe value at the boundary
 * without echoing it.
 */
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
const FORBIDDEN_ID_PART_RE = /[\\/:.\s]|^\.|^ | $|\.\.|^[A-Za-z]+:\/\//;

function isSafeId(value: unknown): boolean {
  if (typeof value !== "string" || !SAFE_ID_RE.test(value)) return false;
  if (FORBIDDEN_ID_PART_RE.test(value)) return false;
  return true;
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
  try {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype) return false;
    for (const ownKey of Reflect.ownKeys(value)) {
      if (typeof ownKey !== "string") return false;
      if (
        ownKey === "__proto__" ||
        ownKey === "prototype" ||
        ownKey === "constructor"
      ) {
        return false;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, ownKey);
      if (
        !descriptor ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
        return false;
      }
    }
  } catch {
    return false;
  }
  return true;
}

/**
 * Validate the TOP-LEVEL input BEFORE reading any field. A malformed (null,
 * undefined, array, Date, class instance, primitive, poisoned prototype) input
 * must fail closed with a FIXED, VALUE-FREE message and must NOT surface a raw
 * JavaScript TypeError / getter error / input value.
 */
function validateTopLevelInput(input: unknown): void {
  if (input === null || input === undefined) {
    throw new Error("INVALID_COMBINED_INPUT: input");
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new Error("INVALID_COMBINED_INPUT: input");
  }
  if (!isPlainSafeObject(input)) {
    // class instance / Date / Map / Set / poisoned prototype.
    throw new Error("INVALID_COMBINED_INPUT: input");
  }
}

/** Strict validate the combined input contract (fail closed, value-free). */
function validateCombinedInput(input: PlanCombinedRestoreInput): void {
  if (!isNonNegativeSafeInt(input.expectedWorkspaceRevision)) {
    throw new Error("INVALID_COMBINED_INPUT: expectedWorkspaceRevision");
  }
  if (input.mode !== "structure" && input.mode !== "duplicate") {
    throw new Error("INVALID_COMBINED_INPUT: mode");
  }
  if (typeof input.ownerId !== "string" || input.ownerId.length === 0) {
    throw new Error("INVALID_COMBINED_INPUT: ownerId");
  }
  if (
    typeof input.targetOwnerKeyHash !== "string" ||
    input.targetOwnerKeyHash.length === 0
  ) {
    throw new Error("INVALID_COMBINED_INPUT: targetOwnerKeyHash");
  }
  if (typeof input.now !== "number" || !Number.isFinite(input.now)) {
    throw new Error("INVALID_COMBINED_INPUT: now");
  }
  if (typeof input.createWorkspaceId !== "function") {
    throw new Error("INVALID_COMBINED_INPUT: createWorkspaceId");
  }
  if (typeof input.createAssetId !== "function") {
    throw new Error("INVALID_COMBINED_INPUT: createAssetId");
  }
  if (input.current === null || typeof input.current !== "object") {
    throw new Error("INVALID_COMBINED_INPUT: current");
  }
  if (input.incoming === null || typeof input.incoming !== "object") {
    throw new Error("INVALID_COMBINED_INPUT: incoming");
  }
  if (!Array.isArray(input.incomingAssets)) {
    throw new Error("INVALID_COMBINED_INPUT: incomingAssets");
  }
  if (!Array.isArray(input.occupiedManifests)) {
    throw new Error("INVALID_COMBINED_INPUT: occupiedManifests");
  }
  if (!Array.isArray(input.knownObjects)) {
    throw new Error("INVALID_COMBINED_INPUT: knownObjects");
  }
}

// ----------------------------------------------------------------------------
// Recording / replay generator
// ----------------------------------------------------------------------------

/**
 * Wrap an external generator so every value it produces is validated as a safe
 * non-empty id (and never a Windows path / URL / slash / traversal / blank /
 * over-long value) AND any error it throws is converted into a FIXED,
 * VALUE-FREE error at the boundary. The raw generator value / Error / message /
 * stack / cause is never propagated. `genLabel` names which generator failed
 * (e.g. "createWorkspaceId" / "createAssetId") so the error code is precise
 * without leaking input.
 */
function makeSafeGenerator(
  external: (prefix: string) => string,
  genLabel: "createWorkspaceId" | "createAssetId"
): { gen: CreateId; recording: Array<{ prefix: string; id: string }> } {
  const recording: Array<{ prefix: string; id: string }> = [];
  const gen: CreateId = (prefix: string): string => {
    let id: unknown;
    try {
      id = external(prefix);
    } catch {
      throw new Error(`INVALID_COMBINED_INPUT: ${genLabel}`);
    }
    if (typeof id !== "string" || id.trim().length === 0) {
      throw new Error(`INVALID_COMBINED_INPUT: ${genLabel}`);
    }
    if (!isSafeId(id)) {
      // Reject unsafe id (path / URL / slash / traversal / blank / over-long)
      // without echoing the offending value.
      throw new Error(`INVALID_COMBINED_INPUT: ${genLabel}`);
    }
    if (genLabel === "createWorkspaceId") {
      recording.push({ prefix, id });
    }
    return id;
  };
  return { gen, recording };
}

/**
 * Wrap the external `createWorkspaceId` so every call is recorded (prefix,
 * generated id, call order) AND verified to be a safe non-empty id. The
 * recording is the single source of truth used to replay in Phase 3. The
 * external generator is only ever invoked in Phase 1 (via this wrapper).
 *
 * This is the SAME production generator the planner uses. Tests import it via
 * `makeRecordingGenerator` and assert on the `recording` array if needed, but
 * the replay contract is exercised through `makeReplayGenerator` below.
 */
export function makeRecordingGenerator(
  external: CreateWorkspaceId
): { gen: CreateId; recording: RecordedId[] } {
  const { gen, recording } = makeSafeGenerator(external, "createWorkspaceId");
  return { gen, recording: recording as RecordedId[] };
}

/**
 * Build a replay generator from a preliminary recording. It returns the
 * recorded ids in order; any attempt to consume more ids than recorded, or a
 * mismatched prefix at consumption time, fails closed with a fixed,
 * value-free message. The external generator is NEVER called here.
 *
 * This is a `@internal` production helper: the planner calls it directly, and
 * tests call the SAME function (not a copy) to prove the replay guards.
 */
/** @internal */
export function makeReplayGenerator(recording: RecordedId[]): {
  gen: CreateId;
  index: () => number;
} {
  let cursor = 0;
  const gen: CreateId = (prefix: string): string => {
    if (cursor >= recording.length) {
      // The final pass asked for MORE ids than the preliminary pass recorded.
      throw new Error("COMBINED_RESTORE_PLAN_DIVERGED");
    }
    const recorded = recording[cursor];
    if (recorded.prefix !== prefix) {
      // Prefix order / kind mismatch between preliminary and final pass.
      throw new Error("COMBINED_RESTORE_PLAN_DIVERGED");
    }
    cursor++;
    return recorded.id;
  };
  return { gen, index: () => cursor };
}

// ----------------------------------------------------------------------------
// Consistency checks (pure comparisons)
// ----------------------------------------------------------------------------

function idMapsEqual(a: IdMaps, b: IdMaps): boolean {
  const keys = Object.keys(a) as Array<keyof IdMaps>;
  if (keys.length !== Object.keys(b).length) return false;
  for (const k of keys) {
    const ak = a[k];
    const bk = b[k];
    const akKeys = Object.keys(ak).sort();
    const bkKeys = Object.keys(bk).sort();
    if (akKeys.length !== bkKeys.length) return false;
    for (let i = 0; i < akKeys.length; i++) {
      const key = akKeys[i];
      if (akKeys[i] !== bkKeys[i]) return false;
      if (ak[key] !== bk[key]) return false;
    }
  }
  return true;
}

function countsEqual(a: MergePlan["counts"], b: MergePlan["counts"]): boolean {
  // Both are plain JSON objects with only primitive number values.
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Compare two conflict-decision lists for exact equality across ALL official
 * `ConflictEntry` fields. Arrays (reusedVersionIds / generatedVersionIds) are
 * compared item-by-item with an unambiguous encoding (JSON.stringify of the
 * sorted array) so there is no delimiter-collision between ids. A deterministic
 * sort key is built from every scalar field so two lists that differ only in
 * ordering also compare equal.
 */
function conflictDecisionsEqual(a: MergePlan["conflicts"], b: MergePlan["conflicts"]): boolean {
  if (a.length !== b.length) return false;
  const norm = (list: MergePlan["conflicts"]) =>
    list
      .map((c) => ({
        sourceTemplateId: c.sourceTemplateId,
        sourceName: c.sourceName,
        existingTemplateId: c.existingTemplateId,
        mode: c.mode,
        action: c.action,
        reusedVersionIds: JSON.stringify([...c.reusedVersionIds].sort()),
        generatedVersionIds: JSON.stringify([...c.generatedVersionIds].sort()),
        preservedInstanceCount: c.preservedInstanceCount,
      }))
      .sort((x, y) => {
        const kx = JSON.stringify([x.sourceTemplateId, x.sourceName, x.existingTemplateId, x.mode, x.action, x.reusedVersionIds, x.generatedVersionIds, x.preservedInstanceCount]);
        const ky = JSON.stringify([y.sourceTemplateId, y.sourceName, y.existingTemplateId, y.mode, y.action, y.reusedVersionIds, y.generatedVersionIds, y.preservedInstanceCount]);
        return kx < ky ? -1 : kx > ky ? 1 : 0;
      });
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/**
 * Compare two required-asset-id sets for exact equality (order-independent,
 * duplicate-insensitive). This is the production guard used to detect
 * `ASSET_REQUIREMENTS_DIVERGED`. Two sets are equal iff they contain the same
 * distinct ids. Exposed as `@internal` so tests call the SAME implementation.
 */
/** @internal */
export function requiredAssetIdsEqual(a: string[], b: string[]): boolean {
  const sa = Array.from(new Set(a)).sort();
  const sb = Array.from(new Set(b)).sort();
  if (sa.length !== sb.length) return false;
  for (let i = 0; i < sa.length; i++) {
    if (sa[i] !== sb[i]) return false;
  }
  return true;
}

// ----------------------------------------------------------------------------
// Declarative application phases (fresh copy per call)
// ----------------------------------------------------------------------------

/**
 * Return a brand-new array of phase descriptors on every call. Callers must
 * never be able to mutate one result and affect another result or a shared
 * module constant (deterministic isolation). Each phase object is also a fresh
 * literal, never a shared reference.
 */
function buildApplicationPhases(): Array<{ phase: string; description: string }> {
  return [
    { phase: "revalidate_preconditions", description: "Re-check revision & plan invariants before any mutation." },
    { phase: "stage_objects", description: "Stage content-addressed object bytes per object plan (copy/reuse)." },
    { phase: "stage_manifests", description: "Stage asset manifests per manifest plan (create/reuse)." },
    { phase: "commit_workspace", description: "Apply final Workspace plan (atomic, revision-checked)." },
    { phase: "verify_commit", description: "Verify committed bytes / hashes / revision match the plan." },
    { phase: "append_journal", description: "Append operation journal entry for the restore." },
  ];
}

type CombinedPhaseError =
  | "COMBINED_RESTORE_WORKSPACE_PLAN_FAILED"
  | "COMBINED_RESTORE_ASSET_PLAN_FAILED";

/** @internal Production error boundary; exported so tests exercise this exact path. */
export function rethrowCombinedPhaseError(
  phaseError: CombinedPhaseError,
  error: unknown
): never {
  const message = error instanceof Error ? error.message : "";
  if (
    message === "INVALID_COMBINED_INPUT: createWorkspaceId" ||
    message === "INVALID_COMBINED_INPUT: createAssetId" ||
    message === "COMBINED_RESTORE_PLAN_DIVERGED"
  ) {
    throw new Error(message);
  }
  throw new Error(phaseError);
}

// ----------------------------------------------------------------------------
// Main planner
// ----------------------------------------------------------------------------

export function planCombinedRestore(
  input: PlanCombinedRestoreInput
): CombinedRestorePlan {
  // Must validate the top-level shape BEFORE reading any field, so a malformed
  // input never leaks a raw TypeError / getter error / input value.
  validateTopLevelInput(input);
  validateCombinedInput(input);

  const {
    current,
    incoming,
    mode,
    ownerId,
    now,
    incomingAssets,
    occupiedManifests,
    knownObjects,
    createWorkspaceId,
    createAssetId,
  } = input;

  const blockers = new Set<BlockerCode>();

  // Boundary wrapper: generator-produced `INVALID_COMBINED_INPUT: *` errors are
  // already fixed + value-free, so they are re-thrown verbatim. Only genuinely
  // UNKNOWN errors from the underlying planners are converted to a fixed,
  // value-free phase error (no message / stack / cause leakage).
  // --- Phase 1: preliminary Workspace plan (records + invokes external) ----
  const { gen: recordingGen, recording } = makeRecordingGenerator(createWorkspaceId);
  let preliminaryPlan!: MergePlan;
  try {
    preliminaryPlan = planWorkspaceBackupMerge({
      current,
      incoming,
      mode,
      ownerId,
      createId: recordingGen,
      now,
      // no assetIdMap: preliminary pass
    });
  } catch (e) {
    // Any non-value-free error from the underlying planner is converted to a
    // fixed, value-free phase error at the boundary.
    rethrowCombinedPhaseError("COMBINED_RESTORE_WORKSPACE_PLAN_FAILED", e);
  }

  // --- Phase 2: Asset plan ------------------------------------------------
  // Wrap createAssetId so any throw / unsafe value becomes a fixed value-free
  // error (INVALID_COMBINED_INPUT: createAssetId) at the boundary, not a raw
  // secret-bearing error from the caller's generator.
  const safeAssetGen = makeSafeGenerator(createAssetId, "createAssetId").gen;
  let assetPlan!: BackupAssetImportPlan;
  try {
    assetPlan = planBackupAssetImport({
      mode: mode as AssetPlanMode,
      targetOwnerKeyHash: input.targetOwnerKeyHash,
      requiredAssetIds: preliminaryPlan.requiredAssetIds,
      incomingAssets,
      occupiedManifests,
      knownObjects,
      workspaceIdMaps: preliminaryPlan.idMaps,
      createAssetId: safeAssetGen,
    });
  } catch (e) {
    rethrowCombinedPhaseError("COMBINED_RESTORE_ASSET_PLAN_FAILED", e);
  }

  // A set capturing the preliminary required asset ids (authoritative).
  const preliminaryRequired = preliminaryPlan.requiredAssetIds;

  // Asset plan must be fully ready before we may proceed.
  if (!assetPlan.ready) {
    blockers.add("ASSET_PLAN_NOT_READY");
  }
  if (assetPlan.conflicts.length > 0) {
    blockers.add("ASSET_PLAN_NOT_READY");
  }
  if (assetPlan.unresolvedAssetIds.length > 0) {
    blockers.add("ASSET_PLAN_NOT_READY");
  }
  // The asset planner's required set must precisely match the preliminary
  // Workspace planner's required set (no fabrication / no loss).
  if (!requiredAssetIdsEqual(assetPlan.requiredAssetIds, preliminaryRequired)) {
    blockers.add("ASSET_REQUIREMENTS_DIVERGED");
  }

  const blocked = blockers.size > 0;

  let finalPlan: MergePlan | null = null;
  if (!blocked) {
    // --- Phase 3: final Workspace plan (replay only) ----------------------
    const replay = makeReplayGenerator(recording);
    let finalPlanRes!: MergePlan;
    try {
      finalPlanRes = planWorkspaceBackupMerge({
        current,
        incoming,
        mode,
        ownerId,
        createId: replay.gen,
        now,
        assetIdMap: assetPlan.assetIdMap,
      });
    } catch (e) {
      rethrowCombinedPhaseError("COMBINED_RESTORE_WORKSPACE_PLAN_FAILED", e);
    }
    finalPlan = finalPlanRes;

    // Replay must have consumed the entire recording (no leftover IDs).
    if (replay.index() !== recording.length) {
      // The final pass asked for FEWER ids than the preliminary pass recorded.
      throw new Error("COMBINED_RESTORE_PLAN_DIVERGED");
    }

    // Consistency checks between preliminary and final plans.
    if (!idMapsEqual(preliminaryPlan.idMaps, finalPlanRes.idMaps)) {
      throw new Error("COMBINED_RESTORE_PLAN_DIVERGED");
    }
    if (!countsEqual(preliminaryPlan.counts, finalPlanRes.counts)) {
      throw new Error("COMBINED_RESTORE_PLAN_DIVERGED");
    }
    if (!conflictDecisionsEqual(preliminaryPlan.conflicts, finalPlanRes.conflicts)) {
      throw new Error("COMBINED_RESTORE_PLAN_DIVERGED");
    }
    if (!requiredAssetIdsEqual(preliminaryPlan.requiredAssetIds, finalPlanRes.requiredAssetIds)) {
      throw new Error("COMBINED_RESTORE_PLAN_DIVERGED");
    }
    // Final plan must have no unresolved asset ids (all mapped by asset plan).
    if (finalPlanRes.unresolvedAssetIds.length > 0) {
      blockers.add("WORKSPACE_ASSETS_UNRESOLVED");
    }
  }

  // --- Finalization contract ------------------------------------------------
  // Any blocker => the plan is NOT ready AND there must be NO applicable final
  // plan (the executor must perform zero mutations). `ready` is recomputed
  // here, AFTER all Phase 3 guards, so it can never be a stale pre-Phase-3
  // boolean. If blocked, the produced (possibly stale) finalPlan is discarded.
  const sortedBlockers = Array.from(blockers).sort();
  const hasBlockers = sortedBlockers.length > 0;
  const finalUnresolved = finalPlan ? finalPlan.unresolvedAssetIds.length : 0;

  const ready = !hasBlockers && finalPlan !== null && finalUnresolved === 0;

  // Enforce the hard contract: ready:false => finalWorkspacePlan:null.
  const finalWorkspacePlan: MergePlan | null = ready ? finalPlan : null;

  return {
    ready,
    preconditions: {
      expectedWorkspaceRevision: input.expectedWorkspaceRevision,
    },
    preliminaryWorkspacePlan: preliminaryPlan,
    assetPlan,
    finalWorkspacePlan,
    blockers: sortedBlockers,
    counts: {
      preliminaryRequiredAssetIds: preliminaryPlan.requiredAssetIds.length,
      assetPlannedManifestCount: assetPlan.manifestPlans.length,
      assetObjectPlanCount: assetPlan.objectPlans.length,
      finalRequiredAssetIds: finalWorkspacePlan ? finalWorkspacePlan.requiredAssetIds.length : 0,
      finalUnresolvedAssetIds: finalWorkspacePlan ? finalWorkspacePlan.unresolvedAssetIds.length : 0,
    },
    // Fresh array + fresh phase objects each call (no shared mutable reference).
    applicationPhases: buildApplicationPhases(),
  };
}
