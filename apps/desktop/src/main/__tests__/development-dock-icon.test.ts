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
    getAppPath: vi.fn(() => "/test/app"),
    icon,
    warn: vi.fn()
  };
});

vi.mock("electron", () => ({
  app: {
    dock: {
      show: mocks.dockShow,
      setIcon: mocks.dockSetIcon
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

  it("reapplies the development icon around Dock show", async () => {
    const { showDockWithDevelopmentIcon } = await import("../development-dock-icon");

    showDockWithDevelopmentIcon({ platform: "darwin", nodeEnv: "development" });
    await Promise.resolve();

    expect(mocks.dockShow).toHaveBeenCalledTimes(1);
    expect(mocks.dockSetIcon).toHaveBeenCalledTimes(2);
    expect(mocks.dockSetIcon).toHaveBeenNthCalledWith(1, mocks.icon);
    expect(mocks.dockSetIcon).toHaveBeenNthCalledWith(2, mocks.icon);
  });
});
