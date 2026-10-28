import { describe, expect, it } from "vitest";
import { CellKind, type Cell } from "@/lib/results";
import { displayCellText, mergeColumnWidths, minimumColumnWidths, SORT_ZONE, type MeasureGridText } from "@/lib/result-column-widths";

const text = (value: string): Cell => ({ kind: CellKind.Text, text: value });
const measure: MeasureGridText = (value, role) => value.length * (role === "number" ? 9 : role === "header" ? 8 : 7);

describe("result column minimum widths", () => {
  it("reserves space for the complete heading, both paddings and sort arrow", () => {
    expect(minimumColumnWidths(["messaggio_id"], ["number"], [], 12, measure))
      .toEqual(["messaggio_id".length * 8 + 24 + SORT_ZONE + 2]);
  });

  it("keeps an unnamed column's displayed heading readable", () => {
    expect(minimumColumnWidths([""], ["text"], [], 12, measure)[0])
      .toBe("(No column name)".length * 8 + 24 + SORT_ZONE + 2);
  });

  it("includes numeric values beyond the old 50-row sample and uses their tabular measure", () => {
    const rows = Array.from({ length: 200 }, (_, row) => [text(row === 100 ? "888888888888888888" : "1")]);
    expect(minimumColumnWidths(["n"], ["number"], rows, 12, measure)).toEqual([18 * 9 + 24 + 2]);
  });

  it("does not truncate measurements at 60 characters or cap widths at 400px", () => {
    expect(minimumColumnWidths(["value"], ["text"], [[text("W".repeat(120))]], 12, measure))
      .toEqual([120 * 7 + 24 + 2]);
  });

  it("measures the text actually drawn for nulls, multiline values and previews", () => {
    const seen: [string, string][] = [];
    minimumColumnWidths(["a", "b", "c"], ["number", "text", "text"], [[
      { kind: CellKind.Null, text: "" },
      text("one\r\ntwo\rthree\nfour"),
      { kind: CellKind.Preview, text: "preview" },
    ]], 8, (value, role) => { seen.push([value, role]); return measure(value, role); });
    expect(seen).toContainEqual(["NULL", "null"]);
    expect(seen).toContainEqual(["one two three four", "text"]);
    expect(seen).toContainEqual(["preview…", "text"]);
    expect(displayCellText({ kind: CellKind.Preview, text: "one\ntwo" })).toBe("one two…");
  });

  it("grows on later blocks and never shrinks past previously measured values", () => {
    const first = minimumColumnWidths(["n", "text"], ["number", "text"], [[text("123"), text("short")]], 12, measure);
    const later = minimumColumnWidths(["n", "text"], ["number", "text"], [[text("1"), text("W".repeat(100))]], 12, measure);
    const merged = mergeColumnWidths(first, later);
    expect(merged[0]).toBe(first[0]);
    expect(merged[1]).toBe(later[1]);
    expect(mergeColumnWidths(merged, first)).toEqual(merged);
  });
});
