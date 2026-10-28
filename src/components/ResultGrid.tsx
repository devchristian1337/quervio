// One Result Set in a Glide Data Grid. Rows live in Rust (ADR 0001): the grid
// fetches 200-row blocks as they scroll into view. It is mounted afresh for
// every Execution (keyed by run), so nothing cached outlives its rows.
//
// The look follows the app theme: quiet headers with a sort arrow, the sorted
// column tinted, numbers right-aligned, horizontal rules only, and a footer
// with the row count. Sorting happens in Rust over every row.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CompactSelection,
  DataEditor,
  GridCellKind,
  type DataEditorRef,
  type DrawCellCallback,
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
import { toast } from "@/components/ui/basic-toast";
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
import { displayCellText, mergeColumnWidths, minimumColumnWidths, SORT_ZONE, type MeasureGridText } from "@/lib/result-column-widths";
import type { Palette } from "@/lib/themes";
import { useTheme } from "@/lib/use-theme";
import type { ResultSetSummary } from "@/stores/queries";
import { useSettings, type Density } from "@/stores/settings";

const BLOCK = 200;
// The app's bundled faces (src/index.css): Inter, or JetBrains Mono on request.
const MONO = "'JetBrains Mono', 'Cascadia Code', Consolas, monospace";
const SANS = "Inter, 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif";

/** Whether the bundled fonts are in, so the canvas draws with them and not a fallback. */
function useFontsReady() {
  const [ready, setReady] = useState(() => document.fonts.check('13px "Inter"') && document.fonts.check('13px "JetBrains Mono"'));
  useEffect(() => {
    if (ready) return;
    let live = true;
    void Promise.all([
      document.fonts.load('400 13px "Inter"'),
      document.fonts.load('500 12px "Inter"'),
      document.fonts.load('400 13px "JetBrains Mono"'),
    ]).then(
      () => live && setReady(true),
    );
    return () => {
      live = false;
    };
  }, [ready]);
  return ready;
}

/**
 * Draws a number right-aligned with tabular figures: every digit takes the
 * width of the widest one, so digits line up down the column. The canvas has
 * no font-variant-numeric, and Inter's default digits are proportional.
 */
function drawTabular(ctx: CanvasRenderingContext2D, text: string, right: number, middle: number) {
  const digit = Math.max(...[..."0123456789"].map((d) => ctx.measureText(d).width));
  const widths = [...text].map((c) => (c >= "0" && c <= "9" ? digit : ctx.measureText(c).width));
  let x = right - widths.reduce((sum, w) => sum + w, 0);
  [...text].forEach((c, i) => {
    const w = widths[i];
    const own = c >= "0" && c <= "9" ? ctx.measureText(c).width : w;
    ctx.fillText(c, x + (w - own) / 2, middle);
    x += w;
  });
}
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
    // Row numbers sit a step under the values, never under 11 px (10 px in Compact).
    markerFontStyle: `${Math.max(11, size.font - 2)}px`,
    editorFontSize: `${size.font}px`,
  };
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
  const fontsReady = useFontsReady();
  const gridRef = useRef<DataEditorRef>(null);
  const blocks = useRef(new Map<number, Cell[][]>());
  const pending = useRef(new Set<number>());
  const [selection, setSelection] = useState<GridSelection>(emptySelection);
  const [widths, setWidths] = useState<Record<number, number>>({});
  const [measuredWidths, setMeasuredWidths] = useState<number[]>([]);
  const [viewer, setViewer] = useState<{ row: number; column: number } | null>(null);
  const [sort, setSort] = useState<Sort>(null);
  // Bumped after a sort so every cell is read again in the new order.
  const [order, setOrder] = useState(0);

  // fontsReady is a dependency on purpose: a new theme object redraws the canvas in the loaded font.
  const base = useMemo(
    () => gridTheme(p, theme.kind, density, monospace),
    [p, theme.kind, density, monospace, fontsReady],
  );
  const sortedTint = useMemo(() => mix(p.accent, p.bg, theme.kind === "dark" ? 0.09 : 0.06), [p, theme.kind]);
  const nullTheme = useMemo<Partial<GridTheme>>(
    () => ({ textDark: withAlpha(p.muted, 0.75), baseFontStyle: `italic ${base.baseFontStyle}` }),
    [p.muted, base.baseFontStyle],
  );

  const measure = useMemo<MeasureGridText>(() => {
    const ctx = document.createElement("canvas").getContext("2d")!;
    const bodyFont = `${base.baseFontStyle} ${base.fontFamily}`;
    ctx.font = bodyFont;
    const digit = Math.max(...[..."0123456789"].map((character) => ctx.measureText(character).width));
    return (text, role) => {
      ctx.font = role === "header" ? `${base.headerFontStyle} ${base.fontFamily}`
        : role === "null" ? `italic ${bodyFont}` : bodyFont;
      // Match drawTabular: Inter numbers use the widest digit's advance.
      if (role === "number" && !monospace) {
        return [...text].reduce((sum, character) => sum + (character >= "0" && character <= "9" ? digit : ctx.measureText(character).width), 0);
      }
      return ctx.measureText(text).width;
    };
  }, [base.baseFontStyle, base.headerFontStyle, base.fontFamily, monospace, fontsReady]);

  const headerWidths = useMemo(
    () => minimumColumnWidths(set.columns, set.kinds, [], base.cellHorizontalPadding!, measure),
    [set.columns, set.kinds, base.cellHorizontalPadding, measure],
  );
  const minimumWidths = useMemo(
    () => mergeColumnWidths(measuredWidths, headerWidths),
    [measuredWidths, headerWidths],
  );

  // Density, typeface or finished font loading changes the text's real width.
  useEffect(() => {
    setMeasuredWidths(minimumColumnWidths(set.columns, set.kinds, [...blocks.current.values()].flat(), base.cellHorizontalPadding!, measure));
  }, [set.columns, set.kinds, base.cellHorizontalPadding, measure]);

  const columns = useMemo<GridColumn[]>(
    () =>
      set.columns.map((name, index) => {
        const title = name || "(No column name)";
        const sorted = sort?.column === index;
        return {
          id: String(index),
          title,
          width: Math.max(widths[index] ?? 0, minimumWidths[index]),
          themeOverride: sorted ? { bgCell: sortedTint, bgHeader: sortedTint, textHeader: p.fg } : undefined,
        };
      }),
    [set.columns, widths, minimumWidths, sort, sortedTint, p.fg],
  );

  const fetchBlock = useCallback(
    async (block: number) => {
      if (pending.current.has(block)) return;
      pending.current.add(block);
      try {
        const buffer = await api.resultRows(tabId, set.index, block * BLOCK, BLOCK);
        const rows = decodeWindow(buffer);
        blocks.current.set(block, rows);
        // Include every fetched row, even in later blocks. Manual resizing
        // can add room, but may never clip a header or a loaded cell's text.
        const required = minimumColumnWidths(set.columns, set.kinds, rows, base.cellHorizontalPadding!, measure);
        setMeasuredWidths((current) => mergeColumnWidths(current, required));
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
    [tabId, set.index, set.columns, set.kinds, base.cellHorizontalPadding, measure],
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
      const display = displayCellText(cell);
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

  const drawCell = useCallback<DrawCellCallback>(
    (args, drawContent) => {
      const { ctx, cell, rect, theme: cellTheme, col } = args;
      const text = cell.kind === GridCellKind.Text ? cell.displayData : "";
      // Numbers only: NULL keeps its italic, other columns their normal drawing.
      if (set.kinds[col] !== "number" || cell.kind !== GridCellKind.Text || cell.data === "NULL" || monospace) {
        drawContent();
        return;
      }
      ctx.save();
      ctx.font = `${cellTheme.baseFontStyle} ${cellTheme.fontFamily}`;
      ctx.fillStyle = cellTheme.textDark;
      ctx.textBaseline = "middle";
      drawTabular(ctx, text, rect.x + rect.width - cellTheme.cellHorizontalPadding, rect.y + rect.height / 2);
      ctx.restore();
    },
    [set.kinds, monospace],
  );

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
              // Row numbers that select their row when clicked, as in SSMS: no checkboxes
              // in place of the numbers on hover, and none in the corner (Ctrl+A selects all).
              rowMarkers={{ kind: "clickable-number", headerDisabled: true }}
              rowHeight={size.row}
              headerHeight={size.header}
              width="100%"
              height="100%"
              smoothScrollX
              smoothScrollY
              theme={base}
              verticalBorder={false}
              drawHeader={drawHeader}
              drawCell={drawCell}
              gridSelection={selection}
              onGridSelectionChange={setSelection}
              keybindings={{ copy: false, paste: false, search: false }}
              maxColumnWidth={Math.max(10_000, ...minimumWidths)}
              onColumnResize={(_column, width, index) => setWidths((w) => ({ ...w, [index]: Math.max(width, minimumWidths[index]) }))}
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
