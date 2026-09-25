import { describe, expect, it } from "vitest";
import {
  planWorkspaceBackupMerge,
  normalizeTemplateName,
  type AssetIdMap,
  type CreateId,
  type MergePlan,
} from "./backupMerge";
import type { LocalWorkspace } from "./workspaceStore";

type Rec = Record<string, unknown>;

const NOW = 1_700_000_000_000;

function makeCreateId(): CreateId {
  let n = 0;
  return (prefix: string) => `${prefix}_t${(++n).toString(36)}`;
}

function emptyWs(ownerKey = "owner-A"): LocalWorkspace {
  return {
    schemaVersion: 2,
    ownerKey,
    createdAt: "2023-01-01T00:00:00.000Z",
    updatedAt: "2023-01-01T00:00:00.000Z",
    templates: [],
    templateVersions: [],
    fields: [],
    instances: [],
    folders: [],
    tags: [],
    savedValues: [],
    mappingTemplates: [],
    importRuns: [],
    importRows: [],
    mappingDecisions: [],
    detectionRuns: [],
    operationJournal: [],
    preferences: { locale: "zh-Hant" },
  } as unknown as LocalWorkspace;
}

// --- record builders (return plain objects; cast at workspace construction) ---
function tpl(id: string, name: string, extra: Rec = {}): Rec {
  return {
    id,
    ownerId: "owner-A",
    name,
    description: null,
    lifecycle: "published",
    currentPublishedVersionId: null,
    currentDraftVersionId: null,
    schemaVersion: 2,
    folderIds: [],
    tagIds: [],
    favorite: false,
    pinned: false,
    printProfile: {},
    instanceNamePattern: "{T}_{D}_{T}",
    keyFieldIds: [],
    createdAt: 1000,
    updatedAt: 1000,
    lastOpenedAt: 1000,
    ...extra,
  };
}
function ver(id: string, tplId: string, hash: string, extra: Rec = {}): Rec {
  return {
    id,
    templateId: tplId,
    versionNumber: 1,
    state: "published",
    schemaVersion: 2,
    contentHash: hash,
    note: null,
    pageManifest: { assetId: "asset-page-1" },
    fieldSnapshot: [],
    printSettings: {},
    publishedAt: 1000,
    createdAt: 1000,
    updatedAt: 1000,
    ...extra,
  };
}
function fld(id: string, verId: string, stable: string, extra: Rec = {}): Rec {
  return {
    id,
    templateVersionId: verId,
    stableFieldId: stable,
    fieldType: "text",
    displayOrder: 1,
    definition: {},
    coordinate: {},
    createdAt: 1000,
    ...extra,
  };
}
function inst(id: string, tplId: string, verId: string, extra: Rec = {}): Rec {
  return {
    id,
    ownerId: "owner-A",
    templateId: tplId,
    templateVersionId: verId,
    templateVersionHash: "hash-pub",
    schemaVersion: 2,
    name: "Inst",
    status: "draft",
    values: {},
    valuesHash: "vh",
    printCount: 0,
    createdAt: 1000,
    updatedAt: 1000,
    completedAt: null,
    lastPrintedAt: null,
    outputHistory: [],
    ...extra,
  };
}
function savedValue(
  id: string,
  tplId: string,
  stable: string,
  value: string,
  extra: Rec = {} as Rec
): Rec {
  return {
    id,
    templateId: tplId,
    stableFieldId: stable,
    value,
    useCount: 0,
    createdAt: 1000,
    lastUsedAt: null,
    ...extra,
  };
}
function mapping(
  id: string,
  verId: string,
  tplId: string,
  extra: Rec = {}
): Rec {
  return {
    id,
    templateVersionId: verId,
    templateId: tplId,
    name: "m",
    sourceSchemaFingerprint: "fp",
    mapping: [],
    mappingHash: "mh",
    columnCount: 0,
    createdAt: 1000,
    updatedAt: 1000,
    lastUsedAt: 1000,
    ...extra,
  };
}
function folder(id: string, parentId: string | null = null, extra: Rec = {}): Rec {
  return {
    id,
    name: id,
    parentId,
    createdAt: 1000,
    updatedAt: 1000,
    ...extra,
  };
}
function tag(id: string, extra: Rec = {}): Rec {
  return { id, name: id, color: "#000000", createdAt: 1000, updatedAt: 1000, ...extra };
}
function importRun(
  id: string,
  verId: string,
  assetId: string,
  extra: Rec = {}
): Rec {
  return {
    id,
    ownerId: "owner-A",
    templateVersionId: verId,
    sourceAssetId: assetId,
    originalFilename: "x.csv",
    status: "completed",
    mode: "strict",
    sourceHash: "sh",
    sourceSchemaFingerprint: "fp",
    decisionHash: "dh",
    decisionManifest: [],
    totalRows: 1,
    successCount: 1,
    warningCount: 0,
    failedCount: 0,
    createdAt: 1000,
    completedAt: 1000,
    ...extra,
  };
}
function importRow(
  id: string,
  runId: string,
  instId: string | null = null,
  extra: Rec = {}
): Rec {
  return {
    id,
    importRunId: runId,
    rowNumber: 2,
    rowFingerprint: "rf",
    status: "created",
    sourceValues: {},
    mappedValues: {},
    instanceId: instId,
    errors: [],
    createdAt: 1000,
    updatedAt: 1000,
    ...extra,
  };
}
function mappingDecision(id: string, runId: string, extra: Rec = {}): Rec {
  return {
    id,
    importRunId: runId,
    csvField: "a",
    templateStableFieldId: null,
    confidence: "high",
    decision: "accepted",
    decidedAt: 1000,
    createdAt: 1000,
    ...extra,
  };
}
function detection(id: string, verId: string, extra: Rec = {}): Rec {
  return { id, templateVersionId: verId, createdAt: 1000, ...extra };
}

function find(recs: Rec[], id: string): Rec {
  const r = recs.find((x) => x.id === id);
  if (!r) throw new Error(`expected record ${id} not found`);
  return r;
}

function plan(
  current: LocalWorkspace,
  incoming: LocalWorkspace,
  mode: "structure" | "duplicate",
  assetIdMap?: AssetIdMap
): MergePlan {
  return planWorkspaceBackupMerge({
    current,
    incoming,
    mode,
    ownerId: "owner-B",
    createId: makeCreateId(),
    now: NOW,
    assetIdMap,
  });
}

function collectIds(ws: LocalWorkspace): Set<string> {
  const ids = new Set<string>();
  const arrays = [
    ws.templates,
    ws.templateVersions,
    ws.fields,
    ws.instances,
    ws.folders,
    ws.tags,
    ws.savedValues,
    ws.mappingTemplates,
    ws.importRuns,
    ws.importRows,
    ws.mappingDecisions,
    ws.detectionRuns,
  ];
  for (const arr of arrays) {
    for (const r of arr as Array<Rec>) if (typeof r.id === "string") ids.add(r.id);
  }
  return ids;
}

// ===========================================================================
describe("backupMerge planner — pure / immutability", () => {
  const current = {
    ...emptyWs(),
    templates: [tpl("t1", "Alpha")],
    templateVersions: [ver("v1", "t1", "H")],
    instances: [inst("i1", "t1", "v1")],
  } as unknown as LocalWorkspace;
  const incoming = {
    ...emptyWs("owner-C"),
    templates: [tpl("it1", "Alpha")],
    templateVersions: [ver("iv1", "it1", "H2")],
    fields: [fld("if1", "iv1", "s1")],
  } as unknown as LocalWorkspace;

  it("1. does not mutate the current workspace", () => {
    const snapshot = JSON.stringify(current);
    plan(current, incoming, "structure");
    expect(JSON.stringify(current)).toBe(snapshot);
  });

  it("2. does not mutate the incoming workspace", () => {
    const snapshot = JSON.stringify(incoming);
    plan(current, incoming, "structure");
    expect(JSON.stringify(incoming)).toBe(snapshot);
  });

  it("3. produces identical output for identical input", () => {
    const a = plan(current, incoming, "structure");
    const b = plan(current, incoming, "structure");
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("4. createId is called in a predictable order", () => {
    const seqA: string[] = [];
    const seqB: string[] = [];
    planWorkspaceBackupMerge({
      current,
      incoming,
      mode: "structure",
      ownerId: "owner-B",
      createId: ((p: string) => {
        seqA.push(p);
        return `${p}_x`;
      }) as CreateId,
      now: NOW,
    });
    planWorkspaceBackupMerge({
      current,
      incoming,
      mode: "structure",
      ownerId: "owner-B",
      createId: ((p: string) => {
        seqB.push(p);
        return `${p}_y`;
      }) as CreateId,
      now: NOW,
    });
    expect(seqA).toEqual(seqB);
  });

  it("5. runs without filesystem or Local Service access", () => {
    // The planner is pure; calling it with in-memory fixtures must succeed
    // and never require fs / Local Service. We assert it returns a plan.
    const result = plan(current, incoming, "duplicate");
    expect(result.mergedWorkspace).toBeDefined();
    expect(result.conflicts.length).toBe(1);
  });
});

// ===========================================================================
describe("backupMerge planner — structure mode", () => {
  it("6. same-name template yields overwrite_structure conflict", () => {
    const current = {
      ...emptyWs(),
      templates: [tpl("t1", "Alpha")],
      templateVersions: [ver("v1", "t1", "H")],
    } as unknown as LocalWorkspace;
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("it1", "Alpha")],
      templateVersions: [ver("iv1", "it1", "H2")],
      fields: [fld("if1", "iv1", "s1")],
    } as unknown as LocalWorkspace;
    const r = plan(current, incoming, "structure");
    expect(r.conflicts[0].action).toBe("overwrite_structure");
    expect(r.conflicts[0].sourceTemplateId).toBe("it1");
    expect(r.conflicts[0].existingTemplateId).toBe("t1");
  });

  it("7. overwrite preserves the current template id", () => {
    const current = {
      ...emptyWs(),
      templates: [tpl("t1", "Alpha")],
      templateVersions: [ver("v1", "t1", "H")],
    } as unknown as LocalWorkspace;
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("it1", "Alpha")],
      templateVersions: [ver("iv1", "it1", "H2")],
    } as unknown as LocalWorkspace;
    const r = plan(current, incoming, "structure");
    expect(r.mergedWorkspace.templates.some((t) => t.id === "t1")).toBe(true);
    expect(r.idMaps.templates["it1"]).toBe("t1");
  });

  it("8. current instances are all preserved", () => {
    const current = {
      ...emptyWs(),
      templates: [tpl("t1", "Alpha")],
      templateVersions: [ver("v1", "t1", "H")],
      instances: [inst("i1", "t1", "v1"), inst("i2", "t1", "v1")],
    } as unknown as LocalWorkspace;
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("it1", "Alpha")],
      templateVersions: [ver("iv1", "it1", "H2")],
    } as unknown as LocalWorkspace;
    const r = plan(current, incoming, "structure");
    const merged = r.mergedWorkspace.instances as unknown as Rec[];
    expect(merged.map((i) => i.id).sort()).toEqual(["i1", "i2"]);
    expect(r.counts.instancesPreserved).toBe(2);
  });

  it("9. current instances' old version / field references preserved", () => {
    const current = {
      ...emptyWs(),
      templates: [tpl("t1", "Alpha")],
      templateVersions: [ver("v1", "t1", "H")],
      fields: [fld("f1", "v1", "s1")],
      instances: [inst("i1", "t1", "v1")],
    } as unknown as LocalWorkspace;
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("it1", "Alpha")],
      templateVersions: [ver("iv1", "it1", "H2")],
      fields: [fld("if1", "iv1", "s1")],
    } as unknown as LocalWorkspace;
    const r = plan(current, incoming, "structure");
    expect(
      (r.mergedWorkspace.templateVersions as unknown as Rec[]).some(
        (v) => v.id === "v1"
      )
    ).toBe(true);
    expect(
      (r.mergedWorkspace.fields as unknown as Rec[]).some((f) => f.id === "f1")
    ).toBe(true);
    expect(find(r.mergedWorkspace.instances as unknown as Rec[], "i1").templateVersionId).toBe(
      "v1"
    );
  });

  it("10. incoming instances are not imported (structure)", () => {
    const current = {
      ...emptyWs(),
      templates: [tpl("t1", "Alpha")],
      templateVersions: [ver("v1", "t1", "H")],
    } as unknown as LocalWorkspace;
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("it1", "Alpha")],
      templateVersions: [ver("iv1", "it1", "H2")],
      instances: [inst("ii1", "it1", "iv1")],
    } as unknown as LocalWorkspace;
    const r = plan(current, incoming, "structure");
    expect(
      (r.mergedWorkspace.instances as unknown as Rec[]).some(
        (i) => i.id === "ii1"
      )
    ).toBe(false);
    expect(r.counts.instancesImported).toBe(0);
  });

  it("11. incoming import history is not imported (structure)", () => {
    const current = {
      ...emptyWs(),
      templates: [tpl("t1", "Alpha")],
      templateVersions: [ver("v1", "t1", "H")],
    } as unknown as LocalWorkspace;
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("it1", "Alpha")],
      templateVersions: [ver("iv1", "it1", "H2")],
      importRuns: [importRun("ir1", "iv1", "a2")],
      importRows: [importRow("irow", "ir1", "ii1")],
      mappingDecisions: [mappingDecision("imd", "ir1")],
    } as unknown as LocalWorkspace;
    const r = plan(current, incoming, "structure");
    expect((r.mergedWorkspace.importRuns as unknown as Rec[]).length).toBe(0);
    expect((r.mergedWorkspace.importRows as unknown as Rec[]).length).toBe(0);
    expect((r.mergedWorkspace.mappingDecisions as unknown as Rec[]).length).toBe(0);
  });

  it("12. same contentHash version is reused", () => {
    const current = {
      ...emptyWs(),
      templates: [tpl("t1", "Alpha")],
      templateVersions: [ver("v1", "t1", "H")],
    } as unknown as LocalWorkspace;
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("it1", "Alpha")],
      templateVersions: [ver("iv1", "it1", "H")],
    } as unknown as LocalWorkspace;
    const r = plan(current, incoming, "structure");
    expect(r.idMaps.templateVersions["iv1"]).toBe("v1");
    expect(r.counts.versionsReused).toBe(1);
    expect(r.counts.versionsGenerated).toBe(0);
    const mergedVers = r.mergedWorkspace.templateVersions as unknown as Rec[];
    const withH = mergedVers.filter((v) => v.contentHash === "H");
    expect(withH.length).toBe(1); // no duplicate
  });

  it("13. different-hash version gets a safe new id", () => {
    const current = {
      ...emptyWs(),
      templates: [tpl("t1", "Alpha")],
      templateVersions: [ver("v1", "t1", "H")],
    } as unknown as LocalWorkspace;
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("it1", "Alpha")],
      templateVersions: [ver("iv2", "it1", "H2")],
    } as unknown as LocalWorkspace;
    const r = plan(current, incoming, "structure");
    expect(r.idMaps.templateVersions["iv2"]).not.toBe("iv2");
    expect(r.idMaps.templateVersions["iv2"].startsWith("ver_")).toBe(true);
    expect(r.counts.versionsGenerated).toBe(1);
  });

  it("14. published / draft pointers remap correctly", () => {
    const current = {
      ...emptyWs(),
      templates: [tpl("t1", "Alpha")],
      templateVersions: [ver("v1", "t1", "H")],
    } as unknown as LocalWorkspace;
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [
        tpl("it1", "Alpha", {
          currentPublishedVersionId: "iv1",
          currentDraftVersionId: "iv2",
        }),
      ],
      templateVersions: [
        ver("iv1", "it1", "H"),
        ver("iv2", "it1", "H2"),
      ],
    } as unknown as LocalWorkspace;
    const r = plan(current, incoming, "structure");
    const t = find(r.mergedWorkspace.templates as unknown as Rec[], "t1");
    expect(t.currentPublishedVersionId).toBe("v1"); // reused
    expect(t.currentDraftVersionId).toBe(r.idMaps.templateVersions["iv2"]);
    const draftVer = find(
      r.mergedWorkspace.templateVersions as unknown as Rec[],
      t.currentDraftVersionId as string
    );
    expect(draftVer.templateId).toBe("t1");
  });

  it("15. new-name template is imported correctly", () => {
    const current = {
      ...emptyWs(),
      templates: [tpl("t1", "Alpha")],
      templateVersions: [ver("v1", "t1", "H")],
    } as unknown as LocalWorkspace;
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("it1", "Beta")],
      templateVersions: [ver("iv1", "it1", "H2")],
    } as unknown as LocalWorkspace;
    const r = plan(current, incoming, "structure");
    expect(r.counts.templatesImported).toBe(1);
    const imported = (r.mergedWorkspace.templates as unknown as Rec[]).find(
      (t) => t.name === "Beta"
    );
    expect(imported).toBeDefined();
    expect(imported!.ownerId).toBe("owner-B");
  });

  it("16. source id collision yields a new id", () => {
    const current = {
      ...emptyWs(),
      templates: [tpl("t1", "Alpha")],
      templateVersions: [ver("v1", "t1", "H")],
    } as unknown as LocalWorkspace;
    // incoming template id == current id but different name -> no name
    // collision, but id collision -> must generate a new id.
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("t1", "Beta")],
      templateVersions: [ver("iv1", "t1", "H2")],
    } as unknown as LocalWorkspace;
    const r = plan(current, incoming, "structure");
    expect(r.idMaps.templates["t1"]).not.toBe("t1");
    expect(r.idMaps.templates["t1"].startsWith("tpl_")).toBe(true);
    expect(
      (r.mergedWorkspace.templates as unknown as Rec[]).some((t) => t.id === "t1")
    ).toBe(true); // original preserved
  });

  it("17. mapping templates are not duplicated", () => {
    const current = {
      ...emptyWs(),
      templates: [tpl("t1", "Alpha")],
      templateVersions: [ver("v1", "t1", "H")],
      mappingTemplates: [mapping("mt1", "v1", "t1")],
    } as unknown as LocalWorkspace;
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("it1", "Alpha")],
      templateVersions: [ver("iv1", "it1", "H")],
      mappingTemplates: [mapping("imt", "iv1", "it1")],
    } as unknown as LocalWorkspace;
    const r = plan(current, incoming, "structure");
    expect((r.mergedWorkspace.mappingTemplates as unknown as Rec[]).length).toBe(1);
    expect(r.counts.mappingTemplatesImported).toBe(0);
  });

  it("18. saved values are not duplicated", () => {
    const current = {
      ...emptyWs(),
      templates: [tpl("t1", "Alpha")],
      templateVersions: [ver("v1", "t1", "H")],
      fields: [fld("f1", "v1", "s1")],
      savedValues: [savedValue("sv1", "t1", "s1", "X")],
    } as unknown as LocalWorkspace;
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("it1", "Alpha")],
      templateVersions: [ver("iv1", "it1", "H")],
      fields: [fld("if1", "iv1", "s1")],
      savedValues: [savedValue("isv", "it1", "s1", "X")],
    } as unknown as LocalWorkspace;
    const r = plan(current, incoming, "structure");
    expect((r.mergedWorkspace.savedValues as unknown as Rec[]).length).toBe(1);
    expect(r.counts.savedValuesImported).toBe(0);
  });

  it("19. folders / tags imported without dangling references", () => {
    const current = {
      ...emptyWs(),
      templates: [tpl("t1", "Alpha")],
    } as unknown as LocalWorkspace;
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("it1", "Beta", { folderIds: ["ifB"], tagIds: ["itA"] })],
      folders: [folder("ifA", null), folder("ifB", "ifA")],
      tags: [tag("itA")],
    } as unknown as LocalWorkspace;
    const r = plan(current, incoming, "structure");
    const fB = find(r.mergedWorkspace.folders as unknown as Rec[], r.idMaps.folders["ifB"]);
    const fA = find(r.mergedWorkspace.folders as unknown as Rec[], r.idMaps.folders["ifA"]);
    expect(fB.parentId).toBe(fA.id); // remapped, not "ifA"
    expect(fB.parentId).not.toBe("ifA");
    const t = find(r.mergedWorkspace.templates as unknown as Rec[], r.idMaps.templates["it1"]);
    expect(t.folderIds).toContain(fB.id);
    expect(t.tagIds).toContain(r.idMaps.tags["itA"]);
  });

  it("20. operationJournal / preferences retained from current", () => {
    const current = {
      ...emptyWs(),
      templates: [tpl("t1", "Alpha")],
      operationJournal: [{ op: "cur" }],
      preferences: { theme: "dark" },
    } as unknown as LocalWorkspace;
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("it1", "Beta")],
      operationJournal: [{ op: "inc" }],
      preferences: { locale: "en" },
    } as unknown as LocalWorkspace;
    const r = plan(current, incoming, "structure");
    expect(r.mergedWorkspace.operationJournal).toEqual([{ op: "cur" }]);
    expect(r.mergedWorkspace.preferences).toEqual({ theme: "dark" });
  });
});

// ===========================================================================
describe("backupMerge planner — duplicate mode", () => {
  function richIncoming(): LocalWorkspace {
    return {
      ...emptyWs("owner-C"),
      templates: [tpl("it1", "T", { folderIds: ["ifA"], tagIds: ["itA"] })],
      templateVersions: [ver("iv1", "it1", "H")],
      fields: [fld("if1", "iv1", "s1")],
      instances: [
        inst("ii1", "it1", "iv1", {
          outputHistory: [{ assetId: "a1" }],
        }),
      ],
      savedValues: [savedValue("isv", "it1", "s1", "V")],
      mappingTemplates: [mapping("imt", "iv1", "it1")],
      importRuns: [importRun("ir1", "iv1", "a2")],
      importRows: [importRow("irow", "ir1", "ii1")],
      mappingDecisions: [mappingDecision("imd", "ir1")],
      detectionRuns: [detection("idr", "iv1")],
      folders: [folder("ifA", null)],
      tags: [tag("itA")],
    } as unknown as LocalWorkspace;
  }

  const current = {
    ...emptyWs(),
    templates: [tpl("curT", "Current")],
  } as unknown as LocalWorkspace;

  it("21. template id is always new", () => {
    const r = plan(current, richIncoming(), "duplicate");
    expect(r.idMaps.templates["it1"]).not.toBe("it1");
    expect(r.idMaps.templates["it1"].startsWith("tpl_")).toBe(true);
  });

  it("22. version id is always new", () => {
    const r = plan(current, richIncoming(), "duplicate");
    expect(r.idMaps.templateVersions["iv1"]).not.toBe("iv1");
    expect(r.idMaps.templateVersions["iv1"].startsWith("ver_")).toBe(true);
  });

  it("23. field id is always new", () => {
    const r = plan(current, richIncoming(), "duplicate");
    expect(r.idMaps.fields["if1"]).not.toBe("if1");
    expect(r.idMaps.fields["if1"].startsWith("fld_")).toBe(true);
  });

  it("24. instance id is always new", () => {
    const r = plan(current, richIncoming(), "duplicate");
    expect(r.idMaps.instances["ii1"]).not.toBe("ii1");
  });

  it("25. mapping / savedValue / import / detection ids all new", () => {
    const r = plan(current, richIncoming(), "duplicate");
    expect(r.idMaps.mappingTemplates["imt"] === undefined).toBe(false);
    expect(r.idMaps.mappingTemplates["imt"]).not.toBe("imt");
    expect(r.idMaps.savedValues["isv"]).not.toBe("isv");
    expect(r.idMaps.importRuns["ir1"]).not.toBe("ir1");
    expect(r.idMaps.importRows["irow"]).not.toBe("irow");
    expect(r.idMaps.mappingDecisions["imd"]).not.toBe("imd");
    expect(r.idMaps.detectionRuns["idr"]).not.toBe("idr");
  });

  it("26. all template / version / instance relations correct", () => {
    const r = plan(current, richIncoming(), "duplicate");
    const newT = r.idMaps.templates["it1"];
    const newV = r.idMaps.templateVersions["iv1"];
    const newI = r.idMaps.instances["ii1"];
    const mergedT = find(r.mergedWorkspace.templates as unknown as Rec[], newT);
    const mergedV = find(r.mergedWorkspace.templateVersions as unknown as Rec[], newV);
    const mergedI = find(r.mergedWorkspace.instances as unknown as Rec[], newI);
    const mergedF = find(r.mergedWorkspace.fields as unknown as Rec[], r.idMaps.fields["if1"]);
    const mergedM = find(
      r.mergedWorkspace.mappingTemplates as unknown as Rec[],
      r.idMaps.mappingTemplates["imt"]
    );
    expect(mergedV.templateId).toBe(newT);
    expect(mergedF.templateVersionId).toBe(newV);
    expect(mergedI.templateId).toBe(newT);
    expect(mergedI.templateVersionId).toBe(newV);
    expect(mergedM.templateId).toBe(newT);
    expect(mergedM.templateVersionId).toBe(newV);
  });

  it("27. folder parent chain remapped", () => {
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("it1", "T", { folderIds: ["ifB"], tagIds: [] })],
      folders: [folder("ifA", null), folder("ifB", "ifA")],
    } as unknown as LocalWorkspace;
    const r = plan(current, incoming, "duplicate");
    const fB = find(r.mergedWorkspace.folders as unknown as Rec[], r.idMaps.folders["ifB"]);
    expect(fB.parentId).toBe(r.idMaps.folders["ifA"]);
    expect(fB.parentId).not.toBe("ifA");
  });

  it("28. tag remapped", () => {
    const r = plan(current, richIncoming(), "duplicate");
    const newT = r.idMaps.templates["it1"];
    const mergedT = find(r.mergedWorkspace.templates as unknown as Rec[], newT);
    expect(mergedT.tagIds).toContain(r.idMaps.tags["itA"]);
    expect(mergedT.tagIds).not.toContain("itA");
  });

  it("29. template / instance names get copy suffix", () => {
    const r = plan(current, richIncoming(), "duplicate");
    const newT = r.idMaps.templates["it1"];
    const newI = r.idMaps.instances["ii1"];
    expect(find(r.mergedWorkspace.templates as unknown as Rec[], newT).name).toBe(
      "T（匯入副本）"
    );
    expect(find(r.mergedWorkspace.instances as unknown as Rec[], newI).name).toBe(
      "Inst（匯入副本）"
    );
  });

  it("30. ownerId changed to target owner", () => {
    const r = plan(current, richIncoming(), "duplicate");
    const newT = r.idMaps.templates["it1"];
    const newI = r.idMaps.instances["ii1"];
    const newRun = r.idMaps.importRuns["ir1"];
    expect(find(r.mergedWorkspace.templates as unknown as Rec[], newT).ownerId).toBe(
      "owner-B"
    );
    expect(find(r.mergedWorkspace.instances as unknown as Rec[], newI).ownerId).toBe(
      "owner-B"
    );
    expect(
      find(r.mergedWorkspace.importRuns as unknown as Rec[], newRun).ownerId
    ).toBe("owner-B");
  });

  it("31. current workspace records fully preserved", () => {
    const r = plan(current, richIncoming(), "duplicate");
    expect(
      (r.mergedWorkspace.templates as unknown as Rec[]).some(
        (t) => t.id === "curT"
      )
    ).toBe(true);
    expect(r.counts.templatesImported).toBe(1);
  });

  it("32. same input + same createId yields identical deterministic plan", () => {
    const a = plan(current, richIncoming(), "duplicate");
    const b = plan(current, richIncoming(), "duplicate");
    // Determinism contract: identical input + identical createId sequence
    // (injected deterministic generator) -> identical output. The generated
    // ids therefore match across runs by design; we assert stability here.
    expect(a.mergedWorkspace).toEqual(b.mergedWorkspace);
    expect(a.idMaps).toEqual(b.idMaps);
    expect(a.conflicts).toEqual(b.conflicts);
    expect(a.counts).toEqual(b.counts);
  });

  it("33. outputHistory assetId remapped via assetIdMap", () => {
    const r = plan(current, richIncoming(), "duplicate", { a1: "a1-new" });
    const newI = r.idMaps.instances["ii1"];
    const mergedI = find(r.mergedWorkspace.instances as unknown as Rec[], newI);
    expect((mergedI.outputHistory as Rec[])[0].assetId).toBe("a1-new");
    expect(r.unresolvedAssetIds).not.toContain("a1");
    expect(r.requiredAssetIds).toContain("a1");
    expect(r.requiredAssetIds).toContain("a2");
  });

  it("34. missing asset map listed in unresolved", () => {
    const r = plan(current, richIncoming(), "duplicate");
    const newI = r.idMaps.instances["ii1"];
    const mergedI = find(r.mergedWorkspace.instances as unknown as Rec[], newI);
    // not fabricated; original value kept
    expect((mergedI.outputHistory as Rec[])[0].assetId).toBe("a1");
    expect(r.unresolvedAssetIds).toContain("a1");
    expect(r.unresolvedAssetIds).toContain("a2");
  });

  it("35. incoming operationJournal / preferences not imported", () => {
    const incoming = {
      ...richIncoming(),
      operationJournal: [{ op: "incoming" }],
    } as unknown as LocalWorkspace;
    (incoming as Rec).preferences = { locale: "en" };
    const r = plan(current, incoming, "duplicate");
    expect(r.mergedWorkspace.operationJournal).toEqual([]);
    expect(r.mergedWorkspace.preferences).toEqual({ locale: "zh-Hant" });
  });
});

// ===========================================================================
describe("backupMerge planner — broken relation rejection", () => {
  function expectThrows(fn: () => unknown, label: string): Error {
    let err: unknown;
    try {
      fn();
    } catch (e) {
      err = e;
    }
    expect(err, label).toBeInstanceOf(Error);
    return err as Error;
  }

  it("36. duplicate incoming template id rejected", () => {
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("t1", "Alpha"), tpl("t1", "Beta")],
    } as unknown as LocalWorkspace;
    const e = expectThrows(
      () => plan(emptyWs(), incoming, "structure"),
      "dup template id"
    );
    expect(e.message).toContain("DUPLICATE_ID: Template");
  });

  it("37. version pointing to missing template rejected", () => {
    const incoming = {
      ...emptyWs("owner-C"),
      templateVersions: [ver("v1", "missing", "H")],
    } as unknown as LocalWorkspace;
    const e = expectThrows(
      () => plan(emptyWs(), incoming, "structure"),
      "version missing template"
    );
    expect(e.message).toContain("INVALID_RELATION: TemplateVersion.templateId");
  });

  it("38. field pointing to missing version rejected", () => {
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("t1", "T")],
      fields: [fld("f1", "missing", "s1")],
    } as unknown as LocalWorkspace;
    const e = expectThrows(
      () => plan(emptyWs(), incoming, "structure"),
      "field missing version"
    );
    expect(e.message).toContain("INVALID_RELATION: Field.templateVersionId");
  });

  it("39. instance template / version mismatch rejected", () => {
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("t1", "T"), tpl("t2", "U")],
      templateVersions: [ver("v1", "t1", "H")],
      instances: [inst("i1", "t2", "v1")],
    } as unknown as LocalWorkspace;
    const e = expectThrows(
      () => plan(emptyWs(), incoming, "structure"),
      "instance mismatch"
    );
    expect(e.message).toContain("INVALID_RELATION: Instance.templateVersionId (wrong owner)");
  });

  it("40. mapping pointing to missing version rejected", () => {
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("t1", "T")],
      templateVersions: [ver("v1", "t1", "H")],
      mappingTemplates: [mapping("m1", "missing", "t1")],
    } as unknown as LocalWorkspace;
    const e = expectThrows(
      () => plan(emptyWs(), incoming, "structure"),
      "mapping missing version"
    );
    expect(e.message).toContain("INVALID_RELATION: MappingTemplate.templateVersionId");
  });

  it("41. importRow pointing to missing importRun rejected", () => {
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("t1", "T")],
      templateVersions: [ver("v1", "t1", "H")],
      importRuns: [importRun("ir1", "v1", "a2")],
      importRows: [importRow("irow", "missing", "ii1")],
    } as unknown as LocalWorkspace;
    const e = expectThrows(
      () => plan(emptyWs(), incoming, "structure"),
      "row missing run"
    );
    expect(e.message).toContain("INVALID_RELATION: ImportRow.importRunId");
  });

  it("42. detectionRun pointing to missing version rejected", () => {
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("t1", "T")],
      templateVersions: [ver("v1", "t1", "H")],
      detectionRuns: [detection("d1", "missing")],
    } as unknown as LocalWorkspace;
    const e = expectThrows(
      () => plan(emptyWs(), incoming, "structure"),
      "detection missing version"
    );
    expect(e.message).toContain("INVALID_RELATION: DetectionRun.templateVersionId");
  });

  it("43. folder parent missing / cycle rejected", () => {
    const missing = {
      ...emptyWs("owner-C"),
      folders: [folder("f1", "missing")],
    } as unknown as LocalWorkspace;
    const e1 = expectThrows(
      () => plan(emptyWs(), missing, "structure"),
      "folder missing parent"
    );
    expect(e1.message).toContain("INVALID_FOLDER_PARENT: unknown");

    const cycle = {
      ...emptyWs("owner-C"),
      folders: [folder("fX", "fX")],
    } as unknown as LocalWorkspace;
    const e2 = expectThrows(
      () => plan(emptyWs(), cycle, "structure"),
      "folder self cycle"
    );
    expect(e2.message).toContain("INVALID_FOLDER_PARENT: self");
  });

  it("44. template folderId / tagId missing rejected", () => {
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("t1", "T", { folderIds: ["missing"] })],
    } as unknown as LocalWorkspace;
    const e = expectThrows(
      () => plan(emptyWs(), incoming, "structure"),
      "template missing folder"
    );
    expect(e.message).toContain("INVALID_TEMPLATE_FOLDER_IDS: unknown");
  });

  it("45. published / draft pointer error rejected", () => {
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("t1", "T", { currentPublishedVersionId: "nope" })],
    } as unknown as LocalWorkspace;
    const e = expectThrows(
      () => plan(emptyWs(), incoming, "structure"),
      "bad published pointer"
    );
    expect(e.message).toContain("INVALID_RELATION: Template.currentPublishedVersionId");
  });

  it("46. two incoming same-name templates rejected", () => {
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("t1", "Alpha"), tpl("t2", "alpha")],
    } as unknown as LocalWorkspace;
    const e = expectThrows(
      () => plan(emptyWs(), incoming, "structure"),
      "two same name"
    );
    expect(e.message).toContain("INVALID_TEMPLATE_NAME: duplicate-normalized");
  });

  it("47. error does not contain secret fixture value", () => {
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("t1", "T")],
      templateVersions: [ver("v1", "missing", "H")],
      fields: [fld("f1", "v1", "s1", { definition: { label: "SECRET-XYZ" } })],
      instances: [inst("i1", "t1", "v1", { values: { x: "SECRET-XYZ" } })],
    } as unknown as LocalWorkspace;
    const e = expectThrows(
      () => plan(emptyWs(), incoming, "structure"),
      "secret leak"
    );
    expect(e.message).toContain("INVALID_RELATION");
    expect(e.message).not.toContain("SECRET-XYZ");
    expect(e.message).not.toContain("definition");
    expect(e.message).not.toContain("missing");
    expect(e.message.length).toBeLessThan(200);
  });
});

// ===========================================================================
describe("backupMerge planner — plan output", () => {
  it("48. counts match actual imported / reused / preserved", () => {
    const current = {
      ...emptyWs(),
      templates: [tpl("t1", "Alpha")],
      templateVersions: [ver("v1", "t1", "H")],
      instances: [inst("i1", "t1", "v1"), inst("i2", "t1", "v1")],
    } as unknown as LocalWorkspace;
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [
        tpl("it1", "Alpha", {
          currentPublishedVersionId: "iv1",
          currentDraftVersionId: "iv2",
        }),
      ],
      templateVersions: [ver("iv1", "it1", "H"), ver("iv2", "it1", "H2")],
      fields: [fld("if1", "iv2", "s1")],
    } as unknown as LocalWorkspace;
    const r = plan(current, incoming, "structure");
    expect(r.counts.templatesOverwritten).toBe(1);
    expect(r.counts.versionsReused).toBe(1);
    expect(r.counts.versionsGenerated).toBe(1);
    expect(r.counts.fieldsImported).toBe(1);
    expect(r.counts.instancesPreserved).toBe(2);
    expect(r.conflicts[0].preservedInstanceCount).toBe(2);
  });

  it("49. conflicts exclude values / asset bytes", () => {
    const current = {
      ...emptyWs(),
      templates: [tpl("t1", "Alpha")],
      templateVersions: [ver("v1", "t1", "H")],
    } as unknown as LocalWorkspace;
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("it1", "Alpha")],
      templateVersions: [ver("iv1", "it1", "H2")],
    } as unknown as LocalWorkspace;
    const r = plan(current, incoming, "structure");
    const c = r.conflicts[0];
    const keys = Object.keys(c).sort();
    expect(keys).toEqual(
      [
        "action",
        "existingTemplateId",
        "generatedVersionIds",
        "mode",
        "preservedInstanceCount",
        "reusedVersionIds",
        "sourceName",
        "sourceTemplateId",
      ].sort()
    );
    expect(JSON.stringify(c)).not.toContain("assetId");
  });

  it("50. idMaps cover all imported records (duplicate)", () => {
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("it1", "T", { folderIds: ["ifA"], tagIds: ["itA"] })],
      templateVersions: [ver("iv1", "it1", "H")],
      fields: [fld("if1", "iv1", "s1")],
      instances: [inst("ii1", "it1", "iv1")],
      savedValues: [savedValue("isv", "it1", "s1", "V")],
      mappingTemplates: [mapping("imt", "iv1", "it1")],
      importRuns: [importRun("ir1", "iv1", "a2")],
      importRows: [importRow("irow", "ir1", "ii1")],
      mappingDecisions: [mappingDecision("imd", "ir1")],
      detectionRuns: [detection("idr", "iv1")],
      folders: [folder("ifA", null)],
      tags: [tag("itA")],
    } as unknown as LocalWorkspace;
    const r = plan(emptyWs(), incoming, "duplicate");
    const maps: Array<[string, Record<string, string>]> = [
      ["templates", r.idMaps.templates],
      ["templateVersions", r.idMaps.templateVersions],
      ["fields", r.idMaps.fields],
      ["instances", r.idMaps.instances],
      ["savedValues", r.idMaps.savedValues],
      ["mappingTemplates", r.idMaps.mappingTemplates],
      ["importRuns", r.idMaps.importRuns],
      ["importRows", r.idMaps.importRows],
      ["mappingDecisions", r.idMaps.mappingDecisions],
      ["detectionRuns", r.idMaps.detectionRuns],
      ["folders", r.idMaps.folders],
      ["tags", r.idMaps.tags],
    ];
    const incomingIds: Record<string, string[]> = {
      templates: ["it1"],
      templateVersions: ["iv1"],
      fields: ["if1"],
      instances: ["ii1"],
      savedValues: ["isv"],
      mappingTemplates: ["imt"],
      importRuns: ["ir1"],
      importRows: ["irow"],
      mappingDecisions: ["imd"],
      detectionRuns: ["idr"],
      folders: ["ifA"],
      tags: ["itA"],
    };
    for (const [type, map] of maps) {
      for (const id of incomingIds[type]) {
        expect(map[id], `${type} map covers ${id}`).toBeDefined();
      }
    }
  });

  it("51. merged workspace contains no relation to source-only id", () => {
    const incoming = "owner-C";
    void incoming;
    const inc = {
      ...emptyWs("owner-C"),
      templates: [tpl("it1", "T", { folderIds: ["ifA"], tagIds: ["itA"] })],
      templateVersions: [ver("iv1", "it1", "H")],
      fields: [fld("if1", "iv1", "s1")],
      instances: [inst("ii1", "it1", "iv1")],
      folders: [folder("ifA", null)],
      tags: [tag("itA")],
    } as unknown as LocalWorkspace;
    const r = plan(emptyWs(), inc, "duplicate");
    const merged = r.mergedWorkspace;
    const mergedIds = collectIds(merged);
    const sourceIds = new Set([
      "it1",
      "iv1",
      "if1",
      "ii1",
      "ifA",
      "itA",
    ]);
    // No merged id equals a source id (all regenerated).
    for (const sid of sourceIds) {
      expect(mergedIds.has(sid), `merged must not keep source id ${sid}`).toBe(
        false
      );
    }
    // Every relation field points to an id that exists in merged.
    const relFields = [
      "templateId",
      "templateVersionId",
      "parentId",
      "instanceId",
      "importRunId",
    ];
    const arrays = [
      merged.templates,
      merged.templateVersions,
      merged.fields,
      merged.instances,
      merged.folders,
      merged.importRuns,
      merged.importRows,
      merged.mappingTemplates,
    ];
      for (const arr of arrays) {
        for (const rec of arr as Array<Rec>) {
          for (const f of relFields) {
            const v = rec[f];
            if (typeof v === "string" && v.length > 0) {
              expect(mergedIds.has(v), `${f}=${v} must exist`).toBe(true);
            }
          }
        }
      }
    });
});

// ===========================================================================
// R1 regression — second-line-defense proven defects + new fail-closed matrix
// ===========================================================================
describe("backupMerge planner — R1 defect regression", () => {
  function expectThrows(fn: () => unknown, label: string): Error {
    let err: unknown;
    try {
      fn();
    } catch (e) {
      err = e;
    }
    expect(err, label).toBeInstanceOf(Error);
    return err as Error;
  }

  // --- Defect 1: pageManifest asset plan must be live ----------------------
  it("R1-1. generated structure Version pageManifest asset is remapped", () => {
    const current = {
      ...emptyWs(),
      templates: [tpl("t1", "Alpha")],
      templateVersions: [ver("v1", "t1", "H")],
    } as unknown as LocalWorkspace;
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("it1", "Beta")],
      templateVersions: [
        ver("iv1", "it1", "H2", { pageManifest: { pages: [{ assetId: "page-asset" }] } }),
      ],
    } as unknown as LocalWorkspace;
    const r = plan(current, incoming, "structure", { "page-asset": "mapped-page" });
    const newVer = find(r.mergedWorkspace.templateVersions as unknown as Rec[], r.idMaps.templateVersions["iv1"]);
    expect((newVer.pageManifest as Rec).pages[0].assetId).toBe("mapped-page");
    expect(r.requiredAssetIds).toContain("page-asset");
    expect(r.unresolvedAssetIds).not.toContain("page-asset");
  });

  it("R1-2. generated structure Version missing asset mapping -> unresolved", () => {
    const current = {
      ...emptyWs(),
      templates: [tpl("t1", "Alpha")],
      templateVersions: [ver("v1", "t1", "H")],
    } as unknown as LocalWorkspace;
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("it1", "Beta")],
      templateVersions: [
        ver("iv1", "it1", "H2", { pageManifest: { pages: [{ assetId: "page-asset" }] } }),
      ],
    } as unknown as LocalWorkspace;
    const r = plan(current, incoming, "structure");
    expect(r.unresolvedAssetIds).toContain("page-asset");
    // original id preserved (never fabricated)
    const newVer = find(r.mergedWorkspace.templateVersions as unknown as Rec[], r.idMaps.templateVersions["iv1"]);
    expect((newVer.pageManifest as Rec).pages[0].assetId).toBe("page-asset");
  });

  it("R1-3. reused structure Version does not rewrite current pageManifest / require source asset", () => {
    const current = {
      ...emptyWs(),
      templates: [tpl("t1", "Alpha")],
      templateVersions: [
        ver("v1", "t1", "H", { pageManifest: { pages: [{ assetId: "cur-asset" }] } }),
      ],
    } as unknown as LocalWorkspace;
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("it1", "Alpha")],
      templateVersions: [
        ver("iv1", "it1", "H", { pageManifest: { pages: [{ assetId: "src-asset" }] } }),
      ],
    } as unknown as LocalWorkspace;
    const r = plan(current, incoming, "structure");
    // The reused version is the CURRENT v1; its pageManifest must be untouched.
    const reusedVer = find(r.mergedWorkspace.templateVersions as unknown as Rec[], "v1");
    expect((reusedVer.pageManifest as Rec).pages[0].assetId).toBe("cur-asset");
    expect(r.requiredAssetIds).not.toContain("src-asset");
    expect(r.unresolvedAssetIds).not.toContain("src-asset");
  });

  it("R1-4. duplicate Version pageManifest asset remapped", () => {
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("it1", "T")],
      templateVersions: [
        ver("iv1", "it1", "H", { pageManifest: { pages: [{ assetId: "page-asset" }] } }),
      ],
    } as unknown as LocalWorkspace;
    const r = plan(emptyWs(), incoming, "duplicate", { "page-asset": "mapped-page" });
    const newVer = find(r.mergedWorkspace.templateVersions as unknown as Rec[], r.idMaps.templateVersions["iv1"]);
    expect((newVer.pageManifest as Rec).pages[0].assetId).toBe("mapped-page");
    expect(r.requiredAssetIds).toContain("page-asset");
  });

  it("R1-5. duplicate Instance outputHistory asset remapped", () => {
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("it1", "T")],
      templateVersions: [ver("iv1", "it1", "H")],
      instances: [inst("ii1", "it1", "iv1", { outputHistory: [{ assetId: "a1" }] })],
    } as unknown as LocalWorkspace;
    const r = plan(emptyWs(), incoming, "duplicate", { a1: "a1-new" });
    const newI = r.idMaps.instances["ii1"];
    const mergedI = find(r.mergedWorkspace.instances as unknown as Rec[], newI);
    expect((mergedI.outputHistory as Rec[])[0].assetId).toBe("a1-new");
    expect(r.requiredAssetIds).toContain("a1");
  });

  it("R1-6. duplicate ImportRun sourceAssetId remapped", () => {
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("it1", "T")],
      templateVersions: [ver("iv1", "it1", "H")],
      importRuns: [importRun("ir1", "iv1", "a2")],
    } as unknown as LocalWorkspace;
    const r = plan(emptyWs(), incoming, "duplicate", { a2: "a2-new" });
    const newRun = r.idMaps.importRuns["ir1"];
    const mergedRun = find(r.mergedWorkspace.importRuns as unknown as Rec[], newRun);
    expect(mergedRun.sourceAssetId).toBe("a2-new");
    expect(r.requiredAssetIds).toContain("a2");
  });

  it("R1-7. requiredAssetIds / unresolvedAssetIds are deduped and deterministic", () => {
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("it1", "T")],
      templateVersions: [
        ver("iv1", "it1", "H", { pageManifest: { pages: [{ assetId: "dup" }, { assetId: "dup" }] } }),
      ],
      instances: [inst("ii1", "it1", "iv1", { outputHistory: [{ assetId: "dup" }] })],
    } as unknown as LocalWorkspace;
    const r = plan(emptyWs(), incoming, "duplicate");
    expect(r.requiredAssetIds.filter((x) => x === "dup")).toEqual(["dup"]);
    expect(r.unresolvedAssetIds.filter((x) => x === "dup")).toEqual(["dup"]);
    // deterministic across runs
    const r2 = plan(emptyWs(), incoming, "duplicate");
    expect(r.requiredAssetIds.slice().sort()).toEqual(r2.requiredAssetIds.slice().sort());
    expect(r.unresolvedAssetIds.slice().sort()).toEqual(r2.unresolvedAssetIds.slice().sort());
  });

  // --- Defect 2: ImportRun missing version must be rejected ----------------
  it("R1-8. ImportRun with missing templateVersionId is rejected", () => {
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("t1", "T")],
      templateVersions: [ver("v1", "t1", "H")],
      importRuns: [importRun("ir1", "missing", "a2")],
    } as unknown as LocalWorkspace;
    const e = expectThrows(
      () => plan(emptyWs(), incoming, "structure"),
      "importrun missing version"
    );
    expect(e.message).toContain("INVALID_RELATION: ImportRun.templateVersionId");
  });

  // --- Defect 3: MappingDecision missing/unknown importRunId rejected ------
  it("R1-9. MappingDecision with missing importRunId is rejected", () => {
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("t1", "T")],
      templateVersions: [ver("v1", "t1", "H")],
      mappingDecisions: [mappingDecision("imd", "", { templateVersionId: "v1" })],
    } as unknown as LocalWorkspace;
    const e = expectThrows(
      () => plan(emptyWs(), incoming, "structure"),
      "mappingDecision missing importRunId"
    );
    expect(e.message).toContain("MISSING_REQUIRED: Incoming MappingDecision.importRunId");
  });

  it("R1-10. MappingDecision with unknown importRunId is rejected", () => {
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("t1", "T")],
      templateVersions: [ver("v1", "t1", "H")],
      mappingDecisions: [mappingDecision("imd", "unknown", { templateVersionId: "v1" })],
    } as unknown as LocalWorkspace;
    const e = expectThrows(
      () => plan(emptyWs(), incoming, "structure"),
      "mappingDecision unknown importRunId"
    );
    expect(e.message).toContain("INVALID_RELATION: MappingDecision.importRunId");
  });

  it("R1-11. ImportRow with unknown non-null instanceId is rejected", () => {
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("t1", "T")],
      templateVersions: [ver("v1", "t1", "H")],
      importRuns: [importRun("ir1", "v1", "a2")],
      importRows: [importRow("irow", "ir1", "ghost")],
    } as unknown as LocalWorkspace;
    const e = expectThrows(
      () => plan(emptyWs(), incoming, "duplicate"),
      "row unknown instance"
    );
    expect(e.message).toContain("INVALID_RELATION: ImportRow.instanceId");
  });

  it("R1-12. ImportRow Instance / ImportRun version mismatch is rejected", () => {
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("t1", "T"), tpl("t2", "U")],
      templateVersions: [ver("v1", "t1", "H"), ver("v2", "t2", "H2")],
      instances: [inst("ii1", "t2", "v2")],
      importRuns: [importRun("ir1", "v1", "a2")],
      importRows: [importRow("irow", "ir1", "ii1")],
    } as unknown as LocalWorkspace;
    const e = expectThrows(
      () => plan(emptyWs(), incoming, "duplicate"),
      "row instance/run version mismatch"
    );
    expect(e.message).toContain("INVALID_RELATION: ImportRow.instanceId (version mismatch with ImportRun)");
  });

  // --- Section VI.A: published/draft must belong to its Template ----------
  it("R1-13. Template published version belonging to another Template is rejected", () => {
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("t1", "T"), tpl("t2", "U")],
      templateVersions: [ver("v1", "t1", "H"), ver("v2", "t2", "H2")],
      // t2 claims v1 (which belongs to t1) as its published version.
    } as unknown as LocalWorkspace;
    const bad = {
      ...emptyWs("owner-C"),
      templates: [tpl("t1", "T"), tpl("t2", "U", { currentPublishedVersionId: "v1" })],
      templateVersions: [ver("v1", "t1", "H"), ver("v2", "t2", "H2")],
    } as unknown as LocalWorkspace;
    const e = expectThrows(() => plan(emptyWs(), bad, "structure"), "published other template");
    expect(e.message).toContain("INVALID_RELATION: Template.currentPublishedVersionId (wrong owner)");
    void incoming;
  });

  it("R1-14. Template draft version belonging to another Template is rejected", () => {
    const bad = {
      ...emptyWs("owner-C"),
      templates: [tpl("t1", "T"), tpl("t2", "U", { currentDraftVersionId: "v1" })],
      templateVersions: [ver("v1", "t1", "H"), ver("v2", "t2", "H2")],
    } as unknown as LocalWorkspace;
    const e = expectThrows(() => plan(emptyWs(), bad, "structure"), "draft other template");
    expect(e.message).toContain("INVALID_RELATION: Template.currentDraftVersionId (wrong owner)");
  });

  // --- Section VI.B: MappingTemplate must be consistent -------------------
  it("R1-15. MappingTemplate referencing a Version of another Template is rejected", () => {
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("t1", "T"), tpl("t2", "U")],
      templateVersions: [ver("v1", "t1", "H"), ver("v2", "t2", "H2")],
      mappingTemplates: [mapping("m1", "v1", "t2")],
    } as unknown as LocalWorkspace;
    const e = expectThrows(
      () => plan(emptyWs(), incoming, "structure"),
      "mapping template version mismatch"
    );
    expect(e.message).toContain("INVALID_RELATION: MappingTemplate.templateVersionId (wrong owner)");
  });

  // --- Section VIII: Duplicate must not dedupe ----------------------------
  it("R1-16. Duplicate SavedValue is added with new id even if current has same content", () => {
    const current = {
      ...emptyWs(),
      templates: [tpl("t1", "Alpha")],
      templateVersions: [ver("v1", "t1", "H")],
      fields: [fld("f1", "v1", "s1")],
      savedValues: [savedValue("sv1", "t1", "s1", "X")],
    } as unknown as LocalWorkspace;
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("it1", "Beta")],
      templateVersions: [ver("iv1", "it1", "H")],
      fields: [fld("if1", "iv1", "s1")],
      savedValues: [savedValue("isv", "it1", "s1", "X")],
    } as unknown as LocalWorkspace;
    const r = plan(current, incoming, "duplicate");
    expect(r.counts.savedValuesImported).toBe(1);
    expect(r.idMaps.savedValues["isv"]).not.toBe("isv");
    expect(r.idMaps.savedValues["isv"]).not.toBe("sv1"); // distinct new id
  });

  it("R1-17. Duplicate MappingTemplate is added with new id even if current has same content", () => {
    const current = {
      ...emptyWs(),
      templates: [tpl("t1", "Alpha")],
      templateVersions: [ver("v1", "t1", "H")],
      mappingTemplates: [mapping("mt1", "v1", "t1")],
    } as unknown as LocalWorkspace;
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("it1", "Beta")],
      templateVersions: [ver("iv1", "it1", "H")],
      mappingTemplates: [mapping("imt", "iv1", "it1")],
    } as unknown as LocalWorkspace;
    const r = plan(current, incoming, "duplicate");
    expect(r.counts.mappingTemplatesImported).toBe(1);
    expect(r.idMaps.mappingTemplates["imt"]).not.toBe("imt");
    expect(r.idMaps.mappingTemplates["imt"]).not.toBe("mt1");
  });

  // --- Section IX: createId safety ---------------------------------------
  it("R1-18. createId returning empty / whitespace / exhausted fails closed", () => {
    const make = (fn: (p: string) => string): CreateId =>
      ((p: string) => fn(p)) as CreateId;
    const current = {
      ...emptyWs(),
      templates: [tpl("t1", "Alpha")],
      templateVersions: [ver("v1", "t1", "H")],
    } as unknown as LocalWorkspace;
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("it1", "Beta")],
      templateVersions: [ver("iv1", "it1", "H2")],
    } as unknown as LocalWorkspace;

    const emptyErr = expectThrows(
      () =>
        planWorkspaceBackupMerge({
          current,
          incoming,
          mode: "duplicate",
          ownerId: "owner-B",
          createId: make(() => ""),
          now: NOW,
        }),
      "empty id"
    );
    expect(emptyErr.message).toContain("invalid (empty/whitespace) id");

    const wsErr = expectThrows(
      () =>
        planWorkspaceBackupMerge({
          current,
          incoming,
          mode: "duplicate",
          ownerId: "owner-B",
          createId: make(() => "   "),
          now: NOW,
        }),
      "whitespace id"
    );
    expect(wsErr.message).toContain("invalid (empty/whitespace) id");

    // After 64 collisions it must throw (deterministic collision exhaust).
    const exhaustErr = expectThrows(
      () =>
        planWorkspaceBackupMerge({
          current,
          incoming,
          mode: "duplicate",
          ownerId: "owner-B",
          createId: make(() => "collide"), // always collides after first use
          now: NOW,
        }),
      "exhausted"
    );
    expect(exhaustErr.message).toContain("Unable to allocate a unique id");
  });

  // --- Section VI.H: no source-only folder/tag ids in duplicate -----------
  it("R1-19. duplicate folders / tags carry no incoming source-only ids", () => {
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("it1", "T", { folderIds: ["ifB"], tagIds: ["itA"] })],
      folders: [folder("ifA", null), folder("ifB", "ifA")],
      tags: [tag("itA")],
    } as unknown as LocalWorkspace;
    const r = plan(emptyWs(), incoming, "duplicate");
    const merged = r.mergedWorkspace;
    const mergedFolderIds = (merged.folders as unknown as Rec[]).map((f) => f.id);
    const mergedTagIds = (merged.tags as unknown as Rec[]).map((t) => t.id);
    expect(mergedFolderIds).not.toContain("ifA");
    expect(mergedFolderIds).not.toContain("ifB");
    expect(mergedTagIds).not.toContain("itA");
    // template folderIds/tagIds must reference the regenerated ids
    const t = find(merged.templates as unknown as Rec[], r.idMaps.templates["it1"]);
    for (const fid of t.folderIds as string[]) {
      expect(mergedFolderIds).toContain(fid);
    }
    for (const tid of t.tagIds as string[]) {
      expect(mergedTagIds).toContain(tid);
    }
  });

  // --- Section X: every relation points to a merged id -------------------
  it("R1-20. mappingDecisions / detectionRuns relations point to merged ids", () => {
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("it1", "T")],
      templateVersions: [ver("iv1", "it1", "H")],
      fields: [fld("if1", "iv1", "s1")],
      importRuns: [importRun("ir1", "iv1", "a2")],
      importRows: [importRow("irow", "ir1", "ii1")],
      instances: [inst("ii1", "it1", "iv1")],
      mappingDecisions: [mappingDecision("imd", "ir1")],
      detectionRuns: [detection("idr", "iv1")],
    } as unknown as LocalWorkspace;
    const r = plan(emptyWs(), incoming, "duplicate");
    const merged = r.mergedWorkspace;
    const mergedIds = collectIds(merged);
    const md = find(merged.mappingDecisions as unknown as Rec[], r.idMaps.mappingDecisions["imd"]);
    expect(mergedIds.has(md.importRunId)).toBe(true);
    const dr = find(merged.detectionRuns as unknown as Rec[], r.idMaps.detectionRuns["idr"]);
    expect(mergedIds.has(dr.templateVersionId)).toBe(true);
    const row = find(merged.importRows as unknown as Rec[], r.idMaps.importRows["irow"]);
    expect(mergedIds.has(row.importRunId)).toBe(true);
    expect(mergedIds.has(row.instanceId)).toBe(true);
  });

  // --- Section X (21): full relation audit across all collections --------
  // Typed ID sets: a single global id set CANNOT catch cross-type mistakes
  // (e.g. a templateId pointing at a Field id). We assert each relation
  // against the correct typed set.
  it("R1-21. full merged relation audit — typed ID sets across 17 relation kinds", () => {
    function richAll(): LocalWorkspace {
      return {
        ...emptyWs("owner-C"),
        templates: [tpl("it1", "T", { folderIds: ["ifA"], tagIds: ["itA"] })],
        templateVersions: [
          ver("iv1", "it1", "H", { pageManifest: { pages: [{ assetId: "pa" }] } }),
          ver("iv2", "it1", "H2"),
        ],
        fields: [fld("if1", "iv1", "s1"), fld("if2", "iv2", "s2")],
        instances: [
          inst("ii1", "it1", "iv1", { outputHistory: [{ assetId: "ia" }] }),
          inst("ii2", "it1", "iv2"),
        ],
        savedValues: [savedValue("isv", "it1", "s1", "V")],
        mappingTemplates: [mapping("imt", "iv1", "it1")],
        importRuns: [importRun("ir1", "iv1", "a2")],
        importRows: [importRow("irow", "ir1", "ii1")],
        mappingDecisions: [mappingDecision("imd", "ir1", { templateVersionId: "iv1" })],
        detectionRuns: [detection("idr", "iv1"), detection("idr2", "iv2")],
        folders: [folder("ifA", null)],
        tags: [tag("itA")],
      } as unknown as LocalWorkspace;
    }
    const r = plan(emptyWs(), richAll(), "duplicate");
    const merged = r.mergedWorkspace;

    // Typed ID sets derived from the merged workspace.
    const typedIds = {
      templateIds: new Set<string>((merged.templates as Rec[]).map((t) => t.id)),
      versionIds: new Set<string>((merged.templateVersions as Rec[]).map((v) => v.id)),
      fieldIds: new Set<string>((merged.fields as Rec[]).map((f) => f.id)),
      instanceIds: new Set<string>((merged.instances as Rec[]).map((i) => i.id)),
      folderIds: new Set<string>((merged.folders as Rec[]).map((f) => f.id)),
      tagIds: new Set<string>((merged.tags as Rec[]).map((t) => t.id)),
      savedValueIds: new Set<string>((merged.savedValues as Rec[]).map((s) => s.id)),
      mappingTemplateIds: new Set<string>((merged.mappingTemplates as Rec[]).map((m) => m.id)),
      importRunIds: new Set<string>((merged.importRuns as Rec[]).map((x) => x.id)),
      importRowIds: new Set<string>((merged.importRows as Rec[]).map((x) => x.id)),
      mappingDecisionIds: new Set<string>((merged.mappingDecisions as Rec[]).map((x) => x.id)),
      detectionRunIds: new Set<string>((merged.detectionRuns as Rec[]).map((x) => x.id)),
    };
    const mustBe = (v: unknown, set: Set<string>, label: string): void => {
      if (typeof v === "string" && v.length > 0) {
        expect(set.has(v), `${label}=${v} must exist in its typed set`).toBe(true);
      }
    };

    // 1. Template published/draft -> Version set, and Version belongs to same Template.
    for (const t of merged.templates as Rec[]) {
      mustBe(t.currentPublishedVersionId, typedIds.versionIds, "Template.published");
      mustBe(t.currentDraftVersionId, typedIds.versionIds, "Template.draft");
      if (typeof t.currentPublishedVersionId === "string") {
        const v = (merged.templateVersions as Rec[]).find((x) => x.id === t.currentPublishedVersionId);
        expect(v?.templateId).toBe(t.id);
      }
      if (typeof t.currentDraftVersionId === "string") {
        const v = (merged.templateVersions as Rec[]).find((x) => x.id === t.currentDraftVersionId);
        expect(v?.templateId).toBe(t.id);
      }
    }
    // 2. Version.templateId -> Template set.
    for (const v of merged.templateVersions as Rec[]) {
      mustBe(v.templateId, typedIds.templateIds, "Version.templateId");
    }
    // 3. Field.templateVersionId -> Version set.
    for (const f of merged.fields as Rec[]) {
      mustBe(f.templateVersionId, typedIds.versionIds, "Field.templateVersionId");
    }
    // 4. Instance.templateId -> Template set.
    for (const i of merged.instances as Rec[]) {
      mustBe(i.templateId, typedIds.templateIds, "Instance.templateId");
    }
    // 5. Instance.templateVersionId -> Version set and Version belongs to its Template.
    for (const i of merged.instances as Rec[]) {
      mustBe(i.templateVersionId, typedIds.versionIds, "Instance.templateVersionId");
      const v = (merged.templateVersions as Rec[]).find((x) => x.id === i.templateVersionId);
      expect(v?.templateId).toBe(i.templateId);
    }
    // 6. SavedValue.templateId -> Template set.
    for (const s of merged.savedValues as Rec[]) {
      mustBe(s.templateId, typedIds.templateIds, "SavedValue.templateId");
    }
    // 7. MappingTemplate.templateId -> Template set.
    for (const m of merged.mappingTemplates as Rec[]) {
      mustBe(m.templateId, typedIds.templateIds, "MappingTemplate.templateId");
    }
    // 8. MappingTemplate.templateVersionId -> Version set and Version belongs to its Template.
    for (const m of merged.mappingTemplates as Rec[]) {
      mustBe(m.templateVersionId, typedIds.versionIds, "MappingTemplate.templateVersionId");
      const v = (merged.templateVersions as Rec[]).find((x) => x.id === m.templateVersionId);
      expect(v?.templateId).toBe(m.templateId);
    }
    // 9. ImportRun.templateVersionId -> Version set.
    for (const x of merged.importRuns as Rec[]) {
      mustBe(x.templateVersionId, typedIds.versionIds, "ImportRun.templateVersionId");
    }
    // 10. ImportRow.importRunId -> ImportRun set.
    for (const x of merged.importRows as Rec[]) {
      mustBe(x.importRunId, typedIds.importRunIds, "ImportRow.importRunId");
    }
    // 11. ImportRow non-empty instanceId -> Instance set.
    for (const x of merged.importRows as Rec[]) {
      if (typeof x.instanceId === "string" && x.instanceId.length > 0) {
        expect(typedIds.instanceIds.has(x.instanceId), `ImportRow.instanceId=${x.instanceId}`).toBe(true);
      } else {
        expect(x.instanceId === null || x.instanceId === undefined).toBe(true);
      }
    }
    // 12. MappingDecision.importRunId -> ImportRun set.
    for (const x of merged.mappingDecisions as Rec[]) {
      mustBe(x.importRunId, typedIds.importRunIds, "MappingDecision.importRunId");
    }
    // 13. MappingDecision non-empty templateVersionId -> Version set & matches its run.
    for (const x of merged.mappingDecisions as Rec[]) {
      if (typeof x.templateVersionId === "string" && x.templateVersionId.length > 0) {
        expect(typedIds.versionIds.has(x.templateVersionId), `MappingDecision.templateVersionId=${x.templateVersionId}`).toBe(true);
        const run = (merged.importRuns as Rec[]).find((rr) => rr.id === x.importRunId);
        expect(run?.templateVersionId).toBe(x.templateVersionId);
      }
    }
    // 14. DetectionRun.templateVersionId -> Version set.
    for (const x of merged.detectionRuns as Rec[]) {
      mustBe(x.templateVersionId, typedIds.versionIds, "DetectionRun.templateVersionId");
    }
    // 15. Folder.parentId -> Folder set (null/undefined allowed).
    for (const f of merged.folders as Rec[]) {
      if (f.parentId !== null && f.parentId !== undefined) {
        expect(typedIds.folderIds.has(f.parentId as string), `Folder.parentId=${f.parentId}`).toBe(true);
      }
    }
    // 16. Template.folderIds -> Folder set.
    for (const t of merged.templates as Rec[]) {
      for (const fid of (t.folderIds as string[]) ?? []) {
        expect(typedIds.folderIds.has(fid), `Template.folderIds=${fid}`).toBe(true);
      }
    }
    // 17. Template.tagIds -> Tag set.
    for (const t of merged.templates as Rec[]) {
      for (const tid of (t.tagIds as string[]) ?? []) {
        expect(typedIds.tagIds.has(tid), `Template.tagIds=${tid}`).toBe(true);
      }
    }

    // Global output record-ID uniqueness (real assertion, not a comment).
    // Collect raw record ids, not ids from Sets: Sets would hide duplicate ids
    // within the same collection and make this assertion capable of false-pass.
    const allIds = [
      merged.templates,
      merged.templateVersions,
      merged.fields,
      merged.instances,
      merged.folders,
      merged.tags,
      merged.savedValues,
      merged.mappingTemplates,
      merged.importRuns,
      merged.importRows,
      merged.mappingDecisions,
      merged.detectionRuns,
    ].flatMap((records) => (records as Rec[]).map((record) => record.id as string));
    const uniqueCount = new Set(allIds).size;
    expect(uniqueCount).toBe(allIds.length);

    // No duplicate-imported record keeps a source-only id (all regenerated).
    const sourceIds = new Set([
      "it1", "iv1", "iv2", "if1", "if2", "ii1", "ii2", "isv",
      "imt", "ir1", "irow", "imd", "idr", "idr2", "ifA", "itA",
    ]);
    for (const sid of sourceIds) {
      expect([...typedIds.templateIds, ...typedIds.versionIds, ...typedIds.fieldIds,
        ...typedIds.instanceIds, ...typedIds.folderIds, ...typedIds.tagIds,
        ...typedIds.savedValueIds, ...typedIds.mappingTemplateIds, ...typedIds.importRunIds,
        ...typedIds.importRowIds, ...typedIds.mappingDecisionIds, ...typedIds.detectionRunIds
      ].includes(sid), `merged must not keep source id ${sid}`).toBe(false);
    }

    // counts consistent
    expect(r.counts.templatesImported).toBe(1);
    expect(r.counts.versionsGenerated).toBe(2);
    expect(r.counts.fieldsImported).toBe(2);
    expect(r.counts.instancesImported).toBe(2);
  });

  // --- Section X (22): malformed errors leak no secret / path / value ----
  it("R1-22. malformed-relation error contains no secret / Windows path / raw value", () => {
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("t1", "T")],
      templateVersions: [
        ver("v1", "missing", "H", {
          pageManifest: { pages: [{ assetId: "C:\\Users\\kk\\secret\\x.pdf" }] },
        }),
      ],
      fields: [fld("f1", "v1", "s1", { definition: { label: "SECRET-XYZ" } })],
      instances: [inst("i1", "t1", "v1", { values: { x: "RAWVALUE-123" } })],
    } as unknown as LocalWorkspace;
    const e = expectThrows(
      () => plan(emptyWs(), incoming, "structure"),
      "secret leak r1"
    );
    expect(e.message).toContain("INVALID_RELATION");
    expect(e.message).not.toContain("SECRET-XYZ");
    expect(e.message).not.toContain("RAWVALUE-123");
    expect(e.message).not.toContain("C:\\Users");
    expect(e.message).not.toContain("x.pdf");
    expect(e.message).not.toContain("definition");
    expect(e.message.length).toBeLessThan(200);
  });
});

// ===========================================================================
// R2 regression — second-line-defense proven defects (round 2)
//   A. MappingDecision stable-field leakage
//   B. Asset remap scope too broad
//   C. folderIds / tagIds silently cleaned
//   D. relation errors leaking incoming values
//   Plus typed relation audit + global uniqueness + immutability (Section 四/五.21-22)
// ===========================================================================
describe("backupMerge planner — R2 defect regression", () => {
  function expectThrows(fn: () => unknown, label: string): Error {
    let err: unknown;
    try {
      fn();
    } catch (e) {
      err = e;
    }
    expect(err, label).toBeInstanceOf(Error);
    return err as Error;
  }

  // ---- A. MappingDecision stable-field --------------------------------
  it("R2-1. MappingDecision valid stable field is accepted", () => {
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("it1", "T")],
      templateVersions: [ver("iv1", "it1", "H")],
      fields: [fld("if1", "iv1", "s1")],
      importRuns: [importRun("ir1", "iv1", "a2")],
      mappingDecisions: [mappingDecision("imd", "ir1", { templateStableFieldId: "s1" })],
    } as unknown as LocalWorkspace;
    const r = plan(emptyWs(), incoming, "duplicate");
    expect(r.idMaps.mappingDecisions["imd"]).toBeDefined();
    const md = find(r.mergedWorkspace.mappingDecisions as unknown as Rec[], r.idMaps.mappingDecisions["imd"]);
    expect(md.templateStableFieldId).toBe("s1");
  });

  it("R2-2. MappingDecision unknown stable field is rejected", () => {
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("it1", "T")],
      templateVersions: [ver("iv1", "it1", "H")],
      fields: [fld("if1", "iv1", "s1")],
      importRuns: [importRun("ir1", "iv1", "a2")],
      mappingDecisions: [mappingDecision("imd", "ir1", { templateStableFieldId: "does-not-exist" })],
    } as unknown as LocalWorkspace;
    const e = expectThrows(
      () => plan(emptyWs(), incoming, "duplicate"),
      "unknown stable field"
    );
    expect(e.message).toContain("INVALID_RELATION: MappingDecision.templateStableFieldId");
  });

  it("R2-3. stable field existing only in another Version of same Template is rejected", () => {
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("it1", "T")],
      templateVersions: [ver("iv1", "it1", "H"), ver("iv2", "it1", "H2")],
      fields: [fld("if1", "iv1", "s1"), fld("if2", "iv2", "s2")],
      importRuns: [importRun("ir1", "iv1", "a2")],
      // Run points at iv1; s2 only exists on iv2 -> must be rejected.
      mappingDecisions: [mappingDecision("imd", "ir1", { templateStableFieldId: "s2" })],
    } as unknown as LocalWorkspace;
    const e = expectThrows(
      () => plan(emptyWs(), incoming, "duplicate"),
      "stable field in other version"
    );
    expect(e.message).toContain("INVALID_RELATION: MappingDecision.templateStableFieldId");
  });

  it("R2-4. MappingDecision optional version inconsistent with ImportRun is rejected", () => {
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("it1", "T")],
      templateVersions: [ver("iv1", "it1", "H"), ver("iv2", "it1", "H2")],
      fields: [fld("if1", "iv1", "s1")],
      importRuns: [importRun("ir1", "iv1", "a2")],
      mappingDecisions: [
        mappingDecision("imd", "ir1", { templateStableFieldId: "s1", templateVersionId: "iv2" }),
      ],
    } as unknown as LocalWorkspace;
    const e = expectThrows(
      () => plan(emptyWs(), incoming, "duplicate"),
      "version mismatch"
    );
    expect(e.message).toContain(
      "INVALID_RELATION: MappingDecision.templateVersionId (mismatch with ImportRun)"
    );
  });

  // ---- B. Asset remap scope --------------------------------------------
  it("R2-5. ImportRun.decisionManifest.nestedAssetId is NOT remapped and NOT required/unresolved", () => {
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("it1", "T")],
      templateVersions: [ver("iv1", "it1", "H")],
      importRuns: [
        importRun("ir1", "iv1", "a-real", {
          decisionManifest: [{ csvField: "a", nestedAssetId: "not-an-asset-reference" }],
        }),
      ],
    } as unknown as LocalWorkspace;
    const r = plan(emptyWs(), incoming, "duplicate", { "a-real": "a-real-new" });
    const run = find(r.mergedWorkspace.importRuns as unknown as Rec[], r.idMaps.importRuns["ir1"]);
    // decisionManifest preserved byte-for-byte
    expect(run.decisionManifest).toEqual([
      { csvField: "a", nestedAssetId: "not-an-asset-reference" },
    ]);
    expect(r.requiredAssetIds).not.toContain("not-an-asset-reference");
    expect(r.unresolvedAssetIds).not.toContain("not-an-asset-reference");
    // the real sourceAssetId IS remapped
    expect(run.sourceAssetId).toBe("a-real-new");
    expect(r.requiredAssetIds).toContain("a-real");
  });

  it("R2-6. ImportRow nested asset id is NOT remapped", () => {
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("it1", "T")],
      templateVersions: [ver("iv1", "it1", "H")],
      instances: [inst("ii1", "it1", "iv1")],
      importRuns: [importRun("ir1", "iv1", "a2")],
      importRows: [importRow("irow", "ir1", "ii1", { nestedAssetId: "row-asset" })],
    } as unknown as LocalWorkspace;
    const r = plan(emptyWs(), incoming, "duplicate");
    const row = find(r.mergedWorkspace.importRows as unknown as Rec[], r.idMaps.importRows["irow"]);
    expect((row as Rec).nestedAssetId).toBe("row-asset");
    expect(r.requiredAssetIds).not.toContain("row-asset");
    expect(r.unresolvedAssetIds).not.toContain("row-asset");
  });

  it("R2-7. Instance nested asset id outside outputHistory is NOT remapped", () => {
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("it1", "T")],
      templateVersions: [ver("iv1", "it1", "H")],
      instances: [
        inst("ii1", "it1", "iv1", {
          meta: { nestedAssetId: "inst-asset" },
          outputHistory: [{ assetId: "a1" }],
        }),
      ],
    } as unknown as LocalWorkspace;
    const r = plan(emptyWs(), incoming, "duplicate", { a1: "a1-new" });
    const i = find(r.mergedWorkspace.instances as unknown as Rec[], r.idMaps.instances["ii1"]);
    expect((i.meta as Rec).nestedAssetId).toBe("inst-asset");
    expect(r.requiredAssetIds).not.toContain("inst-asset");
    expect(r.unresolvedAssetIds).not.toContain("inst-asset");
    // the confirmed position (outputHistory) IS remapped
    expect((i.outputHistory as Rec[])[0].assetId).toBe("a1-new");
  });

  it("R2-8. Instance.outputHistory assetId is remapped", () => {
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("it1", "T")],
      templateVersions: [ver("iv1", "it1", "H")],
      instances: [inst("ii1", "it1", "iv1", { outputHistory: [{ assetId: "a1" }] })],
    } as unknown as LocalWorkspace;
    const r = plan(emptyWs(), incoming, "duplicate", { a1: "a1-new" });
    const i = find(r.mergedWorkspace.instances as unknown as Rec[], r.idMaps.instances["ii1"]);
    expect((i.outputHistory as Rec[])[0].assetId).toBe("a1-new");
    expect(r.requiredAssetIds).toContain("a1");
    expect(r.unresolvedAssetIds).not.toContain("a1");
  });

  it("R2-9. Version.pageManifest assetId is remapped", () => {
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("it1", "T")],
      templateVersions: [ver("iv1", "it1", "H", { pageManifest: { pages: [{ assetId: "pa" }] } })],
    } as unknown as LocalWorkspace;
    const r = plan(emptyWs(), incoming, "duplicate", { pa: "pa-new" });
    const v = find(r.mergedWorkspace.templateVersions as unknown as Rec[], r.idMaps.templateVersions["iv1"]);
    expect((v.pageManifest as Rec).pages[0].assetId).toBe("pa-new");
    expect(r.requiredAssetIds).toContain("pa");
    expect(r.unresolvedAssetIds).not.toContain("pa");
  });

  it("R2-10. ImportRun.sourceAssetId is remapped", () => {
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("it1", "T")],
      templateVersions: [ver("iv1", "it1", "H")],
      importRuns: [importRun("ir1", "iv1", "a2")],
    } as unknown as LocalWorkspace;
    const r = plan(emptyWs(), incoming, "duplicate", { a2: "a2-new" });
    const run = find(r.mergedWorkspace.importRuns as unknown as Rec[], r.idMaps.importRuns["ir1"]);
    expect(run.sourceAssetId).toBe("a2-new");
    expect(r.requiredAssetIds).toContain("a2");
    expect(r.unresolvedAssetIds).not.toContain("a2");
  });

  // ---- C. folderIds / tagIds fail closed -------------------------------
  it("R2-11. Template folderIds containing a number is rejected", () => {
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("it1", "T", { folderIds: [123 as unknown as string] })],
    } as unknown as LocalWorkspace;
    const e = expectThrows(
      () => plan(emptyWs(), incoming, "structure"),
      "folderIds number"
    );
    expect(e.message).toContain("INVALID_TEMPLATE_FOLDER_IDS: invalid-entry");
    expect(e.message).not.toContain("123");
  });

  it("R2-12. Template tagIds containing an object is rejected", () => {
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("it1", "T", { tagIds: [{} as unknown as string] })],
    } as unknown as LocalWorkspace;
    const e = expectThrows(
      () => plan(emptyWs(), incoming, "structure"),
      "tagIds object"
    );
    expect(e.message).toContain("INVALID_TEMPLATE_TAG_IDS: invalid-entry");
    expect(e.message).not.toContain("[object Object]");
  });

  it("R2-13. Template folderIds / tagIds not an array is rejected", () => {
    const f = expectThrows(
      () =>
        plan(
          emptyWs(),
          {
            ...emptyWs("owner-C"),
            templates: [tpl("it1", "T", { folderIds: "not-array" as unknown as string[] })],
          } as unknown as LocalWorkspace,
          "structure"
        ),
      "folderIds not array"
    );
    expect(f.message).toContain("INVALID_TEMPLATE_FOLDER_IDS: not-array");
    const t = expectThrows(
      () =>
        plan(
          emptyWs(),
          {
            ...emptyWs("owner-C"),
            templates: [tpl("it1", "T", { tagIds: 5 as unknown as string[] })],
          } as unknown as LocalWorkspace,
          "structure"
        ),
      "tagIds not array"
    );
    expect(t.message).toContain("INVALID_TEMPLATE_TAG_IDS: not-array");
  });

  it("R2-14. Template folderIds / tagIds empty or blank string is rejected", () => {
    const empty = expectThrows(
      () =>
        plan(
          emptyWs(),
          {
            ...emptyWs("owner-C"),
            templates: [tpl("it1", "T", { folderIds: [""] })],
          } as unknown as LocalWorkspace,
          "structure"
        ),
      "folderIds empty"
    );
    expect(empty.message).toContain("INVALID_TEMPLATE_FOLDER_IDS: invalid-entry");
    const blank = expectThrows(
      () =>
        plan(
          emptyWs(),
          {
            ...emptyWs("owner-C"),
            templates: [tpl("it1", "T", { tagIds: ["  "] })],
          } as unknown as LocalWorkspace,
          "structure"
        ),
      "tagIds blank"
    );
    expect(blank.message).toContain("INVALID_TEMPLATE_TAG_IDS: invalid-entry");
  });

  it("R2-15. Template folderIds / tagIds duplicate values are rejected", () => {
    const f = expectThrows(
      () =>
        plan(
          emptyWs(),
          {
            ...emptyWs("owner-C"),
            templates: [tpl("it1", "T", { folderIds: ["ifA", "ifA"] })],
            folders: [folder("ifA", null)],
          } as unknown as LocalWorkspace,
          "structure"
        ),
      "folderIds duplicate"
    );
    expect(f.message).toContain("INVALID_TEMPLATE_FOLDER_IDS: duplicate");
    const t = expectThrows(
      () =>
        plan(
          emptyWs(),
          {
            ...emptyWs("owner-C"),
            templates: [tpl("it1", "T", { tagIds: ["itA", "itA"] })],
            tags: [tag("itA")],
          } as unknown as LocalWorkspace,
          "structure"
        ),
      "tagIds duplicate"
    );
    expect(t.message).toContain("INVALID_TEMPLATE_TAG_IDS: duplicate");
  });

  it("R2-16. Folder.parentId as number / object / blank is rejected", () => {
    const num = expectThrows(
      () =>
        plan(
          emptyWs(),
          {
            ...emptyWs("owner-C"),
            folders: [folder("f1", 123 as unknown as string)],
          } as unknown as LocalWorkspace,
          "structure"
        ),
      "parentId number"
    );
    expect(num.message).toContain("INVALID_FOLDER_PARENT: type");
    expect(num.message).not.toContain("123");
    const obj = expectThrows(
      () =>
        plan(
          emptyWs(),
          {
            ...emptyWs("owner-C"),
            folders: [folder("f1", {} as unknown as string)],
          } as unknown as LocalWorkspace,
          "structure"
        ),
      "parentId object"
    );
    expect(obj.message).toContain("INVALID_FOLDER_PARENT: type");
    const blank = expectThrows(
      () =>
        plan(
          emptyWs(),
          {
            ...emptyWs("owner-C"),
            folders: [folder("f1", " ")],
          } as unknown as LocalWorkspace,
          "structure"
        ),
      "parentId blank"
    );
    expect(blank.message).toContain("INVALID_FOLDER_PARENT: type");
  });

  // ---- D. relation errors leak no incoming value ----------------------
  it("R2-17. malicious unknown Template relation id does not appear in error", () => {
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("t1", "T")],
      templateVersions: [ver("v1", "C:\\Users\\ExampleUser\\SECRET-RELATION", "H")],
    } as unknown as LocalWorkspace;
    const e = expectThrows(
      () => plan(emptyWs(), incoming, "structure"),
      "malicious template relation"
    );
    expect(e.message).toContain("INVALID_RELATION: TemplateVersion.templateId");
    expect(e.message).not.toContain("C:\\Users\\ExampleUser\\SECRET-RELATION");
    expect(e.message.length).toBeLessThan(200);
  });

  it("R2-18. malicious Version / ImportRun / Folder relation ids do not appear in error", () => {
    const verErr = expectThrows(
      () =>
        plan(
          emptyWs(),
          {
            ...emptyWs("owner-C"),
            templates: [tpl("t1", "T")],
            templateVersions: [ver("v1", "C:\\x\\V", "H")],
          } as unknown as LocalWorkspace,
          "structure"
        ),
      "malicious version relation"
    );
    expect(verErr.message).toContain("INVALID_RELATION: TemplateVersion.templateId");
    expect(verErr.message).not.toContain("C:\\x\\V");

    const runErr = expectThrows(
      () =>
        plan(
          emptyWs(),
          {
            ...emptyWs("owner-C"),
            templates: [tpl("t1", "T")],
            templateVersions: [ver("v1", "t1", "H")],
            importRuns: [importRun("ir1", "C:\\x\\RUN", "a2")],
          } as unknown as LocalWorkspace,
          "structure"
        ),
      "malicious importrun relation"
    );
    expect(runErr.message).toContain("INVALID_RELATION: ImportRun.templateVersionId");
    expect(runErr.message).not.toContain("C:\\x\\RUN");

    const folderErr = expectThrows(
      () =>
        plan(
          emptyWs(),
          {
            ...emptyWs("owner-C"),
            folders: [folder("f1", "C:\\x\\PARENT")],
          } as unknown as LocalWorkspace,
          "structure"
        ),
      "malicious folder relation"
    );
    expect(folderErr.message).toContain("INVALID_FOLDER_PARENT: unknown");
    expect(folderErr.message).not.toContain("C:\\x\\PARENT");
  });

  it("R2-19. malicious duplicate record id does not appear in error", () => {
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [
        tpl("C:\\Users\\ExampleUser\\DUP-RELATION", "Alpha"),
        tpl("C:\\Users\\ExampleUser\\DUP-RELATION", "Beta"),
      ],
    } as unknown as LocalWorkspace;
    const e = expectThrows(
      () => plan(emptyWs(), incoming, "structure"),
      "malicious duplicate id"
    );
    expect(e.message).toContain("DUPLICATE_ID: Template");
    expect(e.message).not.toContain("C:\\Users\\ExampleUser\\DUP-RELATION");
    expect(e.message.length).toBeLessThan(200);
  });

  // ---- Section 四 / 五.21: global output id uniqueness + typed audit ----
  it("R2-20. all output record ids are globally unique (real assertion)", () => {
    function richAll(): LocalWorkspace {
      return {
        ...emptyWs("owner-C"),
        templates: [tpl("it1", "T", { folderIds: ["ifA"], tagIds: ["itA"] })],
        templateVersions: [
          ver("iv1", "it1", "H", { pageManifest: { pages: [{ assetId: "pa" }] } }),
          ver("iv2", "it1", "H2"),
        ],
        fields: [fld("if1", "iv1", "s1"), fld("if2", "iv2", "s2")],
        instances: [
          inst("ii1", "it1", "iv1", { outputHistory: [{ assetId: "ia" }] }),
          inst("ii2", "it1", "iv2"),
        ],
        savedValues: [savedValue("isv", "it1", "s1", "V")],
        mappingTemplates: [mapping("imt", "iv1", "it1")],
        importRuns: [importRun("ir1", "iv1", "a2")],
        importRows: [importRow("irow", "ir1", "ii1")],
        mappingDecisions: [mappingDecision("imd", "ir1", { templateVersionId: "iv1" })],
        detectionRuns: [detection("idr", "iv1"), detection("idr2", "iv2")],
        folders: [folder("ifA", null)],
        tags: [tag("itA")],
      } as unknown as LocalWorkspace;
    }
    const r = plan(emptyWs(), richAll(), "duplicate");
    const merged = r.mergedWorkspace;
    const all: string[] = [];
    for (const arr of [
      merged.templates,
      merged.templateVersions,
      merged.fields,
      merged.instances,
      merged.folders,
      merged.tags,
      merged.savedValues,
      merged.mappingTemplates,
      merged.importRuns,
      merged.importRows,
      merged.mappingDecisions,
      merged.detectionRuns,
    ]) {
      for (const rec of arr as Rec[]) all.push(rec.id as string);
    }
    expect(new Set(all).size).toBe(all.length);
  });

  // ---- Section 五.22: immutability + determinism still hold -----------
  it("R2-21. current / incoming immutability and deterministic output hold", () => {
    const current = {
      ...emptyWs(),
      templates: [tpl("t1", "Alpha")],
      templateVersions: [ver("v1", "t1", "H")],
      instances: [inst("i1", "t1", "v1")],
    } as unknown as LocalWorkspace;
    const incoming = {
      ...emptyWs("owner-C"),
      templates: [tpl("it1", "Alpha")],
      templateVersions: [ver("iv1", "it1", "H2")],
      fields: [fld("if1", "iv1", "s1")],
    } as unknown as LocalWorkspace;
    const snapCurrent = JSON.stringify(current);
    const snapIncoming = JSON.stringify(incoming);
    const a = plan(current, incoming, "structure");
    const b = plan(current, incoming, "structure");
    expect(JSON.stringify(current)).toBe(snapCurrent);
    expect(JSON.stringify(incoming)).toBe(snapIncoming);
    expect(JSON.stringify(a.mergedWorkspace)).toBe(JSON.stringify(b.mergedWorkspace));
  });
});
