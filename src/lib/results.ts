// Decodes the row windows sent by quervio_core::results::ResultSet::window.
export const enum CellKind {
  Text = 0,
  Null = 1,
  /** Text cut to a preview; the full value is fetched on demand. */
  Preview = 2,
}

export interface Cell {
  kind: CellKind;
  text: string;
  /** The grid's one-line form of `text`, kept once worked out (ResultGrid). */
  display?: string;
}

const decoder = new TextDecoder();

export function decodeWindow(buffer: ArrayBuffer): Cell[][] {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const rowCount = view.getUint32(0, true);
  const columnCount = view.getUint32(4, true);
  let offset = 8;
  const rows: Cell[][] = [];
  for (let r = 0; r < rowCount; r++) {
    const row: Cell[] = new Array(columnCount);
    for (let c = 0; c < columnCount; c++) {
      const kind = bytes[offset] as CellKind;
      const length = view.getUint32(offset + 1, true);
      offset += 5;
      row[c] = { kind, text: length ? decoder.decode(bytes.subarray(offset, offset + length)) : "" };
      offset += length;
    }
    rows.push(row);
  }
  return rows;
}

/** Rows a grid reads from Rust at a time. */
export const ROW_BLOCK = 200;

// The first block of each Result Set of a quick Execution, read before its
// output is shown so the grid draws rows in its first frame. Keyed by tab and
// Result Set, for one run: a later run, a sort or the tab's close drops it.
const firstBlocks = new Map<string, { run: number; rows: Cell[][] }>();
const key = (tabId: string, index: number) => `${tabId}\u0000${index}`;

export function rememberFirstBlock(tabId: string, run: number, index: number, rows: Cell[][]) {
  firstBlocks.set(key(tabId, index), { run, rows });
}

export function firstBlock(tabId: string, run: number, index: number): Cell[][] | undefined {
  const entry = firstBlocks.get(key(tabId, index));
  return entry?.run === run ? entry.rows : undefined;
}

export function forgetFirstBlock(tabId: string, index: number) {
  firstBlocks.delete(key(tabId, index));
}

export function forgetFirstBlocks(tabId: string) {
  for (const k of firstBlocks.keys()) if (k.startsWith(`${tabId}\u0000`)) firstBlocks.delete(k);
  for (const k of sorts.keys()) if (k.startsWith(`${tabId}\u0000`)) sorts.delete(k);
}

// The sort the Session applied to a Result Set of one run. The grid can be
// mounted again (another tab, the Messages view); its rows stay sorted in
// Rust, so the header must keep showing that sort.
export type ResultSort = { column: number; direction: "ascending" | "descending" } | null;
const sorts = new Map<string, { run: number; sort: ResultSort }>();

export function rememberSort(tabId: string, run: number, index: number, sort: ResultSort) {
  sorts.set(key(tabId, index), { run, sort });
}

export function sortOf(tabId: string, run: number, index: number): ResultSort {
  const entry = sorts.get(key(tabId, index));
  return entry?.run === run ? entry.sort : null;
}
