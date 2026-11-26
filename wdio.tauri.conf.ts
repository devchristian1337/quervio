import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TauriCapabilities, TauriServiceOptions } from "@wdio/tauri-service";

const root = path.dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === "win32";
const defaultBinary = path.join(root, "target", "debug", isWindows ? "quervio.exe" : "quervio");
const appBinaryPath = path.resolve(process.env.QUERVIO_E2E_BINARY || defaultBinary);
const artifactsDir = path.resolve(
  process.env.QUERVIO_E2E_ARTIFACTS || path.join(root, "target", "e2e-desktop-results"),
);

function resolveTauriDriverPath(): string | undefined {
  if (process.env.TAURI_DRIVER_PATH) return process.env.TAURI_DRIVER_PATH;
  const candidate = path.join(os.homedir(), ".cargo", "bin", isWindows ? "tauri-driver.exe" : "tauri-driver");
  return fs.existsSync(candidate) ? candidate : undefined;
}

// Forward isolated profile variables to tauri-driver and the launched desktop app.
const driverEnv: Record<string, string> = {};
for (const key of [
  "QUERVIO_TEST_DATA_DIR",
  "WEBVIEW2_USER_DATA_FOLDER",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
  "GNOME_KEYRING_CONTROL",
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "TMPDIR",
]) {
  const value = process.env[key];
  if (value) driverEnv[key] = value;
}

const tauriServiceOptions: TauriServiceOptions = {
  driverProvider: "external",
  appBinaryPath,
  tauriDriverPath: resolveTauriDriverPath(),
  tauriDriverPort: Number(process.env.QUERVIO_TAURI_DRIVER_PORT || 4444),
  autoInstallTauriDriver: false,
  autoDownloadEdgeDriver: isWindows,
  captureBackendLogs: process.env.QUERVIO_E2E_VERBOSE === "1",
  captureFrontendLogs: process.env.QUERVIO_E2E_VERBOSE === "1",
  startTimeout: 60000,
  commandTimeout: 60000,
  env: driverEnv,
};

const capabilities: Array<TauriCapabilities & { maxInstances?: number }> = [
  {
    browserName: "tauri",
    maxInstances: 1,
    "tauri:options": {
      application: appBinaryPath,
    },
  },
];

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./tests/e2e/**/*.e2e.ts"],
  maxInstances: 1,
  capabilities,
  services: [["@wdio/tauri-service", tauriServiceOptions]],
  framework: "mocha",
  reporters: ["spec"],
  logLevel: (process.env.WDIO_LOG_LEVEL as WebdriverIO.Config["logLevel"]) || "warn",
  waitforTimeout: 15000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 2,
  mochaOpts: {
    ui: "bdd",
    timeout: 120000,
  },
  onPrepare() {
    fs.mkdirSync(path.join(artifactsDir, "screenshots"), { recursive: true });
    fs.mkdirSync(path.join(artifactsDir, "failures"), { recursive: true });
  },
  async afterTest(test: { parent: string; title: string }, _context: unknown, result: { passed: boolean }) {
    if (!result.passed) {
      const safeName = `${test.parent}-${test.title}`.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 120);
      const target = path.join(artifactsDir, "failures", `${safeName}.png`);
      await browser.saveScreenshot(target).catch(() => {});
    }
  },
};
