import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// Run in a plain browser with fake Rust commands: http://localhost:1420/?mock
if (import.meta.env.DEV && new URLSearchParams(location.search).has("mock")) {
  await import("./dev/mock-tauri");
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
