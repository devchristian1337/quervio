// Dev only: what the fake Rust commands return under the data switch
// (?mock&data=worst|empty|one|huge), beside the Saved Connections in
// connection-fixtures.ts. Every value is one SQL Server or a support desk
// really produces, or the limit SQL Server allows (sysname is 128 chars).
import type { CatalogItem } from "@/lib/api";
import type { FixtureName } from "@/dev/connection-fixtures";

/** Returned when the mode leaves a command to the demo mock. */
export const UNHANDLED = Symbol("unhandled");

type Mode = Exclude<FixtureName, "demo">;
type Args = Record<string, unknown>;

/** A name exactly sysname long, from a realistic stem. */
export const sysname = (stem: string) => (stem + "_" + "Storico".repeat(20)).slice(0, 128);

const item = (name: string, extra: Partial<CatalogItem> = {}): CatalogItem => ({
  name,
  schema: null,
  objectId: null,
  detail: null,
  system: false,
  ...extra,
});

/** By mode: none, one, the worst handful followed by many, or very many. */
function sized<T>(mode: Mode, worst: T[], filler: (i: number) => T, many: number, huge: number): T[] {
  if (mode === "empty") return [];
  if (mode === "one") return [worst[0] ?? filler(0)];
  const count = mode === "huge" ? huge : many;
  return [...worst, ...Array.from({ length: Math.max(0, count - worst.length) }, (_, i) => filler(i))];
}

/** A Kerberos failure as SQL Server reports it: long, one unbreakable SPN, a newline. */
export const LONG_ERROR =
  "Login failed. The login is from an untrusted domain and cannot be used with Integrated authentication. (Microsoft SQL Server, Error: 18452)\n" +
  "Cannot generate SSPI context for MSSQLSvc/sql-ag-listener-prod-westeurope-01.corp.northwind-industries-holdings.example.com:14333. " +
  "The target principal name is incorrect. Check that the SPN is registered for the service account CORP\\svc_mssql_clinical_records_prod and that the client and server clocks are within 5 minutes.";

const SERVER = String.raw`MSSQL-PRD-WEU-AG01\INSTANCE_CLINICAL_RECORDS_2022`;
const LONG_DATABASE = sysname("H2O_AMBULATORIO_PRODUZIONE");

const databases = (mode: Mode) =>
  sized(
    mode,
    [
      item("master", { system: true }),
      item("tempdb", { system: true }),
      item(LONG_DATABASE),
      item("Sales"),
      item("sales"),
      item("Ünïcödé_DB 🦊"),
      item("[Weird] Name; DROP"),
      item("trailing space "),
      item("客户数据"),
    ],
    (i) => item(`H2O_CLIENTE_${String(i + 1).padStart(4, "0")}`),
    400,
    5000,
  );

const objects = (mode: Mode, folder: string) =>
  sized(
    mode,
    [
      item(sysname("ProcessoClinicoRicoveroAmbulatoriale"), { schema: sysname("schema_integrazione_regionale"), objectId: 1, detail: folder === "tables" ? null : "2026-10-28" }),
      item("ProcessoClinicoRicoveroAmbulatorialePrestazioniErogateStoricoMovimentazioni", { schema: "dbo", objectId: 2 }),
      item("客户订单", { schema: "dbo", objectId: 3 }),
      item("T", { schema: "x", objectId: 4 }),
      item("NoSchema", { objectId: 5 }),
      item("NoObjectId", { schema: "dbo" }),
    ],
    (i) => item(`Tabella_${String(i + 1).padStart(5, "0")}`, { schema: ["dbo", "sales", "h2o", "audit"][i % 4], objectId: 100 + i }),
    3000,
    30000,
  );

const tableChildren = (mode: Mode) =>
  sized(
    mode,
    [
      item(sysname("CodiceIdentificativoPrestazioneRegionale"), { detail: "FK, dbo.VeryLongUserDefinedTypeName_PhoneNumberInternational(256), not null, computed" }),
      item("Id", { detail: "PK, int, not null" }),
      item("Note", { detail: "nvarchar(max), null" }),
      item("x", { detail: null }),
    ],
    (i) => item(`Colonna_${i + 1}`, { detail: "nvarchar(50), null" }),
    1024,
    1024,
  );

/** 40 restored Query Tabs: long file names, a 255-char title, a sysname database. */
function tabsSnapshot() {
  const tab = (title: string, extra: Record<string, unknown> = {}) => ({
    title,
    connectionId: "w-long",
    database: "H2O_BASE",
    filePath: null,
    dirty: false,
    text: "SELECT 1;\n",
    ...extra,
  });
  return JSON.stringify({
    tabs: [
      tab("Q3 Board Deck — FINAL (revised) v12 [approved by legal].sql", {
        filePath: String.raw`C:\Users\christian\OneDrive - Northwind Industries Holdings\Progetti\2026\Clienti\Niguarda\Q3 Board Deck — FINAL (revised) v12 [approved by legal].sql`,
        dirty: true,
      }),
      tab(("estrazione_prestazioni_ambulatoriali_regione_lombardia_" + "flusso_c_".repeat(30)).slice(0, 255) + ".sql", { dirty: true }),
      tab("Query 3", { database: LONG_DATABASE, connectionId: "w-entra" }),
      ...Array.from({ length: 37 }, (_, i) => tab(`Query ${i + 4}`, { connectionId: i % 2 ? "w-short" : "w-long" })),
    ],
    active: 39,
  });
}

let worstTabs: string | null = null;
let worstSettings: string | null = null;

// ---- Management tools ---------------------------------------------------

const LOGIN = String.raw`NORTHWIND\svc_h2o_reporting_readonly_ambulatorio`;
const SQL_TEXT = ("SELECT o.Id,\n\to.Customer_Order_Line_Item_Shipping_Address_Verification_Status\nFROM dbo.Orders AS o WITH (NOLOCK)\nWHERE o.Id IN (SELECT Id FROM dbo.Lines)\n").repeat(30).slice(0, 4000);
const BACKUP_PATH = String.raw`\\nas-backup-01.northwind-industries-holdings.example.com\sql$\H2O_BASE\FULL\H2O_BASE_FULL_20261103_020000_COPY_ONLY_COMPRESSED.bak`;
type Cell = string | null;
const table = (columns: string[], rows: Cell[][], truncated = false) => ({ columns, rows, truncated });

/** As management.rs reads them: at most 1,000 rows, then truncated. */
function rows(mode: Mode, worst: Cell[][], filler: (i: number) => Cell[]) {
  const all = sized(mode, worst, filler, 1000, 1000);
  return { list: all, truncated: mode === "worst" || mode === "huge" };
}

function managementRead(mode: Mode, a: Args) {
  const kind = (a.resource as { kind: string }).kind;
  const db = (a.database as string | null) ?? "master";
  const pick = (columns: string[], worst: Cell[][], filler: (i: number) => Cell[]) => {
    const r = rows(mode, worst, filler);
    return table(columns, r.list, r.truncated);
  };
  switch (kind) {
    case "health": {
      if (mode === "empty") return table([], []);
      const now = new Date();
      return table(
        ["server_name", "product_version", "edition", "sampled_at", "cpu_count", "max_workers_count", "active_workers", "started_at", "total_physical_memory_kb", "available_physical_memory_kb", "physical_memory_in_use_kb", "volume_bytes", "volume_used_percent", "cpu_percent", "batch_requests", "memory_grants_pending", "user_sessions", "active_requests", "blocked_requests", "database_name", "state_desc", "recovery_model_desc", "compatibility_level", "data_bytes", "data_used_bytes", "log_bytes", "log_used_percent"],
        [["SQLPRDCLU01-NODE02\\" + sysname("INSTANCE_CLINICAL_RECORDS").slice(0, 110), "16.0.4305.5", "Enterprise Edition: Core-based Licensing (64-bit)", now.toISOString().slice(0, 23), "128", "3000", "2999", new Date(now.getTime() + 3600e3).toISOString().slice(0, 23), "16777216", "17179869184", "16777216", "17592186044416", "-3", "142.857142857142", String(Math.floor(now.getTime() / 100)), "1284", "32767", "1284", "1284", db === "master" ? LONG_DATABASE : db, "RECOVERY_PENDING", "BULK_LOGGED", "160", "0", "0", "17592186044416", null]],
      );
    }
    case "activity":
      return pick(
        ["session_id", "login_name", "database_name", "status", "command", "blocking_session_id", "wait_type", "wait_ms", "cpu_ms", "elapsed_ms", "text"],
        [["32767", LOGIN, LONG_DATABASE, "suspended", "SELECT", "-5", "LCK_M_X", "2147483647", "9223372036854775807", "86400000", SQL_TEXT], ["52", "王秀英", "", "running", "", null, null, "", "0", "0", null]],
        (i) => [String(51 + i), i % 2 ? LOGIN : "sa", "H2O_BASE", "sleeping", "AWAITING COMMAND", "0", null, "0", String(i * 17), String(i * 1000), "SELECT 1"],
      );
    case "waits":
      return pick(["wait_type", "waiting_tasks_count", "wait_time_ms", "signal_wait_time_ms"], [["PREEMPTIVE_OS_AUTHORIZATIONOPS_WITH_A_LONG_SUFFIX", "9223372036854775807", "35123.456789012345", null]], (i) => [`WAIT_${i}`, String(i), String(i * 10), "0"]);
    case "io":
      return pick(["database_name", "name", "num_of_reads", "num_of_writes", "io_stall_read_ms", "io_stall_write_ms"], [[LONG_DATABASE, `D:\\Data\\${LONG_DATABASE}_data_file_00017.ndf`, "17592186044416", "0", "-1", null]], (i) => [`DB_${i}`, `DB_${i}_Data`, String(i), String(i), "0", "0"]);
    case "cpu":
      return pick(["sample_tick", "sql_process_cpu_percent", "system_idle_percent"], [["1234567890123", null, "0"]], (i) => [String(1000 + i * 1000), String(i % 100), String(100 - (i % 100))]);
    case "queryStoreQueries":
    case "queryStoreRegressions":
      return pick(["query_id", "query_sql_text", "executions", "avg_duration_us", "plans"], [["9223372036854775807", SQL_TEXT, "1284", "35123.456789012345", "300"], ["2", "", null, "0.30000000000000004", null]], (i) => [String(i + 3), `SELECT ${i}`, String(i), String(i * 1000), "1"]);
    case "queryStorePlans":
      return pick(["plan_id", "query_id", "is_forced_plan", "force_failure_count", "avg_duration_us"], [["7", "1", "1", "1284", null], ["8", "1", "0", "0", "35123.456789012345"]], (i) => [String(i + 9), "1", "0", "0", String(i * 100)]);
    case "eventData":
      return table(["target_data"], mode === "empty" ? [] : [["<RingBufferTarget><event name=\"sql_batch_completed\""]]);
    case "objects":
      return pick(["schema", "name", "object_id", "type_desc", "modify_date"], [[sysname("schema_integrazione_regionale"), sysname("ProcessoClinicoRicoveroAmbulatoriale"), "1", "USER_TABLE", "2026-10-28"], ["dbo", "客户订单", "2", "USER_TABLE", "1900-01-01"], ["dbo", `FK_${sysname("Customer_Order_Line_Item").slice(0, 125)}`, "3", "FOREIGN_KEY_CONSTRAINT", null]], (i) => ["dbo", `Tabella_${String(i).padStart(5, "0")}`, String(100 + i), "USER_TABLE", "2026-10-28"]);
    case "columns":
      return table(
        ["column_id", "name", "type", "max_length", "precision", "scale", "is_nullable", "is_identity", "is_computed", "default_name", "default_expression", "computed_expression", "identity_seed", "identity_increment"],
        sized(mode, [["1", sysname("CodiceIdentificativoPrestazioneRegionale"), "dbo.udt_CodiceFiscaleNormalizzato", "-1", "0", "0", "0", "1", "1", `DF_${sysname("Default")}`, "(newsequentialid())", SQL_TEXT.slice(0, 600), "9223372036854775807", "1"]], (i) => [String(i + 2), `Colonna_${i + 2}`, "nvarchar", "100", "0", "0", "1", "0", "0", null, null, null, null, null], 1024, 1024),
      );
    case "relations":
      return pick(["name", "parent_schema", "parent_table", "parent_column", "referenced_schema", "referenced_table", "referenced_column", "constraint_column_id", "delete_referential_action_desc", "update_referential_action_desc"], [[`FK_${sysname("Customer_Order_Line_Item").slice(0, 125)}`, "dbo", sysname("ProcessoClinicoRicoveroAmbulatoriale"), "Id", "dbo", "客户订单", "Id", "1", "CASCADE", "SET_DEFAULT"]], (i) => [`FK_${i}`, "dbo", `Tabella_${String(i).padStart(5, "0")}`, "Id", "dbo", `Tabella_${String(i + 1).padStart(5, "0")}`, "Id", "1", "NO_ACTION", "NO_ACTION"]);
    case "principals":
      return pick(["principal_id", "name", "type_desc"], [["1", LOGIN, "WINDOWS_GROUP"], ["2", "王秀英", "SQL_USER"], ["3", "", "EXTERNAL_GROUP"]], (i) => [String(i + 4), `CORP\\user.${i}`, "WINDOWS_LOGIN"]);
    case "roles":
      return pick(["role_name", "member_name"], [["db_datareader", null], [sysname("ruolo_lettura_reportistica_regionale"), LOGIN]], (i) => ["db_datareader", `CORP\\user.${i}`]);
    case "backupFiles":
      return pick(["LogicalName", "PhysicalName", "Type", "FileGroupName", "Size", "MaxSize"], [[sysname("H2O_BASE_Data"), BACKUP_PATH, "D", "PRIMARY", "17592186044416", "35184372080640"]], (i) => [`File_${i}`, `D:\\Data\\File_${i}.ndf`, "D", "PRIMARY", "1048576", "-1"]);
    default:
      return mode === "empty" ? table(["name"], []) : UNHANDLED;
  }
}

const WORST_CAPABILITIES = (database: string | null) => ({
  version: "16.0.4305.5",
  majorVersion: 16,
  edition: "Enterprise Edition: Core-based Licensing (64-bit) on Windows Server 2022 Datacenter 10.0 <X64> (Build 20348: ) (Hypervisor) · " + "Azure Arc-enabled ".repeat(8),
  engineEdition: 3,
  database: database ?? LONG_DATABASE,
  features: {
    plans: { state: "available", reason: "" },
    monitor: { state: "available", reason: "" },
    live: { state: "available", reason: "" },
    queryStore: { state: "disabled", reason: `Query Store is OFF for ${LONG_DATABASE}.` },
    agent: { state: "unsupported", reason: "SQL Server Agent is not available on Azure SQL Database." },
    backup: { state: "available", reason: "" },
    events: { state: "denied", reason: `The current login does not have the required permission. ALTER ANY EVENT SESSION was denied on object 'server', database 'master'. Ask a sysadmin to GRANT ALTER ANY EVENT SESSION TO [${LOGIN}].` },
    audit: { state: "available", reason: "" },
    tde: { state: "available", reason: "" },
    alwaysEncrypted: { state: "available", reason: "" },
  },
});

// ---- Results ------------------------------------------------------------

type Column = { name: string; kind: "number" | "date" | "binary" | "text" };

/** Set 0 is 500 columns wide; set 1 has no rows, set 2 one, then 57 small sets. */
const WIDE: Column[] = [
  { name: "Id", kind: "number" },
  { name: sysname("Customer_Order_Line_Item_Shipping_Address_Verification_Status_Last_Updated_By"), kind: "text" },
  { name: "", kind: "text" },
  { name: "Amount", kind: "number" },
  { name: "نام_مشتری", kind: "text" },
  { name: "Notes", kind: "text" },
  { name: "CreatedAt", kind: "date" },
  { name: "Thumbprint", kind: "binary" },
  ...Array.from({ length: 492 }, (_, i): Column => ({ name: `c${i + 9}`, kind: i % 3 ? "text" : "number" })),
];
const setColumns = (set: number): Column[] => (set === 0 ? WIDE : [{ name: "Id", kind: "number" }]);
const setRows = (set: number) => (set === 0 ? 1_000_000 : set === 1 ? 0 : set === 2 ? 1 : 3);

const UNBROKEN = "0x" + "9F8E7D6C5B4A39281706F5E4D3C2B1A0".repeat(63);

function worstCell(set: number, row: number, column: number): string | null {
  if (set !== 0) return String(row + 1);
  if (column === 0) return String(row + 1);
  const kind = WIDE[column].kind;
  if (kind === "number") return ["-12345678901234567890123456.1234567890", "0.30000000000000004", null, "0", "1"][row % 5];
  if (kind === "date") return [null, "1900-01-01 00:00:00.000", "9999-12-31 23:59:59.9999999 +14:00"][row % 3];
  if (kind === "binary") return row % 4 ? UNBROKEN.slice(0, 66) : UNBROKEN;
  return [null, "", "   ", "NULL", "line one\r\nline two\n\tline three", "👩🏽‍💻 Priya 王秀英 Đặng Thị Ngọc Hân", UNBROKEN, "<b>bold</b> &amp;"][(row + column) % 8];
}

/** The window as Rust encodes it; previews are cut by character, as Rust does. */
function encodeWorst(set: number, start: number, count: number): ArrayBuffer {
  const encoder = new TextEncoder();
  const columns = setColumns(set).length;
  const rows = Math.max(0, Math.min(count, setRows(set) - start));
  const parts: number[] = [];
  const u32 = (n: number) => parts.push(n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255);
  u32(rows);
  u32(columns);
  for (let r = start; r < start + rows; r++) {
    for (let c = 0; c < columns; c++) {
      const text = worstCell(set, r, c);
      if (text === null) {
        parts.push(1);
        u32(0);
        continue;
      }
      const chars = [...text];
      const bytes = encoder.encode(chars.length > 500 ? chars.slice(0, 500).join("") : text);
      parts.push(chars.length > 500 ? 2 : 0);
      u32(bytes.length);
      for (const b of bytes) parts.push(b);
    }
  }
  return new Uint8Array(parts).buffer;
}

/** Three statements, each a 30-deep join tree, with names at sysname length. */
function worstPlan() {
  const object = `<Object Database="[${sysname("Sales_Archive_2019_Q4")}]" Schema="[dbo]" Table="[${sysname("Customer_Order_Line_Item")}]" Index="[${sysname("IX_Customer_Order_Line_Item")}]" />`;
  let id = 0;
  const node = (depth: number): string => {
    const n = id++;
    const leaf = depth >= 30;
    const op = leaf ? (n % 2 ? "Clustered Index Scan" : "Index Seek") : n % 3 ? "Nested Loops" : "Adaptive Join";
    const cost = n === 7 ? "abc" : "123456.789";
    const children = leaf ? "" : `<NestedLoops>${node(depth + 1)}${depth % 6 === 0 ? node(30) : ""}</NestedLoops>`;
    return `<RelOp NodeId="${n}" PhysicalOp="${op}" LogicalOp="${op}" EstimateRows="1.23457e+006" EstimatedTotalSubtreeCost="${cost}"><Warnings NoJoinPredicate="true"><SpillToTempDb SpillLevel="8" /></Warnings><RunTimeInformation>${Array.from({ length: 8 }, (_, t) => `<RunTimeCountersPerThread Thread="${t}" ActualRows="1000000000" />`).join("")}</RunTimeInformation>${leaf ? `<IndexScan>${object}</IndexScan>` : children}</RelOp>`;
  };
  const statement = () =>
    `<StmtSimple StatementText="${("SELECT o.Id, o.Customer_Order_Line_Item_Shipping_Address_Verification_Status FROM dbo.Orders o JOIN dbo.Lines l ON l.OrderId = o.Id WHERE ").padEnd(4000, "o.Id = 0 AND ")}" StatementSubTreeCost="123456.789"><QueryPlan>${node(0)}</QueryPlan></StmtSimple>`;
  return `<ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan" Version="1.6" Build="16.0.4305.5"><BatchSequence><Batch><Statements>${statement()}${statement()}${statement()}</Statements></Batch></BatchSequence></ShowPlanXML>`;
}

type Send = (event: unknown) => void;

function executeWorst(mode: Mode, send: Send, planMode: string | undefined) {
  send({ type: "batchStarted", batch: 0, firstLine: 0 });
  if (planMode && planMode !== "none") send({ type: "plan", xml: worstPlan() });
  const sets = mode === "empty" ? 0 : mode === "one" ? 1 : 60;
  for (let set = 0; set < sets; set++) {
    send({ type: "resultSetStarted", index: set, columns: setColumns(set) });
    send({ type: "resultSetFinished", index: set, rows: mode === "one" ? 1 : setRows(set) });
  }
  if (mode !== "empty") {
    const affected = mode === "one" ? 1 : 2000;
    for (let i = 0; i < affected; i++) send({ type: "rowsAffected", count: 1 });
    send({ type: "rowsAffected", count: 1_000_000 });
    send({ type: "message", text: `Changed database context to '${LONG_DATABASE}'.`, isError: false, header: null, line: null });
    send({ type: "message", text: "تم تغيير سياق قاعدة البيانات إلى 'المبيعات'.", isError: false, header: null, line: null });
    send({
      type: "message",
      isError: true,
      header: "Msg 3201, Level 16, State 2, Line 3",
      line: 3,
      text: String.raw`Cannot open backup device '\\fileserver-prod-01.corp.northwind-industries-holdings.example.com\SQLBackups\Sales_Archive_2019_Q4\FULL\Sales_Archive_2019_Q4_FULL_20261103_235959_copy_only_compressed_encrypted.bak'. Operating system error 3(The system cannot find the path specified.).` +
        "\r\nMsg 3013, Level 16, State 1\r\nBACKUP DATABASE is terminating abnormally.",
    });
    send({ type: "message", text: UNBROKEN, isError: false, header: null, line: null });
    send({ type: "message", text: "Stopped at the limit of 1000000 rows per result set; the rest of the query was cancelled.", isError: true, header: null, line: null });
  }
  send({ type: "finished", outcome: mode === "empty" ? "succeeded" : "failed", elapsedMs: 86_399_999, database: LONG_DATABASE, openTransactions: mode === "empty" ? 0 : 3 });
  return mode === "empty" ? "succeeded" : "failed";
}

// ---- Dialogs ------------------------------------------------------------

/** 300 SSMS entries: nested and colliding group names, history without versions. */
export function ssmsList(mode: Mode) {
  const groups = [["Aurelia", "Ambulatorio-Ricoveri-Diagnostica-per-Immagini-Sede-Centrale"], ["Camilliani"], ["Recent connections"], ["A / B"], ["A", "B"], ["Ospedale Đặng Thị Ngọc Hân 🏥"]];
  return sized(
    mode,
    [],
    (i) => ({
      id: `registered:${i}`,
      name: i % 7 ? `Aurelia [Ambulatorio] Benachrichtigungseinstellungen ${i}` : "",
      groups: i % 10 ? groups[i % 6] : [],
      server: i % 5 ? `sql-prod-${i}.northwind-industries-holdings.database.windows.net,1433` : String.raw`10.0.1.${i % 255}\SQLEXPRESS2022`,
      authentication: i % 3 ? { kind: "sql", userName: "svc_quervio_readonly_reporting_account" } : { kind: "windows" },
      defaultDatabase: i % 4 ? "H2O_BASE_ARCHIVIO_STORICO_2019_2024" : null,
      encrypt: "optional",
      trustServerCertificate: true,
      lastUsed: i % 10 ? null : i % 20 ? Date.now() - i * 86_400_000 : 0,
      source: i % 10 ? "registered" : "history",
      ssmsVersion: i % 10 ? null : i % 20 ? "21.0" : null,
      hasPassword: i % 2 === 0,
    }),
    300,
    2000,
  );
}

/** What the app itself can save at its limits. */
const WORST_SETTINGS = JSON.stringify({
  editor: { fontSize: 32, tabSize: 8 },
  query: { maxRows: 10_000_000, timeoutSeconds: 86_400, maxCellMB: 64 },
  appearance: { theme: "dark" },
  shortcuts: { execute: ["F5", "Ctrl+Shift+Alt+Enter", "Ctrl+E"], format: [], newQuery: ["Ctrl+Shift+Alt+N"] },
});

export function override(mode: Mode, cmd: string, a: Args): unknown {
  switch (cmd) {
    case "management_read":
      return managementRead(mode, a);
    case "management_capabilities":
      return mode === "worst" ? WORST_CAPABILITIES(a.database as string | null) : UNHANDLED;
    case "management_dependencies":
      return mode === "worst"
        ? [{ name: "SQL Tools Service", path: String.raw`C:\Users\Aleksandra.Wiśniewska-Kowalczyk\AppData\Local\Quervio\components\Microsoft.SqlTools.ServiceLayer\6.0.20261023.1\MicrosoftSqlToolsServiceLayer.exe`, available: true, help: "" }, { name: "Microsoft bridge (.NET 10, SMO, DacFx, SqlClient)", path: null, available: false, help: "Configure components in the desktop app." }]
        : UNHANDLED;
    case "explorer_connect":
      // One server fails, as a misregistered SPN does.
      if (mode === "worst" && a.id === "w-entra") throw LONG_ERROR;
      return { serverName: SERVER, version: "16.0.4305.5", database: "master" };
    case "explorer_databases":
    case "connection_databases":
      return databases(mode);
    case "explorer_objects":
      if (mode === "worst" && a.folder === "databaseTriggers") throw LONG_ERROR;
      return objects(mode, String(a.folder));
    case "explorer_table_children":
      return tableChildren(mode);
    case "test_connection":
      if (mode === "worst") throw LONG_ERROR;
      return { serverName: SERVER, version: "16.0.4305.5", database: "master" };
    case "query_open":
      return { serverName: SERVER, version: "16.0.4305.5", database: (a.database as string | null) ?? LONG_DATABASE };
    // The worst tabs live in memory, so the demo's saved tabs survive.
    case "tabs_load":
      return mode === "worst" ? (worstTabs ?? tabsSnapshot()) : null;
    case "tabs_save":
      worstTabs = a.snapshot as string;
      return null;
    case "query_execute": {
      const channel = a.onEvent as { onmessage: Send };
      return executeWorst(mode, (event) => channel.onmessage(event), (a.options as { planMode?: string } | undefined)?.planMode);
    }
    case "result_rows":
      return encodeWorst(a.set as number, a.start as number, a.count as number);
    case "result_cell": {
      const text = worstCell(a.set as number, a.row as number, a.column as number);
      // A clipped JSON value with a bigint and a trailing zero, as nvarchar(max) holds.
      return text === UNBROKEN ? { text: `{"id":12345678901234567890,"price":1.10,"text":"${UNBROKEN}"}`, clipped: true } : { text, clipped: false };
    }
    case "result_sort":
      return null;
    case "query_check":
      return mode === "empty"
        ? { findings: [], uncertain: true }
        : {
            findings: sized(
              mode,
              [],
              (i) => ({ kind: ["updateWithoutWhere", "deleteWithoutWhere", "truncate", "drop", "alterTable"][i % 5], target: `[sales].[${sysname("CustomerOrderLineItemHistoryArchive_2019_2024")}]`, line: i * 31 + 1 }),
              400,
              400,
            ),
            uncertain: true,
          };
    case "query_sqlcmd_prepare":
      if (/:r\b/i.test(String(a.script)) && a.allowFileReads !== true) return { kind: "fileAccessRequired" };
      return {
        kind: "ready",
        token: "mock-sqlcmd",
        hasLocalCommands: true,
        script:
          String.raw`:out \\fileserver.northwind-industries-holdings.example.com\exports\2026\Q4\estrazione_prestazioni_ambulatoriali_regione_lombardia_flusso_c.csv` +
          "\n" +
          Array.from({ length: 5000 }, (_, i) => `INSERT dbo.T VALUES (${i}, N'${"Đặng Thị Ngọc Hân ".repeat(10)}');`).join("\n"),
      };
    case "ssms_connections":
      if (mode === "worst" && a.file) throw String.raw`Cannot read C:\Users\Aleksandra.Wiśniewska-Kowalczyk\AppData\Roaming\Microsoft\SQL Server Management Studio\21.0\RegSrvr.xml: XML parse error at line 1284, column 77: unexpected end of element </ServerGroup>`;
      return ssmsList(mode);
    case "update_check":
      if (mode === "worst")
        throw "error sending request for url (https://api.github.com/repos/devchristian1337/quervio/releases/latest?per_page=1&include_prereleases=true): client error (Connect): tcp connect error: A connection attempt failed because the connected party did not properly respond after a period of time (os error 10060)";
      return { installed: true, current: "0.1.23", available: "0.2.0-beta.12+build.20261103.abcdef0123", ready: false, empty: false };
    case "settings_data_dir":
      return String.raw`C:\Users\Aleksandra.Wiśniewska-Kowalczyk\AppData\Roaming\com.quervio.app`;
    // The worst settings live in memory, so the demo's saved settings survive.
    case "settings_load":
      return mode === "worst" ? (worstSettings ?? WORST_SETTINGS) : UNHANDLED;
    case "settings_save":
      if (mode !== "worst") return UNHANDLED;
      worstSettings = a.settings as string;
      return null;
    default:
      return UNHANDLED;
  }
}
