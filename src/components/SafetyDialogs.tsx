import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ScriptCheck } from "@/lib/api";
import { revealLine } from "@/lib/editor";
import { useDialogs } from "@/stores/dialogs";

const KIND_LABELS: Record<ScriptCheck["findings"][number]["kind"], string> = {
  updateWithoutWhere: "UPDATE without WHERE",
  deleteWithoutWhere: "DELETE without WHERE",
  truncate: "TRUNCATE TABLE",
  drop: "DROP",
  alterTable: "ALTER TABLE",
};

export function SafetyDialogs() {
  const { destructive, transactions } = useDialogs();

  return (
    <>
      <Dialog open={!!destructive} onOpenChange={(open) => !open && destructive?.resolve(false)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-500">
              <TriangleAlert className="size-5" /> Destructive statements on Production
            </DialogTitle>
            <DialogDescription>
              {destructive?.tabTitle} is connected to <strong>{destructive?.connectionName}</strong>, a Production
              server. Check these before running:
            </DialogDescription>
          </DialogHeader>
          <ul className="max-h-64 space-y-1 overflow-auto rounded border p-2 font-mono text-xs">
            {destructive?.check.findings.map((finding, index) => (
              <li key={index}>
                <button
                  className="w-full rounded px-1.5 py-1 text-left hover:bg-accent"
                  title="Show in the editor"
                  onClick={() => revealLine(finding.line)}
                >
                  <span className="text-muted-foreground">Line {finding.line}</span>
                  {" · "}
                  <span className="text-red-500">{KIND_LABELS[finding.kind]}</span>
                  {" · "}
                  {finding.target}
                </button>
              </li>
            ))}
            {destructive?.check.uncertain && (
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
          <ul className="space-y-1 text-sm">
            {transactions?.tabs.map((tab, index) => (
              <li key={index} className="flex justify-between rounded border px-2 py-1">
                <span>{tab.title}</span>
                <span className="text-muted-foreground">
                  {tab.openTransactions} open transaction{tab.openTransactions === 1 ? "" : "s"}
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
    </>
  );
}
