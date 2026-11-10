// Opening and saving .sql files (Ctrl+O, Ctrl+S, Ctrl+Shift+S).
import { open, save } from "@tauri-apps/plugin-dialog";
import { toast } from "@/components/ui/basic-toast";
import { api, errorMessage } from "@/lib/api";
import { disposeModel, modelText } from "@/lib/editor";
import { useDialogs } from "@/stores/dialogs";
import { useExplorer } from "@/stores/explorer";
import { fileName, useQueries } from "@/stores/queries";

const FILTERS = [
  { name: "SQL scripts", extensions: ["sql"] },
  { name: "All files", extensions: ["*"] },
];

// Keep Save/Save As requests in order, including their dialogs. Different tabs
// can share a file, so writes to that destination also have their own queue.
const saves = new Map<string, Promise<unknown>>();
const writes = new Map<string, Promise<unknown>>();

function inOrder<T>(queue: Map<string, Promise<unknown>>, key: string, action: () => Promise<T>): Promise<T> {
  const previous = queue.get(key) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(action).finally(() => {
    if (queue.get(key) === pending) queue.delete(key);
  });
  queue.set(key, pending);
  return pending;
}

/**
 * Opens a .sql file in a new tab on `target` (a start screen row), else on the
 * selected server, or the active tab's.
 */
export async function openFile(target?: { connectionId: string; database: string | null }) {
  const { tabs, activeId } = useQueries.getState();
  const active = tabs.find((t) => t.id === activeId);
  const context = target ?? useExplorer.getState().context;
  const connectionId = context?.connectionId ?? active?.connectionId;
  if (!connectionId) {
    toast.error("Select a server first", {
      description: "A script opens on the server selected in the Object Explorer.",
    });
    return;
  }
  const path = await open({ multiple: false, filters: FILTERS });
  if (typeof path !== "string") return;
  try {
    const text = await api.fileRead(path);
    const database = context?.connectionId === connectionId ? context.database : (active?.database ?? null);
    await useQueries.getState().open(connectionId, database, { text, filePath: path });
  } catch (error) {
    toast.error(`Could not open ${fileName(path)}`, { description: errorMessage(error) });
  }
}

/** Saves a tab to its file, asking for one when it has none or `saveAs`. */
export async function saveTab(id: string, saveAs = false): Promise<boolean> {
  const tab = useQueries.getState().tabs.find((t) => t.id === id);
  if (!tab) return false;
  // Capture the text requested by this Save, not a later edit made while a
  // preceding save or the file dialog is still pending.
  const text = modelText(id) ?? tab.initialText;
  return inOrder(saves, id, async () => {
    const current = useQueries.getState().tabs.find((t) => t.id === id);
    if (!current) return false;
    let path = saveAs ? null : current.filePath;
    try {
      if (!path) {
        path = await save({ defaultPath: current.filePath ?? `${current.title}.sql`, filters: FILTERS });
        if (!path) return false;
      }
      const destination = path;
      // Windows paths are case-insensitive; keep Unix paths case-sensitive.
      const key = /^(?:[a-z]:[\\/]|\\\\)/i.test(destination)
        ? destination.replace(/\\/g, "/").toLowerCase() : destination;
      await inOrder(writes, key, () => api.fileWrite(destination, text));
      const latest = useQueries.getState().tabs.find((t) => t.id === id);
      if (latest) {
        const dirty = (modelText(id) ?? latest.initialText) !== text;
        useQueries.getState().markSaved(id, destination, dirty);
      }
      toast.success(`Saved ${fileName(destination)}`);
      return true;
    } catch (error) {
      toast.error(`Could not save ${fileName(path ?? current.title)}`, { description: errorMessage(error) });
      return false;
    }
  });
}

/**
 * Closes a tab like SSMS: offers to save a modified script, then to end
 * open transactions. False when the user cancels.
 */
export async function closeTab(id: string): Promise<boolean> {
  const tab = useQueries.getState().tabs.find((t) => t.id === id);
  if (!tab) return true;
  const text = modelText(id) ?? tab.initialText;
  let acceptedText = text;
  const keepOpen = () => {
    toast.info("Tab kept open", { description: "The script has changes that were not saved. Save again to close it." });
    return false;
  };
  if (tab.dirty && (tab.filePath || text.trim() !== "")) {
    const choice = await useDialogs.getState().confirmUnsaved(tab.title);
    if (choice === "cancel" || (choice === "save" && !(await saveTab(id)))) return false;
    const current = useQueries.getState().tabs.find((t) => t.id === id);
    if (choice === "save" && current?.dirty) return keepOpen();
    acceptedText = modelText(id) ?? current?.initialText ?? text;
  }
  // A transaction prompt can also take time: check immediately before the
  // store removes the tab, not only before asking about transactions.
  if (!(await useQueries.getState().closeSafely(id, () => {
    const current = useQueries.getState().tabs.find((t) => t.id === id);
    return !current || (modelText(id) ?? current.initialText) === acceptedText || keepOpen();
  }))) return false;
  disposeModel(id);
  return true;
}
