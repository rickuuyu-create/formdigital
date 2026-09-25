import { describe, expect, it } from "vitest";
import {
  CSV_PREVIEW_PAGE_SIZE,
  sliceCsvPreviewRows,
} from "@/lib/csv-preview";

describe("CSV preview paging", () => {
  it("bounds each rendered page without dropping rows", () => {
    const rows = Array.from({ length: 251 }, (_, index) => index + 1);

    expect(sliceCsvPreviewRows(rows, 0)).toHaveLength(CSV_PREVIEW_PAGE_SIZE);
    expect(sliceCsvPreviewRows(rows, 1)).toEqual(
      rows.slice(CSV_PREVIEW_PAGE_SIZE, CSV_PREVIEW_PAGE_SIZE * 2)
    );
    expect(sliceCsvPreviewRows(rows, 2)).toEqual(rows.slice(200));
    expect(sliceCsvPreviewRows(rows, -1)).toEqual(rows.slice(0, 100));
  });
});
