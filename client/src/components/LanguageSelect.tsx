import * as React from "react";
import { useI18n, type UiLocale } from "@/lib/i18n";

export function LanguageSelect({ className = "" }: { className?: string }) {
  const { locale, setLocale, tr } = useI18n();
  return (
    <select
      className={`rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900 ${className}`}
      aria-label={tr("介面語言", "Interface language")}
      value={locale}
      onChange={event => setLocale(event.target.value as UiLocale)}
    >
      <option value="zh-Hant">繁體中文</option>
      <option value="zh-Hans">简体中文</option>
      <option value="en">English</option>
    </select>
  );
}
