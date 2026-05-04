// Multi-project Vitest config. Mirrors PwrAgnt's layout: one project
// per logical surface so we can run a focused set in isolation
// (`pnpm vitest --project shared`) and so the renderer project gets
// `environment: "jsdom"` without leaking the DOM globals into Node-
// only suites.
//
// Test files live next to source under `__tests__/` directories, named
// `*.test.ts` / `*.test.tsx`. E2E specs in `apps/desktop/e2e/*.spec.ts`
// run under Playwright (separate `pnpm test:desktop-e2e` script) — they
// are deliberately excluded from this workspace.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "shared",
          globals: true,
          environment: "node",
          include: ["packages/shared/src/**/__tests__/**/*.test.ts"]
        }
      },
      {
        test: {
          name: "desktop-main",
          globals: true,
          environment: "node",
          include: ["apps/desktop/src/main/**/__tests__/**/*.test.ts"]
        }
      },
      {
        test: {
          name: "desktop-renderer",
          globals: true,
          environment: "jsdom",
          include: [
            "apps/desktop/src/renderer/src/**/__tests__/**/*.test.{ts,tsx}",
            "apps/desktop/src/renderer/src/**/*.test.{ts,tsx}"
          ]
        }
      }
    ]
  }
});
