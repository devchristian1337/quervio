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
import { cn } from "@/lib/utils";
import { codeClass } from "./shared";
export function SqlcmdConfirmation() {
  const { pending, answer } = useSqlcmdConfirmation();
  const fileAccess = pending?.purpose === "fileAccess";
  return (
    <Dialog open={!!pending} onOpenChange={(open) => !open && answer(false)}>
      <DialogContent className="flex max-h-[90vh] max-w-4xl flex-col">
        <DialogHeader>
          <DialogTitle>{fileAccess ? "Allow SQLCMD include file access?" : "Review expanded SQLCMD script"}</DialogTitle>
          <DialogDescription>
            {fileAccess
              ? "Preparing this script reads its :r include files and any nested includes. Network paths, mapped drives or links may contact remote servers using your Windows identity. Allow file access only if you trust this script. You will review the expanded script separately before anything executes."
              : pending?.localCommands
              ? "This script includes local commands or file writes. Confirming authorizes those exact operations as well as the SQL batches and target switches below."
              : "Includes and variables have been expanded. Confirm the batches and server switches before execution."}
          </DialogDescription>
        </DialogHeader>
        <pre className={cn(codeClass, "min-h-0 flex-1")}>
          {pending?.script}
        </pre>
        <DialogFooter>
          <Button variant="outline" onClick={() => answer(false)}>
            Cancel
          </Button>
          <Button onClick={() => answer(true)}>
            {fileAccess ? "Allow reading include files" : "Confirm and execute SQLCMD"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
