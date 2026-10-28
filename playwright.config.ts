import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
import process from "node:process";
const executablePath =
  process.env.QUERVIO_BROWSER ??
  [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ].find(existsSync);
export default defineConfig({
  testDir: "./tests/ui",
  outputDir: "./target/ui-test-results",
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: "http://127.0.0.1:1420",
    browserName: "chromium",
    launchOptions: { executablePath },
    headless: true,
    viewport: { width: 1440, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node node_modules/vite/bin/vite.js --host 127.0.0.1",
    url: "http://127.0.0.1:1420",
    reuseExistingServer: true,
    timeout: 30000,
  },
});
