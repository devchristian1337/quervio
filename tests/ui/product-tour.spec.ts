import { test, expect, type Page } from "@playwright/test";

test.use({ storageState: { cookies: [], origins: [] } });

async function firstLaunch(page: Page) {
  await page.goto("/?mock", { waitUntil: "domcontentloaded" });
  const tour = page.getByRole("dialog", { name: "Welcome to Quervio", exact: true });
  await expect(tour).toBeVisible({ timeout: 30000 });
  await expect(tour.getByRole("button", { name: "Next", exact: true })).toBeFocused();
  return page.locator("[data-product-tour]");
}

test("introduces real controls, traps focus and stays dismissed after completion", async ({ page }) => {
  test.setTimeout(60000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const tour = await firstLaunch(page);
  await page.keyboard.press("Tab");
  await expect(tour.getByRole("button", { name: "Close tour" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(tour.getByRole("button", { name: "Next", exact: true })).toBeFocused();
  await page.keyboard.press("Control+Shift+P");
  await page.keyboard.press("Control+N");
  await page.keyboard.press("Control+O");
  await page.keyboard.press("F5");
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(page.locator(".monaco-editor")).toHaveCount(0);

  const targets = ["new-connection", "explorer", "query-area", "command-search", "tools", "settings"];
  for (const target of targets) {
    await page.keyboard.press("ArrowRight");
    await expect(tour.locator("[role=status]")).toContainText(`Step ${targets.indexOf(target) + 2} of 7`);
    const selector = target === "explorer" ? "[data-explorer]" : `[data-tour="${target}"]`;
    const bounds = await page.locator(selector).boundingBox();
    const spot = tour.locator("[data-tour-spotlight]");
    await expect(spot).toBeVisible();
    await expect.poll(async () => Math.abs((await spot.boundingBox())!.x - (bounds!.x - 8))).toBeLessThan(2);
  }
  // Enter on Back must go back, rather than triggering Next globally.
  await tour.getByRole("button", { name: "Back", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(tour).toHaveAccessibleName("Your management tools");
  await page.keyboard.press("ArrowRight");
  await tour.getByRole("button", { name: "Done", exact: true }).click();
  await expect(tour).toBeHidden();
  await expect(page.locator('[data-tour="new-connection"]')).toBeFocused();
  expect(await page.evaluate(() => localStorage.getItem("quervio.tour.seen"))).toBe("1");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "Search commands", exact: true })).toBeVisible();
  await expect(tour).toHaveCount(0);
  await page.getByRole("button", { name: "Search commands", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Search commands", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

for (const dismissal of ["Escape", "Close"] as const) {
  test(`${dismissal} dismisses the tour permanently and restores workspace input`, async ({ page }) => {
    const tour = await firstLaunch(page);
    if (dismissal === "Escape") await page.keyboard.press("Escape");
    else await tour.getByRole("button", { name: "Close tour" }).click();
    await expect(tour).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem("quervio.tour.seen"))).toBe("1");
    await page.keyboard.press("Control+Shift+P");
    await expect(page.getByRole("dialog", { name: "Search commands", exact: true })).toBeVisible();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-tour="settings"]')).toBeVisible();
    await expect(tour).toHaveCount(0);
  });
}

test("fits light and dark themes, resized windows and reduced motion with no connections", async ({ page }) => {
  // Motion reads the accessibility preference when the component mounts.
  await page.emulateMedia({ reducedMotion: "reduce" });
  const tour = await firstLaunch(page);
  await page.evaluate(async () => {
    const path = "/src/stores/connections.ts";
    const { useConnections } = await import(/* @vite-ignore */ path);
    useConnections.setState({ connections: [], groups: [] });
  });
  for (const [theme, width, height] of [["light", 1440, 900], ["dark", 1000, 700], ["light", 760, 540]] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width, height });
    for (let index = 0; index < 7; index++) {
      const card = tour.locator("[data-tour-card]");
      await expect(card).toBeVisible();
      await expect.poll(async () => {
        const box = (await card.boundingBox())!;
        return box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height;
      }).toBe(true);
      if (index === 2 || index === 6) {
        const target = page.locator(index === 2 ? "[data-explorer]" : '[data-tour="settings"]');
        const bounds = (await target.boundingBox())!;
        await expect.poll(async () => {
          const spot = (await tour.locator("[data-tour-spotlight]").boundingBox())!;
          return Math.max(Math.abs(spot.x - bounds.x + 8), Math.abs(spot.y - bounds.y + 8), Math.abs(spot.width - bounds.width - 16), Math.abs(spot.height - bounds.height - 16));
        }).toBeLessThan(1);
      }
      if (index === 0 || index === 2 || index === 6) {
        await page.screenshot({ path: `target/ui-test-results/tour-${theme}-${width}-step-${index}.png`, animations: "disabled" });
      }
      if (index < 6) await page.keyboard.press("ArrowRight");
    }
    // Return to the first step without changing persisted onboarding state.
    for (let index = 0; index < 6; index++) await page.keyboard.press("ArrowLeft");
  }
  await page.keyboard.press("Escape");
});

test("centers a missing target and can close when local storage is unavailable", async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new Error("Storage blocked"); };
    Storage.prototype.setItem = () => { throw new Error("Storage blocked"); };
  });
  const tour = await firstLaunch(page);
  await page.locator('[data-tour="new-connection"]').evaluate((element) => element.removeAttribute("data-tour"));
  await page.keyboard.press("ArrowRight");
  await expect(tour).toHaveAccessibleName("Add your first SQL Server");
  await expect(tour.locator("[data-tour-spotlight]")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(tour).toBeHidden();
});
