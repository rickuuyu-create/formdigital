import * as React from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type UiLocale = "zh-Hant" | "zh-Hans" | "en";
type Translate = (
  key: keyof typeof ENGLISH_MESSAGES,
  traditionalChinese: string
) => string;

const ENGLISH_MESSAGES = {
  "nav.dashboard": "Dashboard",
  "nav.library": "Template Library",
  "nav.instances": "Completed forms",
  "nav.editor": "Template Editor",
  "nav.fill": "Fill an instance",
  "nav.batch": "CSV batch import",
  "nav.calibrate": "Print calibration",
  "nav.settings": "Settings",
  "login.connected": "Local Data Service connected",
  "login.unavailable": "Local Data Service is not running or cannot be reached",
  "login.reconnect": "Reconnect the Local Data Folder",
  "login.checking": "Checking the local service…",
  "login.reconnectHelp":
    "The original Local Data Folder may have been moved, renamed, or become unavailable. No empty replacement folder was created. Enter the full Windows path to the original FormdigitalData folder. Its structure will be verified before reconnection.",
  "login.originalPath": "Full Windows path to the original folder",
  "login.reconnecting": "Verifying the folder…",
  "login.reconnectAction": "Verify and reconnect",
  "login.recheck": "Check the local service again",
  "login.startupHint":
    "Start the application with start-formdigital-dev.cmd or npm run dev:local, wait until the Local Data Service reports connected, and then check again.",
  "login.google": "Sign in with Google",
  "onboarding.google": "Google sign-in",
  "onboarding.googleHelp":
    "Only the Google User ID is used to isolate each workspace.",
  "onboarding.folder": "Local data folder",
  "onboarding.folderHelp":
    "Confirm or move the Local Data Folder. It is the only source of product data.",
  "onboarding.hierarchy": "Understand the data hierarchy",
  "onboarding.hierarchyHelp":
    "A Template defines the layout, a Version is a locked snapshot, and an Instance is one completed form.",
  "onboarding.import": "Import your first form",
  "onboarding.importHelp":
    "Import PDF, JPG, PNG, multiple images, or a DOCX document.",
  "onboarding.ocr": "OCR and human review",
  "onboarding.ocrHelp":
    "Free local OCR only makes suggestions. You must confirm every field's name, type, and position.",
  "onboarding.publish": "Publish the Template",
  "onboarding.publishHelp":
    "All required fields must be confirmed before publishing. A published version cannot be edited in place.",
  "onboarding.instance": "Create an Instance",
  "onboarding.instanceHelp":
    "Create one form from a published version or create many from a CSV file.",
  "onboarding.output": "Preview, calibrate, and export",
  "onboarding.outputHelp":
    "After validation, export with the full background, print an overlay, create an editable PDF, or print a batch.",
  "onboarding.firstUse": "First-time setup",
  "onboarding.windowsPath": "Windows absolute path",
  "onboarding.moveHelp":
    "Data is copied and fully verified before switching folders. The original location is retained as a manual recovery copy.",
  "onboarding.folderConfirmed": "Folder confirmed",
  "onboarding.previous": "Back",
  "onboarding.next": "Next",
  "onboarding.confirmFolder": "Confirm folder",
  "onboarding.enter": "Enter workspace",
  "onboarding.moving": "Verifying and moving…",
  "settings.languageTheme": "Language and theme",
  "settings.interfaceLanguage": "Interface language",
  "settings.theme": "Theme:",
  "settings.system": "Follow system",
  "settings.dark": "Dark",
  "settings.light": "Light",
  "settings.cycleTheme": "(press to change)",
} as const;

type I18nContextValue = {
  locale: UiLocale;
  setLocale: (locale: UiLocale) => void;
  t: Translate;
  tr: (traditionalChinese: string, english: string) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);

/** Keep common product terms natural for readers of Simplified Chinese. */
export function simplifyUiTerminology(converted: string): string {
  return converted
    .replaceAll("本机资料", "本地数据")
    .replaceAll("资料夹", "文件夹")
    .replaceAll("资料", "数据")
    .replaceAll("介面", "界面")
    .replaceAll("可携备份", "便携备份")
    .replaceAll("设定", "设置")
    .replaceAll("帐号", "账户")
    .replaceAll("范本", "模板")
    .replaceAll("栏位", "字段")
    .replaceAll("侦测", "检测")
    .replaceAll("汇入", "导入")
    .replaceAll("储存", "保存")
    .replaceAll("复原", "恢复")
    .replaceAll("建立", "创建")
    .replaceAll("列印", "打印")
    .replaceAll("登入", "登录");
}

export function normalizeUiLocale(value: unknown): UiLocale {
  if (value === "zh-Hans" || value === "en") return value;
  return "zh-Hant";
}

function initialLocale(): UiLocale {
  if (typeof window === "undefined") return "zh-Hant";
  const stored = localStorage.getItem("formdigital.locale");
  if (stored) return normalizeUiLocale(stored);
  return "zh-Hant";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<UiLocale>(initialLocale);
  const [toSimplified, setToSimplified] = useState<
    ((value: string) => string) | null
  >(null);

  useEffect(() => {
    document.documentElement.lang = locale;
    localStorage.setItem("formdigital.locale", locale);
    if (locale !== "zh-Hans" || toSimplified) return;
    let active = true;
    void import("opencc-js").then(({ default: OpenCC }) => {
      if (active)
        setToSimplified(
          () => OpenCC.Converter({ from: "hk", to: "cn" }) as (value: string) => string
        );
    });
    return () => {
      active = false;
    };
  }, [locale, toSimplified]);

  const setLocale = useCallback((next: UiLocale) => {
    setLocaleState(normalizeUiLocale(next));
  }, []);
  const t = useCallback<Translate>(
    (key, traditionalChinese) => {
      if (locale === "en") return ENGLISH_MESSAGES[key];
      if (locale === "zh-Hans" && toSimplified)
        return simplifyUiTerminology(toSimplified(traditionalChinese));
      return traditionalChinese;
    },
    [locale, toSimplified]
  );
  const tr = useCallback(
    (traditionalChinese: string, english: string) => {
      if (locale === "en") return english;
      if (locale === "zh-Hans" && toSimplified)
        return simplifyUiTerminology(toSimplified(traditionalChinese));
      return traditionalChinese;
    },
    [locale, toSimplified]
  );
  const value = useMemo(
    () => ({ locale, setLocale, t, tr }),
    [locale, setLocale, t, tr]
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used within I18nProvider");
  return value;
}
