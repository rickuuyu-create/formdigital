import { useState } from "react";
import { ArrowLeft, ArrowRight, Check, FolderOpen, HardDrive, LayoutTemplate, Printer, ScanText, Sheet, Sparkles } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { LOCAL_EDITION } from "@/lib/local-edition";
import { LanguageSelect } from "@/components/LanguageSelect";

export function Onboarding({ dataFolder, onMoveFolder, onComplete, moving }: { dataFolder: string; onMoveFolder: (path: string) => Promise<void>; onComplete: () => Promise<void>; moving: boolean }) {
  const { t, tr } = useI18n();
  const steps = [
    ...(!LOCAL_EDITION ? [{ title: t("onboarding.google", "Google 登入"), description: t("onboarding.googleHelp", "身份只使用 Google User ID 作 Workspace 隔離。"), icon: Check }] : []),
    { title: t("onboarding.folder", "本機資料資料夾"), description: t("onboarding.folderHelp", "確認或搬移 Local Data Folder；它是唯一資料來源。"), icon: HardDrive },
    { title: t("onboarding.hierarchy", "理解資料層級"), description: t("onboarding.hierarchyHelp", "Template 是版型；Version 是鎖定快照；Instance 是每一份已填表格。"), icon: LayoutTemplate },
    { title: t("onboarding.import", "匯入第一份表格"), description: t("onboarding.importHelp", "可匯入 PDF、JPG、PNG、多張圖片或 DOCX。"), icon: FolderOpen },
    { title: t("onboarding.ocr", "OCR 與人工確認"), description: t("onboarding.ocrHelp", "免費本機 OCR 只提出建議，您要確認名稱、類型及位置。"), icon: Sparkles },
    { title: t("onboarding.publish", "發佈 Template"), description: t("onboarding.publishHelp", "所有必要欄位確認後才可發佈；已發佈版本不可原地修改。"), icon: ScanText },
    { title: t("onboarding.instance", "建立 Instance"), description: t("onboarding.instanceHelp", "從已發佈版本建立單份資料，或用 CSV 批量建立。"), icon: Sheet },
    { title: t("onboarding.output", "預覽、校準與輸出"), description: t("onboarding.outputHelp", "驗證通過後可完整背景輸出、套印、Editable PDF 或批量列印。"), icon: Printer },
  ];
  const folderStep = LOCAL_EDITION ? 0 : 1;
  const [step, setStep] = useState(0);
  const [folder, setFolder] = useState(dataFolder);
  const [folderConfirmed, setFolderConfirmed] = useState(false);
  const current = steps[step]!;
  const Icon = current.icon;
  const next = async () => {
    if (step === folderStep && !folderConfirmed) {
      if (folder.trim() !== dataFolder) await onMoveFolder(folder.trim());
      setFolderConfirmed(true);
      return;
    }
    if (step === steps.length - 1) await onComplete();
    else setStep((value) => value + 1);
  };
  return <main className="min-h-screen bg-[#f4f1eb] p-4 sm:p-8">
    <section className="mx-auto grid min-h-[620px] max-w-5xl border border-[#d9d4ca] bg-[#fffdfa] shadow-xl md:grid-cols-[260px_1fr]">
      <aside className="bg-[#102a43] p-6 text-white">
        <div className="text-xs font-bold tracking-[.2em]">FORMDIGITAL</div>
        <LanguageSelect className="mt-4" />
        <p className="mt-2 text-xs leading-5 text-slate-300">{t("onboarding.firstUse", "首次設定")} · {step + 1}/{steps.length}</p>
        <ol className="mt-8 space-y-1" aria-label="Onboarding steps">{steps.map((item, index) => <li key={item.title} className={`flex items-center gap-3 border-l-2 px-3 py-2 text-xs ${index === step ? "border-[#d9573b] bg-white/10 text-white" : index < step ? "border-emerald-400 text-emerald-100" : "border-transparent text-slate-400"}`}><span className="font-mono">{String(index + 1).padStart(2, "0")}</span>{item.title}</li>)}</ol>
      </aside>
      <div className="flex flex-col p-7 sm:p-12">
        <div className="grid h-12 w-12 place-items-center border border-[#d9573b] bg-[#f8e7e2] text-[#a23f2b]"><Icon size={22} /></div>
        <div className="eyebrow mt-7">STEP {String(step + 1).padStart(2, "0")}</div>
        <h1 className="mt-3 text-3xl font-bold tracking-tight text-[#122f45]">{current.title}</h1>
        <p className="mt-3 max-w-xl text-sm leading-7 text-slate-600">{current.description}</p>
        {step === folderStep && <div className="mt-8 max-w-xl border border-[#d9d4ca] bg-[#f7f4ee] p-5">
          <label className="block text-xs font-semibold text-slate-700" htmlFor="onboarding-folder">{t("onboarding.windowsPath", "Windows 絕對路徑")}</label>
          <input id="onboarding-folder" className="setting-input mt-2" value={folder} onChange={(event) => { setFolder(event.target.value); setFolderConfirmed(false); }} placeholder="D:\\FormdigitalData" />
          <p className="mt-3 text-xs leading-5 text-slate-500">{t("onboarding.moveHelp", "搬移會先複製並驗證全部資料，成功後才切換。原位置保留作人工復原副本。")}</p>
          {folderConfirmed && <p className="mt-3 flex items-center gap-2 text-xs text-emerald-700"><Check size={14} />{t("onboarding.folderConfirmed", "資料夾已確認")}</p>}
        </div>}
        {step === folderStep + 1 && <div className="mt-8 grid max-w-2xl gap-3 sm:grid-cols-3">{[["Template",tr("固定版面及欄位設計", "Reusable layout and field design")],["Version",tr("可發佈、不可變的快照", "A published, immutable snapshot")],["Instance",tr("綁定某一 Version 的填寫資料", "A filled form linked to one version")]].map(([title, body]) => <div key={title} className="border border-[#d9d4ca] p-4"><b className="text-sm text-[#19364d]">{title}</b><p className="mt-2 text-xs leading-5 text-slate-500">{body}</p></div>)}</div>}
        <div className="mt-auto flex items-center justify-between border-t border-[#e7e1d8] pt-6">
          <button className="btn-paper" disabled={step === 0 || moving} onClick={() => setStep((value) => Math.max(0, value - 1))}><ArrowLeft size={14} />{t("onboarding.previous", "上一步")}</button>
          <button className="btn-ink" disabled={moving} onClick={next}>{moving ? t("onboarding.moving", "正在驗證及搬移…") : step === folderStep && !folderConfirmed ? t("onboarding.confirmFolder", "確認資料夾") : step === steps.length - 1 ? t("onboarding.enter", "進入工作台") : t("onboarding.next", "下一步")}<ArrowRight size={14} /></button>
        </div>
      </div>
    </section>
  </main>;
}
