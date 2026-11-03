import { FolderOpen, Import, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/flexnative-tooltip";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { displayName, type SavedConnection } from "@/lib/api";
import { useShortcutLabel, type CommandId } from "@/lib/commands";
import { ENVIRONMENTS } from "@/lib/environment";
import { openFile } from "@/lib/files";
import { cn } from "@/lib/utils";
import { byGroup, useConnections } from "@/stores/connections";
import { useConnectDialog, useSsmsImportDialog } from "@/stores/dialogs";
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
  const showImport = useSsmsImportDialog((s) => s.show);

  return (
    <ScrollFade className="min-h-0 flex-1">
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
        </header>

        <section aria-labelledby="start-connections">
          {/* The actions sit on the list they add to; with no list yet, the empty
              box below carries them, so they show once either way. */}
          <div className="mb-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <h2 id="start-connections" className="text-sm font-medium">
              Connections
            </h2>
            {connections.length > 0 && (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => showImport()}>
                  <Import /> Import from SSMS
                </Button>
                <Button size="sm" variant="outline" onClick={() => showConnect()}>
                  <Plus /> New connection
                </Button>
              </div>
            )}
          </div>
          {loaded && connections.length === 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-md border border-dashed px-4 py-3">
              <span className="text-muted-foreground">No saved connections yet.</span>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => showImport()}>
                  <Import /> Import from SSMS
                </Button>
                <Button size="sm" onClick={() => showConnect()}>
                  <Plus /> New connection
                </Button>
              </div>
            </div>
          ) : (
            byGroup(connections).map(({ group, connections: inGroup }) => (
              // A group, so the scroll fade shrinks and blurs row by row, not the whole list.
              <ul key={group ?? ""} role="group" aria-label={group ?? "Ungrouped"} className="@container border-t">
                {/* Wraps rather than truncates: nested SSMS groups differ at the end. */}
                {group !== null && (
                  <li className="flex min-h-8 items-end px-1 pt-2 pb-1 text-xs font-medium text-muted-foreground">{group}</li>
                )}
                {inGroup.map((connection) => (
                  <ConnectionRow key={connection.id} connection={connection} />
                ))}
              </ul>
            ))
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
    </ScrollFade>
  );
}

function ConnectionRow({ connection }: { connection: SavedConnection }) {
  const newQueryKey = useShortcutLabel("newQuery");
  const environment = ENVIRONMENTS[connection.environment];
  const name = displayName(connection);
  const { authentication } = connection;
  const user =
    authentication.kind === "sql" ? authentication.userName : authentication.kind === "entra" ? "Microsoft Entra" : "Windows";
  // The login and database, which tell apart two connections to one server.
  const rest = [user, connection.defaultDatabase].filter(Boolean).join(" · ");
  const newQuery = () => void useQueries.getState().open(connection.id, connection.defaultDatabase);

  return (
    // Off-screen rows skip layout, so a desk with a thousand servers still scrolls.
    <li
      className="group flex h-14 items-center gap-3 border-b px-1 [contain-intrinsic-size:auto_3.5rem] [content-visibility:auto]"
      onDoubleClick={newQuery}
    >
      <span className={cn("size-2 shrink-0 rounded-full", environment.dot)} />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium" title={name}>
          {name}
        </div>
        {/* The server gives way first; the login and database keep up to 3/5. */}
        <div className="flex gap-1 text-xs text-muted-foreground" title={[connection.server, rest].filter(Boolean).join(" · ")}>
          <span className="min-w-0 truncate">{connection.server}</span>
          {rest && <span className="max-w-3/5 shrink-0 truncate">· {rest}</span>}
        </div>
      </div>
      {/* In a narrow workspace the dot alone shows the Environment. */}
      <span className="w-24 shrink-0 text-xs text-muted-foreground @max-md:sr-only">{environment.label}</span>
      <Tip label={`Open a script on ${name}`}>
        <Button
          size="icon"
          variant="ghost"
          className="size-8 text-muted-foreground"
          aria-label={`Open a script on ${name}`}
          onClick={() =>
            void openFile({ connectionId: connection.id, database: connection.defaultDatabase })
          }
        >
          <FolderOpen />
        </Button>
      </Tip>
      <Tip label={`New query on ${name}${newQueryKey ? ` (${newQueryKey})` : ""}`}>
        <Button
          size="sm"
          variant="ghost"
          className="text-primary hover:text-primary"
          aria-label={`New query on ${name}`}
          onClick={newQuery}
        >
          <Plus /> <span className="@max-sm:sr-only">New query</span>
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
      <dt className="truncate text-muted-foreground" title={labels[id]}>
        {labels[id]}
      </dt>
      <dd>
        {/* Every key can be removed in Settings. */}
        {key ? (
          <kbd className="rounded border bg-muted/40 px-1.5 py-0.5 font-sans text-xs tabular-nums">{key}</kbd>
        ) : (
          <span className="text-xs whitespace-nowrap text-muted-foreground">Not set</span>
        )}
      </dd>
    </div>
  );
}
