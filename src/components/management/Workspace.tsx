import { lazy, Suspense, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { QueryWorkspace } from "@/components/QueryWorkspace";
import { Button } from "@/components/ui/button";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useConnections } from "@/stores/connections";
import { useQueries } from "@/stores/queries";
import { useExplorer } from "@/stores/explorer";
import {
  TOOL_NAMES,
  useWorkbench,
  type ToolKind,
  type ToolTab,
} from "@/stores/workbench";
import { api, displayName, errorMessage } from "@/lib/api";
import {
  management,
  type Dependency,
  type ServerCapabilities,
} from "@/lib/management-api";
import { cn } from "@/lib/utils";
import { ChevronDown, Wrench, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Choice, Notice } from "./shared";

// The Tools menu, by what each tool is for.
const TOOL_GROUPS: readonly (readonly [string, readonly ToolKind[]])[] = [
  ["Monitoring", ["activity", "queryStore", "events"]],
  ["Design", ["table", "view", "diagram", "properties"]],
  ["Administration", ["backup", "agent", "maintenance", "transfer"]],
  ["Security", ["security", "encryption", "encryptedQuery"]],
  ["Quervio", ["templates", "components"]],
];

const Diagnostics = {
  activity: lazy(() =>
    import("./Diagnostics").then((m) => ({ default: m.ActivityMonitor })),
  ),
  queryStore: lazy(() =>
    import("./Diagnostics").then((m) => ({ default: m.QueryStore })),
  ),
  events: lazy(() =>
    import("./Diagnostics").then((m) => ({ default: m.ExtendedEvents })),
  ),
};
const Table = lazy(() =>
  import("./Designers").then((m) => ({ default: m.TableDesigner })),
);
const View = lazy(() =>
  import("./Designers").then((m) => ({ default: m.ViewDesigner })),
);
const Diagram = lazy(() =>
  import("./Designers").then((m) => ({ default: m.RelationshipDiagram })),
);
const Properties = lazy(() =>
  import("./Designers").then((m) => ({ default: m.ObjectProperties })),
);
const Backup = lazy(() =>
  import("./Administration").then((m) => ({ default: m.BackupRestore })),
);
const Agent = lazy(() =>
  import("./Administration").then((m) => ({ default: m.Agent })),
);
const Maintenance = lazy(() =>
  import("./Administration").then((m) => ({ default: m.Maintenance })),
);
const Transfer = lazy(() =>
  import("./Transfer").then((m) => ({ default: m.Transfer })),
);
const Security = lazy(() =>
  import("./Security").then((m) => ({ default: m.Security })),
);
const Encryption = lazy(() =>
  import("./Security").then((m) => ({ default: m.Encryption })),
);
const MicrosoftQuery = lazy(() =>
  import("./Security").then((m) => ({ default: m.MicrosoftQuery })),
);
const Templates = lazy(() =>
  import("./Templates").then((m) => ({ default: m.Templates })),
);

export function Workspace() {
  const workbench = useWorkbench(),
    connections = useConnections((s) => s.connections),
    explorer = useExplorer((s) => s.context),
    queries = useQueries((s) => s.tabs),
    activeQueryId = useQueries((s) => s.activeId);
  const activeQuery = queries.find((t) => t.id === activeQueryId);
  const context =
    explorer ??
    (activeQuery
      ? {
          connectionId: activeQuery.connectionId,
          database: activeQuery.database,
        }
      : {
          connectionId: connections[0]?.id ?? "",
          database: connections[0]?.defaultDatabase ?? null,
        });
  const active = workbench.tabs.find((t) => t.id === workbench.activeId);
  return (
    <section className="flex h-full min-w-0 flex-col">
      <div className="flex h-9 shrink-0 items-end gap-1 border-b bg-panel px-2 text-xs">
        <div className="flex min-w-0 flex-1 items-end gap-1 overflow-x-auto">
          <button
            className={cn(
              "-mb-px h-8 shrink-0 border-b-2 px-2",
              !active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
            onClick={() => workbench.activate(null)}
          >
            Queries
          </button>
          {workbench.tabs.map((tab) => {
            const selected = active?.id === tab.id;
            return (
              <div
                key={tab.id}
                className={cn(
                  "group -mb-px flex h-8 max-w-60 shrink-0 items-center gap-1 border-b-2 pl-2",
                  selected ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                <button
                  className="min-w-0 truncate"
                  title={`${TOOL_NAMES[tab.kind]} · ${tab.database ?? "Server"}`}
                  onClick={() => workbench.activate(tab.id)}
                >
                  {tab.name ?? TOOL_NAMES[tab.kind]}
                </button>
                <button
                  aria-label={`Close ${TOOL_NAMES[tab.kind]}`}
                  title="Close"
                  // A 20 px target with a 14 px icon, as on the query tabs.
                  className={cn(
                    "grid size-5 shrink-0 place-items-center rounded hover:bg-accent",
                    !selected && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                  )}
                  onClick={() => workbench.close(tab.id)}
                >
                  <X className="size-3.5" />
                </button>
              </div>
            );
          })}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="mb-0.5 h-7 shrink-0">
              <Wrench /> Tools <ChevronDown className="opacity-50" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            {TOOL_GROUPS.map(([group, kinds], index) => (
              <DropdownMenuGroup key={group}>
                {index > 0 && <DropdownMenuSeparator />}
                <DropdownMenuLabel>{group}</DropdownMenuLabel>
                {kinds.map((kind) => (
                  <DropdownMenuItem
                    key={kind}
                    disabled={!context.connectionId && kind !== "templates" && kind !== "components"}
                    onSelect={() => workbench.open(kind, context)}
                  >
                    {TOOL_NAMES[kind]}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className={`min-h-0 flex-1 ${active ? "hidden" : ""}`}>
        <QueryWorkspace />
      </div>
      {workbench.tabs.map((tab) => (
        <div
          key={tab.id}
          className={`min-h-0 flex-1 flex-col ${active?.id === tab.id ? "flex" : "hidden"}`}
        >
          <ErrorBoundary label={TOOL_NAMES[tab.kind]}>
            <ToolFrame tab={tab} active={active?.id === tab.id} />
          </ErrorBoundary>
        </div>
      ))}
    </section>
  );
}

function ToolFrame({ tab, active = true }: { tab: ToolTab; active?: boolean }) {
  const connections = useConnections((s) => s.connections);
  const [connectionId, setConnectionId] = useState(tab.connectionId),
    [database, setDatabase] = useState(tab.database ?? ""),
    [databases, setDatabases] = useState<string[]>([]),
    [capabilities, setCapabilities] = useState<ServerCapabilities | null>(null),
    [error, setError] = useState<string | null>(null);
  const local = tab.kind === "components" || tab.kind === "templates";
  useEffect(() => {
    if (!connectionId) return;
    let disposed = false;
    setError(null);
    setCapabilities(null);
    void management
      .capabilities({ connectionId, database: database || null })
      .then(
        (value) => !disposed && setCapabilities(value),
        (e) => !disposed && setError(errorMessage(e)),
      );
    void api.databases(connectionId).then(
      (values) => !disposed && setDatabases(values.map((d) => d.name)),
      () => {},
    );
    return () => {
      disposed = true;
    };
  }, [connectionId, database]);
  const context = {
    connectionId,
    database: database || capabilities?.database || null,
    active,
  };
  const current: ToolTab = { ...tab, ...context };
  const feature =
    tab.kind === "activity"
      ? "monitor"
      : tab.kind === "events"
        ? "events"
        : tab.kind === "backup"
          ? "backup"
          : tab.kind === "agent"
            ? "agent"
            : tab.kind === "queryStore"
              ? "queryStore"
              : null;
  const unavailable = feature && capabilities?.features[feature];
  const azure = capabilities?.engineEdition === 5;
  function content() {
    switch (tab.kind) {
      case "components":
        return <Components />;
      case "templates":
        return <Templates context={context} />;
      case "activity":
        return <Diagnostics.activity context={context} />;
      case "queryStore":
        return <Diagnostics.queryStore context={context} />;
      case "events":
        return <Diagnostics.events context={context} azure={azure} />;
      case "table":
        return <Table tab={current} />;
      case "view":
        return <View tab={current} />;
      case "diagram":
        return <Diagram context={context} />;
      case "properties":
        return <Properties tab={current} />;
      case "backup":
        return <Backup context={context} azure={azure} />;
      case "agent":
        return <Agent context={context} />;
      case "maintenance":
        return (
          <Maintenance
            context={context}
            agentAvailable={
              capabilities?.features.agent?.state !== "unsupported"
            }
          />
        );
      case "transfer":
        return <Transfer context={context} />;
      case "security":
        return <Security context={context} />;
      case "encryption":
        return <Encryption context={context} />;
      case "encryptedQuery":
        return <MicrosoftQuery context={context} />;
    }
  }
  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-4">
      <header className="flex shrink-0 flex-wrap items-end gap-3">
        <div className="mr-auto">
          <h1 className="text-lg font-semibold">
            {tab.name
              ? `${TOOL_NAMES[tab.kind]} · ${tab.schema ?? "dbo"}.${tab.name}`
              : TOOL_NAMES[tab.kind]}
          </h1>
          {capabilities && (
            <p className="pt-0.5 text-sm text-muted-foreground">
              {capabilities.edition} · {capabilities.version}
            </p>
          )}
        </div>
        {tab.kind !== "components" && (
          <>
            <Choice
              label="Server"
              className="w-48"
              value={connectionId}
              onChange={(id) => {
                setConnectionId(id);
                setDatabase("");
              }}
              options={connections.map((c) => [c.id, displayName(c)] as const)}
            />
            <Choice
              label="Database"
              className="w-48"
              value={database || capabilities?.database || ""}
              onChange={setDatabase}
              options={[
                ["", "Default database"],
                ...databases.map((name): [string, string] => [name, name]),
              ]}
            />
          </>
        )}
      </header>
      {!local && error && <Notice error>{error}</Notice>}
      {unavailable && unavailable.state !== "available" && (
        <Notice>
          {unavailable.state}: {unavailable.reason}
        </Notice>
      )}
      {(local || capabilities) &&
        !(
          unavailable &&
          unavailable.state === "unsupported" &&
          tab.kind !== "backup"
        ) && (
          <Suspense fallback={<Notice>Loading tool…</Notice>}>
            <div
              key={`${connectionId}:${database}`}
              className="flex min-h-0 flex-1 flex-col overflow-auto"
            >
              {content()}
            </div>
          </Suspense>
        )}
      {!local && !capabilities && !error && (
        <Notice>Reading server capabilities…</Notice>
      )}
    </section>
  );
}

function Components() {
  const [dependencies, setDependencies] = useState<Dependency[]>([]),
    [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false),
    [progress, setProgress] = useState("");
  async function install() {
    setInstalling(true);
    setError(null);
    try {
      await management.installLanguage((event) => setProgress(event.message));
      refresh();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setInstalling(false);
    }
  }
  function refresh() {
    void management
      .dependencies()
      .then(setDependencies, (e) => setError(errorMessage(e)));
  }
  useEffect(refresh, []);
  async function select(kind: "bridge" | "language") {
    try {
      const path = await open({
        multiple: false,
        filters: [{ name: "Microsoft component", extensions: ["exe"] }],
      });
      if (path) {
        await management.selectComponent(kind, path);
        refresh();
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  return (
    <div className="flex flex-col gap-3 overflow-auto">
      {error && <Notice error>{error}</Notice>}
      {progress && <Notice>{progress}</Notice>}
      <Button
        variant="outline"
        className="self-start"
        disabled={installing}
        onClick={() => void install()}
      >
        {installing
          ? "Installing…"
          : "Install SQL Tools Service 6.0.20261023.1"}
      </Button>
      {dependencies.map((dependency, index) => (
        <div key={dependency.name} className="rounded-md border p-3">
          <h2 className="text-sm font-medium">{dependency.name}</h2>
          <p className="pt-1 text-xs text-muted-foreground">
            {dependency.available ? "Available" : "Missing"}
            {dependency.path ? ` · ${dependency.path}` : ""}
          </p>
          <p className="py-2 text-xs text-muted-foreground">
            {dependency.help}
          </p>
          <Button
            variant="outline"
            onClick={() => void select(index === 0 ? "bridge" : "language")}
          >
            Select executable
          </Button>
        </div>
      ))}
      <Notice>
        Column encryption migration also requires the official Microsoft
        SqlServer PowerShell module, version 22 or later. Component executables
        run locally under your Windows account.
      </Notice>
      <Button
        className="self-start"
        variant="outline"
        onClick={refresh}
      >
        Refresh components
      </Button>
    </div>
  );
}
