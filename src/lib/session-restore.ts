// Reopening the Query Tabs of the last run, unsaved text included, like VS
// Code. The snapshot is a file Rust writes in the app's data folder: the
// webview's localStorage commits lazily and loses writes when the window
// closes right after them.
import { api } from "@/lib/api";
import { modelText } from "@/lib/editor";
import { useConnections } from "@/stores/connections";
import { useQueries } from "@/stores/queries";

interface SavedTab {
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
    })),
    active: Math.max(0, tabs.findIndex((t) => t.id === activeId)),
  };
}

let timer: number | undefined;
let restored = false;

/** Saves the open tabs soon; called on every edit and tab change. */
export function scheduleSave() {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void saveNow(), 500);
}

/** Saves the open tabs now; awaited before the window closes. */
export async function saveNow() {
  window.clearTimeout(timer);
  // Before the restore, an empty store would overwrite last run's tabs.
  if (!restored) return;
  try {
    await api.tabsSave(JSON.stringify(snapshot()));
  } catch {
    // Restoring is best effort; a failed save must not block closing.
  }
}

/** Reopens last run's tabs once the Saved Connections are loaded. */
export async function restoreTabs() {
  if (restored) return;
  let saved: SavedSession | null = null;
  try {
    const text = await api.tabsLoad();
    saved = text ? JSON.parse(text) : null;
  } catch {
    saved = null;
  }
  restored = true;
  if (!saved?.tabs?.length) return;
  const known = new Set(useConnections.getState().connections.map((c) => c.id));
  const active = saved.active;
  const tabs = saved.tabs.filter((t) => known.has(t.connectionId));
  const { open } = useQueries.getState();
  // Opened in order so they keep their places; each connects on its own.
  await Promise.allSettled(
    tabs.map((tab, index) =>
      open(tab.connectionId, tab.database, {
        title: tab.title,
        text: tab.text,
        filePath: tab.filePath,
        dirty: tab.dirty,
        activate: index === active,
      }),
    ),
  );
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
        t.dirty !== previous.tabs[i]?.dirty,
    )
  ) {
    scheduleSave();
  }
});
