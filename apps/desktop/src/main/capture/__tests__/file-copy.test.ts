// The two halves of a video duplicate's copy: the clone that makes it
// instant where the volume allows, and the streamed byte copy that reports
// progress and can be stopped where it does not.

import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { cloneFileFast, streamCopyFile } from "../file-copy";

let dir: string;
const payload = Buffer.from(Array.from({ length: 10_000 }, (_, i) => i % 251));

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pwrsnap-file-copy-"));
  await writeFile(join(dir, "source.mp4"), payload);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("streamCopyFile", () => {
  test("copies every byte and reports progress chunk by chunk", async () => {
    const dest = join(dir, "copy-progress.mp4");
    const reports: Array<[number, number]> = [];
    const copied = await streamCopyFile(join(dir, "source.mp4"), dest, {
      chunkBytes: 4096,
      onProgress: (bytes, total) => reports.push([bytes, total])
    });
    expect(copied).toBe(payload.length);
    expect(await readFile(dest)).toEqual(payload);
    expect(reports).toEqual([
      [0, 10_000],
      [4096, 10_000],
      [8192, 10_000],
      [10_000, 10_000]
    ]);
  });

  test("an abort mid-copy removes the partial destination", async () => {
    const dest = join(dir, "copy-aborted.mp4.partial");
    const controller = new AbortController();
    await expect(
      streamCopyFile(join(dir, "source.mp4"), dest, {
        chunkBytes: 1024,
        signal: controller.signal,
        onProgress: (bytes) => {
          if (bytes >= 3072) controller.abort(new Error("user cancelled"));
        }
      })
    ).rejects.toThrow("user cancelled");
    await expect(stat(dest)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("a failure mid-copy removes the partial destination", async () => {
    const dest = join(dir, "copy-failed.mp4.partial");
    await expect(
      streamCopyFile(join(dir, "source.mp4"), dest, {
        chunkBytes: 1024,
        onProgress: (bytes) => {
          if (bytes >= 2048) throw new Error("disk unplugged");
        }
      })
    ).rejects.toThrow("disk unplugged");
    await expect(stat(dest)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("never overwrites — or removes — a destination it did not create", async () => {
    const dest = join(dir, "someone-elses.mp4");
    await writeFile(dest, "keep me");
    await expect(streamCopyFile(join(dir, "source.mp4"), dest)).rejects.toMatchObject({
      code: "EEXIST"
    });
    expect(await readFile(dest, "utf8")).toBe("keep me");
  });
});

describe("cloneFileFast", () => {
  test("Windows has no clone: answers false without writing anything", async () => {
    const dest = join(dir, "win-clone.mp4");
    expect(await cloneFileFast(join(dir, "source.mp4"), dest, { platform: "win32" })).toBe(false);
    await expect(stat(dest)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("a source that cannot be read answers false and leaves no destination", async () => {
    const dest = join(dir, "missing-clone.mp4");
    expect(await cloneFileFast(join(dir, "no-such-source.mp4"), dest)).toBe(false);
    await expect(stat(dest)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.runIf(process.platform === "darwin")(
    "macOS: clones on the same volume (tmpdir is APFS)",
    async () => {
      const dest = join(dir, "mac-clone.mp4");
      expect(await cloneFileFast(join(dir, "source.mp4"), dest)).toBe(true);
      expect(await readFile(dest)).toEqual(payload);
    }
  );

  test.runIf(process.platform === "darwin")(
    "macOS: a clone attempt past the grace period is killed and cleaned up",
    async () => {
      // cp blocks forever opening a FIFO with no writer: a stand-in for a
      // fallback byte copy, which cp gives no other sign of.
      const fifo = join(dir, "never-ending.mp4");
      execFileSync("/usr/bin/mkfifo", [fifo]);
      const dest = join(dir, "mac-slow-clone.mp4");
      const startedAt = Date.now();
      expect(await cloneFileFast(fifo, dest, { graceMs: 100 })).toBe(false);
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect((await readdir(dir)).includes("mac-slow-clone.mp4")).toBe(false);
    }
  );
});
