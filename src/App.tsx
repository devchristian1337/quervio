import { useEffect } from "react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ObjectExplorer } from "@/components/ObjectExplorer";
import { QueryWorkspace } from "@/components/QueryWorkspace";
import { Toaster } from "@/components/ui/sonner";

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

export default function App() {
  useSystemTheme();

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
    <Toaster position="bottom-right" />
    </>
  );
}
