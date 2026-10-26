// Monaco bundled locally (no CDN) and handed to @monaco-editor/react.
// Imported only from the lazily loaded editor chunk, so it never delays the
// first paint.
import * as monaco from "@/lib/monaco-core.js";
import EditorWorker from "@/lib/editor.worker?worker";
import { PasteAction } from "monaco-esm/editor/contrib/clipboard/browser/clipboard.js";
import { loader } from "@monaco-editor/react";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { editorHasTextFocus, pasteIntoEditor } from "@/lib/editor";

self.MonacoEnvironment = {
  // Only SQL is edited, so the generic editor worker is the only one needed.
  getWorker: () => new EditorWorker(),
};

// Paste from the context menu reads the clipboard with
// navigator.clipboard, which WebView2 refuses here; read it through the
// clipboard plugin instead. Ctrl+V is a native paste and never gets here.
// Absent in a plain browser and in the dev mock.
if ((window as { __TAURI_INTERNALS__?: { metadata?: unknown } }).__TAURI_INTERNALS__?.metadata) {
  PasteAction?.addImplementation(20000, "tauri-clipboard", () => {
    if (!editorHasTextFocus()) return false;
    return readText().then((text) => {
      if (text) pasteIntoEditor(text);
    });
  });
}

loader.config({ monaco });

export { monaco };
