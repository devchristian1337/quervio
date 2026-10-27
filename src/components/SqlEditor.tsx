// Loaded lazily: importing it pulls in Monaco.
import { useEffect, useState } from "react";
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
import { toast } from "sonner";
import { scheduleSave } from "@/lib/session-restore";
import { useQueries } from "@/stores/queries";
import { useShortcutLabel } from "@/lib/commands";
import { editorThemeName, registerEditorThemes } from "@/lib/themes";
import { useTheme } from "@/lib/use-theme";
import { useSettings } from "@/stores/settings";

registerMonaco(monaco);

registerEditorThemes(monaco.editor);

// Format Document (Shift+Alt+F) and Format Selection (Ctrl+K Ctrl+F). The
// formatter is large, so it loads on first use. An edit is all or nothing,
// and Ctrl+Z undoes it.
async function formatEdits(text: string, range: monaco.IRange): Promise<monaco.languages.TextEdit[]> {
  const { formatScript, FormatError } = await import("@/lib/format-sql");
  try {
    const formatted = formatScript(text, useSettings.getState().settings.formatting);
    return formatted === text ? [] : [{ range, text: formatted }];
  } catch (error) {
    toast.error("Could not format", {
      description: error instanceof FormatError ? error.message : errorMessage(error),
    });
    return [];
  }
}
monaco.languages.registerDocumentFormattingEditProvider("sql", {
  provideDocumentFormattingEdits: (model) => formatEdits(model.getValue(), model.getFullModelRange()),
});
monaco.languages.registerDocumentRangeFormattingEditProvider("sql", {
  provideDocumentRangeFormattingEdits: (model, range) => {
    // Whole lines, so a statement is never cut in the middle of a word.
    const lines = new monaco.Range(range.startLineNumber, 1, range.endLineNumber, model.getLineMaxColumn(range.endLineNumber));
    return formatEdits(model.getValueInRange(lines), lines);
  },
});

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

  useEffect(() => () => registerEditor(null), []);

  return (
    // The app's own menu instead of Monaco's, whose VS Code entries
    // (Command Palette, Change All Occurrences) do not belong here.
    <ContextMenu onOpenChange={(open) => open && setSelected(hasSelection())}>
      <ContextMenuTrigger asChild>
        <div className="h-full">
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
            }}
            theme={editorThemeName(theme)}
            options={{
              fontFamily: options.fontFamily,
              fontSize: options.fontSize,
              minimap: { enabled: options.minimap },
              wordWrap: options.wordWrap ? "on" : "off",
              lineNumbers: options.lineNumbers ? "on" : "off",
              scrollBeyondLastLine: false,
              renderLineHighlight: "line",
              automaticLayout: true,
              tabSize: options.tabSize,
              padding: { top: 8 },
              contextmenu: false,
            }}
            onMount={(editor) => {
              registerEditor(editor);
              editor.focus();
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
          <Play className="text-emerald-500" /> Execute <ContextMenuShortcut>{executeKey}</ContextMenuShortcut>
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
