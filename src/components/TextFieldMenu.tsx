import { useRef, useState, type ReactNode } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { toast } from "@/components/ui/basic-toast";
import { errorMessage } from "@/lib/api";

type Field = HTMLInputElement | HTMLTextAreaElement;

/** The app's text menu, including fields rendered inside a portalled dialog. */
export function TextFieldMenu({ children }: { children: ReactNode }) {
  const field = useRef<Field | null>(null);
  const range = useRef<[number, number] | null>(null);
  const selectedText = useRef("");
  const [state, setState] = useState({ selected: false, writable: false, hasText: false, undo: false, redo: false });

  function rememberSelection() {
    const input = field.current;
    range.current = input?.selectionStart != null && input.selectionEnd != null
      ? [input.selectionStart, input.selectionEnd]
      : null;
    // Number inputs do not expose selectionStart/selectionEnd, but Chromium
    // still exposes their selected text through the document selection.
    selectedText.current = !input || input.type === "password" ? ""
      : range.current ? input.value.slice(...range.current) : window.getSelection()?.toString() ?? "";
  }

  function restoreSelection() {
    const input = field.current;
    if (!input?.isConnected) return;
    input.focus({ preventScroll: true });
    if (range.current) input.setSelectionRange(...range.current);
  }

  function command(name: string, text?: string) {
    restoreSelection();
    // Unlike assigning .value, native editing preserves Undo and emits the
    // input event used by React's controlled fields to update their state.
    document.execCommand(name, false, text);
    rememberSelection();
  }

  async function clipboard(kind: "cut" | "copy" | "paste") {
    const input = field.current;
    if (!input?.isConnected) return;
    const value = input.value;
    const textToCopy = selectedText.current;
    try {
      if (kind === "paste") {
        const text = isTauri() ? await readText() : await navigator.clipboard.readText();
        if (text !== null && input.isConnected && input.value === value && !input.readOnly && !input.disabled) {
          command("insertText", text);
        }
      } else {
        // A password may be replaced or selected, but never copied out.
        if (input.type === "password" || !textToCopy) return;
        const text = textToCopy;
        if (isTauri()) await writeText(text);
        else await navigator.clipboard.writeText(text);
        if (kind === "cut" && input.isConnected && input.value === value && !input.readOnly && !input.disabled) command("delete");
      }
    } catch (error) {
      toast.error("Clipboard error", { description: errorMessage(error) });
    }
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger
        asChild
        onContextMenu={(event) => {
          const input = event.currentTarget as Field;
          field.current = input;
          input.focus({ preventScroll: true });
          rememberSelection();
          setState({
            selected: selectedText.current.length > 0,
            writable: !input.readOnly && !input.disabled,
            hasText: input.value.length > 0,
            undo: document.queryCommandEnabled("undo"),
            redo: document.queryCommandEnabled("redo"),
          });
        }}
        onKeyDown={(event) => {
          if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          event.currentTarget.dispatchEvent(new MouseEvent("contextmenu", {
            bubbles: true, cancelable: true, clientX: rect.left + 12, clientY: rect.bottom,
          }));
        }}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-52" onCloseAutoFocus={(event) => {
        event.preventDefault();
        restoreSelection();
      }}>
        <ContextMenuItem disabled={!state.writable || !state.undo} onSelect={() => command("undo")}>
          Undo <ContextMenuShortcut>Ctrl+Z</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem disabled={!state.writable || !state.redo} onSelect={() => command("redo")}>
          Redo <ContextMenuShortcut>Ctrl+Y</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!state.writable || !state.selected} onSelect={() => void clipboard("cut")}>
          Cut <ContextMenuShortcut>Ctrl+X</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem disabled={!state.selected} onSelect={() => void clipboard("copy")}>
          Copy <ContextMenuShortcut>Ctrl+C</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem disabled={!state.writable} onSelect={() => void clipboard("paste")}>
          Paste <ContextMenuShortcut>Ctrl+V</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!state.hasText} onSelect={() => {
          field.current?.select();
          rememberSelection();
        }}>
          Select All <ContextMenuShortcut>Ctrl+A</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
