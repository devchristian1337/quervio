import { CellKind, type Cell } from "@/lib/results";

export const SORT_ZONE = 28;
export const MIN_COLUMN_WIDTH = 72;
export type GridTextRole = "header" | "text" | "number" | "null";
export type MeasureGridText = (text: string, role: GridTextRole) => number;

/** Use exactly the same single-line text for sizing and drawing a cell. */
export function displayCellText(cell: Cell): string {
  if (cell.kind === CellKind.Null) return "NULL";
  const flat = cell.text.replace(/\r?\n|\r/g, " ");
  return cell.kind === CellKind.Preview ? `${flat}…` : flat;
}

/** Minimum readable widths, including padding and the header's sort target. */
export function minimumColumnWidths(
  columns: readonly string[],
  kinds: readonly string[],
  rows: Iterable<readonly Cell[]>,
  padding: number,
  measure: MeasureGridText,
): number[] {
  const widths = columns.map((name) =>
    Math.max(MIN_COLUMN_WIDTH, Math.ceil(measure(name || "(No column name)", "header")) + padding * 2 + SORT_ZONE + 2),
  );
  for (const row of rows) {
    for (let column = 0; column < columns.length; column++) {
      const cell = row[column];
      if (!cell) continue;
      const role = cell.kind === CellKind.Null ? "null" : kinds[column] === "number" ? "number" : "text";
      widths[column] = Math.max(widths[column], Math.ceil(measure(displayCellText(cell), role)) + padding * 2 + 2);
    }
  }
  return widths;
}

/** Newly loaded rows can widen a column, but cannot hide a previously seen value. */
export function mergeColumnWidths(current: readonly number[], incoming: readonly number[]): number[] {
  return incoming.map((width, column) => Math.max(width, current[column] ?? 0));
}
