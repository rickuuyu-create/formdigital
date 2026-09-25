import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  revision: 1,
  workspace: {} as Record<string, unknown>,
  deletedAssets: [] as string[],
  rejectAssetId: "",
  listedAssets: [] as Array<{ id: string; metadata: Record<string, unknown> }>,
  v2Revision: 1,
  v2Instances: [] as Array<Record<string, unknown>>,
  v2Journal: [] as Array<Record<string, unknown>>,
}));

vi.mock("./localServiceClient", () => {
  class LocalServiceRequestError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return {
  LocalServiceRequestError,
  loadLocalWorkspace: vi.fn(async () => ({
    revision: mockState.revision,
    workspace: structuredClone(mockState.workspace),
  })),
  saveLocalWorkspace: vi.fn(async (_owner: string, workspace: unknown) => {
    mockState.revision += 1;
    mockState.workspace = structuredClone(workspace) as Record<string, unknown>;
    return { revision: mockState.revision, workspace };
  }),
  deleteLocalAsset: vi.fn(async (_owner: string, assetId: string) => {
    if (assetId === "asset-shared")
      throw new LocalServiceRequestError(409, "asset_in_use", "TEST_SHARED_ASSET");
    if (assetId === mockState.rejectAssetId) throw new Error("TEST_DELETE_FAILURE");
    mockState.deletedAssets.push(assetId);
    return { deleted: true, assetId };
  }),
  listLocalAssets: vi.fn(async () => ({ assets: structuredClone(mockState.listedAssets) })),
  deleteLocalTemplateAssets: vi.fn(),
  describeLocalWorkspaceV2: vi.fn(async () => ({
    storageSchemaVersion: 2,
    schemaVersion: 2,
    revision: mockState.v2Revision,
  })),
  queryManyLocalWorkspaceV2: vi.fn(async (_owner: string, input: { collection: string; values: string[] }) => ({
    revision: mockState.v2Revision,
    records: input.collection === "instances"
      ? structuredClone(mockState.v2Instances.filter(record => input.values.includes(String(record.id))))
      : [],
  })),
  queryLocalWorkspaceV2: vi.fn(async (_owner: string, input: {
    collection: string;
    where?: { id?: string; status?: string };
    limit?: number;
    cursor?: string | null;
    order?: "asc" | "desc";
  }) => {
    const source = input.collection === "instances"
      ? mockState.v2Instances
      : input.collection === "operationJournal"
        ? mockState.v2Journal
        : [];
    let filtered = source.filter(record =>
      (input.where?.id === undefined || record.id === input.where.id) &&
      (input.where?.status === undefined || record.status === input.where.status)
    );
    if (input.order === "desc") {
      filtered = [...filtered].reverse();
    }
    const limit = input.limit ?? 100;
    const startIndex = input.cursor ? Number(input.cursor) : 0;
    const slice = filtered.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + limit < filtered.length;
    const nextCursor = hasMore ? String(startIndex + limit) : null;
    return {
      revision: mockState.v2Revision,
      records: structuredClone(slice),
      nextCursor,
    };
  }),
  queryLocalWorkspaceJournalInternal: vi.fn(async (owner: string, input: {
    limit?: number;
    cursor?: string | null;
    order?: "asc" | "desc";
  }) => {
    const { queryLocalWorkspaceV2: qv2 } = await import("./localServiceClient");
    const v2Res = await qv2(owner, {
      collection: "operationJournal",
      limit: input.limit,
      cursor: input.cursor,
      order: input.order,
    });
    return {
      revision: v2Res.revision,
      items: (v2Res.records || []).map((raw: Record<string, unknown>, idx: number) => {
        // The real internal-journal route reports the storage-level record id
        // separately from the payload. A test may set `recordId` to model a
        // native v2 record whose payload carries no id of its own.
        const record = { ...raw };
        let recordId: string;
        if (typeof record.recordId === "string") {
          recordId = record.recordId;
          delete record.recordId;
        } else if (typeof record.id === "string") {
          recordId = record.id;
        } else {
          recordId = `@legacy:${String(idx).padStart(12, "0")}`;
        }
        return { recordId, sequence: idx + 1, record };
      }),
      nextCursor: v2Res.nextCursor,
    };
  }),
  transactLocalWorkspaceV2: vi.fn(async (_owner: string, input: {
    expectedRevision: number;
    put?: Array<{ collection: string; record: Record<string, unknown> }>;
    deleteIds?: Array<{ collection: string; ids: string[] }>;
  }) => {
    if (input.expectedRevision !== mockState.v2Revision)
      throw new LocalServiceRequestError(409, "workspace_v2_revision_conflict", "TEST_CONFLICT");
    for (const put of input.put ?? []) {
      const target = put.collection === "instances" ? mockState.v2Instances : mockState.v2Journal;
      const index = target.findIndex(record => record.id === put.record.id);
      if (index >= 0) target[index] = structuredClone(put.record);
      else target.push(structuredClone(put.record));
    }
    for (const deletion of input.deleteIds ?? []) {
      const target = deletion.collection === "instances" ? mockState.v2Instances : mockState.v2Journal;
      const retained = target.filter(record => !deletion.ids.includes(String(record.id)));
      target.splice(0, target.length, ...retained);
    }
    const baseRevision = mockState.v2Revision;
    mockState.v2Revision += 1;
    return { baseRevision, revision: mockState.v2Revision, operationCount: 1, idempotent: false };
  }),
  };
});

import { deleteInstancesForOwner, listWorkspaceCollections } from "./repository";

function baseWorkspace() {
  const timestamp = "2026-01-01T00:00:00.000Z";
  const instance = (
    id: string,
    imageAssetId: string,
    outputAssetId: string
  ) => ({
    id,
    ownerId: "owner-test",
    templateId: "tpl-test",
    templateVersionId: "ver-test",
    templateVersionHash: "hash-test",
    schemaVersion: 1,
    name: id,
    status: "draft",
    values: { image: imageAssetId, text: "not-an-asset" },
    valuesHash: "values-hash",
    printCount: 0,
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
    lastPrintedAt: null,
    outputHistory: [{ assetId: outputAssetId }],
  });
  return {
    schemaVersion: 2,
    ownerKey: "owner-test",
    createdAt: timestamp,
    updatedAt: timestamp,
    templates: [],
    templateVersions: [],
    fields: [
      {
        id: "field-image",
        templateVersionId: "ver-test",
        stableFieldId: "image",
        fieldType: "image",
        displayOrder: 0,
        definition: {},
        coordinate: {},
        createdAt: 1,
      },
    ],
    instances: [
      instance("ins-delete", "asset-shared", "asset-output-delete"),
      instance("ins-keep", "asset-shared", "asset-output-keep"),
    ],
    folders: [],
    tags: [],
    savedValues: [],
    mappingTemplates: [],
    importRuns: [],
    importRows: [],
    mappingDecisions: [],
    detectionRuns: [],
    operationJournal: [],
    preferences: {},
  };
}

describe("deleteInstancesForOwner asset lifecycle", () => {
  beforeEach(() => {
    mockState.revision = 1;
    mockState.workspace = baseWorkspace();
    mockState.deletedAssets = [];
    mockState.rejectAssetId = "";
    mockState.listedAssets = [];
    mockState.v2Revision = 1;
    mockState.v2Instances = structuredClone(
      (mockState.workspace.instances ?? []) as Array<Record<string, unknown>>
    );
    mockState.v2Journal = [];
  });

  it("deletes unreferenced output assets but preserves shared media", async () => {
    const result = await deleteInstancesForOwner("owner-test", ["ins-delete"]);

    expect(result).toEqual({
      deleted: 1,
      deletedAssets: 1,
      assetCleanupPending: 0,
    });
    expect(mockState.deletedAssets).toEqual(["asset-output-delete"]);
    expect(
      (mockState.v2Instances as Array<{ id: string }>).map(item => item.id)
    ).toEqual(["ins-keep"]);
    expect(mockState.v2Journal).toEqual([]);
  });

  it("commits the instance deletion safely and reports deferred cleanup", async () => {
    mockState.rejectAssetId = "asset-output-delete";

    const result = await deleteInstancesForOwner("owner-test", ["ins-delete"]);

    expect(result).toEqual({
      deleted: 1,
      deletedAssets: 0,
      assetCleanupPending: 1,
    });
    expect(
      (mockState.v2Instances as Array<{ id: string }>).map(item => item.id)
    ).toEqual(["ins-keep"]);
    expect(mockState.v2Journal).toHaveLength(1);
    expect(mockState.v2Journal[0]).toMatchObject({
      type: "asset-cleanup",
      status: "pending",
      assetIds: ["asset-output-delete"],
    });

    mockState.rejectAssetId = "";
    await listWorkspaceCollections("owner-test");
    expect(mockState.deletedAssets).toEqual(["asset-output-delete"]);
    expect(mockState.v2Journal).toEqual([]);
  });

  it("discovers metadata-owned orphan assets after the workspace commit", async () => {
    mockState.listedAssets = [
      { id: "asset-metadata-orphan", metadata: { instanceId: "ins-delete" } },
      { id: "asset-metadata-kept", metadata: { instanceId: "ins-keep" } },
    ];

    const result = await deleteInstancesForOwner("owner-test", ["ins-delete"]);

    expect(result).toEqual({
      deleted: 1,
      deletedAssets: 2,
      assetCleanupPending: 0,
    });
    expect(mockState.deletedAssets.sort()).toEqual([
      "asset-metadata-orphan",
      "asset-output-delete",
    ]);
  });
});

describe("listWorkspaceCollections journal merging and display consistency (Problem C regression)", () => {
  beforeEach(() => {
    mockState.revision = 1;
    mockState.workspace = baseWorkspace();
    mockState.deletedAssets = [];
    mockState.rejectAssetId = "";
    mockState.listedAssets = [];
    mockState.v2Revision = 1;
    mockState.v2Instances = [];
    mockState.v2Journal = [];
  });

  it("1. archived wrapper unwraps to the original operation journal entry", async () => {
    mockState.v2Journal = [
      {
        id: "archive-wrap-1",
        archivedAt: "2026-09-05T00:00:00.000Z",
        archivedEntry: {
          operation: "template.publish",
          at: "2021-06-01T10:00:00.000Z",
        },
      },
    ];

    const collections = await listWorkspaceCollections("owner-test");
    expect(collections.operationJournal).toHaveLength(1);
    const entry = collections.operationJournal[0];
    expect(entry).not.toHaveProperty("archivedEntry");
    expect(entry).toMatchObject({
      operation: "template.publish",
      at: "2021-06-01T10:00:00.000Z",
    });
  });

  it("2. sorts old events by original event time, not archivedAt", async () => {
    // 2021 event archived in 2026 should be older than a 2024 event
    mockState.v2Journal = [
      {
        id: "archive-wrap-old",
        archivedAt: "2026-09-05T12:00:00.000Z",
        archivedEntry: {
          operation: "old.2021",
          at: "2021-01-01T00:00:00.000Z",
        },
      },
    ];
    (mockState.workspace.operationJournal as Array<Record<string, unknown>>) = [
      {
        operation: "recent.2024",
        at: "2024-01-01T00:00:00.000Z",
      },
    ];

    const collections = await listWorkspaceCollections("owner-test");
    expect(collections.operationJournal.map(e => e.operation)).toEqual([
      "recent.2024",
      "old.2021",
    ]);
  });

  it("3. deduplicates the same occurrence with different object key order", async () => {
    (mockState.workspace.operationJournal as Array<Record<string, unknown>>) = [
      { at: "2023-01-01T00:00:00.000Z", operation: "key.order.test", extra: "val" },
    ];
    mockState.v2Journal = [
      { extra: "val", operation: "key.order.test", at: "2023-01-01T00:00:00.000Z" },
    ];

    const collections = await listWorkspaceCollections("owner-test");
    expect(collections.operationJournal).toHaveLength(1);
  });

  it("4. preserves distinct occurrences with identical content", async () => {
    // Two identical occurrences within v1 should both be preserved (not swallowed by global Set)
    (mockState.workspace.operationJournal as Array<Record<string, unknown>>) = [
      { operation: "identical.op", at: "2023-05-01T00:00:00.000Z" },
      { operation: "identical.op", at: "2023-05-01T00:00:00.000Z" },
    ];
    mockState.v2Journal = [];

    const collections = await listWorkspaceCollections("owner-test");
    expect(collections.operationJournal).toHaveLength(2);
  });

  it("5. v1 2 copies and v2 2 copies of migrated occurrences result in 2 copies, not 1 or 4", async () => {
    const entry = { operation: "migrated.op", at: "2023-05-01T00:00:00.000Z" };
    (mockState.workspace.operationJournal as Array<Record<string, unknown>>) = [
      structuredClone(entry),
      structuredClone(entry),
    ];
    mockState.v2Journal = [
      structuredClone(entry),
      structuredClone(entry),
    ];

    const collections = await listWorkspaceCollections("owner-test");
    expect(collections.operationJournal).toHaveLength(2);
  });

  it("6. sorts ISO dates correctly", async () => {
    (mockState.workspace.operationJournal as Array<Record<string, unknown>>) = [
      { operation: "first", at: "2022-01-01T00:00:00.000Z" },
      { operation: "third", at: "2024-01-01T00:00:00.000Z" },
      { operation: "second", at: "2023-01-01T00:00:00.000Z" },
    ];

    const collections = await listWorkspaceCollections("owner-test");
    expect(collections.operationJournal.map(e => e.operation)).toEqual([
      "third",
      "second",
      "first",
    ]);
  });

  it("7. sorts numeric epoch milliseconds correctly", async () => {
    (mockState.workspace.operationJournal as Array<Record<string, unknown>>) = [
      { operation: "epoch-low", at: 1600000000000 },
      { operation: "epoch-high", at: 1700000000000 },
      { operation: "iso-mid", at: new Date(1650000000000).toISOString() },
    ];

    const collections = await listWorkspaceCollections("owner-test");
    expect(collections.operationJournal.map(e => e.operation)).toEqual([
      "epoch-high",
      "iso-mid",
      "epoch-low",
    ]);
  });

  it("8. falls back to createdAt or archivedAt when at is invalid", async () => {
    (mockState.workspace.operationJournal as Array<Record<string, unknown>>) = [
      { operation: "invalid-at-with-created", at: "not-a-valid-date", createdAt: "2024-06-01T00:00:00.000Z" },
      { operation: "valid-older", at: "2023-01-01T00:00:00.000Z" },
    ];

    const collections = await listWorkspaceCollections("owner-test");
    expect(collections.operationJournal.map(e => e.operation)).toEqual([
      "invalid-at-with-created",
      "valid-older",
    ]);
  });

  it("9. deduplicates genuine @legacy: cutover copies and sorts before slicing to 100", async () => {
    // 120 v1 entries (no id of their own). The legacy migration mints "@legacy:"
    // record ids for cutover copies, which ARE reliable provenance (D-004). 50 of
    // them reappear in v2 as @legacy: cutover copies and must be deduplicated.
    // Ordinary business ids are deliberately NOT used here: under the re-review
    // they are no longer treated as provenance (see JRN-01 tests 26/30).
    const items = Array.from({ length: 120 }, (_, i) => ({
      operation: `op-${i}`,
      at: new Date(1600000000000 + i * 10000).toISOString(),
    }));
    (mockState.workspace.operationJournal as Array<Record<string, unknown>>) = structuredClone(items);
    mockState.v2Journal = items.slice(0, 50).map((entry, i) => ({
      ...entry,
      id: `@legacy:${String(i).padStart(12, "0")}`,
    }));

    const collections = await listWorkspaceCollections("owner-test");
    expect(collections.operationJournal).toHaveLength(100);
    // Newest is item-119, oldest of the 100 kept is item-20
    expect(collections.operationJournal[0].operation).toBe("op-119");
    expect(collections.operationJournal[99].operation).toBe("op-20");
  });

  it("10. paginates all v2 journal records and does not exclude newer operations displaced by old archives", async () => {
    // 1 newer operation from 2026 was inserted into v2 first (sequence 1).
    // 101 older operations from 2021 were archived into v2 afterward (sequences 2..102).
    // When queried with order: "desc", the 101 archived operations appear first.
    // Without pagination, limit: 100 truncates sequence 1.
    // With pagination, sequence 1 is retrieved and sorted to index 0 by event timestamp.
    const op2026 = {
      id: "op-2026",
      operation: "new.op.2026",
      at: "2026-09-01T12:00:00.000Z",
    };
    const archived101 = Array.from({ length: 101 }, (_, i) => ({
      id: `archive-wrapper-${i}`,
      archivedAt: "2026-09-05T00:00:00.000Z",
      archivedEntry: {
        id: `op-old-${i}`,
        operation: `old.op.${i}`,
        at: `2021-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
      },
    }));

    (mockState.workspace.operationJournal as Array<Record<string, unknown>>) = [];
    // Insertion order: op2026 first, then archived101
    mockState.v2Journal = [op2026, ...archived101];

    const collections = await listWorkspaceCollections("owner-test");
    expect(collections.operationJournal).toHaveLength(100);
    // The 2026 operation MUST NOT be lost, and must be at index 0 because it has the latest event timestamp
    expect(collections.operationJournal[0].id).toBe("op-2026");
    expect(collections.operationJournal[0].operation).toBe("new.op.2026");
  });

  it("11. does not merge independent identical occurrence in v1 with archived entry in v2", async () => {
    // v2 has an archived entry with action "toggle" from 2021
    mockState.v2Journal = [
      {
        id: "archive-wrapper-toggle",
        archivedAt: "2026-09-01T00:00:00.000Z",
        archivedEntry: { operation: "toggle", at: "2021-01-01T00:00:00.000Z" },
      },
    ];
    // v1 has an active entry with the exact same content from 2026
    (mockState.workspace.operationJournal as Array<Record<string, unknown>>) = [
      { operation: "toggle", at: "2026-01-01T00:00:00.000Z" },
    ];

    const collections = await listWorkspaceCollections("owner-test");
    // Both independent occurrences must be preserved!
    expect(collections.operationJournal).toHaveLength(2);
    expect(collections.operationJournal[0].at).toBe("2026-01-01T00:00:00.000Z");
    expect(collections.operationJournal[1].at).toBe("2021-01-01T00:00:00.000Z");
  });

  it("12. does not merge entries that share the same id but have different content", async () => {
    (mockState.workspace.operationJournal as Array<Record<string, unknown>>) = [
      { id: "shared-id", action: "create", at: "2024-01-01T00:00:00.000Z" },
      { id: "shared-id", action: "delete", at: "2024-01-02T00:00:00.000Z" },
    ];
    mockState.v2Journal = [];

    const collections = await listWorkspaceCollections("owner-test");
    expect(collections.operationJournal).toHaveLength(2);
    expect(collections.operationJournal[0].action).toBe("delete");
    expect(collections.operationJournal[1].action).toBe("create");
  });

  it("13. does NOT unwrap a normal record that happens to have an archivedEntry property", async () => {
    // Normal user record with an archivedEntry property
    const normalRecord = {
      id: "normal-user-op-1",
      operation: "document.archive",
      at: "2024-03-01T00:00:00.000Z",
      archivedEntry: { note: "user data payload", count: 42 },
    };
    mockState.v2Journal = [normalRecord];
    (mockState.workspace.operationJournal as Array<Record<string, unknown>>) = [];

    const collections = await listWorkspaceCollections("owner-test");
    expect(collections.operationJournal).toHaveLength(1);
    const result = collections.operationJournal[0];
    // Outer fields MUST be preserved!
    expect(result.id).toBe("normal-user-op-1");
    expect(result.operation).toBe("document.archive");
    expect(result.archivedEntry).toEqual({ note: "user data payload", count: 42 });
  });

  it("14. correctly unwraps new format archive wrapper with discriminator", async () => {
    const newWrapper = {
      recordType: "formdigital.operation-journal-archive",
      schemaVersion: 1,
      id: "journal-archive-r2-i0-abcdef0123456789abcdef01",
      archivedAt: "2026-09-06T00:00:00.000Z",
      archivedEntry: {
        id: "real-inner-op",
        operation: "instance.create",
        at: "2023-01-01T00:00:00.000Z",
      },
    };
    mockState.v2Journal = [newWrapper];
    (mockState.workspace.operationJournal as Array<Record<string, unknown>>) = [];

    const collections = await listWorkspaceCollections("owner-test");
    expect(collections.operationJournal).toHaveLength(1);
    const result = collections.operationJournal[0];
    expect(result.id).toBe("real-inner-op");
    expect(result.operation).toBe("instance.create");
    expect(result.at).toBe("2023-01-01T00:00:00.000Z");
    expect(result).not.toHaveProperty("archivedEntry");
  });

  it("15. unwraps old format wrapper if matching strict legacy structure and id pattern", async () => {
    const legacyWrapper = {
      id: "journal-archive-r1-i5-1234567890abcdef12345678",
      archivedAt: "2026-09-01T00:00:00.000Z",
      archivedEntry: {
        id: "legacy-inner-op",
        operation: "template.update",
        at: "2022-05-01T00:00:00.000Z",
      },
    };
    mockState.v2Journal = [legacyWrapper];
    (mockState.workspace.operationJournal as Array<Record<string, unknown>>) = [];

    const collections = await listWorkspaceCollections("owner-test");
    expect(collections.operationJournal).toHaveLength(1);
    const result = collections.operationJournal[0];
    expect(result.id).toBe("legacy-inner-op");
    expect(result.operation).toBe("template.update");
  });

  it("16. retains wrapper with unsupported schemaVersion as normal record without unwrapping", async () => {
    const futureWrapper = {
      recordType: "formdigital.operation-journal-archive",
      schemaVersion: 99, // unsupported future schemaVersion
      id: "journal-archive-r1-i0-abcdef0123456789abcdef01",
      archivedAt: "2026-09-06T00:00:00.000Z",
      archivedEntry: {
        id: "future-op",
        operation: "future.action",
      },
    };
    mockState.v2Journal = [futureWrapper];
    (mockState.workspace.operationJournal as Array<Record<string, unknown>>) = [];

    const collections = await listWorkspaceCollections("owner-test");
    expect(collections.operationJournal).toHaveLength(1);
    // Preserved as regular record, outer recordType and schemaVersion kept
    expect(collections.operationJournal[0].recordType).toBe("formdigital.operation-journal-archive");
    expect(collections.operationJournal[0].schemaVersion).toBe(99);
  });

  it("17. safely handles Number.MAX_VALUE and -Number.MAX_VALUE without throwing RangeError", async () => {
    const { parseTimestampValue } = await import("./repository");
    expect(parseTimestampValue(Number.MAX_VALUE)).toBeNull();
    expect(parseTimestampValue(-Number.MAX_VALUE)).toBeNull();
    expect(parseTimestampValue("not-a-valid-date")).toBeNull();
    expect(parseTimestampValue("")).toBeNull();
    expect(parseTimestampValue("   ")).toBeNull();
    expect(parseTimestampValue(1700000000000)).toBe(1700000000000);
    expect(parseTimestampValue("1700000000000")).toBe(1700000000000);
    expect(parseTimestampValue("2024-01-01T00:00:00.000Z")).toBe(Date.parse("2024-01-01T00:00:00.000Z"));

    (mockState.workspace.operationJournal as Array<Record<string, unknown>>) = [
      { id: "max-val", operation: "max.at", at: Number.MAX_VALUE },
      { id: "min-val", operation: "min.at", at: -Number.MAX_VALUE },
      { id: "valid-op", operation: "valid.at", at: "2024-01-01T00:00:00.000Z" },
    ];
    mockState.v2Journal = [];

    // Must not throw RangeError: Invalid time value
    const collections = await listWorkspaceCollections("owner-test");
    expect(collections.operationJournal).toHaveLength(3);
    // Valid timestamp is newest, extreme values fallback safely to 0/epoch
    expect(collections.operationJournal[0].id).toBe("valid-op");
  });

  it("18. handles 100,000 synthetic journal records, returning top 100 newest without dropping newest", async () => {
    // Generate 100,000 synthetic records
    // Page size in queryLocalWorkspaceV2 mock is 1,000, so this spans 100 pages.
    // Make 50 newest records placed near the end of the 100,000 sequence,
    // and 50 newest records near the start, with 99,900 older records.
    const allRecords: Record<string, unknown>[] = [];
    for (let i = 0; i < 100_000; i++) {
      allRecords.push({
        id: `synth-old-${i}`,
        operation: `old.op.${i}`,
        at: 1000000000000 + (i % 10000), // old timestamp around 2001
      });
    }
    // Inject 100 truly latest records with 2026 timestamps
    for (let i = 0; i < 100; i++) {
      const targetIndex = i * 999;
      allRecords[targetIndex] = {
        id: `synth-latest-${i}`,
        operation: `latest.op.${i}`,
        at: 1780000000000 + i * 1000, // 2026 timestamp
      };
    }
    mockState.v2Journal = allRecords;
    (mockState.workspace.operationJournal as Array<Record<string, unknown>>) = [];

    const collections = await listWorkspaceCollections("owner-test");
    expect(collections.operationJournal).toHaveLength(100);
    // The top 100 MUST be the 100 latest injected records
    for (let i = 0; i < 100; i++) {
      expect(collections.operationJournal[i].id).toMatch(/^synth-latest-\d+$/);
    }
    // First element is synth-latest-99 (highest timestamp)
    expect(collections.operationJournal[0].id).toBe("synth-latest-99");
    // 100th element is synth-latest-0
    expect(collections.operationJournal[99].id).toBe("synth-latest-0");

    // CRITICAL: Verify candidate pool high-water mark stayed strictly bounded!
    const { getLastJournalCollectorHighWaterMark } = await import("./repository");
    expect(getLastJournalCollectorHighWaterMark()).toBeLessThanOrEqual(250);
  });

  it("19. stops and throws fixed error when duplicate pagination cursor is returned", async () => {
    // Return a repeating cursor to simulate infinite loop condition specifically on operationJournal
    let journalCallCount = 0;
    const originalQuery = (await import("./localServiceClient")).queryLocalWorkspaceV2;
    const defaultImpl = vi.mocked(originalQuery).getMockImplementation();
    try {
      vi.mocked(originalQuery).mockImplementation(async (_owner, input) => {
        if (input.collection === "operationJournal") {
          journalCallCount++;
          return {
            revision: 1,
            records: [{ id: `rec-${journalCallCount}`, at: 100 }],
            nextCursor: "loop-cursor", // always returns duplicate cursor!
          };
        }
        return { revision: 1, records: [], nextCursor: null };
      });

      await expect(listWorkspaceCollections("owner-test")).rejects.toThrow("OPERATION_JOURNAL_CURSOR_LOOP");
    } finally {
      if (defaultImpl) vi.mocked(originalQuery).mockImplementation(defaultImpl);
    }
  });

  it("20. stops and throws fixed error when revision changes during journal pagination", async () => {
    let journalCallCount = 0;
    const originalQuery = (await import("./localServiceClient")).queryLocalWorkspaceV2;
    const defaultImpl = vi.mocked(originalQuery).getMockImplementation();
    try {
      vi.mocked(originalQuery).mockImplementation(async (_owner, input) => {
        if (input.collection === "operationJournal" && input.where === undefined) {
          journalCallCount++;
          return {
            revision: journalCallCount, // page 1 revision 1, page 2 revision 2 -> drift!
            records: [{ id: `rec-${journalCallCount}`, at: 100 }],
            nextCursor: journalCallCount === 1 ? "next-page" : null,
          };
        }
        return { revision: 1, records: [], nextCursor: null };
      });

      await expect(listWorkspaceCollections("owner-test")).rejects.toThrow("OPERATION_JOURNAL_REVISION_DRIFT");
    } finally {
      if (defaultImpl) vi.mocked(originalQuery).mockImplementation(defaultImpl);
    }
  });

  it("21. ensures BoundedJournalCollector maintains strictly bounded stats on 100,000 records", async () => {
    const { getLastJournalCollectorStats } = await import("./repository");
    const allRecords: Record<string, unknown>[] = [];
    for (let i = 0; i < 100_000; i++) {
      allRecords.push({
        id: `large-text-rec-${i}`,
        operation: `op.${i}`,
        at: 1700000000000 + (i % 5000),
        detail: `This is a long description with redundant payload text to simulate heavy entries ${i}`.repeat(5),
      });
    }
    mockState.v2Journal = allRecords;
    (mockState.workspace.operationJournal as Array<Record<string, unknown>>) = [];

    const collections = await listWorkspaceCollections("owner-test");
    expect(collections.operationJournal).toHaveLength(100);

    const stats = getLastJournalCollectorStats();
    expect(stats).toBeDefined();
    expect(stats.candidateCount).toBeLessThanOrEqual(200);
    expect(stats.v1UnmatchedOccurrenceCount).toBeLessThanOrEqual(5_000);
    expect(stats.v1DigestCount).toBeLessThanOrEqual(5_000);
    expect(stats.logicalRetainedKeyBytes).toBeLessThanOrEqual(stats.v1DigestCount * 64);
    expect(stats.logicalRetainedCanonicalPayloadBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(stats.totalRetainedEntries).toBeLessThanOrEqual(5_200);
  });

  it("22. deterministically orders 10,000 records with identical timestamp across first, middle, and last pages matching independent code-unit oracle", async () => {
    // 10,000 records with identical timestamp
    const allRecords: Array<{ id: string; operation: string; at: number }> = [];
    for (let i = 0; i < 10_000; i++) {
      allRecords.push({
        id: `common-rec-${String(i).padStart(5, "0")}`,
        operation: `common.op`,
        at: 1700000000000,
      });
    }

    // Deliberately inject top priority IDs in first page (0..999), middle page (5000..5999), and last page (9000..9999)
    // Using high lexicographical code-unit prefix "z-target-"
    for (let i = 0; i < 35; i++) {
      allRecords[10 + i] = { id: `z-target-first-${String(i).padStart(3, "0")}`, operation: "target.op", at: 1700000000000 };
    }
    for (let i = 0; i < 35; i++) {
      allRecords[5000 + i] = { id: `z-target-mid-${String(i).padStart(3, "0")}`, operation: "target.op", at: 1700000000000 };
    }
    for (let i = 0; i < 35; i++) {
      allRecords[9900 + i] = { id: `z-target-last-${String(i).padStart(3, "0")}`, operation: "target.op", at: 1700000000000 };
    }

    mockState.v2Journal = allRecords;
    (mockState.workspace.operationJournal as Array<Record<string, unknown>>) = [];

    // Independent test oracle (does NOT call production compareCandidatesDescending to prevent tautology)
    const { canonicalJsonString } = await import("./repository");
    const { createHash } = await import("node:crypto");
    const oracleSorted = [...allRecords].sort((left, right) => {
      if (left.at !== right.at) return right.at - left.at;
      // In v2, identity is `v2:${recordId}`
      const leftId = `v2:${left.id}`;
      const rightId = `v2:${right.id}`;
      if (leftId !== rightId) return leftId > rightId ? -1 : 1;
      const leftDigest = createHash("sha256").update(canonicalJsonString(left)).digest("hex");
      const rightDigest = createHash("sha256").update(canonicalJsonString(right)).digest("hex");
      if (leftDigest !== rightDigest) return leftDigest > rightDigest ? -1 : 1;
      return 0;
    });
    const expectedTop100 = oracleSorted.slice(0, 100);

    const collections = await listWorkspaceCollections("owner-test");
    expect(collections.operationJournal).toHaveLength(100);

    for (let i = 0; i < 100; i++) {
      expect(collections.operationJournal[i].id).toBe(expectedTop100[i].id);
    }
  });

  it("23. preserves multiplicity when v1 has 3 occurrences and v2 legacy cutover has 2 occurrences", async () => {
    // Repeated entry with exact same content and timestamps
    const sharedEntry = {
      operation: "instance.save-data",
      at: 1700000000000,
      note: "identical content multiple occurrences",
    };

    // v1 has 3 occurrences
    (mockState.workspace.operationJournal as Array<Record<string, unknown>>) = [
      { ...sharedEntry },
      { ...sharedEntry },
      { ...sharedEntry },
    ];

    // v2 has 2 cutover occurrences with @legacy: record IDs
    mockState.v2Journal = [
      { ...sharedEntry, id: "@legacy:000000000001" },
      { ...sharedEntry, id: "@legacy:000000000002" },
    ];

    const collections = await listWorkspaceCollections("owner-test");
    // Exactly 3 occurrences must survive: 2 represented by v2, 1 from unmatched v1!
    expect(collections.operationJournal).toHaveLength(3);
    for (const item of collections.operationJournal) {
      expect(item.operation).toBe("instance.save-data");
      expect(item.at).toBe(1700000000000);
      expect(item.note).toBe("identical content multiple occurrences");
    }
  });

  // ---------------------------------------------------------------------
  // JRN-01: provenance-aware v1/v2 pairing.
  //
  // A v1 occurrence may only be consumed by a v2 item that carries reliable
  // cutover provenance: the storage-level record id must be exactly the id
  // that the legacy migration assigns to that specific v1 occurrence, and the
  // canonical payload must match. Neither the payload alone nor the id alone
  // is sufficient (DECISIONS D-004).
  // ---------------------------------------------------------------------

  it("24. does not let a native v2 record consume a v1 occurrence that merely has identical content", async () => {
    // A native v2 journal record (for example an asset-cleanup row) has its own
    // storage-level record id. Its payload can be byte-identical to an
    // independent v1 event without being a copy of it.
    const sharedEntry = {
      operation: "instance.save-data",
      at: 1700000000000,
      note: "independent occurrence",
    };

    (mockState.workspace.operationJournal as Array<Record<string, unknown>>) = [
      { ...sharedEntry },
    ];
    // recordId models the storage-level id; the payload deliberately carries no id.
    mockState.v2Journal = [{ ...sharedEntry, recordId: "journal-native-0001" }];

    const collections = await listWorkspaceCollections("owner-test");
    expect(collections.operationJournal).toHaveLength(2);
  });

  it("25. does not let an archive wrapper consume a v1 occurrence with identical content", async () => {
    // Archiving moves an old v1 entry into a wrapper. An independent v1
    // occurrence with the same content is a separate event and must survive.
    const sharedEntry = {
      operation: "instance.archived",
      at: 1700000000000,
      note: "archived and live copy",
    };

    (mockState.workspace.operationJournal as Array<Record<string, unknown>>) = [
      { ...sharedEntry },
    ];
    mockState.v2Journal = [
      {
        recordType: "formdigital.operation-journal-archive",
        schemaVersion: 1,
        id: "journal-archive-r1-i0-abcdef0123456789abcdef",
        archivedAt: "2026-09-05T00:00:00.000Z",
        archivedEntry: { ...sharedEntry },
      },
    ];

    const collections = await listWorkspaceCollections("owner-test");
    expect(collections.operationJournal).toHaveLength(2);
    for (const item of collections.operationJournal) {
      // The wrapper is still unwrapped for display; only the pairing is refused.
      expect(item.operation).toBe("instance.archived");
    }
  });

  it("26. does NOT treat an ordinary business id as cutover provenance (keeps both)", async () => {
    // D-004: a pre-existing business id is NOT a reliable cutover marker. A v1
    // record that carries its own id and a native v2 record that reuses the same
    // id with identical content are independent events and must both survive.
    const sharedEntry = {
      id: "journal-legacy-1",
      operation: "instance.save-data",
      at: 1700000000000,
    };

    (mockState.workspace.operationJournal as Array<Record<string, unknown>>) = [
      { ...sharedEntry },
    ];
    mockState.v2Journal = [{ ...sharedEntry }];

    const collections = await listWorkspaceCollections("owner-test");
    // Conservative: no verifiable migration marker => keep both, never delete a
    // legitimate event.
    expect(collections.operationJournal).toHaveLength(2);
  });

  it("27. keeps multiplicity with self-id migrated records and an unrelated native copy", async () => {
    // v1 has 3 identical occurrences (indices 0,1,2 => "@legacy:00000000000{0,1,2}").
    // v2 holds cutover copies of indices 1 and 2 plus one unrelated native record.
    const sharedEntry = {
      operation: "instance.save-data",
      at: 1700000000000,
      note: "multiplicity",
    };

    (mockState.workspace.operationJournal as Array<Record<string, unknown>>) = [
      { ...sharedEntry },
      { ...sharedEntry },
      { ...sharedEntry },
    ];
    mockState.v2Journal = [
      { ...sharedEntry, recordId: "@legacy:000000000001" },
      { ...sharedEntry, recordId: "@legacy:000000000002" },
      { ...sharedEntry, recordId: "journal-native-0009" },
    ];

    const collections = await listWorkspaceCollections("owner-test");
    // 3 v2 items survive (2 cutover + 1 native) plus the unmatched v1 index 0.
    expect(collections.operationJournal).toHaveLength(4);
  });

  it("28. keeps both records when a shared id carries different content", async () => {
    (mockState.workspace.operationJournal as Array<Record<string, unknown>>) = [
      { id: "journal-same", operation: "op.a", at: 1700000000000 },
    ];
    mockState.v2Journal = [
      { id: "journal-same", operation: "op.b", at: 1700000000000 },
    ];

    const collections = await listWorkspaceCollections("owner-test");
    expect(collections.operationJournal).toHaveLength(2);
    expect(collections.operationJournal.map(e => e.operation).sort()).toEqual(["op.a", "op.b"]);
  });

  it("29. keeps collector bounds intact under a mixed-provenance workload", async () => {
    // 6,000 v1 occurrences (beyond the 5,000 cap) plus 300 native v2 records.
    // No provenance pairing applies, so the collector must still stay bounded.
    const sharedEntry = { operation: "mixed.op", at: 1700000000000, note: "x" };
    (mockState.workspace.operationJournal as Array<Record<string, unknown>>) = Array.from(
      { length: 6_000 },
      () => ({ ...sharedEntry })
    );
    mockState.v2Journal = Array.from({ length: 300 }, (_, i) => ({
      ...sharedEntry,
      recordId: `journal-native-${String(i).padStart(4, "0")}`,
    }));

    await listWorkspaceCollections("owner-test");

    const { getLastJournalCollectorStats: readStats } = await import("./repository");
    const stats = readStats();
    expect(stats.candidateCount).toBeLessThanOrEqual(200);
    expect(stats.v1UnmatchedOccurrenceCount).toBeLessThanOrEqual(5_000);
    expect(stats.v1DigestCount).toBeLessThanOrEqual(5_000);
    expect(stats.logicalRetainedCanonicalPayloadBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(stats.totalRetainedEntries).toBeLessThanOrEqual(5_200);
  });

  // ---------------------------------------------------------------------
  // JRN-01 (sixth round): the five provenance cases the re-review demands.
  // Each is a lock against the buggy "ordinary id + identical payload => cutover
  // copy" inference (DECISIONS D-004). Case 1 was genuinely RED under round-5.
  // ---------------------------------------------------------------------

  it("30. [case 1] v1 with ordinary id + native v2 same id/payload => keep both", async () => {
    const entry = { id: "biz-1", operation: "instance.save-data", at: 1700000000000 };
    (mockState.workspace.operationJournal as Array<Record<string, unknown>>) = [{ ...entry }];
    mockState.v2Journal = [{ ...entry }];
    const collections = await listWorkspaceCollections("owner-test");
    expect(collections.operationJournal).toHaveLength(2);
  });

  it("31. [case 2] same id but different payload => keep both", async () => {
    (mockState.workspace.operationJournal as Array<Record<string, unknown>>) = [
      { id: "biz-2", operation: "op.a", at: 1700000000000 },
    ];
    mockState.v2Journal = [
      { id: "biz-2", operation: "op.b", at: 1700000000000 },
    ];
    const collections = await listWorkspaceCollections("owner-test");
    expect(collections.operationJournal).toHaveLength(2);
    expect(collections.operationJournal.map(e => e.operation).sort()).toEqual(["op.a", "op.b"]);
  });

  it("32. [case 3] v1 without id + real @legacy: cutover copy => shown once", async () => {
    const entry = { operation: "instance.save-data", at: 1700000000000 };
    (mockState.workspace.operationJournal as Array<Record<string, unknown>>) = [{ ...entry }];
    mockState.v2Journal = [{ ...entry, id: "@legacy:000000000000" }];
    const collections = await listWorkspaceCollections("owner-test");
    expect(collections.operationJournal).toHaveLength(1);
  });

  it("33. [case 4] archive wrapper + live v1 with same content => keep both", async () => {
    const entry = { operation: "instance.archived", at: 1700000000000 };
    (mockState.workspace.operationJournal as Array<Record<string, unknown>>) = [{ ...entry }];
    mockState.v2Journal = [{
      recordType: "formdigital.operation-journal-archive",
      schemaVersion: 1,
      id: "journal-archive-r1-i0-abcdef0123456789abcdef",
      archivedAt: "2026-09-05T00:00:00.000Z",
      archivedEntry: { ...entry },
    }];
    const collections = await listWorkspaceCollections("owner-test");
    expect(collections.operationJournal).toHaveLength(2);
  });

  it("34. [case 5] multiple identical legal occurrences are not swallowed", async () => {
    const entry = { operation: "instance.save-data", at: 1700000000000, note: "dup" };
    (mockState.workspace.operationJournal as Array<Record<string, unknown>>) = [
      { ...entry }, { ...entry }, { ...entry }, { ...entry },
    ];
    // No v2 cutover copies at all: every v1 occurrence must survive.
    mockState.v2Journal = [];
    const collections = await listWorkspaceCollections("owner-test");
    expect(collections.operationJournal).toHaveLength(4);
  });
});
