import { beforeEach, describe, expect, test, vi } from "vitest";

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn()
}));

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock
}));

import {
  resolveAboutPanelBuildVersion,
  resolveDevelopmentRuntimeIdentity,
  resolveRuntimeIdentity
} from "../runtime-identity";

describe("runtime identity", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
  });

  test("resolves the current Git branch", () => {
    execFileSyncMock.mockReturnValue("agent/show-dev-git-branch\n");

    expect(resolveRuntimeIdentity("/repo/PwrSnap")).toEqual({
      branch: "agent/show-dev-git-branch",
      cwd: "/repo/PwrSnap"
    });
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "git",
      ["-C", "/repo/PwrSnap", "branch", "--show-current"],
      expect.objectContaining({
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      })
    );
  });

  test("falls back to the commit when HEAD is detached", () => {
    execFileSyncMock
      .mockReturnValueOnce("\n")
      .mockImplementationOnce(() => {
        throw new Error("not symbolic");
      })
      .mockReturnValueOnce("ab12cd3344556677889900aabbccddeeff001122\n");

    expect(resolveRuntimeIdentity("/repo/PwrSnap")).toEqual({
      commitSha: "ab12cd3344556677889900aabbccddeeff001122",
      cwd: "/repo/PwrSnap",
      detachedHead: true
    });
  });

  test("returns only the cwd outside a Git checkout", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("not a repository");
    });

    expect(resolveRuntimeIdentity("/Applications/PwrSnap.app")).toEqual({
      cwd: "/Applications/PwrSnap.app"
    });
  });

  test("exposes runtime identity only for a development checkout", () => {
    execFileSyncMock.mockReturnValue("agent/show-dev-branch-in-about\n");

    expect(resolveDevelopmentRuntimeIdentity({
      isPackaged: false,
      nodeEnv: "development",
      cwd: "/repo/PwrSnap"
    })).toEqual({
      branch: "agent/show-dev-branch-in-about",
      cwd: "/repo/PwrSnap"
    });

    execFileSyncMock.mockClear();
    expect(resolveDevelopmentRuntimeIdentity({
      isPackaged: true,
      nodeEnv: "development",
      cwd: "/repo/PwrSnap"
    })).toBeUndefined();
    expect(resolveDevelopmentRuntimeIdentity({
      isPackaged: false,
      nodeEnv: "production",
      cwd: "/repo/PwrSnap"
    })).toBeUndefined();
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  test("uses the development identity as the native About build value", () => {
    expect(resolveAboutPanelBuildVersion("1.0.0", {
      branch: "agent/show-dev-branch-in-about",
      cwd: "/repo/PwrSnap"
    })).toBe("agent/show-dev-branch-in-about");
    expect(resolveAboutPanelBuildVersion("1.0.0", {
      commitSha: "ab12cd3344556677889900aabbccddeeff001122",
      cwd: "/repo/PwrSnap",
      detachedHead: true
    })).toBe("HEAD ab12cd33");
    expect(resolveAboutPanelBuildVersion("1.0.0", undefined)).toBe("1.0.0");
  });
});
