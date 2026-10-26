// App-wide SSMS shortcuts: F5/Ctrl+E execute, Alt+Break cancel, Ctrl+N new
// query, Ctrl+R toggle results, Ctrl+O/Ctrl+S/Ctrl+Shift+S open and save,
// Ctrl+W/Ctrl+F4 close, Ctrl+Tab switch tabs. Monaco handles its own while
// it has focus (Ctrl+K Ctrl+C/U comment and uncomment).
import { useEffect } from "react";
import { currentScript } from "@/lib/editor";
import { closeTab, openFile, saveTab } from "@/lib/files";
import { useExplorer } from "@/stores/explorer";
import { useQueries } from "@/stores/queries";

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

export function useGlobalShortcuts() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      // F5 and Ctrl+R are SSMS shortcuts, never page reloads.
      const reload = key === "f5" || (event.ctrlKey && key === "r");
      // Already handled (e.g. F5 refreshing the Object Explorer).
      if (event.defaultPrevented) {
        if (reload) event.preventDefault();
        return;
      }
      const { activeId, execute, cancel, toggleResults, cycle } = useQueries.getState();
      const ctrl = event.ctrlKey && !event.altKey;
      if (key === "f5" || (ctrl && key === "e")) {
        const script = currentScript();
        if (activeId && script) void execute(activeId, script);
      } else if (event.altKey && key === "pause") {
        if (activeId) void cancel(activeId);
      } else if (ctrl && key === "n") {
        openQueryFromContext();
      } else if (ctrl && key === "r") {
        toggleResults();
      } else if (ctrl && key === "o") {
        void openFile();
      } else if (ctrl && key === "s") {
        if (activeId) void saveTab(activeId, event.shiftKey);
      } else if ((ctrl && key === "w") || (ctrl && key === "f4")) {
        if (activeId) void closeTab(activeId);
      } else if (ctrl && key === "tab") {
        cycle(event.shiftKey ? -1 : 1);
      } else if (!reload) {
        return;
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
