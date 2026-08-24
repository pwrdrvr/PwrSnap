import { describe, expect, it, vi } from "vitest";
import { installTransientWindowTeardown } from "../transient-window-teardown";

describe("installTransientWindowTeardown", () => {
  it("registers synchronous transient disposal on before-quit and is idempotent", () => {
    let beforeQuitListener: (() => void) | null = null;
    const app = {
      on: vi.fn((event: "before-quit", listener: () => void) => {
        expect(event).toBe("before-quit");
        beforeQuitListener = listener;
      })
    };
    const disposers = {
      disposeTray: vi.fn(),
      disposeFloatOver: vi.fn(),
      disposeRecordingController: vi.fn(),
      disposeRegionSelector: vi.fn(),
      disposeFocusSink: vi.fn(),
      destroyTextBakePool: vi.fn()
    };

    const disposeTransientWindows = installTransientWindowTeardown(app, disposers);

    expect(app.on).toHaveBeenCalledWith("before-quit", expect.any(Function));
    expect(beforeQuitListener).not.toBeNull();
    beforeQuitListener!();
    expect(disposers.disposeRecordingController).toHaveBeenCalledTimes(1);
    for (const dispose of Object.values(disposers)) {
      expect(dispose).toHaveBeenCalledTimes(1);
    }

    // Electron may enter the handler more than once when a quit is deferred,
    // and index.ts calls the returned helper again from will-quit defensively.
    beforeQuitListener!();
    disposeTransientWindows();
    for (const dispose of Object.values(disposers)) {
      expect(dispose).toHaveBeenCalledTimes(1);
    }
  });

  it("leaves transient windows intact during a deferred Sizzle quit", () => {
    let beforeQuitListener: (() => void) | null = null;
    const app = {
      on: vi.fn((_event: "before-quit", listener: () => void) => {
        beforeQuitListener = listener;
      })
    };
    const disposeTray = vi.fn();
    let deferred = true;
    installTransientWindowTeardown(
      app,
      {
        disposeTray,
        disposeFloatOver: vi.fn(),
        disposeRegionSelector: vi.fn(),
        disposeFocusSink: vi.fn(),
        destroyTextBakePool: vi.fn()
      },
      { shouldDisposeOnBeforeQuit: () => !deferred }
    );

    beforeQuitListener!();
    expect(disposeTray).not.toHaveBeenCalled();

    deferred = false;
    beforeQuitListener!();
    expect(disposeTray).toHaveBeenCalledOnce();
  });
});
