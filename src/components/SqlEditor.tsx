// Loaded lazily: importing it pulls in Monaco.
import { useEffect, useState } from "react";
import Editor from "@monaco-editor/react";
import { monaco } from "@/lib/monaco";
import { currentScript, registerEditor, registerMonaco } from "@/lib/editor";
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

export default function SqlEditor({ tabId, initialText }: { tabId: string; initialText: string }) {
  const dark = useDarkMode();

  useEffect(() => () => registerEditor(null), []);

  return (
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
      }}
      onMount={(editor) => {
        registerEditor(editor);
        editor.focus();
        const { KeyCode, KeyMod } = monaco;
        const execute = () => {
          const { activeId, execute } = useQueries.getState();
          const script = currentScript();
          if (activeId && script) void execute(activeId, script);
        };
        editor.addAction({
          id: "querydeck.execute",
          label: "Execute",
          // The menu shows the last one.
          keybindings: [KeyMod.CtrlCmd | KeyCode.KeyE, KeyCode.F5],
          // First in the editor's context menu, as in SSMS.
          contextMenuGroupId: "navigation",
          contextMenuOrder: 0,
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
  );
}
