/**
 * Local-first CSV import. Source bytes live in the Local Data Folder and every
 * mapping decision, row fingerprint and outcome is committed to the account
 * workspace so a failed run can resume without creating duplicate Instances.
 */
import { Buffer } from "node:buffer";
import crypto from "node:crypto";
import { Readable, Transform } from "node:stream";
import { parse } from "csv-parse/sync";
import { parse as parseCsvStream } from "csv-parse";
import { createStableId, sha256, type JsonValue } from "./domain";
import { getOwnedAssetBytes, storeOwnedAsset } from "./assetStore";
import {
  LocalServiceRequestError,
  describeLocalWorkspaceV2,
  getLocalAssetMetadata,
  openLocalAssetStream,
  queryLocalWorkspaceV2,
  queryManyLocalWorkspaceV2,
  transactLocalWorkspaceV2,
  type LocalWorkspaceV2Collection,
  type LocalWorkspaceV2Transaction,
} from "./localServiceClient";
import {
  mutateWorkspace,
  readWorkspace,
  type LocalField,
  type LocalInstance,
  type LocalTemplate,
  type LocalTemplateVersion,
  type LocalWorkspace,
} from "./workspaceStore";
import { validateFieldValues } from "../../shared/fieldValidation";
import { normalizeInstanceValuesForStorage } from "../../shared/tableFormula";

export type Confidence = "high" | "medium" | "low";
export type MappingDecisionInput = {
  csvField: string;
  templateStableFieldId?: string | null;
  confidence: Confidence;
  decision: "accepted" | "ignored" | "unresolved";
};
export type DuplicateDecisionInput = {
  rowNumber: number;
  action: "skip" | "create" | "overwrite";
  instanceId?: string | null;
  mergedValues?: Record<string, string>;
};
export type RowCorrectionInput = {
  rowNumber: number;
  values: Record<string, string>;
};

type ImportRunRecord = {
  id: string;
  ownerId: string;
  templateVersionId: string;
  sourceAssetId: string;
  originalFilename: string;
  status: "running" | "failed" | "completed" | "archived";
  mode: "strict" | "tolerant";
  sourceHash: string;
  sourceSchemaFingerprint: string;
  decisionHash: string;
  decisionManifest: MappingDecisionInput[];
  rowCorrections?: RowCorrectionInput[];
  totalRows: number;
  successCount: number;
  warningCount: number;
  failedCount: number;
  createdAt: number;
  completedAt: number | null;
};

type ImportRowRecord = {
  id: string;
  importRunId: string;
  rowNumber: number;
  rowFingerprint: string;
  status: "created" | "duplicate" | "failed";
  sourceValues: Record<string, string>;
  mappedValues: Record<string, string>;
  instanceId: string | null;
  errors: string[];
  createdAt: number;
  updatedAt: number;
};

const ownerKey = (ownerId: string | number) => String(ownerId);
const now = () => Date.now();
export const CSV_PROCESS_CHUNK_SIZE = 250;
export const CSV_ANALYSIS_PAGE_SIZE = 100;

const yieldToRuntime = () =>
  new Promise<void>(resolve => setImmediate(resolve));

export function canResumeImportStatus(status: string) {
  return status === "failed" || status === "running";
}

export function prepareResumeReplay(input: {
  status: string;
  templateVersionId: string;
  mode: "strict" | "tolerant";
  decisionManifest: unknown;
  originalFilename: string;
  expectedContentHash: string;
  bytes: Uint8Array;
}) {
  if (!canResumeImportStatus(input.status))
    throw new Error("此 Import Run 已完成或已封存，不需要 Resume。");
  if (sha256(input.bytes) !== input.expectedContentHash)
    throw new Error("原始 CSV 資產完整性驗證失敗。");
  if (!Array.isArray(input.decisionManifest))
    throw new Error("Import Run 缺少可重播的 Mapping Decision manifest。");
  return {
    templateVersionId: input.templateVersionId,
    base64: Buffer.from(input.bytes).toString("base64"),
    originalFilename: input.originalFilename,
    decisions: input.decisionManifest as MappingDecisionInput[],
    mode: input.mode,
  };
}

export function classifyImportRow(input: {
  sourceHash: string;
  mappedValues: Record<string, string>;
  seenFingerprints: Set<string>;
  knownValueHashes: Set<string>;
}) {
  const rowFingerprint = sha256({
    sourceHash: input.sourceHash,
    mappedValues: input.mappedValues,
  } as unknown as JsonValue);
  const valuesHash = sha256(input.mappedValues);
  if (input.seenFingerprints.has(rowFingerprint))
    return {
      status: "duplicate" as const,
      rowFingerprint,
      valuesHash,
      reason: "duplicate-row-in-source",
    };
  input.seenFingerprints.add(rowFingerprint);
  if (input.knownValueHashes.has(valuesHash))
    return {
      status: "duplicate" as const,
      rowFingerprint,
      valuesHash,
      reason: "matching-instance-already-exists",
    };
  return {
    status: "create" as const,
    rowFingerprint,
    valuesHash,
    reason: null,
  };
}

export type ParsedCsv = {
  headers: string[];
  rows: Record<string, string>[];
  schemaFingerprint: string;
};

export function parseCsvForImport(bytes: Uint8Array): ParsedCsv {
  const text = Buffer.from(bytes).toString("utf8");
  const records = parse(text, {
    bom: true,
    skip_empty_lines: true,
    relax_quotes: false,
    trim: false,
  }) as unknown[][];
  const headers = (records[0] ?? []).map(value => String(value));
  if (headers.length === 0 || records.length < 2)
    throw new Error("CSV 必須包含標題列與至少一筆資料。");
  if (
    new Set(headers).size !== headers.length ||
    headers.some(header => !header.trim())
  )
    throw new Error("CSV 欄位名稱不得為空白或重複。");
  return {
    headers,
    rows: records
      .slice(1)
      .map(record =>
        Object.fromEntries(
          headers.map((header, index) => [header, String(record[index] ?? "")])
        )
      ),
    schemaFingerprint: sha256(headers),
  };
}

type ValidatedCsvRow = {
  index: number;
  rowNumber: number;
  record: string[];
  headers: string[];
};

export async function* readValidatedCsvRows(source: Readable) {
  const hash = crypto.createHash("sha256");
  const hashing = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  const parser = source.pipe(hashing).pipe(
    parseCsvStream({
      bom: true,
      skip_empty_lines: true,
      relax_quotes: false,
      trim: false,
    })
  );
  let headers: string[] | null = null;
  let index = 0;
  for await (const rawRecord of parser) {
    const record = (rawRecord as unknown[]).map(value => String(value));
    if (!headers) {
      headers = record;
      if (
        headers.length === 0 ||
        new Set(headers).size !== headers.length ||
        headers.some(header => !header.trim())
      )
        throw new Error("CSV 欄位名稱不得為空白或重複。");
      continue;
    }
    yield { index, rowNumber: index + 2, record, headers } satisfies ValidatedCsvRow;
    index += 1;
  }
  if (!headers || headers.length === 0)
    throw new Error("CSV 必須包含標題列與至少一筆資料。");
  hash.end();
  const sourceWithHash = source as Readable & { __csvSha256?: string };
  sourceWithHash.__csvSha256 = hash.digest("hex");
}

export function csvSourceHash(source: Readable) {
  const digest = (source as Readable & { __csvSha256?: string }).__csvSha256;
  if (!digest) throw new Error("原始 CSV 資產完整性驗證失敗。");
  return digest;
}

export async function inspectStoredCsv(
  ownerId: string | number,
  sourceAssetId: string
) {
  const owner = ownerKey(ownerId);
  const asset = await getLocalAssetMetadata(owner, sourceAssetId);
  if (asset.mimeType !== "text/csv")
    throw new Error("CSV 批量匯入只接受 text/csv 資產。");
  const source = await openLocalAssetStream(owner, sourceAssetId);
  let sample: Record<string, string> | null = null;
  let totalRows = 0;
  let headers: string[] = [];
  try {
    for await (const row of readValidatedCsvRows(source)) {
      if (!headers.length) headers = row.headers;
      totalRows += 1;
      if (!sample) {
        sample = Object.fromEntries(
          row.headers.map((header, columnIndex) => [
            header,
            String(row.record[columnIndex] ?? ""),
          ])
        );
      }
    }
  } finally {
    source.destroy();
  }
  return {
    headers,
    sample: sample ?? {},
    totalRows,
    schemaFingerprint: sha256(headers),
    sourceHash: csvSourceHash(source),
    originalFilename: asset.originalFilename,
  };
}

export function mapCsvRow(
  row: Record<string, string>,
  decisions: MappingDecisionInput[]
) {
  const mapped: Record<string, string> = {};
  for (const decision of decisions) {
    if (decision.decision === "accepted" && decision.templateStableFieldId)
      mapped[decision.templateStableFieldId] = row[decision.csvField] ?? "";
  }
  return mapped;
}

export function validateImportedValues(
  values: Record<string, string>,
  versionFields: LocalField[]
) {
  return validateFieldValues(values, versionFields, {
    requiredIsBlocking: false,
  });
}

function validateMapping(
  headers: string[],
  decisions: MappingDecisionInput[],
  versionFields: LocalField[]
) {
  const decisionsByHeader = new Map(
    decisions.map(decision => [decision.csvField, decision])
  );
  for (const header of headers) {
    const decision = decisionsByHeader.get(header);
    if (!decision || decision.decision === "unresolved")
      throw new Error(`CSV 欄位「${header}」尚未完成 Mapping 決定。`);
  }
  const validStableIds = new Set(
    versionFields.map(field => field.stableFieldId)
  );
  for (const decision of decisions) {
    if (!headers.includes(decision.csvField))
      throw new Error(`Mapping 包含不存在的 CSV 欄位：${decision.csvField}`);
    if (
      decision.decision === "accepted" &&
      (!decision.templateStableFieldId ||
        !validStableIds.has(decision.templateStableFieldId))
    ) {
      throw new Error(
        `Mapping 指向不存在的 Template Field：${decision.templateStableFieldId ?? "未指定"}`
      );
    }
  }
}

export async function previewCsv(ownerId: string | number, base64: string) {
  if (!ownerKey(ownerId)) throw new Error("未授權的 CSV 預覽。");
  const bytes = Buffer.from(base64, "base64");
  const parsed = parseCsvForImport(bytes);
  return {
    headers: parsed.headers,
    rows: parsed.rows.slice(0, 10),
    totalRows: parsed.rows.length,
    schemaFingerprint: parsed.schemaFingerprint,
    sourceHash: sha256(bytes),
  };
}

export async function previewStoredCsv(
  ownerId: string | number,
  sourceAssetId: string
) {
  const inspected = await inspectStoredCsv(ownerId, sourceAssetId);
  return {
    headers: inspected.headers,
    rows: [inspected.sample],
    totalRows: inspected.totalRows,
    schemaFingerprint: inspected.schemaFingerprint,
    sourceHash: inspected.sourceHash,
    originalFilename: inspected.originalFilename,
  };
}

function findRun(workspace: LocalWorkspace, importRunId: string) {
  return workspace.importRuns.find(
    value => (value as Partial<ImportRunRecord>).id === importRunId
  ) as ImportRunRecord | undefined;
}

export async function processRows(input: {
  workspace: LocalWorkspace;
  run: ImportRunRecord;
  parsed: ParsedCsv;
  templateId: string;
  templateVersionHash: string;
  versionFields: LocalField[];
  skipRowNumbers?: Set<number>;
  duplicateDecisions?: DuplicateDecisionInput[];
  rowCorrections?: RowCorrectionInput[];
}) {
  const {
    workspace,
    run,
    parsed,
    templateId,
    templateVersionHash,
    versionFields,
  } = input;
  const knownValueHashes = new Set(
    workspace.instances
      .filter(item => item.templateVersionId === run.templateVersionId)
      .map(item => item.valuesHash)
  );
  const seenFingerprints = new Set<string>();
  const prepared: Array<{
    row: Record<string, string>;
    rowNumber: number;
    mappedValues: Record<string, string>;
    rowClass: ReturnType<typeof classifyImportRow>;
    errors: string[];
    warnings: string[];
  }> = [];
  for (let index = 0; index < parsed.rows.length; index += 1) {
    const row = parsed.rows[index]!;
    const rowNumber = index + 2;
    const correction = input.rowCorrections?.find(
      item => item.rowNumber === rowNumber
    );
    const rawMapped = {
      ...mapCsvRow(row, run.decisionManifest),
      ...(correction?.values ?? {}),
    };
    let mappedValues: Record<string, string>;
    let structuralError: string | null = null;
    try {
      mappedValues = normalizeInstanceValuesForStorage(
        rawMapped,
        versionFields
      );
    } catch (err: any) {
      structuralError = err.message || "表格資料結構無效";
      mappedValues = rawMapped;
    }
    const rowClass = classifyImportRow({
      sourceHash: run.sourceHash,
      mappedValues,
      seenFingerprints,
      knownValueHashes,
    });
    const issues = validateImportedValues(mappedValues, versionFields);
    const errors = [
      ...(structuralError ? [structuralError] : []),
      ...issues
        .filter(issue => issue.blocking)
        .map(issue => issue.message),
    ];
    const warnings = issues
      .filter(issue => !issue.blocking)
      .map(issue => issue.message);
    if (rowClass.status === "create" && !errors.length)
      knownValueHashes.add(rowClass.valuesHash);
    prepared.push({ row, rowNumber, mappedValues, rowClass, errors, warnings });
    if ((index + 1) % CSV_PROCESS_CHUNK_SIZE === 0)
      await yieldToRuntime();
  }

  const pending = prepared.filter(
    item => !input.skipRowNumbers?.has(item.rowNumber)
  );
  if (run.mode === "strict" && pending.some(item => item.errors.length)) {
    const timestamp = now();
    const failedItems = pending.filter(value => value.errors.length);
    for (let index = 0; index < failedItems.length; index += 1) {
      const item = failedItems[index]!;
      workspace.importRows.push({
        id: createStableId("row"),
        importRunId: run.id,
        rowNumber: item.rowNumber,
        rowFingerprint: item.rowClass.rowFingerprint,
        status: "failed",
        sourceValues: item.row,
        mappedValues: item.mappedValues,
        instanceId: null,
        errors: item.errors,
        createdAt: timestamp,
        updatedAt: timestamp,
      } satisfies ImportRowRecord);
      if ((index + 1) % CSV_PROCESS_CHUNK_SIZE === 0)
        await yieldToRuntime();
    }
    run.status = "failed";
    run.failedCount = pending.filter(item => item.errors.length).length;
    run.completedAt = timestamp;
    return {
      created: 0,
      duplicate: 0,
      warnings: 0,
      failed: run.failedCount,
      strictFailure: true,
    };
  }

  let created = 0;
  let duplicate = 0;
  let warnings = 0;
  let failed = 0;
  for (let itemIndex = 0; itemIndex < pending.length; itemIndex += 1) {
    const item = pending[itemIndex]!;
    const timestamp = now();
    const duplicateDecision = input.duplicateDecisions?.find(
      decision => decision.rowNumber === item.rowNumber
    );
    if (
      duplicateDecision?.instanceId &&
      duplicateDecision.action === "overwrite"
    ) {
      const existing = workspace.instances.find(
        instance =>
          instance.id === duplicateDecision.instanceId &&
          instance.templateVersionId === run.templateVersionId
      );
      if (existing) {
        let overwriteError: string | null = null;
        let normalizedValues = existing.values;
        try {
          normalizedValues = normalizeInstanceValuesForStorage(
            duplicateDecision.mergedValues ?? item.mappedValues,
            versionFields
          );
        } catch (err: any) {
          overwriteError = err.message || "表格資料結構無效";
        }
        if (overwriteError) {
          failed += 1;
          workspace.importRows.push({
            id: createStableId("row"),
            importRunId: run.id,
            rowNumber: item.rowNumber,
            rowFingerprint: item.rowClass.rowFingerprint,
            status: "failed",
            sourceValues: item.row,
            mappedValues: item.mappedValues,
            instanceId: null,
            errors: [overwriteError],
            createdAt: timestamp,
            updatedAt: timestamp,
          } satisfies ImportRowRecord);
          if ((itemIndex + 1) % CSV_PROCESS_CHUNK_SIZE === 0)
            await yieldToRuntime();
          continue;
        }
        existing.values = normalizedValues;
        existing.valuesHash = sha256(existing.values);
        existing.updatedAt = timestamp;
        duplicate += 1;
        workspace.importRows.push({
          id: createStableId("row"),
          importRunId: run.id,
          rowNumber: item.rowNumber,
          rowFingerprint: item.rowClass.rowFingerprint,
          status: "duplicate",
          sourceValues: item.row,
          mappedValues: existing.values,
          instanceId: existing.id,
          errors: ["matching-key-instance-overwritten"],
          createdAt: timestamp,
          updatedAt: timestamp,
        } satisfies ImportRowRecord);
        if ((itemIndex + 1) % CSV_PROCESS_CHUNK_SIZE === 0)
          await yieldToRuntime();
        continue;
      }
    }
    if (duplicateDecision?.instanceId && duplicateDecision.action === "skip") {
      duplicate += 1;
      workspace.importRows.push({
        id: createStableId("row"),
        importRunId: run.id,
        rowNumber: item.rowNumber,
        rowFingerprint: item.rowClass.rowFingerprint,
        status: "duplicate",
        sourceValues: item.row,
        mappedValues: item.mappedValues,
        instanceId: duplicateDecision.instanceId,
        errors: ["matching-key-instance-skipped"],
        createdAt: timestamp,
        updatedAt: timestamp,
      } satisfies ImportRowRecord);
      if ((itemIndex + 1) % CSV_PROCESS_CHUNK_SIZE === 0)
        await yieldToRuntime();
      continue;
    }
    if (item.errors.length) {
      failed += 1;
      workspace.importRows.push({
        id: createStableId("row"),
        importRunId: run.id,
        rowNumber: item.rowNumber,
        rowFingerprint: item.rowClass.rowFingerprint,
        status: "failed",
        sourceValues: item.row,
        mappedValues: item.mappedValues,
        instanceId: null,
        errors: item.errors,
        createdAt: timestamp,
        updatedAt: timestamp,
      } satisfies ImportRowRecord);
      if ((itemIndex + 1) % CSV_PROCESS_CHUNK_SIZE === 0)
        await yieldToRuntime();
      continue;
    }
    if (
      item.rowClass.status === "duplicate" &&
      duplicateDecision?.action === "overwrite"
    ) {
      const existing = workspace.instances.find(
        instance =>
          instance.templateVersionId === run.templateVersionId &&
          instance.valuesHash === item.rowClass.valuesHash
      );
      if (existing) {
        let overwriteError: string | null = null;
        let normalizedValues = existing.values;
        try {
          normalizedValues = normalizeInstanceValuesForStorage(
            duplicateDecision.mergedValues ?? item.mappedValues,
            versionFields
          );
        } catch (err: any) {
          overwriteError = err.message || "表格資料結構無效";
        }
        if (overwriteError) {
          failed += 1;
          workspace.importRows.push({
            id: createStableId("row"),
            importRunId: run.id,
            rowNumber: item.rowNumber,
            rowFingerprint: item.rowClass.rowFingerprint,
            status: "failed",
            sourceValues: item.row,
            mappedValues: item.mappedValues,
            instanceId: null,
            errors: [overwriteError],
            createdAt: timestamp,
            updatedAt: timestamp,
          } satisfies ImportRowRecord);
          if ((itemIndex + 1) % CSV_PROCESS_CHUNK_SIZE === 0)
            await yieldToRuntime();
          continue;
        }
        existing.values = normalizedValues;
        existing.valuesHash = sha256(existing.values);
        existing.updatedAt = timestamp;
        duplicate += 1;
        workspace.importRows.push({
          id: createStableId("row"),
          importRunId: run.id,
          rowNumber: item.rowNumber,
          rowFingerprint: item.rowClass.rowFingerprint,
          status: "duplicate",
          sourceValues: item.row,
          mappedValues: existing.values,
          instanceId: existing.id,
          errors: ["matching-instance-overwritten"],
          createdAt: timestamp,
          updatedAt: timestamp,
        } satisfies ImportRowRecord);
        if ((itemIndex + 1) % CSV_PROCESS_CHUNK_SIZE === 0)
          await yieldToRuntime();
        continue;
      }
    }
    if (
      item.rowClass.status === "duplicate" &&
      duplicateDecision?.action !== "create"
    ) {
      duplicate += 1;
      workspace.importRows.push({
        id: createStableId("row"),
        importRunId: run.id,
        rowNumber: item.rowNumber,
        rowFingerprint: item.rowClass.rowFingerprint,
        status: "duplicate",
        sourceValues: item.row,
        mappedValues: item.mappedValues,
        instanceId: null,
        errors: [item.rowClass.reason],
        createdAt: timestamp,
        updatedAt: timestamp,
      } satisfies ImportRowRecord);
      if ((itemIndex + 1) % CSV_PROCESS_CHUNK_SIZE === 0)
        await yieldToRuntime();
      continue;
    }
    const instanceId = createStableId("ins");
    const instanceName =
      Object.values(item.mappedValues).find(Boolean) ||
      `Imported Row ${item.rowNumber}`;
    workspace.instances.push({
      id: instanceId,
      ownerId: run.ownerId,
      templateId,
      templateVersionId: run.templateVersionId,
      templateVersionHash,
      schemaVersion: 2,
      name: instanceName.slice(0, 255),
      status: "draft",
      values: item.mappedValues,
      valuesHash: item.rowClass.valuesHash,
      printCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
      lastPrintedAt: null,
      outputHistory: [],
    });
    workspace.importRows.push({
      id: createStableId("row"),
      importRunId: run.id,
      rowNumber: item.rowNumber,
      rowFingerprint: item.rowClass.rowFingerprint,
      status: "created",
      sourceValues: item.row,
      mappedValues: item.mappedValues,
      instanceId,
      errors: item.warnings,
      createdAt: timestamp,
      updatedAt: timestamp,
    } satisfies ImportRowRecord);
    created += 1;
    if (item.warnings.length) warnings += 1;
    if ((itemIndex + 1) % CSV_PROCESS_CHUNK_SIZE === 0)
      await yieldToRuntime();
  }
  run.successCount += created;
  run.warningCount += duplicate + warnings;
  run.failedCount += failed;
  run.status = failed ? "failed" : "completed";
  run.completedAt = now();
  return { created, duplicate, warnings, failed, strictFailure: false };
}

export async function createImportRun(
  ownerId: string | number,
  input: {
    templateVersionId: string;
    base64: string;
    originalFilename?: string;
    decisions: MappingDecisionInput[];
    mode: "strict" | "tolerant";
    duplicateDecisions?: DuplicateDecisionInput[];
    rowCorrections?: RowCorrectionInput[];
  }
) {
  const owner = ownerKey(ownerId);
  const bytes = Buffer.from(input.base64, "base64");
  const parsed = parseCsvForImport(bytes);
  const sourceHash = sha256(bytes);
  const decisionHash = sha256({
    mappings: input.decisions,
    duplicates: input.duplicateDecisions ?? [],
    corrections: input.rowCorrections ?? [],
  } as unknown as JsonValue);
  const snapshot = await readWorkspace(owner);
  const version = snapshot.workspace.templateVersions.find(
    item => item.id === input.templateVersionId
  );
  const template =
    version &&
    snapshot.workspace.templates.find(item => item.id === version.templateId);
  if (!version || !template) throw new Error("找不到指定 Template Version。");
  if (version.state !== "published" && version.state !== "superseded")
    throw new Error("CSV 批量建立只允許使用已發佈的 Template Version。");
  const versionFields = snapshot.workspace.fields.filter(
    field => field.templateVersionId === version.id
  );
  validateMapping(parsed.headers, input.decisions, versionFields);
  const existing = snapshot.workspace.importRuns.find(value => {
    const run = value as Partial<ImportRunRecord>;
    return (
      run.templateVersionId === version.id &&
      run.sourceHash === sourceHash &&
      run.decisionHash === decisionHash &&
      run.status === "completed"
    );
  }) as ImportRunRecord | undefined;
  if (existing)
    return {
      importRunId: existing.id,
      reused: true,
      totalRows: existing.totalRows,
      created: existing.successCount,
      duplicate: existing.warningCount,
      failed: existing.failedCount,
    };

  const sourceAsset = await storeOwnedAsset(owner, {
    bytes,
    kind: "source",
    mimeType: "text/csv",
    originalFilename: input.originalFilename ?? "import.csv",
    templateId: template.id,
    templateVersionId: version.id,
    metadata: {
      schemaFingerprint: parsed.schemaFingerprint,
      sourceHash,
      decisionHash,
    },
  });
  const importRunId = createStableId("run");
  const outcome = await mutateWorkspace(
    owner,
    "csv.import.create",
    workspace => {
      const currentVersion = workspace.templateVersions.find(
        item => item.id === version.id
      );
      const currentTemplate = workspace.templates.find(
        item => item.id === template.id
      );
      if (
        !currentVersion ||
        !currentTemplate ||
        currentVersion.contentHash !== version.contentHash
      )
        throw new Error("Template Version 在匯入期間已改變，請重新預覽 CSV。");
      const fields = workspace.fields.filter(
        field => field.templateVersionId === currentVersion.id
      );
      const createdAt = now();
      const run: ImportRunRecord = {
        id: importRunId,
        ownerId: owner,
        templateVersionId: currentVersion.id,
        sourceAssetId: sourceAsset.asset.id,
        originalFilename: input.originalFilename ?? "import.csv",
        status: "running",
        mode: input.mode,
        sourceHash,
        sourceSchemaFingerprint: parsed.schemaFingerprint,
        decisionHash,
        decisionManifest: input.decisions,
        rowCorrections: input.rowCorrections,
        totalRows: parsed.rows.length,
        successCount: 0,
        warningCount: 0,
        failedCount: 0,
        createdAt,
        completedAt: null,
      };
      workspace.importRuns.push(run);
      workspace.mappingDecisions.push(
        ...input.decisions.map(decision => ({
          id: createStableId("map"),
          importRunId,
          ...decision,
          templateStableFieldId: decision.templateStableFieldId ?? null,
          decidedAt: createdAt,
          createdAt,
        }))
      );
      return processRows({
        workspace,
        run,
        parsed,
        templateId: currentTemplate.id,
        templateVersionHash: currentVersion.contentHash,
        versionFields: fields,
        duplicateDecisions: input.duplicateDecisions,
        rowCorrections: input.rowCorrections,
      });
    }
  );
  if (outcome.strictFailure)
    throw new Error(
      `Strict 匯入已取消：${outcome.failed} 筆資料未通過欄位驗證，未建立任何 Instance。`
    );
  return {
    importRunId,
    reused: false,
    totalRows: parsed.rows.length,
    created: outcome.created,
    duplicate: outcome.duplicate,
    warnings: outcome.warnings,
    failed: outcome.failed,
  };
}

export async function analyzeCsvImport(
  ownerId: string | number,
  input: {
    templateVersionId: string;
    base64: string;
    decisions: MappingDecisionInput[];
    rowCorrections?: RowCorrectionInput[];
  }
) {
  const owner = ownerKey(ownerId);
  const parsed = parseCsvForImport(Buffer.from(input.base64, "base64"));
  const { workspace } = await readWorkspace(owner);
  const version = workspace.templateVersions.find(
    item => item.id === input.templateVersionId
  );
  const template =
    version && workspace.templates.find(item => item.id === version.templateId);
  if (
    !version ||
    !template ||
    (version.state !== "published" && version.state !== "superseded")
  )
    throw new Error("請選擇已發佈的 Template Version。");
  const versionFields = workspace.fields.filter(
    field => field.templateVersionId === version.id
  );
  validateMapping(parsed.headers, input.decisions, versionFields);
  const versionInstances = workspace.instances.filter(
    instance => instance.templateVersionId === version.id
  );
  const instancesByHash = new Map(
    versionInstances.map(instance => [instance.valuesHash, instance])
  );
  const requiredFieldIds = versionFields
    .filter(
      field =>
        field.definition &&
        typeof field.definition === "object" &&
        !Array.isArray(field.definition) &&
        (field.definition as Record<string, unknown>).required === true
    )
    .map(field => field.stableFieldId);
  const keyFieldIds = template.keyFieldIds.length
    ? template.keyFieldIds
    : requiredFieldIds.slice(0, 2).length
      ? requiredFieldIds.slice(0, 2)
      : versionFields.slice(0, 1).map(field => field.stableFieldId);
  const keyOf = (values: Record<string, string>) =>
    keyFieldIds
      .map(fieldId => values[fieldId]?.trim().toLocaleLowerCase() ?? "")
      .join("\u001f");
  const instancesByKey = new Map(
    versionInstances
      .filter(instance => keyOf(instance.values).replace(/\u001f/g, ""))
      .map(instance => [keyOf(instance.values), instance])
  );
  const seen = new Set<string>();
  const sourceHash = sha256(Buffer.from(input.base64, "base64"));
  const rows = parsed.rows.slice(0, 2_000).map((row, index) => {
    const rowNumber = index + 2;
    const correction = input.rowCorrections?.find(
      item => item.rowNumber === rowNumber
    );
    const mappedValues = normalizeInstanceValuesForStorage(
      {
        ...mapCsvRow(row, input.decisions),
        ...(correction?.values ?? {}),
      },
      versionFields
    );
    const classification = classifyImportRow({
      sourceHash,
      mappedValues,
      seenFingerprints: seen,
      knownValueHashes: new Set(instancesByHash.keys()),
    });
    const issues = validateImportedValues(mappedValues, versionFields);
    const existing =
      instancesByHash.get(classification.valuesHash) ??
      instancesByKey.get(keyOf(mappedValues));
    return {
      rowNumber,
      sourceValues: row,
      mappedValues,
      issues,
      duplicate: existing
        ? {
            instanceId: existing.id,
            name: existing.name,
            values: existing.values,
            keyFieldIds,
            differences: Object.keys(mappedValues)
              .filter(key => existing.values[key] !== mappedValues[key])
              .map(key => ({
                fieldId: key,
                oldValue: existing.values[key] ?? "",
                newValue: mappedValues[key] ?? "",
              })),
          }
        : classification.reason === "duplicate-row-in-source"
          ? {
              instanceId: null,
              name: "同一 CSV 內重複",
              values: mappedValues,
              keyFieldIds,
              differences: [],
            }
          : null,
    };
  });
  return {
    totalRows: parsed.rows.length,
    analyzedRows: rows.length,
    rows,
    duplicateCount: rows.filter(row => row.duplicate).length,
    warningCount: rows.filter(row => row.issues.length).length,
  };
}

export async function analyzeStoredCsvImport(
  ownerId: string | number,
  input: {
    templateVersionId: string;
    sourceAssetId: string;
    sourceHash: string;
    decisions: MappingDecisionInput[];
    rowCorrections?: RowCorrectionInput[];
    previewPage?: number;
  }
) {
  const owner = ownerKey(ownerId);
  const previewPage = Math.max(0, Math.floor(input.previewPage ?? 0));
  const inspected = await inspectStoredCsv(owner, input.sourceAssetId);
  if (inspected.sourceHash !== input.sourceHash)
    throw new Error("原始 CSV 資產完整性驗證失敗。");
  const headers = inspected.headers;
  const { version, template, fields: versionFields } =
    await loadV2TemplateContext(owner, input.templateVersionId);
  if (
    (version.state !== "published" && version.state !== "superseded")
  )
    throw new Error("請選擇已發佈的 Template Version。");
  validateMapping(headers, input.decisions, versionFields);
  const requiredFieldIds = versionFields
    .filter(field => (field.definition as Record<string, unknown>)?.required === true)
    .map(field => field.stableFieldId);
  const keyFieldIds = template.keyFieldIds.length
    ? template.keyFieldIds
    : requiredFieldIds.slice(0, 2).length
      ? requiredFieldIds.slice(0, 2)
      : versionFields.slice(0, 1).map(field => field.stableFieldId);
  const seen = new Set<string>();
  const pageStart = previewPage * CSV_ANALYSIS_PAGE_SIZE;
  const pageEnd = pageStart + CSV_ANALYSIS_PAGE_SIZE - 1;
  let duplicateCount = 0;
  let warningCount = 0;
  const rows = [] as unknown[];
  let pending: Array<{
    csvRow: { index: number; rowNumber: number; record: string[] };
    finalValues: Record<string, string>;
    classification: ReturnType<typeof classifyImportRow>;
    issues: ReturnType<typeof validateImportedValues>;
  }> = [];
  const flushPending = async () => {
    if (!pending.length) return;
    const hashes = Array.from(
      new Set(pending.map(item => item.classification.valuesHash)),
    );
    const existing = hashes.length
      ? await queryManyLocalWorkspaceV2<LocalInstance>(owner, {
          collection: "instances",
          key: "valuesHash",
          values: hashes,
          where: { templateVersionId: version.id },
        })
      : { records: [] as LocalInstance[] };
    const instancesByHash = new Map(
      existing.records.map(instance => [instance.valuesHash, instance]),
    );
    for (const item of pending) {
      const { csvRow, finalValues, classification, issues } = item;
      if (issues.length) warningCount += 1;
      const knownDuplicate = instancesByHash.get(classification.valuesHash);
      const duplicate = knownDuplicate
        ? {
            instanceId: knownDuplicate.id,
            name: knownDuplicate.name,
            values: knownDuplicate.values,
            keyFieldIds,
            differences: Object.keys(finalValues)
              .filter(key => knownDuplicate.values[key] !== finalValues[key])
              .map(key => ({
                fieldId: key,
                oldValue: knownDuplicate.values[key] ?? "",
                newValue: finalValues[key] ?? "",
              })),
          }
        : classification.reason === "duplicate-row-in-source"
          ? {
              instanceId: null,
              name: "同一 CSV 內重複",
              values: finalValues,
              keyFieldIds,
              differences: [],
            }
          : null;
      if (duplicate) duplicateCount += 1;
      if (csvRow.index >= pageStart && csvRow.index <= pageEnd) {
        rows.push({
          rowNumber: csvRow.rowNumber,
          sourceValues: Object.fromEntries(
            headers.map((header, index) => [
              header,
              String(csvRow.record[index] ?? ""),
            ]),
          ),
          mappedValues: finalValues,
          issues,
          duplicate,
        });
      }
    }
    pending = [];
  };
  let source: Readable | null = null;
  try {
    source = await openLocalAssetStream(owner, input.sourceAssetId);
    for await (const csvRow of readValidatedCsvRows(source)) {
      const mappedValues = Object.fromEntries(
        input.decisions
          .filter(item => item.decision === "accepted" && item.templateStableFieldId)
          .map(item => [
            item.templateStableFieldId!,
            String(csvRow.record[headers.indexOf(item.csvField)] ?? ""),
          ])
      );
      const correction = input.rowCorrections?.find(
        item => item.rowNumber === csvRow.rowNumber
      );
      const finalValues = normalizeInstanceValuesForStorage(
        { ...mappedValues, ...(correction?.values ?? {}) },
        versionFields
      );
      const classification = classifyImportRow({
        sourceHash: inspected.sourceHash,
        mappedValues: finalValues,
        seenFingerprints: seen,
        knownValueHashes: new Set(),
      });
      const issues = validateImportedValues(finalValues, versionFields);
      pending.push({ csvRow, finalValues, classification, issues });
      if (pending.length === 500) await flushPending();
    }
    await flushPending();
  } finally {
    source?.destroy();
  }
  return {
    totalRows: inspected.totalRows,
    returnedRows: rows.length,
    previewPage,
    pageSize: CSV_ANALYSIS_PAGE_SIZE,
    rows,
    duplicateCount,
    warningCount,
  };
}

export async function resumeImportRun(
  ownerId: string | number,
  importRunId: string
) {
  const owner = ownerKey(ownerId);
  const snapshot = await readWorkspace(owner);
  const savedRun = findRun(snapshot.workspace, importRunId);
  if (!savedRun) throw new Error("找不到指定 Import Run，或您沒有存取權限。");
  if (!canResumeImportStatus(savedRun.status))
    throw new Error("此 Import Run 已完成或已封存，不需要 Resume。");
  if (!savedRun.sourceAssetId)
    throw new Error("此 Import Run 缺少可重播的原始 CSV 資產。");
  const source = await getOwnedAssetBytes(owner, savedRun.sourceAssetId);
  const replay = prepareResumeReplay({
    status: savedRun.status,
    templateVersionId: savedRun.templateVersionId,
    mode: savedRun.mode,
    decisionManifest: savedRun.decisionManifest,
    originalFilename:
      savedRun.originalFilename ||
      source.asset.originalFilename ||
      "import.csv",
    expectedContentHash: savedRun.sourceHash,
    bytes: source.bytes,
  });
  const parsed = parseCsvForImport(Buffer.from(replay.base64, "base64"));
  const result = await mutateWorkspace(
    owner,
    "csv.import.resume",
    workspace => {
      const run = findRun(workspace, importRunId);
      if (!run || !canResumeImportStatus(run.status))
        throw new Error("此 Import Run 已完成或已封存，不需要 Resume。");
      const version = workspace.templateVersions.find(
        item => item.id === run.templateVersionId
      );
      const template =
        version &&
        workspace.templates.find(item => item.id === version.templateId);
      if (!version || !template)
        throw new Error("Import Run 綁定的 Template Version 不存在。");
      const versionFields = workspace.fields.filter(
        field => field.templateVersionId === version.id
      );
      validateMapping(parsed.headers, run.decisionManifest, versionFields);
      const previousRows = workspace.importRows.filter(
        value => (value as Partial<ImportRowRecord>).importRunId === run.id
      ) as ImportRowRecord[];
      const completedRows = new Set(
        previousRows
          .filter(row => row.status === "created" || row.status === "duplicate")
          .map(row => row.rowNumber)
      );
      workspace.importRows = workspace.importRows.filter(value => {
        const row = value as Partial<ImportRowRecord>;
        return row.importRunId !== run.id || row.status !== "failed";
      });
      run.status = "running";
      run.failedCount = 0;
      return processRows({
        workspace,
        run,
        parsed,
        templateId: template.id,
        templateVersionHash: version.contentHash,
        versionFields,
        skipRowNumbers: completedRows,
        rowCorrections: run.rowCorrections,
      });
    }
  );
  if (result.strictFailure)
    throw new Error(`Strict 匯入仍有 ${result.failed} 筆資料未通過欄位驗證。`);
  return {
    importRunId,
    reused: false,
    totalRows: savedRun.totalRows,
    created: result.created,
    duplicate: result.duplicate,
    warnings: result.warnings,
    failed: result.failed,
  };
}

function csvRowToObject(headers: string[], record: string[]) {
  return Object.fromEntries(
    headers.map((header, index) => [header, String(record[index] ?? "")])
  );
}

async function createStoredImportRunLegacy(
  ownerId: string | number,
  input: {
    templateVersionId: string;
    sourceAssetId: string;
    sourceHash: string;
    originalFilename?: string;
    decisions: MappingDecisionInput[];
    mode: "strict" | "tolerant";
    duplicateDecisions?: DuplicateDecisionInput[];
    rowCorrections?: RowCorrectionInput[];
  }
) {
  const owner = ownerKey(ownerId);
  const inspected = await inspectStoredCsv(owner, input.sourceAssetId);
  if (inspected.sourceHash !== input.sourceHash)
    throw new Error("原始 CSV 資產完整性驗證失敗。");
  const decisionHash = sha256({
    mappings: input.decisions,
    duplicates: input.duplicateDecisions ?? [],
    corrections: input.rowCorrections ?? [],
  } as unknown as JsonValue);

  const preliminary = await readWorkspace(owner);
  const preliminaryVersion = preliminary.workspace.templateVersions.find(
    item => item.id === input.templateVersionId
  );
  const preliminaryTemplate =
    preliminaryVersion &&
    preliminary.workspace.templates.find(
      item => item.id === preliminaryVersion.templateId
    );
  if (!preliminaryVersion || !preliminaryTemplate)
    throw new Error("找不到指定 Template Version。");
  if (
    preliminaryVersion.state !== "published" &&
    preliminaryVersion.state !== "superseded"
  )
    throw new Error("CSV 批量建立只允許使用已發佈的 Template Version。");
  const preliminaryFields = preliminary.workspace.fields.filter(
    field => field.templateVersionId === preliminaryVersion.id
  );
  validateMapping(inspected.headers, input.decisions, preliminaryFields);
  const existing = preliminary.workspace.importRuns.find(value => {
    const run = value as Partial<ImportRunRecord>;
    return (
      run.templateVersionId === preliminaryVersion.id &&
      run.sourceHash === inspected.sourceHash &&
      run.decisionHash === decisionHash &&
      run.status === "completed"
    );
  }) as ImportRunRecord | undefined;
  if (existing)
    return {
      importRunId: existing.id,
      reused: true,
      totalRows: existing.totalRows,
      created: existing.successCount,
      duplicate: existing.warningCount,
      failed: existing.failedCount,
    };

  if (input.mode === "strict") {
    let strictFailures = 0;
    let sawHeaders = false;
    const source = await openLocalAssetStream(owner, input.sourceAssetId);
    try {
      for await (const row of readValidatedCsvRows(source)) {
        if (!sawHeaders) {
          validateMapping(row.headers, input.decisions, preliminaryFields);
          sawHeaders = true;
        }
        const mapped = {
          ...mapCsvRow(csvRowToObject(row.headers, row.record), input.decisions),
        };
        const correction = input.rowCorrections?.find(
          item => item.rowNumber === row.rowNumber
        );
        const issues = validateImportedValues(
          { ...mapped, ...(correction?.values ?? {}) },
          preliminaryFields
        );
        if (issues.some(issue => issue.blocking)) strictFailures += 1;
      }
    } finally {
      source.destroy();
    }
    if (strictFailures)
      throw new Error(
        `Strict 匯入已取消：${strictFailures} 筆資料未通過欄位驗證，未建立任何 Instance。`
      );
  }

  const importRunId = createStableId("run");
  await mutateWorkspace(owner, "csv.import.create", workspace => {
    const currentVersion = workspace.templateVersions.find(
      item => item.id === preliminaryVersion.id
    );
    const currentTemplate = workspace.templates.find(
      item => item.id === preliminaryTemplate.id
    );
    if (
      !currentVersion ||
      !currentTemplate ||
      currentVersion.contentHash !== preliminaryVersion.contentHash
    )
      throw new Error("Template Version 在匯入期間已改變，請重新預覽 CSV。");
    const createdAt = now();
    const run: ImportRunRecord = {
      id: importRunId,
      ownerId: owner,
      templateVersionId: currentVersion.id,
      sourceAssetId: input.sourceAssetId,
      originalFilename: input.originalFilename || inspected.originalFilename,
      status: "running",
      mode: input.mode,
      sourceHash: inspected.sourceHash,
      sourceSchemaFingerprint: inspected.schemaFingerprint,
      decisionHash,
      decisionManifest: input.decisions,
      rowCorrections: input.rowCorrections,
      totalRows: inspected.totalRows,
      successCount: 0,
      warningCount: 0,
      failedCount: 0,
      createdAt,
      completedAt: null,
    };
    workspace.importRuns.push(run);
    workspace.mappingDecisions.push(
      ...input.decisions.map(decision => ({
        id: createStableId("map"),
        importRunId,
        ...decision,
        templateStableFieldId: decision.templateStableFieldId ?? null,
        decidedAt: createdAt,
        createdAt,
      }))
    );
    return { created: 0, duplicate: 0, warnings: 0, failed: 0 };
  });

  let totals = { created: 0, duplicate: 0, warnings: 0, failed: 0 };
  let pending: Array<Record<string, string>> = [];
  let source: Readable | null = null;
  try {
    source = await openLocalAssetStream(owner, input.sourceAssetId);
    let headers: string[] = [];
    const flush = async () => {
      if (!pending.length) return;
      const parsedChunk = {
        headers,
        rows: pending,
        schemaFingerprint: inspected.schemaFingerprint,
      };
      const outcome = await mutateWorkspace(
        owner,
        "csv.import.chunk",
        workspace => {
          const run = findRun(workspace, importRunId);
          if (!run) throw new Error("找不到指定 Import Run。");
          const version = workspace.templateVersions.find(
            item => item.id === run.templateVersionId
          );
          const template =
            version &&
            workspace.templates.find(item => item.id === version.templateId);
          if (!version || !template)
            throw new Error("Import Run 綁定的 Template Version 不存在。");
          const fields = workspace.fields.filter(
            field => field.templateVersionId === version.id
          );
          validateMapping(parsedChunk.headers, run.decisionManifest, fields);
          run.status = "running";
          run.completedAt = null;
          return processRows({
            workspace,
            run,
            parsed: parsedChunk,
            templateId: template.id,
            templateVersionHash: version.contentHash,
            versionFields: fields,
            duplicateDecisions: input.duplicateDecisions,
            rowCorrections: input.rowCorrections,
          });
        }
      );
      totals.created += outcome.created;
      totals.duplicate += outcome.duplicate;
      totals.warnings += outcome.warnings;
      totals.failed += outcome.failed;
      pending = [];
    };
    for await (const row of readValidatedCsvRows(source)) {
      if (!headers.length) headers = row.headers;
      pending.push(csvRowToObject(row.headers, row.record));
      if (pending.length >= CSV_PROCESS_CHUNK_SIZE) await flush();
    }
    await flush();
  } catch (error) {
    await mutateWorkspace(owner, "csv.import.fail", workspace => {
      const run = findRun(workspace, importRunId);
      if (run && run.status === "running") {
        run.status = "failed";
        run.completedAt = now();
      }
    });
    throw error;
  } finally {
    source?.destroy();
  }

  await mutateWorkspace(owner, "csv.import.complete", workspace => {
    const run = findRun(workspace, importRunId);
    if (run && run.status === "running") {
      run.status = "completed";
      run.completedAt = now();
    }
  });

  return {
    importRunId,
    reused: false,
    totalRows: inspected.totalRows,
    ...totals,
  };
}

async function resumeStoredImportRunLegacy(
  ownerId: string | number,
  importRunId: string
) {
  const owner = ownerKey(ownerId);
  const snapshot = await readWorkspace(owner);
  const savedRun = findRun(snapshot.workspace, importRunId);
  if (!savedRun) throw new Error("找不到指定 Import Run，或您沒有存取權限。");
  if (!canResumeImportStatus(savedRun.status))
    throw new Error("此 Import Run 已完成或已封存，不需要 Resume。");
  if (!savedRun.sourceAssetId)
    throw new Error("此 Import Run 缺少可重播的原始 CSV 資產。");
  const inspected = await inspectStoredCsv(owner, savedRun.sourceAssetId);
  if (inspected.sourceHash !== savedRun.sourceHash)
    throw new Error("原始 CSV 資產完整性驗證失敗。");
  const previousRows = snapshot.workspace.importRows.filter(
    value => (value as Partial<ImportRowRecord>).importRunId === importRunId
  ) as ImportRowRecord[];
  const completedRows = new Set(
    previousRows
      .filter(row => row.status === "created" || row.status === "duplicate")
      .map(row => row.rowNumber)
  );
  const result = await mutateWorkspace(
    owner,
    "csv.import.resume",
    workspace => {
      const run = findRun(workspace, importRunId);
      if (!run || !canResumeImportStatus(run.status))
        throw new Error("此 Import Run 已完成或已封存，不需要 Resume。");
      workspace.importRows = workspace.importRows.filter(value => {
        const row = value as Partial<ImportRowRecord>;
        return row.importRunId !== run.id || row.status !== "failed";
      });
      run.status = "running";
      run.completedAt = null;
      run.failedCount = 0;
      return { created: 0, duplicate: 0, warnings: 0, failed: 0 };
    }
  );
  void result;
  let totals = { created: 0, duplicate: 0, warnings: 0, failed: 0 };
  let pending: Array<Record<string, string>> = [];
  let headers: string[] = [];
  let source: Readable | null = null;
  const flush = async () => {
    if (!pending.length) return;
    const parsedChunk = { headers, rows: pending, schemaFingerprint: inspected.schemaFingerprint };
    const outcome = await mutateWorkspace(owner, "csv.import.resume.chunk", workspace => {
      const run = findRun(workspace, importRunId);
      if (!run || !canResumeImportStatus(run.status))
        throw new Error("此 Import Run 已完成或已封存，不需要 Resume。");
      const version = workspace.templateVersions.find(item => item.id === run.templateVersionId);
      const template = version && workspace.templates.find(item => item.id === version.templateId);
      if (!version || !template)
        throw new Error("Import Run 綁定的 Template Version 不存在。");
      const versionFields = workspace.fields.filter(field => field.templateVersionId === version.id);
      validateMapping(parsedChunk.headers, run.decisionManifest, versionFields);
      run.status = "running";
      run.completedAt = null;
      return processRows({
        workspace,
        run,
        parsed: parsedChunk,
        templateId: template.id,
        templateVersionHash: version.contentHash,
        versionFields,
        skipRowNumbers: completedRows,
        rowCorrections: run.rowCorrections,
      });
    });
    totals.created += outcome.created;
    totals.duplicate += outcome.duplicate;
    totals.warnings += outcome.warnings;
    totals.failed += outcome.failed;
    pending = [];
  };
  try {
    source = await openLocalAssetStream(owner, savedRun.sourceAssetId!);
    for await (const row of readValidatedCsvRows(source)) {
      if (!headers.length) headers = row.headers;
      pending.push(csvRowToObject(row.headers, row.record));
      if (pending.length >= CSV_PROCESS_CHUNK_SIZE) await flush();
    }
    await flush();
  } catch (error) {
    await mutateWorkspace(owner, "csv.import.resume.fail", workspace => {
      const run = findRun(workspace, importRunId);
      if (run && run.status === "running") {
        run.status = "failed";
        run.completedAt = now();
      }
    });
    throw error;
  } finally {
    source?.destroy();
  }

  await mutateWorkspace(owner, "csv.import.resume.complete", workspace => {
    const run = findRun(workspace, importRunId);
    if (run && run.status === "running") {
      run.status = "completed";
      run.completedAt = now();
    }
  });

  return {
    importRunId,
    reused: false,
    totalRows: savedRun.totalRows,
    ...totals,
  };
}

type V2ImportRunRecord = ImportRunRecord & { attempt?: number };

function deterministicImportId(prefix: "row" | "ins" | "map", ...parts: Array<string | number>) {
  return `${prefix}-${crypto.createHash("sha256").update(parts.join("\u001f")).digest("hex").slice(0, 40)}`;
}

async function queryAllV2<T>(
  owner: string,
  collection: LocalWorkspaceV2Collection,
  where: Record<string, string | number | boolean | null>,
  maximum = 10_000
) {
  const records: T[] = [];
  let cursor: string | null = null;
  do {
    const page: { revision: number; records: T[]; nextCursor: string | null } =
      await queryLocalWorkspaceV2<T>(owner, {
      collection,
      where,
      limit: Math.min(1_000, maximum - records.length),
      cursor,
      });
    records.push(...page.records);
    cursor = page.nextCursor;
    if (cursor && records.length >= maximum)
      throw new Error("Workspace v2 query exceeded its bounded result limit.");
  } while (cursor);
  return records;
}

async function loadV2TemplateContext(owner: string, templateVersionId: string) {
  // describe triggers one-time, verified legacy migration before any v2 read.
  await describeLocalWorkspaceV2(owner);
  // Template definitions remain the bounded legacy domain during this
  // vertical slice; high-growth records are authoritative in v2. Reading the
  // current definition here avoids using the migration-time template copy
  // after a later draft/publish operation.
  const { workspace } = await readWorkspace(owner);
  const version = workspace.templateVersions.find(item => item.id === templateVersionId);
  if (!version) throw new Error("找不到指定 Template Version。");
  const template = workspace.templates.find(item => item.id === version.templateId);
  if (!template) throw new Error("找不到指定 Template。");
  const fields = workspace.fields.filter(item => item.templateVersionId === version.id);
  return { version, template, fields };
}

async function getV2ImportRun(owner: string, importRunId: string) {
  const runs = await queryAllV2<V2ImportRunRecord>(owner, "importRuns", { id: importRunId }, 2);
  return runs[0];
}

async function findCompletedV2ImportRun(
  owner: string,
  templateVersionId: string,
  sourceHash: string,
  decisionHash: string
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let cursor: string | null = null;
    try {
      do {
        const page: {
          revision: number;
          records: V2ImportRunRecord[];
          nextCursor: string | null;
        } = await queryLocalWorkspaceV2<V2ImportRunRecord>(owner, {
          collection: "importRuns",
          where: { templateVersionId },
          limit: 1_000,
          cursor,
          order: "desc",
        });
        const match = page.records.find(
          run =>
            run.sourceHash === sourceHash &&
            run.decisionHash === decisionHash &&
            run.status === "completed"
        );
        if (match) return match;
        cursor = page.nextCursor;
      } while (cursor);
      return undefined;
    } catch (error) {
      if (
        !(error instanceof LocalServiceRequestError) ||
        error.code !== "workspace_v2_stale_cursor" ||
        attempt === 2
      )
        throw error;
      await yieldToRuntime();
    }
  }
  return undefined;
}

async function transactV2WithConflictRetry(
  owner: string,
  build: () => Promise<LocalWorkspaceV2Transaction>,
  maximumConflicts = 5
) {
  for (let conflict = 0; conflict < maximumConflicts; conflict += 1) {
    const request = await build();
    try {
      return await transactLocalWorkspaceV2(owner, request);
    } catch (error) {
      if (
        error instanceof LocalServiceRequestError &&
        error.code === "workspace_v2_revision_conflict"
      ) {
        await yieldToRuntime();
        continue;
      }
      // A transport failure is ambiguous: the transaction may already have
      // committed. Retry the byte-identical request once so transactionId
      // idempotency can return the original result without duplicating rows.
      if (!(error instanceof LocalServiceRequestError))
        return transactLocalWorkspaceV2(owner, request);
      throw error;
    }
  }
  throw new Error("Workspace data remained busy; retry the import.");
}

type V2CsvChunkRow = {
  rowNumber: number;
  sourceValues: Record<string, string>;
};

async function commitStoredCsvChunk(input: {
  owner: string;
  runId: string;
  attempt: number;
  rows: V2CsvChunkRow[];
  template: LocalTemplate;
  version: LocalTemplateVersion;
  fields: LocalField[];
  duplicateDecisions?: DuplicateDecisionInput[];
  rowCorrections?: RowCorrectionInput[];
}) {
  if (!input.rows.length) return { created: 0, duplicate: 0, warnings: 0, failed: 0 };
  let outcome = { created: 0, duplicate: 0, warnings: 0, failed: 0 };
  await transactV2WithConflictRetry(input.owner, async () => {
    const run = await getV2ImportRun(input.owner, input.runId);
    if (!run || !canResumeImportStatus(run.status))
      throw new Error("此 Import Run 已完成或已封存，不需要 Resume。");
    if ((run.attempt ?? 1) !== input.attempt)
      throw new Error("Import Run 已由另一個 Resume 操作接管。");

    const rowNumbers = input.rows.map(row => row.rowNumber);
    const priorRows = await queryManyLocalWorkspaceV2<ImportRowRecord>(input.owner, {
      collection: "importRows",
      key: "rowNumber",
      values: rowNumbers,
      where: { importRunId: run.id },
    });
    const completed = new Set(
      priorRows.records
        .filter(row => row.status === "created" || row.status === "duplicate")
        .map(row => row.rowNumber)
    );
    const candidates = input.rows
      .filter(row => !completed.has(row.rowNumber))
      .map(row => {
        const correction = input.rowCorrections?.find(item => item.rowNumber === row.rowNumber);
        const rawValues = {
          ...mapCsvRow(row.sourceValues, run.decisionManifest),
          ...(correction?.values ?? {}),
        };
        let mappedValues: Record<string, string>;
        let structuralError: string | null = null;
        try {
          mappedValues = normalizeInstanceValuesForStorage(rawValues, input.fields);
        } catch (err: any) {
          structuralError = err.message || "表格資料結構無效";
          mappedValues = rawValues;
        }
        const issues = validateImportedValues(mappedValues, input.fields);
        return {
          ...row,
          mappedValues,
          rowFingerprint: sha256({ sourceHash: run.sourceHash, mappedValues } as unknown as JsonValue),
          valuesHash: sha256(mappedValues),
          errors: [
            ...(structuralError ? [structuralError] : []),
            ...issues.filter(issue => issue.blocking).map(issue => issue.message),
          ],
          warnings: issues.filter(issue => !issue.blocking).map(issue => issue.message),
        };
      });
    const hashes = Array.from(new Set(candidates.map(item => item.valuesHash)));
    const existingByHashResult = hashes.length
      ? await queryManyLocalWorkspaceV2<LocalInstance>(input.owner, {
          collection: "instances", key: "valuesHash", values: hashes,
          where: { templateVersionId: input.version.id },
        })
      : { records: [] as LocalInstance[] };
    const explicitIds = Array.from(new Set(
      (input.duplicateDecisions ?? [])
        .filter(decision => candidates.some(row => row.rowNumber === decision.rowNumber))
        .map(decision => decision.instanceId)
        .filter((value): value is string => Boolean(value))
    ));
    const explicitInstances = explicitIds.length
      ? (await queryManyLocalWorkspaceV2<LocalInstance>(input.owner, {
          collection: "instances", key: "id", values: explicitIds,
        })).records
      : [];
    const byHash = new Map(existingByHashResult.records.map(instance => [instance.valuesHash, instance]));
    const byId = new Map(explicitInstances.map(instance => [instance.id, instance]));
    const seenFingerprints = new Set<string>();
    const puts: NonNullable<LocalWorkspaceV2Transaction["put"]> = [];
    let created = 0;
    let duplicate = 0;
    let warnings = 0;
    let failed = 0;
    const timestamp = now();

    for (const item of candidates) {
      const decision = input.duplicateDecisions?.find(value => value.rowNumber === item.rowNumber);
      const duplicateInChunk = seenFingerprints.has(item.rowFingerprint);
      seenFingerprints.add(item.rowFingerprint);
      let existing = decision?.instanceId ? byId.get(decision.instanceId) : byHash.get(item.valuesHash);
      if (existing && existing.templateVersionId !== input.version.id) existing = undefined;
      let status: ImportRowRecord["status"] = "created";
      let instanceId: string | null = null;
      let errors = [...item.warnings];
      let finalValues = item.mappedValues;

      if (item.errors.length) {
        status = "failed";
        errors = item.errors;
        failed += 1;
      } else if (decision?.action === "overwrite" && existing) {
        let overwriteError: string | null = null;
        let normalizedFinal = existing.values;
        try {
          normalizedFinal = normalizeInstanceValuesForStorage(
            decision.mergedValues ?? item.mappedValues,
            input.fields
          );
        } catch (err: any) {
          overwriteError = err.message || "表格資料結構無效";
        }
        if (overwriteError) {
          status = "failed";
          errors = [overwriteError];
          failed += 1;
        } else {
          finalValues = normalizedFinal;
          const updated = {
            ...existing,
            values: finalValues,
            valuesHash: sha256(finalValues),
            updatedAt: timestamp,
          };
          puts.push({ collection: "instances", record: updated as unknown as Record<string, unknown> });
          status = "duplicate";
          instanceId = existing.id;
          errors = ["matching-instance-overwritten"];
          duplicate += 1;
        }
      } else if (decision?.action === "skip" || ((existing || duplicateInChunk) && decision?.action !== "create")) {
        status = "duplicate";
        instanceId = existing?.id ?? decision?.instanceId ?? null;
        errors = [existing ? "matching-instance-already-exists" : "duplicate-row-in-source"];
        duplicate += 1;
      } else {
        instanceId = deterministicImportId("ins", run.id, item.rowNumber);
        const name = Object.values(item.mappedValues).find(Boolean) || `Imported Row ${item.rowNumber}`;
        const instance: LocalInstance = {
          id: instanceId,
          ownerId: run.ownerId,
          templateId: input.template.id,
          templateVersionId: input.version.id,
          templateVersionHash: input.version.contentHash,
          schemaVersion: 2,
          name: name.slice(0, 255),
          status: "draft",
          values: item.mappedValues,
          valuesHash: item.valuesHash,
          printCount: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
          completedAt: null,
          lastPrintedAt: null,
          outputHistory: [],
        };
        puts.push({ collection: "instances", record: instance as unknown as Record<string, unknown> });
        created += 1;
        if (item.warnings.length) warnings += 1;
      }
      const importRow: ImportRowRecord = {
        id: deterministicImportId("row", run.id, item.rowNumber),
        importRunId: run.id,
        rowNumber: item.rowNumber,
        rowFingerprint: item.rowFingerprint,
        status,
        sourceValues: item.sourceValues,
        mappedValues: finalValues,
        instanceId,
        errors,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      puts.push({ collection: "importRows", record: importRow as unknown as Record<string, unknown> });
    }
    const nextRun: V2ImportRunRecord = {
      ...run,
      status: "running",
      successCount: run.successCount + created,
      warningCount: run.warningCount + duplicate + warnings,
      failedCount: run.failedCount + failed,
      completedAt: null,
    };
    puts.push({ collection: "importRuns", record: nextRun as unknown as Record<string, unknown> });
    outcome = { created, duplicate, warnings, failed };
    const description = await describeLocalWorkspaceV2(input.owner);
    return {
      expectedRevision: description.revision,
      transactionId: `csv:${run.id}:attempt:${input.attempt}:chunk:${input.rows[0]!.rowNumber}-${input.rows[input.rows.length - 1]!.rowNumber}`,
      put: puts,
      metaPatch: { updatedAt: new Date(timestamp).toISOString() },
    };
  });
  return outcome;
}

async function setV2ImportRunStatus(
  owner: string,
  runId: string,
  attempt: number,
  status: "running" | "failed" | "completed"
) {
  await transactV2WithConflictRetry(owner, async () => {
    const run = await getV2ImportRun(owner, runId);
    if (!run) throw new Error("找不到指定 Import Run。");
    if ((run.attempt ?? 1) !== attempt)
      throw new Error("Import Run 已由另一個 Resume 操作接管。");
    const timestamp = now();
    const description = await describeLocalWorkspaceV2(owner);
    return {
      expectedRevision: description.revision,
      transactionId: `csv:${run.id}:attempt:${attempt}:status:${status}`,
      put: [{
        collection: "importRuns",
        record: {
          ...run,
          status,
          completedAt: status === "running" ? null : timestamp,
        } as unknown as Record<string, unknown>,
      }],
      metaPatch: { updatedAt: new Date(timestamp).toISOString() },
    };
  });
}

async function processStoredCsvV2(input: {
  owner: string;
  sourceAssetId: string;
  runId: string;
  attempt: number;
  template: LocalTemplate;
  version: LocalTemplateVersion;
  fields: LocalField[];
  duplicateDecisions?: DuplicateDecisionInput[];
  rowCorrections?: RowCorrectionInput[];
}) {
  const totals = { created: 0, duplicate: 0, warnings: 0, failed: 0 };
  let pending: V2CsvChunkRow[] = [];
  const source = await openLocalAssetStream(input.owner, input.sourceAssetId);
  const flush = async () => {
    if (!pending.length) return;
    const outcome = await commitStoredCsvChunk({ ...input, rows: pending });
    totals.created += outcome.created;
    totals.duplicate += outcome.duplicate;
    totals.warnings += outcome.warnings;
    totals.failed += outcome.failed;
    pending = [];
  };
  try {
    for await (const row of readValidatedCsvRows(source)) {
      pending.push({ rowNumber: row.rowNumber, sourceValues: csvRowToObject(row.headers, row.record) });
      if (pending.length >= CSV_PROCESS_CHUNK_SIZE) await flush();
    }
    await flush();
  } finally {
    source.destroy();
  }
  return totals;
}

export async function createStoredImportRun(
  ownerId: string | number,
  input: {
    templateVersionId: string;
    sourceAssetId: string;
    sourceHash: string;
    originalFilename?: string;
    decisions: MappingDecisionInput[];
    mode: "strict" | "tolerant";
    duplicateDecisions?: DuplicateDecisionInput[];
    rowCorrections?: RowCorrectionInput[];
  }
) {
  const owner = ownerKey(ownerId);
  const inspected = await inspectStoredCsv(owner, input.sourceAssetId);
  if (inspected.sourceHash !== input.sourceHash)
    throw new Error("原始 CSV 資產完整性驗證失敗。");
  const context = await loadV2TemplateContext(owner, input.templateVersionId);
  if (context.version.state !== "published" && context.version.state !== "superseded")
    throw new Error("CSV 批量建立只允許使用已發佈的 Template Version。");
  validateMapping(inspected.headers, input.decisions, context.fields);
  const decisionHash = sha256({
    mappings: input.decisions,
    duplicates: input.duplicateDecisions ?? [],
    corrections: input.rowCorrections ?? [],
  } as unknown as JsonValue);
  const existing = await findCompletedV2ImportRun(
    owner,
    context.version.id,
    inspected.sourceHash,
    decisionHash
  );
  if (existing) return {
    importRunId: existing.id, reused: true, totalRows: existing.totalRows,
    created: existing.successCount, duplicate: existing.warningCount, failed: existing.failedCount,
  };

  if (input.mode === "strict") {
    let failures = 0;
    const source = await openLocalAssetStream(owner, input.sourceAssetId);
    try {
      for await (const row of readValidatedCsvRows(source)) {
        const correction = input.rowCorrections?.find(item => item.rowNumber === row.rowNumber);
        const values = {
          ...mapCsvRow(csvRowToObject(row.headers, row.record), input.decisions),
          ...(correction?.values ?? {}),
        };
        if (validateImportedValues(values, context.fields).some(issue => issue.blocking)) failures += 1;
      }
    } finally { source.destroy(); }
    if (failures)
      throw new Error(`Strict 匯入已取消：${failures} 筆資料未通過欄位驗證，未建立任何 Instance。`);
  }

  const importRunId = createStableId("run");
  const createdAt = now();
  const run: V2ImportRunRecord = {
    id: importRunId,
    ownerId: owner,
    templateVersionId: context.version.id,
    sourceAssetId: input.sourceAssetId,
    originalFilename: input.originalFilename || inspected.originalFilename,
    status: "running",
    mode: input.mode,
    sourceHash: inspected.sourceHash,
    sourceSchemaFingerprint: inspected.schemaFingerprint,
    decisionHash,
    decisionManifest: input.decisions,
    rowCorrections: input.rowCorrections,
    totalRows: inspected.totalRows,
    successCount: 0,
    warningCount: 0,
    failedCount: 0,
    createdAt,
    completedAt: null,
    attempt: 1,
  };
  await transactV2WithConflictRetry(owner, async () => {
    const description = await describeLocalWorkspaceV2(owner);
    return {
      expectedRevision: description.revision,
      transactionId: `csv:${importRunId}:create`,
      put: [
        { collection: "importRuns", record: run as unknown as Record<string, unknown> },
        ...input.decisions.map((decision, index) => ({
          collection: "mappingDecisions" as const,
          record: {
            id: deterministicImportId("map", importRunId, index),
            importRunId,
            ...decision,
            templateStableFieldId: decision.templateStableFieldId ?? null,
            decidedAt: createdAt,
            createdAt,
          },
        })),
      ],
      metaPatch: { updatedAt: new Date(createdAt).toISOString() },
    };
  });

  let totals;
  try {
    totals = await processStoredCsvV2({
      owner, sourceAssetId: input.sourceAssetId, runId: importRunId, attempt: 1,
      template: context.template, version: context.version, fields: context.fields,
      duplicateDecisions: input.duplicateDecisions, rowCorrections: input.rowCorrections,
    });
    await setV2ImportRunStatus(owner, importRunId, 1, "completed");
  } catch (error) {
    await setV2ImportRunStatus(owner, importRunId, 1, "failed").catch(() => {});
    throw error;
  }
  return { importRunId, reused: false, totalRows: inspected.totalRows, ...totals };
}

export async function resumeStoredImportRun(ownerId: string | number, importRunId: string) {
  const owner = ownerKey(ownerId);
  const savedRun = await getV2ImportRun(owner, importRunId);
  if (!savedRun) throw new Error("找不到指定 Import Run，或您沒有存取權限。");
  if (!canResumeImportStatus(savedRun.status))
    throw new Error("此 Import Run 已完成或已封存，不需要 Resume。");
  if (!savedRun.sourceAssetId)
    throw new Error("此 Import Run 缺少可重播的原始 CSV 資產。");
  const inspected = await inspectStoredCsv(owner, savedRun.sourceAssetId);
  if (inspected.sourceHash !== savedRun.sourceHash)
    throw new Error("原始 CSV 資產完整性驗證失敗。");
  const context = await loadV2TemplateContext(owner, savedRun.templateVersionId);
  validateMapping(inspected.headers, savedRun.decisionManifest, context.fields);
  const attempt = (savedRun.attempt ?? 1) + 1;
  await transactV2WithConflictRetry(owner, async () => {
    const current = await getV2ImportRun(owner, importRunId);
    if (!current || !canResumeImportStatus(current.status))
      throw new Error("此 Import Run 已完成或已封存，不需要 Resume。");
    const description = await describeLocalWorkspaceV2(owner);
    return {
      expectedRevision: description.revision,
      transactionId: `csv:${importRunId}:resume:${attempt}`,
      put: [{
        collection: "importRuns",
        record: {
          ...current,
          attempt,
          status: "running",
          completedAt: null,
          failedCount: 0,
        } as unknown as Record<string, unknown>,
      }],
      metaPatch: { updatedAt: new Date().toISOString() },
    };
  });
  let totals;
  try {
    totals = await processStoredCsvV2({
      owner, sourceAssetId: savedRun.sourceAssetId, runId: importRunId, attempt,
      template: context.template, version: context.version, fields: context.fields,
      rowCorrections: savedRun.rowCorrections,
    });
    await setV2ImportRunStatus(owner, importRunId, attempt, "completed");
  } catch (error) {
    await setV2ImportRunStatus(owner, importRunId, attempt, "failed").catch(() => {});
    throw error;
  }
  return { importRunId, reused: false, totalRows: savedRun.totalRows, ...totals };
}
