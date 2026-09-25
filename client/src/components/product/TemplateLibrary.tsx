import { useMemo, useState } from "react";
import {
  Edit3,
  FileInput,
  Folder,
  Heart,
  MoreVertical,
  Pin,
  Plus,
  Search,
  Tags,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { useI18n } from "@/lib/i18n";
import { trpc } from "@/lib/trpc";
import {
  pageManifestOf,
  type FolderRecord,
  type TagRecord,
  type TemplateRecord,
} from "@/lib/product-types";

function TemplateCard({
  template,
  tags,
  folders,
  onOpen,
  onEdit,
  refresh,
}: {
  template: TemplateRecord;
  tags: TagRecord[];
  folders: FolderRecord[];
  onOpen: () => void;
  onEdit: () => void;
  refresh: () => void;
}) {
  const { tr } = useI18n();
  const [openMenuTemplateId, setOpenMenuTemplateId] = useState<string | null>(
    null
  );
  const update = trpc.formdigital.templates.updateMetadata.useMutation();
  const clone = trpc.formdigital.templates.cloneToDraft.useMutation();
  const remove = trpc.formdigital.templates.delete.useMutation();
  const versionId =
    template.currentDraftVersionId ||
    template.currentPublishedVersionId ||
    "pending";
  const details = trpc.formdigital.templates.getVersionDetails.useQuery(
    { versionId },
    { enabled: versionId !== "pending", staleTime: 60_000 }
  );
  const thumbnailAssetId = details.data
    ? pageManifestOf(details.data.version.pageManifest)[0]?.assetId
    : undefined;
  const run = async (operation: () => Promise<unknown>, message: string) => {
    try {
      await operation();
      await refresh();
      toast.success(message);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : tr("操作失敗", "Operation failed")
      );
    }
  };
  return (
    <article
      draggable
      onDragStart={event =>
        event.dataTransfer.setData("text/formdigital-template", template.id)
      }
      className="template-card card-blue min-h-[210px]"
    >
      <div
        className="relative flex items-center justify-between"
        style={{ zIndex: openMenuTemplateId === template.id ? 30 : 10 }}
      >
        <span
          className={`tag-strip !mb-0 ${template.lifecycle === "published" ? "!bg-emerald-50 !text-emerald-700" : ""}`}
        >
          {template.lifecycle === "published" ? "PUBLISHED" : "DRAFT"}
        </span>
        <div className="flex items-center gap-1">
          <button
            aria-label={
              template.favorite
                ? tr("取消收藏", "Remove favorite")
                : tr("收藏", "Favorite")
            }
            className="icon-button !h-7 !w-7"
            onClick={() =>
              run(
                () =>
                  update.mutateAsync({
                    templateId: template.id,
                    favorite: !template.favorite,
                  }),
                template.favorite
                  ? tr("已取消收藏", "Removed from favorites")
                  : tr("已收藏", "Added to favorites")
              )
            }
          >
            <Heart
              size={13}
              fill={template.favorite ? "currentColor" : "none"}
            />
          </button>
          <button
            aria-label={
              template.pinned
                ? tr("取消置頂", "Unpin")
                : tr("置頂", "Pin")
            }
            className="icon-button !h-7 !w-7"
            onClick={() =>
              run(
                () =>
                  update.mutateAsync({
                    templateId: template.id,
                    pinned: !template.pinned,
                  }),
                template.pinned
                  ? tr("已取消置頂", "Unpinned")
                  : tr("已置頂", "Pinned")
              )
            }
          >
            <Pin size={13} fill={template.pinned ? "currentColor" : "none"} />
          </button>
          {(() => {
            const menuOpen = openMenuTemplateId === template.id;
            return (
              <div className="relative">
                <button
                  aria-label={tr("更多操作", "More actions")}
                  aria-expanded={menuOpen}
                  aria-haspopup="menu"
                  className={`icon-button !h-7 !w-7 ${menuOpen ? "!bg-[#f8e7e2]" : ""}`}
                  onClick={() =>
                    setOpenMenuTemplateId(menuOpen ? null : template.id)
                  }
                >
                  <MoreVertical size={13} />
                </button>
                <div
                  className="absolute right-0 z-30 mt-1 w-48 border bg-[#fffdfa] p-1 shadow-xl"
                  style={{ display: menuOpen ? undefined : "none" }}
                >
              <button
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-[#f4eee8]"
                onClick={() => {
                  const name = prompt(
                    tr("新的 Template 名稱", "New template name"),
                    template.name
                  );
                  if (name?.trim())
                    run(
                      () =>
                        update.mutateAsync({
                          templateId: template.id,
                          name: name.trim(),
                        }),
                      tr("Template 已重新命名", "Template renamed")
                    );
                }}
              >
                <Edit3 size={13} />
                {tr("重新命名", "Rename")}
              </button>
              <button
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-[#f4eee8]"
                onClick={() => {
                  const folder = prompt(
                    `${tr("輸入資料夾名稱", "Enter folder name")}:\n${folders.map(item => item.name).join("、")}`
                  );
                  const found = folders.find(item => item.name === folder);
                  if (found)
                    run(
                      () =>
                        update.mutateAsync({
                          templateId: template.id,
                          folderIds: [found.id],
                        }),
                      tr("Template 已移動", "Template moved")
                    );
                }}
              >
                <Folder size={13} />
                {tr("移動資料夾", "Move to folder")}
              </button>
              {tags.length > 0 && (
                <div className="border-y px-3 py-2">
                  <div className="mb-1 text-[9px] font-semibold text-slate-500">
                    {tr("標籤（可多選）", "Tags (multiple allowed)")}
                  </div>
                  {tags.map(tag => (
                    <label
                      key={tag.id}
                      className="flex items-center gap-2 py-1 text-[10px]"
                    >
                      <input
                        type="checkbox"
                        checked={template.tagIds.includes(tag.id)}
                        onChange={() =>
                          run(
                            () =>
                              update.mutateAsync({
                                templateId: template.id,
                                tagIds: template.tagIds.includes(tag.id)
                                  ? template.tagIds.filter(id => id !== tag.id)
                                  : [...template.tagIds, tag.id],
                              }),
                            tr("標籤已更新", "Tags updated")
                          )
                        }
                      />
                      <i
                        className="h-2 w-2"
                        style={{ backgroundColor: tag.color }}
                      />
                      {tag.name}
                    </label>
                  ))}
                </div>
              )}
              {template.currentPublishedVersionId &&
                !template.currentDraftVersionId && (
                  <button
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-[#f4eee8]"
                    onClick={() =>
                      run(
                        () =>
                          clone.mutateAsync({
                            versionId: template.currentPublishedVersionId!,
                          }),
                        tr(
                          "已建立新 Draft Version",
                          "Created a new draft version"
                        )
                      )
                    }
                  >
                    <Plus size={13} />
                    {tr("建立新版本", "Create new version")}
                  </button>
                )}
              <button
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-red-700 hover:bg-red-50"
                onClick={() => {
                  if (
                    confirm(
                      tr(
                        `永久刪除「${template.name}」及所有版本、Instance、Mapping、輸出與資產？`,
                        `Permanently delete “${template.name}” and all versions, instances, mappings, outputs, and assets?`
                      )
                    )
                  )
                    run(
                      () => remove.mutateAsync({ templateId: template.id }),
                      tr("Template 已永久刪除", "Template permanently deleted")
                    );
                }}
              >
                <Trash2 size={13} />
                {tr("永久刪除", "Delete permanently")}
              </button>
              </div>
              </div>
            );
          })()}
        </div>
      </div>
      <div className="relative z-10 mt-4 grid h-24 place-items-center overflow-hidden border bg-[#f2efe9]">
        {thumbnailAssetId ? (
          <img
            src={`/api/local/assets/${thumbnailAssetId}`}
            alt={`${template.name} ${tr("第一頁縮圖", "first-page thumbnail")}`}
            loading="lazy"
            className="h-full w-full object-cover object-top"
          />
        ) : (
          <FileInput size={24} className="text-slate-300" />
        )}
      </div>
      <h3 className="!mt-4 !max-w-none">{template.name}</h3>
      <div className="relative z-10 mt-3 flex flex-wrap gap-1">
        {template.tagIds.map(id => {
          const tag = tags.find(item => item.id === id);
          return tag ? (
            <span
              key={id}
              className="px-2 py-1 text-[9px]"
              style={{ backgroundColor: `${tag.color}1a`, color: tag.color }}
            >
              {tag.name}
            </span>
          ) : null;
        })}
      </div>
      <div className="relative z-10 mt-5 flex gap-2">
        <button
          className="btn-ink !min-h-8 flex-1"
          disabled={!template.currentPublishedVersionId}
          onClick={onOpen}
        >
          <FileInput size={13} />
          {tr("填表", "Fill")}
        </button>
        <button className="btn-paper !min-h-8 flex-1" onClick={onEdit}>
          <Edit3 size={13} />
          {tr("編輯", "Edit")}
        </button>
      </div>
      <footer>
        <span>
          {template.currentDraftVersionId
            ? tr("Draft 可繼續", "Draft available")
            : template.currentPublishedVersionId
              ? tr("正式版本", "Published version")
              : tr("未發佈", "Not published")}
        </span>
        <span>{new Date(template.updatedAt).toLocaleDateString()}</span>
      </footer>
    </article>
  );
}

export function TemplateLibrary({
  templates,
  folders,
  tags,
  onCreate,
  onOpenVersion,
  onEditVersion,
  refresh,
}: {
  templates: TemplateRecord[];
  folders: FolderRecord[];
  tags: TagRecord[];
  onCreate: () => void;
  onOpenVersion: (versionId: string) => void;
  onEditVersion: (versionId: string) => void;
  refresh: () => void;
}) {
  const { tr } = useI18n();
  const [search, setSearch] = useState("");
  const [folderId, setFolderId] = useState("all");
  const [tagId, setTagId] = useState("all");
  const [sort, setSort] = useState<"opened" | "edited">("edited");
  const searchQuery = trpc.formdigital.templates.search.useQuery(
    { query: search },
    { enabled: Boolean(search.trim()) }
  );
  const update = trpc.formdigital.templates.updateMetadata.useMutation();
  const source = search.trim()
    ? ((searchQuery.data as TemplateRecord[] | undefined) ?? [])
    : templates;
  const filtered = useMemo(
    () =>
      source
        .filter(
          template =>
            (folderId === "all" || template.folderIds.includes(folderId)) &&
            (tagId === "all" || template.tagIds.includes(tagId))
        )
        .sort((a, b) =>
          sort === "opened"
            ? b.lastOpenedAt - a.lastOpenedAt
            : b.updatedAt - a.updatedAt
        ),
    [source, folderId, tagId, sort]
  );
  const dropOnFolder = async (
    event: React.DragEvent,
    targetFolderId: string
  ) => {
    event.preventDefault();
    const templateId = event.dataTransfer.getData("text/formdigital-template");
    const template = templates.find(item => item.id === templateId);
    if (!template) return;
    try {
      await update.mutateAsync({
        templateId,
        folderIds:
          targetFolderId === "unfiled"
            ? []
            : Array.from(new Set([...template.folderIds, targetFolderId])),
      });
      refresh();
      toast.success(tr("Template 已移到資料夾", "Template moved to folder"));
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : tr("移動失敗", "Move failed")
      );
    }
  };
  return (
    <>
      <div className="section-line !mt-0">
        <div>
          <div className="eyebrow">TEMPLATE LIBRARY</div>
          <h2 className="!mt-2">
            {tr("Template、版本與分類", "Templates, versions, and categories")}
          </h2>
          <p>
            {tr(
              "搜尋範圍包括 Template 名稱、版本備註及欄位名稱。",
              "Search template names, version notes, and field names."
            )}
          </p>
        </div>
        <button className="btn-ink" onClick={onCreate}>
          <Plus size={14} />
          {tr("建立 Template", "Create template")}
        </button>
      </div>
      <div className="grid gap-3 border border-[#d9d4ca] bg-[#fffdfa] p-3 md:grid-cols-[1fr_auto_auto_auto]">
        <label className="flex items-center gap-2 border px-3">
          <Search size={14} />
          <input
            className="h-9 min-w-0 flex-1 border-0 bg-transparent text-xs outline-none"
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder={tr(
              "搜尋名稱、版本備註或欄位…",
              "Search names, version notes, or fields…"
            )}
          />
        </label>
        <select
          className="setting-select !w-auto"
          value={folderId}
          onChange={event => setFolderId(event.target.value)}
        >
          <option value="all">{tr("全部資料夾", "All folders")}</option>
          {folders.map(folder => (
            <option key={folder.id} value={folder.id}>
              {folder.name}
            </option>
          ))}
        </select>
        <select
          className="setting-select !w-auto"
          value={tagId}
          onChange={event => setTagId(event.target.value)}
        >
          <option value="all">{tr("全部標籤", "All tags")}</option>
          {tags.map(tag => (
            <option key={tag.id} value={tag.id}>
              {tag.name}
            </option>
          ))}
        </select>
        <select
          className="setting-select !w-auto"
          value={sort}
          onChange={event => setSort(event.target.value as typeof sort)}
        >
          <option value="edited">{tr("最後編輯", "Last edited")}</option>
          <option value="opened">{tr("最後開啟", "Last opened")}</option>
        </select>
      </div>
      {folders.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          <span className="flex items-center gap-1 text-[10px] text-slate-500">
            <Folder size={12} />
            {tr("拖拉卡片到", "Drag a card to")}：
          </span>
          {folders.map(folder => (
            <button
              key={folder.id}
              onDragOver={event => event.preventDefault()}
              onDrop={event => dropOnFolder(event, folder.id)}
              className="border bg-[#fffdfa] px-3 py-1 text-[10px] hover:border-[#d9573b]"
            >
              {folder.name}
            </button>
          ))}
        </div>
      )}
      {filtered.length ? (
        <section className="template-grid mt-5">
          {filtered.map(template => (
            <TemplateCard
              key={template.id}
              template={template}
              tags={tags}
              folders={folders}
              refresh={refresh}
              onOpen={() =>
                template.currentPublishedVersionId &&
                onOpenVersion(template.currentPublishedVersionId)
              }
              onEdit={() =>
                onEditVersion(
                  template.currentDraftVersionId ||
                    template.currentPublishedVersionId ||
                    ""
                )
              }
            />
          ))}
        </section>
      ) : (
        <section className="mt-5 grid min-h-64 place-items-center border border-dashed bg-[#fffdfa] p-8 text-center">
          <div>
            <Tags className="mx-auto text-slate-400" />
            <h3 className="mt-3 text-sm font-semibold">
              {tr("找不到 Template", "No templates found")}
            </h3>
            <p className="mt-1 text-xs text-slate-500">
              {tr(
                "調整搜尋／篩選，或建立第一個 Template。",
                "Adjust the search or filters, or create your first template."
              )}
            </p>
          </div>
        </section>
      )}
    </>
  );
}
