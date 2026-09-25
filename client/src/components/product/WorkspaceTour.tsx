import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowRight, Compass, RotateCcw } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import "./workspace-tour.css";

export const WORKSPACE_TOUR_KEY = "formdigital.workspace-tour.v1";
export type TourView =
  | "dashboard"
  | "library"
  | "instances"
  | "batch"
  | "calibrate"
  | "settings";

export function hasSeenWorkspaceTour() {
  try {
    return localStorage.getItem(WORKSPACE_TOUR_KEY) === "seen";
  } catch {
    return true;
  }
}

function rememberTour() {
  try {
    localStorage.setItem(WORKSPACE_TOUR_KEY, "seen");
  } catch {
    /* Optional browser preference. */
  }
}

type Step = {
  page: TourView;
  target?: string;
  mobileTarget?: string;
  title: [string, string];
  body: [string, string];
};

const steps: Step[] = [
  {
    page: "dashboard",
    title: ["歡迎使用 Formdigital", "Welcome to Formdigital"],
    body: [
      "用約兩分鐘認識從原表到輸出的操作。按「下一步」跟著看，也可以隨時跳過，稍後在設定重播。\n導覽期間只介紹功能，不會替你建立或修改表格。",
      "Take about two minutes to learn the path from an original form to an export. Choose Next to follow along, or skip and replay from Settings later.\nThe tour only explains features; it does not create or edit your forms.",
    ],
  },
  {
    page: "dashboard",
    target: '[data-tour="create-template"]',
    mobileTarget: '[data-tour="dashboard-import"]',
    title: ["① 先匯入一份原表", "① Import an original form"],
    body: [
      "從這裡選擇 PDF、Word（DOCX）或圖片，建立可重複使用的範本。匯入時逐頁檢查；收據等附件可以保留頁面而不建立填寫欄位。",
      "Choose a PDF, Word (DOCX) file, or image here to create a reusable template. Review each page during import; receipt pages can be retained without adding fillable fields.",
    ],
  },
  {
    page: "library",
    target: '[data-tour-page="library"] h2',
    title: ["② 在範本庫整理版型", "② Find your templates"],
    body: [
      "範本就是可重用的空白版型。Draft 表示仍在準備，按「編輯」可繼續；「填表」變灰時，表示尚未有已發佈版本。",
      "A template is a reusable form layout. Draft means it is still being prepared: choose Edit to continue. A disabled Fill button means there is no published version yet.",
    ],
  },
  {
    page: "library",
    target: '[data-tour="nav-editor"]',
    mobileTarget: '[data-tour="workspace-menu"]',
    title: ["③ 確認欄位，再發佈", "③ Review fields, then publish"],
    body: [
      "在「範本編輯器」核對欄位名稱、類型、位置及表格公式。自動辨識只提供建議，圈選框也要對準原表；逐項確認後才發佈。\n手機可從左上角選單找到編輯器，精細對位建議使用電腦。",
      "In Template Editor, review field names, types, positions, and table formulas. Detection only offers suggestions; choice marks must also align with the original. Review the fields before publishing.\nOn a phone, open the top-left menu to find the editor. A computer is easier for precise alignment.",
    ],
  },
  {
    page: "library",
    target: '[data-tour="nav-fill"]',
    mobileTarget: '[data-tour="workspace-menu"]',
    title: ["④ 用已發佈範本填表", "④ Fill a published template"],
    body: [
      "發佈後，在範本卡片按「填表」，建立一份獨立的填寫紀錄。儲存後可以再開啟；日後修改範本，請建立新版本，舊紀錄仍保留原來版型。",
      "After publishing, choose Fill on the template card to create a separate filled record. Save it to reopen later. To change the template, create a new version; existing records keep their original layout.",
    ],
  },
  {
    page: "instances",
    target: '[data-tour-page="instances"] h2',
    title: ["⑤ 重開紀錄，檢查輸出", "⑤ Reopen records and check exports"],
    body: [
      "在「已填表格」找到儲存的紀錄，開啟後可繼續填寫或輸出 PDF。請打開輸出檔檢查文字、圈選及頁數；確認後才按「我已檢查這份輸出」。",
      "Find saved records here and reopen them to continue filling or export a PDF. Open the exported file and check its text, choice marks, and page count before choosing “I checked this output”.",
    ],
  },
  {
    page: "batch",
    target: '[data-tour-page="batch"] select',
    title: ["⑥ 多份資料可用 CSV 匯入", "⑥ Import many records with CSV"],
    body: [
      "先選已發佈的範本，再上傳 CSV，逐欄確認資料要填到哪個欄位。匯入前檢查錯誤及重複資料；第一次使用可先從單份填表開始。",
      "Select a published template, upload a CSV, and match each column to a form field. Review errors and duplicates before importing. For your first try, start with a single form.",
    ],
  },
  {
    page: "calibrate",
    target: '[data-tour-page="calibrate"] h2',
    title: ["⑦ 套印前先校準", "⑦ Calibrate before overlay printing"],
    body: [
      "要把答案印在已有格線的紙本上，先列印測試頁並量度偏移，再調整位置與比例。一般連原表的 PDF 輸出不需要先做這一步。",
      "To print answers onto preprinted paper, print a test page, measure the offset, and adjust position and scale. A normal PDF including the original form does not require this step first.",
    ],
  },
  {
    page: "settings",
    target: '[data-tour="backup-create"]',
    title: ["⑧ 定期備份你的工作", "⑧ Back up your work"],
    body: [
      "表格和填寫紀錄保存在本機資料夾。在這裡建立可攜備份，下載後另存一份；換電腦或還原前，先確認備份檔可用。",
      "Forms and filled records are saved in the local data folder. Create a portable backup here, download it, and keep another copy. Check the backup before moving computers or restoring data.",
    ],
  },
  {
    page: "settings",
    target: '[data-tour="tour-settings"]',
    title: ["⑨ 忘記操作時，回來重播", "⑨ Replay whenever you need help"],
    body: [
      "「重新播放教學」會立即重看。「下次進入時自動播放」適合把這個瀏覽器交給新同事。觀看紀錄只記在這個瀏覽器，不會改動表格資料。",
      "Replay tour starts it immediately. Play automatically next time is useful before handing this browser to a colleague. The viewing preference stays in this browser and does not change your form data.",
    ],
  },
  {
    page: "dashboard",
    title: [
      "準備好了，從一份簡單原表開始",
      "You are ready to try your first form",
    ],
    body: [
      "按「完成」回到工作總覽，再按「匯入 PDF／DOCX／圖片」選擇原表。記住這個順序：匯入 → 確認欄位 → 發佈 → 填寫 → 檢查輸出。",
      "Choose Finish to return to the dashboard, then Import PDF, DOCX, or images to choose an original form. Follow this order: import → review fields → publish → fill → check the export.",
    ],
  },
  {
    page: "dashboard",
    target: '[data-tour="practice-start"]',
    title: ["⑩ 建議先做範本實習", "⑩ Start with template practice"],
    body: [
      "第一次建立範本，建議先按「開始新的範本實習」。它會用八頁示範原表，帶你逐步練習欄位、單選與多選圈選、表格及公式；熟悉後再匯入自己的表格。按「完成」後，這個按鈕會保持選取，供你開始練習。",
      "If this is your first template, choose Start a new practice. The eight-page example walks you through fields, single- and multiple-choice marks, tables, and formulas. Then import your own form. After Finish, this button will be focused so you can start.",
    ],
  },
];

export function TourSettings({
  onReplay,
  onSchedule,
}: {
  onReplay: () => void;
  onSchedule: () => void;
}) {
  const { tr } = useI18n();
  const [scheduled, setScheduled] = useState(() => !hasSeenWorkspaceTour());
  const [storageError, setStorageError] = useState(false);
  return (
    <section data-tour="tour-settings" className="tour-settings">
      <div className="flex items-center gap-2">
        <Compass size={18} />
        <h2>{tr("首次使用指南", "First-use guide")}</h2>
      </div>
      <p>
        {tr(
          "用聚光燈逐步認識功能的位置與使用順序，約需兩分鐘。",
          "A spotlight tour of the controls and workflow, taking about two minutes."
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-ink" onClick={onReplay}>
          <RotateCcw size={14} />
          {tr("重新播放教學", "Replay tour")}
        </button>
        <button
          type="button"
          className="btn-paper"
          onClick={() => {
            try {
              localStorage.removeItem(WORKSPACE_TOUR_KEY);
              setScheduled(true);
              setStorageError(false);
              onSchedule();
            } catch {
              setStorageError(true);
            }
          }}
        >
          {tr("下次進入時自動播放", "Play automatically next time")}
        </button>
      </div>
      <p role="status">
        {storageError
          ? tr(
              "瀏覽器未允許儲存偏好，仍可使用「重新播放教學」。",
              "This browser cannot save the preference. You can still replay the tour."
            )
          : scheduled
            ? tr(
                "已設定：下次重新開啟工作總覽或範本庫時播放。",
                "Scheduled for the next visit to the dashboard or template library."
              )
            : tr(
                "可隨時重播；設定只套用於這個瀏覽器。",
                "Replay any time. This preference applies only to this browser."
              )}
      </p>
    </section>
  );
}

/** A native modal keeps the entire workspace inert, including the spotlight hole. */
export function WorkspaceTour({
  onNavigate,
  onClose,
}: {
  onNavigate: (page: TourView) => void;
  onClose: (completed: boolean) => void;
}) {
  const { tr } = useI18n();
  const [index, setIndex] = useState(0);
  const [missing, setMissing] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const spotRef = useRef<HTMLDivElement>(null);
  const shadeRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const step = steps[index];
  const close = (completed: boolean) => {
    rememberTour();
    onClose(completed);
  };

  useLayoutEffect(() => {
    const dialog = dialogRef.current!;
    const previousFocus = document.activeElement;
    dialog.showModal();
    document.body.classList.add("workspace-tour-running");
    return () => {
      dialog.close();
      document.body.classList.remove("workspace-tour-running");
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
        previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    onNavigate(step.page);
    setMissing(false);
    titleRef.current?.focus({ preventScroll: true });
    let frame = 0;
    let scrolled: Element | null = null;
    let reportedMissing = false;
    const started = performance.now();
    spotRef.current!.hidden = true;
    const update = () => {
      const card = cardRef.current!,
        spot = spotRef.current!,
        shade = shadeRef.current!;
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0,
        top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth,
        height = viewport?.height ?? window.innerHeight;
      const margin = 12,
        gap = 14;
      card.style.maxHeight = `${Math.max(100, height - margin * 2)}px`;
      card.style.width = `${Math.min(380, width - margin * 2)}px`;
      const selector =
        width < 768 && step.mobileTarget ? step.mobileTarget : step.target;
      const target = selector
        ? document.querySelector<HTMLElement>(selector)
        : null;
      const pageReady = document.querySelector(
        `[data-tour-page="${step.page}"]`
      );
      let rect = target?.getBoundingClientRect();
      if (
        pageReady &&
        target &&
        rect &&
        rect.width > 0 &&
        rect.height > 0 &&
        scrolled !== target
      ) {
        target.scrollIntoView({
          block: "center",
          inline: "nearest",
          behavior: "instant",
        });
        scrolled = target;
        rect = target.getBoundingClientRect();
      }
      const visible = Boolean(
        pageReady &&
          rect &&
          rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > top &&
          rect.top < top + height &&
          rect.right > left &&
          rect.left < left + width
      );
      const cardWidth = card.offsetWidth,
        cardHeight = card.offsetHeight;
      let x = left + (width - cardWidth) / 2,
        y = top + (height - cardHeight) / 2;
      spot.hidden = !visible;
      shade.hidden = visible;
      if (visible && rect) {
        const hole = {
          left: Math.max(left + 4, rect.left - 5),
          top: Math.max(top + 4, rect.top - 5),
          right: Math.min(left + width - 4, rect.right + 5),
          bottom: Math.min(top + height - 4, rect.bottom + 5),
        };
        Object.assign(spot.style, {
          left: `${hole.left}px`,
          top: `${hole.top}px`,
          width: `${hole.right - hole.left}px`,
          height: `${hole.bottom - hole.top}px`,
        });
        x = hole.left;
        if (hole.bottom + gap + cardHeight <= top + height - margin)
          y = hole.bottom + gap;
        else if (hole.top - gap - cardHeight >= top + margin)
          y = hole.top - gap - cardHeight;
        else if (hole.right + gap + cardWidth <= left + width - margin) {
          x = hole.right + gap;
          y = hole.top;
        } else if (hole.left - gap - cardWidth >= left + margin) {
          x = hole.left - gap - cardWidth;
          y = hole.top;
        } else
          y =
            top + height - hole.bottom >= hole.top - top
              ? top + height - margin - cardHeight
              : top + margin;
      } else if (
        selector &&
        !reportedMissing &&
        performance.now() - started > 2000
      ) {
        reportedMissing = true;
        setMissing(true);
      }
      if (visible && reportedMissing) {
        reportedMissing = false;
        setMissing(false);
      }
      card.style.left = `${Math.max(left + margin, Math.min(x, left + width - cardWidth - margin))}px`;
      card.style.top = `${Math.max(top + margin, Math.min(y, top + height - cardHeight - margin))}px`;
      card.style.visibility = "visible";
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [index, onNavigate, step]);

  return createPortal(
    <dialog
      ref={dialogRef}
      className="workspace-tour"
      aria-label={tr("首次使用指南", "First-use guide")}
      aria-labelledby="workspace-tour-title"
      aria-describedby="workspace-tour-body"
      data-step={index + 1}
      onCancel={event => {
        event.preventDefault();
        close(false);
      }}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === "Tab") {
          const buttons = Array.from(
            cardRef.current!.querySelectorAll<HTMLButtonElement>(
              "button:not(:disabled)"
            )
          );
          const current = buttons.indexOf(
            document.activeElement as HTMLButtonElement
          );
          if (event.shiftKey && current <= 0) {
            event.preventDefault();
            buttons.at(-1)?.focus();
          } else if (!event.shiftKey && current === buttons.length - 1) {
            event.preventDefault();
            buttons[0]?.focus();
          }
          return;
        }
        if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)
          return;
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          event.stopPropagation();
          setIndex(value => Math.max(0, value - 1));
        }
        if (event.key === "ArrowRight") {
          event.preventDefault();
          event.stopPropagation();
          if (index < steps.length - 1) setIndex(value => value + 1);
        }
      }}
    >
      <div ref={shadeRef} className="tour-shade" />
      <div ref={spotRef} className="tour-spotlight" hidden />
      <section
        ref={cardRef}
        className="tour-card"
        style={{ visibility: "hidden" }}
      >
        <div className="tour-card-top">
          <span>
            <Compass size={16} />
            {tr("首次使用指南", "First-use guide")}
          </span>
          <span aria-live="polite">
            {index + 1} / {steps.length}
          </span>
        </div>
        <progress
          value={index + 1}
          max={steps.length}
          aria-label={tr("導覽進度", "Tour progress")}
        />
        <h2 id="workspace-tour-title" ref={titleRef} tabIndex={-1}>
          {tr(...step.title)}
        </h2>
        <p id="workspace-tour-body">{tr(...step.body)}</p>
        {missing && (
          <p className="tour-fallback" role="status">
            {tr(
              "這個位置暫時未顯示，你仍可繼續閱讀導覽。",
              "This control is not currently visible. You can still continue the guide."
            )}
          </p>
        )}
        <div className="tour-actions">
          <button
            type="button"
            className="tour-skip"
            onClick={() => close(false)}
          >
            {tr("跳過教學", "Skip tour")}
          </button>
          <button
            type="button"
            className="btn-paper"
            disabled={index === 0}
            onClick={() => setIndex(value => value - 1)}
          >
            <ArrowLeft size={14} />
            {tr("上一步", "Back")}
          </button>
          <button
            type="button"
            className="btn-ink"
            onClick={() =>
              index === steps.length - 1
                ? close(true)
                : setIndex(value => value + 1)
            }
          >
            {index === steps.length - 1
              ? tr("完成", "Finish")
              : tr("下一步", "Next")}
            <ArrowRight size={14} />
          </button>
        </div>
        <small>
          {tr(
            "鍵盤：← 上一步 · → 下一步 · Esc 關閉",
            "Keyboard: ← Back · → Next · Esc Close"
          )}
        </small>
      </section>
    </dialog>,
    document.body
  );
}
