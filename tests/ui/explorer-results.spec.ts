import { test, expect, type Page } from "@playwright/test";

type CopyRange = { columns: [number, number][]; rows: [number, number][] };
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
  await page.getByRole("button", { name: "New query on Mock server", exact: true }).click();
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
      if (command === "result_copy") target.copiedRange = { columns: args.columns as [number, number][], rows: args.rows as [number, number][] };
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
  expect(await copiedRange()).toEqual({ columns: [[2, 3]], rows: [[0, 1]] });
  for (const direction of ["↑", "↓", null]) {
    await grid.click({ position: { x: 220, y: 18 }, force: true });
    if (direction) await expect(page.getByText("Sorted by", { exact: false })).toContainText(`Name${direction}`);
    else await expect(page.getByText("Sorted by", { exact: false })).toHaveCount(0);
    expect(await copiedRange()).toEqual({ columns: [[2, 3]], rows: [[0, 1]] });
  }
  await grid.click({ position: { x: 160, y: 18 }, force: true });
  expect(await copiedRange()).toEqual({ columns: [[1, 2]], rows: [[0, 1_000_000]] });
  await grid.click({ position: { x: 62, y: 18 }, force: true });
  await expect(page.getByText("Sorted by", { exact: false })).toContainText("Id↑");
  expect(await copiedRange()).toEqual({ columns: [[1, 2]], rows: [[0, 1_000_000]] });
  await grid.click({ position: { x: 300, y: 18 }, modifiers: ["Shift"], force: true });
  expect(await copiedRange()).toEqual({ columns: [[1, 3]], rows: [[0, 1_000_000]] });
  await page.screenshot({ path: "target/ui-test-results/sort-selection.png" });
});

test("copy preserves gaps in Ctrl-click row and column selections", async ({ page }) => {
  await page.goto("/?mock");
  await page.getByRole("button", { name: "New query on Mock server", exact: true }).click();
  await page.locator(".monaco-editor").click({ position: { x: 80, y: 12 } });
  await page.keyboard.insertText("SELECT 1;");
  await page.getByRole("button", { name: "Execute", exact: true }).click();
  const grid = page.getByTestId("data-grid-canvas");
  await expect(grid).toBeVisible();
  await page.evaluate(() => {
    const target = window as unknown as IpcWindow;
    const invoke = target.__TAURI_INTERNALS__.invoke;
    target.__TAURI_INTERNALS__.invoke = (command, args) => {
      if (command === "result_copy") target.copiedRange = { columns: args.columns as [number, number][], rows: args.rows as [number, number][] };
      return invoke(command, args);
    };
  });
  async function copy(shortcut: string) {
    await page.evaluate(() => { (window as unknown as IpcWindow).copiedRange = null; });
    await page.keyboard.press(shortcut);
    await expect.poll(() => page.evaluate(() => (window as unknown as IpcWindow).copiedRange)).not.toBeNull();
    return page.evaluate(() => (window as unknown as IpcWindow).copiedRange);
  }

  await grid.click({ position: { x: 16, y: 50 }, force: true });
  await grid.click({ position: { x: 16, y: 114 }, modifiers: ["Control"], force: true });
  await expect(page.getByText("selected", { exact: true })).toBeVisible();
  for (const shortcut of ["ControlOrMeta+c", "ControlOrMeta+Shift+c", "ControlOrMeta+Shift+Alt+c"]) {
    expect(await copy(shortcut)).toEqual({ rows: [[0, 1], [2, 3]], columns: [[0, 4]] });
  }

  await page.keyboard.press("Escape");
  await grid.click({ position: { x: 90, y: 18 }, force: true });
  await grid.click({ position: { x: 300, y: 18 }, modifiers: ["Control"], force: true });
  expect(await copy("ControlOrMeta+c")).toEqual({ rows: [[0, 1_000_000]], columns: [[0, 1], [2, 3]] });
});

test("the top-left corner selects the whole result for explicit copy", async ({ page }) => {
  await page.goto("/?mock");
  await page.getByRole("button", { name: "New query on Mock server", exact: true }).click();
  await page.locator(".monaco-editor").click({ position: { x: 80, y: 12 } });
  await page.keyboard.insertText("SELECT 1;");
  await page.getByRole("button", { name: "Execute", exact: true }).click();
  const grid = page.getByTestId("data-grid-canvas");
  await expect(grid).toBeVisible();

  const copies: unknown[] = [];
  await page.exposeFunction("recordGridCopy", (args: unknown) => { copies.push(args); });
  await page.evaluate(() => {
    const target = window as unknown as IpcWindow & { recordGridCopy: (args: unknown) => Promise<void> };
    const internal = target.__TAURI_INTERNALS__;
    const invoke = internal.invoke;
    internal.invoke = (command, args) => {
      if (command === "result_copy") void target.recordGridCopy(args);
      return invoke(command, args);
    };
  });

  const selectAll = page.getByRole("checkbox", { name: "Select all result rows", exact: true });
  await expect(selectAll).not.toBeChecked();
  // The corner remains clickable outside the painted checkbox.
  await grid.click({ position: { x: 4, y: 18 }, force: true });
  await expect(selectAll).toBeChecked();
  await expect(page.getByText("selected", { exact: true })).toBeVisible();
  expect(copies).toHaveLength(0);

  await page.keyboard.press("ControlOrMeta+c");
  await expect.poll(() => copies).toMatchObject([
    { rows: [[0, 1_000_000]], columns: [[0, 4]], format: "text" },
  ]);
  await page.keyboard.press("ControlOrMeta+Shift+c");
  await expect.poll(() => copies).toMatchObject([
    { format: "text" },
    { rows: [[0, 1_000_000]], columns: [[0, 4]], format: "textWithHeaders" },
  ]);

  await page.keyboard.press("Escape");
  await expect(selectAll).not.toBeChecked();
  await selectAll.press("Space");
  await expect(selectAll).toBeChecked();
  await selectAll.press("Space");
  await expect(selectAll).not.toBeChecked();
});

test("find in results navigates to matches outside the visible rows", async ({ page }) => {
  await page.goto("/?mock");
  await page.getByRole("button", { name: "New query on Mock server", exact: true }).click();
  await page.locator(".monaco-editor").click({ position: { x: 80, y: 12 } });
  await page.keyboard.insertText("SELECT 1;");
  await page.getByRole("button", { name: "Execute", exact: true }).click();
  const grid = page.getByTestId("data-grid-canvas");
  await grid.click({ position: { x: 300, y: 50 }, force: true });
  await page.keyboard.press("ControlOrMeta+f");
  const search = page.getByRole("textbox", { name: "Find in results", exact: true });
  const clear = page.getByRole("button", { name: "Clear search", exact: true });
  await expect(search).toBeFocused();
  await expect(clear).toHaveCount(0);
  await search.fill("CUSTOMER 204");
  await search.press("Enter");
  const status = page.getByRole("search", { name: "Find in results" }).getByRole("status");
  await expect(status).toHaveText("Row 204, column 2");
  await search.press("Enter");
  await expect(status).toHaveText("Row 2040, column 2");
  await search.press("Shift+Enter");
  await expect(status).toHaveText("Row 204, column 2");
  const scroller = page.locator("[data-result-grid] .dvn-scroller");
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await clear.click();
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();
  await expect(status).toBeEmpty();
  await expect(clear).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
  await search.press("Escape");
  await expect(search).toHaveCount(0);
});

test("frozen leading columns stay selectable after horizontal scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 840, height: 900 });
  await page.goto("/?mock");
  await page.getByRole("button", { name: "New query on Mock server", exact: true }).click();
  await page.locator(".monaco-editor").click({ position: { x: 80, y: 12 } });
  await page.keyboard.insertText("SELECT 1;");
  await page.getByRole("button", { name: "Execute", exact: true }).click();
  const grid = page.getByTestId("data-grid-canvas");
  await grid.click({ button: "right", position: { x: 90, y: 18 }, force: true });
  await page.getByRole("menuitem", { name: "Freeze Columns Through Here", exact: true }).click();
  await page.evaluate(() => {
    const target = window as unknown as IpcWindow;
    const internal = target.__TAURI_INTERNALS__;
    const invoke = internal.invoke;
    internal.invoke = (command, args) => {
      if (command === "result_copy") target.copiedRange = { columns: args.columns as [number, number][], rows: args.rows as [number, number][] };
      return invoke(command, args);
    };
  });
  const scroller = page.locator("[data-result-grid] .dvn-scroller");
  await scroller.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  await expect.poll(() => scroller.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await grid.click({ position: { x: 90, y: 18 }, force: true });
  await page.keyboard.press("ControlOrMeta+c");
  await expect.poll(() => page.evaluate(() => (window as unknown as IpcWindow).copiedRange))
    .toEqual({ rows: [[0, 1_000_000]], columns: [[0, 1]] });
  await grid.click({ button: "right", position: { x: 90, y: 18 }, force: true });
  await page.getByRole("menuitem", { name: "Unfreeze Columns", exact: true }).click();
});
