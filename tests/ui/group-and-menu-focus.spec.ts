import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  test.setTimeout(60000);
  await page.goto("/?mock", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "Tools", exact: true })).toBeVisible({ timeout: 30000 });
});

test("Group uses themed suggestions, accepts new names and closes suggestions before the dialog", async ({ page }) => {
  await page.evaluate(async () => {
    const path = "/src/stores/connections.ts";
    const { useConnections } = await import(/* @vite-ignore */ path);
    useConnections.setState({ groups: ["Aurelia", "Camilliani", "Casino"] });
  });
  await page.getByRole("button", { name: "New connection", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "New connection", exact: true });
  const group = dialog.getByRole("combobox", { name: "Group", exact: true });
  await group.click();
  await expect(page.getByRole("option", { name: "Aurelia", exact: true })).toBeVisible();
  await expect(group).not.toHaveAttribute("list", /.+/);
  await group.fill("Cam");
  await expect(page.getByRole("option", { name: "Camilliani", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "Aurelia", exact: true })).toHaveCount(0);
  await group.press("ArrowDown");
  await group.press("Enter");
  await expect(group).toHaveValue("Camilliani");
  await expect(dialog).toBeVisible();
  await group.fill("A new group");
  await expect(group).toHaveValue("A new group");
  await group.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(group).toHaveAttribute("aria-expanded", "false");
  await group.fill("");
  await expect(group).toHaveValue("");
  await group.click();
  await expect(page.getByRole("option", { name: "Aurelia", exact: true })).toBeVisible();
  for (const theme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator("html")).toHaveClass(theme === "dark" ? /dark/ : /^(?!.*\bdark\b)/);
    await page.screenshot({ path: `target/ui-test-results/group-picker-${theme}.png`, animations: "disabled" });
  }
  await group.press("Escape");
  await expect(dialog).toBeVisible();
  await group.press("Escape");
  await expect(dialog).toBeHidden();
});

for (const name of ["Search commands", "Tools"]) {
  test(`${name}: Escape after a mouse opening returns to the editor without highlighting the trigger`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    const trigger = page.getByRole("button", { name, exact: true });
    await trigger.click();
    await expect(page.getByRole(name === "Tools" ? "menu" : "dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole(name === "Tools" ? "menu" : "dialog")).toBeHidden();
    await expect(trigger).not.toBeFocused();
    await expect.poll(() => trigger.evaluate((element) => element.closest("section") === document.activeElement)).toBe(true);

    await page.getByRole("button", { name: "New query on Mock server", exact: true }).click();
    const editor = page.locator(".monaco-editor");
    await editor.click({ position: { x: 80, y: 12 } });
    await trigger.click();
    await expect(page.getByRole(name === "Tools" ? "menu" : "dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole(name === "Tools" ? "menu" : "dialog")).toBeHidden();
    await expect(trigger).not.toBeFocused();
    await expect.poll(() => editor.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await page.screenshot({ path: `target/ui-test-results/mouse-escape-${name.toLowerCase().replaceAll(" ", "-")}.png`, animations: "disabled" });
  });

  test(`${name}: keyboard opening keeps a visible focus target after Escape`, async ({ page }) => {
    const trigger = page.getByRole("button", { name, exact: true });
    await trigger.focus();
    await trigger.press("Enter");
    await expect(page.getByRole(name === "Tools" ? "menu" : "dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole(name === "Tools" ? "menu" : "dialog")).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect.poll(() => trigger.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
  });
}
