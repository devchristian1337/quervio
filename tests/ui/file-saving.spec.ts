import { test, expect } from "@playwright/test";

type SavingWindow = Window & {
  __TAURI_INTERNALS__: { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> };
  savedText: string | null;
  finishWrite: () => void;
};

for (const closeAfterSave of [false, true]) {
  test(`${closeAfterSave ? "Close → Save keeps the tab open" : "Save keeps editing available"} when more text is typed`, async ({ page }) => {
    await page.goto("/?mock");
    await page.getByRole("button", { name: "New query on Mock server", exact: true }).click();
    const editor = page.locator(".monaco-editor");
    await editor.click({ position: { x: 80, y: 12 } });
    await page.keyboard.insertText("SELECT 1;");
    await page.evaluate(async () => {
      const path = "/src/stores/queries.ts";
      const { useQueries } = await import(/* @vite-ignore */ path);
      useQueries.getState().markSaved(useQueries.getState().activeId, "C:/scripts/edited.sql", true);
      const target = window as unknown as SavingWindow;
      const invoke = target.__TAURI_INTERNALS__.invoke;
      target.savedText = null;
      target.__TAURI_INTERNALS__.invoke = (command, args) => {
        if (command === "file_write") {
          target.savedText = args.text as string;
          return new Promise((resolve) => { target.finishWrite = () => resolve(null); });
        }
        return invoke(command, args);
      };
    });
    const tab = page.getByRole("tab").filter({ hasText: "edited.sql" });
    if (closeAfterSave) {
      await tab.getByRole("button", { name: "Close", exact: true }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
    } else {
      await page.keyboard.press("ControlOrMeta+s");
    }
    await expect.poll(() => page.evaluate(() => (window as unknown as SavingWindow).savedText)).toBe("SELECT 1;");

    await editor.click({ position: { x: 80, y: 12 } });
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.insertText("\nSELECT 2;");
    await expect(editor.locator(".view-lines")).toContainText("SELECT 2;");
    await page.evaluate(() => (window as unknown as SavingWindow).finishWrite());
    await expect(page.getByText("Saved edited.sql", { exact: true })).toBeVisible();
    await expect(tab).toBeVisible();
    await expect(tab).toContainText("*");
    await expect(editor.locator(".view-lines")).toContainText("SELECT 2;");
    if (closeAfterSave) await expect(page.getByText("Tab kept open", { exact: true })).toBeVisible();
  });
}
