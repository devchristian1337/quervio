// Runs the commands of src/lib/commands.ts from their shortcuts, anywhere in
// the app. It listens in the capture phase, before Monaco and the grid, so a
// shortcut the user set wins over theirs. Monaco keeps its own editing keys
// (Ctrl+K Ctrl+C to comment, Ctrl+K Ctrl+F to format the selection, …).
import { useEffect } from "react";
import { commandFor, shortcutOf, type CommandId } from "@/lib/commands";
import { currentScript, findInEditor, formatInEditor, hasSelection } from "@/lib/editor";
import { closeTab, openFile, saveTab } from "@/lib/files";
import { useExplorer } from "@/stores/explorer";
import { useQueries } from "@/stores/queries";
import { useSettingsDialog } from "@/stores/dialogs";

/** New Query on the Object Explorer selection, else on the active tab's server. */
export function openQueryFromContext() {
  const context = useExplorer.getState().context;
  if (context) {
    void useQueries.getState().open(context.connectionId, context.database);
    return;
  }
  const { tabs, activeId, open } = useQueries.getState();
  const active = tabs.find((t) => t.id === activeId);
  if (active) void open(active.connectionId, active.database);
}

export function runCommand(id: CommandId) {
  const { activeId, execute, cancel, toggleResults, cycle } = useQueries.getState();
  switch (id) {
    case "execute": {
      const script = currentScript();
      if (activeId && script) void execute(activeId, script);
      break;
    }
    case "cancel":
      if (activeId) void cancel(activeId);
      break;
    case "newQuery":
      openQueryFromContext();
      break;
    case "toggleResults":
      toggleResults();
      break;
    case "openFile":
      void openFile();
      break;
    case "save":
    case "saveAs":
      if (activeId) void saveTab(activeId, id === "saveAs");
      break;
    case "closeTab":
      if (activeId) void closeTab(activeId);
      break;
    case "nextTab":
    case "previousTab":
      cycle(id === "nextTab" ? 1 : -1);
      break;
    case "format":
      formatInEditor(hasSelection());
      break;
    case "settings":
      useSettingsDialog.getState().show();
      break;
  }
}

/** Set while Settings records a new shortcut, so the keys go to it instead. */
let paused = false;
export function pauseShortcuts(pause: boolean) {
  paused = pause;
}

export function useGlobalShortcuts() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (paused) return;
      const shortcut = shortcutOf(event);
      if (!shortcut) return;
      // F5 and Ctrl+R are never page reloads, bound or not.
      const reload = shortcut === "F5" || shortcut === "Ctrl+R" || shortcut === "Ctrl+Shift+R";
      const command = commandFor(shortcut);
      // F5 in the Object Explorer refreshes it, unless F5 runs something else.
      const inExplorer = (event.target as Element | null)?.closest?.("[data-explorer]");
      if (command && !(inExplorer && shortcut === "F5" && command === "execute")) {
        event.preventDefault();
        event.stopPropagation();
        runCommand(command);
      } else if (shortcut === "Ctrl+F") {
        // WebView2 otherwise opens its native page-search bar when the
        // editor does not have focus. Search the active Query Tab instead.
        event.preventDefault();
        event.stopPropagation();
        // A modal keeps focus until it is closed.
        if (!(event.target as Element | null)?.closest?.('[role="dialog"]')) findInEditor();
      } else if (reload) {
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, []);
}
