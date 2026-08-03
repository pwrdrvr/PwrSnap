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
      disposeRegionSelector: vi.fn(),
      disposeFocusSink: vi.fn(),
      destroyTextBakePool: vi.fn()
    };

    const disposeTransientWindows = installTransientWindowTeardown(app, disposers);

    expect(app.on).toHaveBeenCalledWith("before-quit", expect.any(Function));
    expect(beforeQuitListener).not.toBeNull();
    beforeQuitListener!();
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
});
