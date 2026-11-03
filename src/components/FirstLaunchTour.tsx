import { useEffect } from "react";
import { Tour, useTour, type TourStep } from "@/components/ui/product-tour";
import { useConnections } from "@/stores/connections";

const STEPS: TourStep[] = [
  {
    title: "Welcome to Quervio",
    content: "A quick tour of your SQL Server workspace. Use Next and Back, or the arrow keys. You can leave at any time with Esc.",
    placement: "center",
  },
  {
    target: '[data-tour="new-connection"]',
    title: "Add your first SQL Server",
    content: "Use New connection to save a server, choose authentication and set its environment. Already using SSMS? The import button next to it brings in registered servers.",
    placement: "bottom",
  },
  {
    target: "[data-explorer]",
    title: "Explore your databases",
    content: "Expand a saved connection to browse databases, tables, views and stored procedures. Select a server or database, then use New query in the toolbar.",
  },
  {
    target: '[data-tour="query-area"]',
    title: "Write and run queries",
    content: "Each query tab keeps its own SQL session. Write a script in the editor, then use Execute to run the script or selection. Results and server messages appear below it.",
    placement: "center",
  },
  {
    target: '[data-tour="command-search"]',
    title: "Find a command quickly",
    content: "Search commands finds actions, tools, open tabs and saved connections. The button shows your current keyboard shortcut.",
    placement: "bottom",
  },
  {
    target: '[data-tour="tools"]',
    title: "Your management tools",
    content: "Open monitoring, designers, backup and restore, security and more from Tools. Available operations depend on the selected server and your permissions.",
    placement: "bottom",
  },
  {
    target: '[data-tour="settings"]',
    title: "Make Quervio your own",
    content: "Choose your theme, editor preferences and keyboard shortcuts in Settings. You're ready: close this tour and add or open a saved connection.",
    placement: "top",
  },
];

export function FirstLaunchTour() {
  const loaded = useConnections((s) => s.loaded);
  const { open, setOpen, index, setIndex, start, seen, markSeen } = useTour("quervio.tour.seen");
  useEffect(() => {
    if (!loaded || seen()) return;
    // Wait for the first layout and leave any startup modal in control.
    let timer: number;
    const begin = () => {
      if (document.querySelector('[role="dialog"]')) {
        timer = window.setTimeout(begin, 200);
      } else start();
    };
    timer = window.setTimeout(begin, 450);
    return () => window.clearTimeout(timer);
  }, [loaded, seen, start]);

  return <Tour steps={STEPS} open={open} onOpenChange={setOpen} index={index} onIndexChange={setIndex} onFinish={markSeen} onSkip={markSeen} />;
}
