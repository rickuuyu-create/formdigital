/** 長期資料契約提醒：Backup 必須可在未接觸資料庫前驗證 manifest 及每個 bytes 的 hash。 */
import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, zipSync } from "fflate";
import {
  createBackupArchive,
  createBackupImportPreview,
  verifyBackupArchive,
} from "./assetStore";
import { sha256 } from "./domain";

describe("formdigital backup archive", () => {
  it("creates an archive that verifies all records and assets", () => {
    const record = [{ id: "tpl_1", name: "Long-life form" }];
    const photo = new Uint8Array([1, 2, 3, 4]);
    const manifest = {
      format: "formdigital-backup" as const,
      schemaVersion: 1,
      createdAt: 1_700_000_000_000,
      ownerId: 7,
      records: { templates: { path: "records/templates.json", contentHash: sha256(new TextEncoder().encode(JSON.stringify(record))), count: 1 } },
      assets: [{ id: "asset_1", path: "assets/abc", contentHash: sha256(photo), mimeType: "image/png", sizeBytes: 4 }],
    };
    const archive = createBackupArchive(manifest, { templates: record }, { "assets/abc": photo });
    expect(verifyBackupArchive(archive)).toMatchObject({ ownerId: 7, format: "formdigital-backup" });
  });

  it("rejects a corrupted archive", () => {
    const bytes = new Uint8Array([10, 20, 30]);
    expect(() => verifyBackupArchive(bytes)).toThrow();
  });
});

/** Layer 2C1：Portable Backup 嚴格唯讀驗證、匯入前預覽最小化、惡意 archive 拒絕。
 *  所有 fixture 完全在記憶體內建立，不寫入真實 backup／資料目錄。 */
describe("formdigital portable backup strict verification", () => {
  const OWNER = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const SECRET = "SUPERSECRETINJECTEDTOKEN-X9F";

  type PortableParts = {
    manifest: Record<string, unknown>;
    entries: Record<string, Uint8Array>;
    ownerKeyHash: string;
    objectHash: string;
    assetId: string;
  };

  function buildPortableParts(overrides: Record<string, unknown> = {}): PortableParts {
    const ownerKeyHash = (overrides.ownerKeyHash as string) ?? OWNER;
    const scope = (overrides.scope as "account" | "template") ?? "account";
    const templateId = "templateId" in overrides ? (overrides.templateId as string | null) : null;
    const assetId = (overrides.assetId as string) ?? "asset_preview_1";
    const objectBytes = (overrides.objectBytes as Uint8Array) ?? new Uint8Array([1, 2, 3, 4]);
    const objectHash = sha256(objectBytes);
    const assetManifest = {
      schemaVersion: 1,
      id: assetId,
      ownerKeyHash,
      contentHash: objectHash,
      size: objectBytes.byteLength,
    };
    const assetManifestBytes = strToU8(JSON.stringify(assetManifest));
    const scopedTemplateId = scope === "template" ? templateId : "tpl_1";
    const workspaceEnvelope = {
      workspace: {
        templates: [{ id: scopedTemplateId, name: "Long-life form" }],
        templateVersions: [{ id: "ver_1", templateId: scopedTemplateId }],
        fields: [],
        instances: [],
        savedValues: [],
        mappingTemplates: [],
      },
    };
    const workspaceBytes = strToU8(JSON.stringify(workspaceEnvelope));
    const summary =
      (overrides.summary as Record<string, unknown>) ?? {
        templates: [{ id: scopedTemplateId, name: "Long-life form", versions: 1, instances: 0 }],
        templateCount: 1,
        versionCount: 1,
        instanceCount: 0,
        mappingTemplateCount: 0,
      };
    const files = [
      {
        path: "account/workspace.json",
        contentHash: sha256(workspaceBytes),
        size: workspaceBytes.byteLength,
      },
      {
        path: `manifests/${assetId}.json`,
        contentHash: sha256(assetManifestBytes),
        size: assetManifestBytes.byteLength,
      },
      {
        path: `objects/${objectHash}`,
        contentHash: objectHash,
        size: objectBytes.byteLength,
      },
    ];
    const manifest: Record<string, unknown> = {
      format: "formdigital-portable-backup",
      schemaVersion: 1,
      createdAt: 1_700_000_000_000,
      ownerKeyHash,
      scope,
      templateId,
      files,
      summary,
    };
    for (const [k, v] of Object.entries(overrides.extraManifestFields ?? {}))
      manifest[k] = v;
    const entries: Record<string, Uint8Array> = {
      "account/workspace.json": workspaceBytes,
      [`manifests/${assetId}.json`]: assetManifestBytes,
      [`objects/${objectHash}`]: objectBytes,
    };
    for (const [k, v] of Object.entries(overrides.extraEntries ?? {}))
      entries[k] = v as Uint8Array;
    return { manifest, entries, ownerKeyHash, objectHash, assetId };
  }

  function makeArchive(parts: PortableParts): Uint8Array {
    return zipSync(
      { ...parts.entries, "backup-manifest.json": strToU8(JSON.stringify(parts.manifest)) },
      { level: 6 }
    );
  }

  function deepForbiddenScan(value: unknown, forbidden: string[]): boolean {
    if (typeof value === "string")
      return forbidden.some(f => value.includes(f));
    if (Array.isArray(value))
      return value.some(v => deepForbiddenScan(v, forbidden));
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        if (forbidden.some(f => k.includes(f))) return true;
        if (deepForbiddenScan(v, forbidden)) return true;
      }
    }
    return false;
  }

  it("accepts a valid account-scoped Portable Backup", () => {
    const parts = buildPortableParts();
    const manifest = verifyBackupArchive(makeArchive(parts));
    expect(manifest.scope).toBe("account");
    expect(manifest.ownerKeyHash).toBe(OWNER);
  });

  it("accepts a valid template-scoped Portable Backup", () => {
    const parts = buildPortableParts({ scope: "template", templateId: "tpl_preview" });
    const manifest = verifyBackupArchive(makeArchive(parts));
    expect(manifest.scope).toBe("template");
    expect(manifest.templateId).toBe("tpl_preview");
  });

  it("produces a sanitized preview with correct statistics", () => {
    const parts = buildPortableParts();
    const manifest = verifyBackupArchive(makeArchive(parts));
    const preview = createBackupImportPreview(manifest);
    expect(preview.schemaVersion).toBe(1);
    expect(preview.scope).toBe("account");
    expect(preview.summary?.templateCount).toBe(1);
    expect(preview.summary?.versionCount).toBe(1);
    expect(preview.summary?.instanceCount).toBe(0);
    expect(preview.summary?.mappingTemplateCount).toBe(0);
    expect(preview.summary?.templates[0]).toMatchObject({
      id: "tpl_1",
      name: "Long-life form",
      versions: 1,
      instances: 0,
    });
  });

  it("still accepts the legacy formdigital-backup and previews safely", () => {
    const record = [{ id: "tpl_1", name: "Long-life form" }];
    const photo = new Uint8Array([1, 2, 3, 4]);
    const legacyManifest = {
      format: "formdigital-backup" as const,
      schemaVersion: 1,
      createdAt: 1_700_000_000_000,
      ownerId: 7,
      records: {
        templates: {
          path: "records/templates.json",
          contentHash: sha256(new TextEncoder().encode(JSON.stringify(record))),
          count: 1,
        },
      },
      assets: [
        {
          id: "asset_1",
          path: "assets/abc",
          contentHash: sha256(photo),
          mimeType: "image/png",
          sizeBytes: 4,
        },
      ],
    };
    const archive = createBackupArchive(
      legacyManifest,
      { templates: record },
      { "assets/abc": photo }
    );
    const manifest = verifyBackupArchive(archive);
    expect(manifest.format).toBe("formdigital-backup");
    const preview = createBackupImportPreview(manifest);
    expect(preview.scope).toBeUndefined();
    expect(JSON.stringify(preview)).not.toContain("ownerKeyHash");
    expect(JSON.stringify(preview)).not.toContain("records");
  });

  // --- archive 結構拒絕 ---
  it("rejects corrupted zip bytes", () => {
    expect(() => verifyBackupArchive(new Uint8Array([1, 2, 3, 4, 5]))).toThrow();
  });

  it("rejects a missing backup-manifest.json", () => {
    const parts = buildPortableParts();
    const { "backup-manifest.json": _drop, ...entries } = {
      ...parts.entries,
      "backup-manifest.json": strToU8(JSON.stringify(parts.manifest)),
    };
    void _drop;
    expect(() => verifyBackupArchive(zipSync(entries, { level: 6 }))).toThrow();
  });

  it("rejects corrupted manifest JSON", () => {
    const parts = buildPortableParts();
    const bytes = zipSync(
      { ...parts.entries, "backup-manifest.json": strToU8("{not-json") },
      { level: 6 }
    );
    expect(() => verifyBackupArchive(bytes)).toThrow();
  });

  it("rejects an unsupported format", () => {
    const parts = buildPortableParts();
    parts.manifest.format = "formdigital-portable-backup-2";
    expect(() => verifyBackupArchive(makeArchive(parts))).toThrow();
  });

  it("rejects an unsupported schemaVersion", () => {
    const parts = buildPortableParts();
    parts.manifest.schemaVersion = 2;
    expect(() => verifyBackupArchive(makeArchive(parts))).toThrow();
  });

  it("rejects a non-array files list", () => {
    const parts = buildPortableParts();
    parts.manifest.files = "not-an-array";
    expect(() => verifyBackupArchive(makeArchive(parts))).toThrow();
  });

  it("rejects a missing account/workspace.json", () => {
    const parts = buildPortableParts();
    const { "account/workspace.json": _drop, ...entries } = parts.entries;
    void _drop;
    parts.manifest.files = (parts.manifest.files as Array<Record<string, unknown>>).filter(
      (f) => f.path !== "account/workspace.json"
    );
    expect(() =>
      verifyBackupArchive(zipSync({ ...entries, "backup-manifest.json": strToU8(JSON.stringify(parts.manifest)) }, { level: 6 }))
    ).toThrow();
  });

  it("rejects a duplicate file path", () => {
    const parts = buildPortableParts();
    const files = parts.manifest.files as Array<Record<string, unknown>>;
    parts.manifest.files = [...files, files[0]];
    expect(() => verifyBackupArchive(makeArchive(parts))).toThrow();
  });

  it("rejects an extra ZIP entry not listed in the manifest", () => {
    const parts = buildPortableParts();
    parts.entries["evil.txt"] = strToU8("pwned");
    expect(() => verifyBackupArchive(makeArchive(parts))).toThrow();
  });

  it("rejects a manifest entry that is missing from the ZIP", () => {
    const parts = buildPortableParts();
    const files = parts.manifest.files as Array<Record<string, unknown>>;
    files.push({ path: "objects/".concat("a".repeat(64)), contentHash: "a".repeat(64), size: 4 });
    expect(() => verifyBackupArchive(makeArchive(parts))).toThrow();
  });

  it("rejects a size mismatch", () => {
    const parts = buildPortableParts();
    const files = parts.manifest.files as Array<Record<string, unknown>>;
    files[0].size = (files[0].size as number) + 1;
    expect(() => verifyBackupArchive(makeArchive(parts))).toThrow();
  });

  it("rejects a content-hash mismatch", () => {
    const parts = buildPortableParts();
    const files = parts.manifest.files as Array<Record<string, unknown>>;
    files[0].contentHash = "b".repeat(64);
    expect(() => verifyBackupArchive(makeArchive(parts))).toThrow();
  });

  it("rejects an object path whose basename disagrees with its bytes", () => {
    const parts = buildPortableParts();
    const differentHash = "c".repeat(64);
    const files = parts.manifest.files as Array<Record<string, unknown>>;
    files[2].path = `objects/${differentHash}`;
    parts.entries[`objects/${differentHash}`] = parts.entries["objects/".concat(parts.objectHash)];
    delete parts.entries["objects/".concat(parts.objectHash)];
    expect(() => verifyBackupArchive(makeArchive(parts))).toThrow();
  });

  it("rejects a ../ traversal path", () => {
    const parts = buildPortableParts();
    const files = parts.manifest.files as Array<Record<string, unknown>>;
    files.push({ path: "../escape.json", contentHash: "d".repeat(64), size: 4 });
    parts.entries["../escape.json"] = strToU8("{}");
    expect(() => verifyBackupArchive(makeArchive(parts))).toThrow();
  });

  it("rejects a backslash traversal path", () => {
    const parts = buildPortableParts();
    const files = parts.manifest.files as Array<Record<string, unknown>>;
    files.push({ path: "account\\evil.json", contentHash: "e".repeat(64), size: 4 });
    parts.entries["account\\evil.json"] = strToU8("{}");
    expect(() => verifyBackupArchive(makeArchive(parts))).toThrow();
  });

  it("rejects an absolute, drive or UNC path", () => {
    for (const bad of ["/etc/passwd", "C:\\windows\\x", "//server/share/x", "D:/x"]) {
      const parts = buildPortableParts();
      const files = parts.manifest.files as Array<Record<string, unknown>>;
      files.push({ path: bad, contentHash: "f".repeat(64), size: 4 });
      parts.entries[bad] = strToU8("{}");
      expect(() => verifyBackupArchive(makeArchive(parts))).toThrow();
    }
  });

  it("rejects an unsupported top-level directory", () => {
    const parts = buildPortableParts();
    const files = parts.manifest.files as Array<Record<string, unknown>>;
    files.push({ path: "secrets/key.json", contentHash: "a".repeat(64), size: 4 });
    parts.entries["secrets/key.json"] = strToU8("{}");
    expect(() => verifyBackupArchive(makeArchive(parts))).toThrow();
  });

  it("rejects a NUL, URL or empty-segment path", () => {
    for (const bad of ["objects/\0/x", "http://evil/x", "objects//x", "account/"]) {
      const parts = buildPortableParts();
      const files = parts.manifest.files as Array<Record<string, unknown>>;
      files.push({ path: bad, contentHash: "a".repeat(64), size: 4 });
      parts.entries[bad] = strToU8("{}");
      expect(() => verifyBackupArchive(makeArchive(parts))).toThrow();
    }
  });

  it("rejects a malformed file descriptor type", () => {
    const parts = buildPortableParts();
    parts.manifest.files = [{ path: 123, contentHash: "a".repeat(64), size: 4 }];
    expect(() => verifyBackupArchive(makeArchive(parts))).toThrow();
    const parts2 = buildPortableParts();
    parts2.manifest.files = "definitely-not-array";
    expect(() => verifyBackupArchive(makeArchive(parts2))).toThrow();
  });

  // --- scope / Workspace / asset 關聯拒絕 ---
  it("rejects account scope carrying a templateId", () => {
    const parts = buildPortableParts({ scope: "account", templateId: "tpl_x" });
    expect(() => verifyBackupArchive(makeArchive(parts))).toThrow();
  });

  it("rejects template scope missing a templateId", () => {
    const parts = buildPortableParts({ scope: "template", templateId: null });
    expect(() => verifyBackupArchive(makeArchive(parts))).toThrow();
  });

  it("rejects a malformed ownerKeyHash", () => {
    const parts = buildPortableParts({ ownerKeyHash: "not-a-hash" });
    expect(() => verifyBackupArchive(makeArchive(parts))).toThrow();
  });

  it("rejects an ownerKeyHash whose case would fail the Local Service owner boundary", () => {
    const parts = buildPortableParts({ ownerKeyHash: OWNER.toUpperCase() });
    expect(() => verifyBackupArchive(makeArchive(parts))).toThrow();
  });

  it("rejects a non-scalar createdAt before it can enter the preview", () => {
    const parts = buildPortableParts({
      extraManifestFields: { createdAt: { leakedPath: "C:\\secret" } },
    });
    expect(() => verifyBackupArchive(makeArchive(parts))).toThrow();
  });

  it("rejects an unparseable createdAt string before it can leak through preview", () => {
    const parts = buildPortableParts({
      extraManifestFields: { createdAt: "C:\\Users\\victim\\backup" },
    });
    expect(() => verifyBackupArchive(makeArchive(parts))).toThrow();
  });

  it("rejects an unsupported asset manifest schema version", () => {
    const parts = buildPortableParts();
    const assetPath = `manifests/${parts.assetId}.json`;
    const asset = JSON.parse(strFromU8(parts.entries[assetPath]));
    asset.schemaVersion = 2;
    const bytes = strToU8(JSON.stringify(asset));
    parts.entries[assetPath] = bytes;
    const descriptor = (parts.manifest.files as Array<Record<string, unknown>>)
      .find(file => file.path === assetPath)!;
    descriptor.size = bytes.byteLength;
    descriptor.contentHash = sha256(bytes);
    expect(() => verifyBackupArchive(makeArchive(parts))).toThrow();
  });

  it("rejects a type-valid summary that understates the Workspace contents", () => {
    const parts = buildPortableParts({
      summary: {
        templates: [],
        templateCount: 0,
        versionCount: 0,
        instanceCount: 0,
        mappingTemplateCount: 0,
      },
    });
    expect(() => verifyBackupArchive(makeArchive(parts))).toThrow();
  });

  it("rejects a template scope whose templateId differs from the Workspace", () => {
    const parts = buildPortableParts({ scope: "template", templateId: "tpl_preview" });
    const workspacePath = "account/workspace.json";
    const envelope = JSON.parse(strFromU8(parts.entries[workspacePath]));
    envelope.workspace.templates[0].id = "tpl_other";
    envelope.workspace.templateVersions[0].templateId = "tpl_other";
    const bytes = strToU8(JSON.stringify(envelope));
    parts.entries[workspacePath] = bytes;
    const descriptor = (parts.manifest.files as Array<Record<string, unknown>>)
      .find(file => file.path === workspacePath)!;
    descriptor.size = bytes.byteLength;
    descriptor.contentHash = sha256(bytes);
    parts.manifest.summary = {
      templates: [{ id: "tpl_other", name: "Long-life form", versions: 1, instances: 0 }],
      templateCount: 1,
      versionCount: 1,
      instanceCount: 0,
      mappingTemplateCount: 0,
    };
    expect(() => verifyBackupArchive(makeArchive(parts))).toThrow();
  });

  it("rejects corrupted workspace JSON", () => {
    const parts = buildPortableParts();
    parts.entries["account/workspace.json"] = strToU8("{broken");
    expect(() => verifyBackupArchive(makeArchive(parts))).toThrow();
  });

  it("rejects a non-object workspace envelope", () => {
    const parts = buildPortableParts();
    parts.entries["account/workspace.json"] = strToU8(JSON.stringify([1, 2, 3]));
    expect(() => verifyBackupArchive(makeArchive(parts))).toThrow();
  });

  it("rejects corrupted asset manifest JSON", () => {
    const parts = buildPortableParts();
    parts.entries[`manifests/${parts.assetId}.json`] = strToU8("{bad");
    expect(() => verifyBackupArchive(makeArchive(parts))).toThrow();
  });

  it("rejects asset manifest owner mismatch", () => {
    const parts = buildPortableParts();
    const assetPath = `manifests/${parts.assetId}.json`;
    const bad = {
      schemaVersion: 1,
      id: parts.assetId,
      ownerKeyHash: "z".repeat(64),
      contentHash: parts.objectHash,
      size: 4,
    };
    parts.entries[assetPath] = strToU8(JSON.stringify(bad));
    expect(() => verifyBackupArchive(makeArchive(parts))).toThrow();
  });

  it("rejects asset manifest pointing to an unlisted object", () => {
    const parts = buildPortableParts();
    const assetPath = `manifests/${parts.assetId}.json`;
    const bad = {
      schemaVersion: 1,
      id: parts.assetId,
      ownerKeyHash: OWNER,
      contentHash: "9".repeat(64),
      size: 4,
    };
    parts.entries[assetPath] = strToU8(JSON.stringify(bad));
    expect(() => verifyBackupArchive(makeArchive(parts))).toThrow();
  });

  it("rejects manifest filename inconsistent with its id", () => {
    const parts = buildPortableParts();
    const assetPath = `manifests/${parts.assetId}.json`;
    const bytes = parts.entries[assetPath];
    delete parts.entries[assetPath];
    parts.entries["manifests/different.json"] = bytes;
    const files = parts.manifest.files as Array<Record<string, unknown>>;
    files[1].path = "manifests/different.json";
    expect(() => verifyBackupArchive(makeArchive(parts))).toThrow();
  });

  it("rejects asset size/contentHash inconsistent with its object", () => {
    const parts = buildPortableParts();
    const assetPath = `manifests/${parts.assetId}.json`;
    const bad = {
      schemaVersion: 1,
      id: parts.assetId,
      ownerKeyHash: OWNER,
      contentHash: parts.objectHash,
      size: 999,
    };
    parts.entries[assetPath] = strToU8(JSON.stringify(bad));
    expect(() => verifyBackupArchive(makeArchive(parts))).toThrow();
  });

  it("rejects a non-array summary.templates", () => {
    const parts = buildPortableParts({
      summary: {
        templates: "nope",
        templateCount: 1,
        versionCount: 1,
        instanceCount: 0,
        mappingTemplateCount: 0,
      },
    });
    expect(() => verifyBackupArchive(makeArchive(parts))).toThrow();
  });

  it("rejects invalid summary counts", () => {
    for (const badCount of [-1, 1.5, NaN]) {
      const parts = buildPortableParts({
        summary: {
          templates: [{ id: "tpl_1", name: "x", versions: 1, instances: 0 }],
          templateCount: badCount,
          versionCount: 1,
          instanceCount: 0,
          mappingTemplateCount: 0,
        },
      });
      expect(() => verifyBackupArchive(makeArchive(parts))).toThrow();
    }
  });

  it("rejects a malformed template preview item", () => {
    const parts = buildPortableParts({
      summary: {
        templates: [{ id: 123, name: "x", versions: 1, instances: 0 }],
        templateCount: 1,
        versionCount: 1,
        instanceCount: 0,
        mappingTemplateCount: 0,
      },
    });
    expect(() => verifyBackupArchive(makeArchive(parts))).toThrow();
  });

  // --- preview 最小化 ---
  it("preview does not include ownerKeyHash", () => {
    const parts = buildPortableParts();
    const preview = createBackupImportPreview(verifyBackupArchive(makeArchive(parts)));
    expect("ownerKeyHash" in preview).toBe(false);
    expect(JSON.stringify(preview)).not.toContain(OWNER);
  });

  it("preview does not include files", () => {
    const parts = buildPortableParts();
    const preview = createBackupImportPreview(verifyBackupArchive(makeArchive(parts)));
    expect("files" in preview).toBe(false);
  });

  it("preview does not include hashes, paths, assets or records", () => {
    const parts = buildPortableParts();
    const serialized = JSON.stringify(createBackupImportPreview(verifyBackupArchive(makeArchive(parts))));
    for (const forbidden of ["ownerKeyHash", "contentHash", "files", "assets", "records", "objects/", "manifests/"])
      expect(serialized).not.toContain(forbidden);
  });

  it("recursive scan proves no injected owner hash, secret or Windows path leaks", () => {
    const parts = buildPortableParts({
      extraManifestFields: { secretToken: SECRET, leakedPath: "C:\\Users\\victim\\data" },
    });
    const preview = createBackupImportPreview(verifyBackupArchive(makeArchive(parts)));
    expect(deepForbiddenScan(preview, [OWNER, SECRET, "C:\\", "\\"])).toBe(false);
  });

  it("verifier error messages do not echo malicious path, hash or owner values", () => {
    const parts = buildPortableParts({ scope: "account", templateId: "tpl_echo" });
    let message = "";
    try {
      verifyBackupArchive(makeArchive(parts));
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain(OWNER);
    expect(message).not.toContain("tpl_echo");
    expect(message).not.toContain("\\");
  });
});
