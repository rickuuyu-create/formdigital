import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectFormStructures,
  detectFormStructuresFromPixels,
  labelFormStructures,
} from "./form-structure";

function syntheticPage(width = 240, height = 180) {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const pixel = (x: number, y: number, shade = 0) => {
    const offset = (y * width + x) * 4;
    data[offset] = shade;
    data[offset + 1] = shade;
    data[offset + 2] = shade;
    data[offset + 3] = 255;
  };
  const horizontal = (
    x0: number,
    x1: number,
    y: number,
    thickness = 2,
    shade = 0
  ) => {
    for (let line = 0; line < thickness; line += 1)
      for (let x = x0; x <= x1; x += 1) pixel(x, y + line, shade);
  };
  const vertical = (
    x: number,
    y0: number,
    y1: number,
    thickness = 2,
    shade = 0
  ) => {
    for (let line = 0; line < thickness; line += 1)
      for (let y = y0; y <= y1; y += 1) pixel(x + line, y, shade);
  };
  const box = (
    x: number,
    y: number,
    boxWidth: number,
    boxHeight: number,
    thickness = 2,
    shade = 0
  ) => {
    horizontal(x, x + boxWidth, y, thickness, shade);
    horizontal(x, x + boxWidth, y + boxHeight, thickness, shade);
    vertical(x, y, y + boxHeight, thickness, shade);
    vertical(x + boxWidth, y, y + boxHeight, thickness, shade);
  };
  const circle = (centerX: number, centerY: number, radius: number) => {
    for (let y = centerY - radius - 1; y <= centerY + radius + 1; y += 1) {
      for (let x = centerX - radius - 1; x <= centerX + radius + 1; x += 1) {
        const distance = Math.hypot(x - centerX, y - centerY);
        if (distance >= radius - 1.3 && distance <= radius + 1.3) pixel(x, y);
      }
    }
  };
  const erase = (
    left: number,
    top: number,
    eraseWidth: number,
    eraseHeight: number
  ) => {
    for (let y = top; y < top + eraseHeight; y += 1)
      for (let x = left; x < left + eraseWidth; x += 1) pixel(x, y, 255);
  };
  const fill = (
    left: number,
    top: number,
    fillWidth: number,
    fillHeight: number
  ) => {
    for (let y = top; y < top + fillHeight; y += 1)
      for (let x = left; x < left + fillWidth; x += 1) pixel(x, y);
  };
  return {
    width,
    height,
    data,
    horizontal,
    vertical,
    box,
    circle,
    erase,
    fill,
  };
}

describe("free local form structure detection", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("detects text boxes, checkboxes, and underlines from synthetic pixels", () => {
    const page = syntheticPage();
    page.box(80, 30, 100, 24);
    page.box(30, 82, 14, 14);
    page.horizontal(90, 190, 130);

    const structures = detectFormStructuresFromPixels(page);

    expect(structures.some(item => item.kind === "text-box")).toBe(true);
    expect(structures.some(item => item.kind === "checkbox")).toBe(true);
    expect(structures.some(item => item.kind === "underline")).toBe(true);
  });

  it("uses nearby OCR text as an unconfirmed structural field label", () => {
    const [labelled] = labelFormStructures(
      [
        {
          kind: "text-box",
          left: 90,
          top: 35,
          width: 90,
          height: 22,
          confidence: 0.94,
        },
      ],
      [
        {
          text: "Student:",
          confidence: 96,
          left: 20,
          top: 36,
          width: 58,
          height: 16,
        },
      ]
    );

    expect(labelled?.label).toBe("Student");
    expect(labelled?.labelConfidence).toBeCloseTo(0.94);
  });

  it("keeps unmatched structures explicit instead of inventing a field name", () => {
    const [labelled] = labelFormStructures(
      [
        {
          kind: "checkbox",
          left: 20,
          top: 20,
          width: 12,
          height: 12,
          confidence: 0.9,
        },
      ],
      []
    );

    expect(labelled?.label).toBe("未命名欄位 1");
    expect(labelled?.labelConfidence).toBe(0);
  });

  it("filters checkbox-shaped text glyphs while keeping labels beside real boxes", () => {
    const checkbox = {
      kind: "checkbox" as const,
      left: 20,
      top: 20,
      width: 12,
      height: 10,
      confidence: 0.91,
    };
    expect(
      labelFormStructures(
        [checkbox],
        [
          {
            text: "Code:",
            confidence: 96,
            left: 4,
            top: 14,
            width: 54,
            height: 22,
          },
        ]
      )
    ).toEqual([]);

    const [labelled] = labelFormStructures(
      [checkbox],
      [
        {
          text: "Agree",
          confidence: 95,
          left: 42,
          top: 17,
          width: 52,
          height: 18,
        },
      ]
    );
    expect(labelled?.label).toBe("Agree");
  });

  it("consolidates adjacent character boxes into one logical field", () => {
    const page = syntheticPage(320, 180);
    for (let index = 0; index < 6; index += 1)
      page.box(30 + index * 23, 60, 20, 24);

    const structures = detectFormStructuresFromPixels(page);
    const characterField = structures.find(
      item => item.kind === "character-box"
    );

    expect(characterField?.boxCount).toBe(6);
    expect(structures.filter(item => item.kind === "checkbox")).toHaveLength(0);
    expect(structures.filter(item => item.kind === "table")).toHaveLength(0);
  });

  it("detects a repeated table grid as one table structure", () => {
    const page = syntheticPage(360, 240);
    for (const y of [70, 105, 140, 175]) page.horizontal(30, 320, y);
    for (const x of [30, 125, 220, 320]) page.vertical(x, 70, 175);

    const structures = detectFormStructuresFromPixels(page);
    const tables = structures.filter(item => item.kind === "table");

    expect(tables).toHaveLength(1);
    expect(tables[0]?.rows).toBe(3);
    expect(tables[0]?.columns).toBe(3);
    expect(tables[0]?.emptyCells).toBe(9);
  });

  it("recognises single-row and single-column grids as tables, but not a lone box", () => {
    const row = syntheticPage(360, 200);
    for (const y of [60, 108]) row.horizontal(40, 320, y);
    for (const x of [40, 133, 226, 320]) row.vertical(x, 60, 108);
    const rowStructures = detectFormStructuresFromPixels(row);
    const rowTables = rowStructures.filter(item => item.kind === "table");
    expect(rowTables).toHaveLength(1);
    expect(rowTables[0]).toMatchObject({
      rows: 1,
      columns: 3,
    });
    expect(rowStructures.some(item => item.kind === "text-box")).toBe(false);

    const column = syntheticPage(240, 240);
    for (const y of [40, 90, 140, 190]) column.horizontal(50, 190, y);
    for (const x of [50, 190]) column.vertical(x, 40, 190);
    const columnStructures = detectFormStructuresFromPixels(column);
    const columnTables = columnStructures.filter(item => item.kind === "table");
    expect(columnTables).toHaveLength(1);
    expect(columnTables[0]).toMatchObject({
      rows: 3,
      columns: 1,
    });
    expect(columnStructures.some(item => item.kind === "text-box")).toBe(false);

    const loneBox = syntheticPage();
    loneBox.box(70, 60, 110, 28);
    expect(
      detectFormStructuresFromPixels(loneBox).some(
        item => item.kind === "table"
      )
    ).toBe(false);
  });

  it("stitches small scan gaps in table dividers without creating row text boxes", () => {
    const page = syntheticPage(380, 260);
    for (const y of [50, 100, 150, 200]) page.horizontal(35, 345, y);
    for (const x of [35, 138, 241, 345]) {
      page.vertical(x, 50, 118);
      page.vertical(x, 131, 200);
    }

    const structures = detectFormStructuresFromPixels(page);
    const tables = structures.filter(item => item.kind === "table");
    expect(tables).toHaveLength(1);
    expect(tables[0]).toMatchObject({
      rows: 3,
      columns: 3,
    });
    expect(structures.some(item => item.kind === "text-box")).toBe(false);
  });

  it("detects high-DPI thick table rules", () => {
    const page = syntheticPage(420, 280);
    for (const y of [50, 110, 170, 230]) page.horizontal(40, 380, y, 6);
    for (const x of [40, 153, 266, 380]) page.vertical(x, 50, 230, 6);

    const tables = detectFormStructuresFromPixels(page).filter(
      item => item.kind === "table"
    );
    expect(tables).toHaveLength(1);
    expect(tables[0]).toMatchObject({ rows: 3, columns: 3 });
  });

  it("detects faint scanned rules and a checkbox with small border gaps", () => {
    const faint = syntheticPage(340, 200);
    faint.box(90, 30, 150, 28, 2, 218);
    faint.horizontal(100, 260, 150, 2, 218);
    const faintStructures = detectFormStructuresFromPixels(faint);
    expect(faintStructures.some(item => item.kind === "text-box")).toBe(true);
    expect(faintStructures.some(item => item.kind === "underline")).toBe(true);

    const broken = syntheticPage();
    broken.box(35, 70, 18, 18);
    broken.erase(43, 70, 3, 2);
    broken.erase(43, 88, 3, 2);
    broken.erase(35, 78, 2, 3);
    broken.erase(53, 78, 2, 3);
    const checkboxes = detectFormStructuresFromPixels(broken).filter(
      item => item.kind === "checkbox"
    );
    expect(checkboxes).toHaveLength(1);
    expect(checkboxes[0]).toMatchObject({
      left: 37,
      top: 72,
      width: 16,
      height: 14,
    });
  });

  it("retains low-contrast rules on dim scanned paper", () => {
    const page = syntheticPage(360, 240);
    for (let y = 0; y < page.height; y += 1) {
      for (let x = 0; x < page.width; x += 1) {
        const dimPaper = x + y < 430;
        const shade = dimPaper ? 190 + ((x + y) % 21) : 255;
        const offset = (y * page.width + x) * 4;
        page.data[offset] = shade;
        page.data[offset + 1] = shade;
        page.data[offset + 2] = shade;
        page.data[offset + 3] = 255;
      }
    }
    page.box(80, 45, 160, 28, 2, 176);
    page.horizontal(100, 260, 145, 2, 176);

    const structures = detectFormStructuresFromPixels(page);

    expect(structures.some(item => item.kind === "text-box")).toBe(true);
    expect(structures.some(item => item.kind === "underline")).toBe(true);
  });

  it("keeps a ruled table only when it contains writable blank cells", () => {
    const occupied = syntheticPage(360, 240);
    for (const y of [70, 105, 140, 175]) occupied.horizontal(30, 320, y);
    for (const x of [30, 125, 220, 320]) occupied.vertical(x, 70, 175);
    for (let rowIndex = 0; rowIndex < 3; rowIndex += 1) {
      for (let columnIndex = 0; columnIndex < 3; columnIndex += 1) {
        const left = 40 + columnIndex * 95;
        const top = 82 + rowIndex * 35;
        occupied.fill(left, top, 2, 12);
      }
    }

    expect(
      detectFormStructuresFromPixels(occupied).some(
        item => item.kind === "table"
      )
    ).toBe(false);
  });

  it("groups three slashed underlines into one segmented date field", () => {
    const page = syntheticPage(420, 240);
    page.horizontal(90, 135, 170);
    page.horizontal(160, 205, 170);
    page.horizontal(230, 275, 170);
    for (let offset = 0; offset <= 28; offset += 1) {
      const x = 138 + offset;
      if (x < 158) {
        const y = 152 + Math.round(offset * 0.7);
        const pixelOffset = (y * page.width + x) * 4;
        page.data[pixelOffset] = 0;
        page.data[pixelOffset + 1] = 0;
        page.data[pixelOffset + 2] = 0;
        page.data[pixelOffset + 3] = 255;
      }
      const secondX = 208 + offset;
      if (secondX < 228) {
        const y = 152 + Math.round(offset * 0.7);
        const pixelOffset = (y * page.width + secondX) * 4;
        page.data[pixelOffset] = 0;
        page.data[pixelOffset + 1] = 0;
        page.data[pixelOffset + 2] = 0;
        page.data[pixelOffset + 3] = 255;
      }
    }

    const structures = detectFormStructuresFromPixels(page);
    const dateGroup = structures.find(item => item.kind === "character-box");

    expect(dateGroup).toBeDefined();
    // Three equal-width rules are a DD / MM / YY date: six writable characters
    // across three printed segments, never three single characters.
    expect(dateGroup?.segmentCapacities).toEqual([2, 2, 2]);
    expect(dateGroup?.boxCount).toBe(6);
    expect(dateGroup?.members).toHaveLength(6);
    expect(structures.filter(item => item.kind === "underline")).toHaveLength(
      0
    );
  });

  it("gives a wider year segment its own larger character capacity", () => {
    const page = syntheticPage(800, 300);
    page.horizontal(60, 105, 170);
    page.horizontal(130, 175, 170);
    page.horizontal(200, 290, 170);
    const slash = (startX: number, limitX: number) => {
      for (let offset = 0; offset <= 28; offset += 1) {
        const x = startX + offset;
        if (x >= limitX) continue;
        const y = 152 + Math.round(offset * 0.7);
        const pixelOffset = (y * page.width + x) * 4;
        page.data[pixelOffset] = 0;
        page.data[pixelOffset + 1] = 0;
        page.data[pixelOffset + 2] = 0;
        page.data[pixelOffset + 3] = 255;
      }
    };
    slash(108, 128);
    slash(178, 198);

    const dateGroup = detectFormStructuresFromPixels(page).find(
      item => item.kind === "character-box"
    );

    expect(dateGroup?.segmentCapacities).toEqual([2, 2, 4]);
    expect(dateGroup?.boxCount).toBe(8);
    expect(dateGroup?.members).toHaveLength(8);
    // Each writable box stays inside the printed segment it belongs to.
    const segmentThree = dateGroup!.members!.slice(4);
    expect(segmentThree.every(box => box.left >= 199)).toBe(true);
    expect(
      segmentThree.every(box => box.left + box.width <= 291)
    ).toBe(true);
  });

  it("rejects vertical rules and stray specks as date separators", () => {
    const buildPage = (drawSeparators: (page: ReturnType<typeof syntheticPage>) => void) => {
      const page = syntheticPage(420, 240);
      page.horizontal(90, 135, 170);
      page.horizontal(160, 205, 170);
      page.horizontal(230, 275, 170);
      drawSeparators(page);
      return detectFormStructuresFromPixels(page);
    };

    const verticalSeparators = buildPage(page => {
      page.vertical(147, 152, 168, 2);
      page.vertical(217, 152, 168, 2);
    });
    expect(
      verticalSeparators.some(item => item.kind === "character-box")
    ).toBe(false);

    const speckles = buildPage(page => {
      page.fill(146, 158, 3, 3);
      page.fill(150, 164, 2, 2);
      page.fill(216, 158, 3, 3);
      page.fill(220, 164, 2, 2);
    });
    expect(speckles.some(item => item.kind === "character-box")).toBe(false);
  });

  it("requires a checkbox interior to remain hollow", () => {
    const markedInterior = syntheticPage();
    markedInterior.box(40, 60, 18, 18);
    markedInterior.fill(46, 66, 6, 6);

    expect(
      detectFormStructuresFromPixels(markedInterior).some(
        item => item.kind === "checkbox"
      )
    ).toBe(false);
  });

  it("rejects an underline with heavy ink directly below it", () => {
    const clean = syntheticPage();
    clean.horizontal(80, 200, 120);
    expect(
      detectFormStructuresFromPixels(clean).some(
        item => item.kind === "underline"
      )
    ).toBe(true);

    const dirty = syntheticPage();
    dirty.horizontal(80, 200, 120);
    dirty.horizontal(80, 200, 123, 1, 80);
    expect(
      detectFormStructuresFromPixels(dirty).some(
        item => item.kind === "underline"
      )
    ).toBe(false);
  });

  it("uses relative geometry for A4 and Letter scan sizes", () => {
    const a4 = syntheticPage(595, 842);
    for (const y of [100, 150, 200, 250]) a4.horizontal(50, 500, y);
    for (const x of [50, 200, 350, 500]) a4.vertical(x, 100, 250);
    const a4Tables = detectFormStructuresFromPixels(a4).filter(
      item => item.kind === "table"
    );
    expect(a4Tables).toHaveLength(1);
    expect(a4Tables[0]).toMatchObject({ rows: 3, columns: 3, emptyCells: 9 });

    const letter = syntheticPage(612, 792);
    for (const y of [90, 145, 200, 255]) letter.horizontal(55, 520, y);
    for (const x of [55, 210, 365, 520]) letter.vertical(x, 90, 255);
    const letterTables = detectFormStructuresFromPixels(letter).filter(
      item => item.kind === "table"
    );
    expect(letterTables).toHaveLength(1);
    expect(letterTables[0]).toMatchObject({
      rows: 3,
      columns: 3,
      emptyCells: 9,
    });
  });

  it("does not stitch distant rule fragments or classify a square box column as a table", () => {
    const distantFragments = syntheticPage(380, 260);
    for (const y of [50, 100, 150, 200])
      distantFragments.horizontal(35, 345, y);
    for (const x of [35, 138, 241, 345]) {
      distantFragments.vertical(x, 50, 108);
      distantFragments.vertical(x, 131, 200);
    }
    expect(
      detectFormStructuresFromPixels(distantFragments).some(
        item => item.kind === "table"
      )
    ).toBe(false);

    const verticalBoxes = syntheticPage(220, 190);
    for (const y of [40, 70, 100, 130]) verticalBoxes.horizontal(80, 110, y);
    for (const x of [80, 110]) verticalBoxes.vertical(x, 40, 130);
    expect(
      detectFormStructuresFromPixels(verticalBoxes).some(
        item => item.kind === "table"
      )
    ).toBe(false);
  });

  it("does not turn solid marks, decorative rules, or printed underlines into fields", () => {
    const solidMark = syntheticPage();
    solidMark.fill(40, 60, 20, 20);
    expect(
      detectFormStructuresFromPixels(solidMark).some(
        item => item.kind === "checkbox"
      )
    ).toBe(false);

    const roundedGlyph = syntheticPage();
    roundedGlyph.circle(80, 80, 10);
    expect(
      detectFormStructuresFromPixels(roundedGlyph).some(
        item => item.kind === "checkbox"
      )
    ).toBe(false);

    const decorativeRule = syntheticPage(340, 200);
    decorativeRule.horizontal(15, 325, 70);
    expect(
      detectFormStructuresFromPixels(decorativeRule).some(
        item => item.kind === "underline"
      )
    ).toBe(false);

    const printedUnderline = syntheticPage(340, 200);
    printedUnderline.horizontal(80, 260, 140);
    for (let x = 90; x <= 250; x += 14)
      printedUnderline.vertical(x, 120, 137, 2);
    expect(
      detectFormStructuresFromPixels(printedUnderline).some(
        item => item.kind === "underline"
      )
    ).toBe(false);
  });

  it("bounds the browser analysis canvas for very large source images", async () => {
    const drawImage = vi.fn();
    const close = vi.fn();
    const context = {
      fillStyle: "",
      imageSmoothingEnabled: false,
      imageSmoothingQuality: "low",
      fillRect: vi.fn(),
      drawImage,
      getImageData: vi.fn(
        (_: number, __: number, width: number, height: number) => ({
          width,
          height,
          data: new Uint8ClampedArray(0),
        })
      ),
    } as unknown as CanvasRenderingContext2D;
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => context),
    } as unknown as HTMLCanvasElement;
    const bitmap = {
      width: 4_000,
      height: 2_000,
      close,
    } as unknown as ImageBitmap;
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => bitmap)
    );
    vi.stubGlobal("document", { createElement: vi.fn(() => canvas) });

    await expect(
      detectFormStructures(new Blob(["synthetic"]))
    ).resolves.toEqual([]);
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(4_000_000);
    expect(canvas.width).toBeLessThan(bitmap.width);
    expect(drawImage).toHaveBeenCalledWith(
      bitmap,
      0,
      0,
      canvas.width,
      canvas.height
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it("never exceeds the analysis budget for awkward aspect ratios", async () => {
    const sizes: Array<[number, number]> = [
      [2_009, 9_651],
      [9_651, 2_009],
      [2_001, 2_001],
      [1_999, 2_001],
      [4_000, 1_000],
      [1, 40_000_000],
      [40_000_000, 1],
      [7, 3],
    ];
    for (const [width, height] of sizes) {
      const context = {
        fillStyle: "",
        imageSmoothingEnabled: false,
        imageSmoothingQuality: "low",
        fillRect: vi.fn(),
        drawImage: vi.fn(),
        getImageData: vi.fn(
          (_: number, __: number, imageWidth: number, imageHeight: number) => ({
            width: imageWidth,
            height: imageHeight,
            data: new Uint8ClampedArray(0),
          })
        ),
      } as unknown as CanvasRenderingContext2D;
      const canvas = {
        width: 0,
        height: 0,
        getContext: vi.fn(() => context),
      } as unknown as HTMLCanvasElement;
      const close = vi.fn();
      vi.stubGlobal(
        "createImageBitmap",
        vi.fn(async () => ({ width, height, close }) as unknown as ImageBitmap)
      );
      vi.stubGlobal("document", { createElement: vi.fn(() => canvas) });

      await detectFormStructures(new Blob(["synthetic"]));

      expect(canvas.width * canvas.height).toBeLessThanOrEqual(4_000_000);
      expect(canvas.width).toBeGreaterThanOrEqual(1);
      expect(canvas.height).toBeGreaterThanOrEqual(1);
      expect(canvas.width).toBeLessThanOrEqual(width);
      expect(canvas.height).toBeLessThanOrEqual(height);
      expect(close).toHaveBeenCalledOnce();
      vi.unstubAllGlobals();
    }
  });

  it("only offers the blank cells of a partly filled table as writable", () => {
    const page = syntheticPage(360, 240);
    for (const y of [70, 105, 140, 175]) page.horizontal(30, 320, y);
    for (const x of [30, 125, 220, 320]) page.vertical(x, 70, 175);
    for (let rowIndex = 0; rowIndex < 3; rowIndex += 1) {
      for (let columnIndex = 0; columnIndex < 3; columnIndex += 1) {
        if (rowIndex === 2 && columnIndex === 2) continue;
        page.fill(40 + columnIndex * 95, 82 + rowIndex * 35, 2, 12);
      }
    }

    const table = detectFormStructuresFromPixels(page).find(
      item => item.kind === "table"
    );

    expect(table?.rows).toBe(3);
    expect(table?.columns).toBe(3);
    expect(table?.writableCells).toEqual([{ row: 2, column: 2 }]);
    expect(table?.emptyCells).toBe(1);
  });

  it("treats short rules and small glyphs as occupied but keeps light speckle blank", () => {
    const grid = (mark?: (page: ReturnType<typeof syntheticPage>) => void) => {
      const page = syntheticPage(360, 240);
      for (const y of [70, 105, 140, 175]) page.horizontal(30, 320, y);
      for (const x of [30, 125, 220, 320]) page.vertical(x, 70, 175);
      mark?.(page);
      return detectFormStructuresFromPixels(page).find(
        item => item.kind === "table"
      );
    };

    expect(grid()?.writableCells).toHaveLength(9);

    const shortRule = grid(page => page.horizontal(45, 75, 88, 2));
    expect(shortRule?.writableCells).toHaveLength(8);
    expect(
      shortRule?.writableCells?.some(
        cell => cell.row === 0 && cell.column === 0
      )
    ).toBe(false);

    const smallGlyph = grid(page => page.fill(150, 120, 5, 7));
    expect(smallGlyph?.writableCells).toHaveLength(8);
    expect(
      smallGlyph?.writableCells?.some(
        cell => cell.row === 1 && cell.column === 1
      )
    ).toBe(false);

    const speckle = grid(page => {
      page.fill(240, 150, 2, 2);
      page.fill(250, 158, 1, 2);
      page.fill(262, 146, 2, 1);
    });
    expect(speckle?.writableCells).toHaveLength(9);
  });

  it("groups aligned hollow circles and extracts their OCR option labels", () => {
    const page = syntheticPage(360, 180);
    page.circle(90, 100, 10);
    page.circle(220, 100, 10);

    const structures = detectFormStructuresFromPixels(page);
    const radio = structures.find(item => item.kind === "radio");
    expect(radio?.members).toHaveLength(2);

    const [labelled] = labelFormStructures(
      [radio!],
      [
        {
          text: "Gender:",
          confidence: 95,
          left: 80,
          top: 52,
          width: 76,
          height: 18,
        },
        {
          text: "Male",
          confidence: 94,
          left: 108,
          top: 92,
          width: 44,
          height: 18,
        },
        {
          text: "Female",
          confidence: 93,
          left: 238,
          top: 92,
          width: 62,
          height: 18,
        },
      ]
    );
    expect(labelled?.label).toBe("Gender");
    expect(labelled?.options).toEqual(["Male", "Female"]);
  });
});
