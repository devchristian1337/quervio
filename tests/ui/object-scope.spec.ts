import { test, expect, type Page } from "@playwright/test";

const queries = "/src/stores/queries.ts";

async function openSales(page: Page) {
  await page.goto("/?mock");
  await page.getByRole("treeitem", { name: /^Mock server/ }).dblclick();
  await page.getByRole("treeitem", { name: /^Databases/ }).dblclick().catch(() => {});
  await page.getByRole("treeitem", { name: /^Sales/ }).dblclick();
}

test("a new database trigger script is scoped to the database", async ({ page }) => {
  await openSales(page);
  await page.getByRole("treeitem", { name: /^Database Triggers/ }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "New object script…", exact: true }).click();
  await expect.poll(() => page.evaluate(async (path) => {
    const { useQueries } = await import(/* @vite-ignore */ path);
    const state = useQueries.getState();
    const tab = state.tabs.find((t: { id: string }) => t.id === state.activeId);
    return tab ? { database: tab.database, text: tab.initialText.split("\n")[0] } : null;
  }, queries)).toEqual({ database: "Sales", text: "CREATE TRIGGER TriggerName ON DATABASE" });
});

type IpcWindow = Window & {
  __TAURI_INTERNALS__: { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> };
  objectCalls: string[];
};

test("an object tool forgets its object when another database is chosen", async ({ page }) => {
  await page.goto("/?mock");
  await expect(page.getByRole("button", { name: "Tools", exact: true })).toBeVisible();
  await page.evaluate(() => {
    const w = window as unknown as IpcWindow;
    w.objectCalls = [];
    const invoke = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = (command, args) => {
      const resource = args.resource as { objectId?: number } | undefined;
      if (command === "management_read" && resource?.objectId !== undefined) {
        w.objectCalls.push(`read ${String(args.database)}:${resource.objectId}`);
      }
      if (command === "management_prepare") w.objectCalls.push(`prepare ${String(args.database)}:${String(args.script)}`);
      return invoke(command, args);
    };
  });
  await page.evaluate(async () => {
    const path = "/src/stores/workbench.ts";
    const { useWorkbench } = await import(/* @vite-ignore */ path);
    useWorkbench.getState().open("properties", { connectionId: "mock", database: "master" }, { objectId: 1, schema: "dbo", name: "Customer" });
  });
  await expect(page.getByRole("heading", { name: "Object Properties · dbo.Customer" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as IpcWindow).objectCalls)).toContain("read master:1");

  await page.evaluate(() => { (window as unknown as IpcWindow).objectCalls = []; });
  await page.getByRole("combobox", { name: "Database", exact: true }).click();
  await page.getByRole("option", { name: "Sales", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Object Properties", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Preview DROP", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as IpcWindow).objectCalls)).toEqual([]);

  // Back in its own database, the tool shows the object again.
  await page.getByRole("combobox", { name: "Database", exact: true }).click();
  await page.getByRole("option", { name: "master", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Object Properties · dbo.Customer" })).toBeVisible();
});
