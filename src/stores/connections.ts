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
