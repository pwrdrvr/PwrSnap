import { readFile } from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import {
  installProductionQuitTeardown,
  type ProductionQuitTeardownDependencies
} from "../production-quit-teardown";

function makeDependencies(
  overrides: Partial<ProductionQuitTeardownDependencies> = {}
): ProductionQuitTeardownDependencies {
  return {
    isRecordingActive: vi.fn(() => false),
    cancelRecording: vi.fn(async () => undefined),
    warnRecordingCancelFailure: vi.fn(),
    unregisterGlobalShortcuts: vi.fn(),
    stopLibraryProcess: vi.fn(),
    disposeCodexProfileHandlers: vi.fn(),
    disposeTransientWindows: vi.fn(),
    disposeIpcDispatcher: vi.fn(),
    stopToolRpcServer: vi.fn(async () => undefined),
    closeAcpAgentPool: vi.fn(async () => undefined),
    closeCodexAgentPool: vi.fn(async () => undefined),
    disposeLocalAgentMcpSettingsListener: vi.fn(),
    disableLocalAgentMcpLifecycle: vi.fn(),
    denyLocalAgentConsent: vi.fn(),
    shutdownCompositeThumbnailWorker: vi.fn(),
    cancelScheduledRepacks: vi.fn(),
    closeDatabase: vi.fn(),
    ...overrides
  };
}

describe("production graceful-quit teardown", () => {
  test("executes every production teardown dependency and closes the database last", () => {
    let willQuit: ((event: { preventDefault(): void }) => void) | undefined;
    const dependencies = makeDependencies();
    installProductionQuitTeardown(
      {
        onWillQuit: (listener) => {
          willQuit = listener;
        },
        quit: vi.fn()
      },
      dependencies
    );

    expect(willQuit).toBeDefined();
    willQuit?.({ preventDefault: vi.fn() });

    for (const dependency of [
      dependencies.unregisterGlobalShortcuts,
      dependencies.stopLibraryProcess,
      dependencies.disposeCodexProfileHandlers,
      dependencies.disposeTransientWindows,
      dependencies.disposeIpcDispatcher,
      dependencies.stopToolRpcServer,
      dependencies.closeAcpAgentPool,
      dependencies.closeCodexAgentPool,
      dependencies.disposeLocalAgentMcpSettingsListener,
      dependencies.disableLocalAgentMcpLifecycle,
      dependencies.denyLocalAgentConsent,
      dependencies.shutdownCompositeThumbnailWorker,
      dependencies.cancelScheduledRepacks,
      dependencies.closeDatabase
    ]) {
      expect(dependency).toHaveBeenCalledTimes(1);
    }
    expect(vi.mocked(dependencies.closeDatabase)).toHaveBeenCalledAfter(
      vi.mocked(dependencies.cancelScheduledRepacks)
    );
  });

  test("cancels an active recording and retries through the same quit path", async () => {
    let recordingActive = true;
    let willQuit: ((event: { preventDefault(): void }) => void) | undefined;
    const quit = vi.fn();
    const dependencies = makeDependencies({
      isRecordingActive: () => recordingActive
    });
    installProductionQuitTeardown(
      {
        onWillQuit: (listener) => {
          willQuit = listener;
        },
        quit
      },
      dependencies
    );
    const preventDefault = vi.fn();

    willQuit?.({ preventDefault });
    await Promise.resolve();
    await Promise.resolve();

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(dependencies.cancelRecording).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
    expect(dependencies.closeDatabase).not.toHaveBeenCalled();

    recordingActive = false;
    willQuit?.({ preventDefault });
    expect(dependencies.closeDatabase).toHaveBeenCalledTimes(1);
  });

  test("registers the production handler before app readiness and packaged smoke", async () => {
    const source = await readFile(
      new URL("../index.ts", import.meta.url),
      "utf8"
    );
    const teardownInstallIndex = source.indexOf("\n  installProductionQuitTeardown(");
    const whenReadyIndex = source.indexOf("app.whenReady().then");
    const packagedSmokeIndex = source.indexOf("runPackagedWindowsSmokeIfRequested({");

    expect(teardownInstallIndex).toBeGreaterThan(-1);
    expect(whenReadyIndex).toBeGreaterThan(teardownInstallIndex);
    expect(packagedSmokeIndex).toBeGreaterThan(whenReadyIndex);
  });
});
