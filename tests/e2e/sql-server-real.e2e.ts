import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { browser, $ } from "@wdio/globals";
import {
  TEST_DATA_DIR,
  dismissTourIfOpen,
  getSqlFixture,
  invokeTauri,
  invokeTauriWithChannel,
  saveDesktopScreenshot,
  setReactInputValue,
  typeInMonaco,
  waitForAppReady,
} from "./helpers/tauri.ts";

const sqlFixture = getSqlFixture();
const describeSql = sqlFixture ? describe : describe.skip;
const DEFAULT_EXEC_OPTIONS = {
  timeoutSeconds: 30,
  maxRows: 1000,
  maxCellBytes: 65536,
  planMode: "none",
};

describeSql("Quervio Real Desktop App — Isolated Docker SQL Server E2E", () => {
  const testDbName = `QuervioE2e_${Date.now().toString(36)}`;
  let testConnId = "";
  let prodConnId = "";
  let originalTourSeen: string | null = null;

  before(async () => {
    await waitForAppReady(30000);
    originalTourSeen = await browser.execute(() => localStorage.getItem("quervio.tour.seen"));
    if (originalTourSeen !== "1") {
      await browser.execute(() => {
        localStorage.setItem("quervio.tour.seen", "1");
        window.location.reload();
      });
      await waitForAppReady(30000);
    }
    await dismissTourIfOpen();
  });

  after(async () => {
    if (!sqlFixture) return;
    await browser.execute((prev: string | null) => {
      if (prev === null) localStorage.removeItem("quervio.tour.seen");
      else localStorage.setItem("quervio.tour.seen", prev);
    }, originalTourSeen).catch(() => {});
    await invokeTauri("tabs_save", { snapshot: JSON.stringify({ version: 1, active: 0, tabs: [] }) }).catch(() => {});
    // Best-effort cleanup of disposable test database inside the ephemeral Docker container.
    if (testConnId) {
      const cleanupTab = `cleanup-${Date.now()}`;
      try {
        await invokeTauri("query_open", { tabId: cleanupTab, connectionId: testConnId, database: "master" });
        await invokeTauriWithChannel("query_execute", {
          tabId: cleanupTab,
          script: `IF DB_ID(N'${testDbName}') IS NOT NULL BEGIN ALTER DATABASE [${testDbName}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${testDbName}]; END`,
          baseLine: 0,
          options: DEFAULT_EXEC_OPTIONS,
          allowDestructive: true,
        });
        await invokeTauri("query_close", { tabId: cleanupTab });
      } catch {
        // Container is destroyed by run-desktop-e2e.mjs anyway.
      }
      await invokeTauri("delete_connection", { id: testConnId }).catch(() => {});
    }
    if (prodConnId) {
      await invokeTauri("delete_connection", { id: prodConnId }).catch(() => {});
    }
  });

  it("creates and tests a real Saved Connection via ConnectDialog against isolated Docker SQL Server", async () => {
    const newConnBtn = await $('button[aria-label="New connection"]');
    await newConnBtn.waitForDisplayed({ timeout: 10000 });
    await newConnBtn.click();

    await setReactInputValue("#server", sqlFixture!.server);
    await setReactInputValue("#login", sqlFixture!.user);
    await setReactInputValue("#password", sqlFixture!.password);
    await setReactInputValue("#name", "Docker SQL Test");

    // Trust self-signed certificate of disposable Docker SQL Server
    const trustCheckbox = await $('label*=Trust server certificate').$('button[role="checkbox"]');
    await trustCheckbox.click();

    // Select Environment = Test
    const envCombobox = await $('//label[text()="Environment"]/following-sibling::button[@role="combobox"]');
    await envCombobox.click();
    const testOption = await $('[role="option"]*=Test');
    await testOption.waitForDisplayed({ timeout: 5000 });
    await testOption.click();

    const testBtn = await $("button=Test connection");
    await testBtn.click();
    await browser.waitUntil(
      async () => (await browser.execute(() => document.body.innerText)).includes("Connected to "),
      { timeout: 20000, timeoutMsg: "Test connection did not report success against Docker SQL Server" },
    );
    await saveDesktopScreenshot("desktop-sql-01-connect-tested");

    const saveBtn = await $("button=Save and connect");
    await saveBtn.click();
    await browser.waitUntil(async () => !(await (await $('[role="dialog"]')).isExisting()), {
      timeout: 10000,
      timeoutMsg: "ConnectDialog did not close after Save and connect",
    });

    const list = await invokeTauri<Array<{ id: string; name: string }>>("list_connections");
    const saved = list.find((c) => c.name === "Docker SQL Test");
    assert.ok(saved, "Docker SQL Test connection must be persisted");
    testConnId = saved.id;

    // Verify Object Explorer connects and lists master database
    const dbs = await invokeTauri<Array<{ name: string }>>("explorer_databases", { id: testConnId });
    assert.ok(dbs.some((db) => db.name === "master"), "Object Explorer must list master database");
    await saveDesktopScreenshot("desktop-sql-02-object-explorer");
  });

  it("executes real T-SQL queries, renders Glide Data Grid, and preserves dedicated tab sessions & temp tables", async () => {
    // Open Tab 1 on Docker SQL Test via UI button or keyboard
    const newQueryBtn = await $('button[aria-label="New query on Docker SQL Test"]');
    if (await newQueryBtn.isExisting()) {
      await newQueryBtn.click();
    } else {
      const serverNode = await $('[role="treeitem"]*=Docker SQL Test');
      await serverNode.click();
      await $('button[aria-label="New query"]').click();
    }

    await (await $(".monaco-editor")).waitForDisplayed({ timeout: 20000 });
    await browser.waitUntil(
      async () => (await browser.execute(() => document.body.innerText)).includes("Connected."),
      { timeout: 20000, timeoutMsg: "Query Tab 1 did not connect to Docker SQL Server" },
    );

    // Create disposable database, table, seed rows, and session-scoped temp table
    const setupSql = [
      `CREATE DATABASE [${testDbName}];`,
      `GO`,
      `USE [${testDbName}];`,
      `CREATE TABLE dbo.E2eItems (Id INT PRIMARY KEY, Title NVARCHAR(100) NOT NULL, Notes NVARCHAR(100) NULL);`,
      `INSERT INTO dbo.E2eItems (Id, Title, Notes) VALUES (1, N'Alpha', NULL), (2, N'Beta', N'Line1'), (3, N'=SUM(A1:A2)', N'FormulaTest');`,
      `CREATE TABLE #QuervioSessionCheck (Id INT NOT NULL);`,
      `INSERT INTO #QuervioSessionCheck VALUES (42);`,
      `SELECT @@SPID AS Spid, DB_NAME() AS CurrentDb, Id, Title, Notes FROM dbo.E2eItems ORDER BY Id;`,
    ].join("\n");

    await typeInMonaco(setupSql);
    await $("button=Execute").click();

    await browser.waitUntil(
      async () => (await browser.execute(() => document.body.innerText)).includes("Query executed successfully."),
      { timeout: 30000, timeoutMsg: "Setup query did not complete successfully" },
    );

    const gridCanvas = await $('[data-testid="data-grid-canvas"]');
    await gridCanvas.waitForDisplayed({ timeout: 10000 });
    await saveDesktopScreenshot("desktop-sql-03-results-grid");

    // Verify dedicated session isolation via real IPC on a second Query Tab
    const tab2Id = `e2e-tab2-${Date.now()}`;
    await invokeTauri("query_open", { tabId: tab2Id, connectionId: testConnId, database: testDbName });
    const { result: tab2Outcome } = await invokeTauriWithChannel<string>("query_execute", {
      tabId: tab2Id,
      script: "SELECT OBJECT_ID('tempdb..#QuervioSessionCheck') AS TempObjId, COUNT(*) AS ItemCount FROM dbo.E2eItems;",
      baseLine: 0,
      options: DEFAULT_EXEC_OPTIONS,
      allowDestructive: false,
    });
    assert.equal(tab2Outcome, "succeeded", "Second tab query must succeed");
    const cell0 = await invokeTauri<{ text: string | null }>("result_cell", {
      tabId: tab2Id,
      set: 0,
      row: 0,
      column: 0,
    });
    const cell1 = await invokeTauri<{ text: string | null }>("result_cell", {
      tabId: tab2Id,
      set: 0,
      row: 0,
      column: 1,
    });
    assert.equal(cell0.text, null, "#QuervioSessionCheck from Tab 1 must be NULL (invisible) in Tab 2");
    assert.equal(cell1.text, "3", "Tab 2 must see all 3 committed rows in dbo.E2eItems");

    // Verify real data export (CSV with NULL as \N, formula rejection, and XLSX)
    const csvOkPath = path.join(TEST_DATA_DIR, "export-ok.csv");
    const xlsxPath = path.join(TEST_DATA_DIR, "export-formula.xlsx");
    const csvFormulaPath = path.join(TEST_DATA_DIR, "export-formula.csv");

    await invokeTauriWithChannel("query_execute", {
      tabId: tab2Id,
      script: "SELECT Id, Title, Notes FROM dbo.E2eItems WHERE Id IN (1, 2) ORDER BY Id;",
      baseLine: 0,
      options: DEFAULT_EXEC_OPTIONS,
      allowDestructive: false,
    });
    await invokeTauri("result_export_file", { tabId: tab2Id, set: 0, path: csvOkPath, format: "csv" });
    const csvContent = await fs.readFile(csvOkPath, "utf8");
    assert.match(csvContent, /"Id","Title","Notes"/);
    assert.match(csvContent, /"1","Alpha","\\N"/);

    // Formula cell (=SUM(A1:A2)) must be rejected in CSV and allowed as text cell in XLSX
    await invokeTauriWithChannel("query_execute", {
      tabId: tab2Id,
      script: "SELECT Id, Title FROM dbo.E2eItems WHERE Id = 3;",
      baseLine: 0,
      options: DEFAULT_EXEC_OPTIONS,
      allowDestructive: false,
    });
    await assert.rejects(
      () => invokeTauri("result_export_file", { tabId: tab2Id, set: 0, path: csvFormulaPath, format: "csv" }),
      /formula/i,
      "CSV export must reject formula-like cells",
    );
    await invokeTauri("result_export_file", { tabId: tab2Id, set: 0, path: xlsxPath, format: "xlsx" });
    const xlsxHeader = (await fs.readFile(xlsxPath)).subarray(0, 2).toString("utf8");
    assert.equal(xlsxHeader, "PK", "XLSX export must write a valid ZIP/OOXML workbook");

    await invokeTauri("query_close", { tabId: tab2Id });
  });

  it("handles real query cancellation while preserving the dedicated Session (@@SPID)", async () => {
    const cancelTab = `e2e-cancel-${Date.now()}`;
    await invokeTauri("query_open", { tabId: cancelTab, connectionId: testConnId, database: testDbName });

    await invokeTauriWithChannel("query_execute", {
      tabId: cancelTab,
      script: "SELECT @@SPID AS Spid;",
      baseLine: 0,
      options: DEFAULT_EXEC_OPTIONS,
      allowDestructive: false,
    });
    const spidBefore = (
      await invokeTauri<{ text: string | null }>("result_cell", { tabId: cancelTab, set: 0, row: 0, column: 0 })
    ).text;
    assert.ok(spidBefore, "Initial SPID must be returned");

    // Start long-running WAITFOR DELAY and cancel it from inside the same WebView context
    // (WebDriver serializes separate executeAsync calls per session).
    const cancelOutcome = (await browser.executeAsync(
      (
        tabId: string,
        execOptions: typeof DEFAULT_EXEC_OPTIONS,
        done: (res: { value?: string; error?: string }) => void,
      ) => {
        const internals = (
          window as unknown as {
            __TAURI_INTERNALS__: {
              invoke: (c: string, a: Record<string, unknown>) => Promise<string>;
              transformCallback: (cb: (event: unknown) => void) => number;
            };
          }
        ).__TAURI_INTERNALS__;
        const cbId = internals.transformCallback(() => {});
        const timer = window.setTimeout(() => {
          void internals.invoke("query_cancel", { tabId });
        }, 800);
        internals
          .invoke("query_execute", {
            tabId,
            script: "WAITFOR DELAY '00:00:20'; SELECT 1;",
            baseLine: 0,
            options: execOptions,
            allowDestructive: false,
            onEvent: `__CHANNEL__:${cbId}`,
          })
          .then((value) => {
            window.clearTimeout(timer);
            done({ value });
          })
          .catch((error) => {
            window.clearTimeout(timer);
            done({ error: String(error) });
          });
      },
      cancelTab,
      DEFAULT_EXEC_OPTIONS,
    )) as { value?: string; error?: string };
    assert.equal(cancelOutcome.error, undefined, cancelOutcome.error ?? "query_execute/cancel error");
    assert.equal(cancelOutcome.value, "cancelled", "Cancelled WAITFOR DELAY must resolve as cancelled");

    // Same session must still work and keep the exact same @@SPID
    await invokeTauriWithChannel("query_execute", {
      tabId: cancelTab,
      script: "SELECT @@SPID AS Spid;",
      baseLine: 0,
      options: DEFAULT_EXEC_OPTIONS,
      allowDestructive: false,
    });
    const spidAfter = (
      await invokeTauri<{ text: string | null }>("result_cell", { tabId: cancelTab, set: 0, row: 0, column: 0 })
    ).text;
    assert.equal(spidAfter, spidBefore, "Session SPID must remain identical after cancellation");

    await invokeTauri("query_close", { tabId: cancelTab });
  });

  it("prompts Open transactions on tab close and rolls back uncommitted writes", async () => {
    await typeInMonaco("BEGIN TRANSACTION;\nINSERT INTO dbo.E2eItems (Id, Title, Notes) VALUES (99, N'Uncommitted', NULL);\nSELECT @@TRANCOUNT AS OpenTran;");
    await $("button=Execute").click();

    await browser.waitUntil(
      async () => await (await $('[aria-label="Open transaction"]')).isExisting(),
      { timeout: 15000, timeoutMsg: "Open transaction indicator did not appear on the Query Tab" },
    );
    await saveDesktopScreenshot("desktop-sql-04-open-transaction");

    // Close the active dirty tab -> Unsaved changes dialog appears first, then Open transactions dialog
    const closeTabBtn = await $('[role="tab"][aria-selected="true"] + button[aria-label="Close"]');
    await closeTabBtn.click();

    const unsavedDialog = await $('[role="dialog"]');
    await unsavedDialog.waitForDisplayed({ timeout: 10000 });
    const dontSaveBtn = await unsavedDialog.$("button=Don't save");
    await dontSaveBtn.waitForDisplayed({ timeout: 10000 });
    await dontSaveBtn.click();

    const txDialog = await $('[role="dialog"]');
    const rollbackBtn = await txDialog.$("button=Roll back");
    await rollbackBtn.waitForDisplayed({ timeout: 10000 });
    await saveDesktopScreenshot("desktop-sql-05-open-transactions-dialog");
    await rollbackBtn.click();
    await browser.waitUntil(async () => !(await (await $('[role="dialog"]')).isExisting()), { timeout: 10000 });

    // Verify Id=99 was truly rolled back in SQL Server
    const verifyTab = `e2e-verify-rb-${Date.now()}`;
    await invokeTauri("query_open", { tabId: verifyTab, connectionId: testConnId, database: testDbName });
    await invokeTauriWithChannel("query_execute", {
      tabId: verifyTab,
      script: "SELECT COUNT(*) FROM dbo.E2eItems WHERE Id = 99;",
      baseLine: 0,
      options: DEFAULT_EXEC_OPTIONS,
      allowDestructive: false,
    });
    const count = (
      await invokeTauri<{ text: string | null }>("result_cell", { tabId: verifyTab, set: 0, row: 0, column: 0 })
    ).text;
    assert.equal(count, "0", "Uncommitted row must be rolled back on SQL Server");
    await invokeTauri("query_close", { tabId: verifyTab });
  });

  it("blocks destructive DELETE without WHERE on Production connection until explicitly confirmed", async () => {
    // Save a second connection pointing to the SAME disposable Docker SQL Server, marked Production
    const prod = await invokeTauri<{ id: string }>("save_connection", {
      connection: {
        id: "",
        name: "Docker Simulated Prod",
        group: null,
        server: sqlFixture!.server,
        authentication: { kind: "sql", userName: sqlFixture!.user },
        defaultDatabase: testDbName,
        environment: "production",
        encrypt: "mandatory",
        trustServerCertificate: true,
      },
      password: sqlFixture!.password,
    });
    prodConnId = prod.id;

    // Reload to pick up the new saved connection in Object Explorer and Start Screen
    await browser.execute(() => window.location.reload());
    await waitForAppReady(30000);
    await dismissTourIfOpen();

    const prodTreeItem = await $('[role="treeitem"]*=Docker Simulated Prod');
    await prodTreeItem.waitForDisplayed({ timeout: 15000 });
    await prodTreeItem.click();
    const toolbarNewQuery = await $('button[aria-label="New query"]');
    await toolbarNewQuery.waitForEnabled({ timeout: 10000 });
    await toolbarNewQuery.click();

    await (await $(".monaco-editor")).waitForDisplayed({ timeout: 20000 });
    await browser.waitUntil(
      async () => (await browser.execute(() => document.body.innerText)).includes("Connected."),
      { timeout: 20000, timeoutMsg: "Production test tab did not connect" },
    );

    await typeInMonaco("DELETE FROM dbo.E2eItems;");
    await $("button=Execute").click();

    const dialogHeading = await $("h2=Destructive statements on Production");
    await dialogHeading.waitForDisplayed({ timeout: 10000 });
    await saveDesktopScreenshot("desktop-sql-06-destructive-guard");

    // Cancel first -> rows must remain intact
    const prodDialog = await $('[role="dialog"]');
    await (await prodDialog.$("button=Cancel")).click();
    await browser.waitUntil(async () => !(await (await $('[role="dialog"]')).isExisting()), { timeout: 5000 });

    const checkTab = `e2e-check-prod-${Date.now()}`;
    await invokeTauri("query_open", { tabId: checkTab, connectionId: testConnId, database: testDbName });
    await invokeTauriWithChannel("query_execute", {
      tabId: checkTab,
      script: "SELECT COUNT(*) FROM dbo.E2eItems;",
      baseLine: 0,
      options: DEFAULT_EXEC_OPTIONS,
      allowDestructive: false,
    });
    assert.equal(
      (await invokeTauri<{ text: string | null }>("result_cell", { tabId: checkTab, set: 0, row: 0, column: 0 })).text,
      "3",
      "Cancelling destructive confirmation must leave all rows untouched",
    );

    // Execute again and click Run anyway -> rows deleted
    await $("button=Execute").click();
    const prodDialog2 = await $('[role="dialog"]');
    const runAnywayBtn = await prodDialog2.$("button=Run anyway");
    await runAnywayBtn.waitForDisplayed({ timeout: 10000 });
    await runAnywayBtn.click();

    await browser.waitUntil(
      async () => (await browser.execute(() => document.body.innerText)).includes("Query executed successfully."),
      { timeout: 15000, timeoutMsg: "Confirmed destructive query did not complete" },
    );

    await invokeTauriWithChannel("query_execute", {
      tabId: checkTab,
      script: "SELECT COUNT(*) FROM dbo.E2eItems;",
      baseLine: 0,
      options: DEFAULT_EXEC_OPTIONS,
      allowDestructive: false,
    });
    assert.equal(
      (await invokeTauri<{ text: string | null }>("result_cell", { tabId: checkTab, set: 0, row: 0, column: 0 })).text,
      "0",
      "Confirmed destructive DELETE must remove rows in the isolated test DB",
    );
    await invokeTauri("query_close", { tabId: checkTab });
  });
});
