import { getCurrentWindow } from "@tauri-apps/api/window";
import { findTheme, type ThemeId } from "@/lib/themes";

/**
 * Sets the window's own light or dark mode to the chosen theme's: the Mica
 * backdrop and the title bar take it, so "Light" stays light over Mica when
 * Windows is dark. "System" hands the mode back to Windows, which also keeps
 * prefers-color-scheme telling the truth for useSystemDark.
 */
export function applyWindowTheme(id: ThemeId) {
  // Absent in a plain browser and in the dev mock.
  if (!(window as { __TAURI_INTERNALS__?: { metadata?: unknown } }).__TAURI_INTERNALS__?.metadata) return;
  void getCurrentWindow()
    .setTheme(id === "system" ? null : findTheme(id, false).kind)
    .catch(() => {});
}
