// The single Monaco editor shared by all Query Tabs (one model per tab),
// reachable from shortcuts and the Messages panel without prop drilling.
import type { editor } from "monaco-editor";
import type { Script } from "@/stores/queries";

let current: editor.IStandaloneCodeEditor | null = null;

export function registerEditor(instance: editor.IStandaloneCodeEditor | null) {
  current = instance;
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

/** Monaco keeps models after the editor switches path; free a closed tab's. */
export async function disposeModel(tabId: string) {
  const { monaco } = await import("@/lib/monaco");
  monaco.editor.getModel(monaco.Uri.parse(tabId))?.dispose();
}
