import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "retry.fixture.mjs",
  workers: 1,
  retries: 0,
  reporter: [["../../../../scripts/ci/playwright-ci-reporter.mjs"]]
});
