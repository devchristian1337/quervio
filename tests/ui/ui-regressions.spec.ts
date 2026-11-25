import { test, expect, type Page } from "@playwright/test";

type IpcWindow = Window & {
  __TAURI_INTERNALS__: {
    invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>;
  };
  [key: string]: unknown;
};

async function gotoMock(page: Page) {
  await page.goto("/?mock", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "Tools", exact: true })).toBeVisible({ timeout: 30000 });
}

async function openTool(page: Page, name: string) {
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}

test("ValueViewer keeps Ctrl+C and Escape isolated from ResultGrid", async ({ page }) => {
  await gotoMock(page);
  await page.getByRole("button", { name: "New query on Mock server", exact: true }).click();
  await page.locator(".monaco-editor").click({ position: { x: 80, y: 12 } });
  await page.keyboard.insertText("SELECT 1;");
  await page.getByRole("button", { name: "Execute", exact: true }).click();
  const grid = page.getByTestId("data-grid-canvas");
  await expect(grid).toBeVisible();

  await page.evaluate(() => {
    const w = window as unknown as IpcWindow;
    const orig = w.__TAURI_INTERNALS__.invoke;
    w.resultCopyCalls = 0;
    w.copiedRange = null;
    w.__TAURI_INTERNALS__.invoke = (cmd, args) => {
      if (cmd === "result_copy") {
        w.resultCopyCalls = (w.resultCopyCalls as number) + 1;
        w.copiedRange = { rows: args.rows, columns: args.columns };
      }
      return orig(cmd, args);
    };
  });

  await grid.dblclick({ position: { x: 160, y: 50 }, force: true });

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const pre = dialog.locator("pre");
  await expect(pre).toBeVisible();

  await pre.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  });
  await page.keyboard.press("Control+c");
  await page.waitForTimeout(150);

  expect(await page.evaluate(() => (window as unknown as IpcWindow).resultCopyCalls)).toBe(0);
  await expect(page.getByText(/Copied 1 row × 1 column/)).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // Grid cell selection (column 1, row 0) must still be intact after Escape closed ValueViewer.
  await grid.click({ position: { x: 160, y: 50 }, button: "right", force: true });
  await page.getByRole("menuitem", { name: /^Copy\b/ }).first().click();
  await expect.poll(() => page.evaluate(() => (window as unknown as IpcWindow).copiedRange)).toEqual({
    rows: [[0, 1]],
    columns: [[1, 2]],
  });
});

test("ResultGrid ignores stale result_sort from a previous run and handles Clear sort errors", async ({ page }) => {
  await gotoMock(page);
  await page.getByRole("button", { name: "New query on Mock server", exact: true }).click();
  await page.locator(".monaco-editor").click({ position: { x: 80, y: 12 } });
  await page.keyboard.insertText("SELECT 1;");
  await page.getByRole("button", { name: "Execute", exact: true }).click();
  const grid = page.getByTestId("data-grid-canvas");
  await expect(grid).toBeVisible();

  // Part A: stale sort from run 1 resolving after run 2 does not mark run 2 sorted.
  await page.evaluate(() => {
    const w = window as unknown as IpcWindow;
    const orig = w.__TAURI_INTERNALS__.invoke;
    w.resolveStaleSort = null;
    w.sortMode = "hold";
    w.__TAURI_INTERNALS__.invoke = (cmd, args) => {
      if (cmd === "result_sort" && w.sortMode === "hold") {
        return new Promise((resolve) => {
          w.resolveStaleSort = () => resolve(null);
        });
      }
      if (cmd === "result_sort" && w.sortMode === "fail") {
        return Promise.reject("Result set expired");
      }
      return orig(cmd, args);
    };
  });

  await grid.click({ position: { x: 62, y: 18 }, force: true });
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as IpcWindow).resolveStaleSort)).toBe("function");

  await page.getByRole("button", { name: "Execute", exact: true }).click();
  await expect(grid).toBeVisible();
  await page.evaluate(() => ((window as unknown as IpcWindow).resolveStaleSort as () => void)());
  await page.waitForTimeout(150);
  await expect(page.getByText("Sorted by", { exact: false })).toHaveCount(0);

  // Part B: footer Clear sort catches IPC errors with a toast instead of an unhandled rejection.
  await page.evaluate(() => {
    const w = window as unknown as IpcWindow;
    w.sortMode = "pass";
    w.unhandled = [];
    window.addEventListener("unhandledrejection", (e) => {
      (w.unhandled as string[]).push(String(e.reason));
    });
  });

  await grid.click({ position: { x: 62, y: 18 }, force: true });
  await expect(page.getByText("Sorted by", { exact: false })).toContainText("Id↑");

  await page.evaluate(() => {
    (window as unknown as IpcWindow).sortMode = "fail";
  });
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page.getByText("Sort failed", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as IpcWindow).unhandled)).toEqual([]);
});

test("SettingsDialog rejects decimal floats on integer query limits and records one shortcut at a time", async ({ page }) => {
  await gotoMock(page);
  await page.getByRole("button", { name: "New query on Mock server", exact: true }).click();
  await page.locator(".monaco-editor").click({ position: { x: 80, y: 12 } });
  await page.keyboard.insertText("SELECT 1;");

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("button", { name: "Query", exact: true }).click();

  const timeoutInput = settings.getByRole("textbox", { name: "Execution timeout", exact: true });
  await timeoutInput.fill("1.5");
  await timeoutInput.blur();
  await expect(timeoutInput).toHaveValue("0");

  const maxRowsInput = settings.getByRole("textbox", { name: "Rows per result set", exact: true });
  await maxRowsInput.fill("100.5");
  await maxRowsInput.blur();
  await expect(maxRowsInput).toHaveValue("1000000");

  // Shortcuts: only one row records at a time.
  await settings.getByRole("button", { name: "Shortcuts", exact: true }).click();
  await settings.getByRole("button", { name: "Add keys for Execute", exact: true }).click();
  await settings.getByRole("button", { name: "Add keys for Cancel executing query", exact: true }).click();
  await expect(settings.getByRole("button", { name: "Press keys…", exact: true })).toHaveCount(1);

  await page.keyboard.press("Control+Alt+K");
  await expect(page.getByText(/Ctrl\+Alt\+K moved from “Execute”/)).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();

  await page.evaluate(() => {
    const w = window as unknown as IpcWindow;
    const orig = w.__TAURI_INTERNALS__.invoke;
    w.capturedOptions = null;
    w.__TAURI_INTERNALS__.invoke = (cmd, args) => {
      if (cmd === "query_execute") w.capturedOptions = args.options;
      return orig(cmd, args);
    };
  });
  await page.getByRole("button", { name: "Execute", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as IpcWindow).capturedOptions)).toMatchObject({
    timeoutSeconds: 0,
    maxRows: 1000000,
  });
});

test("BridgeOperation write modal exposes Cancel operation and live progress inside dialog", async ({ page }) => {
  await gotoMock(page);
  await openTool(page, "Import / Export / Scripts");
  await page.getByRole("textbox", { name: "Local file path", exact: true }).fill("C:\\test\\customers.csv");
  await page.getByRole("textbox", { name: "SQL Server table", exact: true }).fill("Customer");

  await page.evaluate(() => {
    const w = window as unknown as IpcWindow;
    const orig = w.__TAURI_INTERNALS__.invoke;
    w.cancelledToken = null;
    w.finishBridge = null;
    w.__TAURI_INTERNALS__.invoke = (cmd, args) => {
      if (cmd === "management_cancel") {
        w.cancelledToken = args.token;
        return Promise.resolve(null);
      }
      if (cmd === "management_bridge") {
        const ch = args.onEvent as { onmessage?: (e: unknown) => void } | undefined;
        ch?.onmessage?.({ phase: "import", message: "Importing batch 1", completed: 500 });
        return new Promise((resolve) => {
          w.finishBridge = () => resolve({ rows: 500 });
        });
      }
      return orig(cmd, args);
    };
  });

  await page.getByRole("button", { name: "Import data", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Confirm and execute", exact: true }).click();

  await expect(dialog.getByText(/Importing batch 1/)).toBeVisible();
  const cancelOp = dialog.getByRole("button", { name: "Cancel operation", exact: true });
  await expect(cancelOp).toBeVisible();
  await cancelOp.click();
  await expect.poll(() => page.evaluate(() => (window as unknown as IpcWindow).cancelledToken)).toBeTruthy();

  await page.evaluate(() => ((window as unknown as IpcWindow).finishBridge as () => void)());
  await expect(dialog).toBeHidden();
});

test("Operation dialog clears previous progress before confirming the next operation", async ({ page }) => {
  await gotoMock(page);
  await openTool(page, "Table Designer");
  await page.getByLabel("Table", { exact: true }).fill("FirstTable");
  await page.getByLabel("Column 1 name", { exact: true }).fill("Id");
  await page.getByLabel("Column 1 type", { exact: true }).fill("int");

  await page.getByRole("button", { name: "Preview CREATE TABLE", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Confirm and execute", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Operation completed", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
  await expect(dialog).toBeHidden();

  await page.getByLabel("Table", { exact: true }).fill("SecondTable");
  await page.getByRole("button", { name: "Preview CREATE TABLE", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Confirm server operation", exact: true })).toBeVisible();
  await expect(dialog).not.toContainText("no SQL was submitted");
});

test("TableDesigner keeps primaryKey in sync on rename/remove and enables DROP without columns", async ({ page }) => {
  await gotoMock(page);
  await openTool(page, "Table Designer");
  await page.getByLabel("Table", { exact: true }).fill("Orders");
  await page.getByLabel("Column 1 name", { exact: true }).fill("Id");
  await page.getByRole("checkbox", { name: "Column 1 primary key", exact: true }).check();

  // Rename PK column: stays checked and valid with no orphaned column error.
  await page.getByLabel("Column 1 name", { exact: true }).fill("OrderId");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "Column 1 primary key", exact: true })).toBeChecked();
  await expect(page.getByRole("button", { name: "Preview CREATE TABLE", exact: true })).toBeEnabled();

  // Add second column, then remove the PK column: no orphaned primaryKey error.
  await page.getByRole("button", { name: "Add column", exact: true }).click();
  await page.getByLabel("Column 2 name", { exact: true }).fill("Total");
  await page.getByRole("button", { name: "Remove", exact: true }).first().click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Preview CREATE TABLE", exact: true })).toBeEnabled();

  // DROP constraint/index works without entering columns, and trailing comma is ignored for INDEX.
  await page.getByRole("combobox", { name: "Operation", exact: true }).click();
  await page.getByRole("option", { name: "DROP", exact: true }).click();
  await expect(page.getByLabel("Columns in key order, comma separated", { exact: true })).toHaveCount(0);
  await page.getByLabel("Constraint / index name", { exact: true }).fill("IX_Orders_Total");
  await expect(page.getByRole("button", { name: "Preview constraint", exact: true })).toBeEnabled();

  await page.getByRole("combobox", { name: "Operation", exact: true }).click();
  await page.getByRole("option", { name: "INDEX", exact: true }).click();
  await page.getByLabel("Columns in key order, comma separated", { exact: true }).fill("Total, ");
  await page.getByRole("button", { name: "Preview constraint", exact: true }).click();
  const pre = page.getByRole("dialog").locator("pre");
  await expect(pre).toContainText("([Total])");
  await expect(pre).not.toContainText("[]");
});

test("SQL Server Agent never falls back to sp_add on delete/update or section switch", async ({ page }) => {
  await gotoMock(page);
  await page.evaluate(() => {
    const w = window as unknown as IpcWindow;
    const orig = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = (cmd, args) => {
      if (cmd === "management_read" && (args.resource as { kind?: string })?.kind === "jobs") {
        return Promise.resolve({
          columns: ["job_id", "name", "enabled"],
          rows: [["11111111-1111-1111-1111-111111111111", "NightlyBackup", "1"]],
          truncated: false,
        });
      }
      return orig(cmd, args);
    };
  });

  await openTool(page, "SQL Server Agent");
  await page.getByRole("cell", { name: "NightlyBackup", exact: true }).click();

  await page.getByRole("combobox", { name: "Operation", exact: true }).click();
  await page.getByRole("option", { name: "delete", exact: true }).click();
  await page.getByLabel("Schedule name", { exact: true }).fill("Nightly");
  // Without Schedule ID, delete schedule must stay disabled (never generate sp_add_jobschedule).
  await expect(page.getByRole("button", { name: "Preview schedule", exact: true })).toBeDisabled();
  // With Schedule ID (even without schedule name), delete schedule generates sp_detach_schedule.
  await page.getByLabel("Schedule name", { exact: true }).fill("");
  await page.getByLabel("Schedule ID (update/detach)", { exact: true }).fill("7");
  await page.getByRole("button", { name: "Preview schedule", exact: true }).click();
  await expect(page.getByRole("dialog").locator("pre")).toContainText("EXEC msdb.dbo.sp_detach_schedule");
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).first().click();

  // Switching section from Jobs (mode=start) to Operators resets Operation to "create".
  await page.getByRole("combobox", { name: "Operation", exact: true }).click();
  await page.getByRole("option", { name: "start", exact: true }).click();
  await page.getByRole("tab", { name: "Operators", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Operation", exact: true })).toHaveText("create");
});

test("Transfer column mapping allows clearing and retyping destination column without checking Ignore", async ({ page }) => {
  await gotoMock(page);
  await openTool(page, "Import / Export / Scripts");
  await page.getByRole("textbox", { name: "Local file path", exact: true }).fill("C:\\test\\customers.csv");
  await page.getByRole("textbox", { name: "SQL Server table", exact: true }).fill("Customer");
  await page.getByRole("button", { name: "Preview source rows", exact: true }).click();

  const dest = page.getByRole("textbox", { name: "Destination column for Name", exact: true });
  await expect(dest).toHaveValue("Name");
  await dest.click();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Backspace");

  await expect(dest).toBeEnabled();
  await expect(dest).toHaveValue("");
  await expect(page.getByRole("checkbox", { name: "Ignore source column Name", exact: true })).not.toBeChecked();

  await page.keyboard.type("DisplayName");
  await expect(dest).toHaveValue("DisplayName");
});

test("ViewDesigner clears filter and join key columns when switching source or join object", async ({ page }) => {
  await gotoMock(page);
  await page.evaluate(() => {
    const w = window as unknown as IpcWindow;
    const orig = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = (cmd, args) => {
      if (cmd === "management_read") {
        const res = args.resource as { kind: string; objectId?: number };
        if (res.kind === "objects") {
          return Promise.resolve({
            columns: ["object_id", "schema", "name", "type_desc"],
            rows: [
              ["1", "dbo", "Customer", "USER_TABLE"],
              ["2", "dbo", "Invoice", "USER_TABLE"],
            ],
            truncated: false,
          });
        }
        if (res.kind === "columns" && res.objectId === 2) {
          return Promise.resolve({
            columns: ["name", "type", "max_length", "precision", "scale", "is_nullable", "is_identity"],
            rows: [["InvoiceNo", "int", "4", "10", "0", "0", "0"]],
            truncated: false,
          });
        }
      }
      return orig(cmd, args);
    };
  });

  await openTool(page, "View Designer");
  await page.getByLabel("View name", { exact: true }).fill("V_Test");
  await page.getByRole("combobox", { name: "Source object", exact: true }).click();
  await page.getByRole("option", { name: "dbo.Customer", exact: true }).click();
  await page.getByRole("checkbox", { name: "Name", exact: true }).check();
  await page.getByRole("combobox", { name: "Filter column", exact: true }).click();
  await page.getByRole("option", { name: "Name", exact: true }).click();
  await page.getByLabel("Filter value (literal)", { exact: true }).fill("Acme");

  await page.getByRole("combobox", { name: "Source object", exact: true }).click();
  await page.getByRole("option", { name: "dbo.Invoice", exact: true }).click();
  await page.getByRole("checkbox", { name: "InvoiceNo", exact: true }).check();

  await expect(page.getByRole("combobox", { name: "Filter column", exact: true })).toHaveText("No filter");
  await expect(page.locator("pre")).not.toContainText("WHERE s.[Name]");
});

test("CommandPalette retains open tab's session connectionName after Saved Connection is renamed", async ({ page }) => {
  await gotoMock(page);
  await page.getByRole("button", { name: "New query on Mock server", exact: true }).click();
  await expect(page.getByRole("tab", { name: /^Query 1 /, selected: true })).toContainText("Mock server");

  await page.evaluate(async () => {
    const path = "/src/stores/connections.ts";
    const { useConnections } = await import(/* @vite-ignore */ path);
    useConnections.setState((state: { connections: Array<Record<string, unknown>> }) => ({
      connections: state.connections.map((c) => (c.id === "mock" ? { ...c, name: "Changed target" } : c)),
    }));
  });

  await page.keyboard.press("Control+Shift+P");
  const dialog = page.getByRole("dialog", { name: "Search commands", exact: true });
  await dialog.getByRole("combobox").fill("Query 1");
  const option = dialog.getByRole("option", { name: /Query 1/ });
  await expect(option).toContainText("Mock server");
  await expect(option).not.toContainText("Changed target");
});

test("useRead clears loading when resource becomes null and ToolFrame clears databases on server switch", async ({ page }) => {
  await gotoMock(page);
  await page.evaluate(async () => {
    const path = "/src/stores/connections.ts";
    const { useConnections } = await import(/* @vite-ignore */ path);
    const first = useConnections.getState().connections[0];
    useConnections.setState({
      connections: [
        first,
        { ...first, id: "second", name: "Second server", server: "second.local" },
      ],
    });
    const w = window as unknown as IpcWindow;
    const orig = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = (cmd, args) => {
      if (cmd === "management_read" && (args.resource as { kind?: string })?.kind === "activity") {
        return new Promise(() => {});
      }
      if (cmd === "explorer_databases" && args.id === "second") {
        return Promise.reject("Permission denied");
      }
      return orig(cmd, args);
    };
  });

  await openTool(page, "Activity Monitor");
  await expect(page.getByRole("button", { name: "Loading…", exact: true })).toBeDisabled();
  await page.getByRole("tab", { name: "Live query", exact: true }).click();
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();

  // Switch Server to Second server (whose database listing fails): old server's Sales must not remain.
  await page.getByRole("combobox", { name: "Database", exact: true }).click();
  await expect(page.getByRole("option", { name: "Sales", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("combobox", { name: "Server", exact: true }).click();
  await page.getByRole("option", { name: "Second server", exact: true }).click();
  await page.waitForTimeout(200);
  await page.getByRole("combobox", { name: "Database", exact: true }).click();
  await expect(page.getByRole("option", { name: "Sales", exact: true })).toHaveCount(0);
});

test("Maintenance rejects imported flow missing time without corrupting form state", async ({ page }) => {
  await gotoMock(page);
  await page.evaluate(() => {
    const w = window as unknown as IpcWindow;
    const orig = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = (cmd, args) => {
      if (cmd === "plugin:dialog|open") return Promise.resolve("C:/flows/broken.json");
      if (cmd === "file_read") {
        return Promise.resolve(
          JSON.stringify({
            version: 1,
            name: "Nightly",
            tasks: [{ id: "t1", kind: "sql", schema: "dbo", table: "", path: "", sql: "SELECT 1", days: 30 }],
          }),
        );
      }
      return orig(cmd, args);
    };
  });

  await openTool(page, "Maintenance");
  await page.getByRole("button", { name: "Open flow", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Unsupported maintenance flow format.");
  await expect(page.getByRole("alert")).not.toContainText("split");
  await expect(page.getByLabel("Agent job name", { exact: true })).toHaveValue("");
});

test("ExtendedEvents disables actions on empty session name and reads .xel only on Read file click", async ({ page }) => {
  await gotoMock(page);
  await openTool(page, "Extended Events / Profiler");

  await page.getByLabel("Session name", { exact: true }).fill("");
  await expect(page.getByRole("button", { name: "Create profiler session", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Start", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Delete session", exact: true })).toBeDisabled();

  await page.evaluate(() => {
    const w = window as unknown as IpcWindow;
    const orig = w.__TAURI_INTERNALS__.invoke;
    w.xelPaths = [];
    w.__TAURI_INTERNALS__.invoke = (cmd, args) => {
      if (cmd === "management_read" && (args.resource as { kind?: string })?.kind === "xel") {
        (w.xelPaths as string[]).push((args.resource as { path: string }).path);
      }
      return orig(cmd, args);
    };
  });

  await page.getByRole("combobox", { name: "Events source", exact: true }).click();
  await page.getByRole("option", { name: "Server-side .xel file", exact: true }).click();
  const pathInput = page.getByLabel("Path accessible to SQL Server (.xel or Azure URL)", { exact: true });
  await pathInput.click();
  await page.keyboard.type("C:\\a.xel");
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => (window as unknown as IpcWindow).xelPaths)).toEqual([]);

  await page.getByRole("button", { name: "Read file", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as IpcWindow).xelPaths)).toEqual(["C:\\a.xel"]);
});

test("QueryStore clears self-comparison and ActivityMonitor live PlanViewer updates after Open .sqlplan", async ({ page }) => {
  await gotoMock(page);
  const FILE_PLAN = `<ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan" Version="1.6" Build="16.0.0.0"><BatchSequence><Batch><Statements><StmtSimple StatementText="SELECT 1"><QueryPlan><RelOp NodeId="0" PhysicalOp="Table Scan" LogicalOp="Table Scan" EstimateRows="5" EstimatedTotalSubtreeCost="0.001"><TableScan /></RelOp></QueryPlan></StmtSimple></Statements></Batch></BatchSequence></ShowPlanXML>`;
  const LIVE_PLAN_1 = `<ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan" Version="1.6" Build="16.0.0.0"><BatchSequence><Batch><Statements><StmtSimple StatementText="SELECT 1"><QueryPlan><RelOp NodeId="0" PhysicalOp="Index Seek" LogicalOp="Index Seek" EstimateRows="10" EstimatedTotalSubtreeCost="0.002"><IndexScan /></RelOp></QueryPlan></StmtSimple></Statements></Batch></BatchSequence></ShowPlanXML>`;
  const LIVE_PLAN_2 = `<ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan" Version="1.6" Build="16.0.0.0"><BatchSequence><Batch><Statements><StmtSimple StatementText="SELECT 2"><QueryPlan><RelOp NodeId="0" PhysicalOp="Hash Match" LogicalOp="Hash Match" EstimateRows="20" EstimatedTotalSubtreeCost="0.005"><Hash /></RelOp></QueryPlan></StmtSimple></Statements></Batch></BatchSequence></ShowPlanXML>`;

  await page.evaluate(({ filePlan, live1, live2 }) => {
    const w = window as unknown as IpcWindow;
    const orig = w.__TAURI_INTERNALS__.invoke;
    let liveCount = 0;
    w.__TAURI_INTERNALS__.invoke = (cmd, args) => {
      if (cmd === "plugin:dialog|open") return Promise.resolve("C:/plans/saved.sqlplan");
      if (cmd === "file_read") return Promise.resolve(filePlan);
      if (cmd === "management_read") {
        const res = args.resource as { kind?: string };
        if (res.kind === "queryStorePlans") {
          return Promise.resolve({
            columns: ["plan_id", "avg_duration_us", "is_forced_plan"],
            rows: [
              ["10", "500", "0"],
              ["20", "800", "0"],
            ],
            truncated: false,
          });
        }
        if (res.kind === "live") {
          liveCount++;
          return Promise.resolve({
            columns: ["query_plan"],
            rows: [[liveCount === 1 ? live1 : live2]],
            truncated: false,
          });
        }
      }
      return orig(cmd, args);
    };
  }, { filePlan: FILE_PLAN, live1: LIVE_PLAN_1, live2: LIVE_PLAN_2 });

  await openTool(page, "Query Store");
  await page.getByRole("combobox", { name: "Database", exact: true }).click();
  await page.getByRole("option", { name: "Sales", exact: true }).click();
  await page.getByText("SELECT Id, Name FROM dbo.Customer", { exact: true }).click();
  const plans = page.locator("table").filter({ has: page.getByRole("columnheader", { name: "plan id", exact: true }) });
  await plans.locator("tbody tr").nth(0).click();
  await page.getByRole("combobox", { name: "Compare against", exact: true }).click();
  await page.getByRole("option", { name: /Plan 20/ }).click();

  await plans.locator("tbody tr").nth(1).click();
  await expect(page.getByRole("combobox", { name: "Compare against", exact: true })).toHaveText("No comparison");
  await expect(page.getByRole("img", { name: "Execution plan operator tree" })).toHaveCount(1);

  await openTool(page, "Activity Monitor");
  await page.getByRole("combobox", { name: "Refresh interval", exact: true }).click();
  await page.getByRole("option", { name: "Manual", exact: true }).click();
  await page.getByRole("tab", { name: "Live query", exact: true }).click();
  await page.getByLabel("SQL session ID", { exact: true }).fill("55");
  await expect(page.getByText("Index Seek", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open .sqlplan", exact: true }).click();
  await expect(page.getByText("Table Scan", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("Hash Match", { exact: true })).toBeVisible();
});

test("LiveLine stops requestAnimationFrame after unmount even when pointer leaves right before closing", async ({ page }) => {
  await gotoMock(page);
  await openTool(page, "Activity Monitor");
  const chart = page.getByRole("group", { name: "CPU and memory use", exact: true });
  await expect(chart).toBeVisible();
  const box = (await chart.boundingBox())!;

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.move(5, 5);
  await page.getByRole("button", { name: "Close Activity Monitor", exact: true }).click();
  await expect(chart).toHaveCount(0);

  await page.waitForTimeout(250);
  const rafCount = await page.evaluate(async () => {
    let calls = 0;
    const orig = window.requestAnimationFrame;
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      calls++;
      return orig(cb);
    }) as typeof window.requestAnimationFrame;
    await new Promise((r) => setTimeout(r, 300));
    window.requestAnimationFrame = orig;
    return calls;
  });
  expect(rafCount).toBe(0);
});

test("Messages pane does not steal focus to editor when drag-selecting error text", async ({ page }) => {
  await gotoMock(page);
  await page.getByRole("button", { name: "New query on Mock server", exact: true }).click();
  await expect(page.locator(".monaco-editor")).toBeVisible();
  await expect.poll(() => page.locator(".monaco-editor").evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.evaluate(async () => {
    const path = "/src/stores/queries.ts";
    const { useQueries } = await import(/* @vite-ignore */ path);
    const id = useQueries.getState().activeId;
    useQueries.setState((s: { tabs: Array<Record<string, unknown>> }) => ({
      tabs: s.tabs.map((t) =>
        t.id === id
          ? {
              ...t,
              view: "messages",
              hasErrors: true,
              messages: [{ text: "Msg 208: Invalid object name 'dbo.MissingTable'.", isError: true, line: 1 }],
            }
          : t,
      ),
    }));
  });

  const msg = page.getByText("Msg 208: Invalid object name 'dbo.MissingTable'.", { exact: true });
  await expect(msg).toBeVisible();
  const box = (await msg.boundingBox())!;

  await page.mouse.move(box.x + 10, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 140, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();

  const editorHasFocus = await page.locator(".monaco-editor").evaluate((el) => el.contains(document.activeElement));
  expect(editorHasFocus).toBe(false);

  // Plain click (after clearing selection) still reveals the line and focuses Monaco.
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await msg.click({ position: { x: 10, y: 8 } });
  await expect.poll(() => page.locator(".monaco-editor").evaluate((el) => el.contains(document.activeElement))).toBe(true);
});

test("ConnectDialog clears SQL password when switching to Windows or Entra authentication", async ({ page }) => {
  await gotoMock(page);
  await page.evaluate(() => {
    const w = window as unknown as IpcWindow;
    const orig = w.__TAURI_INTERNALS__.invoke;
    w.capturedPasswords = [];
    w.__TAURI_INTERNALS__.invoke = (cmd, args) => {
      if (cmd === "test_connection") {
        (w.capturedPasswords as unknown[]).push({ cmd, password: args.password });
      }
      if (cmd === "save_connection") {
        (w.capturedPasswords as unknown[]).push({ cmd, password: args.password });
        return Promise.resolve(args.connection);
      }
      return orig(cmd, args);
    };
  });

  await page.getByRole("button", { name: "New connection", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "New connection", exact: true });
  await dialog.getByLabel("Server name", { exact: true }).fill("win-server");
  await dialog.getByLabel("Login", { exact: true }).fill("sa");
  await dialog.getByLabel("Password", { exact: true }).fill("SuperSecret!123");

  await dialog.getByRole("combobox").first().click();
  await page.getByRole("option", { name: "Windows Authentication", exact: true }).click();

  await dialog.getByRole("button", { name: "Test connection", exact: true }).click();
  await expect(dialog.getByText(/Connected to /)).toBeVisible();
  await dialog.getByRole("button", { name: "Save and connect", exact: true }).click();
  await expect(dialog).toBeHidden();

  expect(await page.evaluate(() => (window as unknown as IpcWindow).capturedPasswords)).toEqual([
    { cmd: "test_connection", password: null },
    { cmd: "save_connection", password: null },
  ]);
});
