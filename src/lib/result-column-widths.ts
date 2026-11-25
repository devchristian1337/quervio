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

type GraphemeSegmenter = { segment(input: string): Iterable<{ segment: string }> };
const SegmenterCtor = (
  typeof Intl !== "undefined"
    ? (Intl as typeof Intl & {
        Segmenter?: new (locales?: string | string[], options?: { granularity: "grapheme" }) => GraphemeSegmenter;
      }).Segmenter
    : undefined
);
const graphemeSegmenter: GraphemeSegmenter | null = SegmenterCtor
  ? new SegmenterCtor(undefined, { granularity: "grapheme" })
  : null;

function splitGraphemes(text: string): string[] {
  if (graphemeSegmenter) {
    const out: string[] = [];
    for (const { segment } of graphemeSegmenter.segment(text)) out.push(segment);
    return out;
  }
  return Array.from(text);
}

/**
 * The longest start of `text` that fits `width` with an ellipsis, or `text`
 * itself when it fits. A binary search: values can be hundreds of characters.
 */
export function fitText(text: string, width: number, measure: (text: string) => number): string {
  if (width <= 0) return "…";
  const maxUnits = Math.ceil(width);
  // Avoid measuring multi-megabyte values in full, while allowing shorter strings
  // with combining marks or ZWJ sequences (whose UTF-16 length can exceed pixel width)
  // to be measured before deciding to truncate.
  const huge = text.length > maxUnits * 4;
  if (!huge && measure(text) <= width) return text;
  let source = text;
  if (huge) {
    let end = maxUnits;
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    source = text.slice(0, Math.max(0, end));
  }
  const units = splitGraphemes(source);
  let low = 0;
  let high = units.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (measure(`${units.slice(0, middle).join("")}…`) <= width) low = middle;
    else high = middle - 1;
  }
  return `${units.slice(0, low).join("").trimEnd()}…`;
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
