import { CellKind, type Cell } from "@/lib/results";
import type { Density } from "@/stores/settings";

/** Row and header heights, font size and cell padding of a results grid. */
export const GRID_SIZES: Record<Density, { row: number; header: number; font: number; padding: number }> = {
  comfortable: { row: 32, header: 36, font: 13, padding: 12 },
  compact: { row: 24, header: 28, font: 12, padding: 8 },
};

export const SORT_ZONE = 28;
export const MIN_COLUMN_WIDTH = 72;
/** The widest a column sizes itself: one long value must not make the grid thousands of pixels wide. */
export const MAX_AUTO_COLUMN_WIDTH = 480;
export type GridTextRole = "header" | "text" | "number" | "null";
export type MeasureGridText = (text: string, role: GridTextRole) => number;

/** Use exactly the same single-line text for sizing and drawing a cell. */
export function displayCellText(cell: Cell): string {
  if (cell.kind === CellKind.Null) return "NULL";
  const flat = cell.text.replace(/\r?\n|\r/g, " ");
  return cell.kind === CellKind.Preview ? `${flat}…` : flat;
}

/** Readable widths up to MAX_AUTO_COLUMN_WIDTH, including padding and the header's sort target. */
export function minimumColumnWidths(
  columns: readonly string[],
  kinds: readonly string[],
  rows: Iterable<readonly Cell[]>,
  padding: number,
  measure: MeasureGridText,
): number[] {
  const widths = columns.map((name) =>
    Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_AUTO_COLUMN_WIDTH, Math.ceil(measure(name || "(No column name)", "header")) + padding * 2 + SORT_ZONE + 2)),
  );
  for (const row of rows) {
    for (let column = 0; column < columns.length; column++) {
      const cell = row[column];
      // Already at the cap: nothing in this column can widen it further.
      if (!cell || widths[column] >= MAX_AUTO_COLUMN_WIDTH) continue;
      const role = cell.kind === CellKind.Null ? "null" : kinds[column] === "number" ? "number" : "text";
      widths[column] = Math.min(MAX_AUTO_COLUMN_WIDTH, Math.max(widths[column], Math.ceil(measure(displayCellText(cell), role)) + padding * 2 + 2));
    }
  }
  return widths;
}

/**
 * The longest start of `text` that fits `width` with an ellipsis, or `text`
 * itself when it fits. A binary search: values can be hundreds of characters.
 */
export function fitText(text: string, width: number, measure: (text: string) => number): string {
  // No glyph drawn is narrower than a pixel: more characters than pixels never fit.
  const cut = text.length > width;
  const source = cut ? text.slice(0, Math.max(0, Math.ceil(width))) : text;
  if (!cut && measure(source) <= width) return source;
  let low = 0;
  let high = source.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (measure(`${source.slice(0, middle)}…`) <= width) low = middle;
    else high = middle - 1;
  }
  return `${source.slice(0, low).trimEnd()}…`;
}

/**
 * Newly loaded rows can widen a column, but cannot hide a previously seen value.
 * `current` itself when nothing widens: a new array would lay out the grid again.
 */
export function mergeColumnWidths(current: readonly number[], incoming: readonly number[]): number[] {
  const merged = incoming.map((width, column) => Math.max(width, current[column] ?? 0));
  const same = merged.length === current.length && merged.every((width, column) => width === current[column]);
  return same ? (current as number[]) : merged;
}
