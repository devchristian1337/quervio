import { test, expect, type Page } from "@playwright/test";

type IpcWindow = Window & {
  __TAURI_INTERNALS__: {
    invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>;
  };
  ipcCalls: Array<{ command: string; args: Record<string, unknown> }>;
};

async function gotoMock(page: Page) {
  await page.goto("/?mock", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "Tools", exact: true })).toBeVisible({ timeout: 30000 });
}

test("Settings Dialog covers Editor, Results, Shortcuts (GlowingKeyboard + Undo), About, and Reset all + Undo", async ({ page }) => {
  await gotoMock(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(settings).toBeVisible();

  // Editor section: Motion Quantity stepper + switches
  await settings.getByRole("button", { name: "Editor", exact: true }).click();
  const fontSizeGroup = settings.getByRole("group", { name: "Font size", exact: true });
  const fontInput = fontSizeGroup.getByRole("textbox", { name: "Font size", exact: true });
  const initialFont = Number(await fontInput.inputValue());
  await fontSizeGroup.getByRole("button", { name: "Increase", exact: true }).click();
  await expect(fontInput).toHaveValue(String(initialFont + 1));
  await fontSizeGroup.getByRole("button", { name: "Decrease", exact: true }).click();
  await expect(fontInput).toHaveValue(String(initialFont));

  const wordWrapSwitch = settings.getByRole("switch").first();
  const initialChecked = await wordWrapSwitch.getAttribute("aria-checked");
  await wordWrapSwitch.click();
  await expect(wordWrapSwitch).toHaveAttribute("aria-checked", initialChecked === "true" ? "false" : "true");

  // Results section: density & monospace switch
  await settings.getByRole("button", { name: "Results", exact: true }).click();
  await settings.getByRole("combobox").first().click();
  await page.getByRole("option", { name: "Compact", exact: true }).click();
  await expect(settings.getByRole("combobox").first()).toContainText("Compact");

  // Shortcuts section: GlowingKeyboard highlights keys on hover & reset + Undo works
  await settings.getByRole("button", { name: "Shortcuts", exact: true }).click();
  await settings.getByText("Execute", { exact: true }).first().hover();
  await expect(settings.locator(".glowing-key")).toHaveCount(1);
  await page.screenshot({ path: "target/ui-test-results/settings-shortcuts-glow.png", animations: "disabled" });

  // About section: version, data dir, licenses
  await settings.getByRole("button", { name: "About", exact: true }).click();
  await expect(settings).toContainText("0.1.0-mock");
  await expect(settings).toContainText("com.quervio.app");

  // Reset all settings + Undo toast restores customized setting without closing dialog
  await settings.getByRole("button", { name: "Reset all settings", exact: true }).click();
  await expect(page.getByText("Settings reset to their defaults", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "Results", exact: true }).click();
  await expect(settings.getByRole("combobox").first()).toContainText("Compact");
});

test("Monaco shortcuts (Ctrl+R, Shift+Alt+F, Ctrl+K Ctrl+C/U, selection execute) and long-running cancel animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await gotoMock(page);
  await page.getByRole("button", { name: "New query on Mock server", exact: true }).click();

  await page.evaluate(() => {
    const w = window as unknown as IpcWindow;
    const orig = w.__TAURI_INTERNALS__.invoke;
    w.ipcCalls = [];
    w.__TAURI_INTERNALS__.invoke = (command, args) => {
      w.ipcCalls.push({ command, args });
      if (command === "query_execute" && String(args.script).includes("WAITFOR")) {
        return new Promise((resolve) => {
          setTimeout(() => resolve("cancelled"), 1500);
        });
      }
      return orig(command, args);
    };
  });

  const editor = page.locator(".monaco-editor");
  await editor.click({ position: { x: 80, y: 12 } });
  await page.keyboard.insertText("SELECT 1;");

  // Comment & uncomment chords
  await page.keyboard.press("Control+K");
  await page.keyboard.press("Control+C");
  await expect(editor.locator(".view-lines")).toContainText("-- SELECT 1;");
  await page.keyboard.press("Control+K");
  await page.keyboard.press("Control+U");
  await expect(editor.locator(".view-lines")).toContainText("SELECT 1;");
  await expect(editor.locator(".view-lines")).not.toContainText("-- SELECT 1;");

  // Format document invokes format_sql
  await page.keyboard.press("Shift+Alt+F");
  await expect.poll(() =>
    page.evaluate(() => (window as unknown as IpcWindow).ipcCalls.some((c) => c.command === "format_sql")),
  ).toBe(true);

  // Toggle results panel with Ctrl+R
  const outputTabs = page.getByRole("tablist", { name: "Output", exact: true });
  await expect(outputTabs).toBeVisible();
  await page.keyboard.press("Control+R");
  await expect(outputTabs).toHaveCount(0);
  await page.keyboard.press("Control+R");
  await expect(outputTabs).toBeVisible();

  // Long running execution shows LoaderGooeyBlobs and enables Cancel button
  await editor.click({ position: { x: 80, y: 12 } });
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText("WAITFOR DELAY '00:00:05';");
  await page.getByRole("button", { name: "Execute", exact: true }).click();
  const cancelBtn = page.getByRole("button", { name: "Cancel", exact: true });
  await expect(cancelBtn).toBeEnabled({ timeout: 3000 });
  await expect(page.getByRole("status", { name: "Executing query", exact: true })).toBeVisible();
  await cancelBtn.click();
  await expect.poll(() =>
    page.evaluate(() => (window as unknown as IpcWindow).ipcCalls.some((c) => c.command === "query_cancel")),
  ).toBe(true);
});

test("Object Explorer keyboard navigation, scripting context menu, and SSMS Import Dialog workflow", async ({ page }) => {
  await gotoMock(page);

  // Keyboard navigation in Object Explorer tree
  const tree = page.getByRole("tree");
  const mockServer = page.getByRole("treeitem", { name: /^Mock server/ });
  await mockServer.click();
  await tree.press("ArrowRight");
  await expect(page.getByRole("treeitem", { name: "Databases", exact: true })).toBeVisible();
  await tree.press("ArrowDown");
  await tree.press("ArrowRight");
  await expect(page.getByRole("treeitem", { name: "Sales", exact: true })).toBeVisible();

  // Expand Sales -> Tables -> Customer and script Select Top 1000 Rows
  await page.getByRole("treeitem", { name: "Sales", exact: true }).dblclick();
  await page.getByRole("treeitem", { name: /^Tables/ }).dblclick();
  const customer = page.getByRole("treeitem", { name: /Customer/ });
  await expect(customer).toBeVisible();
  await customer.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Script as CREATE", exact: true }).click();
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("CREATE TABLE");

  // SSMS Import Dialog: discover registered groups, pick environment, import
  await page.getByRole("button", { name: "Import from SSMS", exact: true }).first().click();
  const importDialog = page.getByRole("dialog", { name: "Import from SSMS", exact: true });
  await expect(importDialog).toBeVisible();
  await expect(importDialog).toContainText("Camilliani");
  await expect(importDialog).toContainText("Recent connections");
  await page.screenshot({ path: "target/ui-test-results/ssms-import-dialog.png", animations: "disabled" });
  const importBtn = importDialog.getByRole("button", { name: /^Import \d+/ });
  await expect(importBtn).toBeEnabled();
  await importBtn.click();
  await expect(importDialog).toBeHidden();
  await expect(page.getByText(/Imported \d+ connection/)).toBeVisible();
});

test("Glide Data Grid context menu exports (CSV/XLSX/Markdown) and handles export failures gracefully", async ({ page }) => {
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
    w.ipcCalls = [];
    w.__TAURI_INTERNALS__.invoke = (command, args) => {
      w.ipcCalls.push({ command, args });
      if (command === "plugin:dialog|save") return Promise.resolve("C:/temp/export-test.csv");
      if (command === "result_export_file" && args.format === "csv") {
        return Promise.reject("CSV rejects formula-like text");
      }
      if (command === "result_export_file" && args.format === "xlsx") return Promise.resolve(null);
      if (command === "result_export_markdown") return Promise.resolve(null);
      return orig(command, args);
    };
  });

  // CSV export error surfaces an explicit error toast
  await grid.click({ button: "right", position: { x: 160, y: 50 }, force: true });
  await page.getByRole("menuitem", { name: /Save as CSV/i }).click();
  await expect(page.getByText("Export failed", { exact: true })).toBeVisible();
  await expect(page.getByText("CSV rejects formula-like text", { exact: true })).toBeVisible();

  // XLSX export succeeds and shows confirmation toast
  await grid.click({ button: "right", position: { x: 160, y: 50 }, force: true });
  await page.getByRole("menuitem", { name: /Save as Excel/i }).click();
  await expect(page.getByText(/Saved .* as XLSX/)).toBeVisible();

  // Markdown export succeeds
  await grid.click({ button: "right", position: { x: 160, y: 50 }, force: true });
  await page.getByRole("menuitem", { name: /Save as Markdown/i }).click();
  await expect(page.getByText(/Saved .* as Markdown/)).toBeVisible();
});
