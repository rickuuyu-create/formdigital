import { useEffect, useMemo, useRef, useState } from "react";
import {
  DatabaseBackup,
  FolderCog,
  HardDrive,
  Languages,
  LogOut,
  Moon,
  Plus,
  ScanSearch,
  ShieldCheck,
  Sun,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { useTheme } from "@/contexts/ThemeContext";
import { blobToBase64, downloadBlob } from "@/lib/document-files";
import { normalizeUiLocale, useI18n } from "@/lib/i18n";
import { trpc } from "@/lib/trpc";
import { LOCAL_EDITION } from "@/lib/local-edition";
import type {
  FolderRecord,
  TagRecord,
  TemplateRecord,
} from "@/lib/product-types";

type BackupManifest = {
  createdAt?: string | number;
  scope?: "account" | "template";
  templateId?: string | null;
  summary?: {
    templates?: Array<{
      id: string;
      name: string;
      versions: number;
      instances: number;
    }>;
    templateCount?: number;
    versionCount?: number;
    instanceCount?: number;
    mappingTemplateCount?: number;
  };
  files?: unknown[];
};

type SelectedBackup =
  | {
      transport: "stream";
      sessionId: string;
      expiresAt: string;
      manifest: BackupManifest;
      filename: string;
    }
  | {
      transport: "base64";
      base64: string;
      manifest: BackupManifest;
      filename: string;
    };

const LEGACY_BACKUP_MAX_BYTES = 32 * 1024 * 1024;

class PortableUploadError extends Error {
  constructor(readonly status: number) {
    super("Portable Backup upload failed.");
  }
}

async function uploadPortableBackup(file: File) {
  const response = await fetch("/api/local/portable-restore-sessions", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": "application/octet-stream",
      "x-formdigital-portable-restore": "1",
    },
    body: file,
  });
  if (!response.ok) throw new PortableUploadError(response.status);
  const result = (await response.json()) as {
    sessionId?: string;
    expiresAt?: string;
    manifest?: BackupManifest;
  };
  if (
    !result.manifest ||
    typeof result.sessionId !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(result.sessionId) ||
    typeof result.expiresAt !== "string"
  )
    throw new PortableUploadError(502);
  return {
    sessionId: result.sessionId,
    expiresAt: result.expiresAt,
    manifest: result.manifest,
  };
}

async function discardPortableBackupSession(sessionId: string) {
  await fetch(
    `/api/local/portable-restore-sessions/${encodeURIComponent(sessionId)}`,
    {
      method: "DELETE",
      credentials: "same-origin",
      headers: { "x-formdigital-portable-restore": "1" },
    }
  ).catch(() => undefined);
}

function downloadFromUrl(url: string, filename: string) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export function SettingsPanel({
  dataFolder,
  preferences,
  folders,
  tags,
  templates,
  onLogout,
  refresh,
}: {
  dataFolder: string;
  preferences: Record<string, unknown>;
  folders: FolderRecord[];
  tags: TagRecord[];
  templates: TemplateRecord[];
  onLogout: () => Promise<void>;
  refresh: () => void;
}) {
  const restoreInput = useRef<HTMLInputElement>(null);
  const { theme, toggleTheme } = useTheme();
  const { locale, setLocale, t, tr } = useI18n();
  const [folderPath, setFolderPath] = useState(dataFolder);
  const [newFolderParentId, setNewFolderParentId] = useState("");
  const [backup, setBackup] = useState<SelectedBackup | null>(null);
  const [backupTemplateId, setBackupTemplateId] = useState("account");
  const [restoreMode, setRestoreMode] = useState<
    "full" | "structure" | "duplicate"
  >("full");
  useEffect(() => {
    if (backup?.transport !== "stream") return;
    const sessionId = backup.sessionId;
    return () => {
      void discardPortableBackupSession(sessionId);
    };
  }, [backup]);
  const savePreferences = trpc.formdigital.preferences.useMutation();
  const moveFolder = trpc.formdigital.localData.move.useMutation();
  const integrity = trpc.formdigital.localData.integrity.useMutation();
  const createBackup = trpc.formdigital.backups.create.useMutation();
  const createStreamingBackup =
    trpc.formdigital.backups.createStream.useMutation();
  const verifyBackup = trpc.formdigital.backups.verify.useMutation();
  const restoreBackup = trpc.formdigital.backups.restore.useMutation();
  const restoreStreamingBackup =
    trpc.formdigital.backups.restoreStream.useMutation();
  const upsertFolder = trpc.formdigital.folders.upsert.useMutation();
  const deleteFolder = trpc.formdigital.folders.delete.useMutation();
  const upsertTag = trpc.formdigital.tags.upsert.useMutation();
  const deleteTag = trpc.formdigital.tags.delete.useMutation();
  const orderedFolders = useMemo(() => {
    const result: Array<FolderRecord & { depth: number }> = [];
    const visit = (parentId: string | null, depth: number) => {
      for (const folder of folders.filter(
        item => (item.parentId ?? null) === parentId
      )) {
        result.push({ ...folder, depth });
        visit(folder.id, depth + 1);
      }
    };
    visit(null, 0);
    for (const folder of folders)
      if (!result.some(item => item.id === folder.id))
        result.push({ ...folder, depth: 0 });
    return result;
  }, [folders]);
  const savePref = async (patch: Record<string, unknown>) => {
    await savePreferences.mutateAsync(patch);
    refresh();
  };
  const makeBackup = async () => {
    try {
      if (backupTemplateId === "account") {
        const result = await createStreamingBackup.mutateAsync();
        downloadFromUrl(result.downloadUrl, result.filename);
        toast.success(tr("已建立並驗證串流可攜備份檔", "Streaming portable backup created and verified"));
        return;
      }
      const result = await createBackup.mutateAsync({
        templateId: backupTemplateId,
      });
      const bytes = Uint8Array.from(atob(result.archiveBase64), character =>
        character.charCodeAt(0)
      );
      downloadBlob(
        new Blob([bytes], { type: "application/octet-stream" }),
        result.filename
      );
      toast.success(tr("已建立並驗證單一可攜備份檔", "Template backup created and verified"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tr("備份失敗", "Backup failed"));
    }
  };
  const inspectBackup = async (file?: File) => {
    if (!file) return;
    if (backup?.transport === "stream")
      await discardPortableBackupSession(backup.sessionId);
    setBackup(null);
    try {
      try {
        const streamed = await uploadPortableBackup(file);
        setBackup({
          transport: "stream",
          sessionId: streamed.sessionId,
          expiresAt: streamed.expiresAt,
          manifest: streamed.manifest,
          filename: file.name,
        });
        setRestoreMode("full");
        return;
      } catch (error) {
        if (
          !(error instanceof PortableUploadError) ||
          error.status !== 422 ||
          file.size > LEGACY_BACKUP_MAX_BYTES
        )
          throw error;
      }
      const base64 = await blobToBase64(file);
      const result = await verifyBackup.mutateAsync({ base64 });
      const manifest = result.manifest as BackupManifest;
      setBackup({
        transport: "base64",
        base64,
        manifest,
        filename: file.name,
      });
      if (manifest.scope === "template" && restoreMode === "full")
        setRestoreMode("duplicate");
    } catch (error) {
      setBackup(null);
      toast.error(
        error instanceof Error ? error.message : tr("備份損壞或格式不支援", "The backup is damaged or unsupported")
      );
    }
  };
  const restore = async () => {
    if (
      !backup ||
      !confirm(
        restoreMode === "full"
          ? tr("完整還原會以備份取代目前帳號 Workspace；系統會先建立 Emergency Backup。繼續？", "A full restore replaces this workspace. An emergency backup will be created first. Continue?")
          : restoreMode === "duplicate"
            ? tr("匯入內容將建立成新的 Template 副本，現有資料不會被覆蓋。繼續？", "The imported templates will be created as new copies. Existing data will not be replaced. Continue?")
            : tr("匯入 Template 結構並按同名 Template 覆蓋；目前 Instance 會保留。繼續？", "Import template structures and replace templates with matching names. Existing filled forms will remain. Continue?")
      )
    )
      return;
    try {
      const result =
        backup.transport === "stream"
          ? await restoreStreamingBackup.mutateAsync({
              sessionId: backup.sessionId,
            })
          : await restoreBackup.mutateAsync({
              base64: backup.base64,
              mode: restoreMode,
            });
      setBackup(null);
      refresh();
      toast.success(`${tr("還原完成；緊急備份：", "Restore complete. Emergency backup: ")}${result.emergencyBackupId}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tr("還原失敗", "Restore failed"));
    }
  };
  return (
    <div>
      <div className="section-line !mt-0">
        <div>
          <div className="eyebrow">SETTINGS</div>
          <h2 className="!mt-2">{tr("本機資料、安全及偏好", "Local data, security and preferences")}</h2>
          <p>{tr("所有資料操作均由 localhost Local Data Folder 服務執行。", "All data operations run through the localhost Local Data Folder service.")}</p>
        </div>
        {!LOCAL_EDITION && <button className="btn-paper" onClick={onLogout}>
          <LogOut size={14} />
          {tr("登出", "Sign out")}
        </button>}
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <section className="border bg-[#fffdfa] p-5">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <HardDrive size={16} />
            Local Data Folder
          </h3>
          <p className="mt-2 text-xs leading-5 text-slate-500">
            {tr("搬移採「複製 → 完整性驗證 → 切換」，失敗會回滾；原位置保留作人工復原副本。", "Moving data copies and verifies it before switching folders. If it fails, the original remains available for recovery.")}
          </p>
          <label className="setting-label">{tr("Windows 絕對路徑", "Absolute Windows path")}</label>
          <input
            className="setting-input"
            value={folderPath}
            onChange={event => setFolderPath(event.target.value)}
          />
          <div className="mt-3 flex gap-2">
            <button
              className="btn-ink"
              disabled={moveFolder.isPending || folderPath === dataFolder}
              onClick={async () => {
                try {
                  const result = await moveFolder.mutateAsync({
                    dataFolder: folderPath,
                  });
                  refresh();
                  toast.success(`${tr("已切換至", "Switched to")} ${result.dataFolder}`);
                } catch (error) {
                  toast.error(
                    error instanceof Error ? error.message : tr("搬移失敗", "Move failed")
                  );
                }
              }}
            >
              <FolderCog size={14} />
              {tr("搬移並驗證", "Move and verify")}
            </button>
            <button
              className="btn-paper"
              disabled={integrity.isPending}
              onClick={async () => {
                try {
                  const result = await integrity.mutateAsync();
                  result.healthy
                    ? toast.success(
                        `${tr("完整性正常：", "Integrity check passed: ")}${result.manifestsScanned} ${tr("個資產", "assets")}`
                      )
                    : toast.error(`${tr("發現", "Found")} ${result.findings.length} ${tr("個問題", "issues")}`);
                } catch (error) {
                  toast.error(
                    error instanceof Error ? error.message : tr("掃描失敗", "Scan failed")
                  );
                }
              }}
            >
              <ShieldCheck size={14} />
              {tr("立即掃描", "Scan now")}
            </button>
          </div>
        </section>
        <section className="border bg-[#fffdfa] p-5">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <DatabaseBackup size={16} />
            Backup／Restore
          </h3>
          <p className="mt-2 text-xs leading-5 text-slate-500">
            {tr("手動備份包含 Workspace、原始來源、頁面、Instance、Mapping、輸出及完整 hash manifest。", "A manual backup includes the workspace, source documents, pages, filled forms, mappings, exports and a verified hash manifest.")}
          </p>
          <label className="setting-label">{tr("備份範圍", "Backup scope")}</label>
          <select
            className="setting-select"
            value={backupTemplateId}
            onChange={event => setBackupTemplateId(event.target.value)}
          >
            <option value="account">{tr("整個帳號 Workspace", "Entire workspace")}</option>
            {templates.map(template => (
              <option key={template.id} value={template.id}>
                {tr("單一 Template：", "Single template: ")}{template.name}
              </option>
            ))}
          </select>
          <div className="mt-4 flex gap-2">
            <button
              data-tour="backup-create"
              className="btn-ink"
              onClick={makeBackup}
              disabled={
                createBackup.isPending || createStreamingBackup.isPending
              }
            >
              <DatabaseBackup size={14} />
              {tr("建立可攜備份", "Create portable backup")}
            </button>
            <button
              className="btn-paper"
              onClick={() => restoreInput.current?.click()}
            >
              <Upload size={14} />
              {tr("匯入備份", "Import backup")}
            </button>
            <input
              ref={restoreInput}
              hidden
              type="file"
              accept=".formdigital-backup,.zip"
              onChange={event => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                void inspectBackup(file);
              }}
            />
          </div>
          {backup && (
            <div className="mt-4 border border-amber-300 bg-amber-50 p-3 text-xs">
              <b>{tr("還原前預覽：", "Preview before restore: ")}{backup.filename}</b>
              <p className="mt-2">
                {tr("範圍：", "Scope: ")}
                {backup.manifest.scope === "template"
                  ? tr("單一 Template", "Single template")
                  : tr("整個帳號", "Entire workspace")}{" "}
                · {tr("建立時間：", "Created: ")}
                {backup.manifest.createdAt
                  ? new Date(backup.manifest.createdAt).toLocaleString()
                  : "—"}
              </p>
              <p>
                Template {backup.manifest.summary?.templateCount ?? "—"} ·
                Version {backup.manifest.summary?.versionCount ?? "—"} ·
                Instance {backup.manifest.summary?.instanceCount ?? "—"} ·
                Mapping {backup.manifest.summary?.mappingTemplateCount ?? "—"}
              </p>
              <div className="mt-2 max-h-28 overflow-auto">
                {backup.manifest.summary?.templates?.map(template => (
                  <div key={template.id}>
                    {template.name} · {template.versions} versions ·{" "}
                    {template.instances} instances
                  </div>
                ))}
              </div>
              <select
                className="setting-select mt-3"
                value={restoreMode}
                disabled={backup.transport === "stream"}
                onChange={event =>
                  setRestoreMode(event.target.value as typeof restoreMode)
                }
              >
                {backup.transport === "stream" && (
                  <option value="full">{tr("完整取代帳號 Workspace", "Replace the entire workspace")}</option>
                )}
                {backup.transport === "base64" &&
                  backup.manifest.scope !== "template" && (
                  <option value="full">{tr("完整取代帳號 Workspace", "Replace the entire workspace")}</option>
                )}
                {backup.transport === "base64" && (
                  <>
                    <option value="structure">
                      {tr("按同名 Template 匯入／覆蓋，保留目前 Instance", "Import or replace matching templates; keep existing filled forms")}
                    </option>
                    <option value="duplicate">
                      {tr("全部建立為新的 Template 副本", "Create new copies of all templates")}
                    </option>
                  </>
                )}
              </select>
              {backup.transport === "stream" && (
                <p className="mt-2 text-[11px] text-slate-500">
                  {tr("大型帳號備份使用 bounded-memory 串流完整還原；結構合併及建立副本只適用於舊式小型備份。", "Large workspace backups use streaming full restore. Merge and duplicate options are available only for smaller legacy backups.")}
                </p>
              )}
              <button
                className="btn-red mt-2 w-full"
                onClick={restore}
                disabled={
                  restoreBackup.isPending || restoreStreamingBackup.isPending
                }
              >
                {tr("建立 Emergency Backup 後還原", "Create emergency backup and restore")}
              </button>
              <button
                className="btn-paper mt-2 w-full"
                onClick={() => {
                  if (backup.transport === "stream")
                    void discardPortableBackupSession(backup.sessionId);
                  setBackup(null);
                }}
                disabled={
                  restoreBackup.isPending || restoreStreamingBackup.isPending
                }
              >
                {tr("取消匯入", "Cancel import")}
              </button>
            </div>
          )}
        </section>
        <section className="border bg-[#fffdfa] p-5">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <FolderCog size={16} />
            {tr("資料夾", "Folders")}
          </h3>
          <div className="mt-3 grid grid-cols-[1fr_auto] gap-2">
            <select
              className="setting-select"
              value={newFolderParentId}
              onChange={event => setNewFolderParentId(event.target.value)}
            >
              <option value="">{tr("建立為最上層資料夾", "Create at top level")}</option>
              {orderedFolders.map(folder => (
                <option key={folder.id} value={folder.id}>
                  {"　".repeat(folder.depth)}
                  {folder.name}
                </option>
              ))}
            </select>
            <button
              className="btn-paper"
              onClick={async () => {
                const name = prompt(tr("資料夾名稱", "Folder name"));
                if (name?.trim()) {
                  await upsertFolder.mutateAsync({
                    name: name.trim(),
                    parentId: newFolderParentId || null,
                  });
                  refresh();
                }
              }}
            >
              <Plus size={13} />
              {tr("新增資料夾", "Add folder")}
            </button>
          </div>
          <div className="mt-3 space-y-2">
            {orderedFolders.map(folder => (
              <div
                key={folder.id}
                className="flex items-center justify-between border p-2 text-xs"
              >
                <span>
                  {"└ ".repeat(folder.depth)}
                  {folder.name}
                </span>
                <div>
                  <select
                    className="mr-2 h-7 max-w-36 border bg-white px-1 text-[9px]"
                    value={folder.parentId ?? ""}
                    onChange={async event => {
                      try {
                        await upsertFolder.mutateAsync({
                          id: folder.id,
                          name: folder.name,
                          parentId: event.target.value || null,
                        });
                        refresh();
                      } catch (error) {
                        toast.error(
                          error instanceof Error ? error.message : tr("移動失敗", "Move failed")
                        );
                      }
                    }}
                  >
                    <option value="">{tr("最上層", "Top level")}</option>
                    {orderedFolders
                      .filter(candidate => candidate.id !== folder.id)
                      .map(candidate => (
                        <option key={candidate.id} value={candidate.id}>
                          {"　".repeat(candidate.depth)}
                          {candidate.name}
                        </option>
                      ))}
                  </select>
                  <button
                    className="px-2"
                    onClick={async () => {
                      const name = prompt(tr("新的資料夾名稱", "New folder name"), folder.name);
                      if (name?.trim()) {
                        await upsertFolder.mutateAsync({
                          id: folder.id,
                          name: name.trim(),
                          parentId: folder.parentId,
                        });
                        refresh();
                      }
                    }}
                  >
                    {tr("重新命名", "Rename")}
                  </button>
                  <button
                    className="px-2 text-red-700"
                    onClick={async () => {
                      if (confirm(tr("刪除資料夾？Template 不會被刪除。", "Delete this folder? Its templates will remain."))) {
                        await deleteFolder.mutateAsync({ folderId: folder.id });
                        refresh();
                      }
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
        <section className="border bg-[#fffdfa] p-5">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <FolderCog size={16} />
            {tr("標籤", "Tags")}
          </h3>
          <button
            className="btn-paper mt-3"
            onClick={async () => {
              const name = prompt(tr("標籤名稱", "Tag name"));
              if (name?.trim()) {
                await upsertTag.mutateAsync({
                  name: name.trim(),
                  color: "#a23f2b",
                });
                refresh();
              }
            }}
          >
            <Plus size={13} />
            {tr("新增標籤", "Add tag")}
          </button>
          <div className="mt-3 space-y-2">
            {tags.map(tag => (
              <div
                key={tag.id}
                className="flex items-center justify-between border p-2 text-xs"
              >
                <span className="flex items-center gap-2">
                  <i className="h-3 w-3" style={{ background: tag.color }} />
                  {tag.name}
                </span>
                <div>
                  <input
                    type="color"
                    value={tag.color}
                    onChange={async event => {
                      await upsertTag.mutateAsync({
                        id: tag.id,
                        name: tag.name,
                        color: event.target.value,
                      });
                      refresh();
                    }}
                  />
                  <button
                    className="px-2"
                    onClick={async () => {
                      const name = prompt(tr("新的標籤名稱", "New tag name"), tag.name);
                      if (name?.trim()) {
                        await upsertTag.mutateAsync({
                          id: tag.id,
                          name: name.trim(),
                          color: tag.color,
                        });
                        refresh();
                      }
                    }}
                  >
                    {tr("重新命名", "Rename")}
                  </button>
                  <button
                    className="px-2 text-red-700"
                    onClick={async () => {
                      if (confirm(tr("刪除標籤？", "Delete this tag?"))) {
                        await deleteTag.mutateAsync({ tagId: tag.id });
                        refresh();
                      }
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
        <section className="border bg-[#fffdfa] p-5">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Languages size={16} />
            {t("settings.languageTheme", "語言與主題")}
          </h3>
          <label className="setting-label" htmlFor="interface-locale">
            {t("settings.interfaceLanguage", "介面語言")}
          </label>
          <select
            id="interface-locale"
            className="setting-select"
            value={locale}
            onChange={event => {
              const next = normalizeUiLocale(event.target.value);
              setLocale(next);
              void savePref({ locale: next });
            }}
          >
            <option value="zh-Hant">繁體中文</option>
            <option value="zh-Hans">简体中文</option>
            <option value="en">English</option>
          </select>
          <button className="btn-paper mt-3" onClick={toggleTheme}>
            {theme === "dark" ? <Moon size={14} /> : <Sun size={14} />}
            {t("settings.theme", "主題：")}
            {theme === "system"
              ? t("settings.system", "跟隨系統")
              : theme === "dark"
                ? t("settings.dark", "深色")
                : t("settings.light", "淺色")}
            {t("settings.cycleTheme", "（按下切換）")}
          </button>
        </section>
        <section className="border bg-[#fffdfa] p-5">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <ScanSearch size={16} />
            {tr("免費 AI／OCR", "Free AI / OCR")}
          </h3>
          <label className="setting-label">{tr("預設 Provider", "Default provider")}</label>
          <select
            className="setting-select"
            value={String(preferences.ocrProvider ?? "tesseract-local")}
            onChange={event => savePref({ ocrProvider: event.target.value })}
          >
            <option value="tesseract-local">
              {tr("Tesseract（localhost、免費離線）", "Tesseract (local, free, offline)")}
            </option>
            <option value="manual">{tr("純手動欄位", "Manual fields only")}</option>
          </select>
          <label className="setting-label">
            {tr("OCR 信心門檻：", "OCR confidence threshold: ")}{String(preferences.ocrThreshold ?? 65)}%
          </label>
          <input
            className="w-full"
            type="range"
            min="30"
            max="95"
            value={Number(preferences.ocrThreshold ?? 65)}
            onChange={event =>
              savePref({ ocrThreshold: Number(event.target.value) })
            }
          />
          <label className="setting-label">{tr("CSV 預設模式", "Default CSV mode")}</label>
          <select
            className="setting-select"
            value={String(preferences.csvMode ?? "strict")}
            onChange={event => savePref({ csvMode: event.target.value })}
          >
            <option value="strict">{tr("嚴格模式", "Strict mode")}</option>
            <option value="tolerant">{tr("容錯模式", "Tolerant mode")}</option>
          </select>
        </section>
      </div>
    </div>
  );
}
