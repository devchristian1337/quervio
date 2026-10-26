// Decodes the row windows sent by querydeck_core::results::ResultSet::window.
export const enum CellKind {
  Text = 0,
  Null = 1,
  /** Text cut to a preview; the full value is fetched on demand. */
  Preview = 2,
}

export interface Cell {
  kind: CellKind;
  text: string;
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
