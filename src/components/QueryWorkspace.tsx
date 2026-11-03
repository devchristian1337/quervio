import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { toast } from "@/components/ui/basic-toast";
import {
  CheckCircle2,
  Circle,
  Database,
  FolderOpen,
  Loader2,
  Play,
  Save,
  Square,
  Workflow,
  X,
  XCircle,
} from "lucide-react";
import { closeTab as closeTabSafely, openFile, saveTab } from "@/lib/files";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { StartScreen } from "@/components/StartScreen";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/flexnative-tooltip";
import { Checkbox } from "@/components/ui/radix-checkbox";
import { useScrollFade } from "@/components/ui/scroll-fade";
import { Tabs } from "@/components/ui/vercel-tabs";
import { LoaderGooeyBlobs } from "@/components/ui/loaders-gooey-blobs";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { api, displayName, errorMessage } from "@/lib/api";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/interfaces-select";
import { currentScript, focusEditor, revealLine } from "@/lib/editor";
import { ENVIRONMENTS } from "@/lib/environment";
import { useGlobalShortcuts } from "@/lib/shortcuts";
import { useShortcutLabel } from "@/lib/commands";
import { cn } from "@/lib/utils";
import { useConnections } from "@/stores/connections";
import { tabEnvironment, useQueries, type QueryTab, type ResultSetSummary } from "@/stores/queries";
import { useSettings, type Density } from "@/stores/settings";
import { GRID_SIZES } from "@/lib/result-column-widths";
import { PlanViewer } from "@/components/management/PlanViewer";

const SqlEditor = lazy(() => import("@/components/SqlEditor"));
const ResultGrid = lazy(() => import("@/components/ResultGrid"));

export function QueryWorkspace() {
  useGlobalShortcuts();
  const { tabs, activeId, resultsVisible } = useQueries();
  const active = tabs.find((t) => t.id === activeId) ?? null;

  return (
    <section className="flex h-full flex-col bg-background/70">
      {/* No strip of empty tab bar over the start screen. */}
      {tabs.length > 0 && <TabBar />}
      {active ? (
        <>
          <Toolbar tab={active} />
          {/* Remounted when Ctrl+R hides or shows the results pane. */}
          <ResizablePanelGroup
            key={resultsVisible ? "split" : "editor"}
            orientation="vertical"
            className="min-h-0 flex-1"
          >
            <ResizablePanel defaultSize={resultsVisible ? "60%" : "100%"} minSize={80}>
              <ErrorBoundary label="The editor">
                <Suspense fallback={<Centered>Loading editor…</Centered>}>
                  <SqlEditor tabId={active.id} initialText={active.initialText} />
                </Suspense>
              </ErrorBoundary>
            </ResizablePanel>
            {resultsVisible && (
              <>
                <ResizableHandle />
                <ResizablePanel minSize={60}>
                  <ErrorBoundary label="The results panel">
                    <OutputPanel tab={active} />
                  </ErrorBoundary>
                </ResizablePanel>
              </>
            )}
          </ResizablePanelGroup>
          <StatusBar tab={active} />
        </>
      ) : (
        <StartScreen />
      )}
    </section>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="grid h-full place-items-center text-muted-foreground">{children}</div>;
}

async function closeTab(tab: QueryTab) {
  await closeTabSafely(tab.id);
}

function TabBar() {
  const { tabs, activeId, activate } = useQueries();
  const connections = useConnections((s) => s.connections);
  const bar = useRef<HTMLDivElement>(null);

  // A tab opened or chosen past the bar's edge scrolls into view. tabs.length:
  // a new tab is added and made active in the same step. Restored tabs widen
  // after the first paint, as their servers' names arrive, so it follows them.
  useEffect(() => {
    const element = bar.current;
    if (!element) return;
    const reveal = () =>
      element.querySelector('[role="tab"][aria-selected="true"]')?.scrollIntoView({ inline: "nearest", block: "nearest" });
    reveal();
    const observer = new ResizeObserver(reveal);
    for (const tab of element.querySelectorAll('[role="tab"]')) observer.observe(tab);
    return () => observer.disconnect();
  }, [activeId, tabs.length]);

  return (
    <div ref={bar} className="flex h-9 shrink-0 items-end overflow-x-auto border-b bg-panel">
      {tabs.map((tab) => {
        const connection = connections.find((c) => c.id === tab.connectionId);
        const selected = tab.id === activeId;
        const where = connection ? `${displayName(connection)}${tab.database ? ` · ${tab.database}` : ""}` : undefined;
        return (
          <Tip
            key={tab.id}
            side="bottom"
            label={
              tab.filePath && where ? (
                <span className="flex flex-col">
                  <span className="break-all">{tab.filePath}</span>
                  <span className="opacity-70">{where}</span>
                </span>
              ) : (
                (tab.filePath ?? where)
              )
            }
          >
          <div
            role="tab"
            aria-selected={selected}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                void closeTab(tab);
              } else {
                activate(tab.id);
              }
            }}
            className={cn(
              "group flex h-full min-w-0 max-w-56 shrink-0 cursor-pointer items-center gap-2 border-r border-t-2 px-3",
              selected ? "border-t-primary bg-background" : "border-t-transparent text-muted-foreground hover:bg-accent/40",
            )}
          >
            {tab.longRunning ? (
              <Loader2 className="size-3 shrink-0 animate-spin" />
            ) : tab.openTransactions > 0 ? (
              // The brand's second colour, as for activity: amber is the Test Environment's.
              <Circle className="size-2.5 shrink-0 fill-brand-secondary text-brand-secondary" aria-label="Open transaction" />
            ) : null}
            {/* The * outside the cut title: a long file name must not hide unsaved changes. */}
            <span className="flex max-w-40 min-w-0 shrink-0 items-baseline">
              <span className="min-w-0 truncate">{tab.title}</span>
              {tab.dirty && <span className="shrink-0">*</span>}
            </span>
            {/* The title keeps up to 10rem; the server gives way, so a long name never cuts the title to "Q…". */}
            {connection && <span className="min-w-0 truncate text-xs text-muted-foreground">{displayName(connection)}</span>}
            <button
              aria-label="Close"
              // A 20 px target; -mr-1 keeps the tab's right padding where it was.
              className={cn(
                "-mr-1 ml-1 grid size-5 shrink-0 place-items-center rounded hover:bg-accent",
                !selected && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
              )}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => void closeTab(tab)}
            >
              <X className="size-3.5" />
            </button>
          </div>
          </Tip>
        );
      })}
    </div>
  );
}

function DatabaseSelector({ tab }: { tab: QueryTab }) {
  const useDatabase = useQueries((s) => s.useDatabase);
  const [databases, setDatabases] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Listed when the menu opens, so new databases show up without a refresh.
  async function load(open: boolean) {
    if (!open) return;
    try {
      setDatabases((await api.databases(tab.connectionId)).map((d) => d.name));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const current = tab.database ?? "";
  const options = databases ?? (current ? [current] : []);
  return (
    <Select
      value={current}
      onOpenChange={(open) => void load(open)}
      onValueChange={(database) => void useDatabase(tab.id, database)}
      // Disabled only once the Execution shows itself running, like the other
      // controls: a quick one would make it blink. The store refuses a switch meanwhile.
      disabled={tab.longRunning || (tab.status !== "ready" && tab.status !== "executing") || tab.metadataAvailable === false}
    >
      <Tip label="Current database (USE)" wrap>
        <SelectTrigger
          size="sm"
          // As tall as the toolbar buttons; the size="sm" rule alone is 32 px.
          className="w-56 gap-1.5 px-2 py-0 data-[size=sm]:h-7"
          aria-label="Current database"
        >
          <Database className="size-4 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-left">
            <SelectValue placeholder="Database" />
          </span>
        </SelectTrigger>
      </Tip>
      <SelectContent
        // A plain dropdown under the trigger, as wide as it, not a list
        // laid over it around the current database.
        position="popper"
        align="start"
        className="max-h-72 w-(--radix-select-trigger-width)"
        // Back to the editor: the next thing is usually typing the query.
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          focusEditor();
        }}
      >
        {error && <div className="px-2 py-1.5 text-xs text-destructive">{error}</div>}
        {options.map((name) => (
          <SelectItem key={name} value={name} title={name}>
            <span className="truncate">{name}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Toolbar({ tab }: { tab: QueryTab }) {
  const keys = {
    openFile: useShortcutLabel("openFile"),
    save: useShortcutLabel("save"),
    execute: useShortcutLabel("execute"),
    cancel: useShortcutLabel("cancel"),
  };
  const { execute, cancel } = useQueries();
  // Shown running only past the store's threshold; the store still refuses
  // a second Execution before that.
  const executing = tab.longRunning;
  const environment = useConnections((s) => tabEnvironment(tab, s.connections));
  return (
    <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-1 border-b px-2 py-1">
      <Tip label={`Open script (${keys.openFile})`}>
        <Button size="icon" variant="ghost" className="size-7" aria-label="Open script" onClick={() => void openFile()}>
          <FolderOpen />
        </Button>
      </Tip>
      <Tip label={`Save script (${keys.save})`}>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label="Save script"
          onClick={() => void saveTab(tab.id)}
        >
          <Save />
        </Button>
      </Tip>
      <div className="mx-1 h-5 w-px bg-border" />
      <Tip label={`Execute (${keys.execute})`} wrap>
        <Button
          size="sm"
          variant="ghost"
          // The screen's one coloured control: the brand's, never an Environment's.
          className="h-7 text-primary hover:text-primary"
          disabled={(tab.status !== "ready" && tab.status !== "executing") || executing}
          // Keeps the focus in the editor: taking it would turn the selection
          // to its unfocused colour for as long as the button is held.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            const script = currentScript();
            if (script) void execute(tab.id, script);
            focusEditor();
          }}
        >
          <Play className="fill-current" /> Execute
        </Button>
      </Tip>
      <Tip label={`Cancel executing query (${keys.cancel})`} wrap>
        <Button
          size="sm"
          variant="ghost"
          className="h-7"
          disabled={!executing}
          onClick={() => void cancel(tab.id)}
        >
          <Square className="fill-current" /> Cancel
        </Button>
      </Tip>
      <div className="mx-1 h-5 w-px bg-border" />
      <DatabaseSelector tab={tab} />
      <Select
        value={tab.planMode ?? "none"}
        disabled={executing || tab.sqlcmdMode}
        onValueChange={(mode) => useQueries.getState().setPlanMode(tab.id, mode as "none" | "estimated" | "actual")}
      >
        <Tip label="Execution plan" wrap>
          <SelectTrigger
            size="sm"
            aria-label="Execution plan mode"
            // Like the database dropdown beside it.
            className="ml-1 w-40 gap-1.5 px-2 py-0 data-[size=sm]:h-7"
          >
            <Workflow className="size-4 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-left">
              <SelectValue />
            </span>
          </SelectTrigger>
        </Tip>
        <SelectContent position="popper" align="start" className="w-(--radix-select-trigger-width)">
          <SelectItem value="none">No plan</SelectItem>
          <SelectItem value="estimated">Estimated plan</SelectItem>
          <SelectItem value="actual">Actual plan</SelectItem>
        </SelectContent>
      </Select>
      <Tip label="SQLCMD includes, variables and commands are expanded and reviewed before execution">
        <label className="ml-1 flex h-7 cursor-pointer items-center gap-2 rounded-md px-2 text-sm select-none hover:bg-accent has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50">
          <Checkbox
            disabled={executing}
            checked={tab.sqlcmdMode ?? false}
            onCheckedChange={(checked) => useQueries.getState().setSqlcmdMode(tab.id, checked === true)}
          />
          SQLCMD
        </label>
      </Tip>
      {environment && (
        <Tip label={environment === "production" ? "Destructive statements ask for confirmation on this server" : undefined}>
          <span className={cn("ml-2 shrink-0 rounded px-2 py-0.5 text-xs font-medium", ENVIRONMENTS[environment].pill)}>
            {ENVIRONMENTS[environment].label}
          </span>
        </Tip>
      )}
      {tab.status === "connecting" && (
        <span className="ml-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" /> Connecting…
        </span>
      )}
      {tab.status === "disconnected" && tab.error && (
        <Tip label={tab.error}>
          <span className="ml-2 truncate text-xs text-destructive select-text">{tab.error}</span>
        </Tip>
      )}
    </div>
  );
}

function OutputPanel({ tab }: { tab: QueryTab }) {
  const setView = useQueries((s) => s.setView);
  // Only the messages scroll here; the grids and plans scroll on their own.
  const output = useRef<HTMLDivElement>(null);
  useScrollFade(output, { enabled: tab.view === "messages" });
  return (
    <div className="flex h-full flex-col">
      <Tabs
        aria-label="Output"
        className="shrink-0 bg-panel"
        listClassName="px-1"
        activeTab={tab.view}
        onTabChange={(view) => setView(tab.id, view as QueryTab["view"])}
        tabs={[
          { id: "results", label: "Results" },
          {
            id: "messages",
            label: (
              <>
                Messages
                {tab.messages.some((m) => m.isError) && (
                  <span className="ml-1.5 inline-block size-1.5 rounded-full bg-destructive" aria-label="has errors" />
                )}
              </>
            ),
          },
          { id: "plans", label: "Plans" },
        ]}
      />
      <div ref={output} className={cn("min-h-0 flex-1", tab.view === "messages" && "overflow-auto")}>
        {tab.view === "plans" ? <div className="flex h-full flex-col p-2"><PlanViewer plans={tab.plans} /></div> : tab.view === "messages" ? <Messages tab={tab} /> : <Results tab={tab} />}
      </div>
    </div>
  );
}

function Messages({ tab }: { tab: QueryTab }) {
  const finishedAt = tab.startedAt !== null && tab.elapsedMs !== null ? new Date(tab.startedAt + tab.elapsedMs) : null;
  const list = useRef<HTMLDivElement>(null);
  // Read when the menu opens: by the time an item is chosen, focus has moved.
  const [selection, setSelection] = useState("");

  const copy = (text: string, what: string) =>
    writeText(text).then(
      () => toast.success(`Copied ${what}`),
      (error) => toast.error("Copy failed", { description: errorMessage(error) }),
    );
  // From the lines, not innerText: rows skipped by content-visibility have no layout to read.
  const allText = () =>
    [
      ...tab.messages.flatMap((message) => (message.header ? [message.header, message.text] : [message.text])),
      ...(finishedAt && tab.status !== "executing" ? [`Completion time: ${finishedAt.toISOString()}`] : []),
    ].join("\n");
  const selectAll = () => {
    if (list.current) window.getSelection()?.selectAllChildren(list.current);
  };

  if (tab.longRunning && tab.messages.length === 0) return <Running />;
  return (
    <ContextMenu onOpenChange={(open) => open && setSelection(window.getSelection()?.toString() ?? "")}>
      <ContextMenuTrigger asChild>
        {/* wrap-anywhere: a long value without spaces (a varbinary) wraps instead of widening the pane. */}
        <div ref={list} className="min-h-full space-y-1 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap wrap-anywhere select-text">
          {tab.messages.map((message, index) => {
            const { line } = message;
            // Off-screen lines skip layout: ten thousand PRINTs stay cheap to scroll.
            const row = (
              <div
                key={index}
                className={cn(
                  "[contain-intrinsic-size:auto_1.25rem] [content-visibility:auto]",
                  message.isError && "text-destructive",
                  line && "cursor-pointer hover:underline",
                )}
                onDoubleClick={line ? () => revealLine(line) : undefined}
                onClick={line ? () => revealLine(line) : undefined}
              >
                {message.header && <div>{message.header}</div>}
                <div>{message.text}</div>
              </div>
            );
            // Only lines that lead somewhere get a tooltip.
            return line ? (
              <Tip key={index} label={`Go to line ${line}`}>
                {row}
              </Tip>
            ) : (
              row
            );
          })}
          {finishedAt && tab.status !== "executing" && (
            <div className="pt-2 text-muted-foreground">Completion time: {finishedAt.toISOString()}</div>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-48">
        <ContextMenuItem disabled={!selection} onSelect={() => void copy(selection, "selection")}>
          Copy <ContextMenuShortcut>Ctrl+C</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem disabled={tab.messages.length === 0} onSelect={() => void copy(allText(), "messages")}>
          Copy All
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={tab.messages.length === 0} onSelect={selectAll}>
          Select All
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Fills the output panel while a query runs and nothing has come back yet. */
function Running() {
  return (
    <Centered>
      <div className="flex flex-col items-center gap-4">
        <LoaderGooeyBlobs size={14} className="text-brand-secondary" aria-label="Executing query" />
        <span className="text-xs">Executing query…</span>
      </div>
    </Centered>
  );
}

/** Past this a Result Set's box stops growing with its rows and the grid scrolls. */
const BIG_SET_HEIGHT = 320;

/** The box that shows all of a Result Set: header, rows, footer, border and a horizontal scrollbar. */
function contentHeight(set: ResultSetSummary, density: Density) {
  const size = GRID_SIZES[density];
  // The footer is h-8 plus its top border; scrollbars are 10 px (index.css).
  return size.header + set.rows * size.row + 33 + 2 + 10;
}

function Results({ tab }: { tab: QueryTab }) {
  const density = useSettings((s) => s.settings.results.density);
  const scroller = useRef<HTMLDivElement>(null);
  if (tab.resultSets.length === 0) {
    if (tab.longRunning) return <Running />;
    return tab.status === "executing" ? null : <Centered>No result sets.</Centered>;
  }
  // Several sets: small ones take only what their rows need, so the big one
  // is not squeezed to a few rows; a lone big one takes the rest of the panel.
  // One set fills the panel as it always has.
  const single = tab.resultSets.length === 1;
  const heights = tab.resultSets.map((set) => contentHeight(set, density));
  const big = heights.filter((height) => height > BIG_SET_HEIGHT).length;
  return (
    <div ref={scroller} className="flex h-full flex-col gap-1 overflow-auto p-1">
      {tab.resultSets.map((set, i) => {
        const fill = big === 1 && heights[i] > BIG_SET_HEIGHT;
        return (
          // Keyed by index, not run: a new Execution reuses the grid (see ResultGrid).
          // The same element for one set or many, so a second set arriving keeps the first grid.
          <NearViewport
            key={set.index}
            root={scroller}
            className={single ? "min-h-44 flex-1" : fill ? "flex-1" : "shrink-0"}
            style={single ? undefined : fill ? { minHeight: BIG_SET_HEIGHT } : { height: Math.min(heights[i], BIG_SET_HEIGHT) }}
          >
            <ErrorBoundary label="The results grid">
              <Suspense fallback={<Centered>Loading grid…</Centered>}>
                <ResultGrid tabId={tab.id} runId={tab.runId} set={set} />
              </Suspense>
            </ErrorBoundary>
          </NearViewport>
        );
      })}
    </div>
  );
}

/** How far outside the results panel's view a grid is already mounted. */
const NEAR_MARGIN = 600;

/**
 * A Result Set's box that mounts its grid only once it scrolls near the
 * panel's view: sixty sets would otherwise draw three hundred canvases at once.
 * It stays mounted after that, so a sort or selection is not lost on the way back.
 */
function NearViewport({
  root,
  className,
  style,
  children,
}: {
  root: React.RefObject<HTMLDivElement | null>;
  className: string;
  style: React.CSSProperties | undefined;
  children: React.ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  // Measured before the first paint, so the boxes on screen never show empty
  // for a frame while the observer gets round to them.
  useLayoutEffect(() => {
    const element = box.current;
    // On the first mount the parent's ref is not attached yet; the parent is that scroller.
    const area = root.current ?? element?.parentElement;
    if (!element || !area) return;
    const own = element.getBoundingClientRect();
    const view = area.getBoundingClientRect();
    if (own.bottom >= view.top - NEAR_MARGIN && own.top <= view.bottom + NEAR_MARGIN) setNear(true);
  }, [root]);
  useEffect(() => {
    if (near || !box.current) return;
    const observer = new IntersectionObserver(
      (entries) => entries.some((entry) => entry.isIntersecting) && setNear(true),
      { root: root.current, rootMargin: `${NEAR_MARGIN}px 0px` },
    );
    observer.observe(box.current);
    return () => observer.disconnect();
  }, [near, root]);
  return (
    <div ref={box} className={cn("overflow-hidden rounded border", className)} style={style}>
      {near && children}
    </div>
  );
}

function useElapsed(tab: QueryTab) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!tab.longRunning) return;
    const timer = window.setInterval(() => tick((n) => n + 1), 250);
    return () => window.clearInterval(timer);
  }, [tab.longRunning]);
  if (tab.longRunning && tab.startedAt !== null) return Date.now() - tab.startedAt;
  return tab.elapsedMs;
}

function formatElapsed(ms: number | null) {
  if (ms === null) return "00:00:00";
  const seconds = Math.floor(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
}

function StatusBar({ tab }: { tab: QueryTab }) {
  const connection = useConnections((s) => s.connections.find((c) => c.id === tab.connectionId));
  const elapsed = useElapsed(tab);
  const rows = tab.resultSets.reduce((sum, set) => sum + set.rows, 0);

  let status: React.ReactNode;
  if (tab.longRunning) {
    status = (
      <>
        <Loader2 className="size-3 animate-spin" /> Executing query…
      </>
    );
  } else if (tab.status === "connecting") {
    status = "Connecting…";
  } else if (tab.status === "disconnected") {
    status = (
      <>
        <XCircle className="size-3" /> Disconnected
      </>
    );
  } else if (tab.outcome === "succeeded") {
    status = (
      <>
        <CheckCircle2 className="size-3" /> Query executed successfully.
      </>
    );
  } else if (tab.outcome === "failed") {
    status = (
      <>
        <XCircle className="size-3" /> Query completed with errors.
      </>
    );
  } else if (tab.outcome === "cancelled") {
    status = "Query was cancelled.";
  } else {
    status = "Connected.";
  }

  const login = connection
    ? connection.authentication.kind === "sql"
      ? connection.authentication.userName
      : connection.authentication.kind === "entra"
        ? "Microsoft Entra"
        : "Windows"
    : null;
  // Long names give way, cut with their full text on hover; the time and row count never do.
  return (
    <footer className="flex h-6 shrink-0 items-center gap-4 overflow-hidden border-t bg-panel px-3 text-xs text-muted-foreground">
      <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">{status}</span>
      <span className="ml-auto min-w-0 truncate" title={tab.server?.serverName}>{tab.server?.serverName}</span>
      {login !== null && (
        <span className="min-w-0 truncate" title={login}>{login}</span>
      )}
      <span className="min-w-0 truncate" title={tab.database ?? undefined}>{tab.database}</span>
      <span className="shrink-0 tabular-nums">{formatElapsed(elapsed)}</span>
      <span className="shrink-0 whitespace-nowrap tabular-nums">
        {rows.toLocaleString()} {rows === 1 ? "row" : "rows"}
      </span>
    </footer>
  );
}
