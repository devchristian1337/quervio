import { test, expect, type Page } from "@playwright/test";

async function openTool(page: Page, name: string) {
  await page.goto("/?mock");
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}

test("template search clears with mouse and keyboard and restores the list", async ({ page }) => {
  await openTool(page, "Templates / Snippets");
  const search = page.getByRole("searchbox", { name: "Search templates", exact: true });
  const clear = page.getByRole("button", { name: "Clear template search", exact: true });
  const template = page.getByRole("button", { name: /Select rows/ });
  await expect(clear).toHaveCount(0);
  await expect(template).toBeVisible();
  await search.fill("no-matching-template");
  await expect(template).toHaveCount(0);
  await page.screenshot({ path: "target/ui-test-results/search-clear-templates.png" });
  await clear.click();
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();
  await expect(clear).toHaveCount(0);
  await expect(template).toBeVisible();
  await search.fill("transaction");
  await search.press("Tab");
  await expect(clear).toBeFocused();
  await clear.press("Enter");
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();
  await expect(template).toBeVisible();
});

test("captured event filter clears without changing the profiler session", async ({ page }) => {
  await openTool(page, "Extended Events / Profiler");
  const search = page.getByRole("searchbox", { name: "Filter captured events", exact: true });
  const event = page.getByRole("cell", { name: "sql_batch_completed", exact: true });
  await expect(event).toBeVisible();
  await search.fill("no-matching-event");
  await expect(event).toHaveCount(0);
  await page.getByRole("button", { name: "Clear captured events filter", exact: true }).click();
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();
  await expect(event).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Session name", exact: true })).toHaveValue("Quervio_Profiler");
});

test("Object Explorer can clear a name filter and keep it open for another search", async ({ page }) => {
  await page.goto("/?mock");
  await page.getByRole("treeitem", { name: /Mock server/ }).dblclick();
  await page.getByRole("treeitem", { name: "Databases", exact: true }).dblclick();
  await page.getByRole("treeitem", { name: "Sales", exact: true }).dblclick();
  const tables = page.getByRole("treeitem", { name: /^Tables(?: Filter)?$/ });
  await tables.dblclick();
  await tables.getByRole("button", { name: "Filter", exact: true }).click();
  const search = page.getByRole("searchbox", { name: "Filter by name", exact: true });
  const customer = page.getByRole("treeitem", { name: /Customer/ });
  await search.fill("missing-table");
  await expect(customer).toHaveCount(0);
  await page.screenshot({ path: "target/ui-test-results/search-clear-explorer.png" });
  await page.getByRole("button", { name: "Clear name filter", exact: true }).click();
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();
  await expect(customer).toBeVisible();
  await search.fill("Customer");
  await expect(customer).toBeVisible();
  await page.getByRole("button", { name: "Close filter", exact: true }).click();
  await expect(search).toHaveCount(0);
  await expect(customer).toBeVisible();
});
