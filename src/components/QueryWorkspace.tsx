import { lazy, Suspense, useEffect, useRef, useState } from "react";
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
  X,
  XCircle,
} from "lucide-react";
import { closeTab as closeTabSafely, openFile, saveTab } from "@/lib/files";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { StartScreen } from "@/components/StartScreen";
import { Button } from "@/components/ui/button";
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
import { tabEnvironment, useQueries, type QueryTab } from "@/stores/queries";

const SqlEditor = lazy(() => import("@/components/SqlEditor"));
const ResultGrid = lazy(() => import("@/components/ResultGrid"));

export function QueryWorkspace() {
  useGlobalShortcuts();
  const { tabs, activeId, resultsVisible } = useQueries();
  const active = tabs.find((t) => t.id === activeId) ?? null;

  return (
    <section className="flex h-full flex-col bg-background/70">
      <TabBar />
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

  return (
    <div className="flex h-9 shrink-0 items-end overflow-x-auto border-b bg-panel">
      {tabs.map((tab) => {
        const connection = connections.find((c) => c.id === tab.connectionId);
        const selected = tab.id === activeId;
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={selected}
            title={connection ? `${displayName(connection)}${tab.database ? ` · ${tab.database}` : ""}` : undefined}
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
            {tab.status === "executing" ? (
              <Loader2 className="size-3 shrink-0 animate-spin" />
            ) : tab.openTransactions > 0 ? (
              // The brand's second colour, as for activity: amber is the Test Environment's.
              <Circle className="size-2.5 shrink-0 fill-brand-secondary text-brand-secondary" aria-label="Open transaction" />
            ) : null}
            <span className="truncate" title={tab.filePath ?? undefined}>
              {tab.title}
              {tab.dirty ? "*" : ""}
            </span>
            {connection && <span className="truncate text-xs text-muted-foreground">{displayName(connection)}</span>}
            <button
              title="Close"
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
      disabled={tab.status !== "ready"}
    >
      <SelectTrigger
        size="sm"
        // As tall as the toolbar buttons; the size="sm" rule alone is 32 px.
        className="w-56 gap-1.5 px-2 py-0 data-[size=sm]:h-7"
        title="Current database (USE)"
      >
        <Database className="size-4 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-left">
          <SelectValue placeholder="Database" />
        </span>
      </SelectTrigger>
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
  const executing = tab.status === "executing";
  const environment = useConnections((s) => tabEnvironment(tab, s.connections));
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
      <Button size="icon" variant="ghost" className="size-7" title={`Open script (${keys.openFile})`} onClick={() => void openFile()}>
        <FolderOpen />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="size-7"
        title={`Save script (${keys.save})`}
        onClick={() => void saveTab(tab.id)}
      >
        <Save />
      </Button>
      <div className="mx-1 h-5 w-px bg-border" />
      <Button
        size="sm"
        variant="ghost"
        // The screen's one coloured control: the brand's, never an Environment's.
        className="h-7 text-primary hover:text-primary"
        disabled={tab.status !== "ready"}
        title={`Execute (${keys.execute})`}
        onClick={() => {
          const script = currentScript();
          if (script) void execute(tab.id, script);
          focusEditor();
        }}
      >
        <Play className="fill-current" /> Execute
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-7"
        disabled={!executing}
        title={`Cancel executing query (${keys.cancel})`}
        onClick={() => void cancel(tab.id)}
      >
        <Square className="fill-current" /> Cancel
      </Button>
      <div className="mx-1 h-5 w-px bg-border" />
      <DatabaseSelector tab={tab} />
      {environment && (
        <span
          className={cn("ml-2 shrink-0 rounded px-2 py-0.5 text-xs font-medium", ENVIRONMENTS[environment].pill)}
          title={
            environment === "production" ? "Destructive statements ask for confirmation on this server" : undefined
          }
        >
          {ENVIRONMENTS[environment].label}
        </span>
      )}
      {tab.status === "connecting" && (
        <span className="ml-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" /> Connecting…
        </span>
      )}
      {tab.status === "disconnected" && tab.error && (
        <span className="ml-2 truncate text-xs text-destructive select-text" title={tab.error}>
          {tab.error}
        </span>
      )}
    </div>
  );
}

function OutputPanel({ tab }: { tab: QueryTab }) {
  const setView = useQueries((s) => s.setView);
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-end gap-1 border-b bg-panel px-2 text-xs">
        {(["results", "messages"] as const).map((view) => (
          <button
            key={view}
            onClick={() => setView(tab.id, view)}
            className={cn(
              "-mb-px border-b-2 px-2 pb-1.5 capitalize",
              tab.view === view ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {view}
            {view === "messages" && tab.messages.some((m) => m.isError) && (
              <span className="ml-1.5 inline-block size-1.5 rounded-full bg-destructive align-middle" />
            )}
          </button>
        ))}
      </div>
      <div className={cn("min-h-0 flex-1", tab.view === "messages" && "overflow-auto")}>
        {tab.view === "messages" ? <Messages tab={tab} /> : <Results tab={tab} />}
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
  const allText = () => list.current?.innerText.trim() ?? "";
  const selectAll = () => {
    if (list.current) window.getSelection()?.selectAllChildren(list.current);
  };

  if (tab.status === "executing" && tab.messages.length === 0) return <Running />;
  return (
    <ContextMenu onOpenChange={(open) => open && setSelection(window.getSelection()?.toString() ?? "")}>
      <ContextMenuTrigger asChild>
        <div ref={list} className="min-h-full space-y-1 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap select-text">
          {tab.messages.map((message, index) => {
            const { line } = message;
            return (
              <div
                key={index}
                className={cn(message.isError && "text-destructive", line && "cursor-pointer hover:underline")}
                title={line ? `Go to line ${line}` : undefined}
                onDoubleClick={line ? () => revealLine(line) : undefined}
                onClick={line ? () => revealLine(line) : undefined}
              >
                {message.header && <div>{message.header}</div>}
                <div>{message.text}</div>
              </div>
            );
          })}
          {finishedAt && tab.status !== "executing" && (
            <div className="pt-2 text-muted-foreground">Completion time: {finishedAt.toISOString()}</div>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
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

function Results({ tab }: { tab: QueryTab }) {
  if (tab.resultSets.length === 0) {
    return tab.status === "executing" ? <Running /> : <Centered>No result sets.</Centered>;
  }
  return (
    <div className="flex h-full flex-col gap-1 overflow-auto p-1">
      {tab.resultSets.map((set) => (
        <div key={`${tab.runId}:${set.index}`} className="min-h-44 flex-1 overflow-hidden rounded border">
          <ErrorBoundary label="The results grid">
            <Suspense fallback={<Centered>Loading grid…</Centered>}>
              <ResultGrid tabId={tab.id} set={set} />
            </Suspense>
          </ErrorBoundary>
        </div>
      ))}
    </div>
  );
}

function useElapsed(tab: QueryTab) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (tab.status !== "executing") return;
    const timer = window.setInterval(() => tick((n) => n + 1), 250);
    return () => window.clearInterval(timer);
  }, [tab.status]);
  if (tab.status === "executing" && tab.startedAt !== null) return Date.now() - tab.startedAt;
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
  if (tab.status === "executing") {
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

  return (
    <footer className="flex h-6 shrink-0 items-center gap-4 border-t bg-panel px-3 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5">{status}</span>
      <span className="ml-auto">{tab.server?.serverName}</span>
      {connection && (
        <span>{connection.authentication.kind === "sql" ? connection.authentication.userName : "Windows"}</span>
      )}
      <span>{tab.database}</span>
      <span className="tabular-nums">{formatElapsed(elapsed)}</span>
      <span className="tabular-nums">
        {rows.toLocaleString("en-US")} {rows === 1 ? "row" : "rows"}
      </span>
    </footer>
  );
}
