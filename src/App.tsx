import { useEffect } from "react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";

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
    <ResizablePanelGroup orientation="horizontal" className="text-sm">
      <ResizablePanel defaultSize="22%" minSize={200}>
        <section className="h-full p-3 text-muted-foreground">
          Object Explorer
        </section>
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
