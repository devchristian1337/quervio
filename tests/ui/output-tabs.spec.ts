import { test, expect, type Locator } from "@playwright/test";

async function horizontalAlignment(decoration: Locator, tab: Locator) {
  const decorationBox = await decoration.boundingBox();
  const tabBox = await tab.boundingBox();
  if (!decorationBox || !tabBox) return Number.POSITIVE_INFINITY;
  return Math.max(
    Math.abs(decorationBox.x - tabBox.x),
    Math.abs(decorationBox.x + decorationBox.width - tabBox.x - tabBox.width),
  );
}

test("output underline and hover highlight align with their tabs", async ({ page }) => {
  await page.goto("/?mock", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "New query on Mock server", exact: true }).click();
  const tabs = page.getByRole("tablist", { name: "Output", exact: true });
  const bar = tabs.locator("..");
  const hover = bar.locator(":scope > div").nth(0);
  const underline = bar.locator(":scope > div").nth(1);

  for (const name of ["Results", "Messages", "Plans"]) {
    const tab = tabs.getByRole("tab", { name, exact: true });
    await tab.hover();
    await expect.soft.poll(() => horizontalAlignment(hover, tab), { timeout: 1500 }).toBeLessThanOrEqual(1);
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect.soft.poll(() => horizontalAlignment(underline, tab), { timeout: 1500 }).toBeLessThanOrEqual(1);
  }
  await page.screenshot({ path: "target/ui-test-results/output-tabs.png" });
});
