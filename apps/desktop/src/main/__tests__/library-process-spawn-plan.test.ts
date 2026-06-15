// Spawn-plan computation for the library child process (§D2). The
// packaged/dev split is the part worth pinning: packaged Electron's
// execPath IS the app, dev's execPath is the bare runtime and needs
// the app dir argument or it boots Electron's default app.

import { describe, expect, test, vi } from "vitest";
import { ok } from "@pwrsnap/shared";

const mocks = vi.hoisted(() => ({
  bridgeClose: vi.fn(),
  childKill: vi.fn(),
  spawn: vi.fn()
}));

vi.mock("node:child_process", () => ({
  spawn: mocks.spawn
}));

vi.mock("electron", () => ({
  app: {
    getAppPath: () => "/repo/apps/desktop",
    isPackaged: false
  }
}));
vi.mock("../log", () => ({
  getMainLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}));
vi.mock("../process-bridge/channel", () => ({
  channelForChildProcess: vi.fn(() => ({}))
}));
vi.mock("../process-bridge/endpoint", () => ({
  BridgeEndpoint: class {
    close = mocks.bridgeClose;
    waitForPeer = vi.fn(async () => ok(undefined));
    dispatchRemote = vi.fn(async () => ok(undefined));
    emitEvent = vi.fn();
    cancelRemote = vi.fn();
  }
}));

const {
  ensureLibraryProcess,
  libraryProcessSpawnPlan,
  stopLibraryProcess
} = await import("../process-split/library-process-supervisor");

describe("libraryProcessSpawnPlan", () => {
  test("agent stop sends SIGTERM to the supervised library child", () => {
    const child = {
      exitCode: null,
      kill: mocks.childKill,
      on: vi.fn()
    };
    mocks.spawn.mockReturnValue(child);

    ensureLibraryProcess();
    stopLibraryProcess();

    expect(mocks.bridgeClose).toHaveBeenCalledTimes(1);
    expect(mocks.childKill).toHaveBeenCalledWith("SIGTERM");
  });

  test("packaged: relaunch our own binary with only the role flag", () => {
    expect(
      libraryProcessSpawnPlan({
        execPath: "/Applications/PwrSnap.app/Contents/MacOS/PwrSnap",
        appPath: "/Applications/PwrSnap.app/Contents/Resources/app.asar",
        isPackaged: true
      })
    ).toEqual({
      command: "/Applications/PwrSnap.app/Contents/MacOS/PwrSnap",
      args: ["--pwrsnap-role=library"]
    });
  });

  test("dev: bare Electron binary needs the app dir before the role flag", () => {
    expect(
      libraryProcessSpawnPlan({
        execPath: "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
        appPath: "/repo/apps/desktop",
        isPackaged: false
      })
    ).toEqual({
      command: "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      args: ["/repo/apps/desktop", "--pwrsnap-role=library"]
    });
  });
});
