import { getCurrentWindow } from "@tauri-apps/api/window";
import { THEMES, type ThemeId } from "@/lib/themes";

/**
 * Sets the window's own light or dark mode to the chosen theme's: the Mica
 * backdrop and the title bar take it, so "Light" stays light over Mica when
 * Windows is dark. "System" (or a theme id no longer present) hands the mode
 * back to Windows, which also keeps prefers-color-scheme telling the truth
 * for useSystemDark.
 */
export function applyWindowTheme(id: ThemeId) {
  // Absent in a plain browser and in the dev mock.
  if (!(window as { __TAURI_INTERNALS__?: { metadata?: unknown } }).__TAURI_INTERNALS__?.metadata) return;
  const matched = id === "system" ? null : (THEMES.find((theme) => theme.id === id) ?? null);
  void getCurrentWindow()
    .setTheme(matched ? matched.kind : null)
    .catch(() => {});
}
