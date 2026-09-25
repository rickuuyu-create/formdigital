export type ImportRollbackTarget = {
  kind: "template" | "asset";
  id: string;
};

export type ImportRollbackDeps = {
  deleteTemplate: (templateId: string) => Promise<unknown>;
  deleteAsset: (assetId: string) => Promise<unknown>;
  listTemplateIds: () => Promise<string[]>;
  listAssetIds: () => Promise<string[]>;
};

export type ImportRollbackResult = {
  /** True only when a fresh query proved nothing from this import survives. */
  verified: boolean;
  /** How many recorded targets could still be present. */
  remaining: number;
};

export const IMPORT_ROLLBACK_ATTEMPTS = 3;

/**
 * Undo everything a failed or cancelled import created, newest first, then
 * prove it by re-reading the workspace. A delete that throws is retried a
 * bounded number of times and, if it still fails, reported instead of being
 * swallowed — the caller must not tell anyone the workspace is clean unless
 * `verified` is true.
 */
export async function rollbackImport(
  targets: ImportRollbackTarget[],
  deps: ImportRollbackDeps,
  attempts = IMPORT_ROLLBACK_ATTEMPTS
): Promise<ImportRollbackResult> {
  const pending = [...targets].reverse();
  if (!pending.length) return { verified: true, remaining: 0 };
  let outstanding = pending;
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    for (const target of outstanding) {
      try {
        if (target.kind === "template") await deps.deleteTemplate(target.id);
        else await deps.deleteAsset(target.id);
      } catch {
        // The verification pass below decides whether this actually mattered.
      }
    }
    let templateIds: string[];
    let assetIds: string[];
    try {
      templateIds = await deps.listTemplateIds();
      assetIds = await deps.listAssetIds();
    } catch {
      continue;
    }
    const survivingTemplates = new Set(templateIds);
    const survivingAssets = new Set(assetIds);
    outstanding = outstanding.filter(target =>
      target.kind === "template"
        ? survivingTemplates.has(target.id)
        : survivingAssets.has(target.id)
    );
    if (!outstanding.length) return { verified: true, remaining: 0 };
  }
  return { verified: false, remaining: outstanding.length };
}
