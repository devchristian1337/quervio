import { test, expect, type Page } from "@playwright/test";

type CopyRange = { columns: number[]; rows: number[] };
type IpcWindow = Window & {
  __TAURI_INTERNALS__: { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> };
  copiedRange: CopyRange | null;
};

async function seedServer(page: Page) {
  await page.goto("/?mock");
  await page.getByRole("button", { name: "New connection", exact: true }).first().waitFor();
  await page.evaluate(async () => {
    const path = "/src/stores/connections.ts";
    const { useConnections } = await import(/* @vite-ignore */ path);
    await useConnections.getState().setGroup(["mock"], "Madonnina");
    const connection = useConnections.getState().connections[0];
    useConnections.setState({ connections: [{ ...connection, name: "Madonnina [APP SERVER]", group: "Madonnina" }] });
  });
  await page.getByRole("treeitem", { name: "Madonnina (1)", exact: true }).dblclick();
}

test("the environment stays fully visible beside a long server name", async ({ page }) => {
  await seedServer(page);
  const row = page.getByRole("treeitem", { name: "Madonnina [APP SERVER] Production", exact: true });
  const environment = row.getByText("Production", { exact: true });
  const tree = page.getByRole("tree");
  for (const width of [240, 300, 370]) {
    const divider = await page.getByRole("separator").first().boundingBox();
    await page.mouse.move(divider!.x + divider!.width / 2, divider!.y + divider!.height / 2);
    await page.mouse.down();
    await page.mouse.move(width, divider!.y + divider!.height / 2, { steps: 5 });
    await page.mouse.up();
    const rowBox = await row.boundingBox();
    const envBox = await environment.boundingBox();
    expect(envBox!.x + envBox!.width).toBeLessThanOrEqual(rowBox!.x + rowBox!.width);
    expect(await tree.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `target/ui-test-results/server-environment-${width}.png` });
  }
});

test("deleting the last server preserves its group", async ({ page }) => {
  await seedServer(page);
  await page.getByRole("treeitem", { name: "Madonnina [APP SERVER] Production", exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete connection", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete connection", exact: true }).click();
  const group = page.getByRole("treeitem", { name: "Madonnina (0)", exact: true });
  await expect(group).toBeVisible();
  await page.evaluate(async () => {
    const path = "/src/stores/connections.ts";
    const { useConnections } = await import(/* @vite-ignore */ path);
    await useConnections.getState().load();
  });
  await expect(group).toBeVisible();
  await expect(page.getByRole("tree").getByText("No saved connections yet.", { exact: true })).toHaveCount(0);
  await group.click({ button: "right" });
  await page.getByRole("menuitem", { name: "New connection in Madonnina…", exact: true }).click();
  await expect(page.getByLabel("Group", { exact: true })).toHaveValue("Madonnina");
});

test("sort arrows preserve selection while header labels still select columns", async ({ page }) => {
  await page.goto("/?mock");
  await page.getByRole("button", { name: "New query", exact: true }).last().click();
  await page.locator(".monaco-editor").click({ position: { x: 80, y: 12 } });
  await page.keyboard.insertText("SELECT 1;");
  await page.getByRole("button", { name: "Execute", exact: true }).click();
  const grid = page.getByTestId("data-grid-canvas");
  await expect(grid).toBeVisible();
  await page.evaluate(() => {
    const target = window as unknown as IpcWindow;
    const internal = target.__TAURI_INTERNALS__;
    const invoke = internal.invoke;
    internal.invoke = (command, args) => {
      if (command === "result_copy") target.copiedRange = { columns: args.columns as number[], rows: args.rows as number[] };
      return invoke(command, args);
    };
  });
  async function copiedRange() {
    await page.evaluate(() => { (window as unknown as IpcWindow).copiedRange = null; });
    await page.keyboard.press("ControlOrMeta+c");
    await expect.poll(() => page.evaluate(() => (window as unknown as IpcWindow).copiedRange)).not.toBeNull();
    return page.evaluate(() => (window as unknown as IpcWindow).copiedRange);
  }
  // Fixed mock dataset, default density and bundled font: Id is at x=50..120,
  // Name at x=120..234. Footer assertions also verify the arrow was hit.
  await grid.click({ position: { x: 300, y: 50 }, force: true });
  expect(await copiedRange()).toEqual({ columns: [2, 3], rows: [0, 1] });
  for (const direction of ["↑", "↓", null]) {
    await grid.click({ position: { x: 220, y: 18 }, force: true });
    if (direction) await expect(page.getByText("Sorted by", { exact: false })).toContainText(`Name${direction}`);
    else await expect(page.getByText("Sorted by", { exact: false })).toHaveCount(0);
    expect(await copiedRange()).toEqual({ columns: [2, 3], rows: [0, 1] });
  }
  await grid.click({ position: { x: 160, y: 18 }, force: true });
  expect(await copiedRange()).toEqual({ columns: [1, 2], rows: [0, 1_000_000] });
  await grid.click({ position: { x: 62, y: 18 }, force: true });
  await expect(page.getByText("Sorted by", { exact: false })).toContainText("Id↑");
  expect(await copiedRange()).toEqual({ columns: [1, 2], rows: [0, 1_000_000] });
  await grid.click({ position: { x: 300, y: 18 }, modifiers: ["Shift"], force: true });
  expect(await copiedRange()).toEqual({ columns: [1, 3], rows: [0, 1_000_000] });
  await page.screenshot({ path: "target/ui-test-results/sort-selection.png" });
});
