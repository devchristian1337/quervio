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
  environment: "production",
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

const MOCK_ROWS = 1_000_000;
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
