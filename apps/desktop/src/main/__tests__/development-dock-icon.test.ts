import { beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";

const ICON_PATH = join("/test/app", "build", "icon.png");

const mocks = vi.hoisted(() => {
  const icon = {
    isEmpty: vi.fn(() => false)
  };

  return {
    createFromPath: vi.fn(() => icon),
    dockSetIcon: vi.fn(),
    dockShow: vi.fn(() => Promise.resolve()),
    dockIsVisible: vi.fn(() => true),
    getAppPath: vi.fn(() => "/test/app"),
    icon,
    warn: vi.fn()
  };
});

vi.mock("electron", () => ({
  app: {
    dock: {
      show: mocks.dockShow,
      setIcon: mocks.dockSetIcon,
      isVisible: mocks.dockIsVisible
    },
    getAppPath: mocks.getAppPath
  },
  nativeImage: {
    createFromPath: mocks.createFromPath
  }
}));

vi.mock("../log", () => ({
  getMainLogger: vi.fn(() => ({
    warn: mocks.warn
  }))
}));

describe("installDevelopmentDockIcon", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.createFromPath.mockClear();
    mocks.dockSetIcon.mockClear();
    mocks.dockShow.mockClear();
    mocks.dockShow.mockImplementation(() => Promise.resolve());
    mocks.dockIsVisible.mockReset();
    mocks.dockIsVisible.mockReturnValue(true);
    mocks.getAppPath.mockClear();
    mocks.icon.isEmpty.mockReset();
    mocks.icon.isEmpty.mockReturnValue(false);
    mocks.warn.mockClear();
  });

  it("uses the PwrSnap icon for the development Dock icon on macOS", async () => {
    const { installDevelopmentDockIcon } = await import("../development-dock-icon");

    installDevelopmentDockIcon({ platform: "darwin", nodeEnv: "development" });

    expect(mocks.createFromPath).toHaveBeenCalledWith(ICON_PATH);
    expect(mocks.dockSetIcon).toHaveBeenCalledWith(mocks.icon);
  });

  it("skips the Dock icon outside macOS", async () => {
    const { installDevelopmentDockIcon } = await import("../development-dock-icon");

    installDevelopmentDockIcon({ platform: "linux", nodeEnv: "development" });

    expect(mocks.createFromPath).not.toHaveBeenCalled();
    expect(mocks.dockSetIcon).not.toHaveBeenCalled();
  });

  it("skips the Dock icon in production", async () => {
    const { installDevelopmentDockIcon } = await import("../development-dock-icon");

    installDevelopmentDockIcon({ platform: "darwin", nodeEnv: "production" });

    expect(mocks.createFromPath).not.toHaveBeenCalled();
    expect(mocks.dockSetIcon).not.toHaveBeenCalled();
  });

  it("warns and leaves the Dock icon unchanged when the icon cannot load", async () => {
    const { installDevelopmentDockIcon } = await import("../development-dock-icon");
    mocks.icon.isEmpty.mockReturnValue(true);

    installDevelopmentDockIcon({ platform: "darwin", nodeEnv: "development" });

    expect(mocks.warn).toHaveBeenCalledWith("failed to load development dock icon", {
      iconPath: ICON_PATH
    });
    expect(mocks.dockSetIcon).not.toHaveBeenCalled();
  });

  it("skips setIcon while the Dock tile is hidden (Accessory) — phantom-tile guard", async () => {
    const { installDevelopmentDockIcon } = await import("../development-dock-icon");
    mocks.dockIsVisible.mockReturnValue(false);

    installDevelopmentDockIcon({ platform: "darwin", nodeEnv: "development" });

    // No tile exists yet — setIcon here would race tile creation and
    // spawn the phantom. Must be a no-op.
    expect(mocks.dockSetIcon).not.toHaveBeenCalled();
  });

  it("sets the icon AFTER the Dock is shown (never before the tile exists)", async () => {
    const { showDockWithDevelopmentIcon } = await import("../development-dock-icon");

    showDockWithDevelopmentIcon({ platform: "darwin", nodeEnv: "development" });
    // Synchronously, before show() resolves: no setIcon yet.
    expect(mocks.dockSetIcon).not.toHaveBeenCalled();

    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.dockShow).toHaveBeenCalledTimes(1);
    // Exactly once, and only after show() resolved (tile exists).
    expect(mocks.dockSetIcon).toHaveBeenCalledTimes(1);
    expect(mocks.dockSetIcon).toHaveBeenCalledWith(mocks.icon);
  });

  it("coalesces concurrent shows so overlapping transitions can't race", async () => {
    const { showDockWithDevelopmentIcon } = await import("../development-dock-icon");
    let resolveShow!: () => void;
    mocks.dockShow.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveShow = resolve;
        })
    );

    // Two back-to-back calls during the same (still-pending) transition.
    showDockWithDevelopmentIcon({ platform: "darwin", nodeEnv: "development" });
    showDockWithDevelopmentIcon({ platform: "darwin", nodeEnv: "development" });

    // Only one show() — the second call coalesced.
    expect(mocks.dockShow).toHaveBeenCalledTimes(1);

    resolveShow();
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.dockSetIcon).toHaveBeenCalledTimes(1);
  });
});
