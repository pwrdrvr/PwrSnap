import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "act-warning-guard-self-test",
    globals: true,
    pool: "threads",
    environment: "jsdom",
    runner: "apps/desktop/src/test-setup/act-warning-runner.ts",
    setupFiles: ["apps/desktop/src/test-setup/react-act-environment.ts"],
    include: ["apps/desktop/src/test-setup/fixtures/act-warning-guard.fixture.tsx"],
  },
});
