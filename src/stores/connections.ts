import { create } from "zustand";
import { api, type SavedConnection } from "@/lib/api";

interface ConnectionsState {
  connections: SavedConnection[];
  loaded: boolean;
  load: () => Promise<void>;
  save: (connection: SavedConnection, password: string | null) => Promise<SavedConnection>;
  remove: (id: string) => Promise<void>;
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
}));

export function newConnection(): SavedConnection {
  return {
    id: "",
    name: "",
    server: "",
    authentication: { kind: "sql", userName: "" },
    defaultDatabase: null,
    environment: "development",
    encrypt: "mandatory",
    trustServerCertificate: true,
  };
}
