// The user's settings: defaults here, saved by Rust in settings.json
// (src-tauri/src/settings.rs). Loaded before the first render, so the theme
// never flashes.
import { create } from "zustand";
import { api, errorMessage, type ExecuteOptions } from "@/lib/api";
import type { ThemeId } from "@/lib/themes";
import { toast } from "@/components/ui/basic-toast";

export type Density = "compact" | "comfortable";
export type Indent = "2" | "4" | "tab";

export interface Settings {
  /** Bumped when a default changes, so settings saved before can be moved on (see merge). */
  version: number;
  appearance: {
    theme: ThemeId;
  };
  editor: {
    fontFamily: string;
    fontSize: number;
    tabSize: number;
    wordWrap: boolean;
    minimap: boolean;
    lineNumbers: boolean;
    /** Programming ligatures (=> as one glyph); off by default for SQL. */
    ligatures: boolean;
  };
  results: {
    density: Density;
    /** JetBrains Mono in the grid instead of the interface font. */
    monospace: boolean;
  };
  query: {
    /** Seconds before a query is cancelled; 0 waits forever. */
    timeoutSeconds: number;
    maxRows: number;
    maxCellMB: number;
    /** Ask before Destructive Statements on Production connections. */
    confirmDestructive: boolean;
  };
  formatting: {
    uppercaseKeywords: boolean;
    indent: Indent;
  };
  /** Key combinations per command id, where they differ from the defaults. */
  shortcuts: Record<string, string[]>;
}

export const DEFAULT_SETTINGS: Settings = {
  version: 2,
  appearance: { theme: "system" },
  editor: {
    // Bundled with the app (src/assets/fonts), so it is there offline.
    fontFamily: "'JetBrains Mono', Consolas, monospace",
    fontSize: 14,
    tabSize: 4,
    wordWrap: false,
    minimap: false,
    lineNumbers: true,
    ligatures: false,
  },
  results: { density: "comfortable", monospace: false },
  query: { timeoutSeconds: 0, maxRows: 1_000_000, maxCellMB: 2, confirmDestructive: true },
  formatting: { uppercaseKeywords: true, indent: "4" },
  shortcuts: {},
};

/** Bounds of the editor font size, in Settings and for Ctrl+wheel. */
export const EDITOR_FONT_SIZE = { min: 9, max: 32 };
const TAB_SIZE = { min: 1, max: 16 };
const TIMEOUT_SECONDS = { min: 0, max: 86_400 };
const MAX_ROWS = { min: 1, max: 10_000_000 };
const MAX_CELL_MB = { min: 0.1, max: 64 };

function clampNumber(value: unknown, fallback: number, min: number, max: number, integer: boolean): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const clamped = Math.min(max, Math.max(min, value));
  return integer ? Math.round(clamped) : clamped;
}

/** Normalizes and clamps numeric settings so floats or corrupt JSON never break Rust deserialization. */
export function normalizeSettings(settings: Settings): Settings {
  return {
    ...settings,
    editor: {
      ...settings.editor,
      fontSize: clampNumber(settings.editor.fontSize, DEFAULT_SETTINGS.editor.fontSize, EDITOR_FONT_SIZE.min, EDITOR_FONT_SIZE.max, true),
      tabSize: clampNumber(settings.editor.tabSize, DEFAULT_SETTINGS.editor.tabSize, TAB_SIZE.min, TAB_SIZE.max, true),
    },
    query: {
      ...settings.query,
      timeoutSeconds: clampNumber(settings.query.timeoutSeconds, DEFAULT_SETTINGS.query.timeoutSeconds, TIMEOUT_SECONDS.min, TIMEOUT_SECONDS.max, true),
      maxRows: clampNumber(settings.query.maxRows, DEFAULT_SETTINGS.query.maxRows, MAX_ROWS.min, MAX_ROWS.max, true),
      maxCellMB: clampNumber(settings.query.maxCellMB, DEFAULT_SETTINGS.query.maxCellMB, MAX_CELL_MB.min, MAX_CELL_MB.max, false),
    },
  };
}

type Section = Exclude<keyof Settings, "shortcuts" | "version">;

interface SettingsState {
  settings: Settings;
  /** Changes one section, keeping the fields not passed. */
  update: <K extends Section>(section: K, patch: Partial<Settings[K]>) => void;
  setShortcut: (command: string, keys: string[] | null) => void;
  resetShortcuts: () => void;
  reset: () => void;
  /** Puts back settings taken before a reset, for its Undo. */
  restore: (settings: Settings) => void;
}

/**
 * Settings from disk over the defaults, so a newer field never comes back
 * missing. Version 1 saved every field, defaults included: an editor still on
 * the old default font or size moves to the new one; any other choice stays.
 */
function merge(saved: Partial<Settings> | null): Settings {
  const merged = structuredClone(DEFAULT_SETTINGS);
  if (!saved) return merged;
  for (const key of Object.keys(merged) as (keyof Settings)[]) {
    const value = saved[key];
    if (value && typeof value === "object") Object.assign(merged[key], value);
  }
  if ((saved.version ?? 1) < 2) {
    if (saved.editor?.fontFamily === "'Cascadia Code', Consolas, monospace") {
      merged.editor.fontFamily = DEFAULT_SETTINGS.editor.fontFamily;
    }
    if (saved.editor?.fontSize === 13) merged.editor.fontSize = DEFAULT_SETTINGS.editor.fontSize;
  }
  merged.version = DEFAULT_SETTINGS.version;
  return normalizeSettings(merged);
}

let timer: ReturnType<typeof setTimeout> | undefined;
let pendingSettings: Settings | null = null;
let inFlightSave: Promise<void> | null = null;

function persistSettings(settings: Settings): Promise<void> {
  const payload = JSON.stringify(settings, null, 2);
  const previous = inFlightSave ?? Promise.resolve();
  const run = previous.then(() =>
    api.settingsSave(payload).catch((error) => {
      toast.error("Could not save the settings", { description: errorMessage(error) });
    }),
  );
  const pending = run.finally(() => {
    if (inFlightSave === pending) inFlightSave = null;
  });
  inFlightSave = pending;
  return pending;
}

function save(settings: Settings) {
  pendingSettings = settings;
  clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    const toWrite = pendingSettings;
    pendingSettings = null;
    if (toWrite) void persistSettings(toWrite);
  }, 300);
}

/** Immediately writes any debounced settings change (awaited before exit/restart). */
export async function flushSettings(): Promise<void> {
  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }
  const toWrite = pendingSettings;
  pendingSettings = null;
  if (toWrite) await persistSettings(toWrite);
  else if (inFlightSave) await inFlightSave;
}

export const useSettings = create<SettingsState>()((set, get) => {
  const commit = (raw: Settings) => {
    const settings = normalizeSettings(raw);
    set({ settings });
    save(settings);
  };
  return {
    settings: DEFAULT_SETTINGS,
    update: (section, patch) => {
      const settings = get().settings;
      commit({ ...settings, [section]: { ...settings[section], ...patch } });
    },
    setShortcut: (command, keys) => {
      const shortcuts = { ...get().settings.shortcuts };
      if (keys) shortcuts[command] = keys;
      else delete shortcuts[command];
      commit({ ...get().settings, shortcuts });
    },
    resetShortcuts: () => commit({ ...get().settings, shortcuts: {} }),
    reset: () => commit(structuredClone(DEFAULT_SETTINGS)),
    restore: commit,
  };
});

/** Reads settings.json; a missing or broken file leaves the defaults. */
export async function loadSettings() {
  try {
    const text = await api.settingsLoad();
    useSettings.setState({ settings: merge(text ? (JSON.parse(text) as Partial<Settings>) : null) });
  } catch (error) {
    console.error("settings not loaded", error);
  }
}

/** What the Rust side needs for one Execution. */
export function executeOptions(): ExecuteOptions {
  const { query } = normalizeSettings(useSettings.getState().settings);
  return {
    timeoutSeconds: query.timeoutSeconds,
    maxRows: query.maxRows,
    maxCellBytes: Math.round(query.maxCellMB * 1024 * 1024),
  };
}
