import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { browser, $ } from "@wdio/globals";
import {
  TEST_DATA_DIR,
  dismissTourIfOpen,
  invokeTauri,
  invokeTauriWithChannel,
  saveDesktopScreenshot,
  waitForAppReady,
} from "./helpers/tauri.ts";

describe("Quervio Real Desktop App — Shell, IPC, Persistence, Clipboard & Windowing", () => {
  let originalTourSeen: string | null = null;

  before(async () => {
    await waitForAppReady(30000);
    originalTourSeen = await browser.execute(() => localStorage.getItem("quervio.tour.seen"));
  });

  after(async () => {
    await invokeTauri("tabs_save", { snapshot: JSON.stringify({ version: 1, active: 0, tabs: [] }) }).catch(() => {});
    await invokeTauri("update_connection_group", { name: "QA Lab", newName: null }).catch(() => {});
    await browser.execute((prev: string | null) => {
      if (prev === null) localStorage.removeItem("quervio.tour.seen");
      else localStorage.setItem("quervio.tour.seen", prev);
    }, originalTourSeen).catch(() => {});
  });

  it("boots with an isolated empty profile and never reads user Saved Connections", async () => {
    assert.ok(TEST_DATA_DIR.length > 0, "QUERVIO_TEST_DATA_DIR must be set by scripts/run-desktop-e2e.mjs");
    const dataDir = await invokeTauri<string>("settings_data_dir");
    assert.equal(
      path.resolve(dataDir).toLowerCase(),
      path.resolve(TEST_DATA_DIR).toLowerCase(),
      `App data_dir (${dataDir}) must match isolated profile (${TEST_DATA_DIR})`,
    );

    const connections = await invokeTauri<unknown[]>("list_connections");
    assert.deepEqual(connections, [], "Isolated test profile must start with zero Saved Connections");

    const surface = await browser.execute(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      title: document.title,
      textLen: document.body.innerText.trim().length,
    }));
    assert.ok(surface.width >= 900, `Expected viewport width >= 900, got ${surface.width}`);
    assert.ok(surface.height >= 600, `Expected viewport height >= 600, got ${surface.height}`);
    assert.ok(surface.textLen > 50, "Desktop surface rendered empty");

    await saveDesktopScreenshot("desktop-01-first-launch");
  });

  it("shows First Launch Tour on fresh state and persists dismissal in WebView storage", async () => {
    await browser.execute(() => {
      localStorage.removeItem("quervio.tour.seen");
      window.location.reload();
    });
    await waitForAppReady(30000);

    const tour = await $("[data-product-tour]");
    await tour.waitForDisplayed({ timeout: 10000 });
    const nextBtn = await $("[data-tour-primary]");
    await nextBtn.click();
    await browser.waitUntil(
      async () => {
        const status = await $("[data-product-tour] [role='status']");
        return (await status.getText()).includes("Step 2 of 7");
      },
      { timeout: 5000, timeoutMsg: "Tour did not advance to step 2" },
    );
    await saveDesktopScreenshot("desktop-02-product-tour");

    const dismissed = await dismissTourIfOpen();
    assert.equal(dismissed, true, "Tour should be dismissible");

    const seen = await browser.execute(() => localStorage.getItem("quervio.tour.seen"));
    assert.equal(seen, "1", "Tour seen flag must persist in WebView localStorage");

    await saveDesktopScreenshot("desktop-03-start-screen-empty");
  });

  it("formats T-SQL using real Rust sqruff IPC and reports syntax error lines", async () => {
    const formatted = await invokeTauri<Array<{ text: string; unparsedLine: number | null }>>("format_sql", {
      batches: ["select id,name from dbo.customer where active=1"],
      style: { uppercaseKeywords: true, indent: "4" },
    });
    assert.equal(formatted.length, 1);
    assert.equal(formatted[0].unparsedLine, null);
    assert.match(formatted[0].text, /\bSELECT\b/);
    assert.match(formatted[0].text, /\bFROM\b/);
    assert.match(formatted[0].text, /\bWHERE\b/);

    const invalid = await invokeTauri<Array<{ text: string; unparsedLine: number | null }>>("format_sql", {
      batches: ["SELECT FROM WHERE ("],
      style: { uppercaseKeywords: true, indent: "4" },
    });
    assert.equal(invalid.length, 1);
    assert.ok(invalid[0].unparsedLine !== null, "Unparseable SQL must report unparsedLine");
  });

  it("round-trips Unicode SQL files through Rust file_write / file_read with CRLF preservation", async () => {
    const filePath = path.join(TEST_DATA_DIR, "e2e-unicode-script.sql");
    const sql = "-- Test Quervio Unicode àèìòù 漢字 🚀\nSELECT N'Ciao Quervio' AS greeting;\n";
    await invokeTauri("file_write", { path: filePath, text: sql });

    const rawBytes = await fs.readFile(filePath, "utf8");
    assert.ok(rawBytes.includes("\r\n"), "Rust file_write must write CRLF line endings");

    const readBack = await invokeTauri<string>("file_read", { path: filePath });
    assert.equal(readBack.replaceAll("\r\n", "\n"), sql);
  });

  it("reads and writes real OS clipboard through Tauri clipboard-manager plugin", async () => {
    const marker = `quervio-desktop-e2e-clipboard-${Date.now()}`;
    await invokeTauri("plugin:clipboard-manager|write_text", { text: marker });
    const actual = await invokeTauri<string>("plugin:clipboard-manager|read_text");
    assert.equal(actual, marker, "OS clipboard round-trip must match written text");
  });

  it("encrypts Saved Connection passwords (DPAPI/Keyring) and persists connections and groups without plaintext secrets", async () => {
    const secret = "Quervio-E2E-Secret-Never-Plaintext!987";
    const saved = await invokeTauri<{ id: string; name: string }>("save_connection", {
      connection: {
        id: "",
        name: "E2E Offline Test Server",
        group: "QA Lab",
        server: "tcp:127.0.0.1,1",
        authentication: { kind: "sql", userName: "qa_user" },
        defaultDatabase: "master",
        environment: "test",
        encrypt: "mandatory",
        trustServerCertificate: false,
      },
      password: secret,
    });
    assert.ok(saved.id, "Saved connection must receive an id");

    const rawConnections = await fs.readFile(path.join(TEST_DATA_DIR, "connections.json"), "utf8");
    assert.ok(!rawConnections.includes(secret), "Plaintext password must NEVER appear in connections.json");
    assert.ok(rawConnections.includes("E2E Offline Test Server"));

    if (process.platform === "win32") {
      const rawSecrets = await fs.readFile(path.join(TEST_DATA_DIR, "secrets.json"), "utf8");
      assert.ok(!rawSecrets.includes(secret), "Plaintext password must NEVER appear in DPAPI secrets.json");
    }

    // Verify management bridge responds if built locally.
    const deps = await invokeTauri<Array<{ name: string; available: boolean; path: string | null }>>(
      "management_dependencies",
    );
    const bridge = deps.find((d) => d.name.toLowerCase().includes("bridge"));
    if (bridge?.available) {
      const { result } = await invokeTauriWithChannel<{ version: string }>("management_bridge", {
        id: saved.id,
        database: null,
        request: { action: "version", arguments: {}, confirmed: false },
        previewToken: null,
      });
      assert.equal(result.version, "1.0", "Microsoft Bridge version command via real IPC must return 1.0");
    }

    await invokeTauri("delete_connection", { id: saved.id });
    assert.deepEqual(await invokeTauri("list_connections"), [], "Deleted connection must be removed");
  });

  it("changes themes in Settings, persists settings.json to disk, and survives page reload", async () => {
    const settingsBtn = await $('[data-tour="settings"]');
    await settingsBtn.waitForDisplayed({ timeout: 10000 });
    await settingsBtn.click();

    const draculaCard = await $("button*=Dracula");
    await draculaCard.waitForDisplayed({ timeout: 10000 });
    await draculaCard.click();

    await browser.waitUntil(
      async () => (await browser.execute(() => document.documentElement.dataset.theme)) === "dracula",
      { timeout: 5000, timeoutMsg: "Theme did not switch to dracula" },
    );

    await saveDesktopScreenshot("desktop-04-settings-dracula");

    // Close settings dialog via Escape
    await browser.keys("Escape");
    await browser.waitUntil(async () => !(await (await $('[role="dialog"]')).isExisting()), {
      timeout: 5000,
      timeoutMsg: "Settings dialog did not close on Escape",
    });

    // Wait for settings.json to be written to isolated profile dir
    await browser.waitUntil(
      async () => {
        try {
          const text = await fs.readFile(path.join(TEST_DATA_DIR, "settings.json"), "utf8");
          return text.includes('"dracula"');
        } catch {
          return false;
        }
      },
      { timeout: 10000, timeoutMsg: "settings.json was not persisted with dracula theme" },
    );

    // Reload webview and verify theme and dismissed tour persist
    await browser.execute(() => window.location.reload());
    await waitForAppReady(30000);
    await browser.waitUntil(
      async () => (await browser.execute(() => document.documentElement.dataset.theme)) === "dracula",
      { timeout: 10000, timeoutMsg: "Persisted dracula theme did not restore after reload" },
    );
    assert.equal(await (await $("[data-product-tour]")).isExisting(), false, "Tour must stay closed after reload");
  });

  it("persists Query Tab recovery snapshots (tabs.json) and handles window resizing cleanly", async () => {
    const snapshot = JSON.stringify({
      version: 1,
      active: 0,
      tabs: [
        {
          connectionId: "missing-connection-id",
          database: "master",
          title: "Recovered.sql",
          text: "SELECT N'recovered-from-tabs-json';",
          filePath: null,
          dirty: true,
        },
      ],
    });
    await invokeTauri("tabs_save", { snapshot });
    const loaded = await invokeTauri<{ snapshot: string | null; recovered: boolean }>("tabs_load");
    assert.equal(loaded.snapshot, snapshot);
    assert.equal(loaded.recovered, false);

    // Verify resizing the real native window maintains usable layout without horizontal overflow
    await browser.setWindowSize(1024, 700);
    await browser.pause(300);
    const layout = await browser.execute(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      overflowX: document.documentElement.scrollWidth > window.innerWidth,
    }));
    assert.ok(layout.width >= 900 && layout.height >= 600, `Unexpected resized viewport: ${JSON.stringify(layout)}`);
    assert.equal(layout.overflowX, false, "Resized desktop window must not overflow horizontally");

    await saveDesktopScreenshot("desktop-05-resized-window");
  });
});
