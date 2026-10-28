import { FolderOpen, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/flexnative-tooltip";
import { displayName, type SavedConnection } from "@/lib/api";
import { useShortcutLabel, type CommandId } from "@/lib/commands";
import { ENVIRONMENTS } from "@/lib/environment";
import { openFile } from "@/lib/files";
import { cn } from "@/lib/utils";
import { useConnections } from "@/stores/connections";
import { useConnectDialog } from "@/stores/dialogs";
import { useQueries } from "@/stores/queries";

// Q Prisma v2 (design/branding); the transparent cut keeps its centre open on any theme.
import prisma from "@/assets/quervio-q-prisma-v2-trasparente.png";

/** The keys worth learning first, in the order a session uses them. */
const FIRST_SHORTCUTS: CommandId[] = ["newQuery", "execute", "openFile", "format", "toggleResults", "settings"];

/**
 * What the workspace shows with no Query Tab open: the Saved Connections, each
 * one click from a new query, and the first shortcuts to learn.
 */
export function StartScreen() {
  const { connections, loaded } = useConnections();
  const showConnect = useConnectDialog((s) => s.show);

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-10 pt-12 pb-10">
        <header className="flex items-center gap-4">
          <img src={prisma} alt="" className="size-12 object-contain select-none" draggable={false} />
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold tracking-tight">Quervio</h1>
            <p className="text-muted-foreground">
              {connections.length === 0
                ? "Add a SQL Server to start writing queries."
                : `${connections.length} saved ${connections.length === 1 ? "connection" : "connections"}. Open a query on one.`}
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={() => showConnect()}>
            <Plus /> New connection
          </Button>
        </header>

        <section aria-labelledby="start-connections">
          <h2 id="start-connections" className="mb-2 text-sm font-medium">
            Connections
          </h2>
          {loaded && connections.length === 0 ? (
            <div className="flex items-center justify-between gap-4 rounded-md border border-dashed px-4 py-3">
              <span className="text-muted-foreground">No saved connections yet.</span>
              <Button size="sm" onClick={() => showConnect()}>
                <Plus /> New connection
              </Button>
            </div>
          ) : (
            <ul className="border-t">
              {connections.map((connection) => (
                <ConnectionRow key={connection.id} connection={connection} />
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="start-shortcuts">
          <h2 id="start-shortcuts" className="mb-2 text-sm font-medium">
            Shortcuts
          </h2>
          <dl className="grid grid-cols-2 gap-x-10 border-t pt-2">
            {FIRST_SHORTCUTS.map((id) => (
              <Shortcut key={id} id={id} />
            ))}
          </dl>
        </section>
      </div>
    </div>
  );
}

function ConnectionRow({ connection }: { connection: SavedConnection }) {
  const newQueryKey = useShortcutLabel("newQuery");
  const environment = ENVIRONMENTS[connection.environment];
  const user = connection.authentication.kind === "sql" ? connection.authentication.userName : "Windows";
  const details = [connection.server, user, connection.defaultDatabase].filter(Boolean).join(" · ");
  const newQuery = () => void useQueries.getState().open(connection.id, connection.defaultDatabase);

  return (
    <li className="group flex h-14 items-center gap-3 border-b px-1" onDoubleClick={newQuery}>
      <span className={cn("size-2 shrink-0 rounded-full", environment.dot)} />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{displayName(connection)}</div>
        <div className="truncate text-xs text-muted-foreground">{details}</div>
      </div>
      <span className="w-24 shrink-0 text-xs text-muted-foreground">{environment.label}</span>
      <Tip label={`Open a script on ${displayName(connection)}`}>
        <Button
          size="icon"
          variant="ghost"
          className="size-8 text-muted-foreground"
          aria-label={`Open a script on ${displayName(connection)}`}
          onClick={() =>
            void openFile({ connectionId: connection.id, database: connection.defaultDatabase })
          }
        >
          <FolderOpen />
        </Button>
      </Tip>
      <Tip label={`New query on ${displayName(connection)} (${newQueryKey})`}>
        <Button
          size="sm"
          variant="ghost"
          className="text-primary hover:text-primary"
          onClick={newQuery}
        >
          <Plus /> New query
        </Button>
      </Tip>
    </li>
  );
}

function Shortcut({ id }: { id: CommandId }) {
  const key = useShortcutLabel(id);
  const labels: Partial<Record<CommandId, string>> = {
    newQuery: "New query on the selected server",
    execute: "Execute the script or selection",
    openFile: "Open a .sql file",
    format: "Format the script",
    toggleResults: "Show or hide the results",
    settings: "Settings",
  };
  return (
    <div className="flex h-9 items-center justify-between gap-4">
      <dt className="truncate text-muted-foreground">{labels[id]}</dt>
      <dd>
        <kbd className="rounded border bg-muted/40 px-1.5 py-0.5 font-sans text-xs tabular-nums">{key}</kbd>
      </dd>
    </div>
  );
}
