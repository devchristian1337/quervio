import { test, expect, type Page } from "@playwright/test";

type Pending = { resolve: (value: unknown) => void; reject: (error: string) => void };
type TestWindow = Window & {
  __TAURI_INTERNALS__: { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> };
  pendingTests: Pending[];
  pendingDatabases: Pending[];
};

async function newConnection(page: Page) {
  await page.getByRole("button", { name: "New connection", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "New connection", exact: true });
  await dialog.getByLabel("Server name", { exact: true }).fill("test-one");
  await dialog.getByLabel("Login", { exact: true }).fill("test-user");
  await dialog.getByLabel("Password", { exact: true }).fill("test-only");
  return dialog;
}

async function delayTests(page: Page) {
  await page.evaluate(() => {
    const target = window as unknown as TestWindow;
    const invoke = target.__TAURI_INTERNALS__.invoke;
    target.pendingTests = [];
    target.__TAURI_INTERNALS__.invoke = (command, args) => command === "test_connection"
      ? new Promise((resolve, reject) => { target.pendingTests.push({ resolve, reject }); })
      : invoke(command, args);
  });
}

test("changing any tested connection field clears the previous success", async ({ page }) => {
  await page.goto("/?mock");
  const dialog = await newConnection(page);
  for (const [label, value] of [["Server name", "test-two"], ["Login", "another-user"], ["Password", "another-test-only"], ["Default database", "Sales"]]) {
    await dialog.getByRole("button", { name: "Test connection", exact: true }).click();
    await expect(dialog.getByText(/Connected to /)).toBeVisible();
    await dialog.getByLabel(label, { exact: true }).fill(value);
    await expect(dialog.getByText(/Connected to /)).toHaveCount(0);
  }
});

test("a late connection test cannot replace the result for newer values", async ({ page }) => {
  await page.goto("/?mock");
  await delayTests(page);
  const dialog = await newConnection(page);
  const button = dialog.getByRole("button", { name: "Test connection", exact: true });
  await button.click();
  await expect.poll(() => page.evaluate(() => (window as unknown as TestWindow).pendingTests.length)).toBe(1);
  await dialog.getByLabel("Server name", { exact: true }).fill("test-two");
  await expect(button).toBeEnabled();
  await button.click();
  await expect.poll(() => page.evaluate(() => (window as unknown as TestWindow).pendingTests.length)).toBe(2);
  await page.evaluate(() => (window as unknown as TestWindow).pendingTests[1].resolve({ serverName: "test-two", version: "16", database: "master" }));
  await expect(dialog.getByText("Connected to test-two (SQL Server 16)", { exact: true })).toBeVisible();
  await page.evaluate(() => (window as unknown as TestWindow).pendingTests[0].reject("Old connection failed"));
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(dialog.getByText("Connected to test-two (SQL Server 16)", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Old connection failed", { exact: true })).toHaveCount(0);
});

test("closing and reopening a connection dialog ignores its previous pending test", async ({ page }) => {
  await page.goto("/?mock");
  await delayTests(page);
  const dialog = await newConnection(page);
  await dialog.getByRole("button", { name: "Test connection", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as TestWindow).pendingTests.length)).toBe(1);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await newConnection(page);
  await page.evaluate(() => (window as unknown as TestWindow).pendingTests[0].resolve({ serverName: "old-server", version: "16", database: "master" }));
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(dialog.getByText(/Connected to /)).toHaveCount(0);
});

test("an open Query Tab retains its destination after its Saved Connection is edited", async ({ page }) => {
  await page.goto("/?mock");
  await page.getByRole("button", { name: "New query on Mock server", exact: true }).click();
  await expect(page.getByLabel("Current database", { exact: true })).toBeEnabled();
  await page.evaluate(async () => {
    const path = "/src/stores/connections.ts";
    const { useConnections } = await import(/* @vite-ignore */ path);
    useConnections.setState((state: { connections: Array<Record<string, unknown>> }) => ({
      connections: state.connections.map((connection) => connection.id === "mock" ? { ...connection, name: "Changed target", server: "other", authentication: { kind: "sql", userName: "other-user" } } : connection),
    }));
    const target = window as unknown as TestWindow;
    const invoke = target.__TAURI_INTERNALS__.invoke;
    target.__TAURI_INTERNALS__.invoke = (command, args) => {
      if (command === "query_databases") return Promise.resolve([{ name: "OriginalDb" }]);
      if (command === "explorer_databases") return Promise.resolve([{ name: "WrongDb" }]);
      return invoke(command, args);
    };
  });
  const tab = page.getByRole("tab", { name: /^Query 1 /, selected: true });
  await expect.soft(tab).toContainText("Mock server");
  await expect.soft(page.locator('footer span[title="sa"]')).toBeVisible();
  await expect.soft(page.locator('footer span[title="other-user"]')).toHaveCount(0);
  await page.getByLabel("Current database", { exact: true }).click();
  await expect(page.getByRole("option", { name: "OriginalDb", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "WrongDb", exact: true })).toHaveCount(0);
});

test("a late database list from another tab cannot replace the current list", async ({ page }) => {
  await page.goto("/?mock");
  await page.getByRole("button", { name: "New query on Mock server", exact: true }).click();
  await expect(page.getByLabel("Current database", { exact: true })).toBeEnabled();
  await page.evaluate(() => {
    const target = window as unknown as TestWindow;
    target.pendingDatabases = [];
    const invoke = target.__TAURI_INTERNALS__.invoke;
    target.__TAURI_INTERNALS__.invoke = (command, args) => ["query_databases", "explorer_databases"].includes(command)
      ? new Promise((resolve, reject) => { target.pendingDatabases.push({ resolve, reject }); })
      : invoke(command, args);
  });
  await page.getByLabel("Current database", { exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as TestWindow).pendingDatabases.length)).toBe(1);
  await page.keyboard.press("Escape");
  await page.evaluate(async () => {
    const path = "/src/stores/queries.ts";
    const { useQueries } = await import(/* @vite-ignore */ path);
    await useQueries.getState().open("mock", "Sales");
  });
  await page.getByLabel("Current database", { exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as TestWindow).pendingDatabases.length)).toBe(2);
  await page.evaluate(() => (window as unknown as TestWindow).pendingDatabases[1].resolve([{ name: "CurrentDb" }]));
  await expect(page.getByRole("option", { name: "CurrentDb", exact: true })).toBeVisible();
  await page.evaluate(() => (window as unknown as TestWindow).pendingDatabases[0].resolve([{ name: "StaleDb" }]));
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(page.getByRole("option", { name: "CurrentDb", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "StaleDb", exact: true })).toHaveCount(0);
});
