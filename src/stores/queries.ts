// Query Tabs: each owns one Session on the Rust side (src-tauri/src/query.rs).
// The script text lives in the tab's Monaco model, not here.
import { Channel } from "@tauri-apps/api/core";
import { create } from "zustand";
import { toast } from "sonner";
import { api, displayName, errorMessage, type ServerInfo } from "@/lib/api";
import { useConnections } from "@/stores/connections";
import { useDialogs } from "@/stores/dialogs";
import type { ColumnKind, ExecutionEvent, Outcome } from "@/lib/execution";

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
  status: TabStatus;
  error: string | null;
  server: ServerInfo | null;
  database: string | null;
  openTransactions: number;
  messages: MessageLine[];
  resultSets: ResultSetSummary[];
  outcome: Outcome | null;
  /** Bumped on every Execution so grids drop rows cached from the last one. */
  runId: number;
  startedAt: number | null;
  elapsedMs: number | null;
  view: "results" | "messages";
  /** Text the tab's editor starts with (restored, opened from a file or scripted). */
  initialText: string;
  /** The .sql file the tab was opened from or saved to. */
  filePath: string | null;
  /** Edited since it was opened or last saved. */
  dirty: boolean;
}

export interface OpenOptions {
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
  execute: (id: string, script: Script) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  useDatabase: (id: string, database: string) => Promise<void>;
  /** Closes the tab, first asking what to do with open transactions. */
  closeSafely: (id: string) => Promise<boolean>;
  /** Ends open transactions in every tab, asking once; false if the user cancels. */
  settleAllTransactions: () => Promise<boolean>;
}

let counter = 0;

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
        status: "connecting",
        error: null,
        server: null,
        database,
        openTransactions: 0,
        messages: [],
        resultSets: [],
        outcome: null,
        runId: 0,
        startedAt: null,
        elapsedMs: null,
        view: "messages",
        initialText: text,
        filePath: options.filePath ?? null,
        dirty: options.dirty ?? false,
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

    execute: async (id, script) => {
      const tab = get().tabs.find((t) => t.id === id);
      if (!tab || tab.status !== "ready" || script.text.trim() === "") return;

      // On Production, Destructive Statements need an explicit go-ahead.
      const connection = useConnections.getState().connections.find((c) => c.id === tab.connectionId);
      if (connection?.environment === "production") {
        const check = await api.checkScript(script.text, script.baseLine);
        if (check.findings.length > 0 || check.uncertain) {
          const run = await useDialogs.getState().confirmDestructive({
            tabTitle: tab.title,
            connectionName: displayName(connection),
            check,
          });
          if (!run) return;
        }
      }
      patch(id, {
        status: "executing",
        messages: [],
        resultSets: [],
        outcome: null,
        runId: tab.runId + 1,
        startedAt: Date.now(),
        elapsedMs: null,
        error: null,
      });

      const channel = new Channel<ExecutionEvent>();
      channel.onmessage = (event) => {
        switch (event.type) {
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
              view: event.outcome === "succeeded" && t.resultSets.length > 0 ? "results" : "messages",
            }));
            break;
          case "batchStarted":
            break;
        }
      };

      try {
        await api.executeQuery(id, script.text, script.baseLine, channel);
      } catch (error) {
        patch(id, (t) => ({
          messages: [...t.messages, { text: errorMessage(error), isError: true }],
          outcome: "failed",
          view: "messages",
        }));
      } finally {
        patch(id, (t) => ({ status: t.status === "executing" ? "ready" : t.status }));
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
