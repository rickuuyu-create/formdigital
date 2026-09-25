/** Deterministic, offline CSV contract tests for the localhost implementation. */
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  CSV_ANALYSIS_PAGE_SIZE,
  CSV_PROCESS_CHUNK_SIZE,
  canResumeImportStatus,
  csvSourceHash,
  classifyImportRow,
  mapCsvRow,
  parseCsvForImport,
  prepareResumeReplay,
  processRows,
  readValidatedCsvRows,
} from "./batch";
import { sha256 } from "./domain";
import { normalizeInstanceValuesForStorage } from "../../shared/tableFormula";

describe("CSV batch contract", () => {
  it("uses bounded row-processing chunks", () => {
    expect(CSV_PROCESS_CHUNK_SIZE).toBeGreaterThanOrEqual(100);
    expect(CSV_PROCESS_CHUNK_SIZE).toBeLessThanOrEqual(1_000);
  });

  it("does not impose an arbitrary CSV row-count limit", () => {
    const rowCount = 25_000;
    const csv = [
      "name,number",
      ...Array.from(
        { length: rowCount },
        (_, index) => `Synthetic ${index},${index}`
      ),
    ].join("\n");

    const parsed = parseCsvForImport(new TextEncoder().encode(csv));

    expect(parsed.rows).toHaveLength(rowCount);
    expect(parsed.rows.at(-1)).toEqual({
      name: `Synthetic ${rowCount - 1}`,
      number: String(rowCount - 1),
    });
  });
  it("parses quoted commas, BOM and multiline values with a stable schema", () => {
    const csv = new TextEncoder().encode(
      '\uFEFFname,remark\r\nAda,"first,\ncomplete"\r\n'
    );
    const parsed = parseCsvForImport(csv);
    expect(parsed.headers).toEqual(["name", "remark"]);
    expect(parsed.rows).toEqual([{ name: "Ada", remark: "first,\ncomplete" }]);
    expect(parsed.schemaFingerprint).toHaveLength(64);
  });

  it("streams a 100,001-row synthetic source without materialising every record", async () => {
    const rowCount = 100_001;
    const chunks = [
      "\uFEFFname,number\n",
      ...Array.from(
        { length: rowCount },
        (_, index) =>
          `${index % 25 === 24 ? `"Synthetic ${index}",` : `Synthetic ${index},`}${index}\n`
      ),
    ];
    const source = Readable.from(chunks);
    let count = 0;
    let lastRow: string[] | null = null;
    for await (const row of readValidatedCsvRows(source)) {
      count += 1;
      lastRow = row.record;
    }
    expect(count).toBe(rowCount);
    expect(lastRow).toEqual([`Synthetic ${rowCount - 1}`, String(rowCount - 1)]);
    expect(csvSourceHash(source)).toHaveLength(64);
  });

  it("keeps streamed analysis responses bounded to a fixed preview page", () => {
    expect(CSV_ANALYSIS_PAGE_SIZE).toBeLessThanOrEqual(100);
  });

  it("rejects blank or duplicate CSV headers", () => {
    expect(() =>
      parseCsvForImport(new TextEncoder().encode("name,name\nAda,A\n"))
    ).toThrow("不得為空白或重複");
  });

  it("maps only fields accepted by an explicit decision", () => {
    expect(
      mapCsvRow({ fullName: "Ada", ignored: "private" }, [
        {
          csvField: "fullName",
          templateStableFieldId: "studentName",
          confidence: "high",
          decision: "accepted",
        },
        { csvField: "ignored", confidence: "low", decision: "ignored" },
      ])
    ).toEqual({ studentName: "Ada" });
  });

  it("allows only unfinished imports into Resume", () => {
    expect(canResumeImportStatus("failed")).toBe(true);
    expect(canResumeImportStatus("running")).toBe(true);
    expect(canResumeImportStatus("completed")).toBe(false);
    expect(canResumeImportStatus("archived")).toBe(false);
  });

  it("replays only a hash-verified source and immutable Mapping manifest", () => {
    const bytes = new TextEncoder().encode("name\nAda\n");
    const replay = prepareResumeReplay({
      status: "failed",
      templateVersionId: "ver-1",
      mode: "strict",
      decisionManifest: [
        {
          csvField: "name",
          templateStableFieldId: "studentName",
          confidence: "high",
          decision: "accepted",
        },
      ],
      originalFilename: "students.csv",
      expectedContentHash: sha256(bytes),
      bytes,
    });
    expect(replay.templateVersionId).toBe("ver-1");
    expect(() =>
      prepareResumeReplay({
        ...replay,
        status: "completed",
        decisionManifest: replay.decisions,
        expectedContentHash: sha256(bytes),
        bytes,
      })
    ).toThrow("不需要 Resume");
    expect(() =>
      prepareResumeReplay({
        ...replay,
        status: "failed",
        decisionManifest: replay.decisions,
        expectedContentHash: "incorrect",
        bytes,
      })
    ).toThrow("完整性驗證失敗");
  });

  it("distinguishes a repeated source row from an existing Instance", () => {
    const seen = new Set<string>();
    const known = new Set<string>();
    const first = classifyImportRow({
      sourceHash: "source-1",
      mappedValues: { studentName: "Ada" },
      seenFingerprints: seen,
      knownValueHashes: known,
    });
    expect(first.status).toBe("create");
    known.add(first.valuesHash);
    expect(
      classifyImportRow({
        sourceHash: "source-2",
        mappedValues: { studentName: "Ada" },
        seenFingerprints: new Set(),
        knownValueHashes: known,
      })
    ).toMatchObject({
      status: "duplicate",
      reason: "matching-instance-already-exists",
    });
    expect(
      classifyImportRow({
        sourceHash: "source-1",
        mappedValues: { studentName: "Ada" },
        seenFingerprints: seen,
        knownValueHashes: new Set(),
      })
    ).toMatchObject({ status: "duplicate", reason: "duplicate-row-in-source" });
  });

  it("normalizes table fields to raw writable authority during CSV mapping (P1-C)", () => {
    const tableField = {
      stableFieldId: "table_1",
      fieldType: "table",
      definition: {
        tableColumns: 3,
        maxRows: 2,
        tableWritableCells: [
          { row: 0, column: 0 },
          { row: 0, column: 1 },
        ],
        tableFormulaCells: [
          { row: 0, column: 2, expression: "A + B", decimalPlaces: 2 },
        ],
      },
    };
    const fakeRawValues = {
      table_1: JSON.stringify([
        ["10", "20", "99999"],
        ["FixedA", "FixedB", "FixedC"],
      ]),
    };
    const normalized = normalizeInstanceValuesForStorage(fakeRawValues, [tableField as any]);
    const parsed = JSON.parse(normalized.table_1);
    expect(parsed[0][0]).toBe("10");
    expect(parsed[0][1]).toBe("20");
    expect(parsed[0][2]).toBe("");
    expect(parsed[1][0]).toBe("");
    expect(parsed[1][1]).toBe("");
    expect(parsed[1][2]).toBe("");
  });

  it("legacy processRows duplicate overwrite normalizes mergedValues into raw authority (P1-C)", async () => {
    const tableField = {
      id: "fld-1",
      templateVersionId: "ver-1",
      stableFieldId: "table_1",
      fieldType: "table",
      definition: {
        tableColumns: 3,
        maxRows: 2,
        tableWritableCells: [
          { row: 0, column: 0 },
          { row: 0, column: 1 },
        ],
        tableFormulaCells: [
          { row: 0, column: 2, expression: "A + B", decimalPlaces: 2 },
        ],
      },
    };
    const workspace: any = {
      instances: [
        {
          id: "ins-existing",
          templateVersionId: "ver-1",
          values: { table_1: JSON.stringify([["1", "2", ""], ["", "", ""]]) },
          valuesHash: "hash-existing",
          updatedAt: 1000,
        },
      ],
      importRows: [],
    };
    const run: any = {
      id: "run-1",
      templateVersionId: "ver-1",
      mode: "tolerant",
      sourceHash: "src-hash",
      decisionManifest: [
        { csvField: "col1", templateStableFieldId: "table_1", confidence: "high", decision: "accepted" },
      ],
      successCount: 0,
      warningCount: 0,
      failedCount: 0,
    };
    const parsed: any = {
      headers: ["col1"],
      rows: [{ col1: "some-data" }],
      schemaFingerprint: "fp",
    };
    const duplicateDecisions: any = [
      {
        rowNumber: 2,
        instanceId: "ins-existing",
        action: "overwrite",
        mergedValues: {
          table_1: JSON.stringify([
            ["50", "60", "FAKE_FORMULA_RESIDUAL"],
            ["FAKE_FIXED", "FAKE_FIXED", "FAKE_FIXED"],
          ]),
        },
      },
    ];

    await processRows({
      workspace,
      run,
      parsed,
      templateId: "tpl-1",
      templateVersionHash: "vhash",
      versionFields: [tableField as any],
      duplicateDecisions,
    });

    const instance = workspace.instances.find((i: any) => i.id === "ins-existing");
    expect(instance).toBeDefined();
    const parsedStored = JSON.parse(instance.values.table_1);
    expect(parsedStored[0][0]).toBe("50");
    expect(parsedStored[0][1]).toBe("60");
    expect(parsedStored[0][2]).toBe(""); // Formula stripped
    expect(parsedStored[1][0]).toBe(""); // Fixed stripped
  });

  it("legacy processRows marks importRow failed when CSV row has malformed table data (R4-P2)", async () => {
    const tableField = {
      id: "fld-1",
      templateVersionId: "ver-1",
      stableFieldId: "table_1",
      fieldType: "table",
      definition: {
        tableColumns: 3,
        maxRows: 2,
        tableWritableCells: [{ row: 0, column: 0 }],
      },
    };
    const workspace: any = {
      instances: [],
      importRows: [],
    };
    const run: any = {
      id: "run-malformed",
      templateVersionId: "ver-1",
      mode: "tolerant",
      sourceHash: "src-hash",
      decisionManifest: [
        { csvField: "col1", templateStableFieldId: "table_1", confidence: "high", decision: "accepted" },
      ],
      successCount: 0,
      warningCount: 0,
      failedCount: 0,
    };
    const parsed: any = {
      headers: ["col1"],
      rows: [{ col1: "[{},[\"x\",{}]]" }], // Malformed table row!
      schemaFingerprint: "fp",
    };

    await processRows({
      workspace,
      run,
      parsed,
      templateId: "tpl-1",
      templateVersionHash: "vhash",
      versionFields: [tableField as any],
    });

    expect(workspace.instances.length).toBe(0);
    expect(workspace.importRows.length).toBe(1);
    expect(workspace.importRows[0].status).toBe("failed");
    expect(workspace.importRows[0].errors[0]).toMatch(/表格/);
  });

  it("legacy processRows marks importRow failed and preserves existing instance when duplicate overwrite mergedValues has malformed table (R4-P2)", async () => {
    const tableField = {
      id: "fld-1",
      templateVersionId: "ver-1",
      stableFieldId: "table_1",
      fieldType: "table",
      definition: {
        tableColumns: 3,
        maxRows: 2,
        tableWritableCells: [{ row: 0, column: 0 }],
      },
    };
    const originalInstance = {
      id: "ins-existing-clean",
      templateVersionId: "ver-1",
      values: { table_1: JSON.stringify([["preserved", "", ""], ["", "", ""]]) },
      valuesHash: "hash-preserved",
      updatedAt: 1000,
    };
    const workspace: any = {
      instances: [structuredClone(originalInstance)],
      importRows: [],
    };
    const run: any = {
      id: "run-dup-malformed",
      templateVersionId: "ver-1",
      mode: "tolerant",
      sourceHash: "src-hash",
      decisionManifest: [
        { csvField: "col1", templateStableFieldId: "table_1", confidence: "high", decision: "accepted" },
      ],
      successCount: 0,
      warningCount: 0,
      failedCount: 0,
    };
    const parsed: any = {
      headers: ["col1"],
      rows: [{ col1: "some-data" }],
      schemaFingerprint: "fp",
    };
    const duplicateDecisions: any = [
      {
        rowNumber: 2,
        instanceId: "ins-existing-clean",
        action: "overwrite",
        mergedValues: {
          table_1: "[{},[\"x\",{}]]", // Malformed mergedValues!
        },
      },
    ];

    await processRows({
      workspace,
      run,
      parsed,
      templateId: "tpl-1",
      templateVersionHash: "vhash",
      versionFields: [tableField as any],
      duplicateDecisions,
    });

    expect(workspace.importRows.length).toBe(1);
    expect(workspace.importRows[0].status).toBe("failed");
    expect(workspace.importRows[0].errors[0]).toMatch(/表格/);

    // Existing instance must remain byte-for-byte unchanged!
    const instance = workspace.instances.find((i: any) => i.id === "ins-existing-clean");
    expect(instance.values.table_1).toBe(originalInstance.values.table_1);
    expect(instance.valuesHash).toBe(originalInstance.valuesHash);
  });
});
