import { millimetersToPercent, percentToMillimeters } from "@shared/formGeometry";

export { millimetersToPercent, percentToMillimeters };

export type PageManifestEntry = { page?: number; widthMm?: number; heightMm?: number; rotation?: number; assetId?: string; mimeType?: string };

export function pageDimensions(pageManifest: unknown, page: number) {
  const entries = Array.isArray(pageManifest) ? pageManifest as PageManifestEntry[] : [];
  const entry = entries.find((item, index) => (item.page ?? index + 1) === page);
  return { widthMm: entry?.widthMm ?? 210, heightMm: entry?.heightMm ?? 297 };
}
