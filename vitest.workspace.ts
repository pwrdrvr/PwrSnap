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
//
// Every project loads `apps/desktop/src/test-setup/outbound-fetch-guard.ts`,
// which fails any test that makes a real outbound HTTP request. See that file
// for the rationale and for how to fix a failure.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "shared",
          globals: true,
          environment: "node",
          include: ["packages/shared/src/**/__tests__/**/*.test.ts"],
          setupFiles: ["apps/desktop/src/test-setup/outbound-fetch-guard.ts"]
        }
      },
      {
        test: {
          name: "desktop-main",
          globals: true,
          environment: "node",
          include: [
            "scripts/**/*.test.mjs",
            "apps/desktop/scripts/**/*.test.mjs",
            "apps/desktop/src/main/**/__tests__/**/*.test.ts",
            "apps/desktop/src/preload/**/__tests__/**/*.test.ts",
            "apps/desktop/src/test-setup/**/__tests__/**/*.test.ts"
          ],
          setupFiles: ["apps/desktop/src/test-setup/outbound-fetch-guard.ts"]
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
          ],
          // The renderer reaches the network through IPC, so it has no
          // egress `fetch` call site today — but jsdom inherits a live
          // `fetch` from Node, so the guard covers a violation nothing
          // else here would catch.
          setupFiles: ["apps/desktop/src/test-setup/outbound-fetch-guard.ts"]
        }
      }
    ]
  }
});
