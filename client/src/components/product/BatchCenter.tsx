import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Columns3,
  FileUp,
  Play,
  Save,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useI18n } from "@/lib/i18n";
import { uploadRawCsv } from "@/lib/document-files";
import { translateServerMessage } from "@/lib/server-messages";
import {
  CSV_PREVIEW_PAGE_SIZE,
} from "@/lib/csv-preview";
import type { FieldRecord, TemplateRecord } from "@/lib/product-types";

type MapRow = {
  csvField: string;
  sample: string;
  fieldId: string;
  confidence: "high" | "medium" | "low";
  confirmed: boolean;
};
type Analysis = {
  rows: Array<{
    rowNumber: number;
    mappedValues: Record<string, string>;
    issues: Array<{
      fieldId: string;
      code: string;
      message: string;
      blocking: boolean;
    }>;
    duplicate: null | {
      instanceId: string | null;
      name: string;
      values: Record<string, string>;
      differences: Array<{
        fieldId: string;
        oldValue: string;
        newValue: string;
      }>;
    };
  }>;
  totalRows: number;
  duplicateCount: number;
  warningCount: number;
  returnedRows: number;
  previewPage: number;
  pageSize: number;
};

const aliases: Record<string, string[]> = {
  name: ["姓名", "名字", "studentname", "fullname", "名称"],
  id: ["編號", "编号", "studentid", "number", "no"],
  email: ["電郵", "邮箱", "mail"],
  phone: ["電話", "电话", "contact", "mobile"],
  date: ["日期", "生日", "birthdate"],
  address: ["地址", "住址"],
  gender: ["性別", "性别", "sex"],
};
const normalized = (value: string) =>
  value.toLocaleLowerCase().replace(/[\s_\-./()（）:：]/g, "");
function score(csv: string, field: string) {
  const a = normalized(csv),
    b = normalized(field);
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.82;
  for (const words of Object.values(aliases))
    if (
      words.some(word => a.includes(normalized(word))) &&
      words.some(word => b.includes(normalized(word)))
    )
      return 0.78;
  const setA = new Set(a),
    setB = new Set(b);
  let overlap = 0;
  setA.forEach(character => {
    if (setB.has(character)) overlap += 1;
  });
  return overlap / Math.max(1, Math.max(setA.size, setB.size));
}

export function BatchCenter({
  templates,
  mappingTemplates,
  importRuns,
  onOpenInstance,
  refresh,
}: {
  templates: TemplateRecord[];
  mappingTemplates: Array<Record<string, unknown>>;
  importRuns: Array<Record<string, unknown>>;
  onOpenInstance: (id: string) => void;
  refresh: () => void;
}) {
  const { tr, locale } = useI18n();
  const fileInput = useRef<HTMLInputElement>(null);
  const published = templates.filter(
    template => template.currentPublishedVersionId
  );
  const [templateId, setTemplateId] = useState(published[0]?.id ?? "");
  const template = templates.find(item => item.id === templateId);
  const versionId = template?.currentPublishedVersionId ?? "";
  const versionQuery = trpc.formdigital.templates.getVersionDetails.useQuery(
    { versionId: versionId || "pending" },
    { enabled: Boolean(versionId) }
  );
  const fields = (versionQuery.data?.fields ?? []) as FieldRecord[];
  const preview = trpc.formdigital.imports.preview.useMutation();
  const analyze = trpc.formdigital.imports.analyze.useMutation();
  const create = trpc.formdigital.imports.create.useMutation();
  const resume = trpc.formdigital.imports.resume.useMutation();
  const saveMapping = trpc.formdigital.mappingTemplates.upsert.useMutation();
  const deleteMapping = trpc.formdigital.mappingTemplates.delete.useMutation();
  const [payload, setPayload] = useState<{
    sourceAssetId: string;
    filename: string;
    sourceHash: string;
    fingerprint: string;
    totalRows: number;
  } | null>(null);
  const [mappings, setMappings] = useState<MapRow[]>([]);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [previewPage, setPreviewPage] = useState(0);
  const [analysisDirty, setAnalysisDirty] = useState(false);
  const [rowCorrections, setRowCorrections] = useState<
    Record<number, Record<string, string>>
  >({});
  const [mode, setMode] = useState<"strict" | "tolerant">("strict");
  const [duplicateActions, setDuplicateActions] = useState<
    Record<
      number,
      {
        action: "skip" | "create" | "overwrite";
        instanceId?: string | null;
        mergedValues?: Record<string, string>;
      }
    >
  >({});
  const fieldLabels = useMemo(
    () =>
      fields.map(field => ({
        id: field.stableFieldId,
        label: String(
          (field.definition as Record<string, unknown> | null)?.label ||
            field.stableFieldId
        ),
      })),
    [fields]
  );
  const decisions = mappings.map(mapping => ({
    csvField: mapping.csvField,
    templateStableFieldId:
      mapping.fieldId === "__ignore__" ? null : mapping.fieldId || null,
    confidence: mapping.confidence,
    decision: !mapping.confirmed
      ? ("unresolved" as const)
      : mapping.fieldId === "__ignore__"
        ? ("ignored" as const)
        : ("accepted" as const),
  }));
  const unconfirmed = mappings.filter(
    mapping => !mapping.confirmed || !mapping.fieldId
  ).length;
  const localizeIssue = (issue: {
    fieldId: string;
    code: string;
    message: string;
  }) => {
    const label =
      fieldLabels.find(field => field.id === issue.fieldId)?.label ||
      issue.fieldId;
    const english =
      issue.code === "required"
        ? `${label} is required`
        : issue.code === "max_length"
          ? `${label} exceeds the maximum length`
          : issue.code === "number"
            ? `${label} must be a valid number`
            : issue.code === "min"
              ? `${label} is below the minimum`
              : issue.code === "max"
                ? `${label} is above the maximum`
                : issue.code === "date"
                  ? `${label} is not a valid date`
                  : issue.code === "time"
                    ? `${label} must use 24-hour HH:mm format`
                    : issue.code === "email"
                      ? `${label} is not a valid email`
                      : issue.code === "phone"
                        ? `${label} is not a valid phone number`
                        : issue.code === "regex"
                          ? `${label} does not match the configured rule`
                          : issue.code === "regex_config"
                            ? `${label} has an invalid Regex setting`
                            : issue.code === "checkbox"
                              ? `${label} is not a valid checkbox value`
                              : issue.code === "asset"
                                ? `${label} must use a saved local image or text signature`
                                : issue.code === "table"
                                  ? `${label} has invalid table data`
                                  : issue.code === "table_rows"
                                    ? `${label} exceeds the maximum row count`
                                    : issue.message;
    return tr(issue.message, english);
  };
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

  const chooseFile = async (file?: File) => {
    if (!file) return;
    try {
      const uploaded = await uploadRawCsv(file, { templateId, versionId });
      const result = await preview.mutateAsync({
        sourceAssetId: uploaded.assetId,
      });
      const saved = mappingTemplates.find(
        item =>
          item.templateVersionId === versionId &&
          item.sourceSchemaFingerprint === result.schemaFingerprint
      );
      const savedRows = Array.isArray(saved?.mapping)
        ? (saved.mapping as Array<{
            csvField?: string;
            templateStableFieldId?: string | null;
            decision?: string;
            confidence?: string;
          }>)
        : [];
      setMappings(
        result.headers.map(csvField => {
          const remembered = savedRows.find(item => item.csvField === csvField);
          if (remembered)
            return {
              csvField,
              sample: result.rows[0]?.[csvField] ?? "",
              fieldId:
                remembered.decision === "ignored"
                  ? "__ignore__"
                  : (remembered.templateStableFieldId ?? ""),
              confidence:
                (remembered.confidence as MapRow["confidence"]) || "high",
              confirmed: false,
            };
          const ranked = fieldLabels
            .map(field => ({ ...field, score: score(csvField, field.label) }))
            .sort((a, b) => b.score - a.score);
          const best = ranked[0];
          return {
            csvField,
            sample: result.rows[0]?.[csvField] ?? "",
            fieldId: best && best.score >= 0.5 ? best.id : "",
            confidence:
              best?.score >= 0.8
                ? "high"
                : best?.score >= 0.58
                  ? "medium"
                  : "low",
            confirmed: false,
          };
        })
      );
      setPayload({
        sourceAssetId: uploaded.assetId,
        filename: file.name,
        sourceHash: result.sourceHash,
        fingerprint: result.schemaFingerprint,
        totalRows: result.totalRows,
      });
      setAnalysis(null);
      setPreviewPage(0);
      setAnalysisDirty(false);
      setRowCorrections({});
      setDuplicateActions({});
      toast.success(
        tr(`已讀取 ${result.totalRows} 列；所有 Mapping 仍需人工確認。`, `Read ${result.totalRows} rows. Every mapping still needs human confirmation.`)
      );
    } catch (error) {
      serverError(error, "CSV 讀取失敗", "Could not read the CSV");
    }
  };
  const analyzeRows = async () => {
    if (!payload || !versionId || unconfirmed)
      return toast.error(tr("每一個 CSV 欄位都要確認配對或明確忽略。", "Every CSV field must be explicitly paired or ignored."));
    try {
      const result = await analyze.mutateAsync({
        templateVersionId: versionId,
        sourceAssetId: payload.sourceAssetId,
        sourceHash: payload.sourceHash,
        decisions,
        rowCorrections: Object.entries(rowCorrections).map(
          ([rowNumber, values]) => ({ rowNumber: Number(rowNumber), values })
        ),
        previewPage,
      });
      setAnalysis(result as Analysis);
      setPreviewPage(0);
      setAnalysisDirty(false);
      setDuplicateActions(
        Object.fromEntries(
          (result as Analysis).rows
            .filter(row => row.duplicate)
            .map(row => [
              row.rowNumber,
              {
                action: "skip",
                instanceId: row.duplicate!.instanceId,
                mergedValues: row.mappedValues,
              },
            ])
        )
      );
    } catch (error) {
      serverError(error, "匯入分析失敗", "Import analysis failed");
    }
  };
  const execute = async () => {
    if (!payload || !analysis || analysisDirty)
      return toast.error(
        tr("請先完成預覽、重新驗證修正值與重複資料決策。", "Finish previewing and revalidate corrections and duplicate decisions first.")
      );
    try {
      const result = await create.mutateAsync({
        templateVersionId: versionId,
        sourceAssetId: payload.sourceAssetId,
        sourceHash: payload.sourceHash,
        originalFilename: payload.filename,
        mode,
        decisions,
        duplicateDecisions: Object.entries(duplicateActions).map(
          ([rowNumber, item]) => ({ rowNumber: Number(rowNumber), ...item })
        ),
        rowCorrections: Object.entries(rowCorrections).map(
          ([rowNumber, values]) => ({ rowNumber: Number(rowNumber), values })
        ),
      });
      refresh();
      toast.success(
        tr(`匯入完成：建立 ${result.created}、重複 ${result.duplicate}、錯誤 ${result.failed}`, `Import complete: ${result.created} created, ${result.duplicate} duplicates, ${result.failed} errors`)
      );
      setPayload(null);
      setAnalysis(null);
      setPreviewPage(0);
      setMappings([]);
    } catch (error) {
      refresh();
      serverError(error, "匯入失敗；可由歷史 Resume。", "Import failed. Resume is available in history.");
    }
  };
  const saveCurrentMapping = async () => {
    if (!payload || unconfirmed)
      return toast.error(tr("請先確認全部 Mapping。", "Confirm all mappings first."));
    const name = prompt(
      tr("Mapping Template 名稱", "Mapping template name"),
      `${template?.name || "Template"} ${tr("Mapping", "Mapping")}`
    );
    if (!name?.trim()) return;
    try {
      await saveMapping.mutateAsync({
        templateVersionId: versionId,
        name: name.trim(),
        sourceSchemaFingerprint: payload.fingerprint,
        mapping: decisions,
      });
      refresh();
      toast.success(
        tr("Mapping Template 已保存；下次相同欄位會自動帶入，但仍需確認。", "Mapping template saved. The same columns will be suggested next time but still require confirmation.")
      );
    } catch (error) {
      serverError(error, "保存失敗", "Save failed");
    }
  };
  const previewPageCount = analysis
    ? Math.max(
        1,
        Math.ceil((analysis.totalRows || 0) / (analysis.pageSize || CSV_PREVIEW_PAGE_SIZE))
      )
    : 1;
  const displayedAnalysisRows = analysis
    ? analysis.rows
    : [];

  useEffect(() => {
    if (
      analysis &&
      !analysisDirty &&
      !analyze.isPending &&
      analysis.previewPage !== previewPage
    )
      void analyzeRows();
  });
  return (
    <div>
      <div className="section-line !mt-0">
        <div>
          <div className="eyebrow">CSV BATCH CENTER</div>
          <h2 className="!mt-2">
            {tr("Mapping、預覽、重複比較與匯入", "Mapping, preview, duplicate comparison, and import")}
          </h2>
          <p>
            {tr("智能建議不會靜默通過；每欄都必須人工確認。", "Smart suggestions never pass silently; every column needs human confirmation.")}
          </p>
        </div>
        <button
          className="btn-ink"
          onClick={() => fileInput.current?.click()}
          disabled={!versionId}
        >
          <FileUp size={14} />
          {tr("匯入 CSV", "Import CSV")}
        </button>
        <input
          ref={fileInput}
          hidden
          type="file"
          accept=".csv,text/csv"
          onChange={event => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            void chooseFile(file);
          }}
        />
      </div>
      <div className="grid gap-3 border bg-[#fffdfa] p-4 md:grid-cols-3">
        <div>
          <label className="setting-label !mt-0">
            {tr("已發佈 Template", "Published Template")}
          </label>
          <select
            className="setting-select"
            value={templateId}
            onChange={event => {
              setTemplateId(event.target.value);
              setPayload(null);
            }}
          >
            <option value="">{tr("請選擇", "Select")}</option>
            {published.map(item => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="setting-label !mt-0">
            {tr("錯誤模式", "Error mode")}
          </label>
          <select
            className="setting-select"
            value={mode}
            onChange={event => setMode(event.target.value as typeof mode)}
          >
            <option value="strict">
              {tr("嚴格：格式錯誤整批停止", "Strict: stop the batch on invalid rows")}
            </option>
            <option value="tolerant">
              {tr("容錯：建立正常列、保留錯誤摘要", "Tolerant: create valid rows and retain error summaries")}
            </option>
          </select>
        </div>
        <div className="flex items-end">
          <div className="w-full border bg-[#f7f4ee] p-2 text-xs">
            {payload
              ? `${payload.filename} · ${payload.totalRows} rows`
              : tr("尚未選擇 CSV", "No CSV selected")}
          </div>
        </div>
      </div>
      {payload && (
        <div className="mapping-layout mt-4">
          <section className="mapping-main overflow-auto">
            <div className="mapping-cover !min-h-28 !bg-none">
              <div className="eyebrow">MAPPING REVIEW</div>
              <h1>{tr("逐欄確認資料流向", "Confirm data flow column by column")}</h1>
              <p>{tr("低信心欄位必須改配或忽略；高信心亦需按確認。", "Low-confidence fields must be remapped or ignored. High-confidence fields still require confirmation.")}</p>
            </div>
            <table className="mapping-table">
              <thead>
                <tr>
                  <th>{tr("CSV 欄位", "CSV field")}</th>
                  <th>{tr("樣本", "Sample")}</th>
                  <th>{tr("Template 欄位", "Template field")}</th>
                  <th>{tr("信心", "Confidence")}</th>
                  <th>{tr("確認", "Confirmed")}</th>
                </tr>
              </thead>
              <tbody>
                {mappings.map((mapping, index) => (
                  <tr key={mapping.csvField}>
                    <td>{mapping.csvField}</td>
                    <td className="max-w-44 truncate">{mapping.sample}</td>
                    <td>
                      <select
                        value={mapping.fieldId}
                        onChange={event =>
                          setMappings(current =>
                            current.map((item, itemIndex) =>
                              itemIndex === index
                                ? {
                                    ...item,
                                    fieldId: event.target.value,
                                    confirmed: false,
                                  }
                                : item
                            )
                          )
                        }
                      >
                        <option value="">{tr("未配對", "Unmapped")}</option>
                        <option value="__ignore__">{tr("明確忽略", "Explicitly ignored")}</option>
                        {fieldLabels.map(field => (
                          <option key={field.id} value={field.id}>
                            {field.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <span className={`confidence ${mapping.confidence}`}>
                        {mapping.confidence.toUpperCase()}
                      </span>
                    </td>
                    <td>
                      <label className="flex items-center gap-1">
                        <input
                          type="checkbox"
                          disabled={!mapping.fieldId}
                          checked={mapping.confirmed}
                          onChange={event =>
                            setMappings(current =>
                              current.map((item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, confirmed: event.target.checked }
                                  : item
                              )
                            )
                          }
                        />
                        <span className="text-[9px]">{tr("已檢查", "Reviewed")}</span>
                      </label>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <aside className="mapping-side">
            <div className="eyebrow">{tr("執行前閘門", "Pre-execution gate")}</div>
            <h2>
              {unconfirmed
                ? tr(`${unconfirmed} 欄未確認`, `${unconfirmed} fields unconfirmed`)
                : tr("Mapping 已確認", "Mapping confirmed")}
            </h2>
            <div className="mapping-stat">
              <div>
                <b>{payload.totalRows}</b>
                <span>CSV rows</span>
              </div>
              <div>
                <b>{analysis?.duplicateCount ?? "—"}</b>
                <span>duplicates</span>
              </div>
            </div>
            {unconfirmed ? (
              <div className="warning-callout">
                <AlertTriangle size={14} className="mb-2" />
                {tr("所有欄位需人工確認或明確忽略。", "Every field needs human confirmation or explicit ignore.")}
              </div>
            ) : (
              <div className="border-l-4 border-emerald-600 bg-emerald-50 p-3 text-xs text-emerald-800">
                <Check size={14} className="mb-2" />
                {tr("可進入資料預覽。", "Data preview is available.")}
              </div>
            )}
            <button
              className="btn-paper mt-3 w-full"
              onClick={saveCurrentMapping}
              disabled={Boolean(unconfirmed)}
            >
              <Save size={13} />
              {tr("保存 Mapping Template", "Save mapping template")}
            </button>
            <button
              className="btn-ink mt-2 w-full"
              onClick={analyzeRows}
              disabled={Boolean(unconfirmed) || analyze.isPending}
            >
              <Play size={13} />
              {tr("預覽、驗證與查重", "Preview, validate, and check duplicates")}
            </button>
          </aside>
        </div>
      )}
      {analysis && (
        <section className="mt-4 border bg-[#fffdfa]">
          <header className="flex items-center justify-between border-b p-4">
            <div>
              <h3 className="text-sm font-semibold">
                {tr("匯入預覽", "Import preview")}
              </h3>
              <p className="mt-1 text-[10px] text-slate-500">
                {tr("共", "Total")} {analysis.totalRows} {tr("列", "rows")} ·{" "}
                {analysis.warningCount} {tr("列有警告", "rows have warnings")} ·{" "}
                {analysis.duplicateCount} {tr("個可能重複", "possible duplicates")} ·{" "}
                {tr("可直接修正欄位值", "field values can be corrected directly")}
              </p>
            </div>
            {analysisDirty ? (
              <button
                className="btn-ink"
                onClick={analyzeRows}
                disabled={analyze.isPending}
              >
                <Play size={13} />
                {tr("重新驗證修正值", "Revalidate corrections")}
              </button>
            ) : (
              <button
                className="btn-red"
                onClick={execute}
                disabled={create.isPending}
              >
                <Play size={13} />
                {tr("執行匯入", "Run import")}
              </button>
            )}
          </header>
          <div className="max-h-[520px] overflow-auto">
            <div className="sticky top-0 z-20 flex items-center justify-between border-b bg-[#fffdfa] px-3 py-2 text-[10px]">
              <span>
                {tr("顯示第", "Showing rows")}{" "}
                {analysis.rows.length ? previewPage * CSV_PREVIEW_PAGE_SIZE + 1 : 0}
                –
                {Math.min(
                  (previewPage + 1) * CSV_PREVIEW_PAGE_SIZE,
                  analysis.rows.length
                )}
                ，{tr("共", "total")} {analysis.rows.length}
              </span>
              <div className="flex items-center gap-2">
                <button
                  className="btn-paper !min-h-7"
                  disabled={previewPage === 0}
                  onClick={() => setPreviewPage(page => Math.max(0, page - 1))}
                >
                  {tr("上一頁", "Previous")}
                </button>
                <span>
                  {previewPage + 1}/{previewPageCount}
                </span>
                <button
                  className="btn-paper !min-h-7"
                  disabled={previewPage + 1 >= previewPageCount}
                  onClick={() =>
                    setPreviewPage(page =>
                      Math.min(previewPageCount - 1, page + 1)
                    )
                  }
                >
                  {tr("下一頁", "Next")}
                </button>
              </div>
            </div>
            <table className="w-full min-w-[760px] text-xs">
              <thead>
                <tr className="sticky top-0 bg-[#f2efe9]">
                  <th className="p-2 text-left">Row</th>
                  <th className="p-2 text-left">
                    {tr("映射資料／問題", "Mapped data / issues")}
                  </th>
                  <th className="p-2 text-left">
                    {tr("重複決策", "Duplicate decision")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {displayedAnalysisRows.map(row => (
                  <tr key={row.rowNumber} className="border-t align-top">
                    <td className="p-3 font-mono">{row.rowNumber}</td>
                    <td className="p-3">
                      <div className="grid grid-cols-2 gap-1">
                        {Object.entries(row.mappedValues).map(
                          ([key, value]) => (
                            <label key={key}>
                              <b className="text-[9px] text-slate-500">
                                {fieldLabels.find(field => field.id === key)
                                  ?.label || key}
                              </b>
                              <input
                                className="setting-input !mt-1 !h-8"
                                value={value}
                                onChange={event => {
                                  const nextValue = event.target.value;
                                  setRowCorrections(current => ({
                                    ...current,
                                    [row.rowNumber]: {
                                      ...(current[row.rowNumber] ??
                                        row.mappedValues),
                                      [key]: nextValue,
                                    },
                                  }));
                                  setAnalysis(current =>
                                    current
                                      ? {
                                          ...current,
                                          rows: current.rows.map(item =>
                                            item.rowNumber === row.rowNumber
                                              ? {
                                                  ...item,
                                                  mappedValues: {
                                                    ...item.mappedValues,
                                                    [key]: nextValue,
                                                  },
                                                }
                                              : item
                                          ),
                                        }
                                      : current
                                  );
                                  setAnalysisDirty(true);
                                }}
                              />
                            </label>
                          )
                        )}
                      </div>
                      {row.issues.map((issue, index) => (
                        <p
                          key={index}
                          className={`mt-1 text-[9px] ${issue.blocking ? "text-red-700" : "text-amber-700"}`}
                        >
                          {localizeIssue(issue)}
                        </p>
                      ))}
                    </td>
                    <td className="p-3">
                      {row.duplicate ? (
                        <div>
                          <div className="mb-2 border-l-2 border-amber-500 pl-2 text-[10px]">
                            {tr("可能與", "Possibly duplicates")}「
                            {row.duplicate.name === "同一 CSV 內重複"
                              ? tr("同一 CSV 內重複", "duplicate within this CSV")
                              : row.duplicate.name}
                            」
                          </div>
                          {row.duplicate.differences.map(difference => {
                            const action = duplicateActions[row.rowNumber];
                            const useNew =
                              action?.mergedValues?.[difference.fieldId] !==
                              difference.oldValue;
                            return (
                              <div
                                key={difference.fieldId}
                                className="mb-2 grid grid-cols-2 gap-1"
                              >
                                <button
                                  className={`border p-1 text-left text-[9px] ${!useNew ? "border-[#d9573b]" : ""}`}
                                  onClick={() =>
                                    setDuplicateActions(current => ({
                                      ...current,
                                      [row.rowNumber]: {
                                        action: "overwrite",
                                        instanceId: row.duplicate!.instanceId,
                                        mergedValues: {
                                          ...(current[row.rowNumber]
                                            ?.mergedValues ?? row.mappedValues),
                                          [difference.fieldId]:
                                            difference.oldValue,
                                        },
                                      },
                                    }))
                                  }
                                >
                                  {tr("舊：", "Old:")} {difference.oldValue}
                                </button>
                                <button
                                  className={`border p-1 text-left text-[9px] ${useNew ? "border-[#d9573b]" : ""}`}
                                  onClick={() =>
                                    setDuplicateActions(current => ({
                                      ...current,
                                      [row.rowNumber]: {
                                        action: "overwrite",
                                        instanceId: row.duplicate!.instanceId,
                                        mergedValues: {
                                          ...(current[row.rowNumber]
                                            ?.mergedValues ?? row.mappedValues),
                                          [difference.fieldId]:
                                            difference.newValue,
                                        },
                                      },
                                    }))
                                  }
                                >
                                  {tr("新：", "New:")} {difference.newValue}
                                </button>
                              </div>
                            );
                          })}
                          <select
                            className="setting-select"
                            value={
                              duplicateActions[row.rowNumber]?.action ?? "skip"
                            }
                            onChange={event =>
                              setDuplicateActions(current => ({
                                ...current,
                                [row.rowNumber]: {
                                  ...current[row.rowNumber],
                                  instanceId: row.duplicate!.instanceId,
                                  mergedValues:
                                    current[row.rowNumber]?.mergedValues ??
                                    row.mappedValues,
                                  action: event.target.value as
                                    | "skip"
                                    | "create"
                                    | "overwrite",
                                },
                              }))
                            }
                          >
                            <option value="skip">{tr("跳過新資料", "Skip new data")}</option>
                            <option value="create">{tr("照樣建立新 Instance", "Still create a new Instance")}</option>
                            {row.duplicate.instanceId && (
                              <option value="overwrite">
                                {tr("逐欄結果覆蓋舊 Instance", "Overwrite old Instance field by field")}
                              </option>
                            )}
                          </select>
                        </div>
                      ) : (
                        <span className="text-emerald-700">
                          {tr("沒有發現重複", "No duplicate found")}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        <section className="border bg-[#fffdfa] p-4">
          <h3 className="text-sm font-semibold">
            {tr("Mapping Templates", "Mapping templates")}
          </h3>
          <div className="mt-3 space-y-2">
            {mappingTemplates
              .filter(item => item.templateId === templateId)
              .map(item => (
                <div
                  key={String(item.id)}
                  className="flex items-center justify-between border p-2 text-xs"
                >
                  <div>
                    <b>{String(item.name)}</b>
                    <p className="text-[9px] text-slate-500">
                      {String(item.columnCount)} columns ·{" "}
                      {item.lastUsedAt
                        ? new Date(Number(item.lastUsedAt)).toLocaleDateString()
                        : tr("未使用", "Not used")}
                    </p>
                  </div>
                  <button
                    className="icon-button !h-7 !w-7 !text-red-700"
                    onClick={async () => {
                      if (confirm(tr("刪除此 Mapping Template？", "Delete this mapping template?"))) {
                        await deleteMapping.mutateAsync({
                          mappingTemplateId: String(item.id),
                        });
                        refresh();
                      }
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            {!mappingTemplates.some(item => item.templateId === templateId) && (
              <p className="text-xs text-slate-500">
                {tr("沒有已保存 Mapping。", "No saved mappings.")}
              </p>
            )}
          </div>
        </section>
        <section className="border bg-[#fffdfa] p-4">
          <h3 className="text-sm font-semibold">
            {tr("Import History 摘要", "Import history summary")}
          </h3>
          <div className="mt-3 space-y-2">
            {importRuns
              .filter(
                item => !templateId || item.templateVersionId === versionId
              )
              .slice()
              .reverse()
              .slice(0, 20)
              .map(run => (
                <div
                  key={String(run.id)}
                  className="flex items-center justify-between border p-2 text-xs"
                >
                  <div>
                    <b>
                      {String(run.status).toUpperCase()} ·{" "}
                      {String(run.totalRows)} rows
                    </b>
                    <p className="text-[9px] text-slate-500">
                      {tr("成功", "Success")} {String(run.successCount)}/
                      {tr("警告", "warnings")} {String(run.warningCount)}/
                      {tr("失敗", "failures")} {String(run.failedCount)}{" "}
                      · {new Date(Number(run.createdAt)).toLocaleString()}
                    </p>
                  </div>
                  {["failed", "running"].includes(String(run.status)) && (
                    <button
                      className="btn-paper !min-h-7"
                      onClick={async () => {
                        try {
                          await resume.mutateAsync({
                            importRunId: String(run.id),
                          });
                          refresh();
                        } catch (error) {
                          toast.error(
                            error instanceof Error
                              ? error.message
                              : tr("Resume 失敗", "Resume failed")
                          );
                        }
                      }}
                    >
                      Resume
                    </button>
                  )}
                </div>
              ))}
            {!importRuns.length && (
              <p className="text-xs text-slate-500">
                {tr("沒有匯入紀錄。", "No import history.")}
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
