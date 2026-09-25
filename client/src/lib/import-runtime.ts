export const MAX_IMPORT_RASTER_PIXELS = 16_000_000;
export const DEFAULT_PAGE_TIMEOUT_MS = 30_000;
export const MAX_IMPORT_BATCH_SIZE = 8;
/**
 * Raw asset uploads carry their provenance in a bounded query string, so a
 * single import keeps its original-source list small enough to stay inside the
 * request-line budget. Larger batches are refused with a fixed message instead
 * of silently dropping provenance.
 */
export const MAX_IMPORT_SOURCE_FILES = 40;

export class ImportCancelledError extends Error {
  constructor() {
    super("IMPORT_CANCELLED");
    this.name = "ImportCancelledError";
  }
}

export class ImportPageTimeoutError extends Error {
  constructor() {
    super("頁面處理逾時，已略過本頁的自動識別。");
    this.name = "ImportPageTimeoutError";
  }
}

/**
 * The Local Data Service stored an asset under a different type than the one
 * the import asked for. In practice this means a long-running service process
 * predates the client, so it silently drops the requested type and a saved
 * page can never be displayed. Failing loudly beats a blank Template.
 */
export class ImportAssetTypeMismatchError extends Error {
  constructor() {
    super("IMPORT_ASSET_TYPE_MISMATCH");
    this.name = "ImportAssetTypeMismatchError";
  }
}

export function isImportAssetTypeMismatchError(error: unknown) {
  return error instanceof ImportAssetTypeMismatchError;
}

export function isImportCancelledError(error: unknown) {
  return (
    error instanceof ImportCancelledError ||
    (error instanceof DOMException && error.name === "AbortError")
  );
}

export function isImportPageTimeoutError(error: unknown) {
  return error instanceof ImportPageTimeoutError;
}

export function throwIfImportCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new ImportCancelledError();
}

/** A failed provider may fall back only while the import is still live. */
export async function runWithImportFallback<T>(
  primary: () => Promise<T>,
  fallback: () => Promise<T>,
  signal?: AbortSignal
) {
  throwIfImportCancelled(signal);
  try {
    return await primary();
  } catch (error) {
    if (signal?.aborted || isImportCancelledError(error))
      throw new ImportCancelledError();
    throwIfImportCancelled(signal);
    return fallback();
  }
}

export function boundedRasterScale(
  width: number,
  height: number,
  requestedScale: number,
  maximumPixels = MAX_IMPORT_RASTER_PIXELS
) {
  const area = Math.max(0, width) * Math.max(0, height);
  if (!Number.isFinite(area) || area <= 0 || maximumPixels <= 0)
    return Math.max(0.1, requestedScale);
  const safeRequested = Number.isFinite(requestedScale)
    ? Math.max(0.1, requestedScale)
    : 1;
  return Math.min(safeRequested, Math.sqrt(maximumPixels / area));
}

export function normalizeBatchSize(value: number | undefined) {
  const size = Math.floor(Number(value ?? 1));
  if (!Number.isFinite(size)) return 1;
  return Math.max(1, Math.min(MAX_IMPORT_BATCH_SIZE, size));
}

export async function withPageTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<T> {
  throwIfImportCancelled(signal);
  const safeTimeout = Number.isFinite(timeoutMs)
    ? Math.max(1, timeoutMs)
    : DEFAULT_PAGE_TIMEOUT_MS;
  const controller = new AbortController();
  const abortOperation = () => controller.abort();
  signal?.addEventListener("abort", abortOperation, { once: true });
  let abortListener: (() => void) | undefined;
  const callerAbortPromise = signal
    ? new Promise<never>((_, reject) => {
        abortListener = () => reject(new ImportCancelledError());
        signal.addEventListener("abort", abortListener, { once: true });
      })
    : null;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const operations: Array<Promise<T> | Promise<never>> = [
      operation(controller.signal).catch(error => {
        if (signal?.aborted) throw new ImportCancelledError();
        throw error;
      }),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          controller.abort();
          reject(new ImportPageTimeoutError());
        }, safeTimeout);
      }),
    ];
    if (callerAbortPromise) operations.push(callerAbortPromise);
    return await Promise.race(operations);
  } finally {
    signal?.removeEventListener("abort", abortOperation);
    if (signal && abortListener)
      signal.removeEventListener("abort", abortListener);
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

/**
 * Rounding each axis independently can push a "capped" bitmap past the budget,
 * so the longer axis is trimmed until the product is strictly inside it.
 */
export function boundedPixelSize(
  width: number,
  height: number,
  maximumPixels = MAX_IMPORT_RASTER_PIXELS
) {
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 1;
  const safeHeight = Number.isFinite(height) && height > 0 ? height : 1;
  const limit =
    Number.isFinite(maximumPixels) && maximumPixels >= 1
      ? Math.floor(maximumPixels)
      : 1;
  let pixelWidth = Math.max(1, Math.round(safeWidth));
  let pixelHeight = Math.max(1, Math.round(safeHeight));
  if (pixelWidth * pixelHeight > limit) {
    const scale = Math.sqrt(limit / (safeWidth * safeHeight));
    pixelWidth = Math.max(1, Math.round(safeWidth * scale));
    pixelHeight = Math.max(1, Math.round(safeHeight * scale));
  }
  while (pixelWidth * pixelHeight > limit) {
    if (pixelWidth >= pixelHeight && pixelWidth > 1) pixelWidth -= 1;
    else if (pixelHeight > 1) pixelHeight -= 1;
    else break;
  }
  return { width: pixelWidth, height: pixelHeight };
}

/**
 * A raster viewport whose ceil()-ed canvas size is guaranteed to stay inside
 * the pixel budget, plus the scale that fits inside that canvas.
 */
export function boundedRasterViewport(
  width: number,
  height: number,
  requestedScale: number,
  maximumPixels = MAX_IMPORT_RASTER_PIXELS
) {
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 1;
  const safeHeight = Number.isFinite(height) && height > 0 ? height : 1;
  const limit =
    Number.isFinite(maximumPixels) && maximumPixels >= 1
      ? Math.floor(maximumPixels)
      : 1;
  const requested = boundedRasterScale(
    safeWidth,
    safeHeight,
    requestedScale,
    limit
  );
  let pixelWidth = Math.max(1, Math.ceil(safeWidth * requested));
  let pixelHeight = Math.max(1, Math.ceil(safeHeight * requested));
  while (pixelWidth * pixelHeight > limit) {
    if (pixelWidth >= pixelHeight && pixelWidth > 1) pixelWidth -= 1;
    else if (pixelHeight > 1) pixelHeight -= 1;
    else break;
  }
  return {
    scale: Math.min(
      requested,
      pixelWidth / safeWidth,
      pixelHeight / safeHeight
    ),
    width: pixelWidth,
    height: pixelHeight,
  };
}
