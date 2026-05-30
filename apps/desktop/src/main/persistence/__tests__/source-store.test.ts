// Pins the trash + restore round-trip across both image (.png) and
// video (.mp4) source extensions. Pre-Fast-Video-Capture the helpers
// hardcoded `<id>.png` which would have lost any video source on
// soft-delete + restore; this test fails loud if that regression
// returns.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  capturesRoot: "",
  trashRoot: "",
  cacheRoot: "",
  readSourceFromBundle: vi.fn()
}));

vi.mock("../paths", () => ({
  getCapturesRoot: () => mocks.capturesRoot,
  getTrashRoot: () => mocks.trashRoot,
  getCacheRoot: () => mocks.cacheRoot,
  getCacheSourcePath: (id: string) => join(mocks.cacheRoot, id, "source.png")
}));

vi.mock("../bundle-store", () => ({
  readSourceFromBundle: (...args: unknown[]) => mocks.readSourceFromBundle(...args)
}));

vi.mock("../../log", () => ({
  getMainLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  })
}));

let tempRoot: string;

beforeEach(async () => {
  vi.resetModules();
  tempRoot = await mkdtemp(join(tmpdir(), "pwrsnap-source-store-"));
  mocks.capturesRoot = join(tempRoot, "captures");
  mocks.trashRoot = join(tempRoot, ".trash");
  mocks.cacheRoot = join(tempRoot, "render-cache");
  await mkdir(mocks.capturesRoot, { recursive: true });
  await mkdir(mocks.trashRoot, { recursive: true });
  await mkdir(mocks.cacheRoot, { recursive: true });
  mocks.readSourceFromBundle.mockReset();
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("source-store extension generalization", () => {
  test("moveSourceToTrash + restoreSourceFromTrash preserves .png", async () => {
    const { moveSourceToTrash, restoreSourceFromTrash, effectiveSrcPathFor } = await import(
      "../source-store"
    );
    const srcPath = join(mocks.capturesRoot, "img-1.png");
    await writeFile(srcPath, "fake-png-bytes");

    await moveSourceToTrash(srcPath, "img-1");
    expect(existsSync(srcPath)).toBe(false);
    expect(existsSync(join(mocks.trashRoot, "img-1.png"))).toBe(true);

    // effectiveSrcPathFor reads the extension from legacy_src_path even for
    // soft-deleted rows; this is what the protocol handler relies on.
    expect(
      effectiveSrcPathFor({ id: "img-1", legacy_src_path: srcPath, deleted_at: "2026-05-18T00:00:00Z" })
    ).toBe(join(mocks.trashRoot, "img-1.png"));

    await restoreSourceFromTrash("img-1", srcPath);
    expect(existsSync(srcPath)).toBe(true);
    expect(existsSync(join(mocks.trashRoot, "img-1.png"))).toBe(false);
    expect(await readFile(srcPath, "utf8")).toBe("fake-png-bytes");
  });

  test("moveSourceToTrash + restoreSourceFromTrash preserves .mp4", async () => {
    const { moveSourceToTrash, restoreSourceFromTrash, effectiveSrcPathFor } = await import(
      "../source-store"
    );
    const srcPath = join(mocks.capturesRoot, "vid-1.mp4");
    await writeFile(srcPath, "fake-mp4-bytes");

    await moveSourceToTrash(srcPath, "vid-1");
    expect(existsSync(srcPath)).toBe(false);
    expect(existsSync(join(mocks.trashRoot, "vid-1.mp4"))).toBe(true);
    expect(
      effectiveSrcPathFor({ id: "vid-1", legacy_src_path: srcPath, deleted_at: "2026-05-18T00:00:00Z" })
    ).toBe(join(mocks.trashRoot, "vid-1.mp4"));

    await restoreSourceFromTrash("vid-1", srcPath);
    expect(existsSync(srcPath)).toBe(true);
    expect(existsSync(join(mocks.trashRoot, "vid-1.mp4"))).toBe(false);
  });

  test("purgeOneFromTrash uses legacy_src_path extension", async () => {
    const { purgeOneFromTrash } = await import("../source-store");
    const trashPath = join(mocks.trashRoot, "vid-2.mp4");
    await writeFile(trashPath, "trashed");

    // purgeOneFromTrash takes the live legacy_src_path so it can read the
    // extension; for a .mp4 source it removes the .mp4 trash file
    // (not a phantom .png).
    await purgeOneFromTrash("vid-2", join(mocks.capturesRoot, "vid-2.mp4"));
    expect(existsSync(trashPath)).toBe(false);
  });

  test("sweepTrash cleans both .png and .mp4 files older than the cutoff", async () => {
    const { sweepTrash } = await import("../source-store");
    const oldPng = join(mocks.trashRoot, "old-img.png");
    const oldMp4 = join(mocks.trashRoot, "old-vid.mp4");
    const youngPng = join(mocks.trashRoot, "young-img.png");
    await writeFile(oldPng, "x");
    await writeFile(oldMp4, "x");
    await writeFile(youngPng, "x");

    // Backdate the two "old" files past the 14-day retention cutoff.
    const oldMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const { utimes } = await import("node:fs/promises");
    await utimes(oldPng, new Date(oldMs), new Date(oldMs));
    await utimes(oldMp4, new Date(oldMs), new Date(oldMs));

    const result = await sweepTrash(["old-img", "old-vid", "young-img"]);
    expect(result.removedFiles).toBe(2);
    expect(existsSync(oldPng)).toBe(false);
    expect(existsSync(oldMp4)).toBe(false);
    expect(existsSync(youngPng)).toBe(true);
  });

  test("adoptExistingFileAsSource keeps the source extension", async () => {
    const { adoptExistingFileAsSource } = await import("../source-store");
    const tempPath = join(tempRoot, "recorder-temp.mp4");
    await writeFile(tempPath, "video-bytes");

    const stored = await adoptExistingFileAsSource(tempPath);
    expect(stored.srcPath.endsWith(".mp4")).toBe(true);
    expect(existsSync(tempPath)).toBe(false); // rename consumed it
    expect(existsSync(stored.srcPath)).toBe(true);
    expect(stored.byteSize).toBe("video-bytes".length);
    // sha256 is deterministic over the content
    expect(stored.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("ensureEffectiveSrcPath — lazy re-extract after cache wipe", () => {
  test("bundle: re-extracts via readSourceFromBundle keyed by record.sha256", async () => {
    const { ensureEffectiveSrcPath } = await import("../source-store");
    const fakeBundleBytes = Buffer.from("source-png-bytes");
    mocks.readSourceFromBundle.mockResolvedValue(fakeBundleBytes);
    const cachePath = join(mocks.cacheRoot, "cap-1", "source.png");
    expect(existsSync(cachePath)).toBe(false);

    const returned = await ensureEffectiveSrcPath({
      id: "cap-1",
      legacy_src_path: null,
      bundle_path: "/fake/bundle.pwrsnap",
      sha256: "abc123",
      deleted_at: null
    });

    expect(returned).toBe(cachePath);
    expect(existsSync(cachePath)).toBe(true);
    expect(await readFile(cachePath)).toEqual(fakeBundleBytes);
    expect(mocks.readSourceFromBundle).toHaveBeenCalledWith("/fake/bundle.pwrsnap", "abc123");
  });

  test("cache already present: no re-extract, no bundle read", async () => {
    const { ensureEffectiveSrcPath } = await import("../source-store");
    const cachePath = join(mocks.cacheRoot, "cap-warm", "source.png");
    await mkdir(join(mocks.cacheRoot, "cap-warm"), { recursive: true });
    await writeFile(cachePath, "existing-bytes");

    const returned = await ensureEffectiveSrcPath({
      id: "cap-warm",
      legacy_src_path: null,
      bundle_path: "/fake/bundle.pwrsnap",
      sha256: "abc123",
      deleted_at: null
    });

    expect(returned).toBe(cachePath);
    expect(await readFile(cachePath, "utf8")).toBe("existing-bytes");
    expect(mocks.readSourceFromBundle).not.toHaveBeenCalled();
  });

  test("soft-deleted record: returns trash path without bundle round-trip", async () => {
    const { ensureEffectiveSrcPath } = await import("../source-store");
    const legacyPath = join(mocks.capturesRoot, "deleted.png");

    const returned = await ensureEffectiveSrcPath({
      id: "deleted",
      legacy_src_path: legacyPath,
      bundle_path: "/fake/bundle.pwrsnap",
      deleted_at: "2026-05-18T00:00:00Z"
    });

    expect(returned).toBe(join(mocks.trashRoot, "deleted.png"));
    expect(mocks.readSourceFromBundle).not.toHaveBeenCalled();
  });

  test("legacy non-bundle record: returns legacy_src_path without bundle read", async () => {
    const { ensureEffectiveSrcPath } = await import("../source-store");
    const legacyPath = join(mocks.capturesRoot, "legacy.png");

    const returned = await ensureEffectiveSrcPath({
      id: "legacy",
      legacy_src_path: legacyPath,
      bundle_path: null,
      deleted_at: null
    });

    expect(returned).toBe(legacyPath);
    expect(mocks.readSourceFromBundle).not.toHaveBeenCalled();
  });

  test("bundle without sha256: throws rather than producing a bogus path", async () => {
    const { ensureEffectiveSrcPath } = await import("../source-store");

    await expect(
      ensureEffectiveSrcPath({
        id: "cap-broken",
        legacy_src_path: null,
        bundle_path: "/fake/bundle.pwrsnap",
        deleted_at: null
      })
    ).rejects.toThrow(/sha256 missing/);
    expect(mocks.readSourceFromBundle).not.toHaveBeenCalled();
  });
});
