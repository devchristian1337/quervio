// Dev only: fake Rust commands so the UI can run in a plain browser
// (http://localhost:1420/?mock). Never bundled into a release build.
import type { Channel } from "@tauri-apps/api/core";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { CatalogItem, SavedConnection } from "@/lib/api";
import type { ExecutionEvent } from "@/lib/execution";

const connection: SavedConnection = {
  id: "mock",
  name: "Mock server",
  server: "localhost,14333",
  authentication: { kind: "sql", userName: "sa" },
  defaultDatabase: null,
  environment: "development",
  encrypt: "mandatory",
  trustServerCertificate: true,
};

const item = (name: string, extra: Partial<CatalogItem> = {}): CatalogItem => ({
  name,
  schema: null,
  objectId: null,
  detail: null,
  system: false,
  ...extra,
});

const server = { serverName: "mock", version: "16.0.0.0", database: "master" };

mockIPC(async (cmd, args) => {
  const a = args as Record<string, unknown>;
  switch (cmd) {
    case "list_connections":
      return [connection];
    case "explorer_connect":
    case "test_connection":
      return server;
    case "explorer_databases":
      return [item("master", { system: true }), item("Sales")];
    case "explorer_objects":
      return [item("Customer", { schema: "dbo", objectId: 1 })];
    case "explorer_table_children":
      return [item("CustomerId", { detail: "PK, int, not null" })];
    case "query_open":
      return { ...server, database: (a.database as string | null) ?? "master" };
    case "query_execute": {
      const channel = a.onEvent as Channel<ExecutionEvent>;
      const send = (event: ExecutionEvent) => channel.onmessage(event);
      send({ type: "batchStarted", batch: 0, firstLine: 0 });
      send({ type: "resultSetStarted", index: 0, columns: [{ name: "CustomerId" }, { name: "Name" }] });
      send({ type: "resultSetFinished", index: 0, rows: 2 });
      send({ type: "rowsAffected", count: 2 });
      send({ type: "message", text: "ciao", isError: false, header: null, line: null });
      send({
        type: "message",
        text: "Invalid object name 'missing'.",
        isError: true,
        header: "Msg 208, Level 16, State 1, Line 2",
        line: 2,
      });
      send({ type: "finished", outcome: "failed", elapsedMs: 42, database: "master", openTransactions: 0 });
      return "failed";
    }
    default:
      return null;
  }
});
