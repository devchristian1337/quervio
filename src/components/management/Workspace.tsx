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
import { Choice, inputClass, Notice } from "./shared";

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
      <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b bg-panel px-2">
        <button
          className={`h-full shrink-0 border-b-2 px-2 text-xs ${!active ? "border-primary" : "border-transparent text-muted-foreground"}`}
          onClick={() => workbench.activate(null)}
        >
          Queries
        </button>
        {workbench.tabs.map((tab) => (
          <div
            key={tab.id}
            className={`flex h-full shrink-0 items-center border-b-2 ${active?.id === tab.id ? "border-primary" : "border-transparent text-muted-foreground"}`}
          >
            <button
              className="max-w-52 truncate px-2 text-xs"
              title={`${TOOL_NAMES[tab.kind]} · ${tab.database ?? "Server"}`}
              onClick={() => workbench.activate(tab.id)}
            >
              {tab.name ?? TOOL_NAMES[tab.kind]}
            </button>
            <button
              aria-label={`Close ${TOOL_NAMES[tab.kind]}`}
              className="px-2 text-xs hover:text-foreground"
              onClick={() => workbench.close(tab.id)}
            >
              ×
            </button>
          </div>
        ))}
        <select
          aria-label="Open management tool"
          className="ml-auto h-7 w-44 shrink-0 rounded border bg-background px-2 text-xs"
          value=""
          onChange={(e) =>
            e.target.value &&
            workbench.open(e.target.value as ToolKind, context)
          }
        >
          <option value="">Tools…</option>
          {Object.entries(TOOL_NAMES).map(([kind, label]) => (
            <option
              key={kind}
              value={kind}
              disabled={
                !context.connectionId &&
                !["templates", "components"].includes(kind)
              }
            >
              {label}
            </option>
          ))}
        </select>
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
          <h1 className="text-base font-semibold">
            {tab.name
              ? `${TOOL_NAMES[tab.kind]} · ${tab.schema ?? "dbo"}.${tab.name}`
              : TOOL_NAMES[tab.kind]}
          </h1>
          {capabilities && (
            <p className="pt-1 text-xs text-muted-foreground">
              {capabilities.edition} · {capabilities.version}
            </p>
          )}
        </div>
        {tab.kind !== "components" && (
          <>
            <Choice
              label="Server"
              value={connectionId}
              onChange={(id) => {
                setConnectionId(id);
                setDatabase("");
              }}
              options={connections.map((c) => [c.id, displayName(c)] as const)}
            />
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Database
              <select
                className={inputClass}
                value={database || capabilities?.database || ""}
                onChange={(e) => setDatabase(e.target.value)}
              >
                <option value="">Default database</option>
                {databases.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
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
        size="sm"
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
        <div key={dependency.name} className="rounded border p-3">
          <h2 className="text-sm font-semibold">{dependency.name}</h2>
          <p className="pt-1 text-xs text-muted-foreground">
            {dependency.available ? "Available" : "Missing"}
            {dependency.path ? ` · ${dependency.path}` : ""}
          </p>
          <p className="py-2 text-xs text-muted-foreground">
            {dependency.help}
          </p>
          <Button
            size="sm"
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
        size="sm"
        className="self-start"
        variant="outline"
        onClick={refresh}
      >
        Refresh components
      </Button>
    </div>
  );
}
