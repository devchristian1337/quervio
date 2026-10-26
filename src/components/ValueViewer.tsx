import { useEffect, useState } from "react";
import { Copy, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";

/** Indents JSON and XML; anything else is shown as it is. */
function pretty(text: string): { text: string; kind: string | null } {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return { text: JSON.stringify(JSON.parse(trimmed), null, 2), kind: "JSON" };
    } catch {
      // Not JSON after all.
    }
  }
  if (trimmed.startsWith("<")) {
    const document = new DOMParser().parseFromString(trimmed, "application/xml");
    if (!document.querySelector("parsererror")) return { text: indentXml(trimmed), kind: "XML" };
  }
  return { text, kind: null };
}

function indentXml(xml: string) {
  let depth = 0;
  return xml
    .replace(/>\s*</g, ">\n<")
    .split("\n")
    .map((line) => {
      if (/^<\//.test(line)) depth = Math.max(0, depth - 1);
      const indented = "  ".repeat(depth) + line;
      if (/^<[^!?/][^>]*[^/]>$/.test(line) && !/<\/[^>]+>$/.test(line)) depth++;
      return indented;
    })
    .join("\n");
}

interface Props {
  tabId: string;
  set: number;
  row: number;
  column: number;
  columnName: string;
  onClose: () => void;
}

export function ValueViewer({ tabId, set, row, column, columnName, onClose }: Props) {
  const [state, setState] = useState<
    { status: "loading" } | { status: "ready"; text: string | null; clipped: boolean } | { status: "error"; error: string }
  >({ status: "loading" });

  useEffect(() => {
    api
      .resultCell(tabId, set, row, column)
      .then((cell) => setState({ status: "ready", text: cell?.text ?? null, clipped: cell?.clipped ?? false }))
      .catch((error) => setState({ status: "error", error: errorMessage(error) }));
  }, [tabId, set, row, column]);

  const shown = state.status === "ready" && state.text !== null ? pretty(state.text) : null;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{columnName || "(No column name)"}</DialogTitle>
          <DialogDescription>
            Row {row + 1}
            {shown?.kind && ` · formatted as ${shown.kind}`}
            {state.status === "ready" && state.clipped && " · value cut at 2 MB"}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-auto rounded border bg-muted/30 p-3">
          {state.status === "loading" && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
          {state.status === "error" && <p className="text-sm text-destructive">{state.error}</p>}
          {state.status === "ready" &&
            (shown ? (
              <pre className="font-mono text-xs whitespace-pre-wrap break-all">{shown.text}</pre>
            ) : (
              <p className="font-mono text-xs text-muted-foreground">NULL</p>
            ))}
        </div>
        {shown && (
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                writeText(shown.text).then(
                  () => toast.success("Value copied"),
                  (error) => toast.error("Copy failed", { description: errorMessage(error) }),
                )
              }
            >
              <Copy /> Copy
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
