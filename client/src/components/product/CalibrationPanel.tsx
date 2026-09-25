import { useEffect, useState } from "react";
import { Crosshair, Printer, Save } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useI18n } from "@/lib/i18n";
import { openLocalOutput } from "@/lib/document-files";
import type { TemplateRecord } from "@/lib/product-types";

export function CalibrationPanel({ templates, refresh }: { templates: TemplateRecord[]; refresh: () => void }) {
  const { tr } = useI18n();
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const template = templates.find((item) => item.id === templateId);
  const [profile, setProfile] = useState({ xOffsetMm: 0, yOffsetMm: 0, xScale: 100, yScale: 100 });
  const saveProfile = trpc.formdigital.templates.savePrintProfile.useMutation();
  const testPage = trpc.formdigital.exports.calibrationTest.useMutation();
  useEffect(() => { const current = template?.printProfile ?? {}; setProfile({ xOffsetMm: Number(current.xOffsetMm ?? 0), yOffsetMm: Number(current.yOffsetMm ?? 0), xScale: Number(current.xScale ?? 100), yScale: Number(current.yScale ?? 100) }); }, [templateId, template?.updatedAt]);
  const update = (key: keyof typeof profile, value: number) => setProfile((current) => ({ ...current, [key]: value }));
  const controls = [
    ["xOffsetMm", tr("X 偏移", "X offset")],
    ["yOffsetMm", tr("Y 偏移", "Y offset")],
    ["xScale", tr("X 縮放", "X scale")],
    ["yScale", tr("Y 縮放", "Y scale")],
  ] as const;

  return (
    <div>
      <div className="section-line !mt-0">
        <div>
          <div className="eyebrow">PRINT CALIBRATION</div>
          <h2 className="!mt-2">{tr("毫米級套印校準", "Millimetre overlay calibration")}</h2>
          <p>{tr("設定保存於 Template，Preview 與 PDF 共用同一物理座標來源。", "Settings are stored on the Template. Preview and PDF share one physical coordinate source.")}</p>
        </div>
      </div>
      <div className="calibrate-layout">
        <section className="calibrate-main">
          <header className="calibration-header">
            <div>
              <h1>{tr("校準測試頁", "Calibration test page")}</h1>
              <p>{tr("列印時請選「實際大小／100%」，關閉 Fit to page。", "When printing, choose Actual size / 100% and turn off Fit to page.")}</p>
            </div>
            <Crosshair className="text-[#a23f2b]" />
          </header>
          <div className="calibration-visual !bg-none">
            <div className="mx-auto aspect-[210/297] w-full max-w-md border bg-white p-8 shadow-xl">
              <div
                className="relative h-full border border-slate-400"
                style={{
                  transform: `translate(${profile.xOffsetMm / 2}px, ${profile.yOffsetMm / 2}px) scale(${profile.xScale / 100}, ${profile.yScale / 100})`,
                }}
              >
                <div
                  className="absolute inset-0"
                  style={{
                    backgroundImage:
                      "linear-gradient(#d5dadd 1px,transparent 1px),linear-gradient(90deg,#d5dadd 1px,transparent 1px)",
                    backgroundSize: "10% 7%",
                  }}
                />
                <div className="absolute left-1/2 top-1/2 h-8 w-px -translate-y-1/2 bg-red-600" />
                <div className="absolute left-1/2 top-1/2 h-px w-8 -translate-x-1/2 bg-red-600" />
              </div>
            </div>
            <div className="calibration-note">
              <span>{tr("目前設定", "Current settings")}</span>
              <b>
                X {profile.xOffsetMm >= 0 ? "+" : ""}
                {profile.xOffsetMm} mm / Y {profile.yOffsetMm >= 0 ? "+" : ""}
                {profile.yOffsetMm} mm / {profile.xScale}% × {profile.yScale}%
              </b>
            </div>
          </div>
        </section>
        <aside className="calibrate-aside">
          <h2>Template Print Profile</h2>
          <p>{tr("每個 Template 保存一套設定；只影響輸出，不改寫已發佈 Version。", "Each Template stores one profile. It affects output only and never rewrites a published Version.")}</p>
          <label className="setting-label">Template</label>
          <select
            className="setting-select"
            value={templateId}
            onChange={(event) => setTemplateId(event.target.value)}
          >
            <option value="">{tr("請選擇", "Select")}</option>
            {templates.map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
          {controls.map(([key, label]) => (
            <div className="calibration-control" key={key}>
              <label>
                {label}
                <small>{key.includes("Scale") ? "%" : "mm"}</small>
              </label>
              <input
                type="number"
                step={0.1}
                value={profile[key]}
                onChange={(event) => update(key, Number(event.target.value))}
              />
            </div>
          ))}
          <button
            className="btn-ink mt-4 w-full"
            disabled={!templateId}
            onClick={async () => {
              try {
                await saveProfile.mutateAsync({ templateId, printProfile: profile });
                refresh();
                toast.success(tr("校準已保存並會套用到之後輸出", "Calibration saved. Future output will use it."));
              } catch (error) {
                toast.error(error instanceof Error ? error.message : tr("保存失敗", "Save failed"));
              }
            }}
          >
            <Save size={14} />
            {tr("保存校準", "Save calibration")}
          </button>
          <button
            className="btn-paper mt-2 w-full"
            disabled={!templateId}
            onClick={async () => {
              try {
                const result = await testPage.mutateAsync({ templateId, ...profile });
                if (!openLocalOutput(result.url))
                  toast.error(tr("瀏覽器阻擋了測試頁視窗。", "The browser blocked the test-page window."));
              } catch (error) {
                toast.error(error instanceof Error ? error.message : tr("測試頁建立失敗", "Could not create the test page"));
              }
            }}
          >
            <Printer size={14} />
            {tr("建立並列印測試頁", "Create and print test page")}
          </button>
        </aside>
      </div>
    </div>
  );
}
