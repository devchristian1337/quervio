// Query Tabs: each owns one Session on the Rust side (src-tauri/src/query.rs).
// The script text lives in the tab's Monaco model, not here.
import { Channel } from "@tauri-apps/api/core";
import { create } from "zustand";
import { toast } from "@/components/ui/basic-toast";
import { api, displayName, errorMessage, type Environment, type SavedConnection, type ServerInfo } from "@/lib/api";
import { useConnections } from "@/stores/connections";
import { useDialogs } from "@/stores/dialogs";
import { executeOptions, useSettings } from "@/stores/settings";
import type { ColumnKind, ExecutionEvent, Outcome } from "@/lib/execution";
import { useSqlcmdConfirmation } from "@/stores/sqlcmd";
import {invalidateCatalog} from "@/lib/metadata-events";

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
  /** The Environment of the Saved Connection when the Session was opened. */
  environment: Environment | null;
  status: TabStatus;
  error: string | null;
  server: ServerInfo | null;
  database: string | null;
  openTransactions: number;
  messages: MessageLine[];
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
  markSaved: (id: string, filePath: string) => void;
  close: (id: string) => Promise<void>;
  activate: (id: string) => void;
  setView: (id: string, view: QueryTab["view"]) => void;
  setPlanMode: (id: string, mode: NonNullable<QueryTab["planMode"]>) => void;
  setSqlcmdMode: (id: string, mode: boolean) => void;
  execute: (id: string, script: Script) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  useDatabase: (id: string, database: string) => Promise<void>;
  /** Closes the tab, first asking what to do with open transactions. */
  closeSafely: (id: string) => Promise<boolean>;
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

    markSaved: (id, filePath) => patch(id, { filePath, dirty: false, title: fileName(filePath) }),

    open: async (connectionId, database = null, options = {}) => {
      // Restored "Query 7" keeps new tabs numbering after it.
      const number = /^Query (\d+)$/.exec(options.title ?? "");
      counter = number ? Math.max(counter, Number(number[1])) : counter + 1;
      const id = crypto.randomUUID();
      const text = options.text ?? "";
      const tab: QueryTab = {
        id,
        title: options.title ?? (options.filePath ? fileName(options.filePath) : `Query ${counter}`),
        connectionId,
        environment: useConnections.getState().connections.find((c) => c.id === connectionId)?.environment ?? null,
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
        patch(id, { status: "ready", server, database: server.database });
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
      await api.closeQuery(id);
    },

    activate: (id) => set({ activeId: id }),

    setView: (id, view) => patch(id, { view }),
    setPlanMode: (id, planMode) => patch(id, { planMode }),
    setSqlcmdMode: (id, sqlcmdMode) => patch(id, { sqlcmdMode, planMode: "none" }),

    execute: async (id, script) => {
      const tab = get().tabs.find((t) => t.id === id);
      if (!tab || tab.status !== "ready" || script.text.trim() === "") return;

      // On Production, Destructive Statements need an explicit go-ahead.
      // The Session checks it again on its own side unless allowed here.
      const connections = useConnections.getState().connections;
      const confirm = useSettings.getState().settings.query.confirmDestructive;
      let allowDestructive = !confirm;
      let sqlcmdToken: string | null = null;
      if (tab.sqlcmdMode) {
        try {
          const preview = await api.sqlcmdPrepare(id, script.text, tab.filePath, script.baseLine);
          if (!await useSqlcmdConfirmation.getState().ask(preview.script, preview.hasLocalCommands)) return;
          sqlcmdToken = preview.token;
        } catch (error) {toast.error("SQLCMD preparation failed", {description: errorMessage(error)});return;}
      }
      if (!tab.sqlcmdMode && tab.planMode !== "estimated" && confirm && tabEnvironment(tab, connections) === "production") {
        const check = await api.checkScript(script.text, script.baseLine);
        if (check.findings.length > 0 || check.uncertain) {
          const connection = connections.find((c) => c.id === tab.connectionId);
          const run = await useDialogs.getState().confirmDestructive({
            tabTitle: tab.title,
            connectionName: connection ? displayName(connection) : (tab.server?.serverName ?? tab.title),
            check,
          });
          if (!run) return;
          allowDestructive = true;
        }
      }
      // A quick Execution goes straight from the last output to its own: that
      // stays until this one sends something or runs past LONG_RUN_MS, and
      // only then does the UI show it running. Executing blocks a second run
      // from the start.
      const startedAt = Date.now();
      let replaced = false;
      const replaceOutput = () => {
        if (replaced) return;
        replaced = true;
        // The outcome and time stay until this run's own replace them.
        patch(id, (t) => ({ messages: [], resultSets: [], plans: [], runId: t.runId + 1, startedAt }));
      };
      patch(id, { status: "executing", longRunning: false, error: null });
      const longRun = setTimeout(() => {
        replaceOutput();
        patch(id, (t) => (t.status === "executing" ? { longRunning: true, outcome: null, elapsedMs: null } : {}));
      }, LONG_RUN_MS);

      const channel = new Channel<ExecutionEvent>();
      channel.onmessage = (event) => {
        if (event.type !== "batchStarted" && event.type !== "sessionChanged") replaceOutput();
        switch (event.type) {
          case "sessionClosed":
            patch(id,{status:"disconnected",error:event.reason,openTransactions:0});
            break;
          case "sessionChanged":
            patch(id, {server: event.server, database: event.server.database, environment: "production", metadataAvailable: !!event.connectionId, ...(event.connectionId ? {connectionId: event.connectionId} : {})});
            break;
          case "plan":
            patch(id, (t) => ({ plans: [...(t.plans ?? []), event.xml], view: "plans" }));
            break;
          case "message":
            patch(id, (t) => ({ messages: [...t.messages, event] }));
            break;
          case "rowsAffected":
            patch(id, (t) => ({
              messages: [
                ...t.messages,
                { text: `(${event.count} row${event.count === 1 ? "" : "s"} affected)`, isError: false },
              ],
            }));
            break;
          case "resultSetStarted":
            patch(id, (t) => ({
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
            patch(id, (t) => ({
              resultSets: t.resultSets.map((r) => (r.index === event.index ? { ...r, rows: event.rows, done } : r)),
            }));
            break;
          }
          case "finished":
            if(event.outcome==="succeeded" && (tab.sqlcmdMode || /^\s*(CREATE|ALTER|DROP)\b/im.test(script.text))) invalidateCatalog();
            patch(id, (t) => ({
              outcome: event.outcome,
              elapsedMs: event.elapsedMs,
              database: event.database,
              openTransactions: event.openTransactions,
              messages:
                t.messages.length === 0 && event.outcome === "succeeded"
                  ? [{ text: "Commands completed successfully.", isError: false }]
                  : t.messages,
              // Errors are easy to miss behind a grid: show them, like SSMS.
              view: (t.plans?.length ?? 0)>0 ? "plans" : event.outcome === "succeeded" && t.resultSets.length > 0 ? "results" : "messages",
            }));
            break;
          case "batchStarted":
            break;
        }
      };

      try {
        if (sqlcmdToken) await api.sqlcmdExecute(id, sqlcmdToken, executeOptions(), channel);
        else await api.executeQuery(id, script.text, script.baseLine, { ...executeOptions(), planMode: tab.planMode ?? "none" }, allowDestructive, channel);
      } catch (error) {
        replaceOutput();
        patch(id, (t) => ({
          messages: [...t.messages, { text: errorMessage(error), isError: true }],
          outcome: "failed",
          elapsedMs: Date.now() - startedAt,
          view: "messages",
        }));
      } finally {
        clearTimeout(longRun);
        replaceOutput();
        patch(id, (t) => ({ status: t.status === "executing" ? "ready" : t.status, longRunning: false }));
      }
    },

    cancel: async (id) => {
      await api.cancelQuery(id);
    },

    useDatabase: async (id, database) => {
      try {
        const current = await api.useDatabase(id, database);
        patch(id, { database: current });
      } catch (error) {
        toast.error("Could not switch database", { description: errorMessage(error) });
      }
    },

    closeSafely: async (id) => {
      const tab = get().tabs.find((t) => t.id === id);
      if (!tab) return true;
      if (tab.openTransactions > 0) {
        const choice = await useDialogs.getState().confirmTransactions([tab]);
        if (choice === "cancel" || !(await endTransactions([tab], choice === "commit"))) return false;
      }
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
