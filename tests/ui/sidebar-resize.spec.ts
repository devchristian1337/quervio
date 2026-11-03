import { test, expect, type Page } from "@playwright/test";

async function nativeEditorScrollbars(page: Page) {
  return page.locator(".monaco-editor").evaluate((editor) => {
    const scrollbars = [];
    for (let node: HTMLElement | null = editor as HTMLElement; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      const horizontal = /^(auto|scroll)$/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1;
      const vertical = /^(auto|scroll)$/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1;
      if (horizontal || vertical) scrollbars.push({
        element: node.dataset.slot ?? node.tagName,
        className: node.className,
        horizontal, vertical,
        width: node.clientWidth, scrollWidth: node.scrollWidth,
        height: node.clientHeight, scrollHeight: node.scrollHeight,
      });
    }
    return scrollbars;
  });
}

test.beforeEach(async ({ page }) => {
  test.setTimeout(60000);
  // Keep Monaco's measurement a few frames behind the drag, as on a busy
  // WebView. The real panel layout and native scrollbar painting stay intact.
  await page.addInitScript(() => {
    const NativeObserver = window.ResizeObserver;
    window.ResizeObserver = class extends NativeObserver {
      constructor(callback: ResizeObserverCallback) {
        super((entries, observer) => {
          const editorHost = entries.some(({ target }) =>
            target.firstElementChild?.classList.contains("monaco-editor"));
          if (editorHost) setTimeout(() => callback(entries, observer), 80);
          else callback(entries, observer);
        });
      }
    };
  });
  await page.goto("/?mock", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Tools", exact: true }).waitFor();
  await page.evaluate(async () => {
    const path = "/src/stores/settings.ts";
    const { useSettings } = await import(/* @vite-ignore */ path);
    useSettings.getState().update("editor", { fontSize: 20 });
  });
  await page.getByRole("button", { name: "New query on Mock server", exact: true }).click();
  await page.locator(".monaco-editor").click({ position: { x: 80, y: 12 } });
  await page.waitForLoadState("networkidle");
});

test("dragging the sidebar does not create native editor scrollbars, including at maximum width", async ({ page }) => {
  await page.keyboard.insertText("SELECT TOP 10 * FROM ba_patient");
  await page.getByRole("button", { name: "Execute", exact: true }).click();
  await expect(page.getByTestId("data-grid-canvas")).toBeVisible();
  const divider = page.getByRole("separator").first();
  const box = await divider.boundingBox();
  const y = box!.y + box!.height / 2;
  await page.mouse.move(box!.x + box!.width / 2, y);
  await page.mouse.down();
  const observed = [];
  // Inspect during the drag, before Monaco has necessarily caught up with
  // the new dimensions. Checking only after mouseup misses the reported flash.
  for (const x of [420, 600, 800, 1020, 1200, 1350]) {
    await page.mouse.move(x, y, { steps: 5 });
    const scrollbars = await nativeEditorScrollbars(page);
    if (scrollbars.length) observed.push({ x, scrollbars });
  }
  await page.screenshot({ path: "target/ui-test-results/sidebar-resize-max.png", animations: "disabled" });
  await page.mouse.up();
  expect(observed).toEqual([]);
  await expect.poll(() => nativeEditorScrollbars(page)).toEqual([]);
});

test("long SQL keeps Monaco scrolling at maximum sidebar width without native wrapper scrollbars", async ({ page }) => {
  await page.keyboard.insertText(Array.from({ length: 100 }, (_, index) => `SELECT ${index}, '${"long text ".repeat(20)}';`).join("\n"));
  const box = await page.getByRole("separator").first().boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(1400, box!.y + box!.height / 2, { steps: 15 });
  await page.mouse.up();
  await expect.poll(() => nativeEditorScrollbars(page)).toEqual([]);
  await expect.poll(() => page.evaluate(async () => {
    const path = "/src/lib/monaco.ts";
    const { monaco } = await import(/* @vite-ignore */ path);
    const editor = monaco.editor.getEditors()[0];
    const panel = editor.getContainerDomNode().closest('[data-slot="resizable-panel"]') as HTMLElement;
    const layout = editor.getLayoutInfo();
    editor.setScrollPosition({ scrollLeft: 100, scrollTop: 200 });
    return {
      horizontal: editor.getScrollLeft() > 0,
      vertical: editor.getScrollTop() > 0,
      fitsWidth: Math.abs(layout.width - panel.clientWidth) <= 1,
      fitsHeight: Math.abs(layout.height - panel.clientHeight) <= 1,
      lines: editor.getModel()?.getLineCount(),
    };
  })).toEqual({ horizontal: true, vertical: true, fitsWidth: true, fitsHeight: true, lines: 100 });
});
