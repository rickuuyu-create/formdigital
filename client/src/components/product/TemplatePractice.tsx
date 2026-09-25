import { useState } from "react";
import { BookOpen, Check, Target } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { FormField } from "@/lib/form-model";
import { validateFieldValues } from "@shared/fieldValidation";
import { resolveEffectiveTableGrid } from "@shared/tableFormula";
import type { TemplateRecord } from "@/lib/product-types";
import {
  PRACTICE_PDF,
  checkPracticeLesson,
  hasPracticeInput,
  isPracticeTemplate,
  practiceLabels,
  practiceLessons,
  practiceValueLabels,
  type PracticeLesson,
} from "@/lib/template-practice";
import "./template-practice.css";

export function PracticeEntry({
  templates,
  onStart,
  onResume,
}: {
  templates: TemplateRecord[];
  onStart: () => void;
  onResume: (id: string) => void;
}) {
  const { tr } = useI18n();
  const practices = templates.filter(
    t => isPracticeTemplate(t.description) && t.lifecycle !== "archived"
  );
  return (
    <section
      className="practice-entry"
      aria-label={tr("範本建立實習", "Template building practice")}
    >
      <div>
        <h2>
          <BookOpen size={18} />
          {tr("親手建立一份完整範本", "Build a complete template yourself")}
        </h2>
        <p>
          {tr(
            "用八頁示範原表練習 12 種欄位、單選與多選圈選、表格及公式。每一步檢查實際設定，可分次完成。",
            "Use the eight-page example to learn all 12 field types, circle choices, tables and formulas. Each step checks your actual work; continue whenever you like."
          )}
        </p>
      </div>
      <div className="practice-actions">
        <button className="btn-ink" data-tour="practice-start" onClick={onStart}>
          {tr("開始新的範本實習", "Start a new practice")}
        </button>
        <a className="btn-paper" href={PRACTICE_PDF} download>
          {tr("下載示範原表", "Download example form")}
        </a>
      </div>
      {practices.length > 0 && (
        <label>
          {tr("繼續已有的練習", "Resume existing practice")}
          <select
            className="setting-select"
            value=""
            onChange={e => {
              if (e.target.value) onResume(e.target.value);
            }}
          >
            <option value="">
              {tr("選擇練習範本…", "Choose a practice template…")}
            </option>
            {practices.map(p => (
              <option
                key={p.id}
                value={
                  p.currentDraftVersionId || p.currentPublishedVersionId || ""
                }
              >
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
    </section>
  );
}

export function readPracticeStep(versionId: string) {
  try {
    const n = Number(
      localStorage.getItem(`formdigital.practice.step.${versionId}`)
    );
    return Number.isInteger(n) && n >= 0 && n <= practiceLessons.length ? n : 0;
  } catch {
    return 0;
  }
}

export function PracticeFillGuide({
  fields,
  values,
  page,
  onPage,
}: {
  fields: FormField[];
  values: Record<string, string>;
  page: number;
  onPage: (page: number) => void;
}) {
  const { tr } = useI18n();
  const [expanded, setExpanded] = useState(true);
  const lessons = practiceLessons.filter(l => l.page === page);
  return (
    <section className="practice-coach" data-testid="practice-fill-guide">
      <header>
        <h2>
          {tr(
            "實習第二部分：試填與檢查輸出",
            "Practice part two: fill and check the output"
          )}
        </h2>
        <button className="btn-paper" onClick={() => setExpanded(!expanded)}>
          {expanded
            ? tr("收起試填指引", "Collapse filling guide")
            : tr("展開試填指引", "Show filling guide")}
        </button>
      </header>
      {expanded && (
        <>
          <p>
            {tr(
              "逐頁使用以下樣例填寫。這裡只核對目前資料；字體、圈選位置、圖片及簽名仍需目視檢查。完成後儲存填寫紀錄，輸出 PDF 並確認八頁內容。",
              "Fill every page using these examples. Current values are checked here; visually inspect text, choice positions, images and signatures. Save the record, export a PDF and inspect all eight pages."
            )}
          </p>
          <label>
            {tr("試填頁面", "Practice page")}
            <select
              className="setting-select"
              value={page}
              onChange={e => onPage(Number(e.target.value))}
            >
              {Array.from({ length: 8 }, (_, i) => (
                <option key={i} value={i + 1}>
                  {tr("第", "Page")} {i + 1}
                </option>
              ))}
            </select>
          </label>
          <div className="practice-content">
            <div>
              <ul>
                {lessons.map(l => {
                  const f = fields.find(f =>
                    new RegExp(`^${l.id}(?:\\s|$)`).test(f.label)
                  );
                  const v = f ? (values[f.id] ?? "") : "";
                  const issues = f
                    ? validateFieldValues({ [f.id]: v }, [
                        {
                          stableFieldId: f.id,
                          fieldType: f.type,
                          definition: f,
                        },
                      ])
                    : [];
                  let ok = Boolean(f && hasPracticeInput(f.type, v)) && !issues.length;
                  if (l.id === "B01") ok = v === "F";
                  if (l.id === "B02")
                    ok =
                      JSON.stringify(v.split("\n").filter(Boolean).sort()) ===
                      JSON.stringify(["投影", "攝影"].sort());
                  return (
                    <li key={l.id}>
                      <b>
                        {ok ? "✓" : "○"} {l.id} · {tr(...l.title)}
                      </b>
                      <p>
                        {!f ? tr("尚未建立此欄位；請返回範本編輯器完成對應步驟。", "This field has not been created. Return to the template editor and complete this step.") : l.sample ||
                          tr(
                            "依紙面提示填寫；日期／時間可用動態預設，圖片／簽名請用示範素材。",
                            "Follow the form. Dates and times can use defaults; use the sample images for media fields."
                          )}
                      </p>
                      {issues.length > 0 && (
                        <p>
                          {tr(
                            "目前值有驗證問題，請查看欄位提示。",
                            "This value has validation issues. See the field message."
                          )}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
              {page === 8 && (
                <p>
                  {tr(
                    "本頁附件只供核對，沒有填寫欄位。輸出時應完整保留收據與 480.00 合計。",
                    "This attachment has no fields. Check that the receipt and 480.00 total remain in the exported document."
                  )}
                </p>
              )}
            </div>
            <div>
              {page === 2 && (
                <p>
                  {tr(
                    "單選：先 C、後 F，應只留 F 一圈。多選：先投影／桌椅／攝影，再取消桌椅，應留下兩圈。先看值，再檢查圈是否真正套在相應文字上。",
                    "Single choice: C then F; only F stays circled. Multiple choices: select projector, furniture and photography, then clear furniture. Check both the values and the drawn circles."
                  )}
                </p>
              )}
              {page === 4 && (
                <>
                  <h3>{tr("採購明細試填", "Purchase table samples")}</h3>
                  <p>
                    {tr(
                      "每列依序填項目、數量、單價、減免；公式欄不用輸入。",
                      "Enter item, quantity, unit price and deduction; leave formula cells for calculation."
                    )}
                  </p>
                  <pre>
                    {
                      "文具套裝 | 2 | 120 | 20\n展示材料 | 3 | 50 | 0\n資料印刷 | 1 | 80 | 5\n練習卡紙 | 4 | 25 | 0\n收納袋 | 2 | 35 | 10"
                    }
                  </pre>
                  <p>
                    {tr(
                      "D／F／G 合計應為 640.00／605.00／60.50。",
                      "D/F/G totals should be 640.00 / 605.00 / 60.50."
                    )}
                  </p>
                  {(() => {
                    const f = fields.find(f => f.label.startsWith("D01 "));
                    if (!f) return null;
                    const r = resolveEffectiveTableGrid(f, values[f.id] ?? "");
                    return (
                      <p role="status">
                        {!r.hasErrors &&
                        [3, 5, 6]
                          .map(c => r.effectiveRows[5]?.[c])
                          .join("/") === "640.00/605.00/60.50"
                          ? tr(
                              "✓ 三個合計與樣例一致。",
                              "✓ All three totals match."
                            )
                          : tr(
                              "○ 三個合計尚未與樣例一致。",
                              "○ Totals do not match yet."
                            )}
                      </p>
                    );
                  })()}
                </>
              )}
              {page === 5 && (
                <p>
                  {tr(
                    "填入十二列虛構工作人員資料。特別核對最後兩列，儲存後重新開啟並檢查仍然存在。",
                    "Fill twelve fictional attendance rows. Pay particular attention to the last two rows; save and reopen to check they remain."
                  )}
                </p>
              )}
              {page === 6 && (
                <p>
                  {tr(
                    "依紙面核對資料逐列填寫。先確認結果，再把除法列 B 改為 0 觀察錯誤，最後還原為 5；不要保留錯誤值輸出。",
                    "Use the samples printed on the page. After checking the results, try B=0 in the division row, observe the error, then restore B=5 before exporting."
                  )}
                </p>
              )}
              {page === 7 && (
                <>
                  <div className="practice-actions">
                    <a
                      className="btn-paper"
                      href="/practice/practice-image.png"
                      download
                    >
                      {tr("下載練習圖片", "Download sample image")}
                    </a>
                    <a
                      className="btn-paper"
                      href="/practice/practice-signature.png"
                      download
                    >
                      {tr("下載練習簽名圖片", "Download sample signature")}
                    </a>
                  </div>
                  <p>
                    {tr(
                      "同一張圖片分別放進三個圖片框。手寫簽名畫 DEMO，文字簽名用 Demo User；圖片簽名使用下載素材。",
                      "Use the same image in all three boxes. Draw DEMO, type Demo User, and use the downloaded signature for image signing."
                    )}
                  </p>
                </>
              )}
              <p>
                {tr(
                  "試填後可比較一般 PDF、可繼續填寫的 PDF 及套印 PDF。只有你看過輸出並確認後，最後一步才有輸出檢查紀錄。",
                  "Compare a normal, editable and answers-only PDF. An output review is recorded only after you inspect and confirm the exported file."
                )}
              </p>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

export function PracticeCoach({
  versionId,
  fields,
  index,
  onStep,
  onFrame,
  onLocate,
  onUseSelected,
  hasSelection,
  isDraft,
  saveState,
  pages,
  outputReviewed,
  busy,
}: {
  versionId: string;
  fields: FormField[];
  index: number;
  onStep: (n: number) => void;
  onFrame: (lesson: PracticeLesson) => void;
  onLocate: (lesson: PracticeLesson) => void;
  onUseSelected: (lesson: PracticeLesson) => void;
  hasSelection: boolean;
  isDraft: boolean;
  saveState: string;
  pages: number;
  outputReviewed: boolean;
  busy: boolean;
}) {
  const { tr } = useI18n();
  const [collapsed, setCollapsed] = useState(false);
  const [storageFailed, setStorageFailed] = useState(false);
  const results = practiceLessons.map(l => checkPracticeLesson(l, fields));
  const count = results.filter(r => r.complete).length;
  const lesson = practiceLessons[index],
    result = results[index];
  const move = (n: number) => {
    try {
      localStorage.setItem(`formdigital.practice.step.${versionId}`, String(n));
    } catch {
      setStorageFailed(true);
    }
    onStep(n);
  };
  const val = (v: unknown): string =>
    Array.isArray(v)
      ? v.join(" / ")
      : practiceValueLabels[String(v)]
        ? tr(...practiceValueLabels[String(v)])
        : String(v);
  return (
    <section
      className="practice-coach"
      data-testid="practice-coach"
      aria-label={tr("範本建立實習", "Template building practice")}
    >
      <header>
        <h2>
          <BookOpen size={17} />
          {tr("範本建立實習", "Template building practice")}
        </h2>
        <span role="status">
          {count} / 41 {tr("欄位檢查通過", "field checks passed")}
          {saveState !== "saved"
            ? " · " + tr("等待儲存", "Waiting to save")
            : ""}
        </span>
        <button className="btn-paper" onClick={() => setCollapsed(!collapsed)}>
          {collapsed
            ? tr("展開教學", "Show instructions")
            : tr("收起教學", "Collapse instructions")}
        </button>
      </header>
      {!collapsed && (
        <>
          <div className="practice-navigation">
            <label>
              {tr("練習步驟", "Practice step")}
              <select
                className="setting-select"
                value={index}
                disabled={busy}
                onChange={e => move(Number(e.target.value))}
              >
                {practiceLessons.map((l, i) => (
                  <option key={l.id} value={i}>
                    {results[i].complete ? "✓ " : "○ "}
                    {l.id} · {tr(...l.title)} · {tr("頁", "Page")} {l.page}
                  </option>
                ))}
                <option value={41}>
                  {tr(
                    "最後：附件、發佈與輸出",
                    "Finish: attachment, publish and output"
                  )}
                </option>
              </select>
            </label>
            <button
              className="btn-paper"
              disabled={index === 0 || busy}
              onClick={() => move(index - 1)}
            >
              {tr("上一步", "Previous")}
            </button>
            <button
              className="btn-paper"
              disabled={index === 41 || busy}
              onClick={() => move(index + 1)}
            >
              {tr("下一步", "Next")}
            </button>
          </div>
          <p className="practice-note">
            {tr(
              "可先看任何步驟；只有實際設定及對位正確才計入進度。金色虛線是參考位置，不會印在 PDF。",
              "Visit steps in any order. Only correct settings and alignment count. Gold outlines are guides and do not print in the PDF."
            )}
          </p>
          {storageFailed && (
            <p role="status">
              {tr(
                "此瀏覽器無法記住目前步驟；已儲存的欄位仍可重新檢查。",
                "This browser cannot remember your step. Saved fields can still be checked again."
              )}
            </p>
          )}
          {lesson ? (
            <div className="practice-content">
              <div>
                <h3>
                  {lesson.id} · {tr(...lesson.title)}
                </h3>
                <ol>
                  <li>
                    {tr(
                      "按「前往練習位置」，在金色虛線內拖拉新增欄位；亦可用「建立本步空框」。",
                      "Go to the practice location and draw a field inside the gold outline, or choose Create empty frame."
                    )}
                  </li>
                  <li>
                    {tr(
                      "在右側「欄位設定」依照核對清單設定類型及規則。名稱須以",
                      "Use Field settings on the right to set the type and rules. Start the name with"
                    )}{" "}
                    <b>{lesson.id}</b>。
                  </li>
                  <li>
                    {tr(
                      "檢查文字框與原表位置，最後按右側「確認此欄位」。設定變更會即時重新檢查。",
                      "Check alignment, then choose Confirm field on the right. Changes are checked immediately."
                    )}
                  </li>
                </ol>
                <div className="practice-actions">
                  <button
                    className="btn-paper"
                    disabled={busy}
                    onClick={() => onLocate(lesson)}
                  >
                    <Target size={13} />
                    {tr("前往練習位置", "Go to practice location")}
                  </button>
                  {isDraft && (
                    <>
                      <button
                        className="btn-ink"
                        disabled={!!result.field || busy}
                        onClick={() => onFrame(lesson)}
                      >
                        {tr("建立本步空框", "Create empty frame")}
                      </button>
                      <button
                        className="btn-paper"
                        disabled={!hasSelection || !!result.field || busy}
                        onClick={() => onUseSelected(lesson)}
                      >
                        {tr(
                          "用已選欄位練習此步",
                          "Use selected field for this step"
                        )}
                      </button>
                    </>
                  )}
                </div>
                {lesson.segments && (
                  <p>
                    {tr(
                      "分段日期可按「建立本步空框」帶入八個分段位置（2／2／4）。這只建立幾何底稿；你仍需設定數字限制、字數及人工確認。",
                      "For the segmented date, Create empty frame supplies the eight positions (2/2/4). You still set numeric input, character limit and confirmation."
                    )}
                  </p>
                )}
                {lesson.marks && (
                  <p>
                    {tr(
                      "選項在右側逐行輸入，選好記號樣式。每個綠色框都需對準一個金色小框；多行群組不能只靠平均分格。",
                      "Enter one option per line and choose the mark style. Align each green handle with its gold target. Multi-row choices need individual positioning."
                    )}
                  </p>
                )}
                {lesson.cells && (
                  <p>
                    {tr(
                      "將表頭留在欄位外，設定列／欄數。按「調整格線」調整欄寬，再用「逐格微調」；淺灰格設固定，計算格設公式。",
                      "Exclude the header, set rows and columns, then adjust grid lines and individual cells. Grey cells are fixed; calculated cells use formulas."
                    )}
                    <br />
                    {tr("欄寬 mm", "Column widths mm")}：
                    {lesson.widths?.join(" / ")}
                    <br />
                    {tr("列高 mm", "Row heights mm")}：
                    {lesson.heights?.join(" / ")}
                  </p>
                )}
                {lesson.id === "E01" && (
                  <p>
                    {tr(
                      "這個 72 格表格分兩組控制點，每組 6 列、36 格。切換至下一組（第 7–12 列），確認第 72 格仍能定位。",
                      "This 72-cell table has two handle groups of 6 rows and 36 cells each. Switch to the next group (rows 7–12) and check that cell 72 is reachable."
                    )}
                  </p>
                )}
                {lesson.sample && (
                  <p className="practice-sample">
                    {tr("完成範本後的試填值", "Try this after publishing")}：
                    {lesson.sample}
                  </p>
                )}
                {lesson.type === "image" && (
                  <p>
                    {tr(
                      "發佈後用同一張橫向 PNG/JPG 試填，比較三種適配；超過 2 MB 應提示。",
                      "After publishing, use the same landscape PNG/JPG to compare fits; check the 2 MB limit."
                    )}
                  </p>
                )}
                {lesson.type === "signature" && (
                  <p>
                    {tr(
                      "發佈後只使用練習簽名，試填本步指定的簽名方式。",
                      "After publishing, use a fictional signature to try the selected mode."
                    )}
                  </p>
                )}
                {lesson.id === "C11" && (
                  <p>
                    {tr(
                      "這一步先建立文字欄位。發佈後把「活動室 A」加入常用值，再在另一份填寫紀錄套用。",
                      "Create the text field here. After publishing, save a venue value and reuse it in another record."
                    )}
                  </p>
                )}
              </div>
              <div>
                <h3>{tr("即時核對清單", "Live checks")}</h3>
                <ul className="practice-checks">
                  {result.checks.map(check => (
                    <li
                      key={check.key}
                      data-check={check.key}
                      data-passed={check.ok}
                    >
                      <span aria-hidden="true">{check.ok ? "✓" : "○"}</span>
                      <span>
                        {tr(
                          ...(practiceLabels[check.key] ?? [
                            check.key,
                            check.key,
                          ])
                        )}
                        {check.key === "type"
                          ? `：${val(lesson.type)}`
                          : check.key !== "tableFormulaSchemaVersion" && Object.hasOwn(lesson.settings, check.key)
                            ? `：${val(lesson.settings[check.key as keyof FormField])}`
                            : ""}
                      </span>
                    </li>
                  ))}
                </ul>
                {!result.field && (
                  <div className="practice-required">
                    {tr("要設定的類型", "Required type")}：{val(lesson.type)}
                    <ul>
                      {Object.entries(lesson.settings)
                        .filter(
                          ([k]) =>
                            ![
                              "tableWritableCells",
                              "tableFormulaCells",
                            ].includes(k)
                        )
                        .map(([k, v]) => (
                          <li key={k}>
                            {tr(...(practiceLabels[k] ?? [k, k]))}{k === "tableFormulaSchemaVersion" ? "" : `：${val(v)}`}
                          </li>
                        ))}
                    </ul>
                  </div>
                )}
                <details>
                  <summary>
                    {tr("查看位置與詳細設定", "Position and detailed settings")}
                  </summary>
                  <p>
                    {tr(
                      "左／上／寬／高（mm）",
                      "Left / top / width / height (mm)"
                    )}
                    ：
                    {Object.values(lesson.box)
                      .map(v => Math.round(v * 10) / 10)
                      .join(" / ")}
                  </p>
                  {lesson.settings.tableFormulaCells?.length ? (
                    <>
                      <p>
                        {tr(
                          "公式均保留 2 位小數；以第一列可填格為第 1 列。",
                          "Use 2 decimal places; the first row below the header is row 1."
                        )}
                      </p>
                      <ul>
                        {lesson.settings.tableFormulaCells.map(f => (
                          <li key={`${f.row}:${f.column}`}>
                            {String.fromCharCode(65 + f.column)}
                            {f.row + 1} = <code>{f.expression}</code>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                  {lesson.id === "D01" && (
                    <p>
                      {tr(
                        "最後一列只有 D、F、G 是公式；A、B、C、E 設為固定。用「跨列總額嚮導」建立三個 SUM。",
                        "Only D, F and G in the last row are formulas. Set A, B, C and E fixed. Use Column total for the three SUMs."
                      )}
                    </p>
                  )}
                  {lesson.id === "F01" && (
                    <p>
                      {tr(
                        "A／B 可填、C 公式、D 固定。按照紙面上的核對資料試算。",
                        "A/B are writable, C formula, D fixed. Test with the values printed on the form."
                      )}
                    </p>
                  )}
                  <p>
                    {tr(
                      "外觀與排列延伸練習：調整字型／大小／字距／顏色，複製後對齊或分佈，再復原。這些操作不會只因看過說明便被標記完成。",
                      "Further practice: change font, size, spacing and color; duplicate, align and distribute, then undo. Reading this does not mark these actions completed."
                    )}
                  </p>
                </details>
                <p role="status" className="practice-result">
                  {result.complete ? (
                    <>
                      <Check size={14} />
                      {tr(
                        "本步欄位設定檢查通過",
                        "This field passes the settings checks"
                      )}
                    </>
                  ) : (
                    tr(
                      "尚有項目需要完成；可繼續操作右側設定。",
                      "Some checks remain. Continue editing the field settings."
                    )
                  )}
                </p>
              </div>
            </div>
          ) : (
            <div className="practice-finish">
              <h3>
                {tr("把練習變成可用範本", "Finish your practice template")}
              </h3>
              <ol>
                <li>
                  {count}/41{" "}
                  {tr(
                    "欄位檢查通過。回到未完成的步驟修正。",
                    "fields pass. Return to unfinished steps to fix them."
                  )}
                </li>
                <li>
                  {pages === 8 && fields.every(f => f.page !== 8) ? "✓" : "○"}{" "}
                  {tr(
                    "保留全部八頁；第八頁附件不建立欄位。",
                    "Keep all eight pages. Page 8 is an attachment with no fields."
                  )}
                </li>
                <li>
                  {saveState === "saved" ? "✓" : "○"}{" "}
                  {tr(
                    "儲存草稿，重新開啟後核對欄位。",
                    "Save, reopen and check the fields."
                  )}
                </li>
                <li>
                  {!isDraft ? "✓" : "○"}{" "}
                  {tr(
                    "逐頁人工檢查後按「發佈」，再建立填寫紀錄。",
                    "Review every page, publish, then create a filled record."
                  )}
                </li>
                <li>
                  {outputReviewed ? "✓" : "○"}{" "}
                  {tr(
                    "按原表的試填值測試：單選改選、多選取消、表格公式、圖片及簽名。輸出 PDF，檢查八頁，再按「我已檢查這份輸出」。",
                    "Try the sample values, changing single choices, clearing multiple choices, formulas, images and signatures. Export and inspect all eight PDF pages, then confirm the output review."
                  )}
                </li>
              </ol>
              <p>
                {count === 41 &&
                pages === 8 &&
                fields.every(f => f.page !== 8) &&
                !isDraft &&
                saveState === "saved" &&
                outputReviewed
                  ? tr(
                      "欄位、發佈及輸出檢查紀錄齊備。",
                      "Field checks, publication and output review are recorded."
                    )
                  : tr(
                      "完成欄位設定不等於已驗收輸出；請完成上述流程。",
                      "Correct field settings do not mean the output has been verified. Complete the steps above."
                    )}
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
