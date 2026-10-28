import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useSqlcmdConfirmation } from "@/stores/sqlcmd";
export function SqlcmdConfirmation() {
  const { pending, answer } = useSqlcmdConfirmation();
  return (
    <Dialog open={!!pending} onOpenChange={(open) => !open && answer(false)}>
      <DialogContent className="flex max-h-[90vh] max-w-4xl flex-col">
        <DialogHeader>
          <DialogTitle>Review expanded SQLCMD script</DialogTitle>
          <DialogDescription>
            {pending?.localCommands
              ? "This script includes local commands or file writes. Confirming authorizes those exact operations as well as the SQL batches and target switches below."
              : "Includes and variables have been expanded. Confirm the batches and server switches before execution."}
          </DialogDescription>
        </DialogHeader>
        <pre className="min-h-0 flex-1 overflow-auto rounded border bg-background p-3 font-mono text-xs select-text">
          {pending?.script}
        </pre>
        <DialogFooter>
          <Button variant="outline" onClick={() => answer(false)}>
            Cancel
          </Button>
          <Button onClick={() => answer(true)}>
            Confirm and execute SQLCMD
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
