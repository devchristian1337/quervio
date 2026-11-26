import { test, expect, type Page } from "@playwright/test";

type IpcWindow = Window & {
  __TAURI_INTERNALS__: {
    invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>;
  };
  ipcLog: Array<{ command: string; args: Record<string, unknown> }>;
};

async function gotoMock(page: Page) {
  await page.goto("/?mock", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "Tools", exact: true })).toBeVisible({ timeout: 30000 });
}

async function spyIpc(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as IpcWindow;
    const orig = w.__TAURI_INTERNALS__.invoke;
    w.ipcLog = [];
    w.__TAURI_INTERNALS__.invoke = (command, args) => {
      w.ipcLog.push({ command, args });
      return orig(command, args);
    };
  });
}

test("Destructive statement confirmation defaults focus to Cancel, reveals finding line, and gates execution", async ({ page }) => {
  await gotoMock(page);
  await page.getByRole("button", { name: "New query on Mock server", exact: true }).click();
  await spyIpc(page);

  const editor = page.locator(".monaco-editor");
  await editor.click({ position: { x: 80, y: 12 } });
  await page.keyboard.insertText("SELECT 1;\nDELETE FROM dbo.Customer;");
  await page.getByRole("button", { name: "Execute", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "Destructive statements on Production", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Line 2");
  await expect(dialog).toContainText("DELETE without WHERE");
  await expect(dialog).toContainText("dbo.Customer");

  // Safety requirement: Cancel MUST hold initial focus so Enter never runs destructive SQL accidentally.
  const cancelBtn = dialog.getByRole("button", { name: "Cancel", exact: true });
  await expect(cancelBtn).toBeFocused();
  await page.screenshot({ path: "target/ui-test-results/safety-destructive-dialog.png", animations: "disabled" });

  // Pressing Enter while Cancel is focused dismisses without executing.
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  const execAfterCancel = await page.evaluate(() =>
    (window as unknown as IpcWindow).ipcLog.filter((e) => e.command === "query_execute").length,
  );
  expect(execAfterCancel).toBe(0);

  // Executing again and clicking Run anyway submits the query.
  await page.getByRole("button", { name: "Execute", exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Run anyway", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() =>
    page.evaluate(() => (window as unknown as IpcWindow).ipcLog.filter((e) => e.command === "query_execute").length),
  ).toBe(1);
});

for (const choice of ["cancel", "rollback", "commit"] as const) {
  test(`Open transactions dialog handles ${choice} accurately on tab close`, async ({ page }) => {
    await gotoMock(page);
    await page.getByRole("button", { name: "New query on Mock server", exact: true }).click();
    await spyIpc(page);

    // Simulate an active transaction on the open tab.
    await page.evaluate(async () => {
      const path = "/src/stores/queries.ts";
      const { useQueries } = await import(/* @vite-ignore */ path);
      const id = useQueries.getState().activeId;
      useQueries.setState((s: { tabs: Array<Record<string, unknown>> }) => ({
        tabs: s.tabs.map((t) => (t.id === id ? { ...t, openTransactions: 2, dirty: false } : t)),
      }));
    });

    await expect(page.getByLabel("Open transaction", { exact: true })).toBeVisible();
    const tab = page.getByRole("tab", { selected: true }).filter({ hasText: "Query 1" });
    await tab.locator("..").getByRole("button", { name: "Close", exact: true }).click();

    const dialog = page.getByRole("dialog", { name: "Open transactions", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("2 open transactions");
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();

    if (choice === "cancel") {
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(tab).toBeVisible();
      const endCalls = await page.evaluate(() =>
        (window as unknown as IpcWindow).ipcLog.filter((e) => e.command === "query_end_transactions"),
      );
      expect(endCalls).toHaveLength(0);
    } else {
      const btnLabel = choice === "rollback" ? "Roll back" : "Commit";
      await dialog.getByRole("button", { name: btnLabel, exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(tab).toHaveCount(0);
      const endCalls = await page.evaluate(() =>
        (window as unknown as IpcWindow).ipcLog.filter((e) => e.command === "query_end_transactions"),
      );
      expect(endCalls).toHaveLength(1);
      expect(endCalls[0].args.commit).toBe(choice === "commit");
    }
  });
}

test("Unsaved changes dialog allows Cancel and Don't save without writing files", async ({ page }) => {
  await gotoMock(page);
  await page.getByRole("button", { name: "New query on Mock server", exact: true }).click();
  await spyIpc(page);

  await page.locator(".monaco-editor").click({ position: { x: 80, y: 12 } });
  await page.keyboard.insertText("SELECT 'unsaved';");
  const tab = page.getByRole("tab", { name: /^Query 1/, selected: true });
  await expect(tab).toContainText("*");

  await tab.locator("..").getByRole("button", { name: "Close", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /Save changes to Query 1\?/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();

  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(tab).toBeVisible();

  await tab.locator("..").getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Don't save", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(tab).toHaveCount(0);

  const writes = await page.evaluate(() =>
    (window as unknown as IpcWindow).ipcLog.filter((e) => e.command === "file_write"),
  );
  expect(writes).toHaveLength(0);
});
