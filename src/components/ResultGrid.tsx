// One Result Set in a Glide Data Grid. Rows live in Rust (ADR 0001): the grid
// fetches 200-row blocks as they scroll into view. It is mounted afresh for
// every Execution (keyed by run), so nothing cached outlives its rows.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CompactSelection,
  DataEditor,
  GridCellKind,
  type DataEditorRef,
  type GridCell,
  type GridColumn,
  type GridSelection,
  type Item,
  type Theme,
} from "@glideapps/glide-data-grid";
import "@glideapps/glide-data-grid/dist/index.css";
import { save } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ValueViewer } from "@/components/ValueViewer";
import { api, errorMessage, type CopyFormat } from "@/lib/api";
import { CellKind, decodeWindow, type Cell } from "@/lib/results";
import type { ResultSetSummary } from "@/stores/queries";

const BLOCK = 200;

const DARK: Partial<Theme> = {
  accentColor: "#7c8cff",
  accentLight: "rgba(124, 140, 255, 0.18)",
  textDark: "#e6e6ea",
  textMedium: "#a1a1aa",
  textLight: "#71717a",
  textHeader: "#d4d4d8",
  textHeaderSelected: "#ffffff",
  bgCell: "#17161c",
  bgCellMedium: "#1d1c23",
  bgHeader: "#1f1e25",
  bgHeaderHasFocus: "#2a2933",
  bgHeaderHovered: "#2a2933",
  borderColor: "rgba(255, 255, 255, 0.08)",
  horizontalBorderColor: "rgba(255, 255, 255, 0.05)",
  fontFamily: "'Cascadia Code', Consolas, monospace",
  baseFontStyle: "12px",
  headerFontStyle: "600 12px",
};

const LIGHT: Partial<Theme> = {
  accentColor: "#4f5bd5",
  accentLight: "rgba(79, 91, 213, 0.12)",
  textDark: "#18181b",
  textMedium: "#52525b",
  textLight: "#a1a1aa",
  textHeader: "#27272a",
  bgCell: "#ffffff",
  bgCellMedium: "#f8f8fa",
  bgHeader: "#f4f4f5",
  bgHeaderHasFocus: "#e4e4e7",
  bgHeaderHovered: "#e4e4e7",
  borderColor: "rgba(0, 0, 0, 0.1)",
  horizontalBorderColor: "rgba(0, 0, 0, 0.06)",
  fontFamily: "'Cascadia Code', Consolas, monospace",
  baseFontStyle: "12px",
  headerFontStyle: "600 12px",
};

const NULL_DARK: Partial<Theme> = { textDark: "#71717a", bgCell: "#201f1a" };
const NULL_LIGHT: Partial<Theme> = { textDark: "#a1a1aa", bgCell: "#fffbe6" };

function useDarkMode() {
  const [dark, setDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setDark(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return dark;
}

function plural(count: number, noun: string) {
  return `${count.toLocaleString("en-US")} ${noun}${count === 1 ? "" : "s"}`;
}

/** Approximate pixel width of grid text (12px monospace). */
function textWidth(text: string) {
  return Math.min(text.length, 60) * 7.3;
}

const emptySelection: GridSelection = {
  columns: CompactSelection.empty(),
  rows: CompactSelection.empty(),
};

/** The selected block as [start, end) row and column ranges. */
function selectedBlock(selection: GridSelection, rows: number, columns: number) {
  const range = selection.current?.range;
  if (range) {
    return { rows: [range.y, range.y + range.height], columns: [range.x, range.x + range.width] } as const;
  }
  const selectedColumns = selection.columns.toArray();
  if (selectedColumns.length) {
    return { rows: [0, rows], columns: [Math.min(...selectedColumns), Math.max(...selectedColumns) + 1] } as const;
  }
  const selectedRows = selection.rows.toArray();
  if (selectedRows.length) {
    return { rows: [Math.min(...selectedRows), Math.max(...selectedRows) + 1], columns: [0, columns] } as const;
  }
  return null;
}

interface Props {
  tabId: string;
  set: ResultSetSummary;
}

export default function ResultGrid({ tabId, set }: Props) {
  const dark = useDarkMode();
  const gridRef = useRef<DataEditorRef>(null);
  const blocks = useRef(new Map<number, Cell[][]>());
  const pending = useRef(new Set<number>());
  const [selection, setSelection] = useState<GridSelection>(emptySelection);
  const [widths, setWidths] = useState<Record<number, number>>({});
  const [viewer, setViewer] = useState<{ row: number; column: number } | null>(null);

  const columns = useMemo<GridColumn[]>(
    () =>
      set.columns.map((name, index) => ({
        id: String(index),
        title: name || "(No column name)",
        width: widths[index] ?? Math.max(60, textWidth(name || "(No column name)") + 24),
      })),
    [set.columns, widths],
  );

  const fetchBlock = useCallback(
    async (block: number) => {
      if (pending.current.has(block)) return;
      pending.current.add(block);
      try {
        const buffer = await api.resultRows(tabId, set.index, block * BLOCK, BLOCK);
        const rows = decodeWindow(buffer);
        blocks.current.set(block, rows);
        if (block === 0) {
          // Size columns to their first rows, like SSMS; a user resize wins.
          setWidths((current) => {
            const sized = { ...current };
            set.columns.forEach((name, column) => {
              if (sized[column] !== undefined) return;
              const longest = Math.max(
                textWidth(name || "(No column name)"),
                ...rows.slice(0, 50).map((row) => textWidth(row[column]?.kind === CellKind.Null ? "NULL" : (row[column]?.text ?? ""))),
              );
              sized[column] = Math.min(400, Math.max(60, longest + 24));
            });
            return sized;
          });
        }
        const damaged: { cell: Item }[] = [];
        for (let row = block * BLOCK; row < block * BLOCK + BLOCK; row++) {
          for (let column = 0; column < set.columns.length; column++) damaged.push({ cell: [column, row] });
        }
        gridRef.current?.updateCells(damaged);
      } catch {
        // Tab closed or re-executed meanwhile; the next draw asks again.
      } finally {
        pending.current.delete(block);
      }
    },
    [tabId, set.index, set.columns.length],
  );

  const getCellContent = useCallback(
    ([column, row]: Item): GridCell => {
      const block = Math.floor(row / BLOCK);
      const cached = blocks.current.get(block);
      const cell = cached?.[row - block * BLOCK]?.[column];
      if (!cell) {
        // Not fetched yet, or fetched while this block was still streaming.
        void fetchBlock(block);
        return { kind: GridCellKind.Loading, allowOverlay: false };
      }
      if (cell.kind === CellKind.Null) {
        return {
          kind: GridCellKind.Text,
          data: "NULL",
          displayData: "NULL",
          allowOverlay: false,
          themeOverride: dark ? NULL_DARK : NULL_LIGHT,
        };
      }
      const flat = cell.text.replace(/\r?\n|\r/g, " ");
      const display = cell.kind === CellKind.Preview ? `${flat}…` : flat;
      return { kind: GridCellKind.Text, data: cell.text, displayData: display, allowOverlay: false };
    },
    [dark, fetchBlock],
  );

  const block = selectedBlock(selection, set.rows, set.columns.length);
  const all = { rows: [0, set.rows], columns: [0, set.columns.length] } as const;

  async function copy(format: CopyFormat, range = block ?? all) {
    try {
      const copied = await api.resultCopy(
        tabId,
        set.index,
        [range.rows[0], range.rows[1]],
        [range.columns[0], range.columns[1]],
        format,
      );
      const what = `${plural(copied.rows, "row")} × ${plural(copied.columns, "column")}`;
      const how = { text: "", textWithHeaders: " with headers", markdown: " as Markdown" }[format];
      toast.success(`Copied ${what}${how}`);
    } catch (error) {
      toast.error("Copy failed", { description: errorMessage(error) });
    }
  }

  async function exportMarkdown() {
    const path = await save({
      defaultPath: `result-${set.index + 1}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!path) return;
    try {
      await api.resultExportMarkdown(tabId, set.index, path);
      toast.success(`Saved ${plural(set.rows, "row")} as Markdown`, { description: path });
    } catch (error) {
      toast.error("Save failed", { description: errorMessage(error) });
    }
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (!(event.ctrlKey && event.key.toLowerCase() === "c")) return;
    event.preventDefault();
    event.stopPropagation();
    void copy(event.shiftKey ? (event.altKey ? "markdown" : "textWithHeaders") : "text");
  }

  return (
    <div className="relative h-full" onKeyDownCapture={onKeyDown}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="h-full">
            <DataEditor
              ref={gridRef}
              columns={columns}
              rows={set.rows}
              getCellContent={getCellContent}
              rowMarkers="number"
              rowHeight={24}
              headerHeight={28}
              width="100%"
              height="100%"
              smoothScrollX
              smoothScrollY
              theme={dark ? DARK : LIGHT}
              gridSelection={selection}
              onGridSelectionChange={setSelection}
              keybindings={{ copy: false, paste: false, search: false }}
              onColumnResize={(_column, size, index) => setWidths((w) => ({ ...w, [index]: size }))}
              onCellActivated={([column, row]) => setViewer({ row, column })}
            />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-72">
          <ContextMenuItem onSelect={() => void copy("text")}>
            Copy <ContextMenuShortcut>Ctrl+C</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => void copy("textWithHeaders")}>
            Copy with Headers <ContextMenuShortcut>Ctrl+Shift+C</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => void copy("markdown")}>
            Copy as Markdown <ContextMenuShortcut>Ctrl+Shift+Alt+C</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => void copy("markdown", all)}>Copy all as Markdown</ContextMenuItem>
          <ContextMenuItem onSelect={() => void exportMarkdown()}>Save as Markdown…</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {viewer && (
        <ValueViewer
          tabId={tabId}
          set={set.index}
          row={viewer.row}
          column={viewer.column}
          columnName={set.columns[viewer.column] ?? ""}
          onClose={() => setViewer(null)}
        />
      )}
    </div>
  );
}
