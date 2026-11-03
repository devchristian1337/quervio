import { test, expect, type Page } from "@playwright/test";

async function openPalette(page: Page) {
  await page.keyboard.press("Control+Shift+P");
  const dialog = page.getByRole("dialog", { name: "Search commands", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "Search commands", exact: true })).toBeFocused();
  return dialog;
}

test.beforeEach(async ({ page }) => {
  // A cold Vite start can spend time compiling modules and loading Monaco's
  // assets. Wait for the app itself, rather than every page load resource.
  test.setTimeout(60000);
  await page.goto("/?mock", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "Search commands", exact: true })).toBeVisible({ timeout: 30000 });
});

test("searches real tools and opens the selected result with Enter", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const warnings: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") warnings.push(message.text()); });
  const dialog = await openPalette(page);
  await dialog.getByRole("combobox").fill("Templates");
  await expect(dialog.getByRole("option", { name: "Templates / Snippets", exact: true })).toHaveAttribute("data-selected", "true");
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("heading", { name: "Templates / Snippets", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  expect(warnings).toEqual([]);
});

test("clears a search from the keyboard and hands focus to Settings after selection", async ({ page }) => {
  await page.getByRole("button", { name: "Search commands", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Search commands", exact: true });
  const search = dialog.getByRole("combobox");
  await search.fill("zz-no-such-command");
  await expect(dialog).toContainText("No matching commands, tabs or connections.");
  await search.fill("settings");
  const clear = dialog.getByRole("button", { name: "Clear command search", exact: true });
  await clear.focus();
  await clear.press("Enter");
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();
  await expect(dialog).toBeVisible();
  await search.fill("settings");
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(settings).toBeVisible();
  await expect.poll(() => settings.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  // A different modal keeps ownership of the keyboard.
  await page.keyboard.press("Control+Shift+P");
  await expect(dialog).toBeHidden();
  await expect(settings).toBeVisible();
});

test("does not execute SQL behind the palette and restores editor focus on Escape", async ({ page }) => {
  await page.getByRole("button", { name: "New query on Mock server", exact: true }).click();
  const editor = page.locator(".monaco-editor");
  await editor.click({ position: { x: 80, y: 12 } });
  await page.keyboard.insertText("SELECT 1;");
  await page.evaluate(() => {
    const internal = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const invoke = internal.invoke;
    document.body.dataset.executions = "0";
    internal.invoke = (command, args) => {
      if (command === "query_execute") document.body.dataset.executions = String(Number(document.body.dataset.executions) + 1);
      return invoke(command, args);
    };
  });
  const dialog = await openPalette(page);
  await page.keyboard.press("F5");
  await page.keyboard.press("Control+E");
  await expect(dialog).toBeVisible();
  await expect(page.locator("body")).toHaveAttribute("data-executions", "0");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect.poll(() => editor.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Control+K");
  await page.keyboard.press("Control+C");
  await expect(editor.locator(".view-lines")).toContainText("-- SELECT 1;");
});

test("opens a query on a searched saved connection and returns to an existing query tab", async ({ page }) => {
  let dialog = await openPalette(page);
  await dialog.getByRole("combobox").fill("Mock server");
  await dialog.getByRole("option", { name: "Mock server Default database", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("tab", { name: /Query 1/ })).toBeVisible();
  await page.locator(".monaco-editor").click({ position: { x: 80, y: 12 } });
  await page.keyboard.insertText("SELECT 1;");
  await page.keyboard.press("Control+N");
  await expect(page.getByRole("tab", { name: /Query 2/ })).toBeVisible();
  dialog = await openPalette(page);
  await dialog.getByRole("combobox").fill("Query 1");
  await dialog.getByRole("option", { name: /Query 1/ }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("SELECT 1;");
  await expect.poll(() => page.locator(".monaco-editor").evaluate((element) => element.contains(document.activeElement))).toBe(true);
});

test("uses the configured shortcut and fits desktop themes and window sizes", async ({ page }) => {
  await page.evaluate(async () => {
    const path = "/src/stores/settings.ts";
    const { useSettings } = await import(/* @vite-ignore */ path);
    useSettings.getState().setShortcut("commandPalette", ["Ctrl+Alt+P"]);
  });
  await expect(page.getByRole("button", { name: "Search commands", exact: true })).toContainText("Ctrl+Alt+P");
  await page.keyboard.press("Control+Shift+P");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  for (const [theme, width] of [["light", 1440], ["dark", 1000]] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width, height: 700 });
    await page.keyboard.press("Control+Alt+P");
    const dialog = page.getByRole("dialog", { name: "Search commands", exact: true });
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(700);
    await page.screenshot({ path: `target/ui-test-results/command-palette-${theme}.png`, animations: "disabled" });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  }
});
