import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/flexnative-tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { ScriptCheck } from "@/lib/api";
import { revealLine } from "@/lib/editor";
import { useDialogs, useNamePrompt } from "@/stores/dialogs";

const KIND_LABELS: Record<ScriptCheck["findings"][number]["kind"], string> = {
  updateWithoutWhere: "UPDATE without WHERE",
  deleteWithoutWhere: "DELETE without WHERE",
  truncate: "TRUNCATE TABLE",
  drop: "DROP",
  alterTable: "ALTER TABLE",
};

const numberFormat = new Intl.NumberFormat();

/**
 * The last request that was open: the store clears it as the dialog closes,
 * and the dialog keeps showing it while it animates out. Actions use the live one.
 */
function useLastOpen<T>(value: T | null): T | null {
  const [last, setLast] = useState(value);
  if (value !== null && value !== last) setLast(value);
  return value ?? last;
}

export function SafetyDialogs() {
  const { destructive, transactions, unsaved, deleteConnection } = useDialogs();
  const shownDestructive = useLastOpen(destructive);
  const shownTransactions = useLastOpen(transactions);
  const shownUnsaved = useLastOpen(unsaved);
  const shownDeleteConnection = useLastOpen(deleteConnection);
  const findings = shownDestructive?.check.findings ?? [];

  return (
    <>
      <Dialog open={!!destructive} onOpenChange={(open) => !open && destructive?.resolve(false)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-500">
              <TriangleAlert className="size-5" /> Destructive statements on Production
            </DialogTitle>
            <DialogDescription>
              {shownDestructive?.tabTitle} is connected to <strong>{shownDestructive?.connectionName}</strong>, a
              Production server. Check{" "}
              {findings.length === 0
                ? "the script"
                : findings.length === 1
                  ? "this statement"
                  : `these ${numberFormat.format(findings.length)} statements`}{" "}
              before running:
            </DialogDescription>
          </DialogHeader>
          <ul className="max-h-64 space-y-1 overflow-auto rounded border p-2 font-mono text-xs">
            {findings.map((finding, index) => (
              <li key={index}>
                <Tip label="Show in the editor" side="right">
                  <button
                    // A long schema.table target wraps instead of scrolling the list sideways.
                    className="w-full rounded px-1.5 py-1 text-left wrap-anywhere hover:bg-accent"
                    onClick={() => revealLine(finding.line)}
                  >
                    <span className="text-muted-foreground">Line {finding.line}</span>
                    {" · "}
                    <span className="text-red-500">{KIND_LABELS[finding.kind]}</span>
                    {" · "}
                    {finding.target}
                  </button>
                </Tip>
              </li>
            ))}
            {shownDestructive?.check.uncertain && (
              <li className="px-1.5 py-1 text-amber-500">
                Part of the script could not be checked (an unterminated string or comment).
              </li>
            )}
          </ul>
          <DialogFooter>
            {/* Cancel takes the focus, so Enter never runs the script by accident. */}
            <Button autoFocus variant="outline" onClick={() => destructive?.resolve(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => destructive?.resolve(true)}>
              Run anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!transactions} onOpenChange={(open) => !open && transactions?.resolve("cancel")}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-500">
              <TriangleAlert className="size-5" /> Open transactions
            </DialogTitle>
            <DialogDescription>
              Closing ends the session. Commit or roll back its open transactions first.
            </DialogDescription>
          </DialogHeader>
          <ul className="max-h-64 space-y-1 overflow-auto text-sm">
            {shownTransactions?.tabs.map((tab, index) => (
              <li key={index} className="flex justify-between gap-3 rounded border px-2 py-1">
                <span className="min-w-0 truncate" title={tab.title}>
                  {tab.title}
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {numberFormat.format(tab.openTransactions)} open transaction{tab.openTransactions === 1 ? "" : "s"}
                </span>
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button autoFocus variant="outline" onClick={() => transactions?.resolve("cancel")}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => transactions?.resolve("rollback")}>
              Roll back
            </Button>
            <Button onClick={() => transactions?.resolve("commit")}>Commit</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!unsaved} onOpenChange={(open) => !open && unsaved?.resolve("cancel")}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Save changes to {shownUnsaved?.title}?</DialogTitle>
            <DialogDescription>Your changes are lost if you close without saving.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button autoFocus variant="outline" onClick={() => unsaved?.resolve("cancel")}>
              Cancel
            </Button>
            <Button variant="ghost" onClick={() => unsaved?.resolve("discard")}>
              Don't save
            </Button>
            <Button onClick={() => unsaved?.resolve("save")}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteConnection} onOpenChange={(open) => !open && deleteConnection?.resolve(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {shownDeleteConnection?.name}?</DialogTitle>
            <DialogDescription>
              Quervio forgets this connection and its saved password. The server and its databases are not
              touched.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button autoFocus variant="outline" onClick={() => deleteConnection?.resolve(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => deleteConnection?.resolve(true)}>
              Delete connection
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <NamePrompt />
    </>
  );
}

/** A name to type, such as a connection group's (useNamePrompt). */
function NamePrompt() {
  const request = useNamePrompt((s) => s.request);
  const shown = useLastOpen(request);
  const [name, setName] = useState("");
  // Only on opening: the name stays in the field while the dialog closes.
  useEffect(() => {
    if (request) setName(request.value ?? "");
  }, [request]);
  const trimmed = name.trim();
  return (
    <Dialog open={!!request} onOpenChange={(open) => !open && request?.resolve(null)}>
      <DialogContent className="sm:max-w-md">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed) request?.resolve(trimmed);
          }}
        >
          <DialogHeader>
            <DialogTitle>{shown?.title}</DialogTitle>
            <DialogDescription>{shown?.description}</DialogDescription>
          </DialogHeader>
          <Input autoFocus aria-label="Name" value={name} onChange={(event) => setName(event.target.value)} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => request?.resolve(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!trimmed}>
              {shown?.confirm}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
