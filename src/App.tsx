import { useEffect } from "react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ObjectExplorer } from "@/components/ObjectExplorer";
import { QueryWorkspace } from "@/components/QueryWorkspace";
import { Toaster } from "@/components/ui/basic-toast";
import { SafetyDialogs } from "@/components/SafetyDialogs";
import { SettingsDialog } from "@/components/SettingsDialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useQueries } from "@/stores/queries";
import { useConnections } from "@/stores/connections";
import { restoreTabs, saveNow } from "@/lib/session-restore";
import { applyTheme } from "@/lib/themes";
import { useTheme } from "@/lib/use-theme";
import { applyWindowTheme } from "@/lib/window-theme";
import { useSettings } from "@/stores/settings";

// The chosen theme, or Light/Dark following Windows.
function useAppTheme() {
  const theme = useTheme();
  const choice = useSettings((s) => s.settings.appearance.theme);
  useEffect(() => applyWindowTheme(choice), [choice]);
  useEffect(() => applyTheme(theme), [theme]);
}

// WebView2's own menu (Back, Refresh, Save as, Print…) makes no sense in
// the app. Text fields, the editor, the grid and the Object Explorer open
// their own menus. Shift+right-click keeps it in
// dev builds, for Inspect.
function useNoBrowserMenu() {
  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      if (import.meta.env.DEV && event.shiftKey) return;
      event.preventDefault();
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
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
  useAppTheme();
  useNoBrowserMenu();
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
    <SettingsDialog />
    <Toaster />
    </>
  );
}
