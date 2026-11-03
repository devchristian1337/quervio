import { test, expect } from "@playwright/test";

for (const trigger of ["F5", "Control+E", "toolbar"] as const) {
  test(`execution closes IntelliSense without accepting a suggestion (${trigger})`, async ({ page }) => {
    await page.goto("/?mock");
    await page.getByRole("button", { name: "New query on Mock server", exact: true }).click();
    await page.locator(".monaco-editor").click({ position: { x: 80, y: 12 } });
    await page.keyboard.insertText("SELECT TOP 10 * FROM Customer");
    await page.keyboard.press("Control+Space");
    const suggestions = page.locator(".suggest-widget.visible");
    await expect(suggestions).toBeVisible();
    await expect(suggestions).toContainText("dbo.Customer");

    // Observe the real execution boundary as well as the widget: executing
    // must neither accept the highlighted completion nor change the script.
    await page.evaluate(() => {
      const internal = (window as unknown as {
        __TAURI_INTERNALS__: { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> };
      }).__TAURI_INTERNALS__;
      const original = internal.invoke;
      internal.invoke = (command, args) => {
        if (command === "query_execute") {
          document.body.dataset.executedScript = String(args.script);
          document.body.dataset.suggestionsAtExecution = String(Boolean(document.querySelector(".suggest-widget.visible")));
        }
        return original(command, args);
      };
    });
    if (trigger === "toolbar") await page.getByRole("button", { name: "Execute", exact: true }).click();
    else await page.keyboard.press(trigger);

    await expect(page.locator("body")).toHaveAttribute("data-executed-script", "SELECT TOP 10 * FROM Customer");
    await expect(suggestions).toBeHidden();
    await expect(page.locator("body")).toHaveAttribute("data-suggestions-at-execution", "false");
    // Still dismissed when the completed execution redraws the results.
    await expect(page.getByRole("tab", { name: "Results", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(suggestions).toBeHidden();
  });
}
