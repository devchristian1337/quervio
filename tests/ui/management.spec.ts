import { test, expect, type Page } from "@playwright/test";

const TOOLS: Record<string, string> = {"activity": "Activity Monitor", "queryStore": "Query Store", "events": "Extended Events / Profiler", "table": "Table Designer", "view": "View Designer", "diagram": "Relationships", "backup": "Backup / Restore", "agent": "SQL Server Agent", "maintenance": "Maintenance", "transfer": "Import / Export / Scripts", "security": "Security / Audit", "encryption": "Encryption", "encryptedQuery": "Microsoft Query", "templates": "Templates / Snippets", "components": "Microsoft Components", "properties": "Object Properties"};
async function openTool(page: Page, tool: string) {
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByRole("menuitem", { name: TOOLS[tool], exact: true }).click();
  // master cannot use Query Store.
  if (tool === "queryStore") {
    await page.getByRole("combobox", { name: "Database", exact: true }).click();
    await page.getByRole("option", { name: "Sales", exact: true }).click();
  }
}
test.beforeEach(async ({ page }) => {
  await page.goto("/?mock");
  await expect(
    page.getByRole("button", { name: "Tools", exact: true }),
  ).toBeVisible();
});

test("SQLCMD include access is approved separately from script execution", async ({ page }) => {
  await page.getByRole("button", { name: "New query", exact: true }).last().click();
  // Monaco's EditContext exposes a zero-size accessibility textbox; click
  // the visible editor surface before sending normal keyboard input.
  await page.locator(".monaco-editor").click({ position: { x: 80, y: 12 } });
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(':r "include.sql"');
  await page.getByRole("checkbox", { name: "SQLCMD", exact: true }).check();
  await page.getByRole("button", { name: "Execute", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Allow SQLCMD include file access?", exact: true })).toBeVisible();
  await expect(dialog).toContainText("using your Windows identity");
  await expect(dialog.getByRole("button", { name: "Confirm and execute SQLCMD", exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole("button", { name: "Execute", exact: true }).click();
  await dialog.getByRole("button", { name: "Allow reading include files", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Review expanded SQLCMD script", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Confirm and execute SQLCMD", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
});

test("every management area opens without browser exceptions", async ({
  page,
}) => {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  const anchors: Record<
    string,
    readonly [Parameters<Page["getByRole"]>[0], string]
  > = {
    activity: ["tablist", "Activity"],
    queryStore: ["combobox", "Runtime interval"],
    events: ["textbox", "Session name"],
    table: ["textbox", "Table"],
    view: ["textbox", "View name"],
    diagram: ["button", "Export layout"],
    backup: ["tablist", "Operation"],
    agent: ["tablist", "Agent objects"],
    maintenance: ["textbox", "Agent job name"],
    transfer: ["tablist", "Transfer operation"],
    security: ["tablist", "Security objects"],
    encryption: ["tablist", "Encryption area"],
    encryptedQuery: ["textbox", "Microsoft SQL query"],
    templates: ["textbox", "Search templates"],
    components: ["button", "Select executable"],
    properties: ["combobox", "Database operation"],
  };
  for (const [tool, title] of Object.entries({
    activity: "Activity Monitor",
    queryStore: "Query Store",
    events: "Extended Events / Profiler",
    table: "Table Designer",
    view: "View Designer",
    diagram: "Relationships",
    backup: "Backup / Restore",
    agent: "SQL Server Agent",
    maintenance: "Maintenance",
    transfer: "Import / Export / Scripts",
    security: "Security / Audit",
    encryption: "Encryption",
    encryptedQuery: "Microsoft Query",
    templates: "Templates / Snippets",
    components: "Microsoft Components",
    properties: "Object Properties",
  })) {
    await openTool(page, tool);
    await expect(
      page.getByRole("heading", { level: 1, name: title, exact: true }),
    ).toBeVisible();
    await expect(
      page
        .getByRole(anchors[tool][0], { name: anchors[tool][1], exact: true })
        .first(),
    ).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page
      .getByRole("button", { name: `Close ${title}`, exact: true })
      .click();
  }
  expect(failures).toEqual([]);
});

test("designer draft survives switching tools and execution requires a preview", async ({
  page,
}) => {
  await openTool(page, "table");
  await page.getByLabel("Table", { exact: true }).fill("UiDraft");
  await page.getByLabel("Column 1 name", { exact: true }).fill("Id");
  await page.getByLabel("Column 1 type", { exact: true }).fill("int");
  await openTool(page, "activity");
  await expect(
    page.getByRole("heading", { name: "Activity Monitor", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Table Designer", exact: true })
    .click();
  await expect(page.getByLabel("Table", { exact: true })).toHaveValue(
    "UiDraft",
  );
  await page
    .getByRole("button", { name: "Preview CREATE TABLE", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Mock server");
  await expect(dialog.locator("pre")).toContainText(
    "CREATE TABLE [dbo].[UiDraft]",
  );
  await dialog
    .getByRole("button", { name: "Confirm and execute", exact: true })
    .click();
  await expect(
    dialog.getByRole("heading", { name: "Operation completed", exact: true }),
  ).toBeVisible();
  await expect(dialog).toContainText("no SQL was submitted");
});

test("designer rejects SQL fragments in type fields", async ({ page }) => {
  await openTool(page, "table");
  await page.getByLabel("Table", { exact: true }).fill("UiDraft");
  await page.getByLabel("Column 1 name", { exact: true }).fill("Id");
  await page
    .getByLabel("Column 1 type", { exact: true })
    .fill("int); DROP TABLE dbo.Other;--");
  await expect(page.getByRole("alert")).toContainText(
    "Unsupported editable SQL type",
  );
  await expect(
    page.getByRole("button", { name: "Preview CREATE TABLE", exact: true }),
  ).toBeDisabled();
});

test("inactive monitoring stops polling and preserves the selected view", async ({
  page,
}) => {
  await page.evaluate(() => {
    const internal = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (command: string, args: unknown) => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__;
    const original = internal.invoke;
    let count = 0;
    (
      window as unknown as { managementReadCount: () => number }
    ).managementReadCount = () => count;
    internal.invoke = (command, args) => {
      if (command === "management_read") count++;
      return original(command, args);
    };
  });
  await openTool(page, "activity");
  await page.getByRole("combobox", { name: "Refresh interval", exact: true }).click();
  await page.getByRole("option", { name: "Every second", exact: true }).click();
  await expect(
    page.getByText("SELECT Id, Name FROM dbo.Customer", { exact: true }),
  ).toBeVisible();
  await openTool(page, "templates");
  await expect(
    page.getByRole("heading", { level: 1, name: "Templates / Snippets" }),
  ).toBeVisible();
  const before = await page.evaluate(() =>
    (
      window as unknown as { managementReadCount: () => number }
    ).managementReadCount(),
  );
  await page.waitForTimeout(1600);
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { managementReadCount: () => number }
      ).managementReadCount(),
    ),
  ).toBe(before);
});

test("Query Store plans render as an operator graph", async ({ page }) => {
  await openTool(page, "queryStore");
  await page
    .getByText("SELECT Id, Name FROM dbo.Customer", { exact: true })
    .click();
  const plans = page
    .locator("table")
    .filter({
      has: page.getByRole("columnheader", { name: "plan id", exact: true }),
    });
  await expect(plans).toBeVisible();
  await plans.locator("tbody tr").first().click();
  await expect(
    page.getByRole("img", { name: "Execution plan operator tree" }),
  ).toBeVisible();
  await expect(
    page.getByText("Clustered Index Scan", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("img", { name: "Execution plan operator tree" })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: "target/ui-test-results/query-store.png" });
});

test("layout remains usable at the minimum desktop window width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await openTool(page, "maintenance");
  await expect(
    page.getByRole("heading", { level: 1, name: "Maintenance", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Agent job name", exact: true }),
  ).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
  await page.screenshot({ path: "target/ui-test-results/maintenance.png" });
});

test("import mapping is visual and included in the confirmed operation",async({page})=>{
  await openTool(page,"transfer");
  await page.getByRole("textbox",{name:"Local file path",exact:true}).fill("C:\\test\\customers.csv");
  await page.getByRole("textbox",{name:"SQL Server table",exact:true}).fill("Customer");
  await page.getByRole("button",{name:"Preview source rows",exact:true}).click();
  await expect(page.getByRole("cell",{name:"Rossi",exact:true})).toBeVisible();
  const destination=page.getByRole("textbox",{name:"Destination column for Name",exact:true});await expect(destination).toHaveValue("Name");await destination.fill("DisplayName");
  await page.getByRole("button",{name:"Import data",exact:true}).click();
  const dialog=page.getByRole("dialog");await expect(dialog).toContainText("Mock server");await expect(dialog.locator("pre")).toContainText("DisplayName");await dialog.getByRole("button",{name:"Cancel",exact:true}).click();
});
