import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockState, MockLocalServiceRequestError, canonicalString } = vi.hoisted(() => {
  class MockLocalServiceRequestError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.name = "LocalServiceRequestError";
      this.status = status;
      this.code = code;
    }
  }
  // Deterministic canonical serialization used to model the real
  // WorkspaceStorageV2 request hash (sha256 over canonical JSON of
  // expectedRevision / transactionId / put / deleteIds / metaPatch).
  const canonicalString = (value: unknown): string => {
    if (value === undefined || value === null) return "null";
    if (typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalString).join(",")}]`;
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .map(key => `${JSON.stringify(key)}:${canonicalString((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  };
  return {
    MockLocalServiceRequestError,
    canonicalString,
    mockState: {
      revision: 1,
      workspace: {} as Record<string, unknown>,
      v2Revision: 1,
      v2Instances: [] as Array<Record<string, unknown>>,
      v2Puts: [] as Array<{ collection: string; record: Record<string, unknown> }>,
      // Real v2 idempotency: transactionId -> applied request hash / result.
      appliedTransactions: new Map<string, {
        requestHash: string;
        baseRevision: number;
        resultRevision: number;
        operationCount: number;
      }>(),
      // Every transport attempt, in order, with its byte-canonical request.
      transportCalls: [] as Array<{
        transactionId: string;
        expectedRevision: number | undefined;
        requestHash: string;
        canonicalRequest: string;
        idempotentReplay: boolean;
      }>,
      // { mode: "afterCommit" | "beforeCommit", remaining: number }
      transportFault: null as null | { mode: "afterCommit" | "beforeCommit"; remaining: number },
      // Business (non-conflict) LocalService error injected once.
      businessFault: null as null | { status: number; code: string; message: string },
    },
  };
});

vi.mock("./localServiceClient", () => {
  return {
    LocalServiceRequestError: MockLocalServiceRequestError,
    loadLocalWorkspace: vi.fn(async () => ({
      revision: mockState.revision,
      workspace: structuredClone(mockState.workspace),
    })),
    saveLocalWorkspace: vi.fn(async (_owner: string, workspace: unknown) => {
      mockState.revision += 1;
      mockState.workspace = structuredClone(workspace) as Record<string, unknown>;
      return { revision: mockState.revision, workspace };
    }),
    describeLocalWorkspaceV2: vi.fn(async () => ({
      storageSchemaVersion: 2,
      schemaVersion: 2,
      revision: mockState.v2Revision,
    })),
    queryManyLocalWorkspaceV2: vi.fn(async (_owner: string, input: { collection: string; values: string[] }) => ({
      revision: mockState.v2Revision,
      records: input.collection === "instances"
        ? structuredClone(mockState.v2Instances.filter(r => input.values.includes(String(r.id))))
        : [],
    })),
    queryLocalWorkspaceV2: vi.fn(async (_owner: string, input: { collection: string; where?: { id?: string; templateVersionId?: string } }) => ({
      revision: mockState.v2Revision,
      records: input.collection === "instances"
        ? structuredClone(mockState.v2Instances.filter(r =>
          (!input.where?.id || r.id === input.where.id) &&
          (!input.where?.templateVersionId || r.templateVersionId === input.where.templateVersionId)
        ))
        : [],
      nextCursor: null,
    })),
    transactLocalWorkspaceV2: vi.fn(async (_owner: string, input: {
      expectedRevision?: number;
      transactionId?: string;
      put?: Array<{ collection: string; record: Record<string, unknown> }>;
      deleteIds?: Array<{ collection: string; ids: string[] }>;
      metaPatch?: Record<string, unknown>;
    }) => {
      const transactionId = String(input.transactionId ?? "");
      const canonicalRequest = canonicalString({
        expectedRevision: input.expectedRevision,
        transactionId,
        put: input.put ?? [],
        deleteIds: input.deleteIds ?? [],
        metaPatch: input.metaPatch ?? {},
      });
      let requestHash = "";
      {
        // Simple deterministic stand-in for sha256 over the canonical request.
        let h1 = 0x811c9dc5;
        let h2 = 0x01000193;
        for (let i = 0; i < canonicalRequest.length; i += 1) {
          const code = canonicalRequest.charCodeAt(i);
          h1 = (h1 ^ code) >>> 0;
          h1 = Math.imul(h1, 16777619) >>> 0;
          h2 = (h2 + Math.imul(code + i, 2654435761)) >>> 0;
        }
        requestHash = `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
      }

      const prior = mockState.appliedTransactions.get(transactionId);
      mockState.transportCalls.push({
        transactionId,
        expectedRevision: input.expectedRevision,
        requestHash,
        canonicalRequest,
        idempotentReplay: Boolean(prior),
      });

      if (mockState.businessFault) {
        const fault = mockState.businessFault;
        mockState.businessFault = null;
        throw new MockLocalServiceRequestError(fault.status, fault.code, fault.message);
      }

      // Real v2 semantics: replay of an already-applied transactionId returns the
      // recorded result when the request is byte-identical, and fails with
      // TRANSACTION_ID_REUSE when it is not. This happens BEFORE the revision check.
      if (prior) {
        if (prior.requestHash !== requestHash) {
          throw new MockLocalServiceRequestError(
            422, "workspace_v2_request_rejected", "Workspace v2 request was rejected."
          );
        }
        return {
          baseRevision: prior.baseRevision,
          revision: prior.resultRevision,
          operationCount: prior.operationCount,
          idempotent: true,
        };
      }

      if (input.expectedRevision !== undefined && input.expectedRevision !== mockState.v2Revision) {
        throw new MockLocalServiceRequestError(409, "workspace_v2_revision_conflict", "Workspace v2 revision conflict");
      }

      // Transport fault BEFORE the mutation is applied: the transaction truly
      // did not happen, a byte-identical replay must apply it exactly once.
      if (mockState.transportFault?.mode === "beforeCommit") {
        mockState.transportFault.remaining -= 1;
        if (mockState.transportFault.remaining <= 0) mockState.transportFault = null;
        throw new Error("fetch failed: socket hang up");
      }

      const baseRevision = mockState.v2Revision;
      mockState.v2Revision += 1;
      let operationCount = 0;
      if (input.put) {
        for (const item of input.put) {
          if (item.collection === "instances") {
            const idx = mockState.v2Instances.findIndex(i => i.id === item.record.id);
            if (idx >= 0) {
              mockState.v2Instances[idx] = structuredClone(item.record);
            } else {
              mockState.v2Instances.push(structuredClone(item.record));
            }
          }
          mockState.v2Puts.push(structuredClone(item));
          operationCount += 1;
        }
      }
      if (input.deleteIds) {
        for (const group of input.deleteIds) {
          if (group.collection === "instances") {
            mockState.v2Instances = mockState.v2Instances.filter(i => !group.ids.includes(String(i.id)));
          }
          operationCount += group.ids.length;
        }
      }
      if (input.metaPatch) operationCount += Object.keys(input.metaPatch).length;
      const resultRevision = mockState.v2Revision;
      mockState.appliedTransactions.set(transactionId, {
        requestHash, baseRevision, resultRevision, operationCount,
      });

      // Transport fault AFTER commit: the mutation is durable but the caller
      // never sees the response. Only a byte-identical replay can resolve it.
      if (mockState.transportFault?.mode === "afterCommit") {
        mockState.transportFault.remaining -= 1;
        if (mockState.transportFault.remaining <= 0) mockState.transportFault = null;
        throw new Error("fetch failed: connection reset by peer");
      }

      return {
        baseRevision,
        revision: resultRevision,
        operationCount,
        idempotent: false,
      };
    }),
  };
});

import {
  publishTemplateVersion,
  createInstanceFromPublishedVersion,
  saveInstanceValues,
  updateInstanceStatus,
  recordInstanceOutput,
  confirmInstanceOutputChecked,
  hasReviewedOutputForVersion,
  cloneInstanceForOwner,
  migrateInstancesForOwner,
} from "./repository";
import { translateServerMessage } from "../../client/src/lib/server-messages";

function makeWorkflowInstance(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    ownerId: "owner-1",
    templateId: "tpl-1",
    templateVersionId: "ver-pub",
    templateVersionHash: "hash-pub",
    schemaVersion: 2,
    name: `Instance ${id}`,
    status: "draft",
    values: { table_field: JSON.stringify([["10", "20", ""], ["", "", ""]]) },
    valuesHash: `hash-${id}`,
    printCount: 0,
    createdAt: 1000,
    updatedAt: 1000,
    completedAt: null,
    lastPrintedAt: null,
    outputHistory: [],
    ...overrides,
  };
}

describe("table workflow server contracts (P1-B, P1-C)", () => {
  beforeEach(() => {
    mockState.revision = 1;
    mockState.v2Revision = 1;
    mockState.v2Instances = [];
    mockState.v2Puts = [];
    mockState.appliedTransactions.clear();
    mockState.transportCalls = [];
    mockState.transportFault = null;
    mockState.businessFault = null;
    mockState.workspace = {
      schemaVersion: 2,
      ownerKey: "owner-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      templates: [
        {
          id: "tpl-1",
          name: "Finance Template",
          currentDraftVersionId: "ver-draft",
          currentPublishedVersionId: null,
          lifecycle: "draft",
        },
      ],
      templateVersions: [
        {
          id: "ver-draft",
          templateId: "tpl-1",
          versionNumber: 1,
          state: "draft",
          pageManifest: [{ page: 1, widthMm: 210, heightMm: 297 }],
        },
        {
          id: "ver-pub",
          templateId: "tpl-1",
          versionNumber: 1,
          state: "published",
          contentHash: "hash-pub",
          pageManifest: [{ page: 1, widthMm: 210, heightMm: 297 }],
        },
      ],
      fields: [
        {
          id: "fld-1",
          templateVersionId: "ver-pub",
          stableFieldId: "table_field",
          fieldType: "table",
          displayOrder: 0,
          definition: {
            label: "Finance Table",
            confirmed: true,
            tableColumns: 3,
            maxRows: 2,
            tableWritableCells: [{ row: 0, column: 0 }, { row: 0, column: 1 }],
            tableFormulaCells: [{ row: 0, column: 2, expression: "A/B", decimalPlaces: 2 }],
          },
          coordinate: { page: 1, xMm: 10, yMm: 10, widthMm: 80, heightMm: 20 },
        },
      ],
      instances: [],
    };
  });

  describe("final workflow step records a reviewed output", () => {
    it("refuses confirmation until the same Instance has a real output asset", async () => {
      mockState.v2Instances.push(makeWorkflowInstance("ins-review-empty"));
      expect(await hasReviewedOutputForVersion("owner-1", "ver-pub")).toBe(false);
      await expect(
        confirmInstanceOutputChecked("owner-1", "ins-review-empty", "asset-not-created")
      ).rejects.toThrow();
      expect(mockState.v2Instances[0]?.outputHistory).toEqual([]);
    });

    it("persists an explicit check on the matching output and is repeat-safe", async () => {
      mockState.v2Instances.push(makeWorkflowInstance("ins-review"));
      await recordInstanceOutput("owner-1", "ins-review", { assetId: "asset-reviewed", mode: "full" });
      expect(await hasReviewedOutputForVersion("owner-1", "ver-pub")).toBe(false);
      await expect(
        confirmInstanceOutputChecked("owner-1", "ins-review", "asset-unrelated")
      ).rejects.toThrow();

      const checked = await confirmInstanceOutputChecked("owner-1", "ins-review", "asset-reviewed");
      const event = checked.outputHistory[0] as Record<string, unknown>;
      expect(event.assetId).toBe("asset-reviewed");
      expect(event.checkedAt).toEqual(expect.any(Number));
      expect(checked.printCount).toBe(0);
      expect(checked.status).toBe("draft");
      expect(await hasReviewedOutputForVersion("owner-1", "ver-pub")).toBe(true);
      expect(await hasReviewedOutputForVersion("owner-1", "ver-draft")).toBe(false);

      const revision = mockState.v2Revision;
      await confirmInstanceOutputChecked("owner-1", "ins-review", "asset-reviewed");
      expect(mockState.v2Revision).toBe(revision);
    });
  });

  it("server publishTemplateVersion fails closed when formula expression is empty (P1-B)", async () => {
    const ws = mockState.workspace as any;
    ws.fields = [
      {
        id: "fld-draft",
        templateVersionId: "ver-draft",
        stableFieldId: "table_draft",
        fieldType: "table",
        displayOrder: 0,
        definition: {
          label: "Draft Table",
          confirmed: true,
          tableColumns: 3,
          maxRows: 2,
          tableFormulaCells: [{ row: 0, column: 1, expression: "" }],
        },
        coordinate: { page: 1, xMm: 10, yMm: 10, widthMm: 80, heightMm: 20 },
      },
    ];

    await expect(publishTemplateVersion("owner-1", "ver-draft")).rejects.toThrow(/公式不可為空/);
  });

  it("createInstanceFromPublishedVersion strips fixed and formula fake residuals into raw authority (P1-C)", async () => {
    const rawInputValues = {
      table_field: JSON.stringify([
        ["100", "50", "FAKE_FORMULA_RESIDUAL"],
        ["FAKE_FIXED_RESIDUAL", "FAKE_FIXED_RESIDUAL", "FAKE_FIXED_RESIDUAL"],
      ]),
    };

    const { instanceId } = await createInstanceFromPublishedVersion("owner-1", {
      templateVersionId: "ver-pub",
      name: "Test Instance",
      values: rawInputValues,
    });

    const savedInstance = mockState.v2Instances.find(i => i.id === instanceId);
    expect(savedInstance).toBeTruthy();
    const parsedStored = JSON.parse(savedInstance!.values.table_field);
    // Writable cells are preserved
    expect(parsedStored[0][0]).toBe("100");
    expect(parsedStored[0][1]).toBe("50");
    // Formula cell in row 0 col 2 is stored as empty string
    expect(parsedStored[0][2]).toBe("");
    // Fixed cells in row 1 are stored as empty string
    expect(parsedStored[1][0]).toBe("");
    expect(parsedStored[1][1]).toBe("");
    expect(parsedStored[1][2]).toBe("");
  });

  it("updateInstanceStatus refuses to mark instance completed or printed when formula has calculation error (P1-C)", async () => {
    // Instance with A=10, B=0, formula A/B (division by zero)
    const instanceRecord = {
      id: "ins-divzero",
      ownerId: "owner-1",
      templateId: "tpl-1",
      templateVersionId: "ver-pub",
      templateVersionHash: "hash-pub",
      schemaVersion: 2,
      name: "Div Zero Instance",
      status: "draft",
      values: {
        table_field: JSON.stringify([
          ["10", "0", ""],
          ["", "", ""],
        ]),
      },
      valuesHash: "hash-divzero",
      printCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      completedAt: null,
      lastPrintedAt: null,
      outputHistory: [],
    };
    mockState.v2Instances.push(instanceRecord);

    await expect(updateInstanceStatus("owner-1", "ins-divzero", "completed")).rejects.toThrow(/驗證錯誤/);
    // Status must remain draft
    const current = mockState.v2Instances.find(i => i.id === "ins-divzero");
    expect(current!.status).toBe("draft");
  });

  it("updateInstanceStatus refuses to mark instance printed when formula has calculation error (P1-B)", async () => {
    const instanceRecord = {
      id: "ins-divzero-printed",
      ownerId: "owner-1",
      templateId: "tpl-1",
      templateVersionId: "ver-pub",
      templateVersionHash: "hash-pub",
      schemaVersion: 2,
      name: "Div Zero Instance Printed",
      status: "draft",
      values: {
        table_field: JSON.stringify([
          ["10", "0", ""],
          ["", "", ""],
        ]),
      },
      valuesHash: "hash-divzero-printed",
      printCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      completedAt: null,
      lastPrintedAt: null,
      outputHistory: [],
    };
    mockState.v2Instances.push(instanceRecord);

    await expect(updateInstanceStatus("owner-1", "ins-divzero-printed", "printed")).rejects.toThrow(/驗證錯誤/);
    const current = mockState.v2Instances.find(i => i.id === "ins-divzero-printed");
    expect(current!.status).toBe("draft");
  });

  it("recordInstanceOutput with printed=true refuses to update status or history when formula has calculation error (P1-B)", async () => {
    const instanceRecord = {
      id: "ins-record-divzero",
      ownerId: "owner-1",
      templateId: "tpl-1",
      templateVersionId: "ver-pub",
      templateVersionHash: "hash-pub",
      schemaVersion: 2,
      name: "Div Zero Record Output",
      status: "draft",
      values: {
        table_field: JSON.stringify([
          ["10", "0", ""],
          ["", "", ""],
        ]),
      },
      valuesHash: "hash-record-divzero",
      printCount: 0,
      createdAt: 1000,
      updatedAt: 1000,
      completedAt: null,
      lastPrintedAt: null,
      outputHistory: [],
    };
    mockState.v2Instances.push(instanceRecord);

    await expect(
      recordInstanceOutput("owner-1", "ins-record-divzero", { assetId: "ast-1", mode: "print" }, true)
    ).rejects.toThrow(/驗證錯誤/);

    const current = mockState.v2Instances.find(i => i.id === "ins-record-divzero");
    expect(current!.status).toBe("draft");
    expect(current!.printCount).toBe(0);
    expect(current!.lastPrintedAt).toBeNull();
    expect(current!.outputHistory).toEqual([]);
    expect(current!.updatedAt).toBe(1000);
  });

  it("cloneInstanceForOwner normalizes table field values into raw authority (P1-C)", async () => {
    const sourceInstance = {
      id: "ins-clone-source",
      ownerId: "owner-1",
      templateId: "tpl-1",
      templateVersionId: "ver-pub",
      templateVersionHash: "hash-pub",
      schemaVersion: 2,
      name: "Source Instance",
      status: "draft",
      values: {
        table_field: JSON.stringify([
          ["100", "50", "FAKE_FORMULA_RESIDUAL"],
          ["FAKE_FIXED_RESIDUAL", "FAKE_FIXED_RESIDUAL", "FAKE_FIXED_RESIDUAL"],
        ]),
      },
      valuesHash: "hash-clone-source",
      printCount: 0,
      createdAt: 1000,
      updatedAt: 1000,
      completedAt: null,
      lastPrintedAt: null,
      outputHistory: [],
    };
    mockState.v2Instances.push(sourceInstance);

    const { instanceId } = await cloneInstanceForOwner("owner-1", "ins-clone-source", false);
    const cloned = mockState.v2Instances.find(i => i.id === instanceId);
    expect(cloned).toBeTruthy();
    const parsed = JSON.parse(cloned!.values.table_field);
    expect(parsed[0][0]).toBe("100");
    expect(parsed[0][1]).toBe("50");
    expect(parsed[0][2]).toBe(""); // Formula stripped
    expect(parsed[1][0]).toBe(""); // Fixed stripped
    expect(parsed[1][1]).toBe("");
    expect(parsed[1][2]).toBe("");
  });

  it("migrateInstancesForOwner normalizes table field values into raw authority (P1-C)", async () => {
    const ws = mockState.workspace as any;
    ws.templateVersions.push({
      id: "ver-pub2",
      templateId: "tpl-1",
      versionNumber: 2,
      state: "published",
      contentHash: "hash-pub2",
      pageManifest: [{ page: 1, widthMm: 210, heightMm: 297 }],
    });
    ws.fields.push({
      id: "fld-target",
      templateVersionId: "ver-pub2",
      stableFieldId: "table_target",
      fieldType: "table",
      displayOrder: 0,
      definition: {
        label: "Target Table",
        confirmed: true,
        tableColumns: 3,
        maxRows: 2,
        tableWritableCells: [{ row: 0, column: 0 }, { row: 0, column: 1 }],
        tableFormulaCells: [{ row: 0, column: 2, expression: "A+B", decimalPlaces: 2 }],
      },
      coordinate: { page: 1, xMm: 10, yMm: 10, widthMm: 80, heightMm: 20 },
    });

    const sourceInstance = {
      id: "ins-migrate-src",
      ownerId: "owner-1",
      templateId: "tpl-1",
      templateVersionId: "ver-pub",
      templateVersionHash: "hash-pub",
      schemaVersion: 2,
      name: "Migrate Source",
      status: "draft",
      values: {
        table_field: JSON.stringify([
          ["200", "100", "STALE_FORMULA"],
          ["STALE_FIXED", "STALE_FIXED", "STALE_FIXED"],
        ]),
      },
      valuesHash: "hash-migrate-src",
      printCount: 0,
      createdAt: 1000,
      updatedAt: 1000,
      completedAt: null,
      lastPrintedAt: null,
      outputHistory: [],
    };
    mockState.v2Instances.push(sourceInstance);

    const result = await migrateInstancesForOwner("owner-1", {
      instanceIds: ["ins-migrate-src"],
      targetVersionId: "ver-pub2",
      mapping: { table_field: "table_target" },
      deleteOriginals: false,
    });
    expect(result.created).toBe(1);
    const migrated = mockState.v2Instances.find(i => i.templateVersionId === "ver-pub2");
    expect(migrated).toBeTruthy();
    const parsed = JSON.parse(migrated!.values.table_target);
    expect(parsed[0][0]).toBe("200");
    expect(parsed[0][1]).toBe("100");
    expect(parsed[0][2]).toBe("");
    expect(parsed[1][0]).toBe("");
    expect(parsed[1][1]).toBe("");
    expect(parsed[1][2]).toBe("");
  });

  describe("R4-P2: structural table check fails closed before normalization across formal repository paths", () => {
    it("createInstanceFromPublishedVersion rejects malformed table row and does not add instance to v2", async () => {
      const v2CountBefore = mockState.v2Instances.length;
      await expect(
        createInstanceFromPublishedVersion("owner-1", {
          templateVersionId: "ver-pub",
          name: "Malformed Table Instance",
          values: {
            table_field: "[{},[\"x\",{}]]",
          },
        })
      ).rejects.toThrow(/表格/);
      expect(mockState.v2Instances.length).toBe(v2CountBefore);
    });

    it("saveInstanceValues rejects malformed table row and leaves existing instance byte-for-byte unchanged", async () => {
      const existingInstance = {
        id: "ins-save-target",
        ownerId: "owner-1",
        templateId: "tpl-1",
        templateVersionId: "ver-pub",
        templateVersionHash: "hash-pub",
        schemaVersion: 2,
        name: "Safe Instance",
        status: "draft",
        values: { table_field: JSON.stringify([["10", "20", ""]]) },
        valuesHash: "hash-safe",
        printCount: 0,
        createdAt: 1000,
        updatedAt: 1000,
        completedAt: null,
        lastPrintedAt: null,
        outputHistory: [],
      };
      mockState.v2Instances.push(existingInstance);
      const snapshotBefore = structuredClone(existingInstance);

      await expect(
        saveInstanceValues("owner-1", "ins-save-target", {
          table_field: "[{},[\"x\",{}]]",
        })
      ).rejects.toThrow(/表格/);

      const instanceAfter = mockState.v2Instances.find(i => i.id === "ins-save-target");
      expect(instanceAfter).toEqual(snapshotBefore);
    });

    it("cloneInstanceForOwner rejects when source instance has malformed table", async () => {
      const corruptedSource = {
        id: "ins-corrupt-clone-src",
        ownerId: "owner-1",
        templateId: "tpl-1",
        templateVersionId: "ver-pub",
        templateVersionHash: "hash-pub",
        schemaVersion: 2,
        name: "Corrupted Source",
        status: "draft",
        values: { table_field: "[{},[\"x\",{}]]" },
        valuesHash: "hash-corrupt",
        printCount: 0,
        createdAt: 1000,
        updatedAt: 1000,
        completedAt: null,
        lastPrintedAt: null,
        outputHistory: [],
      };
      mockState.v2Instances.push(corruptedSource);
      const v2CountBefore = mockState.v2Instances.length;

      await expect(
        cloneInstanceForOwner("owner-1", "ins-corrupt-clone-src")
      ).rejects.toThrow(/表格/);

      expect(mockState.v2Instances.length).toBe(v2CountBefore);
    });

    it("migrateInstancesForOwner rejects when mapped value has malformed table", async () => {
      const ws = mockState.workspace as any;
      ws.templateVersions.push({
        id: "ver-pub2",
        templateId: "tpl-1",
        versionNumber: 2,
        state: "published",
        contentHash: "hash-pub2",
        pageManifest: [{ page: 1, widthMm: 210, heightMm: 297 }],
      });
      ws.fields.push({
        id: "fld-target",
        templateVersionId: "ver-pub2",
        stableFieldId: "table_target",
        fieldType: "table",
        displayOrder: 0,
        definition: {
          label: "Target Table",
          confirmed: true,
          tableColumns: 3,
          maxRows: 2,
          tableWritableCells: [{ row: 0, column: 0 }, { row: 0, column: 1 }],
          tableFormulaCells: [{ row: 0, column: 2, expression: "A+B", decimalPlaces: 2 }],
        },
        coordinate: { page: 1, xMm: 10, yMm: 10, widthMm: 80, heightMm: 20 },
      });

      const corruptedSource = {
        id: "ins-corrupt-migrate-src",
        ownerId: "owner-1",
        templateId: "tpl-1",
        templateVersionId: "ver-pub",
        templateVersionHash: "hash-pub",
        schemaVersion: 2,
        name: "Corrupted Source",
        status: "draft",
        values: { table_field: "[{},[\"x\",{}]]" },
        valuesHash: "hash-corrupt-mig",
        printCount: 0,
        createdAt: 1000,
        updatedAt: 1000,
        completedAt: null,
        lastPrintedAt: null,
        outputHistory: [],
      };
      mockState.v2Instances.push(corruptedSource);
      const v2CountBefore = mockState.v2Instances.length;

      await expect(
        migrateInstancesForOwner("owner-1", {
          instanceIds: ["ins-corrupt-migrate-src"],
          targetVersionId: "ver-pub2",
          mapping: { table_field: "table_target" },
          deleteOriginals: false,
        })
      ).rejects.toThrow(/表格/);

      expect(mockState.v2Instances.length).toBe(v2CountBefore);
    });
  });

  describe("R4-P5: eliminate status/printed stale-read lost-update race condition", () => {
    it("updateInstanceStatus retries on revision conflict after concurrent save and preserves new values", async () => {
      const initialInstance = {
        id: "ins-concur-status",
        ownerId: "owner-1",
        templateId: "tpl-1",
        templateVersionId: "ver-pub",
        templateVersionHash: "hash-pub",
        schemaVersion: 2,
        name: "Concurrent Status Instance",
        status: "draft",
        values: { table_field: JSON.stringify([["10", "20", ""], ["", "", ""]]) },
        valuesHash: "hash-initial",
        printCount: 0,
        createdAt: 1000,
        updatedAt: 1000,
        completedAt: null,
        lastPrintedAt: null,
        outputHistory: [],
      };
      mockState.v2Instances.push(initialInstance);

      // We hook queryLocalWorkspaceV2 so that on the first call, after the query returns,
      // a concurrent save commits and bumps v2Revision and updates instance values!
      const originalQuery = (await import("./localServiceClient")).queryLocalWorkspaceV2 as any;
      let hookTriggered = false;
      originalQuery.mockImplementationOnce(async (owner: string, input: any) => {
        const queryRes = {
          revision: mockState.v2Revision,
          records: structuredClone(mockState.v2Instances.filter(r => r.id === "ins-concur-status")),
          nextCursor: null,
        };
        if (!hookTriggered) {
          hookTriggered = true;
          // Concurrent save occurs before status transaction!
          const target = mockState.v2Instances.find(i => i.id === "ins-concur-status")!;
          target.values = { table_field: JSON.stringify([["30", "40", ""], ["", "", ""]]) };
          target.valuesHash = "hash-concurrent-saved";
          target.updatedAt = 2000;
          mockState.v2Revision += 1; // revision bump causes expectedRevision mismatch!
        }
        return queryRes;
      });

      const updated = await updateInstanceStatus("owner-1", "ins-concur-status", "completed");
      expect(hookTriggered).toBe(true);
      expect(updated.status).toBe("completed");

      // Verify final stored instance preserved the NEW values and hash, NOT the old values!
      const stored = mockState.v2Instances.find(i => i.id === "ins-concur-status")!;
      expect(stored.status).toBe("completed");
      expect(stored.values.table_field).toBe(JSON.stringify([["30", "40", ""], ["", "", ""]]));
      expect(stored.valuesHash).toBe("hash-concurrent-saved");
    });

    it("recordInstanceOutput re-validates on retry and rejects when concurrent save made formula invalid", async () => {
      const initialInstance = {
        id: "ins-concur-invalid",
        ownerId: "owner-1",
        templateId: "tpl-1",
        templateVersionId: "ver-pub",
        templateVersionHash: "hash-pub",
        schemaVersion: 2,
        name: "Concurrent Invalid Formula Instance",
        status: "draft",
        // Valid inputs: A=10, B=20 -> A/B is valid
        values: { table_field: JSON.stringify([["10", "20", ""], ["", "", ""]]) },
        valuesHash: "hash-valid-initial",
        printCount: 0,
        createdAt: 1000,
        updatedAt: 1000,
        completedAt: null,
        lastPrintedAt: null,
        outputHistory: [],
      };
      mockState.v2Instances.push(initialInstance);

      // In the concurrent save, B is changed to "0", causing division by zero (A/B)
      const originalQuery = (await import("./localServiceClient")).queryLocalWorkspaceV2 as any;
      let hookTriggered = false;
      originalQuery.mockImplementationOnce(async (owner: string, input: any) => {
        const queryRes = {
          revision: mockState.v2Revision,
          records: structuredClone(mockState.v2Instances.filter(r => r.id === "ins-concur-invalid")),
          nextCursor: null,
        };
        if (!hookTriggered) {
          hookTriggered = true;
          // Concurrent save makes B=0, which causes formula A/B division by zero error!
          const target = mockState.v2Instances.find(i => i.id === "ins-concur-invalid")!;
          target.values = { table_field: JSON.stringify([["10", "0", ""], ["", "", ""]]) };
          target.valuesHash = "hash-div-zero";
          target.updatedAt = 2000;
          mockState.v2Revision += 1;
        }
        return queryRes;
      });

      // Attempt to record printed output -> must fail closed on retry re-validation!
      await expect(
        recordInstanceOutput("owner-1", "ins-concur-invalid", { assetId: "asset-pdf-1" }, true)
      ).rejects.toThrow(/無法將狀態更新為 printed/);

      // Verify the concurrent new draft values remain intact in database!
      const stored = mockState.v2Instances.find(i => i.id === "ins-concur-invalid")!;
      expect(stored.status).toBe("draft");
      expect(stored.values.table_field).toBe(JSON.stringify([["10", "0", ""], ["", "", ""]]));
      expect(stored.printCount).toBe(0);
      expect(stored.outputHistory).toEqual([]);
    });

    it("recordInstanceOutput deduplicates outputHistory during concurrent output append", async () => {
      const initialInstance = {
        id: "ins-concur-history",
        ownerId: "owner-1",
        templateId: "tpl-1",
        templateVersionId: "ver-pub",
        templateVersionHash: "hash-pub",
        schemaVersion: 2,
        name: "Concurrent History Instance",
        status: "draft",
        values: { table_field: JSON.stringify([["10", "20", ""], ["", "", ""]]) },
        valuesHash: "hash-valid-h",
        printCount: 0,
        createdAt: 1000,
        updatedAt: 1000,
        completedAt: null,
        lastPrintedAt: null,
        outputHistory: [],
      };
      mockState.v2Instances.push(initialInstance);

      // Concurrent operation appends output-other
      const originalQuery = (await import("./localServiceClient")).queryLocalWorkspaceV2 as any;
      let hookTriggered = false;
      originalQuery.mockImplementationOnce(async (owner: string, input: any) => {
        const queryRes = {
          revision: mockState.v2Revision,
          records: structuredClone(mockState.v2Instances.filter(r => r.id === "ins-concur-history")),
          nextCursor: null,
        };
        if (!hookTriggered) {
          hookTriggered = true;
          const target = mockState.v2Instances.find(i => i.id === "ins-concur-history")!;
          target.outputHistory = [{ assetId: "asset-other", mode: "full" }];
          mockState.v2Revision += 1;
        }
        return queryRes;
      });

      const updated = await recordInstanceOutput(
        "owner-1",
        "ins-concur-history",
        { assetId: "asset-mine", mode: "full" },
        false
      );
      expect(hookTriggered).toBe(true);
      expect(updated.outputHistory).toHaveLength(2);
      expect(updated.outputHistory.map((h: any) => h.assetId)).toEqual(["asset-other", "asset-mine"]);

      const stored = mockState.v2Instances.find(i => i.id === "ins-concur-history")!;
      expect(stored.outputHistory).toHaveLength(2);
    });

    it("saveInstanceValues retries on revision conflict and commits with updated revision", async () => {
      const initialInstance = {
        id: "ins-concur-save",
        ownerId: "owner-1",
        templateId: "tpl-1",
        templateVersionId: "ver-pub",
        templateVersionHash: "hash-pub",
        schemaVersion: 2,
        name: "Concurrent Save Instance",
        status: "draft",
        values: { table_field: JSON.stringify([["1", "2", ""], ["", "", ""]]) },
        valuesHash: "hash-s1",
        printCount: 0,
        createdAt: 1000,
        updatedAt: 1000,
        completedAt: null,
        lastPrintedAt: null,
        outputHistory: [],
      };
      mockState.v2Instances.push(initialInstance);

      const originalQuery = (await import("./localServiceClient")).queryLocalWorkspaceV2 as any;
      let hookTriggered = false;
      originalQuery.mockImplementationOnce(async (owner: string, input: any) => {
        const queryRes = {
          revision: mockState.v2Revision,
          records: structuredClone(mockState.v2Instances.filter(r => r.id === "ins-concur-save")),
          nextCursor: null,
        };
        if (!hookTriggered) {
          hookTriggered = true;
          // Concurrent transaction bumps revision
          mockState.v2Revision += 1;
        }
        return queryRes;
      });

      const res = await saveInstanceValues("owner-1", "ins-concur-save", {
        table_field: JSON.stringify([["50", "60", ""], ["", "", ""]]),
      });
      expect(hookTriggered).toBe(true);
      expect(res.instanceId).toBe("ins-concur-save");

      const stored = mockState.v2Instances.find(i => i.id === "ins-concur-save")!;
      expect(stored.values.table_field).toBe(JSON.stringify([["50", "60", ""], ["", "", ""]]));
    });
  });

  describe("R5-P1: restore byte-identical idempotent retry for transport ambiguity", () => {
    it("replays byte-identically when the transaction was committed before the response was lost", async () => {
      mockState.v2Instances.push(makeWorkflowInstance("ins-amb-commit"));
      mockState.transportFault = { mode: "afterCommit", remaining: 1 };

      const updated = await recordInstanceOutput(
        "owner-1", "ins-amb-commit", { assetId: "asset-amb", mode: "full" }, false
      );

      expect(mockState.transportCalls).toHaveLength(2);
      const [first, second] = mockState.transportCalls;
      expect(second.transactionId).toBe(first.transactionId);
      expect(second.expectedRevision).toBe(first.expectedRevision);
      expect(second.requestHash).toBe(first.requestHash);
      expect(second.canonicalRequest).toBe(first.canonicalRequest);
      expect(second.idempotentReplay).toBe(true);

      const stored = mockState.v2Instances.find(i => i.id === "ins-amb-commit")!;
      expect(stored.outputHistory).toHaveLength(1);
      expect(updated.outputHistory).toHaveLength(1);
    });

    it("applies exactly once when the transport error happened before the commit", async () => {
      mockState.v2Instances.push(makeWorkflowInstance("ins-amb-before"));
      mockState.transportFault = { mode: "beforeCommit", remaining: 1 };

      const updated = await recordInstanceOutput(
        "owner-1", "ins-amb-before", { assetId: "asset-before", mode: "full" }, false
      );

      expect(mockState.transportCalls).toHaveLength(2);
      const [first, second] = mockState.transportCalls;
      expect(second.transactionId).toBe(first.transactionId);
      expect(second.expectedRevision).toBe(first.expectedRevision);
      expect(second.canonicalRequest).toBe(first.canonicalRequest);

      const stored = mockState.v2Instances.find(i => i.id === "ins-amb-before")!;
      expect(stored.outputHistory).toHaveLength(1);
      expect(updated.outputHistory).toHaveLength(1);
    });

    it("never replays an explicit non-conflict LocalServiceRequestError", async () => {
      mockState.v2Instances.push(makeWorkflowInstance("ins-business-fault"));
      mockState.businessFault = {
        status: 422, code: "workspace_v2_request_rejected", message: "Workspace v2 request was rejected.",
      };

      await expect(
        recordInstanceOutput("owner-1", "ins-business-fault", { assetId: "asset-biz", mode: "full" }, false)
      ).rejects.toBeInstanceOf(MockLocalServiceRequestError);

      expect(mockState.transportCalls).toHaveLength(1);
      const stored = mockState.v2Instances.find(i => i.id === "ins-business-fault")!;
      expect(stored.outputHistory).toHaveLength(0);
    });

    it("stops after a bounded number of ambiguity replays with a fixed safe error", async () => {
      mockState.v2Instances.push(makeWorkflowInstance("ins-amb-exhaust"));
      mockState.transportFault = { mode: "beforeCommit", remaining: 99 };

      await expect(
        recordInstanceOutput("owner-1", "ins-amb-exhaust", { assetId: "asset-exhaust", mode: "full" }, false)
      ).rejects.toThrow(/無法確認/);

      expect(mockState.transportCalls.length).toBeLessThanOrEqual(3);
      const stored = mockState.v2Instances.find(i => i.id === "ins-amb-exhaust")!;
      expect(stored.outputHistory).toHaveLength(0);
    });
  });

  describe("R5-P2: output event identity, transaction id collision, history/printCount consistency", () => {
    it("keeps two legitimate output events that share the same assetId without TRANSACTION_ID_REUSE", async () => {
      mockState.v2Instances.push(makeWorkflowInstance("ins-same-asset"));

      await recordInstanceOutput("owner-1", "ins-same-asset", { assetId: "asset-shared", mode: "full" }, false);
      await recordInstanceOutput("owner-1", "ins-same-asset", { assetId: "asset-shared", mode: "overlay" }, false);

      const stored = mockState.v2Instances.find(i => i.id === "ins-same-asset")!;
      expect(stored.outputHistory).toHaveLength(2);
      expect(stored.outputHistory[0].mode).toBe("full");
      expect(stored.outputHistory[1].mode).toBe("overlay");

      const transactionIds = mockState.transportCalls.map(call => call.transactionId);
      expect(new Set(transactionIds).size).toBe(transactionIds.length);
      for (const transactionId of transactionIds) {
        expect(transactionId.length).toBeLessThanOrEqual(256);
        expect(/\s/.test(transactionId)).toBe(false);
      }
    });

    it("does not dedupe the same assetId when format or printedAt differ", async () => {
      mockState.v2Instances.push(makeWorkflowInstance("ins-same-asset-format"));

      await recordInstanceOutput(
        "owner-1", "ins-same-asset-format",
        { assetId: "asset-shared-2", mode: "full", format: "pdf", printedAt: 1_700_000_000_000 }, false
      );
      await recordInstanceOutput(
        "owner-1", "ins-same-asset-format",
        { assetId: "asset-shared-2", mode: "full", format: "csv", printedAt: 1_700_000_060_000 }, false
      );

      const stored = mockState.v2Instances.find(i => i.id === "ins-same-asset-format")!;
      expect(stored.outputHistory).toHaveLength(2);
      expect(stored.outputHistory[0].format).toBe("pdf");
      expect(stored.outputHistory[1].format).toBe("csv");
    });

    it("commit-before-response-loss leaves one history entry and printCount 1", async () => {
      mockState.v2Instances.push(makeWorkflowInstance("ins-print-loss"));
      mockState.transportFault = { mode: "afterCommit", remaining: 1 };

      const updated = await recordInstanceOutput(
        "owner-1", "ins-print-loss", { assetId: "asset-print", mode: "print" }, true
      );

      expect(updated.printCount).toBe(1);
      expect(updated.outputHistory).toHaveLength(1);
      const stored = mockState.v2Instances.find(i => i.id === "ins-print-loss")!;
      expect(stored.outputHistory).toHaveLength(1);
      expect(stored.printCount).toBe(1);
      expect(stored.status).toBe("printed");
    });

    it("counts two independent print events sharing an assetId as two prints", async () => {
      mockState.v2Instances.push(makeWorkflowInstance("ins-two-prints"));

      await recordInstanceOutput("owner-1", "ins-two-prints", { assetId: "asset-print-twice", mode: "print" }, true);
      await recordInstanceOutput("owner-1", "ins-two-prints", { assetId: "asset-print-twice", mode: "print" }, true);

      const stored = mockState.v2Instances.find(i => i.id === "ins-two-prints")!;
      expect(stored.outputHistory).toHaveLength(2);
      expect(stored.printCount).toBe(2);
    });

    it("revision conflict retry keeps a concurrently appended history entry and appends its own once", async () => {
      mockState.v2Instances.push(makeWorkflowInstance("ins-concur-history-2"));

      const originalQuery = (await import("./localServiceClient")).queryLocalWorkspaceV2 as any;
      let hookTriggered = false;
      originalQuery.mockImplementationOnce(async (_owner: string, _input: any) => {
        const queryRes = {
          revision: mockState.v2Revision,
          records: structuredClone(mockState.v2Instances.filter(r => r.id === "ins-concur-history-2")),
          nextCursor: null,
        };
        if (!hookTriggered) {
          hookTriggered = true;
          const target = mockState.v2Instances.find(i => i.id === "ins-concur-history-2")!;
          target.outputHistory = [{ assetId: "asset-other-2", mode: "full" }];
          mockState.v2Revision += 1;
        }
        return queryRes;
      });

      const updated = await recordInstanceOutput(
        "owner-1", "ins-concur-history-2", { assetId: "asset-mine-2", mode: "full" }, false
      );

      expect(hookTriggered).toBe(true);
      expect(updated.outputHistory).toHaveLength(2);
      const stored = mockState.v2Instances.find(i => i.id === "ins-concur-history-2")!;
      expect(stored.outputHistory).toHaveLength(2);
      expect(stored.outputHistory.map((h: any) => h.assetId)).toEqual(["asset-other-2", "asset-mine-2"]);
      const replayed = await recordInstanceOutput(
        "owner-1", "ins-concur-history-2", { assetId: "asset-mine-2", mode: "full" }, false
      );
      expect(replayed.outputHistory).toHaveLength(3);
    });
  });

  describe("R6-P1: structured validation issue preserves safe params through the formal server path", () => {
    const CJK = /[一-鿿]/;
    const LOCALES = ["zh-Hant", "zh-Hans", "en"] as const;

    function localize(raw: string, locale: (typeof LOCALES)[number]): string {
      return translateServerMessage(raw, (zh, english) => (locale === "en" ? english : zh), locale);
    }

    function setDraftTableField(definition: Record<string, unknown>) {
      const ws = mockState.workspace as Record<string, any>;
      ws.fields = [
        {
          id: "fld-draft",
          templateVersionId: "ver-draft",
          stableFieldId: "table_draft",
          fieldType: "table",
          displayOrder: 0,
          definition: { label: "Finance Table", confirmed: true, ...definition },
          coordinate: { page: 1, xMm: 10, yMm: 10, widthMm: 80, heightMm: 20 },
        },
      ];
    }

    async function capturePublishError(definition: Record<string, unknown>): Promise<Error | null> {
      setDraftTableField(definition);
      let captured: Error | null = null;
      await publishTemplateVersion("owner-1", "ver-draft").then(
        () => {},
        (e: Error) => {
          captured = e;
        }
      );
      return captured;
    }

    const PUBLISH_CASES: Array<[string, Record<string, unknown>]> = [
      ["unknown column", { tableColumns: 3, maxRows: 2, tableFormulaCells: [{ row: 0, column: 2, expression: "A+Z" }] }],
      ["self reference", { tableColumns: 3, maxRows: 2, tableFormulaCells: [{ row: 0, column: 2, expression: "C" }] }],
      ["circular reference", { tableColumns: 3, maxRows: 2, tableFormulaCells: [{ row: 0, column: 1, expression: "C" }, { row: 0, column: 2, expression: "B" }] }],
      ["malformed entry", { tableColumns: 3, maxRows: 2, tableFormulaCells: [[] as unknown as Record<string, unknown>] }],
      ["row bounds", { tableColumns: 3, maxRows: 2, tableFormulaCells: [{ row: 5, column: 2, expression: "A" }] }],
      ["empty formula", { tableColumns: 3, maxRows: 2, tableFormulaCells: [{ row: 0, column: 2, expression: "" }] }],
    ];

    it.each(PUBLISH_CASES)("formal publish rejects '%s' and localizes every locale without leaking params", async (name, definition) => {
      const error = await capturePublishError(definition);
      expect(error, `${name} should fail publish`).toBeTruthy();
      const raw = error!.message;
      expect(raw).toContain("Template 發佈失敗：");
      expect(raw).toContain("[[FD_ISSUE:");
      for (const locale of LOCALES) {
        const out = localize(raw, locale);
        expect(out, `${name} ${locale} must not keep the raw marker`).not.toContain("[[");
        expect(out, `${name} ${locale} must not keep FD_ISSUE`).not.toContain("FD_ISSUE");
        expect(out, `${name} ${locale} must not keep unresolved {row}`).not.toContain("{row}");
        expect(out, `${name} ${locale} must not keep unresolved {column}`).not.toContain("{column}");
        expect(out, `${name} ${locale} must not keep unresolved {reference}`).not.toContain("{reference}");
        expect(out, `${name} ${locale} must not keep any unresolved placeholder`).not.toContain("{");
      }
      // en must be fully Latin-script; zh-Hant must actually be Traditional Chinese.
      expect(localize(raw, "en")).not.toMatch(CJK);
      expect(localize(raw, "zh-Hant")).toMatch(CJK);
    });

    function setPublishedFieldsWithRequiredText() {
      const ws = mockState.workspace as Record<string, any>;
      ws.fields = [
        {
          id: "fld-req",
          templateVersionId: "ver-pub",
          stableFieldId: "text_req",
          fieldType: "text",
          displayOrder: 0,
          definition: { label: "Applicant", required: true },
          coordinate: { page: 1, xMm: 10, yMm: 10, widthMm: 80, heightMm: 20 },
        },
        {
          id: "fld-table",
          templateVersionId: "ver-pub",
          stableFieldId: "table_field",
          fieldType: "table",
          displayOrder: 1,
          definition: {
            label: "Finance Table",
            confirmed: true,
            tableColumns: 3,
            maxRows: 2,
            tableWritableCells: [{ row: 0, column: 0 }, { row: 0, column: 1 }],
            tableFormulaCells: [{ row: 0, column: 2, expression: "A/B", decimalPlaces: 2 }],
          },
          coordinate: { page: 1, xMm: 10, yMm: 40, widthMm: 80, heightMm: 20 },
        },
      ];
    }

    const STATUS_CASES: Array<[string, Record<string, string>]> = [
      ["non-formula required field", {}],
      ["malformed table raw", { text_req: "x", table_field: "[{},[\"x\",{}]]" }],
      ["table runtime formula error", { text_req: "x", table_field: JSON.stringify([["10", "0", ""], ["", "", ""]]) }],
    ];

    it.each(STATUS_CASES)("formal status update rejects '%s' and localizes every locale without leaking", async (name, values) => {
      setPublishedFieldsWithRequiredText();
      mockState.v2Instances.push({
        id: "ins-status-r6",
        ownerId: "owner-1",
        templateId: "tpl-1",
        templateVersionId: "ver-pub",
        templateVersionHash: "hash-pub",
        schemaVersion: 2,
        name: "Status Instance",
        status: "draft",
        values,
        valuesHash: "hash-status-r6",
        printCount: 0,
        createdAt: 1000,
        updatedAt: 1000,
        completedAt: null,
        lastPrintedAt: null,
        outputHistory: [],
      });
      let captured: Error | null = null;
      await updateInstanceStatus("owner-1", "ins-status-r6", "completed").then(
        () => {},
        (e: Error) => {
          captured = e;
        }
      );
      expect(captured, `${name} should fail status update`).toBeTruthy();
      const raw = captured!.message;
      expect(raw).toContain("[[FD_ISSUE:");
      expect(raw).toContain("無法將狀態更新為");
      for (const locale of LOCALES) {
        const out = localize(raw, locale);
        expect(out, `${name} ${locale} must not keep raw marker`).not.toContain("[[");
        expect(out, `${name} ${locale} must not keep FD_ISSUE`).not.toContain("FD_ISSUE");
        expect(out, `${name} ${locale} must not keep any unresolved placeholder`).not.toContain("{");
      }
      expect(localize(raw, "en")).not.toMatch(CJK);
      expect(localize(raw, "zh-Hant")).toMatch(CJK);
    });
  });
});
