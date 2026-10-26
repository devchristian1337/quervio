// Opening and saving .sql files (Ctrl+O, Ctrl+S, Ctrl+Shift+S).
import { open, save } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import { disposeModel, modelText } from "@/lib/editor";
import { useDialogs } from "@/stores/dialogs";
import { useExplorer } from "@/stores/explorer";
import { fileName, useQueries } from "@/stores/queries";

const FILTERS = [
  { name: "SQL scripts", extensions: ["sql"] },
  { name: "All files", extensions: ["*"] },
];

/** Opens a .sql file in a new tab on the selected server, or the active tab's. */
export async function openFile() {
  const { tabs, activeId } = useQueries.getState();
  const active = tabs.find((t) => t.id === activeId);
  const context = useExplorer.getState().context;
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
  let path = saveAs ? null : tab.filePath;
  if (!path) {
    path = await save({ defaultPath: tab.filePath ?? `${tab.title}.sql`, filters: FILTERS });
    if (!path) return false;
  }
  try {
    await api.fileWrite(path, modelText(id) ?? tab.initialText);
    useQueries.getState().markSaved(id, path);
    toast.success(`Saved ${fileName(path)}`);
    return true;
  } catch (error) {
    toast.error(`Could not save ${fileName(path)}`, { description: errorMessage(error) });
    return false;
  }
}

/**
 * Closes a tab like SSMS: offers to save a modified script, then to end
 * open transactions. False when the user cancels.
 */
export async function closeTab(id: string): Promise<boolean> {
  const tab = useQueries.getState().tabs.find((t) => t.id === id);
  if (!tab) return true;
  const text = modelText(id) ?? tab.initialText;
  if (tab.dirty && (tab.filePath || text.trim() !== "")) {
    const choice = await useDialogs.getState().confirmUnsaved(tab.title);
    if (choice === "cancel" || (choice === "save" && !(await saveTab(id)))) return false;
  }
  if (!(await useQueries.getState().closeSafely(id))) return false;
  disposeModel(id);
  return true;
}
