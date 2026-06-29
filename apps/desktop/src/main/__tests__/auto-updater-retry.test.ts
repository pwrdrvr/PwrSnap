import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    appPaths: { userData: "", home: "" },
    handlers,
    autoUpdater: {
      allowPrerelease: false,
      autoDownload: false,
      autoInstallOnAppQuit: false,
      checkForUpdates: vi.fn(),
      currentVersion: { version: "1.0.0-beta.22" },
      logger: undefined as unknown,
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        const eventHandlers = handlers.get(event) ?? new Set();
        eventHandlers.add(handler);
        handlers.set(event, eventHandlers);
        return mocks.autoUpdater;
      }),
      quitAndInstall: vi.fn()
    },
    emit: (event: string, ...args: unknown[]) => {
      for (const handler of handlers.get(event) ?? []) handler(...args);
    }
  };
});

vi.mock("electron", (): Partial<typeof import("electron")> => ({
  app: {
    getVersion: () => "1.0.0-beta.22",
    getPath: (name: string) => {
      if (name === "userData") return mocks.appPaths.userData;
      if (name === "home") return mocks.appPaths.home;
      return "";
    }
  } as unknown as typeof import("electron").app,
  BrowserWindow: {
    getAllWindows: () => []
  } as unknown as typeof import("electron").BrowserWindow
}));

vi.mock("electron-updater", () => ({
  default: {
    autoUpdater: mocks.autoUpdater
  }
}));

function writeInstallAttempt(userData: string): void {
  writeFileSync(
    join(userData, "pwrsnap-update-install-attempt.json"),
    JSON.stringify({
      schemaVersion: 1,
      expectedVersion: "1.0.0-beta.23",
      fromVersion: "1.0.0-beta.22",
      channel: "prerelease",
      attemptedAt: "2026-06-29T12:00:00.000Z"
    }),
    "utf8"
  );
}

describe("auto-updater failed install retry", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const roots: string[] = [];

  afterEach(async () => {
    process.env.NODE_ENV = originalNodeEnv;
    mocks.handlers.clear();
    mocks.autoUpdater.checkForUpdates.mockReset();
    mocks.autoUpdater.quitAndInstall.mockReset();
    mocks.autoUpdater.on.mockClear();
    await vi.resetModules();
    while (roots.length > 0) {
      const root = roots.pop();
      if (root !== undefined) rmSync(root, { recursive: true, force: true });
    }
  });

  test("waits for the retry download event before installing", async () => {
    process.env.NODE_ENV = "production";
    const root = mkdtempSync(join(tmpdir(), "pwrsnap-updater-retry-"));
    roots.push(root);
    mocks.appPaths.userData = root;
    mocks.appPaths.home = root;
    writeInstallAttempt(root);
    mocks.autoUpdater.checkForUpdates.mockResolvedValue({
      updateInfo: { version: "1.0.0-beta.23" }
    });

    const { initAppUpdater, installDownloadedAppUpdate } = await import("../auto-updater");
    initAppUpdater();

    const installResult = installDownloadedAppUpdate();
    await vi.waitFor(() => {
      expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    });
    expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled();

    mocks.emit("update-downloaded", { version: "1.0.0-beta.23" });

    await expect(installResult).resolves.toEqual({ status: "restarting" });
    expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });
});
