import { test, expect } from "@playwright/test";

test("New connection keeps its height when the transport warning appears", async ({ page }) => {
  test.setTimeout(60000);
  await page.goto("/?mock", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "Tools", exact: true })).toBeVisible({ timeout: 30000 });
  await page.getByRole("button", { name: "New connection", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "New connection", exact: true });
  await expect(dialog).toBeVisible();
  const height = async () => {
    // The open animation scales the dialog, so measure once it has settled.
    await dialog.evaluate((element) => Promise.all(element.getAnimations({ subtree: true }).map((a) => a.finished)));
    return (await dialog.boundingBox())!.height;
  };
  const warning = dialog.getByText("Certificate not verified", { exact: true });

  await expect(warning).toBeHidden();
  const before = await height();
  await dialog.getByRole("checkbox", { name: "Trust server certificate" }).click();
  await expect(warning).toBeVisible();
  expect(await height()).toBe(before);
  await page.screenshot({ path: "target/ui-test-results/connect-dialog-trust-warning.png", animations: "disabled" });

  await dialog.getByRole("checkbox", { name: "Trust server certificate" }).click();
  await expect(warning).toBeHidden();
  expect(await height()).toBe(before);
});
