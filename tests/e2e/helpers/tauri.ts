import fs from "node:fs/promises";
import path from "node:path";
import { browser } from "@wdio/globals";

export const ARTIFACTS_DIR = path.resolve(
  process.env.QUERVIO_E2E_ARTIFACTS || path.join(process.cwd(), "target", "e2e-desktop-results"),
);

export const TEST_DATA_DIR = process.env.QUERVIO_TEST_DATA_DIR || "";

export interface SqlFixtureConfig {
  server: string;
  user: string;
  password: string;
}

export function getSqlFixture(): SqlFixtureConfig | null {
  const server = process.env.QUERVIO_E2E_SQL_SERVER;
  const user = process.env.QUERVIO_E2E_SQL_USER;
  const password = process.env.QUERVIO_E2E_SQL_PASSWORD;
  if (!server || !user || !password) return null;
  return { server, user, password };
}

/**
 * Waits until the real Tauri frontend and IPC bridge are initialized inside WebView2/WebKitGTK.
 */
export async function waitForAppReady(timeout = 30000): Promise<void> {
  // Explicitly select the current main window handle once so @wdio/tauri-service
  // does not poll for the optional @wdio/tauri-plugin before every DOM command.
  try {
    const handle = await browser.getWindowHandle();
    if (handle) await browser.switchToWindow(handle);
  } catch {
    // Ignore if driver does not require window handle selection.
  }
  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        const w = window as unknown as { __TAURI_INTERNALS__?: { invoke?: unknown } };
        const root = document.querySelector("#root");
        return Boolean(w.__TAURI_INTERNALS__?.invoke && root?.textContent?.trim());
      }),
    { timeout, timeoutMsg: "Quervio desktop frontend did not initialize within timeout" },
  );
}

/**
 * Invokes a real Rust Tauri command through window.__TAURI_INTERNALS__.invoke
 * (uses the standard external tauri-driver bridge, requiring zero test-only plugins).
 */
export async function invokeTauri<T = unknown>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const response = (await browser.executeAsync(
    (cmd: string, payload: Record<string, unknown>, done: (res: { value?: T; error?: string }) => void) => {
      const internals = (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (c: string, a: Record<string, unknown>) => Promise<T> };
        }
      ).__TAURI_INTERNALS__;
      internals
        .invoke(cmd, payload)
        .then((value) => done({ value }))
        .catch((error) => done({ error: typeof error === "string" ? error : String(error) }));
    },
    command,
    args,
  )) as { value?: T; error?: string };

  if (response.error !== undefined) {
    throw new Error(`Tauri command "${command}" failed: ${response.error}`);
  }
  return response.value as T;
}

/**
 * Invokes a real Rust Tauri command that takes a Channel (`onEvent`) callback.
 */
export async function invokeTauriWithChannel<T = unknown>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<{ result: T; events: unknown[] }> {
  const response = (await browser.executeAsync(
    (
      cmd: string,
      payload: Record<string, unknown>,
      done: (res: { value?: T; events?: unknown[]; error?: string }) => void,
    ) => {
      const internals = (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke: (c: string, a: Record<string, unknown>) => Promise<T>;
            transformCallback: (cb: (event: unknown) => void) => number;
          };
        }
      ).__TAURI_INTERNALS__;
      const events: unknown[] = [];
      const cbId = internals.transformCallback((event) => {
        events.push(event);
      });
      internals
        .invoke(cmd, { ...payload, onEvent: `__CHANNEL__:${cbId}` })
        .then((value) => done({ value, events }))
        .catch((error) => done({ error: typeof error === "string" ? error : String(error), events }));
    },
    command,
    args,
  )) as { value?: T; events?: unknown[]; error?: string };

  if (response.error !== undefined) {
    throw new Error(`Tauri channel command "${command}" failed: ${response.error}`);
  }
  return { result: response.value as T, events: response.events ?? [] };
}

/**
 * Dismisses the First Launch Tour if it is currently visible.
 */
export async function dismissTourIfOpen(): Promise<boolean> {
  const tour = await browser.$("[data-product-tour]");
  if (await tour.isExisting()) {
    const closeBtn = await browser.$('button[aria-label="Close tour"]');
    if (await closeBtn.isDisplayed()) {
      await closeBtn.click();
      await browser.waitUntil(async () => !(await (await browser.$("[data-product-tour]")).isExisting()), {
        timeout: 10000,
        timeoutMsg: "First launch tour did not close",
      });
      return true;
    }
  }
  return false;
}

/**
 * Saves a desktop screenshot into target/e2e-desktop-results/screenshots/<name>.png.
 */
export async function saveDesktopScreenshot(name: string): Promise<string> {
  const dir = path.join(ARTIFACTS_DIR, "screenshots");
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${name}.png`);
  await browser.saveScreenshot(filePath);
  return filePath;
}

/**
 * Sets value on a controlled React input reliably in WebView2 / WebKitGTK.
 */
export async function setReactInputValue(selector: string, value: string): Promise<void> {
  const el = await browser.$(selector);
  await el.waitForDisplayed({ timeout: 10000 });
  await el.click();
  await browser.execute(
    (sel: string, val: string) => {
      const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(sel);
      if (!input) throw new Error(`Element not found: ${sel}`);
      const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      setter?.call(input, val);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    },
    selector,
    value,
  );
}

/**
 * Replaces the active Monaco editor's text via real OS clipboard paste (Ctrl+A, Ctrl+V),
 * which works reliably in production Vite bundles without exposing window.monaco globals.
 */
export async function typeInMonaco(sql: string): Promise<void> {
  const editor = await browser.$(".monaco-editor");
  await editor.waitForDisplayed({ timeout: 15000 });
  await invokeTauri("plugin:clipboard-manager|write_text", { text: sql });
  await editor.click();
  await browser.pause(100);
  await browser.keys(["Control", "a"]);
  await browser.pause(50);
  await browser.keys(["Control", "v"]);
  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        const text = document.querySelector(".monaco-editor .view-lines")?.textContent ?? "";
        return text.trim().length > 0;
      }),
    { timeout: 10000, timeoutMsg: "Monaco editor did not receive pasted SQL text" },
  );
}
