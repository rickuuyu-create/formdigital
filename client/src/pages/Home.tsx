import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type FormEvent } from "react";
import {
  Activity,
  CloudOff,
  Columns3,
  FilePlus2,
  FileText,
  FolderOpen,
  HardDrive,
  LayoutDashboard,
  Menu,
  Monitor,
  Plus,
  ScanText,
  Settings2,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  Star,
  Wrench,
} from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/_core/hooks/useAuth";
import { startLogin } from "@/const";
import { useIsMobile } from "@/hooks/useMobile";
import { trpc } from "@/lib/trpc";
import { googleAuthErrorMessage } from "@/lib/google-auth-errors";
import { LOCAL_EDITION } from "@/lib/local-edition";
import { normalizeUiLocale, useI18n } from "@/lib/i18n";
import {
  buildPreflightRequestInit,
  buildRecoveryRequestInit,
  interpretPreflightResponse,
  interpretRecoveryResponse,
  isLikelyWindowsAbsolutePath,
  recoveryUserMessage,
  RECOVERY_ENDPOINT,
  PREFLIGHT_ENDPOINT,
  type PreflightViewState,
  type RecoveryStatus,
} from "@/lib/local-recovery";
import type {
  FolderRecord,
  InstanceRecord,
  SavedValueRecord,
  TagRecord,
  TemplateRecord,
} from "@/lib/product-types";
import { BatchCenter } from "@/components/product/BatchCenter";
import { CalibrationPanel } from "@/components/product/CalibrationPanel";
import { InstancesCenter } from "@/components/product/InstancesCenter";
import { InstanceStudio } from "@/components/product/InstanceStudio";
import { Onboarding } from "@/components/product/Onboarding";
import { SettingsPanel } from "@/components/product/SettingsPanel";
import { SourceImportDialog } from "@/components/product/SourceImportDialog";
import { TemplateEditor } from "@/components/product/TemplateEditor";
import { TemplateLibrary } from "@/components/product/TemplateLibrary";
import { hasSeenWorkspaceTour, TourSettings, WorkspaceTour, type TourView } from "@/components/product/WorkspaceTour";
import { PracticeEntry } from '@/components/product/TemplatePractice';
import { LoginScreen } from "@/components/local/LoginScreen";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";

type View =
  | "dashboard"
  | "library"
  | "editor"
  | "fill"
  | "instances"
  | "batch"
  | "calibrate"
  | "settings";
type RouteState = { view: View; versionId?: string; instanceId?: string };
type NavItem = {
  id: View;
  label: string;
  icon: ComponentType<{ size?: number }>;
};

function localizeRecoveryMessage(
  status: RecoveryStatus | "network_error",
  tr: (traditionalChinese: string, english: string) => string
): string {
  const english: Record<RecoveryStatus | "network_error", string> = {
    invalid_request: "Enter a valid full Windows path.",
    reconnect_failed: "Could not verify or reconnect that folder. Check that it is the original FormdigitalData folder and that you can access it.",
    unavailable: "The local data service cannot be reached. Check that it is running, then try again.",
    forbidden: "The security check failed. Reconnect only from the local Form Digital page.",
    network_error: "Reconnection failed. Check that Form Digital is still running, then try again.",
    reconnected: "",
    not_required: "",
  };
  return tr(recoveryUserMessage(status), english[status]);
}

const supportedViews: View[] = [
  "dashboard",
  "library",
  "editor",
  "fill",
  "instances",
  "batch",
  "calibrate",
  "settings",
];
const primaryNavigation: NavItem[] = [
  { id: "dashboard", label: "工作總覽", icon: LayoutDashboard },
  { id: "library", label: "範本庫", icon: FolderOpen },
  { id: "instances", label: "已填表格", icon: FileText },
];
const workflowNavigation: NavItem[] = [
  { id: "editor", label: "範本編輯器", icon: ScanText },
  { id: "fill", label: "填寫表格", icon: FilePlus2 },
  { id: "batch", label: "CSV 批量匯入", icon: Columns3 },
  { id: "calibrate", label: "列印校準", icon: SlidersHorizontal },
];

function readRoute(): RouteState {
  const params = new URLSearchParams(window.location.search);
  const candidate = params.get("view") as View | null;
  return {
    view:
      candidate && supportedViews.includes(candidate) ? candidate : "dashboard",
    versionId: params.get("version") || undefined,
    instanceId: params.get("instance") || undefined,
  };
}

function routeUrl(route: RouteState) {
  const params = new URLSearchParams();
  if (route.view !== "dashboard") params.set("view", route.view);
  if (route.versionId) params.set("version", route.versionId);
  if (route.instanceId) params.set("instance", route.instanceId);
  const query = params.toString();
  return query ? `/?${query}` : "/";
}

function initials(name?: string | null, email?: string | null) {
  const source = name?.trim() || email?.split("@")[0] || "FD";
  return source
    .split(/\s+/)
    .map(part => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function NavigationButton({
  item,
  active,
  onClick,
}: {
  item: NavItem;
  active: boolean;
  onClick: () => void;
}) {
  const Icon = item.icon;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        data-tour={`nav-${item.id}`}
        className="nav-menu-button"
        isActive={active}
        onClick={onClick}
        tooltip={item.label}
      >
        <Icon size={16} />
        <span>{item.label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function LoadingScreen({
  text = "正在開啟本機 Workspace…",
}: {
  text?: string;
}) {
  const { tr } = useI18n();
  return (
    <main className="grid min-h-screen place-items-center bg-[#f4f1eb] p-6">
      <div className="text-center">
        <Activity className="mx-auto animate-pulse text-[#a23f2b]" />
        <p className="mt-4 text-sm text-slate-600">
          {text === "正在開啟本機 Workspace…"
            ? tr(text, "Opening the local workspace…")
            : text}
        </p>
      </div>
    </main>
  );
}

function IntegrityRepairScreen({
  findings,
  repairing,
  error,
  onRepair,
  onRescan,
}: {
  findings: Array<{ severity: string; code: string; detail?: string }>;
  repairing: boolean;
  error?: string;
  onRepair: () => void;
  onRescan: () => void;
}) {
  const { tr } = useI18n();
  return (
    <main className="grid min-h-screen place-items-center bg-[#f4f1eb] p-6">
      <section className="w-full max-w-2xl border border-red-300 bg-[#fffdfa] p-7 shadow-xl">
        <ShieldAlert className="text-red-700" size={30} />
        <h1 className="mt-4 text-xl font-semibold text-[#17364d]">
          {tr(
            "Local Data Folder 完整性檢查未通過",
            "Local Data Folder integrity check failed"
          )}
        </h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          {tr(
            "為避免損壞擴大，Workspace 已停止載入。安全修復會先建立逐位元 Emergency Backup，再把無法驗證的資產索引移到隔離區；若備份失敗，系統不會改動任何資料。",
            "The workspace has stopped loading to prevent further damage. Safe repair first creates a bit-for-bit emergency backup, then quarantines unverifiable asset indexes. No data is changed if the backup fails."
          )}
        </p>
        <div className="mt-5 max-h-52 overflow-auto border bg-red-50 p-3 text-xs text-red-900">
          {findings
            .filter(item => item.severity === "error")
            .map((item, index) => (
              <div
                key={`${item.code}-${index}`}
                className="border-b py-2 last:border-0"
              >
                <b>{item.code}</b>
                {item.detail ? `：${item.detail}` : ""}
              </div>
            ))}
        </div>
        {error && (
          <p role="alert" className="mt-3 text-xs text-red-700">
            {error}
          </p>
        )}
        <div className="mt-5 flex flex-wrap gap-2">
          <button className="btn-red" disabled={repairing} onClick={onRepair}>
            <Wrench size={14} />
            {repairing
              ? tr("正在建立備份及修復…", "Creating backup and repairing…")
              : tr(
                  "建立 Emergency Backup 並安全修復",
                  "Create emergency backup and repair safely"
                )}
          </button>
          <button className="btn-paper" disabled={repairing} onClick={onRescan}>
            {tr("重新檢查", "Check again")}
          </button>
        </div>
      </section>
    </main>
  );
}

function Dashboard({
  templates,
  instances,
  onCreate,
  onLibrary,
  onBatch,
  onEdit,
  onFill,
  onOpenInstance,
}: {
  templates: TemplateRecord[];
  instances: InstanceRecord[];
  onCreate: () => void;
  onLibrary: () => void;
  onBatch: () => void;
  onEdit: (versionId: string) => void;
  onFill: (versionId: string) => void;
  onOpenInstance: (instance: InstanceRecord) => void;
}) {
  const { tr } = useI18n();
  const highlighted = useMemo(
    () =>
      templates
        .slice()
        .sort(
          (a, b) =>
            Number(b.pinned) - Number(a.pinned) ||
            Number(b.favorite) - Number(a.favorite) ||
            b.lastOpenedAt - a.lastOpenedAt
        )
        .slice(0, 6),
    [templates]
  );
  const recentInstances = useMemo(
    () =>
      instances
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 8),
    [instances]
  );
  const draftCount = templates.filter(
    template => template.currentDraftVersionId
  ).length;
  return (
    <div>
      <section className="hero-local-workbench border border-[#d5d0c7] bg-[#fffdfa] p-7 shadow-sm sm:p-10">
        <div className="eyebrow">LOCAL WORKSPACE</div>
        <h1 className="mt-3 max-w-3xl text-3xl font-bold tracking-tight text-[#112c42] sm:text-5xl">
          {tr(
            "從紙本或 Office 文件，建立可重用的數碼表格。",
            "Create reusable digital forms from paper or Office documents."
          )}
        </h1>
        <p className="mt-4 max-w-2xl text-sm leading-7 text-slate-600">
          {tr(
            "匯入每一頁、人工確認欄位、鎖定 Version，再建立單份或批量 Instance。資料、資產、備份及輸出均保存於 localhost Local Data Folder。",
            "Import every page, review the detected fields, lock a version, then create one or many instances. Data, assets, backups, and outputs stay in the localhost Local Data Folder."
          )}
        </p>
        <div className="mt-6 flex flex-wrap gap-2">
          <button data-tour="dashboard-import" className="btn-ink" onClick={onCreate}>
            <Plus size={15} />
            {tr("匯入 PDF／DOCX／圖片", "Import PDF, DOCX, or images")}
          </button>
          <button className="btn-paper" onClick={onLibrary}>
            <FolderOpen size={15} />
            Template Library
          </button>
          <button className="btn-paper" onClick={onBatch}>
            <Columns3 size={15} />
            {tr("CSV 批量匯入", "CSV batch import")}
          </button>
        </div>
      </section>
      <section className="mt-5 grid gap-3 sm:grid-cols-3">
        {[
          [
            "Templates",
            templates.length,
            tr(`${draftCount} 個 Draft`, `${draftCount} drafts`),
          ],
          [
            "Instances",
            instances.length,
            tr(
              `${instances.filter(item => item.status === "completed").length} 個已完成`,
              `${instances.filter(item => item.status === "completed").length} completed`
            ),
          ],
          [
            "Printed",
            instances.reduce((sum, item) => sum + item.printCount, 0),
            tr("確認送出列印次數", "Confirmed print jobs"),
          ],
        ].map(([label, value, note]) => (
          <article key={String(label)} className="border bg-[#fffdfa] p-5">
            <div className="font-mono text-[10px] tracking-widest text-slate-500">
              {label}
            </div>
            <b className="mt-2 block text-3xl text-[#17364d]">{value}</b>
            <span className="text-[11px] text-slate-500">{note}</span>
          </article>
        ))}
      </section>
      <div className="section-line">
        <div>
          <div className="eyebrow">PINNED & RECENT</div>
          <h2>{tr("常用 Template", "Pinned and recent templates")}</h2>
        </div>
        <button className="text-action" onClick={onLibrary}>
          {tr("查看全部", "View all")}
        </button>
      </div>
      {highlighted.length ? (
        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {highlighted.map(template => (
            <article key={template.id} className="border bg-[#fffdfa] p-5">
              <div className="flex items-center justify-between">
                <span className="tag-strip !mb-0">
                  {template.lifecycle.toUpperCase()}
                </span>
                {(template.pinned || template.favorite) && (
                  <Star
                    size={14}
                    fill="currentColor"
                    className="text-amber-500"
                  />
                )}
              </div>
              <h3 className="mt-5 text-base font-semibold text-[#17364d]">
                {template.name}
              </h3>
              <p className="mt-2 min-h-10 text-xs leading-5 text-slate-500">
                {template.description || tr("未加入說明", "No description")}
              </p>
              <div className="mt-4 flex gap-2">
                <button
                  className="btn-ink !min-h-8 flex-1"
                  disabled={!template.currentPublishedVersionId}
                  onClick={() =>
                    template.currentPublishedVersionId &&
                    onFill(template.currentPublishedVersionId)
                  }
                >
                  {tr("填表", "Fill")}
                </button>
                <button
                  className="btn-paper !min-h-8 flex-1"
                  onClick={() => {
                    const id =
                      template.currentDraftVersionId ||
                      template.currentPublishedVersionId;
                    if (id) onEdit(id);
                  }}
                >
                  {tr("編輯", "Edit")}
                </button>
              </div>
            </article>
          ))}
        </section>
      ) : (
        <EmptyState onCreate={onCreate} />
      )}
      <div className="section-line">
        <div>
          <div className="eyebrow">RECENT INSTANCES</div>
          <h2>{tr("最近填寫", "Recent instances")}</h2>
        </div>
      </div>
      <section className="overflow-auto border bg-[#fffdfa]">
        <table className="w-full min-w-[650px] border-collapse text-xs">
          <thead>
            <tr className="bg-[#f2efe9] text-left text-[10px] text-slate-600">
              <th className="p-3">{tr("名稱", "Name")}</th>
              <th className="p-3">{tr("狀態", "Status")}</th>
              <th className="p-3">{tr("修改時間", "Modified")}</th>
              <th className="p-3">{tr("列印", "Prints")}</th>
            </tr>
          </thead>
          <tbody>
            {recentInstances.length ? (
              recentInstances.map(instance => (
                <tr key={instance.id} className="border-t">
                  <td className="p-3">
                    <button
                      className="font-semibold text-[#17364d] hover:underline"
                      onClick={() => onOpenInstance(instance)}
                    >
                      {instance.name}
                    </button>
                  </td>
                  <td className="p-3">{instance.status}</td>
                  <td className="p-3">
                    {new Date(instance.updatedAt).toLocaleString()}
                  </td>
                  <td className="p-3">{instance.printCount}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td className="p-8 text-center text-slate-500" colSpan={4}>
                  {tr("尚未建立 Instance", "No instances yet")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  const { tr } = useI18n();
  return (
    <section className="grid min-h-64 place-items-center border border-dashed bg-[#fffdfa] p-8 text-center">
      <div>
        <Sparkles className="mx-auto text-[#a23f2b]" />
        <h3 className="mt-4 text-base font-semibold text-[#17364d]">
          {tr("建立第一個正式 Template", "Create your first template")}
        </h3>
        <p className="mt-2 text-xs leading-5 text-slate-500">
          {tr(
            "支援 PDF、DOCX、JPG、PNG、多張圖片及相機。",
            "Supports PDF, DOCX, JPG, PNG, multiple images, and camera capture."
          )}
        </p>
        <button className="btn-ink mt-5" onClick={onCreate}>
          <Plus size={14} />
          {tr("開始匯入", "Start import")}
        </button>
      </div>
    </section>
  );
}

export default function Home() {
  const { setLocale, t, tr } = useI18n();
  const { user, loading, error, isAuthenticated, logout } = useAuth();
  const isMobile = useIsMobile();
  const utils = trpc.useUtils();
  const [route, setRoute] = useState<RouteState>(readRoute);
  const [importOpen, setImportOpen] = useState(false);
  const [practiceRequested, setPracticeRequested] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [preflight, setPreflight] = useState<PreflightViewState>("checking");
  const [reconnectPending, setReconnectPending] = useState(false);
  const [reconnectError, setReconnectError] = useState<string | undefined>();
  const [desktopOnMobile, setDesktopOnMobile] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);
  const tourAutoAttempted = useRef(false);
  const tourReturnRoute = useRef<RouteState>({ view: "dashboard" });
  const [reconnectPath, setReconnectPath] = useState("");
  const integrityQuery = trpc.formdigital.localData.startupIntegrity.useQuery(
    undefined,
    { enabled: isAuthenticated, retry: false, staleTime: Infinity }
  );
  const dashboardQuery = trpc.formdigital.dashboard.useQuery(undefined, {
    enabled: isAuthenticated && integrityQuery.data?.healthy === true,
    retry: false,
  });
  const localStatusQuery = trpc.formdigital.localData.status.useQuery(
    undefined,
    { enabled: isAuthenticated, retry: false, refetchInterval: 30_000 }
  );
  const preferencesMutation = trpc.formdigital.preferences.useMutation();
  const moveFolderMutation = trpc.formdigital.localData.move.useMutation();
  const reconnectFolderMutation =
    trpc.formdigital.localData.reconnect.useMutation();
  const touchTemplateMutation = trpc.formdigital.templates.touch.useMutation();
  const repairIntegrityMutation = trpc.formdigital.localData.repair.useMutation(
    {
      onSuccess: async result => {
        if (result.after.healthy)
          toast.success(tr("完整性修復完成，Emergency Backup 已保留。", "Integrity repair finished. The emergency backup was kept."));
        else
          toast.error(
            tr("仍有無法自動修復的 Workspace 問題，請由 Emergency Backup 還原。", "Some workspace issues could not be repaired automatically. Restore from the emergency backup.")
          );
        await integrityQuery.refetch();
      },
    }
  );

  const runPreflight = async (): Promise<PreflightViewState> => {
    try {
      const response = await fetch(PREFLIGHT_ENDPOINT, buildPreflightRequestInit());
      return await interpretPreflightResponse(response);
    } catch {
      return "unavailable";
    }
  };
  useEffect(() => {
    let active = true;
    void runPreflight().then(state => {
      if (active) setPreflight(state);
    });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    const pop = () => setRoute(readRoute());
    const onOnline = () => setOnline(true),
      onOffline = () => setOnline(false);
    window.addEventListener("popstate", pop);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("popstate", pop);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  const navigate = (next: RouteState, replace = false) => {
    (replace ? window.history.replaceState : window.history.pushState).call(
      window.history,
      {},
      "",
      routeUrl(next)
    );
    setRoute(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  // The guide visits read-only overview pages. It never opens a real form or adds history entries.
  const tourNavigate = useCallback((view: TourView) => {
    window.history.replaceState({}, "", routeUrl({ view }));
    setRoute({ view });
    window.scrollTo({ top: 0, behavior: "instant" });
  }, []);
  const startTour = () => {
    tourAutoAttempted.current = true;
    tourReturnRoute.current = route;
    setDesktopOnMobile(true);
    setTourOpen(true);
  };
  const refresh = async () => {
    await Promise.all([
      utils.formdigital.dashboard.invalidate(),
      utils.formdigital.collections.invalidate(),
      utils.formdigital.localData.status.invalidate(),
    ]);
  };
  const handleReconnect = async (event: FormEvent) => {
    event.preventDefault();
    const path = reconnectPath.trim();
    if (!isLikelyWindowsAbsolutePath(path)) {
      setReconnectError(localizeRecoveryMessage("invalid_request", tr));
      return;
    }
    setReconnectPending(true);
    setReconnectError(undefined);
    try {
      const response = await fetch(
        RECOVERY_ENDPOINT,
        buildRecoveryRequestInit(path)
      );
      const status = await interpretRecoveryResponse(response);
      if (status === "reconnected" || status === "not_required") {
        setReconnectPath("");
        const nextPreflight = await runPreflight();
        setPreflight(nextPreflight);
        if (nextPreflight !== "ok") {
          setReconnectError(
            nextPreflight === "unavailable"
              ? localizeRecoveryMessage("unavailable", tr)
              : localizeRecoveryMessage("reconnect_failed", tr)
          );
        }
      } else {
        if (status === "unavailable") setPreflight("unavailable");
        setReconnectError(localizeRecoveryMessage(status, tr));
      }
    } catch {
      setReconnectError(localizeRecoveryMessage("network_error", tr));
    } finally {
      setReconnectPending(false);
    }
  };
  const dashboard = dashboardQuery.data;
  const templates = (dashboard?.templates ?? []) as TemplateRecord[];
  const instances = (dashboard?.instances ?? []) as InstanceRecord[];
  const folders = (dashboard?.folders ?? []) as FolderRecord[];
  const tags = (dashboard?.tags ?? []) as TagRecord[];
  const savedValues = (dashboard?.savedValues ?? []) as SavedValueRecord[];
  const mappingTemplates = (dashboard?.mappingTemplates ?? []) as Array<
    Record<string, unknown>
  >;
  const importRuns = (dashboard?.importRuns ?? []) as Array<
    Record<string, unknown>
  >;
  const preferences = (dashboard?.preferences ?? {}) as Record<string, unknown>;
  useEffect(() => {
    const ready = isAuthenticated && preflight === "ok" && integrityQuery.data?.healthy === true
      && dashboardQuery.isSuccess && localStatusQuery.isSuccess && preferences.onboardingCompleted === true;
    // Never interrupt an existing editor, filled form, import, or other open dialog.
    if (!ready || importOpen || tourOpen || tourAutoAttempted.current
      || (route.view !== "dashboard" && route.view !== "library")) return;
    if (document.querySelector('dialog[open], [role="dialog"], [role="alertdialog"]')) return;
    tourAutoAttempted.current = true;
    if (!hasSeenWorkspaceTour()) {
      tourReturnRoute.current = route;
      setDesktopOnMobile(true);
      setTourOpen(true);
    }
  }, [isAuthenticated, preflight, integrityQuery.data?.healthy, dashboardQuery.isSuccess,
    localStatusQuery.isSuccess, preferences.onboardingCompleted, importOpen, tourOpen, route]);
  useEffect(() => {
    if (dashboard)
      setLocale(normalizeUiLocale(preferences.locale));
  }, [dashboard, preferences.locale, setLocale]);
  const dataFolder = String(
    (localStatusQuery.data as { dataFolder?: string } | undefined)
      ?.dataFolder ?? ""
  );
  const mobileFocus =
    isMobile && !desktopOnMobile && preferences.mobileDesktopOverride !== true;
  const localizedPrimaryNavigation: NavItem[] = [
    { id: "dashboard", label: t("nav.dashboard", "工作總覽"), icon: LayoutDashboard },
    { id: "library", label: t("nav.library", "範本庫"), icon: FolderOpen },
    { id: "instances", label: t("nav.instances", "已填表格"), icon: FileText },
  ];
  const localizedWorkflowNavigation: NavItem[] = [
    { id: "editor", label: t("nav.editor", "範本編輯器"), icon: ScanText },
    { id: "fill", label: t("nav.fill", "填寫表格"), icon: FilePlus2 },
    { id: "batch", label: t("nav.batch", "CSV 批量匯入"), icon: Columns3 },
    { id: "calibrate", label: t("nav.calibrate", "列印校準"), icon: SlidersHorizontal },
  ];
  const currentLabel =
    [
      ...localizedPrimaryNavigation,
      ...localizedWorkflowNavigation,
      { id: "settings" as const, label: t("nav.settings", "設定"), icon: Settings2 },
    ].find(item => item.id === route.view)?.label ?? t("nav.dashboard", "工作總覽");

  const openEditor = (versionId: string) => {
    const template = templates.find(
      item =>
        item.currentDraftVersionId === versionId ||
        item.currentPublishedVersionId === versionId
    );
    if (template) touchTemplateMutation.mutate({ templateId: template.id });
    navigate({ view: "editor", versionId });
  };
  const openFill = (versionId: string) => {
    const template = templates.find(
      item => item.currentPublishedVersionId === versionId
    );
    if (template) touchTemplateMutation.mutate({ templateId: template.id });
    navigate({ view: "fill", versionId });
  };
  const navOnly = (view: View) => {
    if (view === "editor") {
      const versionId =
        templates.find(item => item.currentDraftVersionId)
          ?.currentDraftVersionId || templates[0]?.currentPublishedVersionId;
      if (!versionId)
        return toast.info(tr("請先建立 Template。", "Create a template first."));
      return openEditor(versionId);
    }
    if (view === "fill") {
      const versionId = templates.find(
        item => item.currentPublishedVersionId
      )?.currentPublishedVersionId;
      if (!versionId)
        return toast.info(
          tr(
            "請先發佈至少一個 Template Version。",
            "Publish at least one template version first."
          )
        );
      return openFill(versionId);
    }
    navigate({ view });
  };

  if (loading)
    return (
      <LoadingScreen
        text={LOCAL_EDITION ? tr("正在開啟本機工作區…", "Opening local workspace…") : tr("正在確認 Google Session…", "Checking the Google session…")}
      />
    );
  if (!isAuthenticated)
    return (
      <LoginScreen
        localOnly={LOCAL_EDITION}
        ready={preflight}
        error={
          reconnectError ||
          error?.message ||
          (!LOCAL_EDITION && googleAuthErrorMessage(
            new URLSearchParams(window.location.search).get("authError")
          )) ||
          undefined
        }
        reconnectPath={reconnectPath}
        reconnectPending={reconnectPending}
        onReconnectPathChange={value => {
          setReconnectPath(value);
          setReconnectError(undefined);
        }}
        onReconnectSubmit={handleReconnect}
        onRecheck={() => {
          setReconnectError(undefined);
          setPreflight("checking");
          void runPreflight().then(setPreflight);
          if (LOCAL_EDITION) void utils.auth.me.invalidate();
        }}
      />
    );
  if (integrityQuery.isLoading || localStatusQuery.isLoading)
    return (
      <LoadingScreen
        text={tr(
          "正在執行 Local Data Folder 啟動完整性檢查…",
          "Checking Local Data Folder integrity…"
        )}
      />
    );
  if (localStatusQuery.data?.status === "reconnect_required")
    return (
      <main className="grid min-h-screen place-items-center bg-[#f4f1eb] p-6">
        <section className="w-full max-w-xl border border-amber-300 bg-[#fffdfa] p-7 shadow-xl">
          <HardDrive className="text-amber-700" size={30} />
          <h1 className="mt-4 text-xl font-semibold text-[#17364d]">
            {tr(
              "需要重新連接 Local Data Folder",
              "Reconnect the Local Data Folder"
            )}
          </h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            {tr(
              "原資料夾可能已移動、改名或暫時失去權限。系統沒有建立新的空白資料夾；請輸入現有 FormdigitalData 的完整 Windows 路徑，驗證通過後才會切換。",
              "The original folder may have moved, been renamed, or become unavailable. No empty replacement was created. Enter the full Windows path to the existing FormdigitalData folder; the app switches only after verification."
            )}
          </p>
          <div className="mt-3 border bg-amber-50 p-3 font-mono text-xs text-amber-900">
            {tr("原設定", "Previous setting")}：{localStatusQuery.data.root}
          </div>
          <label className="setting-label">
            {tr(
              "現有資料夾的 Windows 絕對路徑",
              "Absolute Windows path to the existing folder"
            )}
          </label>
          <input
            className="setting-input"
            value={reconnectPath}
            onChange={event => setReconnectPath(event.target.value)}
            placeholder="D:\\FormdigitalData"
          />
          {reconnectFolderMutation.error && (
            <p role="alert" className="mt-3 text-xs text-red-700">
              {reconnectFolderMutation.error.message}
            </p>
          )}
          <button
            className="btn-ink mt-4"
            disabled={
              !reconnectPath.trim() || reconnectFolderMutation.isPending
            }
            onClick={async () => {
              try {
                await reconnectFolderMutation.mutateAsync({
                  dataFolder: reconnectPath.trim(),
                });
                window.location.reload();
              } catch {
                // Mutation error is rendered above.
              }
            }}
          >
            <HardDrive size={14} />
            {tr("驗證並重新連接", "Verify and reconnect")}
          </button>
        </section>
      </main>
    );
  if (integrityQuery.data && !integrityQuery.data.healthy)
    return (
      <IntegrityRepairScreen
        findings={integrityQuery.data.findings}
        repairing={repairIntegrityMutation.isPending}
        error={repairIntegrityMutation.error?.message}
        onRepair={() => repairIntegrityMutation.mutate()}
        onRescan={() => integrityQuery.refetch()}
      />
    );
  if (dashboardQuery.isLoading) return <LoadingScreen />;
  if (dashboardQuery.error || localStatusQuery.error || integrityQuery.error)
    return (
      <main className="grid min-h-screen place-items-center bg-[#f4f1eb] p-6">
        <div className="max-w-lg border border-red-200 bg-[#fffdfa] p-7 text-center">
          <CloudOff className="mx-auto text-red-600" />
          <h1 className="mt-4 text-lg font-semibold">
            {tr("無法開啟 Local Workspace", "Unable to open local workspace")}
          </h1>
          <p className="mt-2 text-xs leading-5 text-slate-600">
            {dashboardQuery.error?.message ||
              localStatusQuery.error?.message ||
              integrityQuery.error?.message}
          </p>
          <button
            className="btn-ink mt-5"
            onClick={() => window.location.reload()}
          >
            {tr("重新檢查", "Check again")}
          </button>
        </div>
      </main>
    );
  if (preferences.onboardingCompleted !== true)
    return (
      <Onboarding
        dataFolder={dataFolder}
        moving={moveFolderMutation.isPending}
        onMoveFolder={async path => {
          await moveFolderMutation.mutateAsync({ dataFolder: path });
          await refresh();
        }}
        onComplete={async () => {
          await preferencesMutation.mutateAsync({
            onboardingCompleted: true,
            onboardingCompletedAt: new Date().toISOString(),
          });
          await refresh();
        }}
      />
    );

  const content =
    route.view === "library" ? (
      <TemplateLibrary
        templates={templates}
        folders={folders}
        tags={tags}
        onCreate={() => setImportOpen(true)}
        onOpenVersion={openFill}
        onEditVersion={openEditor}
        refresh={refresh}
      />
    ) : route.view === "editor" && route.versionId ? (
      <TemplateEditor
        versionId={route.versionId}
        onBack={() => navigate({ view: "library" })}
        onFill={openFill}
        refresh={refresh}
      />
    ) : route.view === "fill" && (route.versionId || route.instanceId) ? (
      <InstanceStudio
        versionId={route.versionId}
        instanceId={route.instanceId}
        savedValues={savedValues}
        onBack={() => navigate({ view: "instances" })}
        onCreated={instanceId => navigate({ view: "fill", instanceId }, true)}
        refresh={refresh}
      />
    ) : route.view === "instances" ? (
      <InstancesCenter
        instances={instances}
        templates={templates}
        onOpen={instance => navigate({ view: "fill", instanceId: instance.id })}
        refresh={refresh}
      />
    ) : route.view === "batch" ? (
      <BatchCenter
        templates={templates}
        mappingTemplates={mappingTemplates}
        importRuns={importRuns}
        onOpenInstance={instanceId => navigate({ view: "fill", instanceId })}
        refresh={refresh}
      />
    ) : route.view === "calibrate" ? (
      <CalibrationPanel templates={templates} refresh={refresh} />
    ) : route.view === "settings" ? (
      <>
      <TourSettings key={String(tourOpen)} onReplay={startTour} onSchedule={() => { tourAutoAttempted.current = true; }} />
      <SettingsPanel
        dataFolder={dataFolder}
        preferences={preferences}
        folders={folders}
        tags={tags}
        templates={templates}
        onLogout={async () => {
          await logout();
          navigate({ view: "dashboard" }, true);
        }}
        refresh={refresh}
      />
      </>
    ) : (
      <Dashboard
        templates={templates}
        instances={instances}
        onCreate={() => setImportOpen(true)}
        onLibrary={() => navigate({ view: "library" })}
        onBatch={() => navigate({ view: "batch" })}
        onEdit={openEditor}
        onFill={openFill}
        onOpenInstance={instance =>
          navigate({ view: "fill", instanceId: instance.id })
        }
      />
    );

  if (mobileFocus && route.view === "dashboard")
    return (
      <main className="min-h-screen bg-[#f4f1eb] p-4">
        <header className="flex items-center justify-between border bg-[#102a43] p-4 text-white">
          <div>
            <b className="tracking-widest">FORMDIGITAL</b>
            <div className="mt-1 text-[9px] text-slate-300">MOBILE CAPTURE</div>
          </div>
          <button
            className="btn-paper !min-h-8"
            onClick={() => setDesktopOnMobile(true)}
          >
            <Monitor size={13} />
            {tr("完整工作台", "Full workspace")}
          </button>
        </header>
        <section className="mt-4 border bg-[#fffdfa] p-6">
          <div className="eyebrow">QUICK START</div>
          <h1 className="mt-3 text-2xl font-bold text-[#17364d]">
            {tr("拍攝或匯入表格", "Capture or import a form")}
          </h1>
          <p className="mt-2 text-xs leading-6 text-slate-500">
            {tr(
              "手機模式優先提供建立 Template 和填寫已發佈表格；完整座標編輯建議切換桌面工作台。",
              "Mobile mode focuses on creating templates and filling published forms. Switch to the desktop workspace for full coordinate editing."
            )}
          </p>
          <button
            className="btn-ink mt-5 w-full"
            onClick={() => setImportOpen(true)}
          >
            <Plus size={15} />
            {tr("相機／PDF／DOCX／圖片", "Camera, PDF, DOCX, or images")}
          </button>
          <div className="mt-5 grid gap-2">
            {templates
              .filter(item => item.currentPublishedVersionId)
              .slice(0, 8)
              .map(template => (
                <button
                  key={template.id}
                  className="flex items-center justify-between border p-4 text-left text-xs"
                  onClick={() =>
                    template.currentPublishedVersionId &&
                    openFill(template.currentPublishedVersionId)
                  }
                >
                  <span>{template.name}</span>
                  <FileText size={14} />
                </button>
              ))}
          </div>
        </section>
        <SourceImportDialog
          open={importOpen}
          onClose={() => setImportOpen(false)}
          onCreated={versionId => {
            setImportOpen(false);
            openEditor(versionId);
          }}
        />
      </main>
    );

  return (
    <SidebarProvider defaultOpen>
      <div className="app-shell flex min-h-screen w-full">
        <Sidebar className="app-sidebar" collapsible="icon">
          <SidebarHeader>
            <button
              className="brand-lockup text-left"
              onClick={() => navOnly("dashboard")}
            >
              <strong>FORMDIGITAL</strong>
              <span>LOCAL WORKSPACE</span>
            </button>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel className="nav-section-label">
                Workspace
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {localizedPrimaryNavigation.map(item => (
                    <NavigationButton
                      key={item.id}
                      item={item}
                      active={route.view === item.id}
                      onClick={() => navOnly(item.id)}
                    />
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
            <SidebarGroup>
              <SidebarGroupLabel className="nav-section-label">
                Workflow
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {localizedWorkflowNavigation.map(item => (
                    <NavigationButton
                      key={item.id}
                      item={item}
                      active={route.view === item.id}
                      onClick={() => navOnly(item.id)}
                    />
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
          <SidebarFooter className="sidebar-bottom">
            <SidebarMenu>
              <NavigationButton
                item={{
                  id: "settings",
                  label: tr("設定與備份", "Settings and backup"),
                  icon: Settings2,
                }}
                active={route.view === "settings"}
                onClick={() => navOnly("settings")}
              />
            </SidebarMenu>
            <div className="local-status px-2 pt-3">
              <span
                className={`local-dot ${localStatusQuery.isError ? "!bg-red-500" : ""}`}
              />
              {tr("localhost 已連線", "localhost connected")}
            </div>
          </SidebarFooter>
        </Sidebar>
        <SidebarInset className="workspace min-w-0">
          {!LOCAL_EDITION && !online && (
            <div
              role="status"
              className="flex items-center justify-center gap-2 bg-amber-100 px-4 py-2 text-xs text-amber-900"
            >
              <CloudOff size={14} />
              {LOCAL_EDITION
                ? tr("網絡已離線；本機工作區仍可使用。", "Network offline. The local workspace remains available.")
                : tr(
                    "網絡離線；Local Workspace 仍可使用，Google 重新登入及 Tunnel 暫不可用。",
                    "Network offline. The local workspace remains available, but Google sign-in and tunnel access are temporarily unavailable."
                  )}
            </div>
          )}
          <header className="topbar">
            <div className="topbar-left">
              <SidebarTrigger data-tour="workspace-menu">
                <Menu size={16} />
              </SidebarTrigger>
              <div>
                <div className="topbar-title">{currentLabel}</div>
                <div className="topbar-kicker">
                  LOCAL DATA FOLDER · {dataFolder || "CONNECTED"}
                </div>
              </div>
            </div>
            <div className="topbar-right">
              <button
                data-tour="create-template"
                className="btn-red !min-h-8"
                onClick={() => setImportOpen(true)}
              >
                <Plus size={13} />
                {tr("建立 Template", "Create template")}
              </button>
              <button
                className="icon-button"
                title={tr("設定", "Settings")}
                onClick={() => navOnly("settings")}
              >
                <Settings2 size={15} />
              </button>
              <div
                className="avatar"
                title={user?.email ?? user?.name ?? (LOCAL_EDITION ? tr("本機工作區", "Local workspace") : "Google account")}
              >
                {user?.avatarUrl ? (
                  <img
                    src={user.avatarUrl}
                    alt={tr("Google 頭像", "Google profile")}
                    referrerPolicy="no-referrer"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  initials(user?.name, user?.email)
                )}
              </div>
            </div>
          </header>
          <main
            data-tour-page={route.view}
            className={`page-content ${route.view === "editor" || route.view === "fill" ? "!p-2" : ""}`}
          >
            {content}
            {['dashboard','library','settings'].includes(route.view) && <PracticeEntry templates={templates} onResume={openEditor} onStart={() => { setPracticeRequested(true); setImportOpen(true); }} />}
          </main>
        </SidebarInset>
      </div>
      <SourceImportDialog
        key={practiceRequested ? 'practice' : 'normal'}
        practice={practiceRequested}
        open={importOpen}
        onClose={() => { setImportOpen(false); setPracticeRequested(false); }}
        onCreated={versionId => {
          setImportOpen(false);
          refresh();
          openEditor(versionId);
        }}
      />
      {tourOpen && <WorkspaceTour onNavigate={tourNavigate} onClose={completed => {
        setTourOpen(false);
        const next = completed ? { view: "dashboard" as const } : tourReturnRoute.current;
        navigate(next, true);
        requestAnimationFrame(() => {
          const target = document.querySelector<HTMLButtonElement>(
            completed ? '[data-tour="practice-start"]' : next.view === "settings" ? '[data-tour="tour-settings"] button' : '[data-tour="dashboard-import"], [data-tour="create-template"]'
          );
          if (completed) target?.scrollIntoView({ block: "center", behavior: "instant" });
          target?.focus({ preventScroll: true });
        });
      }} />}
    </SidebarProvider>
  );
}
