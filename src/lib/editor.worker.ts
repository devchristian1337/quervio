// Monaco's generic editor worker. Kept as our own entry so Vite's dev
// pre-bundling never strips the `?worker` import that loads it.
import "monaco-esm/editor/editor.worker.js";
