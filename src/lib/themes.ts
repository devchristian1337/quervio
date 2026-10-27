// Colour themes for the whole app: the interface (shadcn CSS variables), the
// SQL editor (a Monaco theme each) and the results grid. "Light" and "Dark"
// are the default look, transparent over the Windows 11 Mica backdrop; the
// others paint their own background.

export type ThemeId =
  | "system"
  | "light"
  | "dark"
  | "github-light"
  | "github-dark"
  | "one-dark-pro"
  | "dracula"
  | "tokyo-night"
  | "tokyo-night-day"
  | "catppuccin-latte"
  | "catppuccin-mocha"
  | "night-owl"
  | "ayu-light"
  | "ayu-mirage"
  | "synthwave-84"
  | "shades-of-purple";

export interface Palette {
  /** Editor and page background. */
  bg: string;
  /** Sidebars, popovers and header rows. */
  panel: string;
  fg: string;
  /** Secondary text: labels, line numbers, placeholders. */
  muted: string;
  border: string;
  /** Buttons, focus, the sorted column, the cursor. */
  accent: string;
  /** Text on the accent colour (and on the secondary accent). */
  accentFg: string;
  /** Second brand colour: activity, the editor cursor, matching brackets. */
  accent2?: string;
  selection: string;
  lineHighlight: string;
  destructive: string;
  syntax: {
    keyword: string;
    string: string;
    number: string;
    comment: string;
    /** Built-in functions and variables (GETDATE, @@ROWCOUNT). */
    predefined: string;
    operator: string;
  };
}

export interface Theme {
  id: Exclude<ThemeId, "system">;
  name: string;
  kind: "light" | "dark";
  /** Keeps the Mica backdrop and the default interface colours of index.css. */
  mica?: boolean;
  palette: Palette;
}

export const THEMES: Theme[] = [
  {
    id: "light",
    name: "Light",
    kind: "light",
    mica: true,
    palette: {
      bg: "#ffffff",
      panel: "#f4f4f5",
      fg: "#18181b",
      muted: "#71717a",
      border: "#e4e4e7",
      accent: "#4f5bd5",
      accentFg: "#ffffff",
      selection: "#add6ff",
      lineHighlight: "#0000000a",
      destructive: "#dc2626",
      // The colours of SSMS.
      syntax: {
        keyword: "#0000ff",
        string: "#c41a16",
        number: "#098658",
        comment: "#008000",
        predefined: "#c016c0",
        operator: "#808080",
      },
    },
  },
  {
    // Quervio's own dark palette (design/branding/design-tokens.json).
    // Muted text and the error red are derived for at least 4.5:1 contrast on
    // both the editor background and the panels.
    id: "dark",
    name: "Quervio Dark",
    kind: "dark",
    palette: {
      bg: "#1E1E24",
      panel: "#2A2A35",
      fg: "#F3F2F7",
      muted: "#ABA9BC",
      border: "#3A3A48",
      accent: "#B4ADEA",
      accentFg: "#1E1E24",
      accent2: "#B7FDFE",
      selection: "#B4ADEA40",
      lineHighlight: "#2A2A3599",
      destructive: "#FF7A8A",
      syntax: {
        keyword: "#569cd6",
        string: "#ce9178",
        number: "#b5cea8",
        comment: "#6a9955",
        predefined: "#dcdcaa",
        operator: "#d4d4d4",
      },
    },
  },
  {
    id: "github-light",
    name: "GitHub Light",
    kind: "light",
    palette: {
      bg: "#ffffff",
      panel: "#f6f8fa",
      fg: "#1f2328",
      muted: "#59636e",
      border: "#d1d9e0",
      accent: "#0969da",
      accentFg: "#ffffff",
      selection: "#0969da33",
      lineHighlight: "#eaeef280",
      destructive: "#cf222e",
      syntax: {
        keyword: "#cf222e",
        string: "#0a3069",
        number: "#0550ae",
        comment: "#59636e",
        predefined: "#8250df",
        operator: "#0550ae",
      },
    },
  },
  {
    id: "github-dark",
    name: "GitHub Dark",
    kind: "dark",
    palette: {
      bg: "#0d1117",
      panel: "#010409",
      fg: "#e6edf3",
      muted: "#9198a1",
      border: "#3d444d",
      accent: "#4493f8",
      accentFg: "#ffffff",
      selection: "#3392ff44",
      lineHighlight: "#6e76811a",
      destructive: "#f85149",
      syntax: {
        keyword: "#ff7b72",
        string: "#a5d6ff",
        number: "#79c0ff",
        comment: "#9198a1",
        predefined: "#d2a8ff",
        operator: "#79c0ff",
      },
    },
  },
  {
    id: "one-dark-pro",
    name: "One Dark Pro",
    kind: "dark",
    palette: {
      bg: "#282c34",
      panel: "#21252b",
      fg: "#abb2bf",
      muted: "#7f848e",
      border: "#181a1f",
      accent: "#61afef",
      accentFg: "#1e2127",
      selection: "#67769660",
      lineHighlight: "#2c313c",
      destructive: "#e06c75",
      syntax: {
        keyword: "#c678dd",
        string: "#98c379",
        number: "#d19a66",
        comment: "#7f848e",
        predefined: "#61afef",
        operator: "#56b6c2",
      },
    },
  },
  {
    id: "dracula",
    name: "Dracula",
    kind: "dark",
    palette: {
      bg: "#282a36",
      panel: "#21222c",
      fg: "#f8f8f2",
      muted: "#6272a4",
      border: "#191a21",
      accent: "#bd93f9",
      accentFg: "#282a36",
      selection: "#44475a",
      lineHighlight: "#44475a75",
      destructive: "#ff5555",
      syntax: {
        keyword: "#ff79c6",
        string: "#f1fa8c",
        number: "#bd93f9",
        comment: "#6272a4",
        predefined: "#50fa7b",
        operator: "#ff79c6",
      },
    },
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    kind: "dark",
    palette: {
      bg: "#1a1b26",
      panel: "#16161e",
      fg: "#c0caf5",
      muted: "#565f89",
      border: "#292e42",
      accent: "#7aa2f7",
      accentFg: "#1a1b26",
      selection: "#283457",
      lineHighlight: "#1e202e",
      destructive: "#f7768e",
      syntax: {
        keyword: "#bb9af7",
        string: "#9ece6a",
        number: "#ff9e64",
        comment: "#565f89",
        predefined: "#7aa2f7",
        operator: "#89ddff",
      },
    },
  },
  {
    id: "tokyo-night-day",
    name: "Tokyo Night Day",
    kind: "light",
    palette: {
      bg: "#e1e2e7",
      panel: "#d0d5e3",
      fg: "#3760bf",
      muted: "#848cb5",
      border: "#c4c8da",
      accent: "#2e7de9",
      accentFg: "#ffffff",
      selection: "#b7c1e3",
      lineHighlight: "#c4c8da66",
      destructive: "#f52a65",
      syntax: {
        keyword: "#9854f1",
        string: "#587539",
        number: "#b15c00",
        comment: "#848cb5",
        predefined: "#2e7de9",
        operator: "#006a83",
      },
    },
  },
  {
    id: "catppuccin-latte",
    name: "Catppuccin Latte",
    kind: "light",
    palette: {
      bg: "#eff1f5",
      panel: "#e6e9ef",
      fg: "#4c4f69",
      muted: "#6c6f85",
      border: "#ccd0da",
      accent: "#8839ef",
      accentFg: "#eff1f5",
      selection: "#acb0be66",
      lineHighlight: "#e6e9ef",
      destructive: "#d20f39",
      syntax: {
        keyword: "#8839ef",
        string: "#40a02b",
        number: "#fe640b",
        comment: "#8c8fa1",
        predefined: "#1e66f5",
        operator: "#04a5e5",
      },
    },
  },
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    kind: "dark",
    palette: {
      bg: "#1e1e2e",
      panel: "#181825",
      fg: "#cdd6f4",
      muted: "#a6adc8",
      border: "#313244",
      accent: "#cba6f7",
      accentFg: "#1e1e2e",
      selection: "#585b7066",
      lineHighlight: "#313244",
      destructive: "#f38ba8",
      syntax: {
        keyword: "#cba6f7",
        string: "#a6e3a1",
        number: "#fab387",
        comment: "#9399b2",
        predefined: "#89b4fa",
        operator: "#89dceb",
      },
    },
  },
  {
    id: "night-owl",
    name: "Night Owl",
    kind: "dark",
    palette: {
      bg: "#011627",
      panel: "#01111d",
      fg: "#d6deeb",
      muted: "#637777",
      border: "#122d42",
      accent: "#7e57c2",
      accentFg: "#ffffff",
      selection: "#1d3b53",
      lineHighlight: "#0b253a",
      destructive: "#ef5350",
      syntax: {
        keyword: "#c792ea",
        string: "#ecc48d",
        number: "#f78c6c",
        comment: "#637777",
        predefined: "#82aaff",
        operator: "#7fdbca",
      },
    },
  },
  {
    id: "ayu-light",
    name: "Ayu Light",
    kind: "light",
    palette: {
      bg: "#fcfcfc",
      panel: "#f3f4f5",
      fg: "#5c6166",
      muted: "#8a9199",
      border: "#e7eaed",
      accent: "#fa8d3e",
      accentFg: "#ffffff",
      selection: "#035bd626",
      lineHighlight: "#8a91991a",
      destructive: "#e65050",
      syntax: {
        keyword: "#fa8d3e",
        string: "#86b300",
        number: "#a37acc",
        comment: "#adaeb1",
        predefined: "#f2ae49",
        operator: "#ed9366",
      },
    },
  },
  {
    id: "ayu-mirage",
    name: "Ayu Mirage",
    kind: "dark",
    palette: {
      bg: "#1f2430",
      panel: "#1a1f29",
      fg: "#cccac2",
      muted: "#707a8c",
      border: "#2d3342",
      accent: "#ffcc66",
      accentFg: "#1f2430",
      selection: "#409fff40",
      lineHighlight: "#1a1f29",
      destructive: "#ff6666",
      syntax: {
        keyword: "#ffad66",
        string: "#d5ff80",
        number: "#dfbfff",
        comment: "#6e7c8f",
        predefined: "#ffd173",
        operator: "#f29e74",
      },
    },
  },
  {
    id: "synthwave-84",
    name: "SynthWave '84",
    kind: "dark",
    palette: {
      bg: "#262335",
      panel: "#241b2f",
      fg: "#f0eff1",
      muted: "#848bbd",
      border: "#34294f",
      accent: "#ff7edb",
      accentFg: "#262335",
      selection: "#ffffff20",
      lineHighlight: "#34294f66",
      destructive: "#fe4450",
      syntax: {
        keyword: "#fede5d",
        string: "#ff8b39",
        number: "#f97e72",
        comment: "#848bbd",
        predefined: "#36f9f6",
        operator: "#fede5d",
      },
    },
  },
  {
    id: "shades-of-purple",
    name: "Shades of Purple",
    kind: "dark",
    palette: {
      bg: "#2d2b55",
      panel: "#1e1e3f",
      fg: "#ffffff",
      muted: "#a599e9",
      border: "#3b3772",
      accent: "#fad000",
      accentFg: "#2d2b55",
      selection: "#b362ff88",
      lineHighlight: "#1f1f41",
      destructive: "#ec3a37",
      syntax: {
        keyword: "#ff9d00",
        string: "#a5ff90",
        number: "#ff628c",
        comment: "#b362ff",
        predefined: "#fad000",
        operator: "#ff9d00",
      },
    },
  },
];

export function findTheme(id: ThemeId, systemDark: boolean): Theme {
  const wanted = id === "system" ? (systemDark ? "dark" : "light") : id;
  return THEMES.find((theme) => theme.id === wanted) ?? THEMES[0];
}

/** Monaco theme name for a theme (see registerEditorThemes). */
export const editorThemeName = (theme: Theme) => `quervio-${theme.id}`;

/** A colour mixed into another, as CSS. */
const mix = (color: string, percent: number, base: string) =>
  `color-mix(in oklab, ${color} ${percent}%, ${base})`;

/** The shadcn variables a theme sets; the Mica themes use index.css. */
function cssVariables({ palette: p, kind }: Theme): Record<string, string> {
  const soft = mix(p.fg, kind === "dark" ? 10 : 7, p.bg);
  return {
    "--app-background": p.bg,
    "--panel": p.panel,
    "--brand-secondary": p.accent2 ?? p.accent,
    "--background": p.bg,
    "--foreground": p.fg,
    "--card": p.panel,
    "--card-foreground": p.fg,
    "--popover": p.panel,
    "--popover-foreground": p.fg,
    "--primary": p.accent,
    "--primary-foreground": p.accentFg,
    "--secondary": soft,
    "--secondary-foreground": p.fg,
    "--muted": soft,
    "--muted-foreground": p.muted,
    "--accent": soft,
    "--accent-foreground": p.fg,
    "--destructive": p.destructive,
    "--border": p.border,
    "--input": p.border,
    "--ring": p.accent,
    "--sidebar": p.panel,
    "--sidebar-foreground": p.fg,
    "--sidebar-primary": p.accent,
    "--sidebar-primary-foreground": p.accentFg,
    "--sidebar-accent": soft,
    "--sidebar-accent-foreground": p.fg,
    "--sidebar-border": p.border,
    "--sidebar-ring": p.accent,
  };
}

const ALL_VARIABLES = Object.keys(cssVariables(THEMES[2]));

/** Applies a theme to the page: light/dark class and, for painted themes, colours. */
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme.kind === "dark");
  root.dataset.theme = theme.id;
  root.style.colorScheme = theme.kind;
  for (const name of ALL_VARIABLES) root.style.removeProperty(name);
  if (theme.mica) return;
  for (const [name, value] of Object.entries(cssVariables(theme))) root.style.setProperty(name, value);
}

/** The subset of monaco.editor used here, so this module does not import Monaco. */
interface EditorApi {
  defineTheme(name: string, data: {
    base: "vs" | "vs-dark";
    inherit: boolean;
    rules: { token: string; foreground?: string; fontStyle?: string }[];
    colors: Record<string, string>;
  }): void;
}

/** Defines one Monaco theme per app theme. */
export function registerEditorThemes(editor: EditorApi) {
  const hex = (color: string) => color.replace("#", "");
  for (const theme of THEMES) {
    const { palette: p } = theme;
    editor.defineTheme(editorThemeName(theme), {
      base: theme.kind === "dark" ? "vs-dark" : "vs",
      inherit: true,
      rules: [
        { token: "", foreground: hex(p.fg) },
        { token: "keyword", foreground: hex(p.syntax.keyword) },
        { token: "string", foreground: hex(p.syntax.string) },
        { token: "number", foreground: hex(p.syntax.number) },
        { token: "comment", foreground: hex(p.syntax.comment), fontStyle: "italic" },
        { token: "predefined", foreground: hex(p.syntax.predefined) },
        { token: "operator", foreground: hex(p.syntax.operator) },
        { token: "delimiter", foreground: hex(p.fg) },
        { token: "identifier", foreground: hex(p.fg) },
        { token: "identifier.quote", foreground: hex(p.fg) },
        // Monaco's base themes colour these SQL tokens specifically; override them too.
        { token: "string.sql", foreground: hex(p.syntax.string) },
        { token: "predefined.sql", foreground: hex(p.syntax.predefined) },
        { token: "operator.sql", foreground: hex(p.syntax.operator) },
      ],
      colors: {
        // Transparent: the page behind is the theme's background (or Mica).
        "editor.background": "#00000000",
        "editorGutter.background": "#00000000",
        "editor.foreground": p.fg,
        "editor.lineHighlightBackground": p.lineHighlight,
        "editor.lineHighlightBorder": "#00000000",
        "editor.selectionBackground": p.selection,
        "editor.inactiveSelectionBackground": p.selection,
        "editorCursor.foreground": p.accent2 ?? p.accent,
        "editorLineNumber.foreground": p.muted,
        "editorLineNumber.activeForeground": p.fg,
        "editorWidget.background": p.panel,
        "editorWidget.border": p.border,
        "editorSuggestWidget.background": p.panel,
        "editorSuggestWidget.border": p.border,
        "editorSuggestWidget.selectedBackground": p.selection,
        "editorIndentGuide.background1": p.border,
        "editorBracketMatch.border": p.accent2 ?? p.muted,
      },
    });
  }
}
