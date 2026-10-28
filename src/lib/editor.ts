// The single Monaco editor shared by all Query Tabs (one model per tab),
// reachable from shortcuts and the Messages panel without prop drilling.
import type * as Monaco from "monaco-editor";
import type { editor } from "monaco-editor";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { Script } from "@/stores/queries";

let current: editor.IStandaloneCodeEditor | null = null;
let monaco: typeof Monaco | null = null;

export function registerEditor(instance: editor.IStandaloneCodeEditor | null) {
  current = instance;
}

export function registerMonaco(api: typeof Monaco) {
  monaco = api;
}

// The editor's context menu clipboard commands. Monaco's own read the
// clipboard with navigator.clipboard, which WebView2 refuses, and only run
// while the editor has the keyboard focus, which the menu has taken.

export function hasSelection(): boolean {
  return !(current?.getSelection()?.isEmpty() ?? true);
}

export async function copySelection() {
  const selection = current?.getSelection();
  const model = current?.getModel();
  if (!selection || selection.isEmpty() || !model) return;
  await writeText(model.getValueInRange(selection));
}

export async function cutSelection() {
  const selection = current?.getSelection();
  if (!current || !selection || selection.isEmpty()) return;
  await copySelection();
  current.executeEdits("cut", [{ range: selection, text: "" }]);
  current.pushUndoStop();
  current.focus();
}

export async function pasteClipboard() {
  const text = inTauri() ? await readText() : await navigator.clipboard.readText();
  if (!current || !text) return;
  current.focus();
  current.trigger("keyboard", "paste", { text });
}

export function selectAll() {
  const model = current?.getModel();
  if (!current || !model) return;
  current.setSelection(model.getFullModelRange());
  current.focus();
}

/** Monaco's Format Selection or Format Document (see SqlEditor.tsx). */
export function formatInEditor(selectionOnly: boolean) {
  current?.focus();
  void current?.getAction(selectionOnly ? "editor.action.formatSelection" : "editor.action.formatDocument")?.run();
}

// Absent in a plain browser and in the dev mock.
function inTauri() {
  return Boolean((window as { __TAURI_INTERNALS__?: { metadata?: unknown } }).__TAURI_INTERNALS__?.metadata);
}

/** The selection when there is one, otherwise the whole script. */
export function currentScript(): Script | null {
  const model = current?.getModel();
  if (!current || !model) return null;
  const selection = current.getSelection();
  if (selection && !selection.isEmpty()) {
    return { text: model.getValueInRange(selection), baseLine: selection.startLineNumber - 1 };
  }
  return { text: model.getValue(), baseLine: 0 };
}

/** A tab's text, if its editor model exists yet (it does once shown). */
export function modelText(tabId: string): string | null {
  return monaco?.editor.getModel(monaco.Uri.parse(tabId))?.getValue() ?? null;
}

export function revealLine(line: number) {
  if (!current) return;
  current.revealLineInCenter(line);
  current.setPosition({ lineNumber: line, column: 1 });
  current.setSelection({ startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 });
  current.focus();
}

export function focusEditor() {
  current?.focus();
}

export function insertText(text: string, snippet = false) {
  if (!current) return;
  current.focus();
  if (snippet) {
    const controller = current.getContribution("snippetController2") as {insert: (template: string) => void} | null;
    controller?.insert(text);
  } else {
    const range = current.getSelection();
    if (range) current.executeEdits("template", [{range, text}]);
    current.pushUndoStop();
  }
}

/** Search the active Query Tab even when a toolbar or results panel has focus. */
export function findInEditor() {
  current?.focus();
  void current?.getAction("actions.find")?.run();
}

/** Monaco keeps models after the editor switches path; free a closed tab's. */
export function disposeModel(tabId: string) {
  monaco?.editor.getModel(monaco.Uri.parse(tabId))?.dispose();
}
