import { test, expect, type Page } from "@playwright/test";

type IpcWindow = Window & {
  __TAURI_INTERNALS__: { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> };
};

const queries = "/src/stores/queries.ts";
// A saved plan that differs from the mock Server's Clustered Index Scan.
const FILE_PLAN = `<ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan" Version="1.6" Build="16.0.0.0"><BatchSequence><Batch><Statements><StmtSimple StatementText="SELECT * FROM dbo.Saved"><QueryPlan><RelOp NodeId="0" PhysicalOp="Table Scan" LogicalOp="Table Scan" EstimateRows="5" EstimatedTotalSubtreeCost="0.001"><TableScan /></RelOp></QueryPlan></StmtSimple></Statements></Batch></BatchSequence></ShowPlanXML>`;

async function executeWithPlan(page: Page) {
  await page.evaluate(async (path) => {
    const { useQueries } = await import(/* @vite-ignore */ path);
    const state = useQueries.getState();
    state.setPlanMode(state.activeId, "actual");
  }, queries);
  await page.getByRole("button", { name: "Execute", exact: true }).click();
}

test("a plan opened from file gives way to the next Execution's plan", async ({ page }) => {
  await page.goto("/?mock");
  await page.getByRole("button", { name: "New query on Mock server", exact: true }).waitFor();
  await page.evaluate((plan) => {
    const w = window as unknown as IpcWindow;
    const invoke = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = (command, args) => {
      if (command === "plugin:dialog|open") return Promise.resolve("C:/plans/saved.sqlplan");
      if (command === "file_read" && String(args.path).endsWith(".sqlplan")) return Promise.resolve(plan);
      return invoke(command, args);
    };
  }, FILE_PLAN);
  await page.getByRole("button", { name: "New query on Mock server", exact: true }).click();
  await page.locator(".monaco-editor").click({ position: { x: 80, y: 12 } });
  await page.keyboard.insertText("SELECT Id FROM dbo.Customer;");
  await executeWithPlan(page);
  await expect(page.getByText("Clustered Index Scan").first()).toBeVisible();

  await page.getByRole("button", { name: "Open .sqlplan" }).click();
  await expect(page.getByText("Table Scan", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Clustered Index Scan")).toHaveCount(0);

  await executeWithPlan(page);
  await expect(page.getByText("Clustered Index Scan").first()).toBeVisible();
  await expect(page.getByText("Table Scan", { exact: true })).toHaveCount(0);
});
