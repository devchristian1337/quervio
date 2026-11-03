import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, errorMessage } from "@/lib/api";
import { useSettings } from "@/stores/settings";

/**
 * An indented copy of JSON and XML, or null for anything else. Only to look
 * at: JSON.parse rounds 12345678901234567890 and drops the 0 of 1.10, so the
 * original text stays what is shown first and what is copied.
 */
function pretty(text: string): { text: string; kind: string } | null {
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
  return null;
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

  const maxCellMB = useSettings((s) => s.settings.query.maxCellMB);
  const [formatted, setFormatted] = useState(false);
  const original = state.status === "ready" ? state.text : null;
  const indented = useMemo(() => (original !== null ? pretty(original) : null), [original]);
  const shown = formatted && indented ? indented.text : original;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="wrap-anywhere">{columnName || "(No column name)"}</DialogTitle>
          <DialogDescription>
            Row {row + 1}
            {indented && (formatted ? ` · formatted as ${indented.kind}` : ` · ${indented.kind}`)}
            {state.status === "ready" && state.clipped && ` · value cut at ${maxCellMB.toLocaleString()} MB`}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-auto rounded border bg-muted/30 p-3 select-text">
          {state.status === "loading" && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
          {state.status === "error" && <p className="text-sm text-destructive">{state.error}</p>}
          {state.status === "ready" &&
            (shown !== null ? (
              <pre className="font-mono text-xs whitespace-pre-wrap break-all">{shown}</pre>
            ) : (
              <p className="font-mono text-xs text-muted-foreground">NULL</p>
            ))}
        </div>
        {original !== null && (
          <div className="flex justify-end gap-2">
            {indented && (
              <Button variant="outline" aria-pressed={formatted} onClick={() => setFormatted((on) => !on)}>
                {formatted ? "Show original" : "Format"}
              </Button>
            )}
            {/* The value as stored, even while the indented copy is shown. */}
            <CopyButton text={original} label="Copy the value" variant="outline">
              Copy
            </CopyButton>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
