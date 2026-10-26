// App-wide SSMS shortcuts. Monaco handles them itself while it has focus;
// this listener covers the rest of the window.
import { useEffect } from "react";
import { currentScript } from "@/lib/editor";
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
      const { activeId, execute, cancel } = useQueries.getState();
      if (key === "f5" || (event.ctrlKey && key === "e")) {
        const script = currentScript();
        if (activeId && script) void execute(activeId, script);
      } else if (event.altKey && key === "pause") {
        if (activeId) void cancel(activeId);
      } else if (event.ctrlKey && key === "n") {
        openQueryFromContext();
      } else if (!reload) {
        return;
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
