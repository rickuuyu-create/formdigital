import { beforeEach, describe, expect, it, vi } from "vitest";
import { strToU8, zipSync } from "fflate";
import { sha256 } from "./domain";

const mocks = vi.hoisted(() => ({
  readWorkspace: vi.fn(),
  restoreLocalBackup: vi.fn(),
  saveLocalWorkspace: vi.fn(),
}));

vi.mock("./workspaceStore", () => ({
  readWorkspace: mocks.readWorkspace,
}));

vi.mock("./localServiceClient", () => ({
  commitLocalPortableRestoreSession: vi.fn(),
  createLocalBackup: vi.fn(),
  createLocalStreamingBackup: vi.fn(),
  deleteLocalAsset: vi.fn(),
  listLocalAssets: vi.fn(),
  loadLocalAsset: vi.fn(),
  restoreLocalBackup: mocks.restoreLocalBackup,
  saveLocalWorkspace: mocks.saveLocalWorkspace,
  storeLocalAsset: vi.fn(),
}));

import { restoreVerifiedBackup } from "./assetStore";

function duplicateArchiveWithInstance() {
  const workspace = {
    templates: [{
      id: "template-synthetic",
      name: "Synthetic Template",
      currentPublishedVersionId: "version-synthetic",
      currentDraftVersionId: null,
    }],
    templateVersions: [{
      id: "version-synthetic",
      templateId: "template-synthetic",
      contentHash: "content-synthetic",
    }],
    fields: [],
    instances: [{
      id: "instance-synthetic",
      templateId: "template-synthetic",
      templateVersionId: "version-synthetic",
      name: "Synthetic Instance",
    }],
    savedValues: [],
    mappingTemplates: [],
  };
  const workspaceBytes = strToU8(JSON.stringify({ revision: 1, workspace }));
  const files = [{
    path: "account/workspace.json",
    contentHash: sha256(workspaceBytes),
    size: workspaceBytes.byteLength,
  }];
  const manifest = {
    format: "formdigital-portable-backup",
    schemaVersion: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    ownerKeyHash: "a".repeat(64),
    scope: "template",
    templateId: "template-synthetic",
    files,
    summary: {
      templates: [{
        id: "template-synthetic",
        name: "Synthetic Template",
        versions: 1,
        instances: 1,
      }],
      templateCount: 1,
      versionCount: 1,
      instanceCount: 1,
      mappingTemplateCount: 0,
    },
  };
  return zipSync({
    "account/workspace.json": workspaceBytes,
    "backup-manifest.json": strToU8(JSON.stringify(manifest)),
  });
}

describe("projected Workspace legacy duplicate safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readWorkspace.mockResolvedValue({
      revision: 9,
      workspace: {
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
        preferences: {
          __formdigitalWorkspaceV2: { layout: "v2-authoritative-high-growth" },
        },
      },
    });
  });

  it("rejects before installing assets or saving split-brain Instances", async () => {
    await expect(
      restoreVerifiedBackup("synthetic-owner", duplicateArchiveWithInstance(), "duplicate")
    ).rejects.toThrow("無法以舊式建立副本流程");
    expect(mocks.restoreLocalBackup).not.toHaveBeenCalled();
    expect(mocks.saveLocalWorkspace).not.toHaveBeenCalled();
  });
});
