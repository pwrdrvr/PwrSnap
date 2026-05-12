import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const icon = {
    isEmpty: vi.fn(() => false)
  };

  return {
    createFromPath: vi.fn(() => icon),
    dockSetIcon: vi.fn(),
    getAppPath: vi.fn(() => "/test/app"),
    icon,
    warn: vi.fn()
  };
});

vi.mock("electron", () => ({
  app: {
    dock: {
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

import { installDevelopmentDockIcon } from "../development-dock-icon";

describe("installDevelopmentDockIcon", () => {
  beforeEach(() => {
    mocks.createFromPath.mockClear();
    mocks.dockSetIcon.mockClear();
    mocks.getAppPath.mockClear();
    mocks.icon.isEmpty.mockReset();
    mocks.icon.isEmpty.mockReturnValue(false);
    mocks.warn.mockClear();
  });

  it("uses the PwrSnap icon for the development Dock icon on macOS", () => {
    installDevelopmentDockIcon({ platform: "darwin", nodeEnv: "development" });

    expect(mocks.createFromPath).toHaveBeenCalledWith("/test/app/build/icon.png");
    expect(mocks.dockSetIcon).toHaveBeenCalledWith(mocks.icon);
  });

  it("skips the Dock icon outside macOS", () => {
    installDevelopmentDockIcon({ platform: "linux", nodeEnv: "development" });

    expect(mocks.createFromPath).not.toHaveBeenCalled();
    expect(mocks.dockSetIcon).not.toHaveBeenCalled();
  });

  it("skips the Dock icon in production", () => {
    installDevelopmentDockIcon({ platform: "darwin", nodeEnv: "production" });

    expect(mocks.createFromPath).not.toHaveBeenCalled();
    expect(mocks.dockSetIcon).not.toHaveBeenCalled();
  });

  it("warns and leaves the Dock icon unchanged when the icon cannot load", () => {
    mocks.icon.isEmpty.mockReturnValue(true);

    installDevelopmentDockIcon({ platform: "darwin", nodeEnv: "development" });

    expect(mocks.warn).toHaveBeenCalledWith("failed to load development dock icon", {
      iconPath: "/test/app/build/icon.png"
    });
    expect(mocks.dockSetIcon).not.toHaveBeenCalled();
  });
});
