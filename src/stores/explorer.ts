// Object Explorer tree: nodes are addressed by a path-like key and their
// children are loaded lazily, one level per expand, then cached until F5.
import { create } from "zustand";
import { management, records } from "@/lib/management-api";
import type { ToolKind } from "@/stores/workbench";
import {invalidateCatalog} from "@/lib/metadata-events";
import {
  api,
  errorMessage,
  type CatalogItem,
  type ObjectFolder,
  type ServerInfo,
  type TableFolder,
} from "@/lib/api";

export type NodeKind =
  | { type: "group"; name: string }
  | { type: "tool"; connectionId: string; database: string | null; tool: ToolKind }
  | { type: "securityFolder"; connectionId: string; database: string | null; server: boolean }
  | { type: "securityList"; connectionId: string; database: string | null; server: boolean; section: "principals" | "roles" | "serverTriggers" }
  | { type: "securityObject"; connectionId: string; database: string | null; definition?: string }
  | { type: "server"; connectionId: string }
  | { type: "databases"; connectionId: string }
  | { type: "systemDatabases"; connectionId: string }
  | { type: "database"; connectionId: string; database: string }
  | { type: "objectFolder"; connectionId: string; database: string; folder: ObjectFolder }
  | {
      type: "object";
      connectionId: string;
      database: string;
      folder: ObjectFolder;
      objectId: number | null;
    }
  | {
      type: "tableFolder";
      connectionId: string;
      database: string;
      objectId: number;
      folder: TableFolder;
    }
  | {
      type: "leaf";
      folder: TableFolder;
      connectionId: string;
      database: string;
      /** Set for triggers, which can be scripted. */
      objectId: number | null;
    };

export interface TreeNode {
  objectName?: string;
  objectSchema?: string;
  key: string;
  label: string;
  detail?: string | null;
  kind: NodeKind;
  expandable: boolean;
}

export type Children =
  | { status: "loading" }
  | { status: "ready"; nodes: TreeNode[] }
  | { status: "error"; error: string };

const OBJECT_FOLDERS: { folder: ObjectFolder; label: string }[] = [
  { folder: "tables", label: "Tables" },
  { folder: "views", label: "Views" },
  { folder: "storedProcedures", label: "Stored Procedures" },
  { folder: "functions", label: "Functions" },
  { folder: "databaseTriggers", label: "Database Triggers" },
];

const TABLE_FOLDERS: { folder: TableFolder; label: string }[] = [
  { folder: "columns", label: "Columns" },
  { folder: "keys", label: "Keys" },
  { folder: "indexes", label: "Indexes" },
  { folder: "triggers", label: "Triggers" },
];

/** Folders whose children can be narrowed with a name filter. */
export function isFilterable(kind: NodeKind) {
  return kind.type === "databases" || kind.type === "objectFolder" || kind.type === "tableFolder";
}

export function serverKey(connectionId: string) {
  return `s:${connectionId}`;
}

export function groupKey(name: string) {
  return `g:${name}`;
}

function qualified(item: CatalogItem) {
  return item.schema ? `${item.schema}.${item.name}` : item.name;
}

function databaseNode(parentKey: string, connectionId: string, item: CatalogItem): TreeNode {
  return {
    key: `${parentKey}/db:${item.name}`,
    label: item.name,
    kind: { type: "database", connectionId, database: item.name },
    expandable: true,
  };
}

async function loadChildren(node: TreeNode, cache: Record<string, Children>): Promise<TreeNode[]> {
  const { kind, key } = node;
  switch (kind.type) {
    case "group":
      // Its connections come from the Saved Connections (ObjectExplorer.tsx).
      return [];
    case "server":
      return [
        {
          key: `${key}/dbs`,
          label: "Databases",
          kind: { type: "databases", connectionId: kind.connectionId },
          expandable: true,
        },
        {key: `${key}/security`, label: "Security", kind: {type: "securityFolder", connectionId: kind.connectionId, database: null, server: true}, expandable: true},
        {key: `${key}/triggers`, label: "Server Triggers", kind: {type: "securityList", connectionId: kind.connectionId, database: null, server: true, section: "serverTriggers"}, expandable: true},
        ...(["activity", "events", "agent"] as const).map(tool => ({key: `${key}/${tool}`, label: tool === "activity" ? "Activity Monitor" : tool === "events" ? "Extended Events" : "SQL Server Agent", kind: {type: "tool" as const, connectionId: kind.connectionId, database: null, tool}, expandable: false})),
      ];
    case "databases": {
      const items = await api.databases(kind.connectionId);
      const system: TreeNode = {
        key: `${key}/system`,
        label: "System Databases",
        kind: { type: "systemDatabases", connectionId: kind.connectionId },
        expandable: true,
      };
      // System databases are cached under their folder right away.
      cache[system.key] = {
        status: "ready",
        nodes: items.filter((i) => i.system).map((i) => databaseNode(system.key, kind.connectionId, i)),
      };
      return [
        system,
        ...items.filter((i) => !i.system).map((i) => databaseNode(key, kind.connectionId, i)),
      ];
    }
    case "systemDatabases": {
      // Only reached after an F5 on the folder itself: reload from the server.
      const items = await api.databases(kind.connectionId);
      return items.filter((i) => i.system).map((i) => databaseNode(key, kind.connectionId, i));
    }
    case "database":
      return [...OBJECT_FOLDERS.map(({ folder, label }) => ({
        key: `${key}/${folder}`,
        label,
        kind: { type: "objectFolder" as const, connectionId: kind.connectionId, database: kind.database, folder },
        expandable: true,
      })), {key: `${key}/security`, label: "Security", kind: {type: "securityFolder", connectionId: kind.connectionId, database: kind.database, server: false}, expandable: true}, ...(["queryStore", "backup", "maintenance", "diagram", "transfer"] as const).map(tool => ({key: `${key}/${tool}`, label: {queryStore: "Query Store", backup: "Backup / Restore", maintenance: "Maintenance", diagram: "Relationships", transfer: "Import / Export"}[tool], kind: {type: "tool" as const, connectionId: kind.connectionId, database: kind.database, tool}, expandable: false}))];
    case "securityFolder":
      return (["principals", "roles"] as const).map(section => ({key: `${key}/${section}`, label: section === "principals" ? kind.server ? "Logins" : "Users" : "Roles", kind: {type: "securityList" as const, connectionId: kind.connectionId, database: kind.database, server: kind.server, section}, expandable: true}));
    case "securityList": {
      const data = await management.read({connectionId: kind.connectionId, database: kind.database}, kind.section === "serverTriggers" ? {kind: "serverTriggers"} : {kind: kind.section, server: kind.server});
      return records(data).map((row, index) => ({key: `${key}/${row.principal_id ?? index}`, label: row.name ?? row.role_name ?? "", detail: row.type_desc, kind: {type: "securityObject" as const, connectionId: kind.connectionId, database: kind.database, definition: row.definition ?? undefined}, expandable: false}));
    }
    case "securityObject":case "tool":return [];
    case "objectFolder": {
      const items = await api.objects(kind.connectionId, kind.database, kind.folder);
      const hasColumns = kind.folder === "tables" || kind.folder === "views";
      return items
        .filter((item) => !item.system)
        .map((item) => ({
          key: `${key}/${item.objectId ?? qualified(item)}`,
          label: qualified(item),
          objectName: item.name,
          objectSchema: item.schema ?? "dbo",
          detail: item.detail,
          kind: {
            type: "object",
            connectionId: kind.connectionId,
            database: kind.database,
            folder: kind.folder,
            objectId: item.objectId,
          },
          expandable: hasColumns && item.objectId !== null,
        }));
    }
    case "object": {
      if (kind.objectId === null) return [];
      const objectId = kind.objectId;
      const folders = kind.folder === "views" ? TABLE_FOLDERS.slice(0, 1) : TABLE_FOLDERS;
      return folders.map(({ folder, label }) => ({
        key: `${key}/${folder}`,
        label,
        kind: { type: "tableFolder", connectionId: kind.connectionId, database: kind.database, objectId, folder },
        expandable: true,
      }));
    }
    case "tableFolder": {
      const items = await api.tableChildren(kind.connectionId, kind.database, kind.objectId, kind.folder);
      return items.map((item) => ({
        key: `${key}/${item.name}`,
        label: item.name,
        detail: item.detail,
        kind: {
          type: "leaf",
          folder: kind.folder,
          connectionId: kind.connectionId,
          database: kind.database,
          objectId: item.objectId,
        },
        expandable: false,
      }));
    }
    case "leaf":
      return [];
  }
}

/** Server and database of the selected node, for New Query. */
export interface SelectionContext {
  connectionId: string;
  database: string | null;
}

export function contextOf(kind: NodeKind): SelectionContext | null {
  if (!("connectionId" in kind)) return null;
  return { connectionId: kind.connectionId, database: "database" in kind ? kind.database : null };
}

interface ExplorerState {
  expanded: Record<string, boolean>;
  context: SelectionContext | null;
  setContext: (context: SelectionContext | null) => void;
  children: Record<string, Children>;
  filters: Record<string, string>;
  selected: string | null;
  servers: Record<string, ServerInfo | undefined>;
  toggle: (node: TreeNode) => Promise<void>;
  expand: (node: TreeNode) => Promise<void>;
  collapse: (key: string) => void;
  refresh: (node: TreeNode) => Promise<void>;
  select: (key: string | null) => void;
  setFilter: (key: string, text: string | null) => void;
  disconnect: (connectionId: string) => Promise<void>;
}

/** Drops cached state of a node's descendants (and the node itself when asked). */
function prune<T>(record: Record<string, T>, key: string, includeSelf: boolean) {
  return Object.fromEntries(
    Object.entries(record).filter(
      ([k]) => !(k.startsWith(`${key}/`) || (includeSelf && k === key)),
    ),
  );
}

export const useExplorer = create<ExplorerState>((set, get) => {
  async function load(node: TreeNode) {
    set((s) => ({ children: { ...s.children, [node.key]: { status: "loading" } } }));
    try {
      if (node.kind.type === "server") {
        const { connectionId } = node.kind;
        const info = await api.connect(connectionId);
        set((s) => ({ servers: { ...s.servers, [connectionId]: info } }));
      }
      const extra: Record<string, Children> = {};
      const nodes = await loadChildren(node, extra);
      set((s) => ({ children: { ...s.children, ...extra, [node.key]: { status: "ready", nodes } } }));
    } catch (error) {
      set((s) => ({
        children: { ...s.children, [node.key]: { status: "error", error: errorMessage(error) } },
      }));
    }
  }

  return {
    expanded: {},
    context: null,
    setContext: (context) => set({ context }),
    children: {},
    filters: {},
    selected: null,
    servers: {},

    toggle: async (node) => {
      if (get().expanded[node.key]) get().collapse(node.key);
      else await get().expand(node);
    },

    expand: async (node) => {
      if (!node.expandable) return;
      set((s) => ({ expanded: { ...s.expanded, [node.key]: true } }));
      if (node.kind.type === "group") return;
      const cached = get().children[node.key];
      if (!cached || cached.status === "error") await load(node);
    },

    collapse: (key) => set((s) => ({ expanded: { ...s.expanded, [key]: false } })),

    refresh: async (node) => {
      invalidateCatalog();
      if (!node.expandable || node.kind.type === "group") return;
      set((s) => ({
        children: prune(s.children, node.key, true),
        expanded: { ...prune(s.expanded, node.key, false), [node.key]: true },
      }));
      await load(node);
    },

    select: (key) => set({ selected: key }),

    setFilter: (key, text) =>
      set((s) => {
        const filters = { ...s.filters };
        if (text === null) delete filters[key];
        else filters[key] = text;
        return { filters };
      }),

    disconnect: async (connectionId) => {
      const key = serverKey(connectionId);
      set((s) => ({
        children: prune(s.children, key, true),
        expanded: prune(s.expanded, key, true),
        filters: prune(s.filters, key, true),
        servers: { ...s.servers, [connectionId]: undefined },
      }));
      await api.disconnect(connectionId);
    },
  };
});
