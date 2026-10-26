// Loaded lazily: importing it pulls in Monaco.
import { useEffect, useState } from "react";
import Editor from "@monaco-editor/react";
import { Play } from "lucide-react";
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
import { openQueryFromContext } from "@/lib/shortcuts";

registerMonaco(monaco);

// Transparent background so the Mica effect shows through, as elsewhere.
monaco.editor.defineTheme("querydeck-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: { "editor.background": "#00000000", "editorGutter.background": "#00000000" },
});
monaco.editor.defineTheme("querydeck-light", {
  base: "vs",
  inherit: true,
  rules: [],
  colors: { "editor.background": "#00000000", "editorGutter.background": "#00000000" },
});

function useDarkMode() {
  const query = "(prefers-color-scheme: dark)";
  const [dark, setDark] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setDark(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return dark;
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
  const dark = useDarkMode();
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
            theme={dark ? "querydeck-dark" : "querydeck-light"}
            options={{
              fontFamily: "'Cascadia Code', Consolas, monospace",
              fontSize: 13,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              renderLineHighlight: "line",
              automaticLayout: true,
              tabSize: 4,
              padding: { top: 8 },
              contextmenu: false,
            }}
            onMount={(editor) => {
              registerEditor(editor);
              editor.focus();
              const { KeyCode, KeyMod } = monaco;
              editor.addAction({
                id: "querydeck.execute",
                label: "Execute",
                keybindings: [KeyCode.F5, KeyMod.CtrlCmd | KeyCode.KeyE],
                run: execute,
              });
              editor.addAction({
                id: "querydeck.cancel",
                label: "Cancel Executing Query",
                keybindings: [KeyMod.Alt | KeyCode.PauseBreak],
                run: () => {
                  const { activeId, cancel } = useQueries.getState();
                  if (activeId) void cancel(activeId);
                },
              });
              editor.addAction({
                id: "querydeck.newQuery",
                label: "New Query",
                keybindings: [KeyMod.CtrlCmd | KeyCode.KeyN],
                run: () => openQueryFromContext(),
              });
            }}
          />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent
        className="w-52"
        // Keep the keyboard in the editor, not on the menu's trigger.
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          focusEditor();
        }}
      >
        <ContextMenuItem onSelect={execute}>
          <Play className="text-emerald-500" /> Execute <ContextMenuShortcut>F5</ContextMenuShortcut>
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
      </ContextMenuContent>
    </ContextMenu>
  );
}
