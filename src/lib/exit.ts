// What must happen before Quervio goes away, whether the window closes or
// an update restarts it: running operations are confirmed, the tabs are
// saved (they come back on the next start) and open transactions settled.
import { ask } from "@tauri-apps/plugin-dialog";
import { management } from "@/lib/management-api";
import { saveNow } from "@/lib/session-restore";
import { useOperations } from "@/stores/operations";
import { useQueries } from "@/stores/queries";

/** False when the user chose to keep working. */
export async function settleBeforeExit(action = "close Quervio"): Promise<boolean> {
  const operations = Object.values(useOperations.getState().running);
  if (
    operations.length &&
    !(await ask(`${operations.length} operation(s) are still running. Cancel them and ${action}?`, {
      title: "Operations in progress",
      kind: "warning",
      okLabel: `Cancel operations and ${action}`,
      cancelLabel: "Keep working",
    }))
  )
    return false;
  if (!(await saveNow()) && !(await ask(
    "Query tabs could not be saved for recovery. Save your SQL files before closing, or continue without saving the recovery snapshot.",
    { title: "Query tabs not saved", kind: "warning", okLabel: "Continue without recovery", cancelLabel: "Keep working" },
  ))) return false;
  if (!(await useQueries.getState().settleAllTransactions())) return false;
  await management.shutdown();
  return true;
}
