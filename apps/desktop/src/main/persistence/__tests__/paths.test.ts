// Verifies the data-root rerooting primitive that the dev seeder
// relies on for safety. The wipe path refuses to run unless
// `isOverriddenDataRoot()` returns true, so a regression in the
// override resolution would either silently let the seeder write
// against the user's real Library OR refuse all wipes (DoS the
// dev tool). Either way: lock it down.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  appPaths: {
    userData: "/tmp/pwrsnap-test-userData",
    documents: "/tmp/pwrsnap-test-documents",
    home: "/tmp/pwrsnap-test-home"
  },
  statSync: vi.fn()
}));

// `paths.ts` imports `electron`'s `app` for the default-fallback case.
// Stub it with a fixed userData path so the tests don't need an
// actual Electron runtime.
vi.mock("electron", () => ({
  app: {
    getPath: (name: string): string => {
      if (name === "userData") return mocks.appPaths.userData;
      if (name === "documents") return mocks.appPaths.documents;
      if (name === "home") return mocks.appPaths.home;
      throw new Error(`unexpected app.getPath: ${name}`);
    }
  }
}));

vi.mock("node:fs", () => ({
  statSync: mocks.statSync
}));

const ENV_KEY = "PWRSNAP_DATA_ROOT";
const originalEnv = process.env[ENV_KEY];

beforeEach(() => {
  delete process.env[ENV_KEY];
  mocks.appPaths.userData = "/tmp/pwrsnap-test-userData";
  mocks.appPaths.documents = "/tmp/pwrsnap-test-documents";
  mocks.appPaths.home = "/tmp/pwrsnap-test-home";
  mocks.statSync.mockReset();
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

  test("keeps the seeder wipe gate closed for the same Windows drive path with different case and trailing separators", async () => {
    mocks.appPaths.userData = String.raw`C:\Users\Test\AppData\Roaming\PwrSnap`;
    process.env[ENV_KEY] = String.raw`c:\users\test\appdata\roaming\pwrsnap\\`;
    const { isOverriddenDataRoot } = await import("../paths");

    expect(isOverriddenDataRoot("win32")).toBe(false);
  });

  test("keeps the seeder wipe gate closed for the same Windows UNC path with different case and trailing separators", async () => {
    mocks.appPaths.userData = String.raw`\\Server\Share\PwrSnap`;
    process.env[ENV_KEY] = String.raw`\\server\share\pwrsnap\\`;
    const { isOverriddenDataRoot } = await import("../paths");

    expect(isOverriddenDataRoot("win32")).toBe(false);
  });

  test("opens the seeder wipe gate for a distinct Windows override", async () => {
    mocks.appPaths.userData = String.raw`C:\Users\Test\AppData\Roaming\PwrSnap`;
    process.env[ENV_KEY] = String.raw`D:\PwrSnap\Seed`;
    const { isOverriddenDataRoot } = await import("../paths");

    expect(isOverriddenDataRoot("win32")).toBe(true);
  });

  test("preserves POSIX case sensitivity while ignoring a trailing separator", async () => {
    mocks.appPaths.userData = "/Users/test/Library/Application Support/PwrSnap";
    process.env[ENV_KEY] = "/Users/test/Library/Application Support/PwrSnap/";
    const { isOverriddenDataRoot } = await import("../paths");
    expect(isOverriddenDataRoot("darwin")).toBe(false);

    process.env[ENV_KEY] = "/Users/test/Library/Application Support/pwrsnap";
    expect(isOverriddenDataRoot("darwin")).toBe(true);
  });
});

describe("paths.assertSameVolume", () => {
  test("throws when both roots exist on different devices", async () => {
    process.env[ENV_KEY] = "/tmp/pwrsnap-override";
    mocks.statSync
      .mockReturnValueOnce({ dev: 101 })
      .mockReturnValueOnce({ dev: 202 });
    const { assertSameVolume } = await import("../paths");

    expect(() => assertSameVolume()).toThrow(
      "paths invariant violated: captures (/tmp/pwrsnap-override/captures) and trash (/tmp/pwrsnap-override/.trash) on different volumes"
    );
  });

  test("allows a fresh install when either root cannot be statted", async () => {
    process.env[ENV_KEY] = "/tmp/pwrsnap-override";
    mocks.statSync.mockImplementationOnce(() => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    const { assertSameVolume } = await import("../paths");

    expect(() => assertSameVolume()).not.toThrow();

    mocks.statSync.mockReset();
    mocks.statSync.mockReturnValueOnce({ dev: 101 }).mockImplementationOnce(() => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    expect(() => assertSameVolume()).not.toThrow();
  });
});

describe("paths accessors compose from getDataRoot", () => {
  test("default layout: DB/render-cache/trash under userData, captures under documents/PwrSnap", async () => {
    const {
      getDbPath,
      getCapturesRoot,
      getCapturesLocation,
      getCapturesRootForLocation,
      getDurableCapturesRoots,
      setCapturesLocation,
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
    expect(getCapturesLocation()).toBe("documents");
    setCapturesLocation("home");
    expect(getCapturesRoot()).toBe(join("/tmp/pwrsnap-test-home", "PwrSnap"));
    expect(getCapturesRootForLocation("documents")).toBe(join(documents, "PwrSnap"));
    expect(getDurableCapturesRoots()).toEqual([
      { kind: "documents", path: join(documents, "PwrSnap") },
      { kind: "home", path: join("/tmp/pwrsnap-test-home", "PwrSnap") }
    ]);
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
      getDurableCapturesRoots,
      setCapturesLocation,
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
    expect(getDurableCapturesRoots()).toEqual([
      { kind: "override", path: join(root, "captures") }
    ]);
    setCapturesLocation("home");
    // The dev/test override always wins over a persisted user location.
    expect(getCapturesRoot()).toBe(join(root, "captures"));
    expect(getLegacyCapturesRoot()).toBe(join(root, "captures"));
    expect(getCacheRoot()).toBe(join(root, "render-cache"));
    expect(getLegacyCacheRoot()).toBe(join(root, "cache"));
    expect(getTrashRoot()).toBe(join(root, ".trash"));
    expect(getPerfRoot()).toBe(join(root, "perf"));
  });
});

// Chat + sizzle threads used to be hardcoded to ~/Documents/PwrSnap/Chats in
// four handlers. `~/Documents` is TCC-gated on macOS, and #376's denial
// fallback only covered the CAPTURE root — so a denied grant left captures
// working while chat persistence silently broke. Chats now compose from the
// captures root, inheriting that fallback.
describe("paths.getChatsRoot", () => {
  test("sits under the Documents captures root by default", async () => {
    const { getChatsRoot, getCapturesRoot } = await import("../paths");
    expect(getChatsRoot()).toBe(join("/tmp/pwrsnap-test-documents", "PwrSnap", "Chats"));
    expect(getChatsRoot()).toBe(join(getCapturesRoot(), "Chats"));
  });

  test("follows the captures root to ~/PwrSnap when Documents is denied", async () => {
    const { getChatsRoot, setCapturesLocation } = await import("../paths");
    setCapturesLocation("home");
    expect(getChatsRoot()).toBe(join("/tmp/pwrsnap-test-home", "PwrSnap", "Chats"));
    // Never strands threads in the TCC-gated tree after a denial.
    expect(getChatsRoot()).not.toContain("documents");
  });

  test("stays inside the data root in override mode, not the user's Documents", async () => {
    process.env[ENV_KEY] = "/tmp/pwrsnap-override";
    const { getChatsRoot } = await import("../paths");
    // A dev seeder or profiling clone must not write threads into the real
    // ~/Documents/PwrSnap (capture bundles live outside userData).
    expect(getChatsRoot()).toBe(join("/tmp/pwrsnap-override", "captures", "Chats"));
    expect(getChatsRoot()).not.toContain("documents");
  });
});
