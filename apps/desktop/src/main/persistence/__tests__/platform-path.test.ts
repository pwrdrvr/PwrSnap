import { describe, expect, test, vi } from "vitest";
import { win32 } from "node:path";

import {
  inspectRenameDestination,
  renameWithCaseSupport
} from "../platform-path";

type Identity = { dev: bigint; ino: bigint };

function missing(filePath: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`ENOENT: ${filePath}`);
  error.code = "ENOENT";
  return error;
}

describe("filesystem path identity", () => {
  test.each([
    [
      String.raw`C:\Captures\Demo.PWRSNAP`,
      String.raw`c:\captures\demo.pwrsnap`,
      ["Demo.PWRSNAP"]
    ],
    [
      String.raw`\\agent-share\local agents\QWEN.CMD`,
      String.raw`\\AGENT-SHARE\LOCAL AGENTS\qwen.cmd`,
      ["QWEN.CMD"]
    ]
  ])("recognizes drive and UNC aliases only from file identity", async (current, desired, names) => {
    const identity = { dev: 7n, ino: 9_007_199_254_740_993n };
    await expect(
      inspectRenameDestination(current, desired, {
        statFile: async () => identity,
        readDirectory: async () => names,
        pathImpl: win32
      })
    ).resolves.toEqual({
      kind: "same-entry",
      currentNamePresent: true,
      desiredNamePresent: false
    });
  });

  test("treats a missing Darwin spelling as an ordinary direct rename", async () => {
    const current = "/Volumes/CaseSensitive/Demo.PWRSNAP";
    const desired = "/Volumes/CaseSensitive/demo.pwrsnap";
    await expect(
      inspectRenameDestination(current, desired, {
        statFile: async (filePath) => {
          if (filePath === desired) throw missing(filePath);
          return { dev: 4n, ino: 8n };
        }
      })
    ).resolves.toEqual({ kind: "absent" });
  });

  test("never folds a distinct case-sensitive destination", async () => {
    const current = "/Volumes/CaseSensitive/Demo.PWRSNAP";
    const desired = "/Volumes/CaseSensitive/demo.pwrsnap";
    const renameFile = vi.fn(async () => undefined);
    const statFile = async (filePath: string): Promise<Identity> =>
      filePath === current ? { dev: 4n, ino: 10n } : { dev: 4n, ino: 11n };

    await expect(
      inspectRenameDestination(current, desired, { statFile })
    ).resolves.toEqual({ kind: "occupied" });
    await expect(
      renameWithCaseSupport(current, desired, { statFile, renameFile })
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(renameFile).not.toHaveBeenCalled();
  });

  test("does not collapse two hard-link names with the same identity", async () => {
    await expect(
      inspectRenameDestination("/captures/Demo.mp4", "/captures/demo.mp4", {
        statFile: async () => ({ dev: 1n, ino: 2n }),
        readDirectory: async () => ["Demo.mp4", "demo.mp4"]
      })
    ).resolves.toEqual({ kind: "occupied" });
  });

  test("fails closed when a filesystem reports an unreliable zero inode", async () => {
    await expect(
      inspectRenameDestination(
        String.raw`\\server\share\Demo.mp4`,
        String.raw`\\server\share\demo.mp4`,
        { statFile: async () => ({ dev: 0n, ino: 0n }) }
      )
    ).resolves.toEqual({ kind: "ambiguous" });
  });

  test("uses one direct rename when the desired path is absent", async () => {
    const current = "/Volumes/CaseSensitive/Demo.PWRSNAP";
    const desired = "/Volumes/CaseSensitive/demo.pwrsnap";
    const renameFile = vi.fn(async () => undefined);
    await renameWithCaseSupport(current, desired, {
      statFile: async (filePath) => {
        if (filePath === desired) throw missing(filePath);
        return { dev: 1n, ino: 2n };
      },
      renameFile
    });
    expect(renameFile).toHaveBeenCalledOnce();
    expect(renameFile).toHaveBeenCalledWith(current, desired);
  });

  test("case-alias recovery hop keeps the asset extension", async () => {
    const current = String.raw`C:\Captures\Demo.PWRSNAP`;
    const desired = String.raw`C:\Captures\demo.pwrsnap`;
    const recovery = String.raw`C:\Captures\.pwrsnap-case-rename-test.PWRSNAP`;
    let movedToRecovery = false;
    const renameFile = vi.fn(async (from: string, to: string) => {
      if (from === current && to === recovery) movedToRecovery = true;
    });
    const statFile = async (filePath: string): Promise<Identity> => {
      if (filePath === recovery) throw missing(filePath);
      if (filePath === desired && movedToRecovery) throw missing(filePath);
      return { dev: 3n, ino: 4n };
    };

    await renameWithCaseSupport(current, desired, {
        statFile,
        readDirectory: async () => ["Demo.PWRSNAP"],
        renameFile,
        recoveryPath: recovery,
        pathImpl: win32
    });
    expect(renameFile.mock.calls).toEqual([
      [current, recovery],
      [recovery, desired]
    ]);
    expect(recovery.endsWith(".PWRSNAP")).toBe(true);
  });

  test("promotion failure leaves the discoverable recovery file in place", async () => {
    const current = "/Users/me/Demo.MP4";
    const desired = "/Users/me/demo.mp4";
    const recovery = "/Users/me/.pwrsnap-case-rename-test.MP4";
    let movedToRecovery = false;
    const promotionError = new Error("promote failed");
    const renameFile = vi.fn(async (from: string, to: string) => {
      if (from === current && to === recovery) {
        movedToRecovery = true;
        return;
      }
      throw promotionError;
    });
    const statFile = async (filePath: string): Promise<Identity> => {
      if (filePath === recovery) throw missing(filePath);
      if (filePath === desired && movedToRecovery) throw missing(filePath);
      return { dev: 3n, ino: 4n };
    };

    await expect(
      renameWithCaseSupport(current, desired, {
        statFile,
        readDirectory: async () => ["Demo.MP4"],
        renameFile,
        recoveryPath: recovery
      })
    ).rejects.toBe(promotionError);
    expect(renameFile.mock.calls).toEqual([
      [current, recovery],
      [recovery, desired]
    ]);
  });
});
