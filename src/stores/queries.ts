// Query Tabs: each owns one Session on the Rust side (src-tauri/src/query.rs).
// The script text lives in the tab's Monaco model, not here.
import { Channel } from "@tauri-apps/api/core";
import { create } from "zustand";
import { toast } from "@/components/ui/basic-toast";
import { api, displayName, errorMessage, type Environment, type SavedConnection, type ScriptCheck, type ServerInfo } from "@/lib/api";
import { useConnections } from "@/stores/connections";
import { useDialogs } from "@/stores/dialogs";
import { executeOptions, useSettings } from "@/stores/settings";
import type { ColumnKind, ExecutionEvent, Outcome } from "@/lib/execution";
import { useSqlcmdConfirmation } from "@/stores/sqlcmd";
import {invalidateCatalog} from "@/lib/metadata-events";
import { decodeWindow, forgetFirstBlocks, rememberFirstBlock, ROW_BLOCK } from "@/lib/results";

export interface MessageLine {
  text: string;
  isError: boolean;
  header?: string | null;
  line?: number | null;
}

export interface ResultSetSummary {
  index: number;
  columns: string[];
  kinds: ColumnKind[];
  /** Rows read so far; grows while the Result Set streams. */
  rows: number;
  done: boolean;
}

export type TabStatus = "connecting" | "ready" | "executing" | "disconnected";

export interface QueryTab {
  id: string;
  title: string;
  connectionId: string;
  /** Display context captured when this Session opened; editing its Saved Connection leaves it unchanged. */
  connectionName: string;
  login: string | null;
  /** Changes when SQLCMD replaces the Session, invalidating its database menu. */
  sessionRevision: number;
  /** The Environment of the Saved Connection when the Session was opened. */
  environment: Environment | null;
  status: TabStatus;
  error: string | null;
  server: ServerInfo | null;
  database: string | null;
  openTransactions: number;
  messages: MessageLine[];
  /** Some message is an error; kept here so the tab need not scan every line. */
  hasErrors?: boolean;
  resultSets: ResultSetSummary[];
  outcome: Outcome | null;
  /** Bumped when an Execution's output replaces the last one's, so grids drop rows cached from it. */
  runId: number;
  /** The Execution has run longer than LONG_RUN_MS: only then does the UI show it running. */
  longRunning: boolean;
  startedAt: number | null;
  elapsedMs: number | null;
  view: "results" | "messages" | "plans";
  planMode?: "none" | "estimated" | "actual";
  plans?: string[];
  sqlcmdMode?: boolean;
  metadataAvailable?: boolean;
  /** Text the tab's editor starts with (restored, opened from a file or scripted). */
  initialText: string;
  /** The .sql file the tab was opened from or saved to. */
  filePath: string | null;
  /** Edited since it was opened or last saved. */
  dirty: boolean;
}

export interface OpenOptions {
  sqlcmdMode?: boolean;
  planMode?: "none" | "estimated" | "actual";
  title?: string;
  text?: string;
  filePath?: string | null;
  dirty?: boolean;
  /** Run the text as soon as the Session is open (Select Top 1000 Rows). */
  execute?: boolean;
  /** Bring the new tab to the front (default true). */
  activate?: boolean;
}

/** The script to run: the editor's selection or its whole text. */
export interface Script {
  text: string;
  /** Zero-based editor line where `text` starts. */
  baseLine: number;
}

interface QueriesState {
  tabs: QueryTab[];
  activeId: string | null;
  open: (connectionId: string, database?: string | null, options?: OpenOptions) => Promise<void>;
  /** Whether the Results/Messages pane is shown (Ctrl+R). */
  resultsVisible: boolean;
  toggleResults: () => void;
  /** Activates the next (1) or previous (-1) tab. */
  cycle: (step: 1 | -1) => void;
  setDirty: (id: string, dirty: boolean) => void;
  markSaved: (id: string, filePath: string, dirty: boolean) => void;
  close: (id: string) => Promise<void>;
  activate: (id: string) => void;
  setView: (id: string, view: QueryTab["view"]) => void;
  setPlanMode: (id: string, mode: NonNullable<QueryTab["planMode"]>) => void;
  setSqlcmdMode: (id: string, mode: boolean) => void;
  execute: (id: string, script: Script) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  useDatabase: (id: string, database: string) => Promise<void>;
  /** Closes the tab, first asking what to do with open transactions. */
  closeSafely: (id: string, canClose?: () => boolean) => Promise<boolean>;
  /** Ends open transactions in every tab, asking once; false if the user cancels. */
  settleAllTransactions: () => Promise<boolean>;
}

let counter = 0;

/**
 * The Environment the Production guard uses for a tab: the one its Session
 * was opened with, since editing or deleting the Saved Connection leaves the
 * Session on its Server, or Production if the connection says so now.
 */
export function tabEnvironment(tab: QueryTab, connections: SavedConnection[]): Environment | null {
  const current = connections.find((c) => c.id === tab.connectionId)?.environment ?? null;
  return current === "production" ? current : (tab.environment ?? current);
}

export function fileName(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

/** Commits or rolls back the tabs' transactions; false (with a toast) if any fails. */
async function endTransactions(tabs: QueryTab[], commit: boolean) {
  for (const tab of tabs) {
    try {
      const remaining = await api.endTransactions(tab.id, commit);
      useQueries.setState((s) => ({
        tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, openTransactions: remaining } : t)),
      }));
      if (remaining > 0) throw new Error(`${remaining} transaction(s) are still open`);
    } catch (error) {
      toast.error(`${commit ? "Commit" : "Rollback"} failed in ${tab.title}`, { description: errorMessage(error) });
      return false;
    }
  }
  toast.success(commit ? "Transactions committed" : "Transactions rolled back");
  return true;
}

/** How long an Execution runs before the UI shows it running. */
const LONG_RUN_MS = 300;
/** How often streamed messages are added to the tab. */
const MESSAGE_FLUSH_MS = 16;
/** Past this many lines, less often: each flush copies the list. */
const MESSAGE_FLUSH_SLOW_AFTER = 1000;
const MESSAGE_FLUSH_SLOW_MS = 100;

/** Reads the first rows of each Result Set of a quick Execution for the run about to be shown. */
async function readFirstBlocks(id: string, sets: ResultSetSummary[]) {
  const tab = useQueries.getState().tabs.find((t) => t.id === id);
  if (!tab) return;
  await Promise.all(
    sets.filter((set) => set.rows > 0).map(async (set) => {
      try {
        const rows = decodeWindow(await api.resultRows(id, set.index, 0, ROW_BLOCK));
        rememberFirstBlock(id, tab.runId + 1, set.index, rows);
      } catch {
        // The grid reads them itself.
      }
    }),
  );
}

/** Tabs whose Execute is past its "ready" check and still being prepared. */
const starting = new Set<string>();

type Prepared = { allowDestructive: boolean; sqlcmdToken: string | null };

/**
 * The approvals an Execution needs before it runs: the expanded SQLCMD
 * script, and on Production its Destructive Statements. Null when the user
 * declines or preparing fails. Without anything to ask it answers at once,
 * so a plain Execution shows itself running in the same tick.
 */
function prepareExecution(tab: QueryTab, script: { text: string; baseLine: number }): Prepared | null | Promise<Prepared | null> {
  // On Production, Destructive Statements need an explicit go-ahead.
  // The Session checks it again on its own side unless allowed here.
  const confirm = useSettings.getState().settings.query.confirmDestructive;
  if (tab.sqlcmdMode) return prepareSqlcmd(tab, script, confirm);
  if (tab.planMode !== "estimated" && confirm && tabEnvironment(tab, useConnections.getState().connections) === "production") {
    return confirmProduction(tab, script);
  }
  return { allowDestructive: !confirm, sqlcmdToken: null };
}

function confirmDestructive(tab: QueryTab, check: ScriptCheck) {
  return useDialogs.getState().confirmDestructive({
    tabTitle: tab.title,
    connectionName: tab.connectionName || tab.server?.serverName || tab.title,
    check,
  });
}

async function confirmProduction(tab: QueryTab, script: { text: string; baseLine: number }): Promise<Prepared | null> {
  const check = await api.checkScript(script.text, script.baseLine);
  if (check.findings.length === 0 && !check.uncertain) return { allowDestructive: false, sqlcmdToken: null };
  return await confirmDestructive(tab, check) ? { allowDestructive: true, sqlcmdToken: null } : null;
}

/** Reviews the expanded script; a preview left unused is discarded at once. */
async function prepareSqlcmd(tab: QueryTab, script: { text: string; baseLine: number }, confirm: boolean): Promise<Prepared | null> {
  const id = tab.id;
  let token: string | null = null;
  const discard = () => {
    if (token) void api.sqlcmdDiscard(id, token).catch(() => {});
    return null;
  };
  try {
    let preview = await api.sqlcmdPrepare(id, script.text, tab.filePath, script.baseLine);
    if (preview.kind === "fileAccessRequired") {
      if (!await useSqlcmdConfirmation.getState().ask(script.text, false, "fileAccess")) return null;
      preview = await api.sqlcmdPrepare(id, script.text, tab.filePath, script.baseLine, true);
    }
    if (preview.kind !== "ready") throw new Error("SQLCMD file access was not authorized.");
    token = preview.token;
    if (!await useSqlcmdConfirmation.getState().ask(preview.script, preview.hasLocalCommands)) return discard();
    // Production, or a :connect that may reach any server.
    if (confirm && preview.needsConfirmation) {
      return await confirmDestructive(tab, preview.destructive) ? { allowDestructive: true, sqlcmdToken: token } : discard();
    }
    return { allowDestructive: !confirm, sqlcmdToken: token };
  } catch (error) {
    discard();
    toast.error("SQLCMD preparation failed", { description: errorMessage(error) });
    return null;
  }
}

export const useQueries = create<QueriesState>((set, get) => {
  const patch = (id: string, change: Partial<QueryTab> | ((tab: QueryTab) => Partial<QueryTab>)) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...(typeof change === "function" ? change(t) : change) } : t)),
    }));

  return {
    tabs: [],
    activeId: null,
    resultsVisible: true,

    toggleResults: () => set((s) => ({ resultsVisible: !s.resultsVisible })),

    cycle: (step) => {
      const { tabs, activeId } = get();
      if (tabs.length < 2) return;
      const index = tabs.findIndex((t) => t.id === activeId);
      set({ activeId: tabs[(index + step + tabs.length) % tabs.length].id });
    },

    setDirty: (id, dirty) => {
      if (get().tabs.find((t) => t.id === id)?.dirty !== dirty) patch(id, { dirty });
    },

    markSaved: (id, filePath, dirty) => patch(id, { filePath, dirty, title: fileName(filePath) }),

    open: async (connectionId, database = null, options = {}) => {
      // Restored "Query 7" keeps new tabs numbering after it.
      const number = /^Query (\d+)$/.exec(options.title ?? "");
      counter = number ? Math.max(counter, Number(number[1])) : counter + 1;
      const id = crypto.randomUUID();
      const text = options.text ?? "";
      const connection = useConnections.getState().connections.find((c) => c.id === connectionId);
      const tab: QueryTab = {
        id,
        title: options.title ?? (options.filePath ? fileName(options.filePath) : `Query ${counter}`),
        connectionId,
        connectionName: connection ? displayName(connection) : "",
        login: connection?.authentication.kind === "sql" ? connection.authentication.userName
          : connection?.authentication.kind === "entra" ? "Microsoft Entra" : connection ? "Windows" : null,
        sessionRevision: 0,
        environment: connection?.environment ?? null,
        status: "connecting",
        error: null,
        server: null,
        database,
        openTransactions: 0,
        messages: [],
        resultSets: [],
        outcome: null,
        runId: 0,
        longRunning: false,
        startedAt: null,
        elapsedMs: null,
        view: "messages",
        initialText: text,
        filePath: options.filePath ?? null,
        dirty: options.dirty ?? false,
        sqlcmdMode: options.sqlcmdMode ?? false,
        planMode: options.planMode ?? "none",
      };
      set((s) => ({ tabs: [...s.tabs, tab], activeId: options.activate === false ? s.activeId : id }));
      try {
        const server = await api.openQuery(id, connectionId, database);
        if (!get().tabs.some((t) => t.id === id)) {
          // The first close may have reached Rust before query_open registered
          // its Session. Close again after that registration has completed.
          try { await api.closeQuery(id); }
          catch (error) { toast.error("Could not close the completed connection", { description: errorMessage(error) }); }
          return;
        }
        patch(id, { status: "ready", server, database: server.database,
          connectionName: server.connectionName ?? tab.connectionName,
          login: server.login ?? tab.login });
      } catch (error) {
        patch(id, { status: "disconnected", error: errorMessage(error) });
        return;
      }
      if (options.execute) await get().execute(id, { text, baseLine: 0 });
    },

    close: async (id) => {
      const tabs = get().tabs;
      const index = tabs.findIndex((t) => t.id === id);
      if (index === -1) return;
      const remaining = tabs.filter((t) => t.id !== id);
      const activeId =
        get().activeId === id ? (remaining[Math.min(index, remaining.length - 1)]?.id ?? null) : get().activeId;
      set({ tabs: remaining, activeId });
      forgetFirstBlocks(id);
      await api.closeQuery(id);
    },

    activate: (id) => set({ activeId: id }),

    setView: (id, view) => patch(id, { view }),
    setPlanMode: (id, planMode) => patch(id, { planMode }),
    setSqlcmdMode: (id, sqlcmdMode) => patch(id, { sqlcmdMode, planMode: "none" }),

    execute: async (id, script) => {
      const tab = get().tabs.find((t) => t.id === id);
      if (!tab || tab.status !== "ready" || script.text.trim() === "") return;
      // The checks below await the backend and dialogs while the tab is still
      // "ready": a second Execute meanwhile must not start another run.
      if (starting.has(id)) return;
      starting.add(id);
      let prepared: Prepared | null;
      try {
        const pending = prepareExecution(tab, script);
        prepared = pending instanceof Promise ? await pending : pending;
        // Executing from here on, before another Execute can see "ready".
        if (prepared) patch(id, { status: "executing", longRunning: false, error: null });
      } finally {
        starting.delete(id);
      }
      if (!prepared) return;
      const { allowDestructive, sqlcmdToken } = prepared;
      // A quick Execution replaces the last output in one step, with its
      // grids' first rows already read: nothing in between is drawn. Past
      // LONG_RUN_MS the UI shows it running and its output streams in.
      // Executing blocks a second run from the start.
      const startedAt = Date.now();
      // The output gathered while the last one stays on screen; null once shown.
      let staged: Partial<QueryTab> | null = { messages: [], hasErrors: false, resultSets: [], plans: [] };
      const output = (update: (t: QueryTab) => Partial<QueryTab>) => {
        if (!staged) return patch(id, update);
        const current = get().tabs.find((t) => t.id === id);
        if (current) staged = { ...staged, ...update({ ...current, ...staged }) };
      };
      const show = () => {
        if (!staged) return;
        const shown = staged;
        staged = null;
        // The outcome and time stay until this run's own replace them.
        patch(id, (t) => ({ ...shown, runId: t.runId + 1, startedAt }));
      };
      const longRun = setTimeout(() => {
        const finished = staged?.outcome != null;
        show();
        if (!finished) {
          patch(id, (t) => (t.status === "executing" ? { longRunning: true, outcome: null, elapsedMs: null } : {}));
        }
      }, LONG_RUN_MS);

      // Messages and row counts are added about once a frame, not one copy of
      // the list per line: ten thousand PRINTs would copy it ten thousand times.
      // A timer, not requestAnimationFrame: that one stops in a hidden window.
      let queued: MessageLine[] = [];
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      const flushMessages = () => {
        if (flushTimer !== null) clearTimeout(flushTimer);
        flushTimer = null;
        if (queued.length === 0) return;
        const lines = queued;
        queued = [];
        output((t) => ({
          messages: [...t.messages, ...lines],
          hasErrors: t.hasErrors === true || lines.some((line) => line.isError),
        }));
      };
      const queueMessage = (line: MessageLine) => {
        queued.push(line);
        if (flushTimer === null) {
          const shownLines = staged ? (staged.messages?.length ?? 0) : (get().tabs.find((t) => t.id === id)?.messages.length ?? 0);
          flushTimer = setTimeout(flushMessages, shownLines > MESSAGE_FLUSH_SLOW_AFTER ? MESSAGE_FLUSH_SLOW_MS : MESSAGE_FLUSH_MS);
        }
      };
      const rowsAffected = (count: number): MessageLine => ({
        text: `(${count} row${count === 1 ? "" : "s"} affected)`,
        isError: false,
      });

      const channel = new Channel<ExecutionEvent>();
      channel.onmessage = (event) => {
        // Everything else lands after the lines that came before it.
        if (event.type !== "message" && event.type !== "rowsAffected" && event.type !== "messages") flushMessages();
        switch (event.type) {
          case "sessionClosed":
            patch(id,{status:"disconnected",error:event.reason,openTransactions:0});
            break;
          case "sessionChanged":
            patch(id, (current) => ({server: event.server, database: event.server.database,
              connectionName: event.connectionName ?? event.server.serverName, login: event.server.login ?? null,
              sessionRevision: current.sessionRevision + 1, environment: "production", metadataAvailable: !!event.connectionId,
              ...(event.connectionId ? {connectionId: event.connectionId} : {})}));
            break;
          case "plan":
            output((t) => ({ plans: [...(t.plans ?? []), event.xml], view: "plans" }));
            break;
          case "message":
            queueMessage(event);
            break;
          case "rowsAffected":
            queueMessage(rowsAffected(event.count));
            break;
          case "messages":
            for (const item of event.items) queueMessage(item.type === "message" ? item : rowsAffected(item.count));
            break;
          case "resultSetStarted":
            output((t) => ({
              resultSets: [
                ...t.resultSets,
                {
                  index: event.index,
                  columns: event.columns.map((c) => c.name),
                  kinds: event.columns.map((c) => c.kind),
                  rows: 0,
                  done: false,
                },
              ],
              view: "results",
            }));
            break;
          case "resultSetRows":
          case "resultSetFinished": {
            const done = event.type === "resultSetFinished";
            output((t) => ({
              resultSets: t.resultSets.map((r) => (r.index === event.index ? { ...r, rows: event.rows, done } : r)),
            }));
            break;
          }
          case "finished":
            if(event.outcome==="succeeded" && (tab.sqlcmdMode || /^\s*(CREATE|ALTER|DROP)\b/im.test(script.text))) invalidateCatalog();
            output((t) => ({
              outcome: event.outcome,
              elapsedMs: event.elapsedMs,
              database: event.database,
              openTransactions: event.openTransactions,
              messages:
                t.messages.length === 0 && event.outcome === "succeeded"
                  ? [{ text: "Commands completed successfully.", isError: false }]
                  : t.messages,
              // Errors are easy to miss behind a grid or a plan: show them, like SSMS.
              view: event.outcome === "failed" ? "messages"
                : (t.plans?.length ?? 0) > 0 ? "plans"
                : event.outcome === "succeeded" && t.resultSets.length > 0 ? "results" : "messages",
            }));
            break;
          case "batchStarted":
            break;
        }
      };
      try {
        if (sqlcmdToken) await api.sqlcmdExecute(id, sqlcmdToken, allowDestructive, executeOptions(), channel);
        else await api.executeQuery(id, script.text, script.baseLine, { ...executeOptions(), planMode: tab.planMode ?? "none" }, allowDestructive, channel);
      } catch (error) {
        flushMessages();
        output((t) => ({
          messages: [...t.messages, { text: errorMessage(error), isError: true }],
          hasErrors: true,
          outcome: "failed",
          elapsedMs: Date.now() - startedAt,
          view: "messages",
        }));
      } finally {
        clearTimeout(longRun);
        flushMessages();
        if (staged) await readFirstBlocks(id, staged.resultSets ?? []);
        show();
        patch(id, (t) => ({ status: t.status === "executing" ? "ready" : t.status, longRunning: false }));
      }
    },

    cancel: async (id) => {
      await api.cancelQuery(id);
    },

    useDatabase: async (id, database) => {
      // Not while an Execution runs, even before it shows itself running.
      if (get().tabs.find((t) => t.id === id)?.status !== "ready") return;
      try {
        const current = await api.useDatabase(id, database);
        patch(id, { database: current });
      } catch (error) {
        toast.error("Could not switch database", { description: errorMessage(error) });
      }
    },

    closeSafely: async (id, canClose = () => true) => {
      const tab = get().tabs.find((t) => t.id === id);
      if (!tab) return true;
      if (tab.openTransactions > 0) {
        const choice = await useDialogs.getState().confirmTransactions([tab]);
        if (choice === "cancel" || !(await endTransactions([tab], choice === "commit"))) return false;
      }
      if (!canClose()) return false;
      await get().close(id);
      return true;
    },

    settleAllTransactions: async () => {
      const open = get().tabs.filter((t) => t.openTransactions > 0);
      if (open.length === 0) return true;
      const choice = await useDialogs.getState().confirmTransactions(open);
      return choice !== "cancel" && endTransactions(open, choice === "commit");
    },
  };
});
