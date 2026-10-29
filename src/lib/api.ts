// Typed wrappers around the Tauri commands in src-tauri/src/explorer.rs.
// Shapes mirror quervio-core's serde output.
import { invoke, type Channel } from "@tauri-apps/api/core";
import type { ExecutionEvent, Outcome } from "@/lib/execution";

export type SortDirection = "ascending" | "descending";

/** Mirrors ExecuteOptions in src-tauri/src/query.rs. */
export interface ExecuteOptions {
  planMode?: "none" | "estimated" | "actual";
  /** 0 waits forever. */
  timeoutSeconds: number;
  maxRows: number;
  maxCellBytes: number;
}

export type Environment = "production" | "test" | "development";
export type Encrypt = "mandatory" | "optional" | "strict";

export type Authentication =
  | { kind: "sql"; userName: string }
  | { kind: "windows" }
  | { kind: "entra" };

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

/** A connection SSMS knows (crates/quervio-core/src/ssms.rs), to import. */
export interface SsmsConnection {
  id: string;
  /** The registered server's name; empty for a history entry. */
  name: string;
  /** The registered server's groups, outermost first. */
  groups: string[];
  server: string;
  authentication: Authentication;
  defaultDatabase: string | null;
  encrypt: Encrypt;
  trustServerCertificate: boolean;
  /** Milliseconds since the Unix epoch. */
  lastUsed: number | null;
  source: "registered" | "history";
  ssmsVersion: string | null;
  hasPassword: boolean;
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

export type ObjectFolder = "tables" | "views" | "storedProcedures" | "functions" | "databaseTriggers";
export type TableFolder = "columns" | "keys" | "indexes" | "triggers";

export const api = {
  listConnections: () => invoke<SavedConnection[]>("list_connections"),
  saveConnection: (connection: SavedConnection, password: string | null) =>
    invoke<SavedConnection>("save_connection", { connection, password }),
  deleteConnection: (id: string) => invoke<void>("delete_connection", { id }),
  /** What SSMS knows on this PC, or the registered servers of an exported .regsrvr file. */
  ssmsConnections: (file: string | null) => invoke<SsmsConnection[]>("ssms_connections", { file }),
  ssmsImport: (file: string | null, picks: { id: string; environment: Environment }[]) =>
    invoke<SavedConnection[]>("ssms_import", { file, picks }),
  testConnection: (connection: SavedConnection, password: string | null) =>
    invoke<ServerInfo>("test_connection", { connection, password }),
  connectionDatabases: (connection: SavedConnection, password: string | null) =>
    invoke<CatalogItem[]>("connection_databases", { connection, password }),
  connect: (id: string) => invoke<ServerInfo>("explorer_connect", { id }),
  disconnect: (id: string) => invoke<void>("explorer_disconnect", { id }),
  databases: (id: string) => invoke<CatalogItem[]>("explorer_databases", { id }),
  objects: (id: string, database: string, folder: ObjectFolder) =>
    invoke<CatalogItem[]>("explorer_objects", { id, database, folder }),
  tableChildren: (id: string, database: string, objectId: number, folder: TableFolder) =>
    invoke<CatalogItem[]>("explorer_table_children", { id, database, objectId, folder }),

  openQuery: (tabId: string, connectionId: string, database: string | null) =>
    invoke<ServerInfo>("query_open", { tabId, connectionId, database }),
  closeQuery: (tabId: string) => invoke<void>("query_close", { tabId }).then(()=>{void invoke("language_close",{tabId}).catch(()=>{});}),
  executeQuery: (
    tabId: string,
    script: string,
    baseLine: number,
    options: ExecuteOptions,
    allowDestructive: boolean,
    onEvent: Channel<ExecutionEvent>,
  ) => invoke<Outcome>("query_execute", { tabId, script, baseLine, options, allowDestructive, onEvent }),
  sqlcmdPrepare: (tabId: string, script: string, filePath: string | null, baseLine: number) => invoke<{token: string; script: string; hasLocalCommands: boolean}>("query_sqlcmd_prepare", {tabId, script, filePath, baseLine}),
  sqlcmdExecute: (tabId: string, token: string, options: ExecuteOptions, onEvent: Channel<ExecutionEvent>) => invoke<Outcome>("query_sqlcmd_execute", {tabId, token, confirmed: true, options, onEvent}),
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
  resultExportFile: (tabId: string, set: number, path: string, format: "csv" | "xlsx") => invoke<void>("result_export_file", {tabId,set,path,format}),

  script: (id: string, database: string, objectId: number, kind: ScriptKind) =>
    invoke<string>("explorer_script", { id, database, objectId, kind }),
  fileRead: (path: string) => invoke<string>("file_read", { path }),
  fileWrite: (path: string, text: string) => invoke<void>("file_write", { path, text }),
  tabsLoad: () => invoke<string | null>("tabs_load"),
  settingsLoad: () => invoke<string | null>("settings_load"),
  settingsSave: (settings: string) => invoke<void>("settings_save", { settings }),
  dataDir: () => invoke<string>("settings_data_dir"),
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
