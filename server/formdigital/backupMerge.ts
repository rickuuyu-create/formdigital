/**
 * Pure Workspace merge planner for Structure / Duplicate restore.
 *
 * This module is intentionally side-effect free: it never touches the
 * filesystem, never calls the Local Data Service, never reads or writes an
 * actual Workspace, and never imports `restoreLocalBackup` / `saveLocalWorkspace`
 * / `localServiceClient` / `assetStore`. It is a deterministic pure function that
 * takes a `current` Workspace, an already-strict-verified `incoming` Workspace
 * and produces a planned `mergedWorkspace` plus the bookkeeping a later atomic
 * apply layer will need (conflicts, id maps, asset references).
 *
 * Deterministic contract: for identical `current`, `incoming`, `mode`,
 * `ownerId`, `assetIdMap` and an identical `createId` call sequence, the result
 * is byte-for-byte identical. The planner never reads the system clock — `now`
 * and `createId` are both injected.
 */
import type {
  LocalField,
  LocalInstance,
  LocalTemplate,
  LocalTemplateVersion,
  LocalWorkspace,
} from "./workspaceStore";

export type MergeMode = "structure" | "duplicate";

/** Injected, deterministic id generator. `prefix` matches the existing
 *  `createStableId(prefix)` convention (e.g. "tpl", "ver", "fld"). */
export type CreateId = (prefix: string) => string;

/** Optional map of known source asset id -> target (already-stored) asset id. */
export type AssetIdMap = Record<string, string>;

export type ConflictAction =
  | "overwrite_structure"
  | "import_structure"
  | "create_duplicate";

export type ConflictEntry = {
  sourceTemplateId: string;
  sourceName: string;
  existingTemplateId: string | null;
  mode: MergeMode;
  action: ConflictAction;
  reusedVersionIds: string[];
  generatedVersionIds: string[];
  preservedInstanceCount: number;
};

export type PlanCounts = {
  templatesImported: number;
  templatesOverwritten: number;
  versionsReused: number;
  versionsGenerated: number;
  fieldsImported: number;
  instancesPreserved: number;
  instancesImported: number;
  savedValuesImported: number;
  mappingTemplatesImported: number;
  foldersImported: number;
  tagsImported: number;
  importRunsImported: number;
  importRowsImported: number;
  mappingDecisionsImported: number;
  detectionRunsImported: number;
};

export type IdMaps = {
  templates: Record<string, string>;
  templateVersions: Record<string, string>;
  fields: Record<string, string>;
  instances: Record<string, string>;
  savedValues: Record<string, string>;
  mappingTemplates: Record<string, string>;
  importRuns: Record<string, string>;
  importRows: Record<string, string>;
  mappingDecisions: Record<string, string>;
  detectionRuns: Record<string, string>;
  folders: Record<string, string>;
  tags: Record<string, string>;
};

export type MergePlan = {
  mergedWorkspace: LocalWorkspace;
  conflicts: ConflictEntry[];
  idMaps: IdMaps;
  counts: PlanCounts;
  requiredAssetIds: string[];
  unresolvedAssetIds: string[];
};

export type PlanWorkspaceBackupMergeInput = {
  current: LocalWorkspace;
  incoming: LocalWorkspace;
  mode: MergeMode;
  ownerId: string;
  createId: CreateId;
  /** Injected fixed epoch-ms time. Never read from the system clock. */
  now: number;
  assetIdMap?: AssetIdMap;
};

// ----------------------------------------------------------------------------
// Small typed helpers (no `any`, no value-leaking errors)
// ----------------------------------------------------------------------------

type Rec = Record<string, unknown>;

const ARRAY_FIELDS: Array<keyof LocalWorkspace> = [
  "templates",
  "templateVersions",
  "fields",
  "instances",
  "folders",
  "tags",
  "savedValues",
  "mappingTemplates",
  "importRuns",
  "importRows",
  "mappingDecisions",
  "detectionRuns",
  "operationJournal",
];

/** Normalized template name used for collision detection.
 *  Case-insensitive + trimmed, using a locale-independent transform so the
 *  same input always yields the same key regardless of the host's locale. */
export function normalizeTemplateName(name: unknown): string {
  if (typeof name !== "string") return "";
  return name.trim().toLowerCase();
}

function asNonEmptyString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "";
  return value;
}

function requireNonEmptyString(record: Rec, field: string, ctx: string): string {
  const value = asNonEmptyString(record[field]);
  if (!value) {
    // Value-free: names the record type + field but never echoes the value.
    throw new Error(`MISSING_REQUIRED: ${ctx}.${field}`);
  }
  return value;
}

/** Collect / remap asset references. We only ever look at keys whose name ends
 *  in `assetId` (e.g. `assetId`, `sourceAssetId`) — never every field named
 *  `id`. Unknown nested structures (pageManifest, outputHistory) are scanned
 *  with a bounded depth + cycle guard so we never blow the stack or loop. */
const ASSET_KEY_RE = /assetId$/i;
const ASSET_SCAN_DEPTH = 12;

/** Mutates the (already deep-cloned) record in place: records every asset id it
 *  finds into `required`, remaps it when the `map` knows it, and records
 *  unmapped ids into `unresolved`. Never fabricates an id. Uses a bounded
 *  depth + cycle guard so nested pageManifest / outputHistory never blow the
 *  stack or loop. */
function remapAssetIds(
  value: unknown,
  map: AssetIdMap,
  required: Set<string>,
  unresolved: Set<string>,
  depth = 0,
  visited: Set<object> = new Set()
): void {
  if (depth > ASSET_SCAN_DEPTH) return;
  if (value === null || typeof value !== "object") return;
  const obj = value as object;
  if (visited.has(obj)) return;
  visited.add(obj);
  if (Array.isArray(value)) {
    for (const item of value) remapAssetIds(item, map, required, unresolved, depth + 1, visited);
    return;
  }
  const rec = value as Rec;
  for (const [key, v] of Object.entries(rec)) {
    if (ASSET_KEY_RE.test(key) && typeof v === "string" && v.length > 0) {
      required.add(v);
      if (map[v]) rec[key] = map[v];
      else unresolved.add(v);
    } else if (typeof v === "object" && v !== null) {
      remapAssetIds(v, map, required, unresolved, depth + 1, visited);
    }
  }
}

function emptyCounts(): PlanCounts {
  return {
    templatesImported: 0,
    templatesOverwritten: 0,
    versionsReused: 0,
    versionsGenerated: 0,
    fieldsImported: 0,
    instancesPreserved: 0,
    instancesImported: 0,
    savedValuesImported: 0,
    mappingTemplatesImported: 0,
    foldersImported: 0,
    tagsImported: 0,
    importRunsImported: 0,
    importRowsImported: 0,
    mappingDecisionsImported: 0,
    detectionRunsImported: 0,
  };
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

// ----------------------------------------------------------------------------
// Validation (throw on broken relation — never `continue` and drop data)
// ----------------------------------------------------------------------------

function assertArray(value: unknown, label: string): Array<Rec> {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  return value as Array<Rec>;
}

function assertUniqueIds(records: Array<Rec>, typeName: string): void {
  const seen = new Set<string>();
  for (const rec of records) {
    const id = asNonEmptyString(rec.id);
    // Value-free: never echo the colliding / missing id (it may be an attack
    // payload such as a Windows path or secret).
    if (!id) throw new Error(`MISSING_REQUIRED: incoming.${typeName}.id`);
    if (seen.has(id)) {
      throw new Error(`DUPLICATE_ID: ${typeName}`);
    }
    seen.add(id);
  }
}

function validateWorkspaceShape(ws: unknown, label: string): LocalWorkspace {
  if (!ws || typeof ws !== "object" || Array.isArray(ws)) {
    throw new Error(`${label} must be an object.`);
  }
  const record = ws as LocalWorkspace;
  for (const field of ARRAY_FIELDS) {
    assertArray((record as Rec)[field], `${label}.${String(field)}`);
  }
  return record;
}

/** Strict validation of the incoming (backup) Workspace.
 *
 *  Security contract: every relation / shape / duplicate / cycle error is a
 *  FIXED, VALUE-FREE message. It may name the record type and the field, but
 *  it MUST NEVER echo the offending id, name, path, raw value or any incoming
 *  data — those may be attacker-controlled secrets (Windows paths, etc.). */
function validateIncoming(incoming: LocalWorkspace): void {
  const templates = assertArray(incoming.templates, "incoming.templates");
  const versions = assertArray(
    incoming.templateVersions,
    "incoming.templateVersions"
  );
  const fields = assertArray(incoming.fields, "incoming.fields");
  const instances = assertArray(incoming.instances, "incoming.instances");
  const savedValues = assertArray(incoming.savedValues, "incoming.savedValues");
  const mappings = assertArray(
    incoming.mappingTemplates,
    "incoming.mappingTemplates"
  );
  const importRuns = assertArray(incoming.importRuns, "incoming.importRuns");
  const importRows = assertArray(incoming.importRows, "incoming.importRows");
  const decisions = assertArray(
    incoming.mappingDecisions,
    "incoming.mappingDecisions"
  );
  const detections = assertArray(
    incoming.detectionRuns,
    "incoming.detectionRuns"
  );
  const folders = assertArray(incoming.folders, "incoming.folders");
  const tags = assertArray(incoming.tags, "incoming.tags");

  // Value-free duplicate-id check (never echoes the colliding id).
  assertUniqueIds(templates, "Template");
  assertUniqueIds(versions, "TemplateVersion");
  assertUniqueIds(fields, "Field");
  assertUniqueIds(instances, "Instance");
  assertUniqueIds(savedValues, "SavedValue");
  assertUniqueIds(mappings, "MappingTemplate");
  assertUniqueIds(importRuns, "ImportRun");
  assertUniqueIds(importRows, "ImportRow");
  assertUniqueIds(decisions, "MappingDecision");
  assertUniqueIds(detections, "DetectionRun");
  assertUniqueIds(folders, "Folder");
  assertUniqueIds(tags, "Tag");

  const versionIds = new Set(versions.map((v) => asNonEmptyString(v.id)));
  const templateIds = new Set(templates.map((t) => asNonEmptyString(t.id)));
  const folderIds = new Set(folders.map((f) => asNonEmptyString(f.id)));
  const tagIds = new Set(tags.map((t) => asNonEmptyString(t.id)));
  const runIds = new Set(importRuns.map((r) => asNonEmptyString(r.id)));

  // versionId -> templateId (for belonging checks)
  const versionTemplate = new Map<string, string>();
  for (const v of versions) {
    versionTemplate.set(
      asNonEmptyString(v.id),
      asNonEmptyString(v.templateId)
    );
  }
  // templateId -> set of stableFieldIds across all its versions' fields
  const templateStableFields = new Map<string, Set<string>>();
  // versionId -> set of stableFieldIds (for MappingDecision stable-field check)
  const versionStableFields = new Map<string, Set<string>>();
  for (const f of fields) {
    const vid = asNonEmptyString(f.templateVersionId);
    const tid = versionTemplate.get(vid);
    const sf = asNonEmptyString(f.stableFieldId);
    if (tid) {
      if (!templateStableFields.has(tid)) templateStableFields.set(tid, new Set());
      if (sf) templateStableFields.get(tid)!.add(sf);
    }
    if (vid) {
      if (!versionStableFields.has(vid)) versionStableFields.set(vid, new Set());
      if (sf) versionStableFields.get(vid)!.add(sf);
    }
  }
  // importRunId -> templateVersionId (for MappingDecision checks)
  const runVersion = new Map<string, string>();
  for (const r of importRuns) {
    runVersion.set(
      asNonEmptyString(r.id),
      asNonEmptyString(r.templateVersionId)
    );
  }

  // Two incoming Templates with the same normalized name must not silently
  // overwrite the same current Template. (Rule message, no incoming value.)
  const nameSeen = new Map<string, string>();
  for (const t of templates) {
    const id = requireNonEmptyString(t, "id", "Incoming Template");
    const name = asNonEmptyString(t.name);
    if (name.trim().length === 0) {
      throw new Error("INVALID_TEMPLATE_NAME: empty");
    }
    const norm = normalizeTemplateName(name);
    const prev = nameSeen.get(norm);
    if (prev && prev !== id) {
      throw new Error(
        "INVALID_TEMPLATE_NAME: duplicate-normalized"
      );
    }
    nameSeen.set(norm, id);
  }

  for (const t of templates) {
    const id = asNonEmptyString(t.id);
    const published = asNonEmptyString(t.currentPublishedVersionId);
    const draft = asNonEmptyString(t.currentDraftVersionId);
    if (published) {
      if (!versionIds.has(published)) {
        throw new Error("INVALID_RELATION: Template.currentPublishedVersionId");
      }
      if (versionTemplate.get(published) !== id) {
        throw new Error(
          "INVALID_RELATION: Template.currentPublishedVersionId (wrong owner)"
        );
      }
    }
    if (draft) {
      if (!versionIds.has(draft)) {
        throw new Error("INVALID_RELATION: Template.currentDraftVersionId");
      }
      if (versionTemplate.get(draft) !== id) {
        throw new Error(
          "INVALID_RELATION: Template.currentDraftVersionId (wrong owner)"
        );
      }
    }
  }

  for (const v of versions) {
    const id = asNonEmptyString(v.id);
    const tid = requireNonEmptyString(v, "templateId", "Incoming Version");
    if (!templateIds.has(tid)) {
      throw new Error("INVALID_RELATION: TemplateVersion.templateId");
    }
  }

  for (const f of fields) {
    const id = asNonEmptyString(f.id);
    const vid = requireNonEmptyString(
      f,
      "templateVersionId",
      "Incoming Field"
    );
    if (!versionIds.has(vid)) {
      throw new Error("INVALID_RELATION: Field.templateVersionId");
    }
  }

  for (const i of instances) {
    const id = asNonEmptyString(i.id);
    const tid = requireNonEmptyString(i, "templateId", "Incoming Instance");
    const vid = requireNonEmptyString(
      i,
      "templateVersionId",
      "Incoming Instance"
    );
    if (!templateIds.has(tid)) {
      throw new Error("INVALID_RELATION: Instance.templateId");
    }
    if (!versionIds.has(vid)) {
      throw new Error("INVALID_RELATION: Instance.templateVersionId");
    }
    const v = versions.find((x) => asNonEmptyString(x.id) === vid);
    if (v && asNonEmptyString(v.templateId) !== tid) {
      throw new Error(
        "INVALID_RELATION: Instance.templateVersionId (wrong owner)"
      );
    }
  }

  for (const s of savedValues) {
    const id = asNonEmptyString(s.id);
    const tid = requireNonEmptyString(s, "templateId", "Incoming SavedValue");
    if (!templateIds.has(tid)) {
      throw new Error("INVALID_RELATION: SavedValue.templateId");
    }
    const stableFieldId = asNonEmptyString(s.stableFieldId);
    if (stableFieldId) {
      const known = templateStableFields.get(tid);
      if (!known || !known.has(stableFieldId)) {
        throw new Error("INVALID_RELATION: SavedValue.stableFieldId");
      }
    }
  }

  for (const m of mappings) {
    const id = asNonEmptyString(m.id);
    const vid = requireNonEmptyString(
      m,
      "templateVersionId",
      "Incoming MappingTemplate"
    );
    if (!versionIds.has(vid)) {
      throw new Error("INVALID_RELATION: MappingTemplate.templateVersionId");
    }
    const tid = requireNonEmptyString(
      m,
      "templateId",
      "Incoming MappingTemplate"
    );
    if (!templateIds.has(tid)) {
      throw new Error("INVALID_RELATION: MappingTemplate.templateId");
    }
    if (versionTemplate.get(vid) !== tid) {
      throw new Error(
        "INVALID_RELATION: MappingTemplate.templateVersionId (wrong owner)"
      );
    }
  }

  for (const r of importRows) {
    const id = asNonEmptyString(r.id);
    const rid = requireNonEmptyString(r, "importRunId", "Incoming ImportRow");
    if (!runIds.has(rid)) {
      throw new Error("INVALID_RELATION: ImportRow.importRunId");
    }
  }

  for (const run of importRuns) {
    const id = asNonEmptyString(run.id);
    const vid = requireNonEmptyString(
      run,
      "templateVersionId",
      "Incoming ImportRun"
    );
    if (!versionIds.has(vid)) {
      throw new Error("INVALID_RELATION: ImportRun.templateVersionId");
    }
  }

  // MappingDecision: importRunId is mandatory; templateStableFieldId must
  // resolve to a field of the SAME version the run points at (not just any
  // version of the same Template); optional templateVersionId must exist and
  // match the run's version.
  for (const d of decisions) {
    const id = asNonEmptyString(d.id);
    const rid = requireNonEmptyString(
      d,
      "importRunId",
      "Incoming MappingDecision"
    );
    if (!runIds.has(rid)) {
      throw new Error("INVALID_RELATION: MappingDecision.importRunId");
    }
    const runVid = runVersion.get(rid);
    const stableFieldId = d.templateStableFieldId;
    if (stableFieldId !== null && stableFieldId !== undefined) {
      const sf = asNonEmptyString(stableFieldId);
      if (!sf) {
        throw new Error("INVALID_RELATION: MappingDecision.templateStableFieldId");
      }
      const known = runVid ? versionStableFields.get(runVid) : undefined;
      if (!known || !known.has(sf)) {
        throw new Error("INVALID_RELATION: MappingDecision.templateStableFieldId");
      }
    }
    const vid = asNonEmptyString(d.templateVersionId);
    if (vid) {
      if (!versionIds.has(vid)) {
        throw new Error("INVALID_RELATION: MappingDecision.templateVersionId");
      }
      if (runVid && vid !== runVid) {
        throw new Error(
          "INVALID_RELATION: MappingDecision.templateVersionId (mismatch with ImportRun)"
        );
      }
    }
  }

  for (const d of detections) {
    const id = asNonEmptyString(d.id);
    const vid = requireNonEmptyString(
      d,
      "templateVersionId",
      "Incoming DetectionRun"
    );
    if (!versionIds.has(vid)) {
      throw new Error("INVALID_RELATION: DetectionRun.templateVersionId");
    }
  }

  for (const f of folders) {
    const id = asNonEmptyString(f.id);
    const pidRaw = f.parentId;
    // parentId must be null / undefined / or a non-empty, non-blank string.
    // Numbers, objects, blank strings are rejected (value-free).
    if (pidRaw !== null && pidRaw !== undefined) {
      if (typeof pidRaw !== "string" || pidRaw.trim().length === 0) {
        throw new Error("INVALID_FOLDER_PARENT: type");
      }
      const pid = pidRaw;
      if (pid === id) {
        throw new Error("INVALID_FOLDER_PARENT: self");
      }
      if (!folderIds.has(pid)) {
        throw new Error("INVALID_FOLDER_PARENT: unknown");
      }
      // Reject parent cycles (direct or indirect).
      const seen = new Set<string>([id]);
      let cursor: string | null = pid;
      while (cursor) {
        if (seen.has(cursor)) {
          throw new Error("INVALID_FOLDER_PARENT: cycle");
        }
        seen.add(cursor);
        const parent = folders.find(
          (x) => asNonEmptyString(x.id) === cursor
        );
        cursor = parent ? asNonEmptyString(parent.parentId) : null;
      }
    }
  }

  // Template folderIds / tagIds: array, non-empty non-blank string entries,
  // unique, each pointing to an incoming Folder/Tag. Fail closed — never
  // silently filtered into an empty array.
  for (const t of templates) {
    const id = asNonEmptyString(t.id);
    const folderIdsVal = t.folderIds;
    if (!Array.isArray(folderIdsVal)) {
      throw new Error("INVALID_TEMPLATE_FOLDER_IDS: not-array");
    }
    const seenF = new Set<string>();
    for (const fid of folderIdsVal) {
      if (typeof fid !== "string" || fid.trim().length === 0) {
        throw new Error("INVALID_TEMPLATE_FOLDER_IDS: invalid-entry");
      }
      if (seenF.has(fid)) {
        throw new Error("INVALID_TEMPLATE_FOLDER_IDS: duplicate");
      }
      seenF.add(fid);
      if (!folderIds.has(fid)) {
        throw new Error("INVALID_TEMPLATE_FOLDER_IDS: unknown");
      }
    }
    const tagIdsVal = t.tagIds;
    if (!Array.isArray(tagIdsVal)) {
      throw new Error("INVALID_TEMPLATE_TAG_IDS: not-array");
    }
    const seenT = new Set<string>();
    for (const tid of tagIdsVal) {
      if (typeof tid !== "string" || tid.trim().length === 0) {
        throw new Error("INVALID_TEMPLATE_TAG_IDS: invalid-entry");
      }
      if (seenT.has(tid)) {
        throw new Error("INVALID_TEMPLATE_TAG_IDS: duplicate");
      }
      seenT.add(tid);
      if (!tagIds.has(tid)) {
        throw new Error("INVALID_TEMPLATE_TAG_IDS: unknown");
      }
    }
  }
}

function templates_getFolderIds(t: Rec): string[] {
  const v = t.folderIds;
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
}
function templates_getTagIds(t: Rec): string[] {
  const v = t.tagIds;
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
}

// ----------------------------------------------------------------------------
// Main planner
// ----------------------------------------------------------------------------

export function planWorkspaceBackupMerge(
  input: PlanWorkspaceBackupMergeInput
): MergePlan {
  const { mode, ownerId, createId, now } = input;
  if (typeof ownerId !== "string" || ownerId.length === 0) {
    throw new Error("ownerId must be a non-empty string.");
  }
  if (typeof now !== "number" || !Number.isFinite(now)) {
    throw new Error("now must be a finite number (epoch ms).");
  }
  if (mode !== "structure" && mode !== "duplicate") {
    throw new Error("mode must be 'structure' or 'duplicate'.");
  }
  const assetIdMap: AssetIdMap = input.assetIdMap ?? {};

  const current = validateWorkspaceShape(input.current, "current");
  const incoming = validateWorkspaceShape(input.incoming, "incoming");
  validateIncoming(incoming);

  const merged: LocalWorkspace = structuredClone(current);
  const counts = emptyCounts();
  const idMaps = emptyIdMaps();
  const conflicts: ConflictEntry[] = [];

  const required = new Set<string>();
  const unresolved = new Set<string>();

  // Ids already in use: every current record id, so generated ids never
  // collide with live data. Kept source ids are added as we keep them.
  const used = new Set<string>();
  for (const field of ARRAY_FIELDS) {
    for (const rec of assertArray((current as Rec)[field], `current.${String(field)}`)) {
      const id = asNonEmptyString(rec.id);
      if (id) used.add(id);
    }
  }

  const newId = (prefix: string): string => {
    for (let attempt = 0; attempt < 64; attempt++) {
      const id = createId(prefix);
      // Fail closed: a generated id must be a non-empty, non-whitespace string
      // that does not collide with an existing or already-allocated id.
      if (typeof id !== "string" || id.trim().length === 0) {
        throw new Error(`createId returned an invalid (empty/whitespace) id for "${prefix}".`);
      }
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
    }
    throw new Error(`Unable to allocate a unique id for "${prefix}" after 64 attempts.`);
  };

  const templateIdMap = new Map<string, string>();
  const versionIdMap = new Map<string, string>();
  const fieldIdMap = new Map<string, string>();
  const instanceIdMap = new Map<string, string>();
  const savedValueIdMap = new Map<string, string>();
  const mappingTemplateIdMap = new Map<string, string>();
  const importRunIdMap = new Map<string, string>();
  const importRowIdMap = new Map<string, string>();
  const mappingDecisionIdMap = new Map<string, string>();
  const detectionRunIdMap = new Map<string, string>();
  const folderIdMap = new Map<string, string>();
  const tagIdMap = new Map<string, string>();

  const reusedVersionTargets = new Set<string>();
  const templatePlans: Array<{
    source: Rec;
    targetId: string;
    action: ConflictAction;
    existingId: string | null;
    record: Rec;
    reusedVersionIds: string[];
    generatedVersionIds: string[];
    preservedInstanceCount: number;
  }> = [];

  // --- Phase A: template id map + conflict plan ---------------------------
  const incomingTemplates = assertArray(incoming.templates, "incoming.templates");
  // Index the (cloned) current templates by normalized name for structure
  // collision. Must be built from `merged` (the clone) so the overwrite target
  // is the object we actually mutate, never the caller's `current`.
  const currentByNormName = new Map<string, Rec>();
  if (mode === "structure") {
    for (const t of assertArray(merged.templates, "merged.templates")) {
      const key = normalizeTemplateName(t.name);
      if (key && !currentByNormName.has(key)) currentByNormName.set(key, t);
    }
  }

  for (const source of incomingTemplates) {
    const sourceId = asNonEmptyString(source.id);
    const sourceName = asNonEmptyString(source.name);
    let targetId: string;
    let action: ConflictAction;
    let existingId: string | null = null;
    let record: Rec;

    if (mode === "structure") {
      const conflict = currentByNormName.get(normalizeTemplateName(sourceName));
      if (conflict) {
        existingId = asNonEmptyString(conflict.id);
        targetId = existingId;
        action = "overwrite_structure";
        // Overlay incoming structure onto the existing (cloned) template,
        // preserving its id, ownerId, createdAt and its Instances.
        const originalCreatedAt = conflict.createdAt;
        const originalName = conflict.name;
        record = conflict as Rec;
        Object.assign(record, structuredClone(source));
        record.id = existingId;
        record.ownerId = ownerId;
        record.createdAt = originalCreatedAt; // preserve history
        record.name = asNonEmptyString(originalName); // keep existing display name
      } else {
        const newTpl = structuredClone(source) as LocalTemplate;
        targetId = newId("tpl");
        action = "import_structure";
        record = newTpl as unknown as Rec;
        record.id = targetId;
        record.ownerId = ownerId;
        record.createdAt = source.createdAt;
        merged.templates.push(newTpl);
      }
    } else {
      targetId = newId("tpl");
      action = "create_duplicate";
      const dup = structuredClone(source) as LocalTemplate;
      record = dup as unknown as Rec;
      record.id = targetId;
      record.ownerId = ownerId;
      record.name = `${sourceName}（匯入副本）`;
      record.createdAt = now;
      merged.templates.push(dup);
    }

    templateIdMap.set(sourceId, targetId);
    idMaps.templates[sourceId] = targetId;
    templatePlans.push({
      source,
      targetId,
      action,
      existingId,
      record,
      reusedVersionIds: [],
      generatedVersionIds: [],
      preservedInstanceCount: 0,
    });
  }

  // --- Phase B: versions ---------------------------------------------------
  for (const source of assertArray(incoming.templateVersions, "incoming.templateVersions")) {
    const sourceId = asNonEmptyString(source.id);
    const targetTemplateId = templateIdMap.get(
      asNonEmptyString(source.templateId)
    );
    if (!targetTemplateId) {
      throw new Error("INVALID_RELATION: TemplateVersion.templateId");
    }
    let targetVersionId: string;
    const plan = templatePlans.find(
      (p) => asNonEmptyString(p.source.id) === asNonEmptyString(source.templateId)
    );

    if (mode === "structure") {
      const existing = (assertArray(current.templateVersions, "current.templateVersions") as Array<Rec>).find(
        (v) =>
          asNonEmptyString(v.templateId) === targetTemplateId &&
          asNonEmptyString(v.contentHash) === asNonEmptyString(source.contentHash)
      );
      if (existing) {
        targetVersionId = asNonEmptyString(existing.id);
        reusedVersionTargets.add(targetVersionId);
        if (plan) plan.reusedVersionIds.push(targetVersionId);
        counts.versionsReused += 1;
      } else {
        targetVersionId = newId("ver");
        const cloned = structuredClone(source) as LocalTemplateVersion;
        (cloned as Rec).id = targetVersionId;
        cloned.templateId = targetTemplateId;
        cloned.createdAt = source.createdAt as number;
        cloned.updatedAt = now;
        // New (non-reused) version: plan its pageManifest asset references.
        remapAssetIds(cloned.pageManifest, assetIdMap, required, unresolved);
        merged.templateVersions.push(cloned as unknown as LocalTemplateVersion);
        if (plan) plan.generatedVersionIds.push(targetVersionId);
        counts.versionsGenerated += 1;
      }
    } else {
      targetVersionId = newId("ver");
      const cloned = structuredClone(source) as LocalTemplateVersion;
      (cloned as Rec).id = targetVersionId;
      cloned.templateId = targetTemplateId;
      cloned.createdAt = now;
      cloned.updatedAt = now;
      // Duplicate version: plan its pageManifest asset references.
      remapAssetIds(cloned.pageManifest, assetIdMap, required, unresolved);
      merged.templateVersions.push(cloned as unknown as LocalTemplateVersion);
      if (plan) plan.generatedVersionIds.push(targetVersionId);
      counts.versionsGenerated += 1;
    }
    versionIdMap.set(sourceId, targetVersionId);
    idMaps.templateVersions[sourceId] = targetVersionId;
  }

  // --- Phase C: fields ------------------------------------------------------
  for (const source of assertArray(incoming.fields, "incoming.fields")) {
    const sourceId = asNonEmptyString(source.id);
    const targetVersionId = versionIdMap.get(
      asNonEmptyString(source.templateVersionId)
    );
    if (!targetVersionId) {
      throw new Error("INVALID_RELATION: Field.templateVersionId");
    }
    // In structure mode a reused version already carries its fields.
    if (mode === "structure" && reusedVersionTargets.has(targetVersionId)) {
      continue;
    }
    const stableFieldId = asNonEmptyString(source.stableFieldId);
    const already = (merged.fields as Array<Rec>).some(
      (f) =>
        asNonEmptyString(f.templateVersionId) === targetVersionId &&
        asNonEmptyString(f.stableFieldId) === stableFieldId
    );
    if (already) continue;
    const targetFieldId = newId("fld");
    const cloned = structuredClone(source) as LocalField;
    (cloned as Rec).id = targetFieldId;
    cloned.templateVersionId = targetVersionId;
    cloned.createdAt = mode === "duplicate" ? now : (source.createdAt as number);
    merged.fields.push(cloned as unknown as LocalField);
    fieldIdMap.set(sourceId, targetFieldId);
    idMaps.fields[sourceId] = targetFieldId;
    counts.fieldsImported += 1;
  }

  // --- Phase D: saved values -----------------------------------------------
  for (const source of assertArray(incoming.savedValues, "incoming.savedValues")) {
    const sourceId = asNonEmptyString(source.id);
    const targetTemplateId = templateIdMap.get(
      asNonEmptyString(source.templateId)
    );
    if (!targetTemplateId) {
      throw new Error("INVALID_RELATION: SavedValue.templateId");
    }
    const stableFieldId = asNonEmptyString(source.stableFieldId);
    const value = asNonEmptyString(source.value);
    // Structure mode may dedupe against the (cloned) merged workspace.
    // Duplicate mode never dedupes: every incoming core record gets a new id.
    if (mode === "structure") {
      const dup = (merged.savedValues as Array<Rec>).some(
        (s) =>
          asNonEmptyString(s.templateId) === targetTemplateId &&
          asNonEmptyString(s.stableFieldId) === stableFieldId &&
          asNonEmptyString(s.value) === value
      );
      if (dup) continue;
    }
    const targetId = newId("value");
    const cloned = structuredClone(source) as Rec;
    cloned.id = targetId;
    cloned.templateId = targetTemplateId;
    cloned.createdAt = mode === "duplicate" ? now : source.createdAt;
    merged.savedValues.push(cloned);
    savedValueIdMap.set(sourceId, targetId);
    idMaps.savedValues[sourceId] = targetId;
    counts.savedValuesImported += 1;
  }

  // --- Phase E: mapping templates ------------------------------------------
  for (const source of assertArray(incoming.mappingTemplates, "incoming.mappingTemplates")) {
    const sourceId = asNonEmptyString(source.id);
    const targetVersionId = versionIdMap.get(
      asNonEmptyString(source.templateVersionId)
    );
    if (!targetVersionId) {
      throw new Error("INVALID_RELATION: MappingTemplate.templateVersionId");
    }
    const targetTemplateId = templateIdMap.get(
      asNonEmptyString(source.templateId)
    );
    if (!targetTemplateId) {
      throw new Error("INVALID_RELATION: MappingTemplate.templateId");
    }
    const name = asNonEmptyString(source.name);
    const mappingHash = asNonEmptyString(source.mappingHash);
    // Structure mode may dedupe against the (cloned) merged workspace.
    // Duplicate mode never dedupes: every incoming core record gets a new id.
    if (mode === "structure") {
      const dup = (merged.mappingTemplates as Array<Rec>).some(
        (m) =>
          asNonEmptyString(m.templateVersionId) === targetVersionId &&
          asNonEmptyString(m.name) === name &&
          asNonEmptyString(m.mappingHash) === mappingHash
      );
      if (dup) continue;
    }
    const targetId = newId("mapping");
    const cloned = structuredClone(source) as Rec;
    cloned.id = targetId;
    cloned.templateVersionId = targetVersionId;
    cloned.templateId = targetTemplateId;
    cloned.createdAt = mode === "duplicate" ? now : source.createdAt;
    merged.mappingTemplates.push(cloned);
    mappingTemplateIdMap.set(sourceId, targetId);
    idMaps.mappingTemplates[sourceId] = targetId;
    counts.mappingTemplatesImported += 1;
  }

  // --- Phase F: folders & tags (referenced by imported templates) ----------
  const referencedFolderIds = new Set<string>();
  const referencedTagIds = new Set<string>();
  for (const plan of templatePlans) {
    for (const fid of templates_getFolderIds(plan.source))
      referencedFolderIds.add(fid);
    for (const tid of templates_getTagIds(plan.source)) referencedTagIds.add(tid);
  }
  // Expand folder ancestors.
  const folderAncestors = new Set<string>(referencedFolderIds);
  let grew = true;
  while (grew) {
    grew = false;
    for (const fid of Array.from(folderAncestors)) {
      const folder = (assertArray(incoming.folders, "incoming.folders") as Array<Rec>).find(
        (f) => asNonEmptyString(f.id) === fid
      );
      if (!folder) continue;
      const pid = asNonEmptyString(folder.parentId);
      if (pid && !folderAncestors.has(pid)) {
        folderAncestors.add(pid);
        grew = true;
      }
    }
  }

  // Assign target ids first, then build with remapped parentId.
  for (const fid of Array.from(folderAncestors)) {
    folderIdMap.set(fid, newId("folder"));
  }
  for (const fid of Array.from(folderAncestors)) {
    const source = (assertArray(incoming.folders, "incoming.folders") as Array<Rec>).find(
      (f) => asNonEmptyString(f.id) === fid
    )!;
    const targetId = folderIdMap.get(fid)!;
    const cloned = structuredClone(source) as Rec;
    cloned.id = targetId;
    const pid = asNonEmptyString(source.parentId);
    cloned.parentId = pid ? (folderIdMap.get(pid) ?? pid) : null;
    cloned.createdAt = mode === "duplicate" ? now : source.createdAt;
    if ("updatedAt" in cloned) cloned.updatedAt = now;
    merged.folders.push(cloned);
    counts.foldersImported += 1;
  }
  for (const tid of Array.from(referencedTagIds)) {
    const targetId = newId("tag");
    tagIdMap.set(tid, targetId);
    const source = (assertArray(incoming.tags, "incoming.tags") as Array<Rec>).find(
      (t) => asNonEmptyString(t.id) === tid
    )!;
    const cloned = structuredClone(source) as Rec;
    cloned.id = targetId;
    cloned.createdAt = mode === "duplicate" ? now : source.createdAt;
    if ("updatedAt" in cloned) cloned.updatedAt = now;
    merged.tags.push(cloned);
    counts.tagsImported += 1;
  }

  // --- Phase G: finalize template records (pointers, owner, folder/tag) -----
  for (const plan of templatePlans) {
    const record = plan.record;
    const source = plan.source;
    record.ownerId = ownerId;
    record.updatedAt = now;
    const published = asNonEmptyString(source.currentPublishedVersionId);
    const draft = asNonEmptyString(source.currentDraftVersionId);
    record.currentPublishedVersionId = published
      ? (versionIdMap.get(published) ?? null)
      : null;
    record.currentDraftVersionId = draft
      ? (versionIdMap.get(draft) ?? null)
      : null;
    record.folderIds = templates_getFolderIds(source).map(
      (fid) => folderIdMap.get(fid) ?? fid
    );
    record.tagIds = templates_getTagIds(source).map(
      (tid) => tagIdMap.get(tid) ?? tid
    );
    if (plan.action === "overwrite_structure") {
      counts.templatesOverwritten += 1;
      plan.preservedInstanceCount = (merged.instances as Array<Rec>).filter(
        (i) => asNonEmptyString(i.templateId) === plan.existingId
      ).length;
    } else if (plan.action === "import_structure") {
      counts.templatesImported += 1;
      plan.preservedInstanceCount = 0;
    } else {
      counts.templatesImported += 1;
      plan.preservedInstanceCount = 0;
    }
    conflicts.push({
      sourceTemplateId: asNonEmptyString(source.id),
      sourceName: asNonEmptyString(source.name),
      existingTemplateId: plan.existingId,
      mode,
      action: plan.action,
      reusedVersionIds: plan.reusedVersionIds,
      generatedVersionIds: plan.generatedVersionIds,
      preservedInstanceCount: plan.preservedInstanceCount,
    });
  }

  // --- Phase H: duplicate-only Instance / Import / Decision / Detection -----
  if (mode === "duplicate") {
    for (const source of assertArray(incoming.instances, "incoming.instances")) {
      const sourceId = asNonEmptyString(source.id);
      const targetId = newId("ins");
      instanceIdMap.set(sourceId, targetId);
      const cloned = structuredClone(source) as LocalInstance;
      (cloned as Rec).id = targetId;
      cloned.ownerId = ownerId;
      cloned.templateId = templateIdMap.get(asNonEmptyString(source.templateId))!;
      cloned.templateVersionId = versionIdMap.get(
        asNonEmptyString(source.templateVersionId)
      )!;
      cloned.name = `${asNonEmptyString(source.name)}（匯入副本）`;
      cloned.createdAt = now;
      cloned.updatedAt = now;
      // Asset remap is confined to the officially-confirmed location:
      // Instance.outputHistory only. Any other nested `*assetId` key on the
      // Instance is left byte-for-byte untouched and never enters required /
      // unresolved.
      remapAssetIds(cloned.outputHistory, assetIdMap, required, unresolved);
      merged.instances.push(cloned as unknown as LocalInstance);
      counts.instancesImported += 1;
    }
    for (const source of assertArray(incoming.importRuns, "incoming.importRuns")) {
      const sourceId = asNonEmptyString(source.id);
      const targetId = newId("run");
      importRunIdMap.set(sourceId, targetId);
      const cloned = structuredClone(source) as Rec;
      cloned.id = targetId;
      cloned.ownerId = ownerId;
      cloned.templateVersionId = versionIdMap.get(
        asNonEmptyString(source.templateVersionId)
      )!;
      cloned.createdAt = now;
      cloned.completedAt =
        source.completedAt == null ? null : now;
      // Asset remap is confined to the officially-confirmed direct field
      // `sourceAssetId`. decisionManifest / other metadata is never scanned,
      // so nested `*assetId` keys there stay byte-for-byte intact and never
      // enter required / unresolved.
      const srcAsset = asNonEmptyString(cloned.sourceAssetId);
      if (srcAsset) {
        required.add(srcAsset);
        const mapped = assetIdMap[srcAsset];
        if (mapped) {
          cloned.sourceAssetId = mapped;
        } else {
          unresolved.add(srcAsset);
        }
      }
      merged.importRuns.push(cloned);
      counts.importRunsImported += 1;
    }
    for (const source of assertArray(incoming.importRows, "incoming.importRows")) {
      const sourceId = asNonEmptyString(source.id);
      const targetId = newId("row");
      importRowIdMap.set(sourceId, targetId);
      const srcRunId = asNonEmptyString(source.importRunId);
      const targetRunId = importRunIdMap.get(srcRunId);
      if (!targetRunId) {
        throw new Error("INVALID_RELATION: ImportRow.importRunId");
      }
      const srcInstance = asNonEmptyString(source.instanceId);
      let targetInstanceId: string | null = null;
      if (srcInstance) {
        targetInstanceId = instanceIdMap.get(srcInstance) ?? null;
        if (!targetInstanceId) {
          throw new Error("INVALID_RELATION: ImportRow.instanceId");
        }
        // Instance / ImportRun version consistency.
        const runTemplateVersionId = versionIdMap.get(
          asNonEmptyString(
            (assertArray(incoming.importRuns, "incoming.importRuns") as Array<Rec>).find(
              (r) => asNonEmptyString(r.id) === srcRunId
            )?.templateVersionId ?? ""
          )
        );
        const instTemplateVersionId = versionIdMap.get(
          asNonEmptyString(
            (assertArray(incoming.instances, "incoming.instances") as Array<Rec>).find(
              (i) => asNonEmptyString(i.id) === srcInstance
            )?.templateVersionId ?? ""
          )
        );
        if (
          runTemplateVersionId &&
          instTemplateVersionId &&
          runTemplateVersionId !== instTemplateVersionId
        ) {
          throw new Error(
            "INVALID_RELATION: ImportRow.instanceId (version mismatch with ImportRun)"
          );
        }
      }
      const cloned = structuredClone(source) as Rec;
      cloned.id = targetId;
      cloned.importRunId = targetRunId;
      cloned.instanceId = targetInstanceId;
      cloned.createdAt = now;
      if ("updatedAt" in cloned) cloned.updatedAt = now;
      // ImportRow performs NO asset remap — there is no confirmed asset
      // reference location on an ImportRow, so any nested `*assetId` is left
      // byte-for-byte intact and never enters required / unresolved.
      merged.importRows.push(cloned);
      counts.importRowsImported += 1;
    }
    for (const source of assertArray(
      incoming.mappingDecisions,
      "incoming.mappingDecisions"
    )) {
      const sourceId = asNonEmptyString(source.id);
      const targetId = newId("map");
      mappingDecisionIdMap.set(sourceId, targetId);
      const srcRunId = asNonEmptyString(source.importRunId);
      const targetRunId = importRunIdMap.get(srcRunId);
      if (!targetRunId) {
        throw new Error("INVALID_RELATION: MappingDecision.importRunId");
      }
      const cloned = structuredClone(source) as Rec;
      cloned.id = targetId;
      cloned.importRunId = targetRunId;
      const vid = asNonEmptyString(source.templateVersionId);
      if (vid) cloned.templateVersionId = versionIdMap.get(vid) ?? vid;
      cloned.createdAt = now;
      if ("decidedAt" in cloned) cloned.decidedAt = now;
      merged.mappingDecisions.push(cloned);
      counts.mappingDecisionsImported += 1;
    }
    for (const source of assertArray(
      incoming.detectionRuns,
      "incoming.detectionRuns"
    )) {
      const sourceId = asNonEmptyString(source.id);
      const targetId = newId("detection");
      detectionRunIdMap.set(sourceId, targetId);
      const cloned = structuredClone(source) as Rec;
      cloned.id = targetId;
      cloned.templateVersionId = versionIdMap.get(
        asNonEmptyString(source.templateVersionId)
      )!;
      cloned.createdAt = now;
      merged.detectionRuns.push(cloned);
      counts.detectionRunsImported += 1;
    }
  } else {
    // Structure mode: current Instances are preserved untouched.
    counts.instancesPreserved = merged.instances.length;
  }

  // --- Phase I: workspace-level bookkeeping --------------------------------
  merged.updatedAt = new Date(now).toISOString();

  // Id maps for duplicate-only collections.
  if (mode === "duplicate") {
    instanceIdMap.forEach((v, k) => (idMaps.instances[k] = v));
    importRunIdMap.forEach((v, k) => (idMaps.importRuns[k] = v));
    importRowIdMap.forEach((v, k) => (idMaps.importRows[k] = v));
    mappingDecisionIdMap.forEach((v, k) => (idMaps.mappingDecisions[k] = v));
    detectionRunIdMap.forEach((v, k) => (idMaps.detectionRuns[k] = v));
  }
  folderIdMap.forEach((v, k) => (idMaps.folders[k] = v));
  tagIdMap.forEach((v, k) => (idMaps.tags[k] = v));
  fieldIdMap.forEach((v, k) => (idMaps.fields[k] = v));

  return {
    mergedWorkspace: merged,
    conflicts,
    idMaps,
    counts,
    requiredAssetIds: Array.from(required).sort(),
    unresolvedAssetIds: Array.from(unresolved).sort(),
  };
}
