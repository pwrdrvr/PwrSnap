import { describe, expect, it } from "vitest";
import { sourceReadingTests, testArguments } from "../check-changed.mjs";
import { pnpmCommand } from "../lib/pnpm-command.mjs";

describe("changed-work test selection", () => {
  it("selects import-related tests for ordinary source and preserves exact paths", () => {
    expect(testArguments(["packages/shared/src/result.ts", "apps/desktop/src/file with spaces.tsx"]))
      .toEqual(["exec", "vitest", "related", "--run", "--config", "vitest.workspace.ts",
        "packages/shared/src/result.ts", "apps/desktop/src/file with spaces.tsx", ...sourceReadingTests()]);
  });
  it("includes source-reading guards when only their guarded source changes", () => {
    const args = testArguments(["apps/desktop/src/main/capture/region-selector.ts"]);
    expect(args).toContain("apps/desktop/src/main/capture/__tests__/selector-overlay-fullscreen.test.ts");
    expect(args).toContain("apps/desktop/src/renderer/src/styles/__tests__/focus-ring-contract.test.ts");
    expect(args).toContain("apps/desktop/scripts/native-recorder-audio-contract.test.mjs");
  });
  it("does not duplicate a source-reading test that itself changed", () => {
    const file = "apps/desktop/src/main/capture/__tests__/selector-overlay-fullscreen.test.ts";
    expect(testArguments([file]).filter((arg) => arg === file)).toHaveLength(1);
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

describe("package-manager invocation", () => {
  it("keeps native Windows paths and test filenames as separate argv entries", () => {
    const args = ["exec", "vitest", "related", "path with spaces & symbols.ts"];
    expect(pnpmCommand(args, "C:\\Program Files\\pnpm-native.exe"))
      .toEqual({ command: "C:\\Program Files\\pnpm-native.exe", args });
  });
  it("runs a JS package-manager launcher with Node", () => {
    expect(pnpmCommand(["lint"], "/tools/pnpm.cjs"))
      .toEqual({ command: process.execPath, args: ["/tools/pnpm.cjs", "lint"] });
  });
});
