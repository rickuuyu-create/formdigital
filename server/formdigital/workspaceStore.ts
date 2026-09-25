import { loadLocalWorkspace, saveLocalWorkspace } from "./localServiceClient";

export type LocalTemplate = {
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  lifecycle: "draft" | "published" | "archived";
  currentPublishedVersionId: string | null;
  currentDraftVersionId: string | null;
  schemaVersion: number;
  folderIds: string[];
  tagIds: string[];
  favorite: boolean;
  pinned: boolean;
  printProfile: Record<string, unknown>;
  instanceNamePattern: string;
  keyFieldIds: string[];
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
};

export type LocalTemplateVersion = {
  id: string;
  templateId: string;
  versionNumber: number;
  state: "draft" | "published" | "superseded";
  schemaVersion: number;
  contentHash: string;
  note: string | null;
  pageManifest: unknown;
  fieldSnapshot: unknown;
  printSettings: unknown;
  publishedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type LocalField = {
  id: string;
  templateVersionId: string;
  stableFieldId: string;
  fieldType: string;
  displayOrder: number;
  definition: unknown;
  coordinate: unknown;
  createdAt: number;
};

export type LocalInstance = {
  id: string;
  ownerId: string;
  templateId: string;
  templateVersionId: string;
  templateVersionHash: string;
  schemaVersion: number;
  name: string;
  status: "draft" | "completed" | "printed";
  values: Record<string, string>;
  valuesHash: string;
  printCount: number;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  lastPrintedAt: number | null;
  outputHistory: Array<Record<string, unknown>>;
};

export type LocalWorkspace = {
  schemaVersion: number;
  ownerKey: string;
  createdAt: string;
  updatedAt: string;
  templates: LocalTemplate[];
  templateVersions: LocalTemplateVersion[];
  fields: LocalField[];
  instances: LocalInstance[];
  folders: Array<Record<string, unknown>>;
  tags: Array<Record<string, unknown>>;
  savedValues: Array<Record<string, unknown>>;
  mappingTemplates: Array<Record<string, unknown>>;
  importRuns: Array<Record<string, unknown>>;
  importRows: Array<Record<string, unknown>>;
  mappingDecisions: Array<Record<string, unknown>>;
  detectionRuns: Array<Record<string, unknown>>;
  operationJournal: Array<Record<string, unknown>>;
  preferences: Record<string, unknown>;
};

export const CURRENT_WORKSPACE_SCHEMA_VERSION = 2;

export function normalizeWorkspace(
  ownerKey: string,
  input: Partial<LocalWorkspace> | undefined
): LocalWorkspace {
  const sourceSchemaVersion = input?.schemaVersion;
  if (
    sourceSchemaVersion !== undefined &&
    (!Number.isSafeInteger(sourceSchemaVersion) ||
      sourceSchemaVersion < 1 ||
      sourceSchemaVersion > CURRENT_WORKSPACE_SCHEMA_VERSION)
  ) {
    const error = new Error("UNSUPPORTED_WORKSPACE_SCHEMA");
    Object.assign(error, { code: "UNSUPPORTED_WORKSPACE_SCHEMA" });
    throw error;
  }
  const timestamp = new Date().toISOString();
  return {
    schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
    ownerKey,
    createdAt: input?.createdAt ?? timestamp,
    updatedAt: input?.updatedAt ?? timestamp,
    templates: Array.isArray(input?.templates) ? input.templates.map((template) => ({
      ...template,
      folderIds: Array.isArray(template.folderIds) ? template.folderIds : [],
      tagIds: Array.isArray(template.tagIds) ? template.tagIds : [],
      favorite: Boolean(template.favorite),
      pinned: Boolean(template.pinned),
      printProfile: template.printProfile && typeof template.printProfile === "object" ? template.printProfile : {},
      instanceNamePattern: template.instanceNamePattern || "{Template名稱}_{日期}_{時間}",
      keyFieldIds: Array.isArray(template.keyFieldIds) ? template.keyFieldIds : [],
    })) : [],
    templateVersions: Array.isArray(input?.templateVersions) ? input.templateVersions : [],
    fields: Array.isArray(input?.fields) ? input.fields : [],
    instances: Array.isArray(input?.instances) ? input.instances : [],
    folders: Array.isArray(input?.folders) ? input.folders : [],
    tags: Array.isArray(input?.tags) ? input.tags : [],
    savedValues: Array.isArray(input?.savedValues) ? input.savedValues : [],
    mappingTemplates: Array.isArray(input?.mappingTemplates) ? input.mappingTemplates : [],
    importRuns: Array.isArray(input?.importRuns) ? input.importRuns : [],
    importRows: Array.isArray(input?.importRows) ? input.importRows : [],
    mappingDecisions: Array.isArray(input?.mappingDecisions) ? input.mappingDecisions : [],
    detectionRuns: Array.isArray(input?.detectionRuns) ? input.detectionRuns : [],
    operationJournal: Array.isArray(input?.operationJournal) ? input.operationJournal : [],
    preferences: input?.preferences && typeof input.preferences === "object" ? input.preferences : {},
  };
}

const writeTails = new Map<string, Promise<void>>();

export async function readWorkspace(ownerKey: string) {
  const envelope = await loadLocalWorkspace<Partial<LocalWorkspace>>(ownerKey);
  return { revision: envelope.revision, workspace: normalizeWorkspace(ownerKey, envelope.workspace) };
}

export async function mutateWorkspace<T>(ownerKey: string, operation: string, mutation: (workspace: LocalWorkspace) => Promise<T> | T): Promise<T> {
  const previous = writeTails.get(ownerKey) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  writeTails.set(ownerKey, tail);
  await previous;
  try {
    const { revision, workspace } = await readWorkspace(ownerKey);
    const result = await mutation(workspace);
    workspace.updatedAt = new Date().toISOString();
    workspace.operationJournal.push({ operation, at: workspace.updatedAt });
    // The journal is not trimmed here. Dropping the oldest entries destroyed
    // operation history that, for a Workspace which has never migrated, exists
    // nowhere else. The Local Data Service keeps the envelope bounded by
    // archiving the overflow into its append-only log first, so the history
    // survives and this layer never has to choose between the two.
    await saveLocalWorkspace(ownerKey, workspace, revision);
    return result;
  } finally {
    release();
    if (writeTails.get(ownerKey) === tail) writeTails.delete(ownerKey);
  }
}
