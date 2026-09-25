export const CSV_PREVIEW_PAGE_SIZE = 100;

export function sliceCsvPreviewRows<T>(rows: readonly T[], page: number) {
  const safePage = Math.max(0, Math.trunc(page));
  const start = safePage * CSV_PREVIEW_PAGE_SIZE;
  return rows.slice(start, start + CSV_PREVIEW_PAGE_SIZE);
}
