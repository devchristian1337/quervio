// Settings: appearance, editor, results, query, shortcuts and About. Every
// change applies at once and is saved by src/stores/settings.ts.
import { useEffect, useState, type ReactNode } from "react";
import { getTauriVersion, getVersion } from "@tauri-apps/api/app";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  Check,
  Code2,
  Copy,
  Info,
  Keyboard,
  Palette,
  RotateCcw,
  Table2,
  Timer,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api, errorMessage } from "@/lib/api";
import { COMMANDS, commandFor, keysOf, shortcutOf, type Command } from "@/lib/commands";
import { pauseShortcuts } from "@/lib/shortcuts";
import { THEMES, findTheme, type Theme, type ThemeId } from "@/lib/themes";
import { useSystemDark } from "@/lib/use-theme";
import { cn } from "@/lib/utils";
import { useSettingsDialog, type SettingsSection } from "@/stores/dialogs";
import { EDITOR_FONT_SIZE, useSettings, type Density, type Indent } from "@/stores/settings";
// The app tile: Q Prisma v2 on its graphite ground, as on the desktop.
import prismaTile from "@/assets/quervio-q-prisma-v2.png";
import interLicence from "@/assets/fonts/Inter-LICENSE.txt?raw";
import jetBrainsLicence from "@/assets/fonts/JetBrainsMono-OFL.txt?raw";

const SECTIONS: { id: SettingsSection; label: string; icon: ReactNode }[] = [
  { id: "appearance", label: "Appearance", icon: <Palette /> },
  { id: "editor", label: "Editor", icon: <Code2 /> },
  { id: "results", label: "Results", icon: <Table2 /> },
  { id: "query", label: "Query", icon: <Timer /> },
  { id: "shortcuts", label: "Shortcuts", icon: <Keyboard /> },
  { id: "about", label: "About", icon: <Info /> },
];

export function SettingsDialog() {
  const { open, section, show, hide } = useSettingsDialog();
  const reset = useSettings((s) => s.reset);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? show() : hide())}>
      <DialogContent className="flex h-[min(640px,calc(100vh-4rem))] gap-0 overflow-hidden p-0 sm:max-w-4xl">
        <nav className="flex w-48 shrink-0 flex-col gap-0.5 border-r bg-muted/40 p-2">
          <DialogTitle className="px-2 pt-2 pb-3 text-sm">Settings</DialogTitle>
          <DialogDescription className="sr-only">Quervio settings</DialogDescription>
          {SECTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => show(item.id)}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-4",
                section === item.id && "bg-accent font-medium text-foreground",
              )}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
          <div className="mt-auto">
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start gap-2 text-xs text-muted-foreground"
              onClick={() => {
                reset();
                toast.success("Settings reset to their defaults");
              }}
            >
              <RotateCcw /> Reset all settings
            </Button>
          </div>
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto px-8 py-6">
          {section === "appearance" && <AppearanceSection />}
          {section === "editor" && <EditorSection />}
          {section === "results" && <ResultsSection />}
          {section === "query" && <QuerySection />}
          {section === "shortcuts" && <ShortcutsSection />}
          {section === "about" && <AboutSection />}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Heading({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-5">
      <h3 className="text-base font-semibold">{title}</h3>
      {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
    </div>
  );
}

/** One setting: label and help on the left, the control on the right. */
function Row({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 border-b py-3 last:border-b-0">
      <div className="min-w-0">
        <Label className="text-sm font-normal">{label}</Label>
        {help && <p className="mt-0.5 text-xs text-muted-foreground">{help}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** A number field that saves only valid values within its range. */
function NumberField({
  value,
  min,
  max,
  step = 1,
  suffix,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <div className="flex items-center gap-2">
      <Input
        type="number"
        className="h-8 w-28 text-right"
        min={min}
        max={max}
        step={step}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          const next = Number(event.target.value);
          if (event.target.value !== "" && Number.isFinite(next) && next >= min && next <= max) onChange(next);
        }}
        onBlur={() => setText(String(value))}
      />
      {suffix && <span className="w-14 text-xs text-muted-foreground">{suffix}</span>}
    </div>
  );
}

// ─── Appearance ─────────────────────────────────────────────────────────────

function AppearanceSection() {
  const current = useSettings((s) => s.settings.appearance.theme);
  const update = useSettings((s) => s.update);
  const systemDark = useSystemDark();
  const choose = (theme: ThemeId) => update("appearance", { theme });

  return (
    <>
      <Heading title="Appearance" description="Colours of the whole app: panels, SQL editor and results grid." />
      <div className="grid grid-cols-3 gap-3">
        <ThemeCard
          name="System"
          note={`Follows Windows · now ${systemDark ? "Dark" : "Light"}`}
          selected={current === "system"}
          onSelect={() => choose("system")}
          preview={[findTheme("light", false), findTheme("dark", true)]}
        />
        {THEMES.map((theme) => (
          <ThemeCard
            key={theme.id}
            name={theme.name}
            note={theme.mica ? `${theme.kind === "dark" ? "Dark" : "Light"} · Mica` : theme.kind === "dark" ? "Dark" : "Light"}
            selected={current === theme.id}
            onSelect={() => choose(theme.id)}
            preview={[theme]}
          />
        ))}
      </div>
    </>
  );
}

function ThemeCard({
  name,
  note,
  selected,
  onSelect,
  preview,
}: {
  name: string;
  note: string;
  selected: boolean;
  onSelect: () => void;
  preview: Theme[];
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "group overflow-hidden rounded-lg border text-left transition-shadow outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "ring-2 ring-primary" : "hover:border-muted-foreground/40",
      )}
    >
      <div className="flex h-20">
        {preview.map((theme) => (
          <ThemePreview key={theme.id} theme={theme} />
        ))}
      </div>
      <div className="flex items-center justify-between gap-2 border-t px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{name}</div>
          <div className="truncate text-xs text-muted-foreground">{note}</div>
        </div>
        {selected && <Check className="size-4 shrink-0 text-primary" />}
      </div>
    </button>
  );
}

/** A tiny editor: sidebar strip, then lines of "code" in the theme's colours. */
function ThemePreview({ theme }: { theme: Theme }) {
  const { palette: p } = theme;
  const line = (parts: [string, number][]) => (
    <div className="flex gap-1">
      {parts.map(([color, width], index) => (
        <span key={index} className="h-1.5 rounded-full" style={{ background: color, width }} />
      ))}
    </div>
  );
  return (
    <div className="flex flex-1" style={{ background: p.bg }}>
      <div className="w-5 shrink-0" style={{ background: p.panel, borderRight: `1px solid ${p.border}` }} />
      <div className="flex flex-1 flex-col justify-center gap-1.5 px-2.5">
        {line([[p.syntax.keyword, 22], [p.fg, 14], [p.syntax.keyword, 16]])}
        {line([[p.muted, 8], [p.syntax.predefined, 20], [p.syntax.string, 26]])}
        {line([[p.syntax.keyword, 18], [p.fg, 10], [p.syntax.operator, 6], [p.syntax.number, 10]])}
        {line([[p.syntax.comment, 40]])}
        <span className="h-1.5 w-8 rounded-full" style={{ background: p.accent }} />
      </div>
    </div>
  );
}

// ─── Editor ─────────────────────────────────────────────────────────────────

const FONTS = [
  // Bundled with Quervio; the others are used if installed on the PC.
  "'JetBrains Mono', Consolas, monospace",
  "'Cascadia Code', Consolas, monospace",
  "'Cascadia Mono', Consolas, monospace",
  "Consolas, monospace",
  "'Fira Code', Consolas, monospace",
  "'Courier New', monospace",
];

const fontName = (family: string) => family.split(",")[0].replace(/'/g, "");

function EditorSection() {
  const editor = useSettings((s) => s.settings.editor);
  const formatting = useSettings((s) => s.settings.formatting);
  const update = useSettings((s) => s.update);

  return (
    <>
      <Heading title="Editor" description="The SQL editor of every query tab." />
      <Row label="Font" help="JetBrains Mono comes with Quervio; the others fall back to Consolas if not installed.">
        <Select value={editor.fontFamily} onValueChange={(fontFamily) => update("editor", { fontFamily })}>
          <SelectTrigger size="sm" className="w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FONTS.map((family) => (
              <SelectItem key={family} value={family} style={{ fontFamily: family }}>
                {fontName(family)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      <Row label="Font size">
        <NumberField value={editor.fontSize} min={EDITOR_FONT_SIZE.min} max={EDITOR_FONT_SIZE.max} suffix="px" onChange={(fontSize) => update("editor", { fontSize })} />
      </Row>
      <Row label="Tab size">
        <Select value={String(editor.tabSize)} onValueChange={(size) => update("editor", { tabSize: Number(size) })}>
          <SelectTrigger size="sm" className="w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[2, 4, 8].map((size) => (
              <SelectItem key={size} value={String(size)}>
                {size} spaces
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      <Row label="Word wrap" help="Wrap long lines instead of scrolling sideways.">
        <Switch checked={editor.wordWrap} onCheckedChange={(wordWrap) => update("editor", { wordWrap })} />
      </Row>
      <Row label="Line numbers">
        <Switch checked={editor.lineNumbers} onCheckedChange={(lineNumbers) => update("editor", { lineNumbers })} />
      </Row>
      <Row label="Ligatures" help="Join pairs such as => or != into one glyph, if the font has them.">
        <Switch checked={editor.ligatures} onCheckedChange={(ligatures) => update("editor", { ligatures })} />
      </Row>
      <Row label="Minimap" help="An overview of the script along the right edge.">
        <Switch checked={editor.minimap} onCheckedChange={(minimap) => update("editor", { minimap })} />
      </Row>

      <h4 className="mt-8 mb-1 text-sm font-semibold">Formatting</h4>
      <p className="mb-2 text-xs text-muted-foreground">Format Document and Format Selection (Poor Man's T-SQL Formatter).</p>
      <Row label="Uppercase keywords" help="SELECT, FROM, WHERE… in capitals.">
        <Switch
          checked={formatting.uppercaseKeywords}
          onCheckedChange={(uppercaseKeywords) => update("formatting", { uppercaseKeywords })}
        />
      </Row>
      <Row label="Indentation">
        <Select value={formatting.indent} onValueChange={(indent) => update("formatting", { indent: indent as Indent })}>
          <SelectTrigger size="sm" className="w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="2">2 spaces</SelectItem>
            <SelectItem value="4">4 spaces</SelectItem>
            <SelectItem value="tab">Tab</SelectItem>
          </SelectContent>
        </Select>
      </Row>
    </>
  );
}

// ─── Results ────────────────────────────────────────────────────────────────

function ResultsSection() {
  const results = useSettings((s) => s.settings.results);
  const update = useSettings((s) => s.update);
  return (
    <>
      <Heading title="Results" description="How result sets look in the grid." />
      <Row label="Row density">
        <Select value={results.density} onValueChange={(density) => update("results", { density: density as Density })}>
          <SelectTrigger size="sm" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="comfortable">Comfortable</SelectItem>
            <SelectItem value="compact">Compact</SelectItem>
          </SelectContent>
        </Select>
      </Row>
      <Row label="Monospace font" help="Show values in JetBrains Mono, like the editor, instead of Inter.">
        <Switch checked={results.monospace} onCheckedChange={(monospace) => update("results", { monospace })} />
      </Row>
    </>
  );
}

// ─── Query ──────────────────────────────────────────────────────────────────

function QuerySection() {
  const query = useSettings((s) => s.settings.query);
  const update = useSettings((s) => s.update);
  return (
    <>
      <Heading title="Query" description="Limits and safeguards for every execution. They apply to the next run." />
      <Row label="Execution timeout" help="Cancel a query that runs longer than this. 0 waits forever, as SSMS.">
        <NumberField
          value={query.timeoutSeconds}
          min={0}
          max={86_400}
          suffix="seconds"
          onChange={(timeoutSeconds) => update("query", { timeoutSeconds })}
        />
      </Row>
      <Row label="Rows per result set" help="Reading stops here, with a message. Rows are kept in memory.">
        <NumberField
          value={query.maxRows}
          min={1}
          max={10_000_000}
          step={1000}
          suffix="rows"
          onChange={(maxRows) => update("query", { maxRows })}
        />
      </Row>
      <Row label="Text per cell" help="Longer values are cut; the value viewer says so.">
        <NumberField
          value={query.maxCellMB}
          min={0.1}
          max={64}
          step={0.5}
          suffix="MB"
          onChange={(maxCellMB) => update("query", { maxCellMB })}
        />
      </Row>
      <Row
        label="Confirm destructive statements on Production"
        help="Ask before DELETE, UPDATE, DROP, TRUNCATE… on connections marked Production."
      >
        <Switch
          checked={query.confirmDestructive}
          onCheckedChange={(confirmDestructive) => update("query", { confirmDestructive })}
        />
      </Row>
    </>
  );
}

// ─── Shortcuts ──────────────────────────────────────────────────────────────

function ShortcutsSection() {
  const shortcuts = useSettings((s) => s.settings.shortcuts);
  const resetShortcuts = useSettings((s) => s.resetShortcuts);
  const groups = [...new Set(COMMANDS.map((command) => command.group))];
  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <Heading
          title="Shortcuts"
          description="Click + to record a new key combination; Esc cancels. Editing keys such as Ctrl+K Ctrl+C stay as in SSMS."
        />
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          disabled={Object.keys(shortcuts).length === 0}
          onClick={() => resetShortcuts()}
        >
          <RotateCcw /> Reset all
        </Button>
      </div>
      {groups.map((group) => (
        <div key={group} className="mb-6">
          <h4 className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">{group}</h4>
          {COMMANDS.filter((command) => command.group === group).map((command) => (
            <ShortcutRow key={command.id} command={command} />
          ))}
        </div>
      ))}
    </>
  );
}

function ShortcutRow({ command }: { command: Command }) {
  const shortcuts = useSettings((s) => s.settings.shortcuts);
  const setShortcut = useSettings((s) => s.setShortcut);
  const [recording, setRecording] = useState(false);
  const keys = keysOf(command.id, shortcuts);
  const changed = shortcuts[command.id] !== undefined;

  useEffect(() => {
    if (!recording) return;
    pauseShortcuts(true);
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setRecording(false);
        return;
      }
      const shortcut = shortcutOf(event);
      if (!shortcut) return;
      setRecording(false);
      if (keys.includes(shortcut)) return;
      // A combination does one thing: take it from the command that had it.
      const other = commandFor(shortcut);
      if (other && other !== command.id) {
        setShortcut(other, keysOf(other).filter((key) => key !== shortcut));
        const name = COMMANDS.find((c) => c.id === other)?.label;
        toast.info(`${shortcut} moved from “${name}” to “${command.label}”`);
      }
      setShortcut(command.id, [...keys, shortcut]);
    };
    // Capture, so the dialog and the global shortcuts never see these keys.
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      pauseShortcuts(false);
    };
  }, [recording, keys, command, setShortcut]);

  return (
    <div className="flex min-h-11 items-center justify-between gap-4 border-b py-1.5 last:border-b-0">
      <span className="text-sm">{command.label}</span>
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        {keys.map((key) => (
          <span key={key} className="group inline-flex items-center gap-1 rounded-md border bg-muted px-2 py-0.5 font-mono text-xs">
            {key}
            <button
              type="button"
              title={`Remove ${key}`}
              className="text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground"
              onClick={() => setShortcut(command.id, keys.filter((k) => k !== key))}
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        {keys.length === 0 && !recording && <span className="text-xs text-muted-foreground">None</span>}
        <Button
          variant={recording ? "default" : "ghost"}
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => setRecording((value) => !value)}
        >
          {recording ? "Press keys…" : "+"}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          title="Back to the default"
          disabled={!changed}
          onClick={() => setShortcut(command.id, null)}
        >
          <RotateCcw />
        </Button>
      </div>
    </div>
  );
}

// ─── About ──────────────────────────────────────────────────────────────────

const LICENSES: [string, string][] = [
  ["Tauri", "MIT / Apache-2.0"],
  ["mssql-tds (Microsoft)", "MIT"],
  ["React", "MIT"],
  ["Monaco Editor", "MIT"],
  ["Glide Data Grid", "MIT"],
  ["Poor Man's T-SQL Formatter", "AGPL-3.0"],
  ["Radix UI and shadcn/ui", "MIT"],
  ["Tailwind CSS", "MIT"],
  ["Motion", "MIT"],
  ["Lucide icons", "ISC"],
  ["Zustand", "MIT"],
  ["Sonner", "MIT"],
];

const FONT_LICENCES: [string, string][] = [
  ["Inter (interface and results)", interLicence],
  ["JetBrains Mono (SQL editor)", jetBrainsLicence],
];

function AboutSection() {
  const [versions, setVersions] = useState<{ app: string; tauri: string } | null>(null);
  const [dataDir, setDataDir] = useState("");

  useEffect(() => {
    Promise.all([getVersion(), getTauriVersion()])
      .then(([app, tauri]) => setVersions({ app: app ?? "dev", tauri: tauri ?? "?" }))
      .catch(() => setVersions({ app: "dev", tauri: "?" }));
    api.dataDir().then((dir) => setDataDir(dir ?? ""), () => setDataDir(""));
  }, []);

  const copyDataDir = () =>
    writeText(dataDir).then(
      () => toast.success("Folder path copied"),
      (error) => toast.error("Copy failed", { description: errorMessage(error) }),
    );

  return (
    <>
      <div className="mb-6 flex items-center gap-4">
        <img src={prismaTile} alt="" className="size-16 rounded-2xl object-contain" draggable={false} />
        <div>
          <div className="text-xl font-semibold tracking-tight">Quervio</div>
          <p className="text-sm text-muted-foreground">A fast, modern SQL Server client for Windows.</p>
        </div>
      </div>
      <Row label="Version">
        <span className="font-mono text-sm">{versions?.app ?? "…"}</span>
      </Row>
      <Row label="Tauri">
        <span className="font-mono text-sm">{versions?.tauri ?? "…"}</span>
      </Row>
      <Row label="Data folder" help="Saved connections, encrypted passwords, open tabs and settings.">
        <div className="flex max-w-80 items-center gap-1.5">
          <span className="truncate font-mono text-xs" title={dataDir}>
            {dataDir || "—"}
          </span>
          <Button variant="ghost" size="icon" className="size-7" disabled={!dataDir} title="Copy path" onClick={() => void copyDataDir()}>
            <Copy />
          </Button>
        </div>
      </Row>

      <h4 className="mt-8 mb-1 text-sm font-semibold">Open source</h4>
      <p className="mb-2 text-xs text-muted-foreground">
        Quervio is built on these projects. The formatter is AGPL-3.0: if Quervio is distributed outside the team, its
        source must be made available under the same terms.
      </p>
      <div className="divide-y rounded-md border">
        {LICENSES.map(([name, license]) => (
          <div key={name} className="flex items-center justify-between px-3 py-1.5 text-sm">
            <span>{name}</span>
            <span className="font-mono text-xs text-muted-foreground">{license}</span>
          </div>
        ))}
      </div>

      <h4 className="mt-8 mb-1 text-sm font-semibold">Fonts</h4>
      <p className="mb-2 text-xs text-muted-foreground">
        Bundled with Quervio under the SIL Open Font License 1.1, which travels with them.
      </p>
      <div className="divide-y rounded-md border">
        {FONT_LICENCES.map(([name, text]) => (
          <details key={name} className="group px-3 py-1.5 text-sm">
            <summary className="flex cursor-pointer list-none items-center justify-between">
              <span>{name}</span>
              <span className="font-mono text-xs text-muted-foreground">OFL-1.1</span>
            </summary>
            <pre className="mt-2 max-h-56 overflow-auto font-mono text-xs whitespace-pre-wrap text-muted-foreground">{text}</pre>
          </details>
        ))}
      </div>
    </>
  );
}
