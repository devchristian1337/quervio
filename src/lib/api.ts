// Typed wrappers around the Tauri commands in src-tauri/src/explorer.rs.
// Shapes mirror quervio-core's serde output.
import { invoke, type Channel } from "@tauri-apps/api/core";
import type { ExecutionEvent, Outcome } from "@/lib/execution";

export type SortDirection = "ascending" | "descending";

export type Environment = "production" | "test" | "development";
export type Encrypt = "mandatory" | "optional" | "strict";

export type Authentication =
  | { kind: "sql"; userName: string }
  | { kind: "windows" };

export interface SavedConnection {
  id: string;
  name: string;
  server: string;
  authentication: Authentication;
  defaultDatabase: string | null;
  environment: Environment;
  encrypt: Encrypt;
  trustServerCertificate: boolean;
}

export interface ServerInfo {
  serverName: string;
  version: string;
  database: string;
}

export interface CatalogItem {
  name: string;
  schema: string | null;
  objectId: number | null;
  detail: string | null;
  system: boolean;
}

export type CopyFormat = "text" | "textWithHeaders" | "markdown";

/** Mirrors explorer::ScriptKind. */
export type ScriptKind = "selectTop" | "createTable" | "create" | "alter";

export type ObjectFolder = "tables" | "views" | "storedProcedures" | "functions";
export type TableFolder = "columns" | "keys" | "indexes" | "triggers";

export const api = {
  listConnections: () => invoke<SavedConnection[]>("list_connections"),
  saveConnection: (connection: SavedConnection, password: string | null) =>
    invoke<SavedConnection>("save_connection", { connection, password }),
  deleteConnection: (id: string) => invoke<void>("delete_connection", { id }),
  testConnection: (connection: SavedConnection, password: string | null) =>
    invoke<ServerInfo>("test_connection", { connection, password }),
  connect: (id: string) => invoke<ServerInfo>("explorer_connect", { id }),
  disconnect: (id: string) => invoke<void>("explorer_disconnect", { id }),
  databases: (id: string) => invoke<CatalogItem[]>("explorer_databases", { id }),
  objects: (id: string, database: string, folder: ObjectFolder) =>
    invoke<CatalogItem[]>("explorer_objects", { id, database, folder }),
  tableChildren: (id: string, database: string, objectId: number, folder: TableFolder) =>
    invoke<CatalogItem[]>("explorer_table_children", { id, database, objectId, folder }),

  openQuery: (tabId: string, connectionId: string, database: string | null) =>
    invoke<ServerInfo>("query_open", { tabId, connectionId, database }),
  closeQuery: (tabId: string) => invoke<void>("query_close", { tabId }),
  executeQuery: (tabId: string, script: string, baseLine: number, onEvent: Channel<ExecutionEvent>) =>
    invoke<Outcome>("query_execute", { tabId, script, baseLine, onEvent }),
  cancelQuery: (tabId: string) => invoke<void>("query_cancel", { tabId }),

  resultRows: (tabId: string, set: number, start: number, count: number) =>
    invoke<ArrayBuffer>("result_rows", { tabId, set, start, count }),
  resultSort: (tabId: string, set: number, column: number | null, direction: SortDirection) =>
    invoke<void>("result_sort", { tabId, set, column, direction }),
  resultCell: (tabId: string, set: number, row: number, column: number) =>
    invoke<{ text: string | null; clipped: boolean } | null>("result_cell", { tabId, set, row, column }),
  resultCopy: (
    tabId: string,
    set: number,
    rows: [number, number],
    columns: [number, number],
    format: CopyFormat,
  ) => invoke<{ rows: number; columns: number }>("result_copy", { tabId, set, rows, columns, format }),
  resultExportMarkdown: (tabId: string, set: number, path: string) =>
    invoke<void>("result_export_markdown", { tabId, set, path }),

  script: (id: string, database: string, objectId: number, kind: ScriptKind) =>
    invoke<string>("explorer_script", { id, database, objectId, kind }),
  fileRead: (path: string) => invoke<string>("file_read", { path }),
  fileWrite: (path: string, text: string) => invoke<void>("file_write", { path, text }),
  tabsLoad: () => invoke<string | null>("tabs_load"),
  tabsSave: (snapshot: string) => invoke<void>("tabs_save", { snapshot }),

  checkScript: (script: string, baseLine: number) => invoke<ScriptCheck>("query_check", { script, baseLine }),
  useDatabase: (tabId: string, database: string) => invoke<string>("query_use_database", { tabId, database }),
  endTransactions: (tabId: string, commit: boolean) =>
    invoke<number>("query_end_transactions", { tabId, commit }),
};

/** Mirrors quervio_core::guard::Check. */
export interface ScriptCheck {
  findings: {
    kind: "updateWithoutWhere" | "deleteWithoutWhere" | "truncate" | "drop" | "alterTable";
    target: string;
    line: number;
  }[];
  uncertain: boolean;
}

export function displayName(connection: SavedConnection) {
  return connection.name.trim() || connection.server;
}

/** Tauri rejects with the Rust error's message as a plain string. */
export function errorMessage(error: unknown) {
  return typeof error === "string" ? error : error instanceof Error ? error.message : String(error);
}
