// Monaco bundled locally (no CDN) and handed to @monaco-editor/react.
// Imported only from the lazily loaded editor chunk, so it never delays the
// first paint.
import * as monaco from "@/lib/monaco-core.js";
import EditorWorker from "@/lib/editor.worker?worker";
import { loader } from "@monaco-editor/react";

self.MonacoEnvironment = {
  // Only SQL is edited, so the generic editor worker is the only one needed.
  getWorker: () => new EditorWorker(),
};
loader.config({ monaco });

export { monaco };
