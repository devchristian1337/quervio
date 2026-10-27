// The user's settings: defaults here, saved by Rust in settings.json
// (src-tauri/src/settings.rs). Loaded before the first render, so the theme
// never flashes.
import { create } from "zustand";
import { api, errorMessage, type ExecuteOptions } from "@/lib/api";
import type { ThemeId } from "@/lib/themes";
import { toast } from "sonner";

export type Density = "compact" | "comfortable";
export type Indent = "2" | "4" | "tab";

export interface Settings {
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
  };
  results: {
    density: Density;
    /** Cascadia Code in the grid instead of the interface font. */
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
  appearance: { theme: "system" },
  editor: {
    fontFamily: "'Cascadia Code', Consolas, monospace",
    fontSize: 13,
    tabSize: 4,
    wordWrap: false,
    minimap: false,
    lineNumbers: true,
  },
  results: { density: "comfortable", monospace: false },
  query: { timeoutSeconds: 0, maxRows: 1_000_000, maxCellMB: 2, confirmDestructive: true },
  formatting: { uppercaseKeywords: true, indent: "4" },
  shortcuts: {},
};

type Section = Exclude<keyof Settings, "shortcuts">;

interface SettingsState {
  settings: Settings;
  /** Changes one section, keeping the fields not passed. */
  update: <K extends Section>(section: K, patch: Partial<Settings[K]>) => void;
  setShortcut: (command: string, keys: string[] | null) => void;
  resetShortcuts: () => void;
  reset: () => void;
}

/** Settings from disk over the defaults, so a newer field never comes back missing. */
function merge(saved: Partial<Settings> | null): Settings {
  const merged = structuredClone(DEFAULT_SETTINGS);
  if (!saved) return merged;
  for (const key of Object.keys(merged) as (keyof Settings)[]) {
    const value = saved[key];
    if (value && typeof value === "object") Object.assign(merged[key], value);
  }
  return merged;
}

let timer: ReturnType<typeof setTimeout> | undefined;
function save(settings: Settings) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    api.settingsSave(JSON.stringify(settings, null, 2)).catch((error) =>
      toast.error("Could not save the settings", { description: errorMessage(error) }),
    );
  }, 300);
}

export const useSettings = create<SettingsState>()((set, get) => {
  const commit = (settings: Settings) => {
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
  const { query } = useSettings.getState().settings;
  return {
    timeoutSeconds: query.timeoutSeconds,
    maxRows: query.maxRows,
    maxCellBytes: Math.round(query.maxCellMB * 1024 * 1024),
  };
}
