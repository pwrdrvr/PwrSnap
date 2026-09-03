// Deterministic hot-path counter for the shared image-capture settings gate.
// capture:interactive, capture:fullScreen, and capture:allScreens each call
// startCursorSampleIfEnabled(); the process-owned store must hydrate once and
// must not turn those repeated entries into disk reads or agent discovery.

import { afterEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sampleCursor: vi.fn(async () => null)
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => "/tmp/pwrsnap-cursor-settings-test",
    getVersion: () => "1.0.0"
  },
  BrowserWindow: { getAllWindows: () => [] }
}));

vi.mock("../cursor-sample", () => ({
  sampleCursor: mocks.sampleCursor
}));

import {
  defaultSettings
} from "../../settings/desktop-settings-service";
import {
  DesktopSettingsStore,
  __setDesktopSettingsStoreForTests
} from "../../settings/desktop-settings-store";
import { startCursorSampleIfEnabled } from "../cursor-capture-settings";

afterEach(() => {
  __setDesktopSettingsStoreForTests(null);
  mocks.sampleCursor.mockClear();
  vi.restoreAllMocks();
});

describe("image-capture settings hot path", () => {
  test("three repeated capture entries perform one disk read and zero discovery passes", async () => {
    const readTextFile = vi.fn(async () => JSON.stringify(defaultSettings()));
    const store = new DesktopSettingsStore({
      filePath: "/tmp/pwrsnap-cursor-settings-test/pwrsnap-settings.json",
      readTextFile
    });
    __setDesktopSettingsStoreForTests(store);

    const codexDiscovery = await import("../../settings/codex-discovery");
    const discoverSpy = vi.spyOn(codexDiscovery, "discoverCodexCommands");

    await Promise.all([
      startCursorSampleIfEnabled(), // capture:interactive
      startCursorSampleIfEnabled(), // capture:fullScreen
      startCursorSampleIfEnabled() // capture:allScreens
    ]);

    expect(readTextFile).toHaveBeenCalledTimes(1);
    expect(mocks.sampleCursor).toHaveBeenCalledTimes(3);
    expect(discoverSpy).not.toHaveBeenCalled();
  });
});
