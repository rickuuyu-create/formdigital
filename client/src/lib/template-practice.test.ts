import { describe, it, expect } from "vitest";
import {
  practiceLessons,
  checkPracticeLesson,
  practiceField,
  hasPracticeInput,
} from "./template-practice";

describe("practice completion is derived from real fields", () => {
  it("does not mark serialized empty table rows as entered data, but accepts zero", () => {
    for (const value of ["", "[]", '[["",""],[" ",null]]', "{}", "invalid"]) {
      expect(hasPracticeInput("table", value)).toBe(false);
    }
    expect(hasPracticeInput("table", '[["0",""]]')).toBe(true);
    expect(hasPracticeInput("table", '[[0,""]]')).toBe(true);
    expect(hasPracticeInput("table", '[["測試",""]]')).toBe(true);
  });
  it.each([
    ["A08", "dateFormat", "dd-mm-yyyy"],
    ["A11", "timeFormat", "hhmm"],
    ["G01", "imageFit", "cover"],
    ["B07", "options", ["unexpected"]],
    ["C01", "boxCount", 7],
  ] as const)("accepts the displayed default for %s but rejects a different selection", (id, key, wrong) => {
    const lesson = practiceLessons.find(x => x.id === id)!;
    const field = {
      ...practiceField(lesson), ...lesson.settings, type: lesson.type,
      confirmed: true, status: "confirmed" as const,
    };
    delete field[key];
    expect(checkPracticeLesson(lesson, [field]).complete).toBe(true);
    expect(checkPracticeLesson(lesson, [{ ...field, [key]: wrong }]).complete).toBe(false);
  });
  it("covers every approved group and all twelve types", () => {
    expect(practiceLessons).toHaveLength(41);
    expect(new Set(practiceLessons.map(x => x.type)).size).toBe(12);
  });
  it("does not count an empty frame, a duplicate label or a field on another page", () => {
    const lesson = practiceLessons[0];
    const field = practiceField(lesson);
    expect(checkPracticeLesson(lesson, [field]).complete).toBe(false);
    const correct = {
      ...field,
      ...lesson.settings,
      type: lesson.type,
      confirmed: true,
      status: "confirmed" as const,
    };
    expect(checkPracticeLesson(lesson, [correct]).complete).toBe(true);
    expect(
      checkPracticeLesson(lesson, [correct, { ...correct, id: "duplicate" }])
        .complete
    ).toBe(false);
    expect(
      checkPracticeLesson(lesson, [{ ...correct, page: 2 }]).complete
    ).toBe(false);
  });
  it("rejects circle choices with the right values but circles over the wrong letters", () => {
    const lesson = practiceLessons.find(x => x.id === "B01")!;
    const field = {
      ...practiceField(lesson),
      ...lesson.settings,
      type: lesson.type,
      confirmed: true,
      status: "confirmed" as const,
    };
    expect(checkPracticeLesson(lesson, [field]).complete).toBe(false);
    const aligned = { ...field, optionMarks: lesson.marks };
    expect(checkPracticeLesson(lesson, [aligned]).complete).toBe(true);
    expect(
      checkPracticeLesson(lesson, [
        {
          ...aligned,
          optionMarks: lesson.marks!.map(m => ({
            ...m,
            xRatio: m.xRatio + 0.08,
          })),
        },
      ]).complete
    ).toBe(false);
  });
  it("checks formulas and fixed cells, not just the table dimensions", () => {
    const lesson = practiceLessons.find(x => x.id === "D01")!;
    const correct = {
      ...practiceField(lesson),
      ...lesson.settings,
      type: lesson.type,
      confirmed: true,
      status: "confirmed" as const,
      tableCellGuides: lesson.cells,
    };
    expect(checkPracticeLesson(lesson, [correct]).complete).toBe(true);
    expect(
      checkPracticeLesson(lesson, [{ ...correct, tableFormulaCells: [] }])
        .complete
    ).toBe(false);
    expect(
      checkPracticeLesson(lesson, [
        { ...correct, tableWritableCells: undefined },
      ]).complete
    ).toBe(false);
    expect(
      checkPracticeLesson(lesson, [{ ...correct, tableCellGuides: undefined }])
        .complete
    ).toBe(false);
  });
});
