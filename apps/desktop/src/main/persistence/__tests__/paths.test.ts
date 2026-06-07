// Verifies the data-root rerooting primitive that the dev seeder
// relies on for safety. The wipe path refuses to run unless
// `isOverriddenDataRoot()` returns true, so a regression in the
// override resolution would either silently let the seeder write
// against the user's real Library OR refuse all wipes (DoS the
// dev tool). Either way: lock it down.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { join } from "node:path";

// `paths.ts` imports `electron`'s `app` for the default-fallback case.
// Stub it with a fixed userData path so the tests don't need an
// actual Electron runtime.
vi.mock("electron", () => ({
  app: {
    getPath: (name: string): string => {
      if (name === "userData") return "/tmp/pwrsnap-test-userData";
      if (name === "documents") return "/tmp/pwrsnap-test-documents";
      throw new Error(`unexpected app.getPath: ${name}`);
    }
  }
}));

const ENV_KEY = "PWRSNAP_DATA_ROOT";
const originalEnv = process.env[ENV_KEY];

beforeEach(() => {
  delete process.env[ENV_KEY];
  vi.resetModules();
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = originalEnv;
});

describe("paths.getDataRoot", () => {
  test("returns app.getPath('userData') when env is unset", async () => {
    const { getDataRoot, isOverriddenDataRoot } = await import("../paths");
    expect(getDataRoot()).toBe("/tmp/pwrsnap-test-userData");
    expect(isOverriddenDataRoot()).toBe(false);
  });

  test("returns env override when PWRSNAP_DATA_ROOT is set", async () => {
    process.env[ENV_KEY] = "/Volumes/Dev/pwrsnap-perf/10k";
    const { getDataRoot, isOverriddenDataRoot } = await import("../paths");
    expect(getDataRoot()).toBe("/Volumes/Dev/pwrsnap-perf/10k");
    expect(isOverriddenDataRoot()).toBe(true);
  });

  test("treats an empty-string env value as unset", async () => {
    process.env[ENV_KEY] = "";
    const { getDataRoot, isOverriddenDataRoot } = await import("../paths");
    expect(getDataRoot()).toBe("/tmp/pwrsnap-test-userData");
    expect(isOverriddenDataRoot()).toBe(false);
  });
});

describe("paths accessors compose from getDataRoot", () => {
  test("default layout: DB/render-cache/trash under userData, captures under documents/PwrSnap", async () => {
    const {
      getDbPath,
      getCapturesRoot,
      getLegacyCapturesRoot,
      getCacheRoot,
      getLegacyCacheRoot,
      getTrashRoot,
      getPerfRoot
    } =
      await import("../paths");
    const userData = "/tmp/pwrsnap-test-userData";
    const documents = "/tmp/pwrsnap-test-documents";
    expect(getDbPath()).toBe(join(userData, "pwrsnap.db"));
    expect(getCapturesRoot()).toBe(join(documents, "PwrSnap"));
    expect(getLegacyCapturesRoot()).toBe(join(userData, "captures"));
    expect(getCacheRoot()).toBe(join(userData, "render-cache"));
    expect(getLegacyCacheRoot()).toBe(join(userData, "cache"));
    expect(getTrashRoot()).toBe(join(userData, ".trash"));
    expect(getPerfRoot()).toBe(join(userData, "perf"));
  });

  test("override layout: every accessor reroots under PWRSNAP_DATA_ROOT (single tree)", async () => {
    process.env[ENV_KEY] = "/Volumes/Dev/pwrsnap-perf/100";
    const {
      getDbPath,
      getCapturesRoot,
      getLegacyCapturesRoot,
      getCacheRoot,
      getLegacyCacheRoot,
      getTrashRoot,
      getPerfRoot
    } =
      await import("../paths");
    const root = "/Volumes/Dev/pwrsnap-perf/100";
    expect(getDbPath()).toBe(join(root, "pwrsnap.db"));
    expect(getCapturesRoot()).toBe(join(root, "captures"));
    expect(getLegacyCapturesRoot()).toBe(join(root, "captures"));
    expect(getCacheRoot()).toBe(join(root, "render-cache"));
    expect(getLegacyCacheRoot()).toBe(join(root, "cache"));
    expect(getTrashRoot()).toBe(join(root, ".trash"));
    expect(getPerfRoot()).toBe(join(root, "perf"));
  });
});
