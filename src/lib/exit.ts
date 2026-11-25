// What must happen before Quervio goes away, whether the window closes or
// an update restarts it: running operations are confirmed, the tabs are
// saved (they come back on the next start) and open transactions settled.
import { ask } from "@tauri-apps/plugin-dialog";
import { management } from "@/lib/management-api";
import { saveNow } from "@/lib/session-restore";
import { useOperations } from "@/stores/operations";
import { useQueries } from "@/stores/queries";
import { flushSettings } from "@/stores/settings";

let inFlight: Promise<boolean> | null = null;

/** False when the user chose to keep working. Re-entrant calls share one flow. */
export function settleBeforeExit(action = "close Quervio"): Promise<boolean> {
  if (inFlight) return inFlight;
  const run = (async () => {
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
    await flushSettings();
    await management.shutdown();
    return true;
  })();
  const pending = run.finally(() => {
    if (inFlight === pending) inFlight = null;
  });
  inFlight = pending;
  return pending;
}
