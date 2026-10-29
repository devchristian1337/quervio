import { create } from "zustand";
import { api, displayName, type SavedConnection } from "@/lib/api";

interface ConnectionsState {
  connections: SavedConnection[];
  loaded: boolean;
  load: () => Promise<void>;
  save: (connection: SavedConnection, password: string | null) => Promise<SavedConnection>;
  remove: (id: string) => Promise<void>;
  /** Moves connections into a group, or out of any with null. */
  setGroup: (ids: string[], group: string | null) => Promise<void>;
}

export const useConnections = create<ConnectionsState>((set, get) => ({
  connections: [],
  loaded: false,
  load: async () => {
    set({ connections: await api.listConnections(), loaded: true });
  },
  save: async (connection, password) => {
    const saved = await api.saveConnection(connection, password);
    const others = get().connections.filter((c) => c.id !== saved.id);
    const index = get().connections.findIndex((c) => c.id === saved.id);
    const connections = [...others];
    connections.splice(index === -1 ? others.length : index, 0, saved);
    set({ connections });
    return saved;
  },
  remove: async (id) => {
    await api.deleteConnection(id);
    set({ connections: get().connections.filter((c) => c.id !== id) });
  },
  setGroup: async (ids, group) => {
    const moved = new Map((await api.groupConnections(ids, group)).map((c) => [c.id, c]));
    set({ connections: get().connections.map((c) => moved.get(c.id) ?? c) });
  },
}));

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });

export interface ConnectionGroup {
  /** Null for the connections in no group. */
  group: string | null;
  connections: SavedConnection[];
}

/**
 * Saved Connections as the Object Explorer and the start screen list them:
 * the groups by name, then the connections in none, each by name, as in SSMS.
 */
export function byGroup(connections: SavedConnection[]): ConnectionGroup[] {
  const sorted = [...connections].sort((a, b) => byName(displayName(a), displayName(b)));
  const groups = [...new Set(sorted.flatMap((c) => (c.group ? [c.group] : [])))].sort(byName);
  const loose = sorted.filter((c) => !c.group);
  return [
    ...groups.map((group) => ({ group, connections: sorted.filter((c) => c.group === group) })),
    ...(loose.length > 0 ? [{ group: null, connections: loose }] : []),
  ];
}

/** The names of the connection groups, sorted. */
export function groupNames(connections: SavedConnection[]): string[] {
  return byGroup(connections).flatMap((g) => (g.group ? [g.group] : []));
}

export function newConnection(): SavedConnection {
  return {
    id: "",
    name: "",
    group: null,
    server: "",
    authentication: { kind: "sql", userName: "" },
    defaultDatabase: null,
    environment: "development",
    encrypt: "mandatory",
    // Checked by default, as in SSMS: a trusted certificate lets anyone on the
    // network path read the login, so it is opt-in per connection.
    trustServerCertificate: false,
  };
}

/** Why these settings leave the login readable on the network, if they do. */
export function transportWarning(connection: Pick<SavedConnection, "encrypt" | "trustServerCertificate">): string | null {
  if (connection.encrypt === "optional") {
    return "Optional encryption can be turned off by anyone on the network path, who can then read the login.";
  }
  if (connection.trustServerCertificate && connection.encrypt !== "strict") {
    return "The server's certificate and name are not checked, so anyone on the network path can read the login. Use it only for a server you trust with a self-signed certificate.";
  }
  return null;
}
