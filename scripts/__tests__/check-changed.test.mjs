import { describe, expect, it } from "vitest";
import { testArguments } from "../check-changed.mjs";

describe("changed-work test selection", () => {
  it("selects import-related tests for ordinary source and preserves exact paths", () => {
    expect(testArguments(["packages/shared/src/result.ts", "apps/desktop/src/file with spaces.tsx"]))
      .toEqual(["exec", "vitest", "related", "--run", "--config", "vitest.workspace.ts",
        "packages/shared/src/result.ts", "apps/desktop/src/file with spaces.tsx"]);
  });
  it.each([
    "pnpm-lock.yaml", "package.json", "packages/shared/tsconfig.json",
    "apps/desktop/electron.vite.config.ts", "vitest.workspace.ts",
    "scripts/check-changed.mjs", "apps/desktop/src/test-setup/outbound-fetch-guard.ts",
    "apps/desktop/e2e/fixtures/electron-app.ts", "apps/desktop/native/recorder.swift"
  ])("runs all tests for changes without a reliable import edge: %s", (file) => {
    expect(testArguments([file])).toEqual(["test"]);
  });
  it("does not invent related tests for an empty change set", () => {
    expect(testArguments([])).toEqual([]);
  });
});
