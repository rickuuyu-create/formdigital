import { useEffect, useMemo, useState } from "react";
import {
  ArrowRightLeft,
  Copy,
  Download,
  FileText,
  Printer,
  Search,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useI18n } from "@/lib/i18n";
import { translateServerMessage } from "@/lib/server-messages";
import {
  downloadPdfPagesAsImages,
  downloadUrl,
  openLocalOutput,
} from "@/lib/document-files";
import type {
  FieldRecord,
  InstanceRecord,
  TemplateRecord,
} from "@/lib/product-types";

function parsePageNumbers(
  value: string,
  translate: (traditionalChinese: string, english: string) => string
) {
  const pages = new Set<number>();
  for (const part of value
    .split(",")
    .map(item => item.trim())
    .filter(Boolean)) {
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start < 1 || end < start || end - start > 99)
        throw new Error(
          translate(`頁碼範圍無效：${part}`, `Invalid page range: ${part}`)
        );
      for (let page = start; page <= end; page += 1) pages.add(page);
    } else {
      const page = Number(part);
      if (!Number.isInteger(page) || page < 1)
        throw new Error(translate(`頁碼無效：${part}`, `Invalid page number: ${part}`));
      pages.add(page);
    }
  }
  return Array.from(pages).sort((a, b) => a - b);
}

export function InstancesCenter({
  instances,
  templates,
  onOpen,
  refresh,
}: {
  instances: InstanceRecord[];
  templates: TemplateRecord[];
  onOpen: (instance: InstanceRecord) => void;
  refresh: () => void;
}) {
  const { tr, locale } = useI18n();
  const serverError = (
    error: unknown,
    traditionalChinese: string,
    english: string
  ) =>
    toast.error(
      error instanceof Error
        ? translateServerMessage(error.message, tr, locale)
        : tr(traditionalChinese, english)
    );
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [sort, setSort] = useState<"updated" | "created" | "name" | "key">(
    "updated"
  );
  const [page, setPage] = useState(0);
  const [copies, setCopies] = useState(1);
  const [separatorPage, setSeparatorPage] = useState(false);
  const [titlePage, setTitlePage] = useState(false);
  const [pageNumbers, setPageNumbers] = useState("");
  const [itemOptions, setItemOptions] = useState<
    Record<string, { copies: number; pageNumbers: string }>
  >({});
  const [migrationOpen, setMigrationOpen] = useState(false);
  const [targetVersionId, setTargetVersionId] = useState("");
  const [migrationMapping, setMigrationMapping] = useState<
    Record<string, string>
  >({});
  const [deleteOriginals, setDeleteOriginals] = useState(false);
  const clone = trpc.formdigital.instances.clone.useMutation();
  const remove = trpc.formdigital.instances.delete.useMutation();
  const setInstanceStatus = trpc.formdigital.instances.setStatus.useMutation();
  const batchPdf = trpc.formdigital.exports.batchPdf.useMutation();
  const structured = trpc.formdigital.exports.structured.useMutation();
  const markPrinted = trpc.formdigital.instances.markPrinted.useMutation();
  const migrate = trpc.formdigital.instances.migrateVersion.useMutation();
  const selectedRecords = instances.filter(instance =>
    selected.includes(instance.id)
  );
  const sourceVersionId =
    selectedRecords.length &&
    selectedRecords.every(
      instance =>
        instance.templateVersionId === selectedRecords[0]!.templateVersionId
    )
      ? selectedRecords[0]!.templateVersionId
      : "";
  const sourceTemplate =
    selectedRecords.length &&
    selectedRecords.every(
      instance => instance.templateId === selectedRecords[0]!.templateId
    )
      ? templates.find(
          template => template.id === selectedRecords[0]!.templateId
        )
      : undefined;
  const sourceDetails = trpc.formdigital.templates.getVersionDetails.useQuery(
    { versionId: sourceVersionId || "pending" },
    { enabled: migrationOpen && Boolean(sourceVersionId) }
  );
  const targetDetails = trpc.formdigital.templates.getVersionDetails.useQuery(
    { versionId: targetVersionId || "pending" },
    { enabled: migrationOpen && Boolean(targetVersionId) }
  );
  const filtered = useMemo(
    () =>
      instances
        .filter(
          instance =>
            (status === "all" || instance.status === status) &&
            `${instance.name} ${templates.find(template => template.id === instance.templateId)?.name ?? ""} ${Object.values(instance.values).join(" ")}`
              .toLocaleLowerCase()
              .includes(search.toLocaleLowerCase())
        )
        .sort((a, b) =>
          sort === "name"
            ? a.name.localeCompare(b.name)
            : sort === "created"
              ? b.createdAt - a.createdAt
              : sort === "key"
                ? String(
                    a.values[
                      templates.find(template => template.id === a.templateId)
                        ?.keyFieldIds[0] ?? ""
                    ] ?? ""
                  ).localeCompare(
                    String(
                      b.values[
                        templates.find(template => template.id === b.templateId)
                          ?.keyFieldIds[0] ?? ""
                      ] ?? ""
                    )
                  )
                : b.updatedAt - a.updatedAt
        ),
    [instances, templates, search, status, sort]
  );
  useEffect(() => {
    if (!sourceDetails.data || !targetDetails.data) return;
    const targetFields = targetDetails.data.fields as FieldRecord[];
    const byLabel = new Map(
      targetFields.map(field => [
        String(
          (field.definition as Record<string, unknown>)?.label ||
            field.stableFieldId
        )
          .toLocaleLowerCase()
          .replace(/\s/g, ""),
        field.stableFieldId,
      ])
    );
    const mapping: Record<string, string> = {};
    for (const field of sourceDetails.data.fields as FieldRecord[]) {
      const label = String(
        (field.definition as Record<string, unknown>)?.label ||
          field.stableFieldId
      )
        .toLocaleLowerCase()
        .replace(/\s/g, "");
      mapping[field.stableFieldId] = targetFields.some(
        target => target.stableFieldId === field.stableFieldId
      )
        ? field.stableFieldId
        : (byLabel.get(label) ?? "");
    }
    setMigrationMapping(mapping);
  }, [sourceDetails.data, targetDetails.data]);
  const perPage = 100;
  const visible = filtered.slice(page * perPage, (page + 1) * perPage);
  const targetIds = selected.length
    ? selected
    : visible.map(instance => instance.id);
  const toggle = (id: string) =>
    setSelected(current =>
      current.includes(id)
        ? current.filter(item => item !== id)
        : [...current, id]
    );
  const moveSelected = (id: string, offset: -1 | 1) =>
    setSelected(current => {
      const index = current.indexOf(id);
      const target = index + offset;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = current.slice();
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  const deleteSelected = async () => {
    if (
      !selected.length ||
      !confirm(tr(`永久刪除 ${selected.length} 個 Instance？`, `Permanently delete ${selected.length} Instances?`))
    )
      return;
    try {
      await remove.mutateAsync({ instanceIds: selected });
      setSelected([]);
      refresh();
      toast.success(tr("Instance 已永久刪除", "Instances permanently deleted"));
    } catch (error) {
      serverError(error, "刪除失敗", "Delete failed");
    }
  };
  const setStatusBatch = async (
    nextStatus: "draft" | "completed" | "printed"
  ) => {
    try {
      for (const id of selected)
        await setInstanceStatus.mutateAsync({
          instanceId: id,
          status: nextStatus,
        });
      refresh();
      toast.success(tr("狀態已更新", "Status updated"));
    } catch (error) {
      serverError(error, "狀態更新失敗", "Could not update status");
    }
  };
  const createBatch = async (
    mode: "full" | "overlay" | "editable",
    print = false,
    raster?: "png" | "jpeg"
  ) => {
    if (!targetIds.length)
      return toast.error(tr("沒有可輸出的 Instance。", "No Instances available for export."));
    try {
      const globalPages = parsePageNumbers(pageNumbers, tr);
      const overrides = Object.fromEntries(
        targetIds.map(id => {
          const option = itemOptions[id];
          return [
            id,
            {
              copies: option?.copies ?? copies,
              pageNumbers: option?.pageNumbers
                ? parsePageNumbers(option.pageNumbers, tr)
                : undefined,
            },
          ];
        })
      );
      const result = await batchPdf.mutateAsync({
        instanceIds: targetIds,
        mode,
        copies,
        separatorPage,
        titlePage,
        pageNumbers: globalPages.length ? globalPages : undefined,
        itemOptions: overrides,
      });
      if (raster) {
        const count = await downloadPdfPagesAsImages(
          result.url,
          raster,
          "Formdigital-batch"
        );
        toast.success(
          tr(`已輸出 ${count} 張 ${raster === "jpeg" ? "JPG" : "PNG"} 圖片`, `Exported ${count} ${raster === "jpeg" ? "JPG" : "PNG"} images`)
        );
      } else if (print) {
        if (!openLocalOutput(result.url))
          return toast.error(
            tr("瀏覽器阻擋了批量列印視窗。", "The browser blocked the batch print window.")
          );
        if (
          confirm(
            tr("系統列印對話框是否已成功送出整批列印？", "Did the system print dialog successfully submit the batch print job?")
          )
        ) {
          await markPrinted.mutateAsync({
            instanceIds: targetIds,
            output: { assetId: result.assetId, mode, batch: true },
          });
          refresh();
        }
      } else
        await downloadUrl(
          result.url,
          result.filename || "Formdigital-batch.pdf"
        );
    } catch (error) {
      serverError(error, "批量輸出失敗", "Batch export failed");
    }
  };
  const exportMany = async (format: "json" | "csv") => {
    try {
      for (const id of targetIds) {
        const result = await structured.mutateAsync({ instanceId: id, format });
        await downloadUrl(result.url, result.filename || `${id}.${format}`);
      }
    } catch (error) {
      serverError(error, "批量輸出失敗", "Batch export failed");
    }
  };
  return (
    <>
      {selected.length > 0 && (
        <div className="mb-3 flex items-center gap-2 border border-blue-200 bg-blue-50 p-3 text-xs">
          <span>
            {tr("已選", "Selected")} {selected.length}{" "}
            {tr("個 Instance", "Instances")}
          </span>
          <button
            className="btn-paper !ml-auto !min-h-8"
            onClick={() => {
              if (!sourceVersionId || !sourceTemplate)
                return toast.error(
                  tr("版本遷移只可一次處理同一 Template、同一來源 Version 的 Instance。", "Version migration processes only Instances from one Template and one source Version at a time.")
                );
              const target = sourceTemplate.currentPublishedVersionId;
              if (!target || target === sourceVersionId)
                return toast.error(
                  tr("此 Template 沒有另一個已發佈 Version 可作目標。", "This Template has no other published Version to target.")
                );
              setTargetVersionId(target);
              setMigrationOpen(true);
            }}
          >
            <ArrowRightLeft size={13} />
            {tr("遷移至新版本", "Migrate to new version")}
          </button>
        </div>
      )}
      {migrationOpen && sourceDetails.data && targetDetails.data && (
        <section className="mb-4 border border-[#d9573b] bg-[#fffdfa] p-4">
          <div className="flex items-start justify-between">
            <div>
              <div className="eyebrow">VERSION MIGRATION</div>
              <h3 className="mt-2 text-sm font-semibold">
                {tr("人工確認欄位 Mapping", "Human-confirm field mapping")}
              </h3>
              <p className="mt-1 text-[10px] text-slate-500">
                {tr("建立綁定目標 Version 的新副本；無法配對的目標欄位會留空。", "Create new copies bound to the target Version. Unmatched target fields are left blank.")}
              </p>
            </div>
            <button
              className="icon-button"
              onClick={() => setMigrationOpen(false)}
            >
              ×
            </button>
          </div>
          <div className="mt-3 max-h-72 overflow-auto border">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="bg-[#f2efe9] text-left">
                  <th className="p-2">
                    {tr("舊 Version 欄位", "Old Version field")}
                  </th>
                  <th className="p-2">
                    {tr("新 Version 欄位", "New Version field")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {(sourceDetails.data.fields as FieldRecord[]).map(field => (
                  <tr key={field.stableFieldId} className="border-t">
                    <td className="p-2">
                      {String(
                        (field.definition as Record<string, unknown>)?.label ||
                          field.stableFieldId
                      )}
                    </td>
                    <td className="p-2">
                      <select
                        className="setting-select"
                        value={migrationMapping[field.stableFieldId] ?? ""}
                        onChange={event =>
                          setMigrationMapping(current => ({
                            ...current,
                            [field.stableFieldId]: event.target.value,
                          }))
                        }
                      >
                        <option value="">
                          {tr("不遷移此欄位", "Do not migrate this field")}
                        </option>
                        {(targetDetails.data.fields as FieldRecord[]).map(
                          target => (
                            <option
                              key={target.stableFieldId}
                              value={target.stableFieldId}
                            >
                              {String(
                                (target.definition as Record<string, unknown>)
                                  ?.label || target.stableFieldId
                              )}
                            </option>
                          )
                        )}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <label className="mt-3 flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={deleteOriginals}
              onChange={event => setDeleteOriginals(event.target.checked)}
            />
            {tr("完成後刪除舊 Version Instance（否則保留並建立新副本）", "Delete old Version Instances after completion; otherwise retain them and create new copies")}
          </label>
          <button
            className="btn-red mt-3"
            disabled={migrate.isPending}
            onClick={async () => {
              if (
                !confirm(
                  tr(
                    `確認遷移 ${selected.length} 個 Instance？${deleteOriginals ? "舊 Instance 會在成功後刪除。" : "舊 Instance 會保留。"}`,
                    `Migrate ${selected.length} Instances? ${deleteOriginals ? "Old Instances will be deleted after success." : "Old Instances will be retained."}`,
                  )
                )
              )
                return;
              try {
                const result = await migrate.mutateAsync({
                  instanceIds: selected,
                  targetVersionId,
                  mapping: Object.fromEntries(
                    Object.entries(migrationMapping).map(([key, value]) => [
                      key,
                      value || null,
                    ])
                  ),
                  deleteOriginals,
                });
                setSelected([]);
                setMigrationOpen(false);
                refresh();
                toast.success(
                  tr(`已建立 ${result.created} 個新 Version Instance`, `Created ${result.created} new Version Instances`)
                );
              } catch (error) {
                toast.error(
                  error instanceof Error
                    ? error.message
                    : tr("遷移失敗", "Migration failed")
                );
              }
            }}
          >
            <ArrowRightLeft size={13} />
            {tr("執行版本遷移", "Run version migration")}
          </button>
        </section>
      )}
      <div className="section-line !mt-0">
        <div>
          <div className="eyebrow">INSTANCES</div>
          <h2 className="!mt-2">
            {tr("已填表格與歷史", "Completed forms and history")}
          </h2>
          <p>
            {tr("顯示版本、輸出、列印次數及固定狀態。", "Shows versions, outputs, print counts, and locked statuses.")}
          </p>
        </div>
        <span className="font-mono text-xs text-slate-500">
          {filtered.length} records
        </span>
      </div>
      <div className="grid gap-2 border bg-[#fffdfa] p-3 md:grid-cols-[1fr_auto_auto]">
        <label className="flex items-center gap-2 border px-3">
          <Search size={14} />
          <input
            className="h-9 flex-1 border-0 bg-transparent text-xs outline-none"
            value={search}
            onChange={event => {
              setSearch(event.target.value);
              setPage(0);
            }}
            placeholder={tr("搜尋 Instance 名稱、Template 或關鍵欄位…", "Search Instance names, Templates, or key fields…")}
          />
        </label>
        <select
          className="setting-select !w-auto"
          value={status}
          onChange={event => setStatus(event.target.value)}
        >
          <option value="all">{tr("全部狀態", "All statuses")}</option>
          <option value="draft">{tr("草稿", "Draft")}</option>
          <option value="completed">{tr("已完成", "Completed")}</option>
          <option value="printed">{tr("已列印", "Printed")}</option>
        </select>
        <select
          className="setting-select !w-auto"
          value={sort}
          onChange={event => setSort(event.target.value as typeof sort)}
        >
          <option value="updated">{tr("最後修改", "Last modified")}</option>
          <option value="created">{tr("建立時間", "Created")}</option>
          <option value="name">{tr("名稱", "Name")}</option>
          <option value="key">{tr("第一關鍵欄位", "First key field")}</option>
        </select>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 border bg-[#fffdfa] p-2">
        <button
          className="btn-paper !min-h-8"
          onClick={() =>
            setSelected(
              selected.length === visible.length
                ? []
                : visible.map(instance => instance.id)
            )
          }
        >
          {selected.length === visible.length && visible.length
            ? tr("取消全選", "Clear selection")
            : tr("選取本頁", "Select this page")}
        </button>
        <span className="text-[10px] text-slate-500">
          {tr("已選", "Selected")} {selected.length}
          {tr("；未選時操作目前頁面", "; with no selection, actions target the current page")}
        </span>
        <label className="text-[10px]">
          {tr("頁碼（如 1,3-5）", "Pages (e.g. 1,3-5)")}
          <input
            className="ml-1 h-8 w-24 border px-2"
            value={pageNumbers}
            onChange={event => setPageNumbers(event.target.value)}
            placeholder={tr("全部", "All")}
          />
        </label>
        <select
          className="setting-select !ml-auto !w-auto"
          value={copies}
          onChange={event => setCopies(Number(event.target.value))}
        >
          {[1, 2, 3, 4, 5].map(value => (
            <option key={value} value={value}>
              {value} {tr("份", "copies")}
            </option>
          ))}
        </select>
        <label className="text-[10px]">
          <input
            type="checkbox"
            checked={separatorPage}
            onChange={event => setSeparatorPage(event.target.checked)}
          />{" "}
          {tr("分隔頁", "Separator page")}
        </label>
        <label className="text-[10px]">
          <input
            type="checkbox"
            checked={titlePage}
            onChange={event => setTitlePage(event.target.checked)}
          />{" "}
          {tr("標題頁", "Title page")}
        </label>
        <details className="relative">
          <summary className="btn-paper !min-h-8 list-none">
            <Download size={13} />
            {tr("批量匯出", "Batch export")}
          </summary>
          <div className="absolute right-0 z-20 mt-1 grid w-44 border bg-[#fffdfa] p-1 shadow-xl">
            <button
              className="p-2 text-left text-xs"
              onClick={() => createBatch("full")}
            >
              {tr("合併 Flattened PDF", "Merged Flattened PDF")}
            </button>
            <button
              className="p-2 text-left text-xs"
              onClick={() => createBatch("overlay")}
            >
              {tr("合併 Overlay PDF", "Merged Overlay PDF")}
            </button>
            <button
              className="p-2 text-left text-xs"
              onClick={() => createBatch("editable")}
            >
              {tr("合併 Editable PDF", "Merged Editable PDF")}
            </button>
            <button
              className="p-2 text-left text-xs"
              onClick={() => createBatch("full", false, "png")}
            >
              {tr("合併結果逐頁 PNG", "Merged result as page PNGs")}
            </button>
            <button
              className="p-2 text-left text-xs"
              onClick={() => createBatch("full", false, "jpeg")}
            >
              {tr("合併結果逐頁 JPG", "Merged result as page JPGs")}
            </button>
            <button
              className="p-2 text-left text-xs"
              onClick={() => exportMany("json")}
            >
              {tr("每份 JSON", "JSON per Instance")}
            </button>
            <button
              className="p-2 text-left text-xs"
              onClick={() => exportMany("csv")}
            >
              {tr("每份 CSV", "CSV per Instance")}
            </button>
          </div>
        </details>
        <button
          className="btn-red !min-h-8"
          onClick={() => createBatch("full", true)}
        >
          <Printer size={13} />
          {tr("批量列印", "Batch print")}
        </button>
        {selected.length > 0 && (
          <details className="relative">
            <summary className="btn-paper !min-h-8 list-none">
              {tr("狀態／刪除", "Status / delete")}
            </summary>
            <div className="absolute right-0 z-20 mt-1 grid w-40 border bg-[#fffdfa] p-1 shadow-xl">
              <button
                className="p-2 text-left text-xs"
                onClick={() => setStatusBatch("draft")}
              >
                {tr("改為草稿", "Set to Draft")}
              </button>
              <button
                className="p-2 text-left text-xs"
                onClick={() => setStatusBatch("completed")}
              >
                {tr("改為已完成", "Set to Completed")}
              </button>
              <button
                className="p-2 text-left text-xs"
                onClick={() => setStatusBatch("printed")}
              >
                {tr("改為已列印", "Set to Printed")}
              </button>
              <button
                className="p-2 text-left text-xs text-red-700"
                onClick={deleteSelected}
              >
                {tr("永久刪除", "Delete permanently")}
              </button>
            </div>
          </details>
        )}
      </div>
      {selected.length > 0 && (
        <details className="mt-3 border bg-[#fffdfa] p-3">
          <summary className="cursor-pointer text-xs font-semibold">
            {tr("列印佇列順序與每份覆寫設定", "Print queue order and per-item overrides")} (
            {selected.length})
          </summary>
          <div className="mt-3 max-h-72 overflow-auto">
            {selected.map((id, index) => {
              const instance = instances.find(item => item.id === id);
              const option = itemOptions[id] ?? { copies, pageNumbers: "" };
              return (
                <div
                  key={id}
                  className="grid grid-cols-[2rem_1fr_auto_auto_auto] items-center gap-2 border-b py-2 text-xs"
                >
                  <span className="font-mono text-slate-400">{index + 1}</span>
                  <span className="truncate">{instance?.name || id}</span>
                  <label>
                    {tr("份數", "Copies")}
                    <input
                      className="ml-1 h-8 w-14 border px-2"
                      type="number"
                      min={1}
                      max={20}
                      value={option.copies}
                      onChange={event =>
                        setItemOptions(current => ({
                          ...current,
                          [id]: {
                            ...option,
                            copies: Math.max(
                              1,
                              Math.min(20, Number(event.target.value) || 1)
                            ),
                          },
                        }))
                      }
                    />
                  </label>
                  <label>
                    {tr("頁碼", "Pages")}
                    <input
                      className="ml-1 h-8 w-24 border px-2"
                      value={option.pageNumbers}
                      placeholder={tr("沿用全域", "Use global setting")}
                      onChange={event =>
                        setItemOptions(current => ({
                          ...current,
                          [id]: { ...option, pageNumbers: event.target.value },
                        }))
                      }
                    />
                  </label>
                  <span className="flex gap-1">
                    <button
                      className="icon-button !h-7 !w-7"
                      disabled={index === 0}
                      onClick={() => moveSelected(id, -1)}
                      title={tr("上移", "Move up")}
                    >
                      ↑
                    </button>
                    <button
                      className="icon-button !h-7 !w-7"
                      disabled={index === selected.length - 1}
                      onClick={() => moveSelected(id, 1)}
                      title={tr("下移", "Move down")}
                    >
                      ↓
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        </details>
      )}
      <div className="mt-3 overflow-auto border bg-[#fffdfa]">
        <table className="w-full min-w-[860px] border-collapse text-xs">
          <thead>
            <tr className="bg-[#f2efe9] text-left text-[10px] text-slate-600">
              <th className="p-3" />
              <th className="p-3">Instance</th>
              <th className="p-3">Template／Version</th>
              <th className="p-3">{tr("狀態", "Status")}</th>
              <th className="p-3">{tr("修改時間", "Modified")}</th>
              <th className="p-3">{tr("輸出／列印", "Output / print")}</th>
              <th className="p-3">{tr("操作", "Actions")}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map(instance => {
              const template = templates.find(
                item => item.id === instance.templateId
              );
              return (
                <tr key={instance.id} className="border-t hover:bg-[#faf7f2]">
                  <td className="p-3">
                    <input
                      type="checkbox"
                      checked={selected.includes(instance.id)}
                      onChange={() => toggle(instance.id)}
                    />
                  </td>
                  <td className="p-3">
                    <button
                      className="font-semibold text-[#17364d] hover:underline"
                      onClick={() => onOpen(instance)}
                    >
                      {instance.name}
                    </button>
                    <div className="mt-1 font-mono text-[9px] text-slate-400">
                      {instance.id}
                    </div>
                    {template?.keyFieldIds.length ? (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {template.keyFieldIds.map(fieldId => (
                          <span
                            key={fieldId}
                            className="border bg-[#f7f4ee] px-2 py-1 text-[9px]"
                            title={fieldId}
                          >
                            {fieldId}: {instance.values[fieldId] || "—"}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </td>
                  <td className="p-3">
                    {template?.name || "—"}
                    <div className="mt-1 font-mono text-[9px] text-slate-400">
                      {instance.templateVersionId}
                    </div>
                  </td>
                  <td className="p-3">
                    <span
                      className={`px-2 py-1 text-[9px] ${instance.status === "printed" ? "bg-emerald-50 text-emerald-700" : instance.status === "completed" ? "bg-blue-50 text-blue-700" : "bg-amber-50 text-amber-700"}`}
                    >
                      {instance.status}
                    </span>
                  </td>
                  <td className="p-3">
                    {new Date(instance.updatedAt).toLocaleString()}
                  </td>
                  <td className="p-3">
                    {instance.outputHistory.length} files ·{" "}
                    {instance.printCount} prints
                    <details className="mt-1">
                      <summary className="text-[9px] text-[#a23f2b]">
                        {tr("查看歷史", "View history")}
                      </summary>
                      <div className="mt-1 max-w-64 space-y-1 border p-2 font-mono text-[8px]">
                        {instance.outputHistory.length
                          ? instance.outputHistory
                              .slice()
                              .reverse()
                              .map((entry, index) => (
                                <div key={index}>
                                  {String(
                                    entry.format || entry.mode || "output"
                                  )}{" "}
                                  ·{" "}
                                  {entry.createdAt
                                    ? new Date(
                                        Number(entry.createdAt)
                                      ).toLocaleString()
                                    : ""}
                                </div>
                              ))
                          : tr("沒有輸出紀錄", "No output history")}
                      </div>
                    </details>
                  </td>
                  <td className="p-3">
                    <div className="flex gap-1">
                      <button
                        className="icon-button !h-7 !w-7"
                        title={tr("開啟", "Open")}
                        onClick={() => onOpen(instance)}
                      >
                        <FileText size={12} />
                      </button>
                      <button
                        className="icon-button !h-7 !w-7"
                          title={tr("複製", "Duplicate")}
                        onClick={async () => {
                          const clearMedia = confirm(
                            tr("按「確定」清除簽名／圖片；按「取消」保留。 ", "Choose OK to clear signatures/images; choose Cancel to retain them. ")
                          );
                          const result = await clone.mutateAsync({
                            instanceId: instance.id,
                            clearMedia,
                          });
                          refresh();
                          toast.success(
                            tr(`已建立副本 ${result.instanceId}`, `Created copy ${result.instanceId}`)
                          );
                        }}
                      >
                        <Copy size={12} />
                      </button>
                      <button
                        className="icon-button !h-7 !w-7 !text-red-700"
                        title={tr("刪除", "Delete")}
                        onClick={async () => {
                            if (
                              confirm(
                                tr(`永久刪除「${instance.name}」？`, `Permanently delete "${instance.name}"?`)
                              )
                            ) {
                            await remove.mutateAsync({
                              instanceIds: [instance.id],
                            });
                            refresh();
                          }
                        }}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {filtered.length > perPage && (
        <div className="mt-3 flex items-center justify-center gap-3">
          <button
            className="btn-paper !min-h-8"
            disabled={page === 0}
            onClick={() => setPage(value => value - 1)}
          >
            {tr("上一頁", "Previous")}
          </button>
          <span className="text-xs">
            {page + 1} / {Math.ceil(filtered.length / perPage)}
          </span>
          <button
            className="btn-paper !min-h-8"
            disabled={(page + 1) * perPage >= filtered.length}
            onClick={() => setPage(value => value + 1)}
          >
            {tr("下一頁", "Next")}
          </button>
        </div>
      )}
    </>
  );
}
