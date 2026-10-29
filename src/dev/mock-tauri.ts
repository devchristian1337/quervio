// Dev only: fake Rust commands so the UI can run in a plain browser
// (http://localhost:1420/?mock). Never bundled into a release build.
import type { Channel } from "@tauri-apps/api/core";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { CatalogItem, SavedConnection, SsmsConnection } from "@/lib/api";
import type { ExecutionEvent } from "@/lib/execution";

const connection: SavedConnection = {
  id: "mock",
  name: "Mock server",
  group: null,
  server: "localhost,14333",
  authentication: { kind: "sql", userName: "sa" },
  defaultDatabase: null,
  environment: "production",
  encrypt: "mandatory",
  trustServerCertificate: true,
};

// What the mock's SSMS knows: registered servers in groups, then its history.
const ssms: SsmsConnection[] = [
  ...[["Aurelia", "Aurelia [Ambulatorio]", "10.0.1.5"], ["Aurelia", "Aurelia [Ricoveri]", "10.0.1.6"], ["Camilliani", "Camilliani [APP SERVER]", "10.0.2.5"], ["Camilliani", "Camilliani [TEST SERVER]", "10.0.2.5", "H2O_TEST"], ["", "Nightly", "10.0.9.9"]].map(
    ([group, name, server, database = "H2O_BASE"]): SsmsConnection => ({
      id: `registered:${group}/${name}`, name, groups: group ? [group] : [], server, authentication: { kind: "sql", userName: "sa" },
      defaultDatabase: database, encrypt: "optional", trustServerCertificate: true, lastUsed: null, source: "registered", ssmsVersion: null, hasPassword: true,
    }),
  ),
  { id: "history:localhost,14333|sql:sa", name: "", groups: [], server: "localhost,14333", authentication: { kind: "sql", userName: "sa" }, defaultDatabase: null, encrypt: "optional", trustServerCertificate: true, lastUsed: Date.now() - 86_400_000, source: "history", ssmsVersion: "21.0", hasPassword: false },
  { id: "history:10.0.3.7|sql:app", name: "", groups: [], server: "10.0.3.7", authentication: { kind: "sql", userName: "app" }, defaultDatabase: null, encrypt: "optional", trustServerCertificate: true, lastUsed: Date.now() - 40 * 86_400_000, source: "history", ssmsVersion: "20.0", hasPassword: false },
];
// One connection as Quervio 0.1.14 imported it, before groups: the import moves it into Aurelia.
const saved: SavedConnection[] = [
  connection,
  { ...connection, id: "legacy", name: "Aurelia / Aurelia [Ambulatorio]", server: "10.0.1.5", environment: "test", defaultDatabase: "H2O_BASE", encrypt: "optional" },
];

const item = (name: string, extra: Partial<CatalogItem> = {}): CatalogItem => ({
  name,
  schema: null,
  objectId: null,
  detail: null,
  system: false,
  ...extra,
});

const server = { serverName: "mock", version: "16.0.0.0", database: "master" };

const MOCK_ROWS = 1_000_000;
const table = (columns: string[], rows: (string | null)[][] = []) => ({columns, rows, truncated: false});
const PLAN = `<ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan" Version="1.6" Build="16.0.0.0"><BatchSequence><Batch><Statements><StmtSimple StatementText="SELECT Id FROM dbo.Customer" StatementSubTreeCost="0.003"><QueryPlan><RelOp NodeId="0" PhysicalOp="Clustered Index Scan" LogicalOp="Clustered Index Scan" EstimateRows="100" EstimatedTotalSubtreeCost="0.003"><RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="100" /></RunTimeInformation><IndexScan /></RelOp></QueryPlan></StmtSimple></Statements></Batch></BatchSequence></ShowPlanXML>`;
const previews = new Map<string, string>();
const COLUMNS = ["Id", "Name", "Notes", "Payload"];

let mockDescending = false;

/** Synthetic cell: NULL every 7th Notes, long JSON in Payload. */
function mockCell(shown: number, column: number): string | null {
  const row = mockDescending ? MOCK_ROWS - 1 - shown : shown;
  switch (column) {
    case 0:
      return String(row + 1);
    case 1:
      return `Customer ${row + 1}`;
    case 2:
      return row % 7 === 0 ? null : `note | line one\nline two ${row}`;
    default:
      return JSON.stringify({ id: row, tags: ["a", "b"], text: "x".repeat(600) });
  }
}

function encodeWindow(start: number, count: number): ArrayBuffer {
  const encoder = new TextEncoder();
  const rows = Math.max(0, Math.min(count, MOCK_ROWS - start));
  const parts: number[] = [];
  const u32 = (n: number) => parts.push(n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255);
  u32(rows);
  u32(COLUMNS.length);
  for (let r = start; r < start + rows; r++) {
    for (let c = 0; c < COLUMNS.length; c++) {
      const text = mockCell(r, c);
      if (text === null) {
        parts.push(1);
        u32(0);
        continue;
      }
      const preview = text.length > 500 ? text.slice(0, 500) : text;
      const bytes = encoder.encode(preview);
      parts.push(text.length > 500 ? 2 : 0);
      u32(bytes.length);
      for (const b of bytes) parts.push(b);
    }
  }
  return new Uint8Array(parts).buffer;
}

mockIPC(async (cmd, args) => {
  const a = args as Record<string, unknown>;
  switch (cmd) {
    case "management_capabilities":return {version: "16.0.0.0", majorVersion: 16, edition: "Developer Edition · browser mock", engineEdition: 3, database: a.database ?? "master", features: Object.fromEntries(["plans", "monitor", "live", "queryStore", "agent", "backup", "events", "audit", "tde", "alwaysEncrypted"].map(f => [f, {state: "available", reason: ""}]))};
    case "management_dependencies":return [{name: "Microsoft bridge (.NET 10, SMO, DacFx, SqlClient)", path: null, available: false, help: "Configure components in the desktop app."}, {name: "SQL Tools Service", path: null, available: false, help: "Browser mock uses catalog completion."}];
    case "management_read": {
      const r = a.resource as Record<string, unknown>;
      switch (r.kind) {
        case "objects":return table(["schema", "name", "object_id", "type_desc", "modify_date"], [["dbo", "Customer", "1", "USER_TABLE", "2026-10-28"], ["sales", "Order", "2", "USER_TABLE", "2026-10-28"], ["dbo", "CustomerNames", "3", "VIEW", "2026-10-28"]]);
        case "columns":return table(["column_id", "name", "type", "max_length", "precision", "scale", "is_nullable", "is_identity", "is_computed", "default_name", "default_expression", "computed_expression", "identity_seed", "identity_increment"], [["1", "Id", "int", "4", "10", "0", "0", "1", "0", null, null, null, "1", "1"], ["2", "Name", "nvarchar", "200", "0", "0", "0", "0", "0", null, null, null, null, null]]);
        case "relations":return table(["name", "parent_schema", "parent_table", "parent_column", "referenced_schema", "referenced_table", "referenced_column", "constraint_column_id", "delete_referential_action_desc", "update_referential_action_desc"], [["FK_Order_Customer", "sales", "Order", "CustomerId", "dbo", "Customer", "Id", "1", "NO_ACTION", "NO_ACTION"]]);
        case "definition":return table(["definition"], [["CREATE VIEW dbo.CustomerNames AS SELECT Id, Name FROM dbo.Customer;"]]);
        case "properties":return table(["name", "state_desc", "recovery_model_desc", "compatibility_level"], [[String(a.database ?? "master"), "ONLINE", "FULL", "160"]]);
        case "activity":return table(["session_id", "login_name", "database_name", "status", "command", "blocking_session_id", "wait_type", "wait_ms", "cpu_ms", "elapsed_ms", "text"], [["52", "support", "Sales", "running", "SELECT", "0", null, "0", "12", "35", "SELECT Id, Name FROM dbo.Customer"]]);
        case "health": {
          // Moves a little on each read, like a live server.
          const wobble = (base: number, spread: number, whole = false) => {const v = Math.max(0, base + (Math.random() - 0.5) * spread);return String(whole ? Math.round(v) : v);};
          const now = new Date();
          return table(
            ["server_name", "product_version", "edition", "sampled_at", "cpu_count", "max_workers_count", "active_workers", "started_at", "total_physical_memory_kb", "available_physical_memory_kb", "physical_memory_in_use_kb", "volume_bytes", "volume_used_percent", "cpu_percent", "batch_requests", "memory_grants_pending", "user_sessions", "active_requests", "blocked_requests", "database_name", "state_desc", "recovery_model_desc", "compatibility_level", "data_bytes", "data_used_bytes", "log_bytes", "log_used_percent"],
            [["MOCK-SQL01", "16.0.4305.5", "Developer Edition (64-bit)", now.toISOString().slice(0, 23), "8", "576", wobble(60, 20, true), new Date(now.getTime() - 9.5 * 3600e3).toISOString().slice(0, 23), "16777216", wobble(5000000, 400000, true), "6291456", "536870912000", "71.4", wobble(38, 30), String(Math.floor(now.getTime() / 100)), "0", "14", wobble(3, 4, true), "1", String(a.database ?? "master"), "ONLINE", "FULL", "160", "2147483648", "1610612736", "536870912", wobble(22, 6)]],
          );
        }
        case "waits":return table(["wait_type", "waiting_tasks_count", "wait_time_ms", "signal_wait_time_ms"], [["PAGEIOLATCH_SH", "15", "120", "4"]]);
        case "io":return table(["database_name", "name", "num_of_reads", "num_of_writes", "io_stall_read_ms", "io_stall_write_ms"], [["Sales", "Sales_Data", "400", "120", "38", "12"]]);
        case "cpu":return table(["sample_tick", "sql_process_cpu_percent", "system_idle_percent"], [["1000", "3", "90"], ["2000", "4", "89"], ["3000", "2", "94"]]);
        case "queryStoreOptions":return table(["actual_state_desc", "desired_state_desc", "current_storage_size_mb", "max_storage_size_mb"], [["READ_WRITE", "READ_WRITE", "12", "1000"]]);
        case "queryStoreQueries":case "queryStoreRegressions":return table(["query_id", "query_sql_text", "executions", "avg_duration_us", "plans"], [["1", "SELECT Id, Name FROM dbo.Customer", "15", "35000", "2"]]);
        case "queryStorePlans":return table(["plan_id", "query_id", "is_forced_plan", "force_failure_count", "avg_duration_us"], [["1", "1", "0", "0", "35000"], ["2", "1", "0", "0", "18000"]]);
        case "queryStorePlan":case "live":return table(["query_plan"], [[PLAN]]);
        case "eventData":return table(["target_data"], [[`<RingBufferTarget><event name="sql_batch_completed" timestamp="2026-10-28T12:00:00Z"><data name="duration"><value>35000</value></data><action name="sql_text"><value>SELECT Id FROM dbo.Customer</value></action></event></RingBufferTarget>`]]);
        case "principals":return table(["principal_id", "name", "type_desc"], [["1", "dbo", "SQL_USER"]]);
        case "roles":return table(["role_name", "member_name"], [["db_datareader", "support"]]);
        default:return table(["name"]);
      }
    }
    case "management_prepare": {const token = crypto.randomUUID();previews.set(token, String(a.script));return {token, script: a.script, server: "Mock server", database: a.database ?? "master", expiresInSeconds: 300};}
    case "management_bridge_prepare":return {token: crypto.randomUUID(), server: "Mock server", database: a.database ?? "master"};
    case "management_apply": {if (!a.confirmed || !previews.delete(String(a.token))) throw new Error("Invalid preview.");return ["Browser mock: no SQL was submitted."];}
    case "management_discard":previews.delete(String(a.token));return null;
    case "management_bridge": {
      const request=a.request as {action:string};
      if(request.action==="importPreview")return table(["Id","Name"],[["1","Rossi"],["2",""]]);
      if(request.action==="dacPreview")return {packageHash:"mock-package",script:"-- Browser mock: no deployment was generated.",report:"<DeploymentReport/>"};
      if(request.action==="encryptedQuery")return {sets:[table(["Id","Name"],[["1","Rossi"]])]};
      return {mock: true, message: "No Microsoft operation was executed in browser mock mode."};
    }
    case "query_sqlcmd_prepare":return /:r\b/i.test(String(a.script)) && a.allowFileReads !== true ? {kind: "fileAccessRequired"} : {kind: "ready", token: "mock-sqlcmd", script: a.script, hasLocalCommands: /!!|:out|:error/i.test(String(a.script))};
    case "language_request":return {result: null};
    // Copies, as IPC hands over: the page must not share the mock's objects.
    case "list_connections":
      return structuredClone(saved);
    case "group_connections": {
      const moved = saved.filter((c) => (a.ids as string[]).includes(c.id));
      for (const c of moved) c.group = (a.group as string | null)?.trim() || null;
      return structuredClone(moved);
    }
    case "ssms_connections":
      return ssms;
    case "ssms_import":
      for (const pick of a.picks as { id: string; environment: SavedConnection["environment"] | null; existing: string | null }[]) {
        const found = ssms.find((c) => c.id === pick.id);
        if (!found) continue;
        const group = found.groups.join(" / ") || null;
        const existing = saved.find((c) => c.id === pick.existing);
        if (existing) Object.assign(existing, { group, name: found.name, environment: pick.environment ?? existing.environment });
        else saved.push({ id: crypto.randomUUID(), name: found.name, group, server: found.server, authentication: found.authentication, defaultDatabase: found.defaultDatabase, environment: pick.environment ?? "production", encrypt: found.encrypt, trustServerCertificate: found.trustServerCertificate });
      }
      return structuredClone(saved);
    case "explorer_connect":
    case "test_connection":
      return server;
    case "explorer_databases":
    case "connection_databases":
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
      if ((a.options as {planMode?: string} | undefined)?.planMode !== "none" && (a.options as {planMode?: string} | undefined)?.planMode) send({type: "plan", xml: PLAN});
      // WAITFOR DELAY '00:00:05' makes the mock slow, to see the running state.
      const wait = /waitfor\s+delay\s+'00:00:(\d\d)'/i.exec(String(a.script));
      if (wait) await new Promise((resolve) => setTimeout(resolve, Number(wait[1]) * 1000));
      send({ type: "resultSetStarted", index: 0, columns: COLUMNS.map((name, i) => ({ name, kind: i === 0 ? "number" : "text" })) });
      send({ type: "resultSetFinished", index: 0, rows: MOCK_ROWS });
      send({ type: "rowsAffected", count: MOCK_ROWS });
      send({ type: "finished", outcome: "succeeded", elapsedMs: 1234, database: "master", openTransactions: 0 });
      return "succeeded";
    }
    case "result_sort":
      // Only Id sorts in the mock: descending reverses the rows.
      mockDescending = a.column === 0 && a.direction === "descending";
      return null;
    case "result_rows":
      return encodeWindow(a.start as number, a.count as number);
    case "result_cell": {
      const text = mockCell(a.row as number, a.column as number);
      return { text, clipped: false };
    }
    case "result_copy":
      return {
        rows: (a.rows as number[])[1] - (a.rows as number[])[0],
        columns: (a.columns as number[])[1] - (a.columns as number[])[0],
      };
    case "query_check": {
      // Rough stand-in for the Rust check: any DELETE counts.
      const lines = String(a.script).split(/\r?\n/);
      const findings = lines.flatMap((text, i) =>
        /\bdelete\b/i.test(text)
          ? [{ kind: "deleteWithoutWhere", target: "dbo.Customer", line: (a.baseLine as number) + i + 1 }]
          : [],
      );
      return { findings, uncertain: false };
    }
    case "explorer_script":
      return a.kind === "selectTop"
        ? "SELECT TOP (1000)\n      [Id]\n     ,[Name]\n  FROM [dbo].[Customer];\n"
        : "CREATE TABLE [dbo].[Customer] (\n    [Id] int IDENTITY(1, 1) NOT NULL,\n    [Name] nvarchar(100) NOT NULL\n);\n";
    case "tabs_load":
      return localStorage.getItem("quervio.mock.tabs");
    case "tabs_save":
      localStorage.setItem("quervio.mock.tabs", a.snapshot as string);
      return null;
    case "settings_load":
      return localStorage.getItem("quervio.mock.settings");
    case "settings_save":
      localStorage.setItem("quervio.mock.settings", a.settings as string);
      return null;
    case "settings_data_dir":
      return String.raw`C:\Users\mock\AppData\Roaming\com.quervio.app`;
    case "update_check":
      if (new URLSearchParams(location.search).has("update-error"))
        throw "https://github.com/devchristian1337/quervio/releases cannot be read: the repository is private or does not exist.";
      return { installed: true, current: "0.1.0-mock", available: "0.1.1-mock", ready: false, empty: false };
    case "update_download": {
      const channel = a.onProgress as Channel<number>;
      for (const percent of [0, 25, 50, 75, 100]) channel.onmessage(percent);
      return null;
    }
    case "update_apply":
      return null;
    case "plugin:app|version":
      return "0.1.0-mock";
    case "plugin:app|tauri_version":
      return "2.x";
    case "file_read":
      return "SELECT 'from a file';\n";
    case "file_write":
      return null;
    case "query_use_database":
      return a.database;
    case "query_end_transactions":
      return 0;
    default:
      return null;
  }
});
