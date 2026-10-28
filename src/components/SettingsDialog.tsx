// Settings: appearance, editor, results, query, shortcuts and About. Every
// change applies at once and is saved by src/stores/settings.ts.
import { useEffect, useState, type ReactNode } from "react";
import { getTauriVersion, getVersion } from "@tauri-apps/api/app";
import {
  Check,
  Code2,
  Info,
  Keyboard,
  Palette,
  Plus,
  RotateCcw,
  Table2,
  Timer,
  X,
} from "lucide-react";
import { toast } from "@/components/ui/basic-toast";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/flexnative-tooltip";
import { CopyButton } from "@/components/ui/copy-button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { GlowingKeyboard } from "@/components/ui/glowing-keyboard";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/interfaces-select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { COMMANDS, commandFor, keysOf, shortcutOf, type Command } from "@/lib/commands";
import { pauseShortcuts } from "@/lib/shortcuts";
import { THEMES, findTheme, type Theme, type ThemeId } from "@/lib/themes";
import { useSystemDark } from "@/lib/use-theme";
import { cn } from "@/lib/utils";
import { useSettingsDialog, type SettingsSection } from "@/stores/dialogs";
import { useUpdates } from "@/stores/updates";
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
      <DialogContent
        className="flex h-[min(640px,calc(100vh-4rem))] gap-0 overflow-hidden p-0 sm:max-w-4xl"
        // Focus starts on the section the dialog opens at, not on the first one, so
        // a keyboard user's focus ring sits on the item that is selected.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          event.currentTarget instanceof HTMLElement &&
            event.currentTarget.querySelector<HTMLElement>(`[data-section="${section}"]`)?.focus();
        }}
      >
        <nav className="flex w-48 shrink-0 flex-col gap-0.5 border-r bg-muted/40 p-2">
          <DialogTitle className="px-2 pt-2 pb-3 text-sm">Settings</DialogTitle>
          <DialogDescription className="sr-only">Quervio settings</DialogDescription>
          {SECTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              data-section={item.id}
              aria-current={section === item.id ? "page" : undefined}
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
              className="w-full justify-start gap-2 px-2 font-normal text-muted-foreground has-[>svg]:px-2"
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
        className="w-28 text-right"
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
          // Short enough for the narrowest card, like "Dark · Mica" beside it. Another
          // theme sets the window's own mode (lib/window-theme.ts), which hides
          // Windows' from the page, so the current mode shows only while System is on.
          note={current === "system" ? `Windows · ${systemDark ? "Dark" : "Light"}` : "Follows Windows"}
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
          <Tip label={note}>
            <div className="truncate text-xs text-muted-foreground">{note}</div>
          </Tip>
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
          <SelectTrigger className="w-52">
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
          <SelectTrigger className="w-28">
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
          <SelectTrigger className="w-28">
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
          <SelectTrigger className="w-36">
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

/** What the keyboard lights: a shortcut, or the keys held while recording one. */
interface Preview {
  shortcut: string;
  command: string;
  recording?: boolean;
}

function ShortcutsSection() {
  const shortcuts = useSettings((s) => s.settings.shortcuts);
  const resetShortcuts = useSettings((s) => s.resetShortcuts);
  const [preview, setPreview] = useState<Preview | null>(null);
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
          className="shrink-0"
          disabled={Object.keys(shortcuts).length === 0}
          onClick={() => resetShortcuts()}
        >
          <RotateCcw /> Reset all
        </Button>
      </div>
      {/* Stays in view while the list scrolls, so every row can light it. */}
      <div className="sticky -top-6 z-10 -mx-8 mb-4 bg-background px-8 pt-6 pb-3 -mt-6">
        {/* Split on a "+" that has a key after it, so Ctrl++ (the + key) keeps its "+". */}
        <GlowingKeyboard highlight={preview?.shortcut.split(/\+(?=.)/) ?? []} />
        <p className="mt-2 h-5 text-xs text-muted-foreground">
          {preview ? (
            <>
              <span className="font-mono text-foreground">{preview.shortcut || "…"}</span> · {preview.command}
              {preview.recording && " (recording)"}
            </>
          ) : (
            "Point at a command to see its keys."
          )}
        </p>
      </div>
      {/* The keys stay lit over the gaps between rows and groups, until the pointer leaves the list. */}
      <div onMouseLeave={() => setPreview((current) => (current?.recording ? current : null))}>
      {groups.map((group) => (
        <div key={group} className="mb-6">
          <h4 className="mb-1 text-xs font-medium text-muted-foreground">{group}</h4>
          {COMMANDS.filter((command) => command.group === group).map((command) => (
            <ShortcutRow key={command.id} command={command} onPreview={setPreview} />
          ))}
        </div>
      ))}
      </div>
    </>
  );
}

/** Ctrl, Shift and Alt as held during a key event, in shortcut order. */
function heldModifiers(event: KeyboardEvent) {
  return [event.ctrlKey && "Ctrl", event.shiftKey && "Shift", event.altKey && "Alt"].filter(Boolean).join("+");
}

function ShortcutRow({ command, onPreview }: { command: Command; onPreview: (preview: Preview | null) => void }) {
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
        onPreview(null);
        return;
      }
      const shortcut = shortcutOf(event);
      if (!shortcut) {
        onPreview({ shortcut: heldModifiers(event), command: command.label, recording: true });
        return;
      }
      setRecording(false);
      onPreview({ shortcut, command: command.label });
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
    // Letting go of a modifier unlights it.
    const onKeyUp = (event: KeyboardEvent) =>
      onPreview({ shortcut: heldModifiers(event), command: command.label, recording: true });
    // Capture, so the dialog and the global shortcuts never see these keys.
    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("keyup", onKeyUp, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("keyup", onKeyUp, { capture: true });
      pauseShortcuts(false);
    };
  }, [recording, keys, command, setShortcut, onPreview]);

  const show = (shortcut: string | undefined) =>
    !recording && onPreview(shortcut ? { shortcut, command: command.label } : null);

  return (
    <div
      className="flex min-h-11 items-center justify-between gap-4 border-b py-1.5 last:border-b-0"
      onMouseEnter={() => show(keys[0])}
    >
      <span className="text-sm">{command.label}</span>
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        {keys.map((key) => (
          <span
            key={key}
            className="group inline-flex items-center gap-1 rounded-md border bg-muted px-2 py-0.5 font-mono text-xs"
            onMouseEnter={() => show(key)}
            onMouseLeave={() => show(keys[0])}
          >
            {key}
            <Tip label={`Remove ${key}`}>
              <button
                type="button"
                aria-label={`Remove ${key}`}
                className="text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100"
                onClick={() => setShortcut(command.id, keys.filter((k) => k !== key))}
              >
                <X className="size-3" />
              </button>
            </Tip>
          </span>
        ))}
        {keys.length === 0 && !recording && <span className="text-xs text-muted-foreground">None</span>}
        <Tip label={recording ? undefined : `Add keys for ${command.label}`}>
          <Button
            variant={recording ? "default" : "ghost"}
            size={recording ? "sm" : "icon"}
            // The same 28 px square as the reset button beside it until it records.
            className={recording ? "h-7 px-2 text-xs" : "size-7"}
            aria-label={recording ? undefined : `Add keys for ${command.label}`}
            onClick={() => {
              onPreview(
                recording
                  ? keys[0] ? { shortcut: keys[0], command: command.label } : null
                  : { shortcut: "", command: command.label, recording: true },
              );
              setRecording(!recording);
            }}
          >
            {recording ? "Press keys…" : <Plus />}
          </Button>
        </Tip>
        <Tip label="Back to the default" wrap>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Back to the default"
            disabled={!changed}
            onClick={() => setShortcut(command.id, null)}
          >
            <RotateCcw />
          </Button>
        </Tip>
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

const UPDATE_HELP = "Downloaded from the Quervio releases on GitHub and installed on restart.";

/** Check, download, then restart into the new version. */
function UpdateControl() {
  const { phase, available, progress, error, check, download, install } = useUpdates();
  const busy = phase === "checking" || phase === "downloading" || phase === "installing";
  const text = {
    idle: "",
    checking: "Checking…",
    "not-installed": "Only an installed Quervio can update itself",
    current: "Quervio is up to date",
    available: `Version ${available} is available`,
    downloading: `Downloading ${available}… ${progress}%`,
    ready: `Version ${available} is ready`,
    installing: "Restarting…",
    error: "The update failed",
  }[phase];
  const action =
    phase === "available"
      ? { label: "Download", run: download }
      : phase === "ready" || phase === "installing"
        ? { label: "Restart to update", run: install }
        : { label: "Check for updates", run: check };

  return (
    <div className="flex items-center gap-3">
      {text &&
        (error ? (
          <Tip label={error}>
            <span className="text-sm text-destructive">{text}</span>
          </Tip>
        ) : (
          <span className="text-sm text-muted-foreground">{text}</span>
        ))}
      {phase !== "not-installed" && (
        <Button size="sm" variant={phase === "ready" ? "default" : "outline"} disabled={busy} onClick={() => void action.run()}>
          {action.label}
        </Button>
      )}
    </div>
  );
}

function AboutSection() {
  const [versions, setVersions] = useState<{ app: string; tauri: string } | null>(null);
  const [dataDir, setDataDir] = useState("");

  useEffect(() => {
    Promise.all([getVersion(), getTauriVersion()])
      .then(([app, tauri]) => setVersions({ app: app ?? "dev", tauri: tauri ?? "?" }))
      .catch(() => setVersions({ app: "dev", tauri: "?" }));
    api.dataDir().then((dir) => setDataDir(dir ?? ""), () => setDataDir(""));
  }, []);

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
        <span className="font-mono text-sm select-text">{versions?.app ?? "…"}</span>
      </Row>
      <Row label="Updates" help={UPDATE_HELP}>
        <UpdateControl />
      </Row>
      <Row label="Tauri">
        <span className="font-mono text-sm select-text">{versions?.tauri ?? "…"}</span>
      </Row>
      <Row label="Data folder" help="Saved connections, encrypted passwords, open tabs and settings.">
        <div className="flex max-w-80 items-center gap-1.5">
          <Tip label={dataDir}>
            <span className="truncate font-mono text-xs select-text">{dataDir || "—"}</span>
          </Tip>
          <CopyButton text={dataDir} label="Copy path" className="size-7" disabled={!dataDir} />
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
            <summary className="flex list-none items-center justify-between">
              <span>{name}</span>
              <span className="font-mono text-xs text-muted-foreground">OFL-1.1</span>
            </summary>
            <pre className="mt-2 max-h-56 overflow-auto font-mono text-xs whitespace-pre-wrap text-muted-foreground select-text">{text}</pre>
          </details>
        ))}
      </div>
    </>
  );
}
