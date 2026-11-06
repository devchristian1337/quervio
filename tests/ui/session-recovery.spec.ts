import { test, expect } from "@playwright/test";

test("warns on autosave failure and retries without losing editor text", async ({ page }) => {
  test.setTimeout(60000);
  await page.goto("/?mock", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "New query on Mock server", exact: true }).click();
  await page.evaluate(() => {
    const internal = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const invoke = internal.invoke;
    document.body.dataset.saveFails = "true";
    internal.invoke = (command, args) => {
      if (command === "tabs_save" && document.body.dataset.saveFails === "true") return Promise.reject("disk full");
      return invoke(command, args);
    };
  });
  const editor = page.locator(".monaco-editor");
  await editor.click({ position: { x: 80, y: 12 } });
  await page.keyboard.insertText("SELECT N'recover this SQL';");
  await expect(page.getByText("Query tabs could not be saved", { exact: true })).toBeVisible();
  await expect(editor.locator(".view-lines")).toContainText("recover this SQL");
  await page.evaluate(() => { document.body.dataset.saveFails = "false"; });
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByText("Query tab recovery is available again", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("quervio.mock.tabs")!).tabs[0].text))
    .toContain("recover this SQL");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("recover this SQL");
});
