// One Result Set in a Glide Data Grid. Rows live in Rust (ADR 0001): the grid
// fetches 200-row blocks as they scroll into view. It is mounted afresh for
// every Execution (keyed by run), so nothing cached outlives its rows.
//
// The look follows the app theme: quiet headers with a sort arrow, the sorted
// column tinted, numbers right-aligned, horizontal rules only, and a footer
// with the row count. Sorting happens in Rust over every row.
import { useCallback, useMemo, useRef, useState } from "react";
import {
  CompactSelection,
  DataEditor,
  GridCellKind,
  type DataEditorRef,
  type DrawHeaderCallback,
  type GridCell,
  type GridColumn,
  type GridSelection,
  type Item,
  type Theme as GridTheme,
} from "@glideapps/glide-data-grid";
import "@glideapps/glide-data-grid/dist/index.css";
import { save } from "@tauri-apps/plugin-dialog";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
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
import { api, errorMessage, type CopyFormat, type SortDirection } from "@/lib/api";
import { mix, withAlpha } from "@/lib/color";
import { CellKind, decodeWindow, type Cell } from "@/lib/results";
import type { Palette } from "@/lib/themes";
import { useTheme } from "@/lib/use-theme";
import type { ResultSetSummary } from "@/stores/queries";
import { useSettings, type Density } from "@/stores/settings";

const BLOCK = 200;
const MONO = "'Cascadia Code', Consolas, monospace";
const SANS = "'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif";
/** Width of the sort arrow's click target at the right of a header. */
const SORT_ZONE = 28;

const SIZES: Record<Density, { row: number; header: number; font: number; padding: number }> = {
  comfortable: { row: 32, header: 36, font: 13, padding: 12 },
  compact: { row: 24, header: 28, font: 12, padding: 8 },
};

function gridTheme(p: Palette, kind: "light" | "dark", density: Density, monospace: boolean): Partial<GridTheme> {
  const size = SIZES[density];
  return {
    accentColor: p.accent,
    accentFg: p.accentFg,
    accentLight: withAlpha(p.accent, kind === "dark" ? 0.22 : 0.14),
    textDark: p.fg,
    textMedium: p.muted,
    textLight: withAlpha(p.muted, 0.8),
    textBubble: p.fg,
    textHeader: p.muted,
    textHeaderSelected: p.accentFg,
    textGroupHeader: p.muted,
    bgCell: p.bg,
    bgCellMedium: mix(p.fg, p.bg, 0.03),
    bgHeader: p.bg,
    bgHeaderHasFocus: mix(p.fg, p.bg, 0.06),
    bgHeaderHovered: mix(p.fg, p.bg, 0.05),
    bgBubble: mix(p.fg, p.bg, 0.08),
    bgBubbleSelected: p.bg,
    bgSearchResult: withAlpha(p.accent, 0.25),
    borderColor: withAlpha(p.fg, 0.07),
    horizontalBorderColor: withAlpha(p.fg, 0.06),
    headerBottomBorderColor: withAlpha(p.fg, 0.14),
    drilldownBorder: withAlpha(p.fg, 0.1),
    linkColor: p.accent,
    cellHorizontalPadding: size.padding,
    cellVerticalPadding: 3,
    headerIconSize: 16,
    fontFamily: monospace ? MONO : SANS,
    baseFontStyle: `${monospace ? size.font - 1 : size.font}px`,
    headerFontStyle: `500 ${size.font - 1}px`,
    markerFontStyle: `${size.font - 2}px`,
    editorFontSize: `${size.font}px`,
  };
}

/** Approximate pixel width of grid text. */
function textWidth(text: string, monospace: boolean) {
  return Math.min(text.length, 60) * (monospace ? 7.3 : 7);
}

function plural(count: number, noun: string) {
  return `${count.toLocaleString("en-US")} ${noun}${count === 1 ? "" : "s"}`;
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

// lucide's ArrowUp, drawn on the canvas.
const ARROW = [new Path2D("m5 12 7-7 7 7"), new Path2D("M12 19V5")];

function drawArrow(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, down: boolean) {
  const size = 14;
  ctx.save();
  ctx.translate(x + size / 2, y + size / 2);
  if (down) ctx.rotate(Math.PI);
  ctx.scale(size / 24, size / 24);
  ctx.translate(-12, -12);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const path of ARROW) ctx.stroke(path);
  ctx.restore();
}

type Sort = { column: number; direction: SortDirection } | null;

interface Props {
  tabId: string;
  set: ResultSetSummary;
}

export default function ResultGrid({ tabId, set }: Props) {
  const theme = useTheme();
  const { density, monospace } = useSettings((s) => s.settings.results);
  const p = theme.palette;
  const gridRef = useRef<DataEditorRef>(null);
  const blocks = useRef(new Map<number, Cell[][]>());
  const pending = useRef(new Set<number>());
  const [selection, setSelection] = useState<GridSelection>(emptySelection);
  const [widths, setWidths] = useState<Record<number, number>>({});
  const [viewer, setViewer] = useState<{ row: number; column: number } | null>(null);
  const [sort, setSort] = useState<Sort>(null);
  // Bumped after a sort so every cell is read again in the new order.
  const [order, setOrder] = useState(0);

  const base = useMemo(() => gridTheme(p, theme.kind, density, monospace), [p, theme.kind, density, monospace]);
  const sortedTint = useMemo(() => mix(p.accent, p.bg, theme.kind === "dark" ? 0.09 : 0.06), [p, theme.kind]);
  const nullTheme = useMemo<Partial<GridTheme>>(
    () => ({ textDark: withAlpha(p.muted, 0.75), baseFontStyle: `italic ${base.baseFontStyle}` }),
    [p.muted, base.baseFontStyle],
  );

  const columns = useMemo<GridColumn[]>(
    () =>
      set.columns.map((name, index) => {
        const title = name || "(No column name)";
        const sorted = sort?.column === index;
        return {
          id: String(index),
          title,
          width: widths[index] ?? Math.max(72, textWidth(title, monospace) + 24 + SORT_ZONE),
          themeOverride: sorted ? { bgCell: sortedTint, bgHeader: sortedTint, textHeader: p.fg } : undefined,
        };
      }),
    [set.columns, widths, sort, sortedTint, p.fg, monospace],
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
                textWidth(name || "(No column name)", monospace) + SORT_ZONE,
                ...rows
                  .slice(0, 50)
                  .map((row) => textWidth(row[column]?.kind === CellKind.Null ? "NULL" : (row[column]?.text ?? ""), monospace)),
              );
              sized[column] = Math.min(400, Math.max(72, longest + 28));
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
    [tabId, set.index, set.columns, monospace],
  );

  const getCellContent = useCallback(
    ([column, row]: Item): GridCell => {
      const block = Math.floor(row / BLOCK);
      const cached = blocks.current.get(block);
      const cell = cached?.[row - block * BLOCK]?.[column];
      const align = set.kinds[column] === "number" ? "right" : undefined;
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
          contentAlign: align,
          themeOverride: nullTheme,
        };
      }
      const flat = cell.text.replace(/\r?\n|\r/g, " ");
      const display = cell.kind === CellKind.Preview ? `${flat}…` : flat;
      return { kind: GridCellKind.Text, data: cell.text, displayData: display, allowOverlay: false, contentAlign: align };
    },
    // `order` is a dependency on purpose: a new function makes the grid redraw every cell.
    [fetchBlock, nullTheme, set.kinds, order],
  );

  async function sortBy(column: number) {
    if (!set.done) {
      toast.info("Wait for the query to finish to sort");
      return;
    }
    // Ascending, descending, then back to the Server's order.
    const next: Sort =
      sort?.column !== column
        ? { column, direction: "ascending" }
        : sort.direction === "ascending"
          ? { column, direction: "descending" }
          : null;
    try {
      await api.resultSort(tabId, set.index, next?.column ?? null, next?.direction ?? "ascending");
      blocks.current.clear();
      setSort(next);
      setOrder((value) => value + 1);
    } catch (error) {
      toast.error("Sort failed", { description: errorMessage(error) });
    }
  }

  const drawHeader = useCallback<DrawHeaderCallback>(
    (args, drawContent) => {
      drawContent();
      const { ctx, rect, columnIndex, isHovered, isSelected } = args;
      const active = sort?.column === columnIndex;
      if (!active && !isHovered) return;
      const x = rect.x + rect.width - SORT_ZONE + (SORT_ZONE - 14) / 2;
      const y = rect.y + (rect.height - 14) / 2;
      const color = isSelected ? p.accentFg : active ? p.accent : withAlpha(p.muted, 0.45);
      drawArrow(ctx, x, y, color, active && sort?.direction === "descending");
    },
    [sort, p.accent, p.accentFg, p.muted],
  );

  const block = selectedBlock(selection, set.rows, set.columns.length);
  const all = { rows: [0, set.rows], columns: [0, set.columns.length] } as const;
  const selectedRows = selection.rows.length;

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
    if (event.key === "Escape" && (selection.rows.length || selection.current || selection.columns.length)) {
      setSelection(emptySelection);
      return;
    }
    if (!(event.ctrlKey && event.key.toLowerCase() === "c")) return;
    event.preventDefault();
    event.stopPropagation();
    void copy(event.shiftKey ? (event.altKey ? "markdown" : "textWithHeaders") : "text");
  }

  const size = SIZES[density];
  const sortedName = sort ? set.columns[sort.column] || "(No column name)" : null;

  return (
    <div className="flex h-full flex-col" onKeyDownCapture={onKeyDown}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="min-h-0 flex-1">
            <DataEditor
              ref={gridRef}
              columns={columns}
              rows={set.rows}
              getCellContent={getCellContent}
              rowMarkers="both"
              rowHeight={size.row}
              headerHeight={size.header}
              width="100%"
              height="100%"
              smoothScrollX
              smoothScrollY
              theme={base}
              verticalBorder={false}
              drawHeader={drawHeader}
              gridSelection={selection}
              onGridSelectionChange={setSelection}
              keybindings={{ copy: false, paste: false, search: false }}
              onColumnResize={(_column, width, index) => setWidths((w) => ({ ...w, [index]: width }))}
              onCellActivated={([column, row]) => setViewer({ row, column })}
              onHeaderClicked={(column, event) => {
                // The arrow sorts; the rest of the header selects the column, as in SSMS.
                if (event.localEventX >= event.bounds.width - SORT_ZONE) {
                  event.preventDefault();
                  void sortBy(column);
                }
              }}
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
          {sort && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => void sortBy(sort.column)}>
                {sort.direction === "ascending" ? "Sort descending" : "Clear sort"}
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>

      <footer className="flex h-8 shrink-0 items-center gap-3 border-t px-3 text-xs text-muted-foreground">
        <span className="flex items-baseline gap-1" aria-live="polite">
          <Count value={selectedRows || set.rows} className="font-medium text-foreground tabular-nums" />
          <Count value={selectedRows ? "selected" : set.rows === 1 ? "row" : "rows"} />
          {!set.done && <span>so far…</span>}
        </span>
        {selectedRows > 0 && (
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-foreground hover:bg-accent"
            onClick={() => setSelection(emptySelection)}
          >
            Clear selection
          </button>
        )}
        {sortedName && (
          <span className="ml-auto flex items-center gap-1.5">
            Sorted by <span className="font-medium text-foreground">{sortedName}</span>
            {sort?.direction === "descending" ? "↓" : "↑"}
            <button
              type="button"
              className="rounded px-1.5 py-0.5 text-foreground hover:bg-accent"
              onClick={() => {
                void api.resultSort(tabId, set.index, null, "ascending").then(() => {
                  blocks.current.clear();
                  setSort(null);
                  setOrder((value) => value + 1);
                });
              }}
            >
              Clear
            </button>
          </span>
        )}
      </footer>

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

/** Text that changes in place: the new value rises in, the old one lifts away. */
function Count({ value, className }: { value: number | string; className?: string }) {
  const reduced = useReducedMotion();
  const text = typeof value === "number" ? value.toLocaleString("en-US") : value;
  return (
    <span className={`relative inline-flex overflow-hidden ${className ?? ""}`}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={text}
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: "0.4em", filter: "blur(2px)" }}
          animate={{ opacity: 1, y: "0em", filter: "blur(0px)" }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, y: "-0.4em", filter: "blur(2px)" }}
          transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
        >
          {text}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
