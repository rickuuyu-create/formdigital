import { describe, expect, it, vi } from "vitest";
import { rollbackImport } from "./import-rollback";

function workspace(templateIds: string[], assetIds: string[]) {
  const templates = new Set(templateIds);
  const assets = new Set(assetIds);
  return {
    templates,
    assets,
    deps: {
      deleteTemplate: vi.fn(async (id: string) => {
        templates.delete(id);
      }),
      deleteAsset: vi.fn(async (id: string) => {
        assets.delete(id);
      }),
      listTemplateIds: async () => [...templates],
      listAssetIds: async () => [...assets],
    },
  };
}

describe("failed import rollback", () => {
  it("removes everything the import created, newest first, and proves it", async () => {
    const state = workspace(["tpl-1", "tpl-keep"], [
      "asset-1",
      "asset-2",
      "asset-keep",
    ]);

    const result = await rollbackImport(
      [
        { kind: "template", id: "tpl-1" },
        { kind: "asset", id: "asset-1" },
        { kind: "asset", id: "asset-2" },
      ],
      state.deps
    );

    expect(result).toEqual({ verified: true, remaining: 0 });
    expect([...state.templates]).toEqual(["tpl-keep"]);
    expect([...state.assets]).toEqual(["asset-keep"]);
    expect(state.deps.deleteAsset.mock.calls.map(call => call[0])).toEqual([
      "asset-2",
      "asset-1",
    ]);
  });

  it("retries a transient failure and still verifies the workspace", async () => {
    const state = workspace(["tpl-1"], ["asset-1"]);
    let attempts = 0;
    const deps = {
      ...state.deps,
      deleteAsset: vi.fn(async (id: string) => {
        attempts += 1;
        if (attempts === 1) throw new Error("TRANSIENT");
        state.assets.delete(id);
      }),
    };

    const result = await rollbackImport(
      [
        { kind: "template", id: "tpl-1" },
        { kind: "asset", id: "asset-1" },
      ],
      deps
    );

    expect(result).toEqual({ verified: true, remaining: 0 });
    expect(attempts).toBe(2);
    expect([...state.assets]).toEqual([]);
  });

  it("reports an unverified rollback instead of claiming a clean workspace", async () => {
    const state = workspace(["tpl-1"], ["asset-1"]);
    const deps = {
      ...state.deps,
      deleteAsset: vi.fn(async () => {
        throw new Error("PERMANENT");
      }),
    };

    const result = await rollbackImport(
      [
        { kind: "template", id: "tpl-1" },
        { kind: "asset", id: "asset-1" },
      ],
      deps
    );

    expect(result.verified).toBe(false);
    expect(result.remaining).toBe(1);
    expect([...state.templates]).toEqual([]);
  });

  it("does not claim success when the workspace cannot be re-read", async () => {
    const state = workspace(["tpl-1"], []);
    const result = await rollbackImport([{ kind: "template", id: "tpl-1" }], {
      ...state.deps,
      listTemplateIds: async () => {
        throw new Error("SERVICE_DOWN");
      },
    });

    expect(result.verified).toBe(false);
    expect(result.remaining).toBe(1);
  });

  it("treats an import that created nothing as already clean", async () => {
    const state = workspace([], []);
    await expect(rollbackImport([], state.deps)).resolves.toEqual({
      verified: true,
      remaining: 0,
    });
    expect(state.deps.deleteTemplate).not.toHaveBeenCalled();
  });
});
