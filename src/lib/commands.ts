// The commands that have keyboard shortcuts, with their SSMS defaults. The
// user can change them in Settings > Shortcuts; src/lib/shortcuts.ts runs
// them. A shortcut is written like "Ctrl+Shift+S": modifiers in the order
// Ctrl, Shift, Alt, then the key.
import { useSettings } from "@/stores/settings";

export type CommandId =
  | "execute"
  | "cancel"
  | "newQuery"
  | "toggleResults"
  | "openFile"
  | "save"
  | "saveAs"
  | "closeTab"
  | "nextTab"
  | "previousTab"
  | "format"
  | "settings";

export interface Command {
  id: CommandId;
  label: string;
  group: "Query" | "Editor" | "Tabs and files" | "App";
  defaults: string[];
}

export const COMMANDS: Command[] = [
  { id: "execute", label: "Execute", group: "Query", defaults: ["F5", "Ctrl+E"] },
  { id: "cancel", label: "Cancel executing query", group: "Query", defaults: ["Alt+Pause"] },
  { id: "toggleResults", label: "Show or hide the results pane", group: "Query", defaults: ["Ctrl+R"] },
  { id: "format", label: "Format document or selection", group: "Editor", defaults: ["Shift+Alt+F"] },
  { id: "newQuery", label: "New query", group: "Tabs and files", defaults: ["Ctrl+N"] },
  { id: "openFile", label: "Open file", group: "Tabs and files", defaults: ["Ctrl+O"] },
  { id: "save", label: "Save", group: "Tabs and files", defaults: ["Ctrl+S"] },
  { id: "saveAs", label: "Save as", group: "Tabs and files", defaults: ["Ctrl+Shift+S"] },
  { id: "closeTab", label: "Close tab", group: "Tabs and files", defaults: ["Ctrl+W", "Ctrl+F4"] },
  { id: "nextTab", label: "Next tab", group: "Tabs and files", defaults: ["Ctrl+Tab"] },
  { id: "previousTab", label: "Previous tab", group: "Tabs and files", defaults: ["Ctrl+Shift+Tab"] },
  { id: "settings", label: "Open settings", group: "App", defaults: ["Ctrl+,"] },
];

/** The keys of a command: the user's, or the defaults. */
export function keysOf(id: CommandId, shortcuts = useSettings.getState().settings.shortcuts): string[] {
  return shortcuts[id] ?? COMMANDS.find((command) => command.id === id)?.defaults ?? [];
}

/** The first key of a command, for menus and tooltips. */
export function useShortcutLabel(id: CommandId): string {
  const shortcuts = useSettings((s) => s.settings.shortcuts);
  return keysOf(id, shortcuts)[0] ?? "";
}

const KEY_NAMES: Record<string, string> = {
  " ": "Space",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Escape: "Esc",
  Cancel: "Pause",
};

/** The shortcut a key press makes, or null for a lone modifier. */
export function shortcutOf(event: KeyboardEvent): string | null {
  if (["Control", "Shift", "Alt", "Meta", "AltGraph", "CapsLock"].includes(event.key)) return null;
  // With Shift the key may be a symbol ("?" for "/"); use the physical key for letters and digits.
  const code = event.code;
  let key = KEY_NAMES[event.key] ?? event.key;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit\d$/.test(code)) key = code.slice(5);
  else if (key.length === 1) key = key.toUpperCase();
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.shiftKey) parts.push("Shift");
  if (event.altKey) parts.push("Alt");
  parts.push(key);
  return parts.join("+");
}

/** The command bound to a shortcut, if any. */
export function commandFor(shortcut: string): CommandId | null {
  const { shortcuts } = useSettings.getState().settings;
  return COMMANDS.find((command) => keysOf(command.id, shortcuts).includes(shortcut))?.id ?? null;
}
