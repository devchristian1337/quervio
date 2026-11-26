import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { THEMES } from "../../src/lib/themes";

async function gotoMock(page: Page) {
  await page.goto("/?mock", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "Tools", exact: true })).toBeVisible({ timeout: 30000 });
}

async function waitForSettledAnimations(page: Page) {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const finite = document.getAnimations().filter((animation) => {
      const iterations = animation.effect?.getComputedTiming().iterations;
      return iterations !== Infinity;
    });
    await Promise.race([
      Promise.allSettled(finite.map((animation) => animation.finished)),
      new Promise<void>((resolve) => setTimeout(resolve, 1200)),
    ]);
  });
}

async function runA11yAudit(page: Page, label: string) {
  await waitForSettledAnimations(page);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    // Exclude Monaco's internal hidden IME/canvas helper DOM where upstream controls ARIA.
    .exclude(".monaco-editor .overflowingContentWidgets")
    .analyze();

  const seriousOrCritical = results.violations.filter(
    (v) => v.impact === "critical" || v.impact === "serious",
  );
  const summary = results.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.slice(0, 3).map((n) => n.target.join(" ")),
  }));
  return { label, total: results.violations.length, seriousOrCritical, summary };
}

test("WCAG 2.1 A/AA accessibility audit across core screens and modals", async ({ page }) => {
  test.setTimeout(90000);
  await gotoMock(page);

  const findings: Array<Awaited<ReturnType<typeof runA11yAudit>>> = [];

  // 1. Start screen (Light)
  await page.emulateMedia({ colorScheme: "light" });
  findings.push(await runA11yAudit(page, "StartScreen-light"));

  // 2. Start screen (Dark)
  await page.emulateMedia({ colorScheme: "dark" });
  findings.push(await runA11yAudit(page, "StartScreen-dark"));

  // 3. Connect Dialog
  await page.getByRole("button", { name: "New connection", exact: true }).first().click();
  const connectDialog = page.getByRole("dialog", { name: "New connection", exact: true });
  await expect(connectDialog).toBeVisible();
  findings.push(await runA11yAudit(page, "ConnectDialog"));
  await page.keyboard.press("Escape");
  await expect(connectDialog).toBeHidden();

  // 4. Settings Dialog (Appearance + Shortcuts)
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(settings).toBeVisible();
  findings.push(await runA11yAudit(page, "Settings-Appearance"));
  await settings.getByRole("button", { name: "Shortcuts", exact: true }).click();
  findings.push(await runA11yAudit(page, "Settings-Shortcuts"));
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();

  // 5. Command Palette
  await page.keyboard.press("Control+Shift+P");
  const palette = page.getByRole("dialog", { name: "Search commands", exact: true });
  await expect(palette).toBeVisible();
  findings.push(await runA11yAudit(page, "CommandPalette"));
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();

  // 6. Query Workspace + Results Grid
  await page.getByRole("button", { name: "New query on Mock server", exact: true }).click();
  await page.locator(".monaco-editor").click({ position: { x: 80, y: 12 } });
  await page.keyboard.insertText("SELECT 1;");
  await page.getByRole("button", { name: "Execute", exact: true }).click();
  await expect(page.getByTestId("data-grid-canvas")).toBeVisible();
  findings.push(await runA11yAudit(page, "QueryWorkspace-Results"));

  // Report all detected violations transparently in test annotations for QA report
  for (const report of findings) {
    if (report.total > 0) {
      test.info().annotations.push({
        type: `a11y:${report.label}`,
        description: JSON.stringify(report.summary),
      });
    }
  }

  const criticalFailures = findings.flatMap((f) =>
    f.seriousOrCritical.map((v) => `[${f.label}] ${v.impact?.toUpperCase()} ${v.id}: ${v.help} (${v.nodes[0]?.target.join(" ")})`),
  );
  expect(
    criticalFailures,
    `Serious/Critical WCAG 2.1 A/AA violations found:\n${criticalFailures.join("\n")}`,
  ).toEqual([]);
});

test("all 15 built-in themes apply cleanly with zero horizontal overflow across desktop viewports", async ({ page }) => {
  test.setTimeout(90000);
  await gotoMock(page);
  await page.getByRole("button", { name: "New query on Mock server", exact: true }).click();
  await page.locator(".monaco-editor").click({ position: { x: 80, y: 12 } });
  await page.keyboard.insertText("SELECT Id, Name FROM dbo.Customer WHERE Id > 0;");
  await page.getByRole("button", { name: "Execute", exact: true }).click();
  await expect(page.getByTestId("data-grid-canvas")).toBeVisible();

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(settings).toBeVisible();

  for (const theme of THEMES) {
    const escaped = theme.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const kindLabel = theme.kind === "dark" ? "Dark" : "Light";
    const card = settings.getByRole("button", { name: new RegExp(`^${escaped}\\s+${kindLabel}`) });
    await card.scrollIntoViewIfNeeded();
    await card.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme.id);
    const isDark = await page.locator("html").evaluate((el) => el.classList.contains("dark"));
    expect(isDark).toBe(theme.kind === "dark");
    await expect(card).toHaveAttribute("aria-pressed", "true");
  }

  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();

  // Verify representative themes and minimum/standard desktop window dimensions
  const snapshots: Array<[string, number, number]> = [
    ["light", 1440, 900],
    ["dark", 1440, 900],
    ["dracula", 900, 600],
    ["github-light", 900, 600],
    ["synthwave-84", 1280, 800],
  ];

  for (const [themeId, width, height] of snapshots) {
    await page.setViewportSize({ width, height });
    await page.evaluate(async (id) => {
      const path = "/src/stores/settings.ts";
      const { useSettings } = await import(/* @vite-ignore */ path);
      useSettings.getState().update("appearance", { theme: id });
    }, themeId);
    await expect(page.locator("html")).toHaveAttribute("data-theme", themeId);
    const overflow = await page.evaluate(() => ({
      x: document.documentElement.scrollWidth > window.innerWidth,
      y: document.documentElement.scrollHeight > window.innerHeight,
    }));
    expect(overflow.x, `Horizontal overflow for ${themeId} at ${width}x${height}`).toBe(false);
    await page.screenshot({
      path: `target/ui-test-results/theme-${themeId}-${width}x${height}.png`,
      animations: "disabled",
    });
  }
});
