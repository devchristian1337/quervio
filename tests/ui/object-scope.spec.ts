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

test("rows of another scope are not shown or acted on after a failed read", async ({ page }) => {
  await page.goto("/?mock");
  await expect(page.getByRole("button", { name: "Tools", exact: true })).toBeVisible();
  await page.evaluate(() => {
    const w = window as unknown as IpcWindow;
    const invoke = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = (command, args) => {
      const resource = args.resource as { kind?: string; server?: boolean } | undefined;
      if (command === "management_read" && resource?.kind === "principals" && resource.server) {
        return Promise.reject("The SELECT permission was denied (mock).");
      }
      return invoke(command, args);
    };
  });
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByRole("menuitem", { name: "Security / Audit", exact: true }).click();
  await expect(page.getByRole("cell", { name: "SQL_USER" })).toBeVisible();
  await page.getByRole("cell", { name: "dbo", exact: true }).click();

  await page.getByRole("combobox", { name: "Scope", exact: true }).click();
  await page.getByRole("option", { name: "Server", exact: true }).click();
  await expect(page.getByText("permission was denied", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
  // Checked once the failed read has settled, not retried until a redraw.
  expect(await page.getByRole("cell", { name: "SQL_USER" }).count()).toBe(0);
  expect(await page.getByRole("cell", { name: "dbo", exact: true }).count()).toBe(0);
  // The database user picked before is not carried over as a login name.
  await page.getByRole("combobox", { name: "Operation", exact: true }).click();
  await page.getByRole("option", { name: "delete", exact: true }).click();
  await expect(page.getByRole("button", { name: "Preview security changes", exact: true })).toBeDisabled();
});

test("creating an audit without its directory builds no other operation", async ({ page }) => {
  await page.goto("/?mock");
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByRole("menuitem", { name: "Security / Audit", exact: true }).click();
  await page.getByRole("tab", { name: "SQL Server Audit", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Nightly");
  const preview = page.getByRole("button", { name: "Preview security changes", exact: true });
  // "create" is the default operation; without a directory there is nothing to create.
  await expect(preview).toBeDisabled();
  await page.getByLabel("Server-side audit directory (trailing slash)", { exact: true }).fill("D:\\Audit\\");
  await expect(preview).toBeEnabled();
});
