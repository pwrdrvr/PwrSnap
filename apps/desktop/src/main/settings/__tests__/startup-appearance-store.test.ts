// BrowserWindow constructors call startup-appearance synchronously. Once the
// process store is hydrated, opening Library/Settings/editor windows must use
// that snapshot rather than re-reading settings.json for every window.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userData: "/tmp/pwrsnap-startup-appearance-store-test"
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => mocks.userData,
    getVersion: () => "1.0.0"
  },
  BrowserWindow: { getAllWindows: () => [] },
  nativeTheme: { shouldUseDarkColors: false }
}));

import {
  defaultSettings,
  mergeSettings
} from "../desktop-settings-service";
import {
  DesktopSettingsStore,
  __setDesktopSettingsStoreForTests
} from "../desktop-settings-store";
import { getStartupBackgroundColor } from "../startup-appearance";

afterEach(() => {
  __setDesktopSettingsStoreForTests(null);
});

describe("startup appearance settings store wiring", () => {
  test("repeated window appearance reads use the hydrated snapshot", async () => {
    mocks.userData = mkdtempSync(join(tmpdir(), "pwrsnap-window-settings-"));
    const light = mergeSettings(defaultSettings(), {
      appearance: { theme: "light" }
    });
    const readTextFile = vi.fn(async () => JSON.stringify(light));
    const store = new DesktopSettingsStore({
      filePath: join(mocks.userData, "pwrsnap-settings.json"),
      readTextFile
    });
    __setDesktopSettingsStoreForTests(store);
    await store.read();

    // If startup-appearance bypassed the store, this external dark value
    // would be observed by the next BrowserWindow construction.
    const dark = mergeSettings(light, { appearance: { theme: "dark" } });
    writeFileSync(
      join(mocks.userData, "pwrsnap-settings.json"),
      JSON.stringify(dark),
      "utf8"
    );

    expect(getStartupBackgroundColor()).toBe("#ffffff");
    expect(getStartupBackgroundColor()).toBe("#ffffff");
    expect(readTextFile).toHaveBeenCalledTimes(1);
  });

  test("a relayed trusted snapshot updates later window construction without disk I/O", async () => {
    const readTextFile = vi.fn(async () => JSON.stringify(defaultSettings()));
    const store = new DesktopSettingsStore({
      filePath: "/tmp/pwrsnap-startup-appearance-store-test/settings.json",
      readTextFile
    });
    __setDesktopSettingsStoreForTests(store);
    await store.read();

    store.applyExternalSnapshot(
      mergeSettings(defaultSettings(), { appearance: { theme: "light" } })
    );

    expect(getStartupBackgroundColor()).toBe("#ffffff");
    expect(readTextFile).toHaveBeenCalledTimes(1);
  });
});
