import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { TooltipProvider } from "./components/ui/flexnative-tooltip";
import "./index.css";
import { loadSettings, useSettings } from "./stores/settings";
import { applyTheme, findTheme } from "./lib/themes";
import { applyWindowTheme } from "./lib/window-theme";

// Run in a plain browser with fake Rust commands: http://localhost:1420/?mock
if (import.meta.env.DEV && new URLSearchParams(location.search).has("mock")) {
  await import("./dev/mock-tauri");
}

// Before the first render, so the chosen theme shows from the start.
await loadSettings();
applyWindowTheme(useSettings.getState().settings.appearance.theme);
applyTheme(
  findTheme(useSettings.getState().settings.appearance.theme, window.matchMedia("(prefers-color-scheme: dark)").matches),
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {/* A short wait, so moving across a toolbar does not flash every tip. */}
    <TooltipProvider delayDuration={400}>
      <App />
    </TooltipProvider>
  </React.StrictMode>,
);
