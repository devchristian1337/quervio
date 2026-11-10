import { test, expect, type Page } from "@playwright/test";

type IpcWindow = Window & {
  __TAURI_INTERNALS__: { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> };
  rowReads: string[];
};

const queries = "/src/stores/queries.ts";

async function execute(page: Page, sql: string) {
  await page.locator(".monaco-editor").last().click({ position: { x: 80, y: 12 } });
  await page.keyboard.insertText(sql);
  await page.getByRole("button", { name: "Execute", exact: true }).click();
}

const activeTab = (page: Page) => page.evaluate(async (path) => {
  const { useQueries } = await import(/* @vite-ignore */ path);
  return useQueries.getState().activeId as string;
}, queries);

test("each query tab keeps its own result rows and sort", async ({ page }) => {
  await page.goto("/?mock");
  await page.getByRole("button", { name: "New query on Mock server", exact: true }).click();
  // Which tab's rows each grid reads.
  await page.evaluate(() => {
    const w = window as unknown as IpcWindow;
    w.rowReads = [];
    const invoke = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = (command, args) => {
      if (command === "result_rows") w.rowReads.push(String(args.tabId));
      return invoke(command, args);
    };
  });
  const sorted = page.getByText("Sorted by", { exact: false });
  const grid = page.getByTestId("data-grid-canvas");

  await execute(page, "SELECT 1;");
  const first = await activeTab(page);
  await expect(grid).toBeVisible();
  await grid.click({ position: { x: 62, y: 18 }, force: true });
  await expect(sorted).toContainText("Id↑");

  await page.evaluate(async (path) => {
    const { useQueries } = await import(/* @vite-ignore */ path);
    await useQueries.getState().open("mock", "master");
  }, queries);
  // Both tabs are now at their first Execution: the same run number.
  await execute(page, "SELECT 2;");
  const second = await activeTab(page);
  await expect(grid).toBeVisible();
  await expect(sorted).toHaveCount(0);

  await page.evaluate(() => { (window as unknown as IpcWindow).rowReads = []; });
  await page.getByRole("tab").first().dispatchEvent("mousedown");
  await expect.poll(() => activeTab(page)).toBe(first);
  await expect(sorted).toContainText("Id↑");
  // The first tab's grid reads its own sorted rows, never the second tab's.
  await expect.poll(() => page.evaluate(() => (window as unknown as IpcWindow).rowReads)).toContain(first);
  expect(await page.evaluate(() => (window as unknown as IpcWindow).rowReads)).not.toContain(second);

  // Messages and back mounts the grid again: the rows are still sorted.
  await page.getByRole("tab", { name: "Messages" }).click();
  await page.getByRole("tab", { name: "Results" }).click();
  await expect(sorted).toContainText("Id↑");
});
