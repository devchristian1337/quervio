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
