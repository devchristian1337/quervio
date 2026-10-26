import { useEffect } from "react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ObjectExplorer } from "@/components/ObjectExplorer";
import { QueryWorkspace } from "@/components/QueryWorkspace";
import { Toaster } from "@/components/ui/sonner";
import { SafetyDialogs } from "@/components/SafetyDialogs";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useQueries } from "@/stores/queries";
import { useConnections } from "@/stores/connections";
import { restoreTabs, saveNow } from "@/lib/session-restore";

// Follow the Windows light/dark setting.
function useSystemTheme() {
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () =>
      document.documentElement.classList.toggle("dark", query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);
}

// Closing the window ends every Session: settle open transactions first.
function useCloseGuard() {
  useEffect(() => {
    // Absent in a plain browser and in the dev mock.
    if (!(window as { __TAURI_INTERNALS__?: { metadata?: unknown } }).__TAURI_INTERNALS__?.metadata) return;
    const appWindow = getCurrentWindow();
    let closing = false;
    const unlisten = appWindow.onCloseRequested(async (event) => {
      if (closing) return;
      // Held open until the tabs are saved (they come back on the next
      // start) and open transactions are settled.
      event.preventDefault();
      await saveNow();
      if (await useQueries.getState().settleAllTransactions()) {
        closing = true;
        await appWindow.destroy();
      }
    });
    return () => void unlisten.then((stop) => stop());
  }, []);
}

// Reopens last run's Query Tabs once the Saved Connections are known.
function useRestoreTabs() {
  const loaded = useConnections((s) => s.loaded);
  useEffect(() => {
    if (loaded) void restoreTabs();
  }, [loaded]);
}

export default function App() {
  useSystemTheme();
  useCloseGuard();
  useRestoreTabs();

  return (
    <>
    <ResizablePanelGroup orientation="horizontal" className="text-sm">
      <ResizablePanel defaultSize="22%" minSize={200}>
        <ObjectExplorer />
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel>
        <QueryWorkspace />
      </ResizablePanel>
    </ResizablePanelGroup>
    <SafetyDialogs />
    <Toaster position="bottom-right" />
    </>
  );
}
