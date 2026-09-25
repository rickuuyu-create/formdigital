import React, { useEffect, useMemo, useState, useRef } from "react";
import { trpc } from "@/lib/trpc";
import type { ImportPipelineDraftField, ImportReviewContext } from "../../lib/import-pipeline";
import {
  computeFinalFields,
  excludeAllCandidatesOnPage,
  initReviewSession,
  restoreAllCandidatesOnPage,
  toggleCandidateExcluded,
  togglePageAttachment,
  type ReviewCandidate,
  type ReviewSessionState,
} from "../../lib/import-review";
import { getImportReviewMessages } from "../../lib/import-review-messages";

export type ImportReviewPanelProps = {
  context: ImportReviewContext;
  onConfirm: (fields: ImportPipelineDraftField[]) => void;
  onCancel: () => void;
  locale?: string;
};

export function ImportReviewPanel({
  context,
  onConfirm,
  onCancel,
  locale = typeof document !== "undefined" ? document.documentElement.lang : "zh-Hant",
}: ImportReviewPanelProps) {
  const messages = useMemo(() => getImportReviewMessages(locale), [locale]);
  const [session, setSession] = useState<ReviewSessionState>(() =>
    initReviewSession(context)
  );
  const [activePageIndex, setActivePageIndex] = useState(0);
  const [activeFilter, setActiveFilter] = useState<
    "all" | "table" | "text" | "needsCheck"
  >("all");
  const [hoveredCandidateId, setHoveredCandidateId] = useState<string | null>(
    null
  );
  const activePage = session.pages[activePageIndex] || session.pages[0];

  const assetQuery = trpc.formdigital.assets.getUrl.useQuery(
    { assetId: activePage?.assetId ?? "" },
    { enabled: Boolean(activePage?.assetId), staleTime: Infinity, gcTime: 0, trpc: { abortOnUnmount: true } }
  );

  const previewUrl = assetQuery.data?.url ?? null;

  const filteredCandidates = useMemo(() => {
    if (!activePage) return [];
    return activePage.candidates.filter(c => {
      if (activeFilter === "table") return c.isTable;
      if (activeFilter === "text") return !c.isTable;
      if (activeFilter === "needsCheck") return c.isUltraWide;
      return true;
    });
  }, [activePage, activeFilter]);

  const finalFields = useMemo(
    () => computeFinalFields(session),
    [session]
  );

  const totalOriginalSuggestions = context.suggestedFields.length;
  const isDocx = session.isDocx;
  const hasZeroTables = activePage?.tablesCount === 0;

  const handlePageChange = (newIndex: number) => {
    if (newIndex >= 0 && newIndex < session.pages.length) {
      setActivePageIndex(newIndex);
    }
  };

  const handleToggleAttachment = (isAttachment: boolean) => {
    setSession(prev => togglePageAttachment(prev, activePageIndex, isAttachment));
  };

  const handleToggleCandidate = (candidateId: string, currentExcluded: boolean) => {
    setSession(prev =>
      toggleCandidateExcluded(prev, activePageIndex, candidateId, !currentExcluded)
    );
  };

  const handleExcludeAll = () => {
    setSession(prev => excludeAllCandidatesOnPage(prev, activePageIndex));
  };

  const handleRestoreAll = () => {
    setSession(prev => restoreAllCandidatesOnPage(prev, activePageIndex));
  };

  const pageIndicatorRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    // Focus the page indicator on active page change for screen readers and keyboard navigation
    if (pageIndicatorRef.current) {
      pageIndicatorRef.current.focus();
    }
  }, [activePageIndex]);

  return (
    <div
      className="flex flex-col h-[85vh] max-h-[85vh] w-full text-[#17364d]"
      data-testid="import-review-panel"
      role="region"
      aria-label={messages.reviewTitle}
    >
      {/* Header */}
      <header className="border-b border-[#e2ded6] p-4 bg-[#fbf9f5] flex-shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs font-semibold tracking-wider text-[#627d98] uppercase">
              FORMDIGITAL
            </div>
            <h2 className="text-xl font-bold text-[#102a43] mt-0.5">
              {messages.reviewTitle}
            </h2>
            <p className="text-sm text-[#486581] mt-0.5">
              {messages.reviewSubtitle}
            </p>
          </div>
          <div className="text-right">
            <span
              className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-[#f0f4f8] text-[#334e68] border border-[#d9e2ec]"
              data-testid="unconfirmed-warning-badge"
            >
              {messages.unconfirmedWarning}
            </span>
          </div>
        </div>

        {/* Notices */}
        <div className="mt-3 space-y-2">
          {isDocx && (
            <div
              className="p-2.5 rounded bg-[#fff8e6] border border-[#f0b429] text-xs text-[#744210] flex items-start gap-2"
              data-testid="docx-notice"
              role="status"
            >
              <span className="font-bold shrink-0">DOCX:</span>
              <span>{messages.docxNotice}</span>
            </div>
          )}

          {context.runDetection === false && (
            <div className="p-2.5 rounded bg-[#f0f4f8] border border-[#bcccdc] text-xs text-[#334e68] flex items-start gap-2" data-testid="detection-disabled-notice" role="status">
              <span className="font-bold shrink-0">ℹ️</span>
              <span>{messages.detectionDisabledNotice}</span>
            </div>
          )}

          {context.ocrAvailable === false && context.runDetection !== false && (
            <div className="p-2.5 rounded bg-[#fff3c4] border border-[#f59f00] text-xs text-[#744210] flex items-start gap-2" data-testid="ocr-unavailable-notice" role="status">
              <span className="font-bold shrink-0">⚠️</span>
              <span>{messages.ocrUnavailableNotice}</span>
            </div>
          )}

          {hasZeroTables && context.runDetection !== false && context.ocrAvailable !== false && (
            <div
              className="p-2.5 rounded bg-[#f0f4f8] border border-[#bcccdc] text-xs text-[#334e68] flex items-start gap-2"
              data-testid="zero-tables-notice"
              role="status"
            >
              <span className="font-bold shrink-0">ℹ️</span>
              <span>{messages.noTableNotice}</span>
            </div>
          )}

          {session.truncation !== "none" && (
            <div
              className="p-2.5 rounded bg-[#fff3c4] border border-[#f59f00] text-xs text-[#744210] flex items-start gap-2"
              data-testid="truncation-notice"
              role="status"
            >
              <span className="font-bold shrink-0">⚠️</span>
              <span>{session.truncation === "document" ? messages.documentTruncatedNotice : messages.truncatedNotice}</span>
            </div>
          )}
        </div>

        {/* Page navigation & Attachment toggle */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 bg-white p-2.5 rounded border border-[#e2ded6]">
          {/* Page Paging */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="px-2 py-1 rounded border border-[#d9d4ca] bg-white text-sm font-medium hover:bg-[#f0f4f8] disabled:opacity-40 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-[#1971c2]"
              onClick={() => handlePageChange(activePageIndex - 1)}
              disabled={activePageIndex === 0}
              aria-label={messages.previousPage}
              data-testid="prev-page-btn"
            >
              &larr;
            </button>
            <span
              className="text-sm font-semibold text-[#102a43] min-w-[100px] text-center focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-[#1971c2]"
              data-testid="page-indicator"
              ref={pageIndicatorRef}
              tabIndex={-1}
              aria-live="polite"
            >
              {messages.pageIndicator(activePageIndex + 1, session.pages.length)}
            </span>
            <button
              type="button"
              className="px-2 py-1 rounded border border-[#d9d4ca] bg-white text-sm font-medium hover:bg-[#f0f4f8] disabled:opacity-40 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-[#1971c2]"
              onClick={() => handlePageChange(activePageIndex + 1)}
              disabled={activePageIndex === session.pages.length - 1}
              aria-label={messages.nextPage}
              data-testid="next-page-btn"
            >
              &rarr;
            </button>
          </div>

          {/* Attachment Toggle (Reversible Client-side Filter) */}
          <div
            className="flex items-center gap-4 bg-[#f8f9fa] px-3 py-1.5 rounded-lg border border-[#e2ded6]"
            role="radiogroup"
            aria-label={messages.pageType}
            data-testid="attachment-toggle-group"
          >
            <label className="flex items-center gap-1.5 text-xs font-medium cursor-pointer">
              <input
                type="radio"
                name={`page-type-${activePageIndex}`}
                checked={!activePage?.isAttachment}
                onChange={() => handleToggleAttachment(false)}
                className="text-[#1971c2] focus:ring-[#1971c2]"
                data-testid="page-type-general"
              />
              <span>{messages.generalPage}</span>
            </label>

            <label className="flex items-center gap-1.5 text-xs font-medium cursor-pointer text-[#d9480f]">
              <input
                type="radio"
                name={`page-type-${activePageIndex}`}
                checked={Boolean(activePage?.isAttachment)}
                onChange={() => handleToggleAttachment(true)}
                className="text-[#d9480f] focus:ring-[#d9480f]"
                data-testid="page-type-attachment"
              />
              <span>{messages.attachmentPage}</span>
            </label>
          </div>
        </div>
      </header>

      {/* Main Review Body */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Left: Preview with overlay */}
        <div className="w-1/2 p-4 border-r border-[#e2ded6] bg-[#f0f4f8] flex flex-col items-center justify-center relative overflow-hidden">
          {activePage?.isAttachment && (
            <div
              className="absolute top-2 inset-x-2 z-10 p-2 rounded bg-[#fff4e6] border border-[#ffa94d] text-xs text-[#d9480f] font-medium text-center shadow-sm"
              data-testid="attachment-active-notice"
            >
              {messages.attachmentNotice}
            </div>
          )}

          <div
            className="relative max-w-full max-h-full border border-[#cbd5e1] bg-white shadow-md rounded overflow-hidden"
            data-testid="page-preview-container"
          >
            {previewUrl ? (
              <div className="relative inline-block">
                <img
                  src={previewUrl}
                  alt={messages.pageIndicator(activePageIndex + 1, session.pages.length)}
                  className="max-h-[52vh] w-auto object-contain select-none"
                  data-testid="preview-image"
                />

                {/* Candidate Highlight Overlays (only if not attachment) */}
                {!activePage?.isAttachment &&
                  activePage?.candidates.map(candidate => {
                    const isExcluded = activePage.excludedCandidateIds.has(
                      candidate.stableFieldId
                    );
                    const isHovered =
                      hoveredCandidateId === candidate.stableFieldId;
                    const { leftRatio, topRatio } = candidate;
                    const widthRatio = candidate.widthRatio;
                    const heightRatio = candidate.heightRatio;

                    return (
                      <div
                        key={candidate.stableFieldId}
                        style={{
                          left: `${leftRatio * 100}%`,
                          top: `${topRatio * 100}%`,
                          width: `${widthRatio * 100}%`,
                          height: `${heightRatio * 100}%`,
                        }}
                        className={`absolute pointer-events-none transition-all duration-150 border-2 rounded-sm ${
                          isExcluded
                            ? "border-red-400 bg-red-500/10 opacity-40 line-through"
                            : candidate.isUltraWide
                              ? "border-amber-500 bg-amber-500/15"
                              : candidate.isTable
                                ? "border-emerald-600 bg-emerald-500/15"
                                : "border-blue-500 bg-blue-500/15"
                        } ${isHovered ? "ring-4 ring-yellow-400 z-20 opacity-100" : "z-10"}`}
                        data-testid={`candidate-box-${candidate.stableFieldId}`}
                      />
                    );
                  })}
              </div>
            ) : (
              <div className="p-12 text-sm text-[#829ab1] text-center" role="status" aria-live="polite">
                {assetQuery.isError ? messages.previewFailed : messages.loadingPreview}
              </div>
            )}
          </div>
        </div>

        {/* Right: Candidate List & Controls */}
        <div className="w-1/2 flex flex-col bg-white overflow-hidden">
          {/* Filter Bar */}
          <div className="p-3 border-b border-[#e2ded6] flex items-center justify-between gap-2 flex-shrink-0 bg-[#fbf9f5]">
            <div className="flex items-center gap-1">
              <button
                type="button"
                className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-colors ${
                  activeFilter === "all"
                    ? "bg-[#102a43] text-white"
                    : "bg-[#e2ded6]/50 text-[#486581] hover:bg-[#e2ded6]"
                }`}
                onClick={() => setActiveFilter("all")}
                data-testid="filter-all-btn"
              >
                {messages.filterAll} ({activePage?.candidates.length ?? 0})
              </button>

              <button
                type="button"
                className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-colors ${
                  activeFilter === "table"
                    ? "bg-[#102a43] text-white"
                    : "bg-[#e2ded6]/50 text-[#486581] hover:bg-[#e2ded6]"
                }`}
                onClick={() => setActiveFilter("table")}
                data-testid="filter-table-btn"
              >
                {messages.filterTable} ({activePage?.tablesCount ?? 0})
              </button>

              <button
                type="button"
                className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-colors ${
                  activeFilter === "text"
                    ? "bg-[#102a43] text-white"
                    : "bg-[#e2ded6]/50 text-[#486581] hover:bg-[#e2ded6]"
                }`}
                onClick={() => setActiveFilter("text")}
                data-testid="filter-text-btn"
              >
                {messages.filterText} ({activePage?.textCount ?? 0})
              </button>

              <button
                type="button"
                className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-colors ${
                  activeFilter === "needsCheck"
                    ? "bg-[#f08c00] text-white"
                    : "bg-[#fff3bf] text-[#d9480f] hover:bg-[#ffe066]"
                }`}
                onClick={() => setActiveFilter("needsCheck")}
                data-testid="filter-needs-check-btn"
              >
                ⚠️ {messages.filterNeedsCheck} ({activePage?.needsCheckCount ?? 0})
              </button>
            </div>

            {/* Page-level bulk actions */}
            {!activePage?.isAttachment && (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="text-xs text-[#829ab1] hover:text-[#e03131] px-1.5 py-0.5 rounded hover:bg-[#ffe3e3]"
                  onClick={handleExcludeAll}
                  data-testid="exclude-all-page-btn"
                >
                  {messages.excludeAll}
                </button>
                <span className="text-[#cbd5e1]">|</span>
                <button
                  type="button"
                  className="text-xs text-[#829ab1] hover:text-[#1971c2] px-1.5 py-0.5 rounded hover:bg-[#e7f5ff]"
                  onClick={handleRestoreAll}
                  data-testid="restore-all-page-btn"
                >
                  {messages.restoreAll}
                </button>
              </div>
            )}
          </div>

          {/* Ultra-wide hint banner when in needsCheck filter */}
          {activeFilter === "needsCheck" && (
            <div
              className="p-2.5 bg-[#fff9db] border-b border-[#ffe066] text-xs text-[#854d0e] flex-shrink-0"
              data-testid="ultra-wide-tip"
            >
              {messages.ultraWideTip}
            </div>
          )}

          {/* List of candidates */}
          <div
            className="flex-1 overflow-y-auto p-3 space-y-2"
            data-testid="candidate-list"
          >
            {activePage?.isAttachment ? (
              <div className="h-full flex flex-col items-center justify-center text-center p-6 text-[#829ab1]">
                <span className="text-3xl mb-2">📎</span>
                <p className="text-sm font-medium text-[#486581]">
                  {messages.attachmentNotice}
                </p>
                <p className="text-xs text-[#829ab1] mt-1">
                  {messages.restorePageHint}
                </p>
              </div>
            ) : filteredCandidates.length === 0 ? (
              <div className="h-full flex items-center justify-center text-sm text-[#829ab1]">
                {messages.emptyCandidates}
              </div>
            ) : (
              filteredCandidates.map(candidate => {
                const isExcluded = activePage.excludedCandidateIds.has(
                  candidate.stableFieldId
                );

                return (
                  <div
                    key={candidate.stableFieldId}
                    className={`p-2.5 rounded-md border text-xs flex items-center justify-between gap-3 transition-colors ${
                      isExcluded
                        ? "bg-[#f8f9fa] border-[#e2ded6] opacity-60"
                        : candidate.isUltraWide
                          ? "bg-[#fffbeb] border-[#fde68a]"
                          : "bg-white border-[#e2ded6] hover:border-[#bcccdc]"
                    }`}
                    onMouseEnter={() =>
                      setHoveredCandidateId(candidate.stableFieldId)
                    }
                    onMouseLeave={() => setHoveredCandidateId(null)}
                    data-testid={`candidate-item-${candidate.stableFieldId}`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className={`font-semibold truncate max-w-[180px] ${
                            isExcluded ? "line-through text-[#829ab1]" : "text-[#102a43]"
                          }`}
                        >
                          {candidate.label || messages.unnamedField}
                        </span>
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                            candidate.isTable
                              ? "bg-[#d3f9d8] text-[#2b8a3e]"
                              : "bg-[#e7f5ff] text-[#1971c2]"
                          }`}
                        >
                          {candidate.fieldType}
                        </span>
                        {candidate.isUltraWide && (
                          <span
                            className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-[#ffe066] text-[#d9480f]"
                            title={messages.ultraWideWarning}
                            data-testid="ultra-wide-badge"
                          >
                            {messages.wideBadge}
                          </span>
                        )}
                      </div>

                      <div className="text-[11px] text-[#829ab1] mt-1 flex items-center gap-3">
                        <span>{messages.widthLabel}: {Math.round(candidate.widthRatio * 100)}%</span>
                        <span>{messages.sourceLabel}: {candidate.detectionSource}</span>
                        {isExcluded && (
                          <span className="font-medium text-[#e03131]">
                            [{messages.statusExcluded}]
                          </span>
                        )}
                      </div>
                    </div>

                    <button
                      type="button"
                      className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                        isExcluded
                          ? "bg-[#e7f5ff] text-[#1971c2] hover:bg-[#d0ebff]"
                          : "bg-[#ffe3e3] text-[#e03131] hover:bg-[#ffc9c9]"
                      }`}
                      onClick={() =>
                        handleToggleCandidate(
                          candidate.stableFieldId,
                          isExcluded
                        )
                      }
                      data-testid={`candidate-action-${candidate.stableFieldId}`}
                    >
                      {isExcluded ? messages.restore : messages.exclude}
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-[#e2ded6] p-4 bg-[#fbf9f5] flex items-center justify-between flex-shrink-0">
        <div className="text-xs text-[#627d98]">
          <span className="font-semibold text-[#102a43]">
            {messages.candidatesCount(finalFields.length)}
          </span>
          <span className="ml-2">
            {messages.originalCount(totalOriginalSuggestions, totalOriginalSuggestions - finalFields.length)}
          </span>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            className="px-3.5 py-1.5 rounded border border-[#d9d4ca] bg-white text-sm font-medium text-[#486581] hover:bg-[#f0f4f8] hover:text-[#102a43]"
            onClick={onCancel}
            data-testid="cancel-import-btn"
          >
            {messages.cancelImport}
          </button>

          <button
            type="button"
            className="px-3.5 py-1.5 rounded border border-[#bcccdc] bg-white text-sm font-medium text-[#334e68] hover:bg-[#f0f4f8]"
            onClick={() => onConfirm([])}
            data-testid="import-pages-only-btn"
          >
            {messages.importPagesOnly}
          </button>

          <button
            type="button"
            className="px-4 py-1.5 rounded bg-[#1971c2] text-white text-sm font-medium hover:bg-[#1864ab] shadow-sm"
            onClick={() => onConfirm(finalFields)}
            data-testid="confirm-import-btn"
          >
            {messages.confirmImport}
          </button>
        </div>
      </footer>
    </div>
  );
}
