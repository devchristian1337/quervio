import { useEffect } from "react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ObjectExplorer } from "@/components/ObjectExplorer";

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

// F5 and Ctrl+R are SSMS shortcuts (Refresh, toggle Results), not page reloads.
function useNoReloadKeys() {
  useEffect(() => {
    const block = (event: KeyboardEvent) => {
      if (event.key === "F5" || (event.ctrlKey && event.key.toLowerCase() === "r")) {
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", block);
    return () => window.removeEventListener("keydown", block);
  }, []);
}

export default function App() {
  useSystemTheme();
  useNoReloadKeys();

  return (
    <ResizablePanelGroup orientation="horizontal" className="text-sm">
      <ResizablePanel defaultSize="22%" minSize={200}>
        <ObjectExplorer />
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel>
        <ResizablePanelGroup orientation="vertical">
          <ResizablePanel defaultSize="60%" minSize={120}>
            <section className="h-full bg-background/70 p-3 text-muted-foreground">
              Query Tabs
            </section>
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel minSize={80}>
            <section className="h-full bg-background/70 p-3 text-muted-foreground">
              Results / Messages
            </section>
          </ResizablePanel>
        </ResizablePanelGroup>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
