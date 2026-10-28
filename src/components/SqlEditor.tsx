// Loaded lazily: importing it pulls in Monaco.
import { useEffect, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import { Play, WandSparkles } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { monaco } from "@/lib/monaco";
import {
  copySelection,
  currentScript,
  cutSelection,
  focusEditor,
  formatInEditor,
  hasSelection,
  pasteClipboard,
  registerEditor,
  registerMonaco,
  selectAll,
} from "@/lib/editor";
import { errorMessage } from "@/lib/api";
import { toast } from "@/components/ui/basic-toast";
import { scheduleSave } from "@/lib/session-restore";
import { useQueries } from "@/stores/queries";
import { useShortcutLabel } from "@/lib/commands";
import { editorThemeName, registerEditorThemes } from "@/lib/themes";
import { useTheme } from "@/lib/use-theme";
import { EDITOR_FONT_SIZE, useSettings } from "@/stores/settings";
import { syncLanguage } from "@/lib/intellisense";

registerMonaco(monaco);

registerEditorThemes(monaco.editor);

// Monaco measures character widths once; the bundled JetBrains Mono may still
// be loading then, which would put the cursor off its characters. Measure
// again once the fonts are in.
void Promise.all([
  document.fonts.load('400 14px "JetBrains Mono"'),
  document.fonts.load('700 14px "JetBrains Mono"'),
]).then(() => monaco.editor.remeasureFonts());

// Format Document (Shift+Alt+F) and Format Selection (Ctrl+K Ctrl+F). The
// formatter is large, so it loads on first use. An edit is all or nothing,
// and Ctrl+Z undoes it.
async function formatEdits(model: monaco.editor.ITextModel, range: monaco.IRange): Promise<monaco.languages.TextEdit[]> {
  const { formatRange, FormatError } = await import("@/lib/format-sql");
  try {
    // The whole document goes along, so a selection is checked in context.
    const start = model.getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn });
    const end = model.getOffsetAt({ lineNumber: range.endLineNumber, column: range.endColumn });
    const formatted = formatRange(model.getValue(), start, end, useSettings.getState().settings.formatting);
    return formatted === model.getValueInRange(range) ? [] : [{ range, text: formatted }];
  } catch (error) {
    toast.error("Could not format", {
      description: error instanceof FormatError ? error.message : errorMessage(error),
    });
    return [];
  }
}
monaco.languages.registerDocumentFormattingEditProvider("sql", {
  provideDocumentFormattingEdits: (model) => formatEdits(model, model.getFullModelRange()),
});
monaco.languages.registerDocumentRangeFormattingEditProvider("sql", {
  provideDocumentRangeFormattingEdits: (model, range) => {
    // Whole lines, so a statement is never cut in the middle of a word.
    const lines = new monaco.Range(range.startLineNumber, 1, range.endLineNumber, model.getLineMaxColumn(range.endLineNumber));
    return formatEdits(model, lines);
  },
});

/**
 * Ctrl+wheel zooms the editor: it changes the font size, the one in Settings,
 * so it is kept. Captured before Monaco, which would scroll instead. A mouse
 * notch is one step; a touchpad pinch sends small deltas, added up to a step.
 */
function zoomOnCtrlWheel(node: HTMLElement) {
  let pending = 0;
  const onWheel = (event: WheelEvent) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    event.stopPropagation();
    const delta = event.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? event.deltaY : event.deltaY * 40;
    if (Math.abs(delta) >= 50) pending = Math.sign(delta);
    else if (Math.sign(delta) !== Math.sign(pending)) pending = delta / 50;
    else pending += delta / 50;
    const steps = Math.trunc(pending);
    if (!steps) return;
    pending -= steps;
    const { settings, update } = useSettings.getState();
    // Wheel up makes the text bigger.
    const fontSize = Math.min(EDITOR_FONT_SIZE.max, Math.max(EDITOR_FONT_SIZE.min, settings.editor.fontSize - steps));
    if (fontSize !== settings.editor.fontSize) update("editor", { fontSize });
  };
  node.addEventListener("wheel", onWheel, { capture: true, passive: false });
  return () => node.removeEventListener("wheel", onWheel, { capture: true });
}

function clipboard(action: () => Promise<void>) {
  return () =>
    void action().catch((error) => toast.error("Clipboard error", { description: errorMessage(error) }));
}

// Runs the selection, or the whole script when nothing is selected.
function execute() {
  const { activeId, execute } = useQueries.getState();
  const script = currentScript();
  if (activeId && script) void execute(activeId, script);
}

export default function SqlEditor({ tabId, initialText }: { tabId: string; initialText: string }) {
  const theme = useTheme();
  const options = useSettings((s) => s.settings.editor);
  const executeKey = useShortcutLabel("execute");
  const formatKey = useShortcutLabel("format");
  // Read when the menu opens, to disable Cut and Copy without a selection.
  const [selected, setSelected] = useState(false);

  const container = useRef<HTMLDivElement>(null);
  const languageTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {registerEditor(null);if (languageTimer.current) clearTimeout(languageTimer.current);}, []);
  useEffect(() => zoomOnCtrlWheel(container.current!), []);

  return (
    // The app's own menu instead of Monaco's, whose VS Code entries
    // (Command Palette, Change All Occurrences) do not belong here.
    <ContextMenu onOpenChange={(open) => open && setSelected(hasSelection())}>
      <ContextMenuTrigger asChild>
        <div ref={container} className="h-full">
          <Editor
            path={tabId}
            defaultLanguage="sql"
            // Only used when the tab's model is first created.
            defaultValue={initialText}
            // The editor unmounts on Ctrl+R and when the last tab closes; its
            // model must survive that. Models are disposed when their tab closes.
            keepCurrentModel
            onChange={() => {
              useQueries.getState().setDirty(tabId, true);
              scheduleSave();
              if (languageTimer.current) clearTimeout(languageTimer.current);
              languageTimer.current = setTimeout(() => {const model = monaco.editor.getModel(monaco.Uri.parse(tabId));if (model) syncLanguage(model);}, 700);
            }}
            theme={editorThemeName(theme)}
            options={{
              fontFamily: options.fontFamily,
              fontSize: options.fontSize,
              fontLigatures: options.ligatures,
              minimap: { enabled: options.minimap },
              wordWrap: options.wordWrap ? "on" : "off",
              lineNumbers: options.lineNumbers ? "on" : "off",
              scrollBeyondLastLine: false,
              renderLineHighlight: "line",
              automaticLayout: true,
              tabSize: options.tabSize,
              padding: { top: 8 },
              contextmenu: false,
              // Hover, suggestions and signatures may pass the editor's edges:
              // on the first lines a hover above the text was cut off by them.
              fixedOverflowWidgets: true,
            }}
            onMount={(editor) => {
              registerEditor(editor);
              editor.focus();
              const model = editor.getModel();if (model) syncLanguage(model);
              // Execute, Cancel, New Query and the rest are app shortcuts
              // (src/lib/shortcuts.ts), so they work everywhere and can be changed.
            }}
          />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent
        className="w-64"
        // Keep the keyboard in the editor, not on the menu's trigger.
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          focusEditor();
        }}
      >
        <ContextMenuItem onSelect={execute}>
          <Play className="text-primary" /> Execute <ContextMenuShortcut>{executeKey}</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!selected} onSelect={clipboard(cutSelection)}>
          Cut <ContextMenuShortcut>Ctrl+X</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem disabled={!selected} onSelect={clipboard(copySelection)}>
          Copy <ContextMenuShortcut>Ctrl+C</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={clipboard(pasteClipboard)}>
          Paste <ContextMenuShortcut>Ctrl+V</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={selectAll}>
          Select All <ContextMenuShortcut>Ctrl+A</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => formatInEditor(selected)}>
          <WandSparkles /> {selected ? "Format Selection" : "Format Document"}
          <ContextMenuShortcut>{formatKey}</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
