// Playwright config for the desktop E2E suite. Modeled on PwrAgnt's
// shape — single worker, no parallelism (Electron tests share the
// global Electron runtime; parallel launches collide on the
// single-instance lock and on the per-user data dir).
//
// Specs live under `./e2e/`. Each spec launches a fresh Electron
// process via `_electron.launch()` against a tmpdir HOME, so tests
// are independent at the OS level even though Playwright runs them
// serially.

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  outputDir: "./test-results",
  reporter: process.env.CI
    ? [
        ["html", { outputFolder: "playwright-report", open: "never" }],
        ["list"]
      ]
    : "list",
  use: {
    screenshot: process.env.CI ? "only-on-failure" : "off",
    trace: "on-first-retry",
    video: process.env.CI ? "retain-on-failure" : "off"
  }
});
