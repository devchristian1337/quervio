import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { loadSettings } from "./stores/settings";

// Run in a plain browser with fake Rust commands: http://localhost:1420/?mock
if (import.meta.env.DEV && new URLSearchParams(location.search).has("mock")) {
  await import("./dev/mock-tauri");
}

// Before the first render, so the chosen theme shows from the start.
await loadSettings();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
