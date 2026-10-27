import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  Columns3,
  Database,
  Eye,
  Filter,
  Folder,
  FunctionSquare,
  KeyRound,
  ListTree,
  Loader2,
  Plus,
  ScrollText,
  Server,
  Settings2,
  SquarePen,
  Table2,
  X,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ConnectDialog } from "@/components/ConnectDialog";
import { api, displayName, errorMessage, type SavedConnection, type ScriptKind } from "@/lib/api";
import { toast } from "sonner";
import { ENVIRONMENTS } from "@/lib/environment";
import { cn } from "@/lib/utils";
import { useConnections } from "@/stores/connections";
import { contextOf, isFilterable, serverKey, useExplorer, type TreeNode } from "@/stores/explorer";
import { useQueries } from "@/stores/queries";
import { openQueryFromContext } from "@/lib/shortcuts";
import { useShortcutLabel } from "@/lib/commands";
import { useSettingsDialog } from "@/stores/dialogs";

type Row =
  | { type: "node"; node: TreeNode; depth: number; parent: string | null }
  | { type: "status"; key: string; depth: number; text: string; tone: "muted" | "error" | "loading" }
  | { type: "filter"; key: string; depth: number; owner: string };

const INDENT = 14;

export function ObjectExplorer() {
  const { connections, loaded, load } = useConnections();
  const explorer = useExplorer();
  const settingsKey = useShortcutLabel("settings");
  const newQueryKey = useShortcutLabel("newQuery");
  const [dialog, setDialog] = useState<{ open: boolean; editing: SavedConnection | null }>({
    open: false,
    editing: null,
  });
  const treeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const roots = useMemo<TreeNode[]>(
    () =>
      connections.map((c) => ({
        key: serverKey(c.id),
        label: displayName(c),
        kind: { type: "server", connectionId: c.id },
        expandable: true,
      })),
    [connections],
  );

  const rows = useMemo(() => {
    const out: Row[] = [];
    const visit = (node: TreeNode, depth: number, parent: string | null) => {
      out.push({ type: "node", node, depth, parent });
      if (!explorer.expanded[node.key]) return;
      const state = explorer.children[node.key];
      if (!state || state.status === "loading") {
        out.push({ type: "status", key: `${node.key}#loading`, depth: depth + 1, text: "Loading…", tone: "loading" });
        return;
      }
      if (state.status === "error") {
        out.push({ type: "status", key: `${node.key}#error`, depth: depth + 1, text: state.error, tone: "error" });
        return;
      }
      const filter = explorer.filters[node.key];
      if (filter !== undefined) out.push({ type: "filter", key: `${node.key}#filter`, depth: depth + 1, owner: node.key });
      const needle = filter?.trim().toLowerCase();
      const children = needle ? state.nodes.filter((n) => n.label.toLowerCase().includes(needle)) : state.nodes;
      if (children.length === 0) {
        out.push({
          type: "status",
          key: `${node.key}#empty`,
          depth: depth + 1,
          text: needle ? "No matches" : "Empty",
          tone: "muted",
        });
      }
      for (const child of children) visit(child, depth + 1, node.key);
    };
    for (const root of roots) visit(root, 0, null);
    return out;
  }, [roots, explorer.expanded, explorer.children, explorer.filters]);

  const nodeRows = rows.filter((r): r is Extract<Row, { type: "node" }> => r.type === "node");
  const selectedIndex = nodeRows.findIndex((r) => r.node.key === explorer.selected);
  const selectedNode = nodeRows[selectedIndex]?.node;

  // New Query (Ctrl+N, toolbar) opens on the selected server and database.
  const setContext = explorer.setContext;
  useEffect(() => {
    setContext(selectedNode ? contextOf(selectedNode.kind) : null);
  }, [selectedNode, setContext]);

  function connectionOf(node: TreeNode) {
    const { kind } = node;
    return kind.type === "server" ? connections.find((c) => c.id === kind.connectionId) : undefined;
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.target !== treeRef.current) return;
    const current = nodeRows[selectedIndex];
    const go = (index: number) => {
      const row = nodeRows[Math.max(0, Math.min(nodeRows.length - 1, index))];
      if (row) explorer.select(row.node.key);
    };
    switch (event.key) {
      case "ArrowDown":
        go(selectedIndex + 1);
        break;
      case "ArrowUp":
        go(selectedIndex <= 0 ? 0 : selectedIndex - 1);
        break;
      case "ArrowRight":
        if (!current) break;
        if (current.node.expandable && !explorer.expanded[current.node.key]) void explorer.expand(current.node);
        else go(selectedIndex + 1);
        break;
      case "ArrowLeft":
        if (!current) break;
        if (explorer.expanded[current.node.key]) explorer.collapse(current.node.key);
        else if (current.parent) explorer.select(current.parent);
        break;
      case "Enter":
        if (current) void explorer.toggle(current.node);
        break;
      case "F5":
        if (current) void explorer.refresh(current.node);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  async function removeConnection(connection: SavedConnection) {
    if (!window.confirm(`Delete the saved connection "${displayName(connection)}"?`)) return;
    await explorer.disconnect(connection.id);
    await useConnections.getState().remove(connection.id);
  }

  return (
    <section className="flex h-full flex-col">
      <header className="flex h-9 shrink-0 items-center justify-between border-b px-3">
        <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Object Explorer</h2>
        <div className="flex items-center">
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          title={`New query (${newQueryKey})`}
          disabled={!explorer.context}
          onClick={() => openQueryFromContext()}
        >
          <SquarePen />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          title="New connection"
          onClick={() => setDialog({ open: true, editing: null })}
        >
          <Plus />
        </Button>
        </div>
      </header>

      <div
        ref={treeRef}
        role="tree"
        tabIndex={0}
        // F5 here refreshes instead of executing (src/lib/shortcuts.ts).
        data-explorer
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-auto py-1 outline-none select-none"
      >
        {loaded && connections.length === 0 && (
          <div className="flex flex-col items-start gap-2 p-3 text-muted-foreground">
            <p>No saved connections yet.</p>
            <Button size="sm" variant="outline" onClick={() => setDialog({ open: true, editing: null })}>
              <Plus /> New connection
            </Button>
          </div>
        )}

        {rows.map((row) => {
          if (row.type === "status") {
            return (
              <div
                key={row.key}
                style={{ paddingLeft: row.depth * INDENT + 26 }}
                className={cn(
                  "flex items-start gap-1.5 py-0.5 pr-2 text-xs",
                  row.tone === "error" ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {row.tone === "loading" && <Loader2 className="mt-0.5 size-3 animate-spin" />}
                <span className="break-words">{row.text}</span>
              </div>
            );
          }
          if (row.type === "filter") {
            return (
              <div key={row.key} style={{ paddingLeft: row.depth * INDENT + 20 }} className="flex items-center gap-1 py-0.5 pr-2">
                <Filter className="size-3 shrink-0 text-muted-foreground" />
                <input
                  autoFocus
                  value={explorer.filters[row.owner] ?? ""}
                  onChange={(e) => explorer.setFilter(row.owner, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      explorer.setFilter(row.owner, null);
                      treeRef.current?.focus();
                    }
                  }}
                  placeholder="Filter by name"
                  className="h-5 min-w-0 flex-1 rounded border bg-background/60 px-1.5 text-xs outline-none focus:border-ring"
                />
                <button
                  title="Clear filter"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    explorer.setFilter(row.owner, null);
                    treeRef.current?.focus();
                  }}
                >
                  <X className="size-3" />
                </button>
              </div>
            );
          }

          const { node, depth } = row;
          const connection = node.kind.type === "server" ? connectionOf(node) : undefined;
          const expanded = !!explorer.expanded[node.key];
          const selected = explorer.selected === node.key;
          const info = connection ? explorer.servers[connection.id] : undefined;

          return (
            <ContextMenu key={node.key}>
              <ContextMenuTrigger asChild>
                <div
                  role="treeitem"
                  aria-expanded={node.expandable ? expanded : undefined}
                  aria-selected={selected}
                  title={
                    info
                      ? `${info.serverName} — SQL Server ${info.version}`
                      : node.detail
                        ? `${node.label} (${node.detail})`
                        : node.label
                  }
                  style={{ paddingLeft: depth * INDENT + 4 }}
                  className={cn(
                    "group flex h-6 cursor-default items-center gap-1 pr-2 whitespace-nowrap",
                    selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
                    connection && `border-l-2 ${ENVIRONMENTS[connection.environment].bar}`,
                  )}
                  onMouseDown={() => {
                    explorer.select(node.key);
                    // Keep keyboard navigation on the tree after a click.
                    requestAnimationFrame(() => treeRef.current?.focus());
                  }}
                  onDoubleClick={() => void explorer.toggle(node)}
                >
                  <button
                    tabIndex={-1}
                    className={cn("grid size-4 shrink-0 place-items-center", !node.expandable && "invisible")}
                    onClick={() => void explorer.toggle(node)}
                  >
                    <ChevronRight className={cn("size-3.5 transition-transform", expanded && "rotate-90")} />
                  </button>
                  <NodeIcon node={node} />
                  <span className="shrink-0">{node.label}</span>
                  {node.detail && (
                    <span className="min-w-0 truncate text-muted-foreground">({node.detail})</span>
                  )}
                  {connection && (
                    <span
                      className={cn(
                        "ml-auto pl-2 text-[10px] font-semibold tracking-wider",
                        ENVIRONMENTS[connection.environment].text,
                      )}
                    >
                      {ENVIRONMENTS[connection.environment].badge}
                    </span>
                  )}
                  {isFilterable(node.kind) && expanded && explorer.filters[node.key] === undefined && (
                    <button
                      tabIndex={-1}
                      title="Filter"
                      className="ml-auto opacity-0 group-hover:opacity-100"
                      onClick={(e) => {
                        e.stopPropagation();
                        explorer.setFilter(node.key, "");
                      }}
                    >
                      <Filter className="size-3 text-muted-foreground" />
                    </button>
                  )}
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-48">
                <ScriptItems node={node} />
                {contextOf(node.kind) && (
                  <>
                    <ContextMenuItem
                      onSelect={() => {
                        const context = contextOf(node.kind);
                        if (context) void useQueries.getState().open(context.connectionId, context.database);
                      }}
                    >
                      New Query <ContextMenuShortcut>{newQueryKey}</ContextMenuShortcut>
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                  </>
                )}
                {node.expandable && (
                  <ContextMenuItem onSelect={() => void explorer.refresh(node)}>
                    Refresh <ContextMenuShortcut>F5</ContextMenuShortcut>
                  </ContextMenuItem>
                )}
                {isFilterable(node.kind) && (
                  <ContextMenuItem
                    onSelect={() => {
                      void explorer.expand(node);
                      explorer.setFilter(node.key, explorer.filters[node.key] ?? "");
                    }}
                  >
                    Filter…
                  </ContextMenuItem>
                )}
                {connection && (
                  <>
                    <ContextMenuSeparator />
                    <ContextMenuItem onSelect={() => setDialog({ open: true, editing: connection })}>
                      Edit connection…
                    </ContextMenuItem>
                    <ContextMenuItem disabled={!info} onSelect={() => void explorer.disconnect(connection.id)}>
                      Disconnect
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem variant="destructive" onSelect={() => void removeConnection(connection)}>
                      Delete connection
                    </ContextMenuItem>
                  </>
                )}
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
      </div>

      <ConnectDialog
        open={dialog.open}
        editing={dialog.editing}
        onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}
        onSaved={(saved) => {
          const node: TreeNode = {
            key: serverKey(saved.id),
            label: displayName(saved),
            kind: { type: "server", connectionId: saved.id },
            expandable: true,
          };
          // Settings may have changed: start over from a fresh connection.
          void explorer.disconnect(saved.id).then(() => {
            explorer.select(node.key);
            if (!dialog.editing) void explorer.expand(node);
          });
        }}
      />
      <footer className="flex h-9 shrink-0 items-center border-t px-1.5">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
          title={`Settings (${settingsKey})`}
          onClick={() => useSettingsDialog.getState().show()}
        >
          <Settings2 /> Settings
        </Button>
      </footer>
    </section>
  );
}

/** Opens a script for an Object in a new Query Tab on its database. */
async function openScript(kind: ScriptKind, connectionId: string, database: string, objectId: number) {
  try {
    const text = await api.script(connectionId, database, objectId, kind);
    await useQueries.getState().open(connectionId, database, { text, execute: kind === "selectTop" });
  } catch (error) {
    toast.error("Could not script the object", { description: errorMessage(error) });
  }
}

/** Scripting actions for tables, views and Modules, as in SSMS. */
function ScriptItems({ node }: { node: TreeNode }) {
  const { kind } = node;
  if (!(kind.type === "object" || (kind.type === "leaf" && kind.folder === "triggers")) || kind.objectId === null) {
    return null;
  }
  const { connectionId, database, objectId } = kind;
  const folder = kind.type === "object" ? kind.folder : "triggers";
  const run = (script: ScriptKind) => () => void openScript(script, connectionId, database, objectId);
  const hasRows = folder === "tables" || folder === "views";
  const isModule = folder !== "tables";
  return (
    <>
      {hasRows && <ContextMenuItem onSelect={run("selectTop")}>Select Top 1000 Rows</ContextMenuItem>}
      {isModule && <ContextMenuItem onSelect={run("alter")}>Modify</ContextMenuItem>}
      <ContextMenuItem onSelect={run(isModule ? "create" : "createTable")}>Script as CREATE</ContextMenuItem>
      {isModule && <ContextMenuItem onSelect={run("alter")}>Script as ALTER</ContextMenuItem>}
      <ContextMenuSeparator />
    </>
  );
}

function NodeIcon({ node }: { node: TreeNode }) {
  const className = "size-3.5 shrink-0 text-muted-foreground";
  switch (node.kind.type) {
    case "server":
      return <Server className={className} />;
    case "database":
      return <Database className={className} />;
    case "object":
      switch (node.kind.folder) {
        case "tables":
          return <Table2 className={className} />;
        case "views":
          return <Eye className={className} />;
        case "storedProcedures":
          return <ScrollText className={className} />;
        case "functions":
          return <FunctionSquare className={className} />;
      }
      break;
    case "leaf":
      switch (node.kind.folder) {
        case "columns":
          return <Columns3 className={className} />;
        case "keys":
          return <KeyRound className={className} />;
        case "indexes":
          return <ListTree className={className} />;
        case "triggers":
          return <Zap className={className} />;
      }
      break;
  }
  return <Folder className={className} />;
}
