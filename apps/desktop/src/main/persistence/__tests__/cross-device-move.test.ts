import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { moveFileWithExdevFallback } from "../cross-device-move";

function fileError(code: string, message = code): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

let workRoot: string;
let sourceDir: string;
let destinationDir: string;

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "pwrsnap-cross-device-move-"));
  sourceDir = join(workRoot, "source");
  destinationDir = join(workRoot, "destination");
  await mkdir(sourceDir, { recursive: true });
  await mkdir(destinationDir, { recursive: true });
});

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

describe("moveFileWithExdevFallback", () => {
  test("keeps the normal path as one rename", async () => {
    const sourcePath = join(sourceDir, "clip.mp4");
    const destinationPath = join(destinationDir, "clip.mp4");
    await writeFile(sourcePath, "video-bytes");
    let renameCalls = 0;

    await moveFileWithExdevFallback(sourcePath, destinationPath, {
      rename: async (from, to) => {
        renameCalls += 1;
        await rename(from, to);
      },
      copyFile: async () => {
        throw new Error("copy fallback must not run on the same-volume path");
      }
    });

    expect(renameCalls).toBe(1);
    expect(existsSync(sourcePath)).toBe(false);
    expect(await readFile(destinationPath, "utf8")).toBe("video-bytes");
  });

  test("on EXDEV installs a synced destination-sibling copy before deleting the source", async () => {
    const sourcePath = join(sourceDir, "clip.mp4");
    const destinationPath = join(destinationDir, "clip.mp4");
    await writeFile(sourcePath, "video-bytes");
    const events: string[] = [];
    let firstRename = true;

    await moveFileWithExdevFallback(sourcePath, destinationPath, {
      rename: async (from, to) => {
        if (firstRename) {
          firstRename = false;
          events.push("rename-source");
          throw fileError("EXDEV");
        }
        events.push("rename-staging");
        expect(dirname(from)).toBe(destinationDir);
        expect(basename(from).startsWith(".")).toBe(true);
        await rename(from, to);
      },
      syncFile: async (path) => {
        events.push("sync-staging");
        expect(dirname(path)).toBe(destinationDir);
        expect(basename(path).startsWith(".")).toBe(true);
      },
      syncDirectory: async (path) => {
        events.push("sync-destination-directory");
        expect(path).toBe(destinationDir);
      },
      unlink: async (path) => {
        events.push(path === sourcePath ? "unlink-source" : "unlink-other");
        await unlink(path);
      },
      uniqueSuffix: () => "test-suffix"
    });

    expect(events).toEqual([
      "rename-source",
      "sync-staging",
      "rename-staging",
      "sync-destination-directory",
      "unlink-source"
    ]);
    expect(existsSync(sourcePath)).toBe(false);
    expect(await readFile(destinationPath, "utf8")).toBe("video-bytes");
    expect(await readdir(destinationDir)).toEqual(["clip.mp4"]);
  });

  test("does not copy for a rename error other than EXDEV", async () => {
    const sourcePath = join(sourceDir, "clip.mp4");
    const destinationPath = join(destinationDir, "clip.mp4");
    await writeFile(sourcePath, "video-bytes");
    let copyCalled = false;

    await expect(
      moveFileWithExdevFallback(sourcePath, destinationPath, {
        rename: async () => {
          throw fileError("EPERM");
        },
        copyFile: async () => {
          copyCalled = true;
        }
      })
    ).rejects.toMatchObject({ code: "EPERM" });

    expect(copyCalled).toBe(false);
    expect(await readFile(sourcePath, "utf8")).toBe("video-bytes");
    expect(existsSync(destinationPath)).toBe(false);
  });

  test("cleans the staging copy and preserves the source when final rename fails", async () => {
    const sourcePath = join(sourceDir, "clip.mp4");
    const destinationPath = join(destinationDir, "clip.mp4");
    await writeFile(sourcePath, "video-bytes");
    let renameCalls = 0;

    await expect(
      moveFileWithExdevFallback(sourcePath, destinationPath, {
        rename: async () => {
          renameCalls += 1;
          if (renameCalls === 1) throw fileError("EXDEV");
          throw fileError("EIO", "destination rename failed");
        },
        uniqueSuffix: () => "failed-final-rename"
      })
    ).rejects.toMatchObject({ code: "EIO" });

    expect(await readFile(sourcePath, "utf8")).toBe("video-bytes");
    expect(existsSync(destinationPath)).toBe(false);
    expect(await readdir(destinationDir)).toEqual([]);
  });

  test("retains both completed copies when source deletion fails", async () => {
    const sourcePath = join(sourceDir, "clip.mp4");
    const destinationPath = join(destinationDir, "clip.mp4");
    await writeFile(sourcePath, "video-bytes");
    let firstRename = true;

    await expect(
      moveFileWithExdevFallback(sourcePath, destinationPath, {
        rename: async (from, to) => {
          if (firstRename) {
            firstRename = false;
            throw fileError("EXDEV");
          }
          await rename(from, to);
        },
        unlink: async (path) => {
          if (path === sourcePath) throw fileError("EPERM", "source delete failed");
          await unlink(path);
        },
        uniqueSuffix: () => "source-delete-failure"
      })
    ).rejects.toMatchObject({ code: "EPERM" });

    expect(await readFile(sourcePath, "utf8")).toBe("video-bytes");
    expect(await readFile(destinationPath, "utf8")).toBe("video-bytes");
    expect(await readdir(destinationDir)).toEqual(["clip.mp4"]);
  });

  test("retains both completed copies when destination directory sync fails", async () => {
    const sourcePath = join(sourceDir, "clip.mp4");
    const destinationPath = join(destinationDir, "clip.mp4");
    await writeFile(sourcePath, "video-bytes");
    const events: string[] = [];
    let firstRename = true;

    await expect(
      moveFileWithExdevFallback(sourcePath, destinationPath, {
        rename: async (from, to) => {
          if (firstRename) {
            firstRename = false;
            events.push("rename-source");
            throw fileError("EXDEV");
          }
          events.push("rename-staging");
          await rename(from, to);
        },
        syncDirectory: async (path) => {
          events.push("sync-destination-directory");
          expect(path).toBe(destinationDir);
          throw fileError("EIO", "destination directory sync failed");
        },
        unlink: async (path) => {
          events.push(path === sourcePath ? "unlink-source" : "unlink-other");
          await unlink(path);
        },
        uniqueSuffix: () => "directory-sync-failure"
      })
    ).rejects.toMatchObject({ code: "EIO" });

    expect(events).toEqual([
      "rename-source",
      "rename-staging",
      "sync-destination-directory"
    ]);
    expect(await readFile(sourcePath, "utf8")).toBe("video-bytes");
    expect(await readFile(destinationPath, "utf8")).toBe("video-bytes");
    expect(await readdir(destinationDir)).toEqual(["clip.mp4"]);
  });
});
