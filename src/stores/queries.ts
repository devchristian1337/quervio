// Query Tabs: each owns one Session on the Rust side (src-tauri/src/query.rs).
// The script text lives in the tab's Monaco model, not here.
import { Channel } from "@tauri-apps/api/core";
import { create } from "zustand";
import { api, errorMessage, type ServerInfo } from "@/lib/api";
import type { ExecutionEvent, Outcome } from "@/lib/execution";

export interface MessageLine {
  text: string;
  isError: boolean;
  header?: string | null;
  line?: number | null;
}

export interface ResultSetSummary {
  index: number;
  columns: string[];
  rows: number | null;
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
  startedAt: number | null;
  elapsedMs: number | null;
  view: "results" | "messages";
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
  open: (connectionId: string, database?: string | null) => Promise<void>;
  close: (id: string) => Promise<void>;
  activate: (id: string) => void;
  setView: (id: string, view: QueryTab["view"]) => void;
  execute: (id: string, script: Script) => Promise<void>;
  cancel: (id: string) => Promise<void>;
}

let counter = 0;

export const useQueries = create<QueriesState>((set, get) => {
  const patch = (id: string, change: Partial<QueryTab> | ((tab: QueryTab) => Partial<QueryTab>)) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...(typeof change === "function" ? change(t) : change) } : t)),
    }));

  return {
    tabs: [],
    activeId: null,

    open: async (connectionId, database = null) => {
      counter += 1;
      const id = crypto.randomUUID();
      const tab: QueryTab = {
        id,
        title: `Query ${counter}`,
        connectionId,
        status: "connecting",
        error: null,
        server: null,
        database,
        openTransactions: 0,
        messages: [],
        resultSets: [],
        outcome: null,
        startedAt: null,
        elapsedMs: null,
        view: "messages",
      };
      set((s) => ({ tabs: [...s.tabs, tab], activeId: id }));
      try {
        const server = await api.openQuery(id, connectionId, database);
        patch(id, { status: "ready", server, database: server.database });
      } catch (error) {
        patch(id, { status: "disconnected", error: errorMessage(error) });
      }
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
      patch(id, {
        status: "executing",
        messages: [],
        resultSets: [],
        outcome: null,
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
              resultSets: [...t.resultSets, { index: event.index, columns: event.columns.map((c) => c.name), rows: null }],
              view: "results",
            }));
            break;
          case "resultSetFinished":
            patch(id, (t) => ({
              resultSets: t.resultSets.map((r) => (r.index === event.index ? { ...r, rows: event.rows } : r)),
            }));
            break;
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
  };
});
