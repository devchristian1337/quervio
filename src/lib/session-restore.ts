// Reopening the Query Tabs of the last run, unsaved text included, like VS
// Code. The snapshot is a file Rust writes in the app's data folder: the
// webview's localStorage commits lazily and loses writes when the window
// closes right after them.
import { api } from "@/lib/api";
import { modelText } from "@/lib/editor";
import { useConnections } from "@/stores/connections";
import { useQueries } from "@/stores/queries";
import { toast } from "@/components/ui/basic-toast";

interface SavedTab {
  sqlcmdMode?: boolean;
  planMode?: "none" | "estimated" | "actual";
  title: string;
  connectionId: string;
  database: string | null;
  filePath: string | null;
  dirty: boolean;
  text: string;
}

interface SavedSession {
  tabs: SavedTab[];
  active: number;
}

function snapshot(): SavedSession {
  const { tabs, activeId } = useQueries.getState();
  return {
    tabs: tabs.map((tab) => ({
      title: tab.title,
      connectionId: tab.connectionId,
      database: tab.database,
      filePath: tab.filePath,
      dirty: tab.dirty,
      text: modelText(tab.id) ?? tab.initialText,
      sqlcmdMode: tab.sqlcmdMode ?? false,
      planMode: tab.planMode ?? "none",
    })),
    active: Math.max(0, tabs.findIndex((t) => t.id === activeId)),
  };
}

let timer: number | undefined;
let restored = false;
let restoreFailed = false;
let restoring: Promise<void> | undefined;
let pendingSave = Promise.resolve(true);
let saveFailed = false;

/** Saves the open tabs soon; called on every edit and tab change. */
export function scheduleSave() {
  if (!restored) return;
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void saveNow(), 500);
}

/** Saves the open tabs now; awaited before the window closes. */
export async function saveNow(): Promise<boolean> {
  window.clearTimeout(timer);
  if (restoring) await restoring;
  // Before the restore, an empty store would overwrite last run's tabs.
  if (!restored) return !restoreFailed;
  const text = JSON.stringify(snapshot());
  // Autosave and closing may overlap. Keep their snapshots in request order.
  pendingSave = pendingSave.then(async () => {
    try {
      await api.tabsSave(text);
      if (saveFailed) toast.success("Query tab recovery is available again");
      saveFailed = false;
      return true;
    } catch {
      if (!saveFailed) toast.warning("Query tabs could not be saved", {
        description: "Save your SQL files before closing. Automatic recovery is temporarily unavailable.",
        action: { label: "Retry", onClick: () => { void saveNow(); } },
      });
      saveFailed = true;
      return false;
    }
  });
  return pendingSave;
}

/** Reopens last run's tabs once the Saved Connections are loaded. */
export function restoreTabs(): Promise<void> {
  if (restored) return Promise.resolve();
  if (restoring) return restoring;
  restoring = restoreSnapshot().finally(() => { restoring = undefined; });
  return restoring;
}

async function restoreSnapshot() {
  try {
    const { snapshot: text, recovered } = await api.tabsLoad();
    // The backend validates the snapshot before returning it.
    const saved: SavedSession | null = text ? JSON.parse(text) : null;
    if (saved?.tabs.length) {
      const known = new Set(useConnections.getState().connections.map((c) => c.id));
      const missing = saved.tabs.some((tab) => !known.has(tab.connectionId));
      const { open } = useQueries.getState();
      // Opening an unknown connection keeps the SQL in a disconnected tab.
      // Never execute restored text or read the original .sql file.
      // open() adds its tab at once and then logs in. Only the tabs need to be
      // in place: autosave and closing must not wait for a slow or unreachable
      // server, and open() reports its own connection errors in the tab.
      void Promise.allSettled(saved.tabs.map((tab, index) => open(tab.connectionId, tab.database, {
        title: tab.title,
        text: tab.text,
        filePath: tab.filePath,
        dirty: tab.dirty,
        activate: index === saved.active,
        sqlcmdMode: tab.sqlcmdMode === true,
        planMode: tab.planMode === "estimated" || tab.planMode === "actual" ? tab.planMode : "none",
      })));
      if (missing) toast.warning("Some Saved Connections are unavailable", {
        description: "Their SQL has been kept in disconnected query tabs.",
      });
    }
    if (recovered) toast.warning("Query tabs recovered", {
      description: "The latest snapshot was unavailable. Your tabs were restored from the previous copy; recent edits may be missing.",
    });
    restored = true;
    restoreFailed = false;
  } catch {
    restoreFailed = true;
    toast.warning("Query tabs could not be restored", {
      description: "Recovery files have been kept. Save any new SQL to files before closing.",
      action: { label: "Retry recovery", onClick: () => { void restoreTabs(); } },
    });
  }
}

/** Keeps the snapshot current whenever tabs open, close or change database. */
useQueries.subscribe((state, previous) => {
  if (
    state.tabs.length !== previous.tabs.length ||
    state.activeId !== previous.activeId ||
    state.tabs.some(
      (t, i) =>
        t.database !== previous.tabs[i]?.database ||
        t.title !== previous.tabs[i]?.title ||
        t.filePath !== previous.tabs[i]?.filePath ||
        t.dirty !== previous.tabs[i]?.dirty ||
        t.sqlcmdMode !== previous.tabs[i]?.sqlcmdMode || t.planMode !== previous.tabs[i]?.planMode,
    )
  ) {
    scheduleSave();
  }
});
