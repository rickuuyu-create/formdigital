import { describe, expect, it, vi } from "vitest";
import {
  ImportCancelledError,
  MAX_IMPORT_BATCH_SIZE,
  MAX_IMPORT_RASTER_PIXELS,
  boundedPixelSize,
  boundedRasterScale,
  boundedRasterViewport,
  isImportCancelledError,
  normalizeBatchSize,
  runWithImportFallback,
  throwIfImportCancelled,
  withPageTimeout,
} from "./import-runtime";

describe("large document import runtime", () => {
  it("bounds raster pixels without changing normal page scales", () => {
    expect(boundedRasterScale(595, 842, 2)).toBe(2);
    expect(boundedRasterScale(595, 842, 0)).toBeGreaterThanOrEqual(0.1);

    const cappedScale = boundedRasterScale(
      20_000,
      40_000,
      4,
      MAX_IMPORT_RASTER_PIXELS
    );
    expect(cappedScale).toBeLessThan(0.15);
    expect(20_000 * cappedScale * 40_000 * cappedScale).toBeCloseTo(
      MAX_IMPORT_RASTER_PIXELS,
      6
    );
  });

  it("normalises batch sizes into a safe bounded range", () => {
    expect(normalizeBatchSize(undefined)).toBe(1);
    expect(normalizeBatchSize(3.9)).toBe(3);
    expect(normalizeBatchSize(Number.NaN)).toBe(1);
    expect(normalizeBatchSize(999)).toBe(MAX_IMPORT_BATCH_SIZE);
  });

  it("runs a page within its deadline and forwards the scoped abort signal", async () => {
    let sawSignal = false;
    await expect(
      withPageTimeout(async signal => {
        sawSignal = !signal.aborted;
        return "done";
      }, 1_000)
    ).resolves.toBe("done");
    expect(sawSignal).toBe(true);
  });

  it("stops a stalled page and aborts the page-scoped signal", async () => {
    let aborted = false;
    await expect(
      withPageTimeout(
        signal =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("TEST_PRIVATE_VALUE"));
            });
          }),
        20
      )
    ).rejects.toThrow("頁面處理逾時，已略過本頁的自動識別。");
    expect(aborted).toBe(true);
  });

  it("converts caller cancellation into a safe import-cancelled error", async () => {
    const controller = new AbortController();
    const operation = withPageTimeout(
      signal =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () =>
            reject(new Error("TEST_PRIVATE_VALUE"))
          );
        }),
      1_000,
      controller.signal
    );
    setTimeout(() => controller.abort(), 10);
    await expect(operation).rejects.toBeInstanceOf(ImportCancelledError);
    expect(isImportCancelledError(new ImportCancelledError())).toBe(true);
    expect(() => throwIfImportCancelled(controller.signal)).toThrow(
      ImportCancelledError
    );
  });

  it("never starts a provider fallback after the import was cancelled", async () => {
    const controller = new AbortController();
    const fallback = vi.fn(async () => "fallback");
    const operation = runWithImportFallback(
      async () => {
        controller.abort();
        throw new Error("SYSTEM_OCR_FAILED");
      },
      fallback,
      controller.signal
    );

    await expect(operation).rejects.toBeInstanceOf(ImportCancelledError);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("cancels promptly even when a legacy page operation ignores its signal", async () => {
    const controller = new AbortController();
    const operation = withPageTimeout(
      () => new Promise(() => {}),
      1_000,
      controller.signal
    );
    setTimeout(() => controller.abort(), 10);
    await expect(operation).rejects.toBeInstanceOf(ImportCancelledError);
  });
  it("keeps every bounded canvas strictly inside its pixel budget", () => {
    const sizes: Array<[number, number]> = [
      [2_009, 9_651],
      [9_651, 2_009],
      [4_001, 4_001],
      [3_999, 4_003],
      [20_000, 40_000],
      [1, 100_000_000],
      [100_000_000, 1],
      [5, 7],
      [595, 842],
    ];
    for (const limit of [4_000_000, MAX_IMPORT_RASTER_PIXELS]) {
      for (const [width, height] of sizes) {
        const size = boundedPixelSize(width, height, limit);
        expect(size.width * size.height).toBeLessThanOrEqual(limit);
        expect(size.width).toBeGreaterThanOrEqual(1);
        expect(size.height).toBeGreaterThanOrEqual(1);
        expect(size.width).toBeLessThanOrEqual(Math.max(1, Math.round(width)));
        expect(size.height).toBeLessThanOrEqual(
          Math.max(1, Math.round(height))
        );

        const viewport = boundedRasterViewport(width, height, 2, limit);
        expect(viewport.width * viewport.height).toBeLessThanOrEqual(limit);
        expect(Math.ceil(width * viewport.scale)).toBeLessThanOrEqual(
          viewport.width
        );
        expect(Math.ceil(height * viewport.scale)).toBeLessThanOrEqual(
          viewport.height
        );
      }
    }
  });

  it("refuses to produce a zero or non-finite canvas", () => {
    for (const [width, height] of [
      [0, 100],
      [100, 0],
      [Number.NaN, 100],
      [100, Number.POSITIVE_INFINITY],
      [-50, -50],
    ] as Array<[number, number]>) {
      const size = boundedPixelSize(width, height);
      expect(size.width).toBeGreaterThanOrEqual(1);
      expect(size.height).toBeGreaterThanOrEqual(1);
      expect(size.width * size.height).toBeLessThanOrEqual(
        MAX_IMPORT_RASTER_PIXELS
      );
      const viewport = boundedRasterViewport(width, height, 2);
      expect(viewport.width).toBeGreaterThanOrEqual(1);
      expect(viewport.height).toBeGreaterThanOrEqual(1);
      expect(Number.isFinite(viewport.scale)).toBe(true);
      expect(viewport.scale).toBeGreaterThan(0);
    }
  });

  it("leaves an ordinary page at its requested scale", () => {
    const viewport = boundedRasterViewport(595, 842, 2);
    expect(viewport.scale).toBeCloseTo(2, 6);
    expect(viewport.width).toBe(1_190);
    expect(viewport.height).toBe(1_684);
  });
});
