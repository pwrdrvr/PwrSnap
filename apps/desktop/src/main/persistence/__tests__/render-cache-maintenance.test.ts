import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  currentRoot: "",
  legacyRoot: "",
  captureRows: [] as Array<{ id: string; width_px?: number; height_px?: number }>,
  cp: vi.fn(),
  rename: vi.fn(),
  link: vi.fn()
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  cp: mocks.cp,
  rename: mocks.rename,
  link: mocks.link
}));

vi.mock("../db", () => ({
  getDb: () => ({
    prepare: () => ({
      all: () => mocks.captureRows
    })
  })
}));

vi.mock("../paths", () => ({
  getCacheRoot: () => mocks.currentRoot,
  getLegacyCacheRoot: () => mocks.legacyRoot
}));

// The keep-set hashes the live v2 layer tree (empty here) via
// composeV2's `computeTreeRenderHash`. Mock both so the test stays
// deterministic and never loads the sharp pipeline — the hash is
// keyed on `width` so keep140/keep400 are distinct + predictable.
vi.mock("../layers-repo", () => ({
  listLayerTree: () => []
}));

vi.mock("../../render/compose-tree", () => ({
  computeTreeRenderHash: (input: { width: number }) => `treehash-${input.width}`
}));

let tempRoot: string;

beforeEach(async () => {
  vi.resetModules();
  tempRoot = await mkdtemp(join(tmpdir(), "pwrsnap-render-cache-maintenance-"));
  mocks.legacyRoot = join(tempRoot, "cache");
  mocks.currentRoot = join(tempRoot, "render-cache");
  mocks.captureRows = [];
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  mocks.cp.mockReset().mockImplementation(actual.cp);
  mocks.rename.mockReset().mockImplementation(actual.rename);
  mocks.link.mockReset().mockImplementation(actual.link);
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("migrateLegacyRenderCache", () => {
  test.each([
    { scenario: "merge", rebuild: false },
    { scenario: "cross-volume", rebuild: false },
    { scenario: "merge", rebuild: true },
    { scenario: "cross-volume", rebuild: true }
  ])("$scenario copies publish complete cache files without exposing partial bytes (concurrent rebuild: $rebuild)", async ({ scenario, rebuild }) => {
    mocks.captureRows = [{ id: "capture-a" }];
    const legacyDir = join(mocks.legacyRoot, "capture-a");
    const currentDir = join(mocks.currentRoot, "capture-a");
    await mkdir(legacyDir, { recursive: true });
    await writeFile(join(legacyDir, "hash.webp"), "complete");
    if (scenario === "merge") await mkdir(currentDir, { recursive: true });
    else mocks.rename.mockRejectedValue(Object.assign(new Error("cross-device"), { code: "EXDEV" }));
    let started!: () => void;
    const copying = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    mocks.cp.mockImplementation(async (_from: string, to: string) => {
      await mkdir(to, { recursive: true });
      await writeFile(join(to, "hash.webp"), "partial");
      started();
      await barrier;
      await writeFile(join(to, "hash.webp"), "complete");
    });
    const { migrateLegacyRenderCache } = await import("../render-cache-maintenance");
    const migration = migrateLegacyRenderCache();
    try {
      await copying;
      // Render bakes intentionally bypass the derived-video gate. Readers
      // must continue to see a cache miss until a complete file is published.
      await expect(stat(join(currentDir, "hash.webp"))).rejects.toThrow();
      if (rebuild) {
        await mkdir(currentDir, { recursive: true });
        await writeFile(join(currentDir, "hash.webp"), "rebuilt meanwhile");
      }
      release();
      expect(await migration).toEqual({ movedDirs: 1, skippedDirs: 0 });
      expect(await readFile(join(currentDir, "hash.webp"), "utf8"))
        .toBe(rebuild ? "rebuilt meanwhile" : "complete");
    } finally {
      release();
      await migration;
    }
  });

  test("an interrupted copy removes staging and retains the legacy cache for retry", async () => {
    mocks.captureRows = [{ id: "capture-a" }];
    const legacyDir = join(mocks.legacyRoot, "capture-a");
    await mkdir(legacyDir, { recursive: true });
    await mkdir(join(mocks.currentRoot, "capture-a"), { recursive: true });
    await writeFile(join(legacyDir, "hash.webp"), "complete");
    mocks.cp.mockImplementation(async (_from: string, to: string) => {
      await writeFile(join(to, "hash.webp"), "partial");
      throw new Error("copy interrupted");
    });
    const { migrateLegacyRenderCache } = await import("../render-cache-maintenance");
    expect(await migrateLegacyRenderCache()).toEqual({ movedDirs: 0, skippedDirs: 1 });
    expect(await readFile(join(legacyDir, "hash.webp"), "utf8")).toBe("complete");
    await expect(stat(join(mocks.currentRoot, "capture-a", "hash.webp"))).rejects.toThrow();
    expect(await readdir(mocks.currentRoot)).toEqual(["capture-a"]);
  });

  test("a failed atomic publication removes staging and retains the legacy cache for retry", async () => {
    mocks.captureRows = [{ id: "capture-a" }];
    const legacyDir = join(mocks.legacyRoot, "capture-a");
    await mkdir(legacyDir, { recursive: true });
    await mkdir(join(mocks.currentRoot, "capture-a"), { recursive: true });
    await writeFile(join(legacyDir, "hash.webp"), "complete");
    mocks.link.mockRejectedValue(Object.assign(new Error("hardlinks unsupported"), { code: "EPERM" }));
    const { migrateLegacyRenderCache } = await import("../render-cache-maintenance");
    expect(await migrateLegacyRenderCache()).toEqual({ movedDirs: 0, skippedDirs: 1 });
    expect(await readFile(join(legacyDir, "hash.webp"), "utf8")).toBe("complete");
    await expect(stat(join(mocks.currentRoot, "capture-a", "hash.webp"))).rejects.toThrow();
    expect(await readdir(mocks.currentRoot)).toEqual(["capture-a"]);
  });

  test("closes admission synchronously, drains existing writes, and runs a concurrent Clear after migration", async () => {
    mocks.captureRows = [{ id: "capture-a" }];
    await mkdir(join(mocks.legacyRoot, "capture-a"), { recursive: true });
    await writeFile(join(mocks.legacyRoot, "capture-a", "hash.webp"), "legacy render");
    const { runGatedCacheWrite } = await import("../derived-cache-gate");
    const { migrateLegacyRenderCache, clearRenderCache } = await import("../render-cache-maintenance");
    let releaseWrite!: () => void;
    let writerSignal!: AbortSignal;
    let started!: () => void;
    const start = new Promise<void>((resolve) => { started = resolve; });
    const writing = runGatedCacheWrite("capture-a", "fixture", async (signal) => {
      writerSignal = signal;
      started();
      await new Promise<void>((resolve) => { releaseWrite = resolve; });
    }).catch((error: unknown) => error);
    await start;
    const migration = migrateLegacyRenderCache();
    let clearing: Promise<void> | undefined;
    try {
      // No await between starting maintenance and testing the admission gate.
      expect(writerSignal.aborted).toBe(true);
      const newWork = vi.fn(async () => undefined);
      const queued = runGatedCacheWrite("capture-b", "new-fixture", newWork)
        .catch((cause: unknown) => cause);
      expect(newWork).not.toHaveBeenCalled();
      // The active writer deliberately ignores abort until its barrier opens.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await expect(readFile(join(mocks.legacyRoot, "capture-a", "hash.webp"), "utf8"))
        .resolves.toBe("legacy render");
      clearing = clearRenderCache();
      // Explicit cleanup still cancels a request queued behind migration;
      // it must not recreate files after Clear has emptied the root.
      await expect(queued).resolves.toMatchObject({ name: "AbortError" });
      releaseWrite();
      expect(await migration).toEqual({ movedDirs: 1, skippedDirs: 0 });
      expect(await writing).toMatchObject({ name: "AbortError" });
      await clearing;
      await expect(stat(join(mocks.currentRoot, "capture-a"))).rejects.toThrow();
      await expect(stat(join(mocks.legacyRoot, "capture-a"))).rejects.toThrow();
      await expect(runGatedCacheWrite("capture-a", "after-clear", async () => "admitted"))
        .resolves.toBe("admitted");
    } finally {
      releaseWrite();
      await writing;
      await migration;
      await clearing;
    }
  });

  test.each([false, true])("video cache hits and misses wait for migration without failing (copy failure: %s)", async (failCopy) => {
    mocks.captureRows = [{ id: "capture-a" }];
    await mkdir(join(mocks.legacyRoot, "capture-a"), { recursive: true });
    await mkdir(join(mocks.currentRoot, "capture-a"), { recursive: true });
    await writeFile(join(mocks.legacyRoot, "capture-a", "hash.webp"), "legacy render");
    const videoDir = join(mocks.currentRoot, "video", "unrelated-video");
    await mkdir(videoDir, { recursive: true });
    await writeFile(join(videoDir, "playback.mp4"), "mixed playback");
    let started!: () => void;
    const copying = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    mocks.cp.mockImplementation(async (from: string, to: string) => {
      started();
      await barrier;
      if (failCopy) throw new Error("copy failed");
      await actual.cp(from, to, { recursive: true });
    });
    const { migrateLegacyRenderCache } = await import("../render-cache-maintenance");
    const { runGatedCacheWrite } = await import("../derived-cache-gate");
    const migration = migrateLegacyRenderCache();
    await copying;
    const hit = vi.fn(async () => readFile(join(videoDir, "playback.mp4"), "utf8"));
    const miss = vi.fn(async () => {
      await writeFile(join(videoDir, "frames.jpg"), "filmstrip");
      return "filmstrip";
    });
    const results: unknown[] = [];
    const requests = [hit, miss].map((work, index) =>
      runGatedCacheWrite("unrelated-video", String(index), work)
        .then((value) => { results.push(value); return value; }, (cause: unknown) => {
          results.push(cause);
          return cause;
        })
    );
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(results).toEqual([]);
      expect(hit).not.toHaveBeenCalled();
      expect(miss).not.toHaveBeenCalled();
      release();
      expect(await migration).toEqual({ movedDirs: failCopy ? 0 : 1, skippedDirs: failCopy ? 1 : 0 });
      expect(await Promise.all(requests)).toEqual(["mixed playback", "filmstrip"]);
      expect(await readFile(join(videoDir, "frames.jpg"), "utf8")).toBe("filmstrip");
    } finally {
      release();
      await migration;
      await Promise.allSettled(requests);
    }
  });

  test("a failed migration releases admission for subsequent work and cleanup", async () => {
    mocks.captureRows = [{ id: "capture-a" }];
    await mkdir(mocks.legacyRoot, { recursive: true });
    await writeFile(mocks.currentRoot, "not a directory");
    const { migrateLegacyRenderCache, clearRenderCache } = await import("../render-cache-maintenance");
    const { runGatedCacheWrite } = await import("../derived-cache-gate");
    await expect(migrateLegacyRenderCache()).rejects.toThrow();
    await expect(runGatedCacheWrite("capture-a", "after-failure", async () => "admitted"))
      .resolves.toBe("admitted");
    await expect(clearRenderCache()).resolves.toBeUndefined();
  });

  test("merging a legacy cache never overwrites a render already rebuilt at the new root", async () => {
    mocks.captureRows = [{ id: "capture-a" }];
    await mkdir(join(mocks.legacyRoot, "capture-a"), { recursive: true });
    await mkdir(join(mocks.currentRoot, "capture-a"), { recursive: true });
    await writeFile(join(mocks.legacyRoot, "capture-a", "hash.webp"), "old");
    await writeFile(join(mocks.currentRoot, "capture-a", "hash.webp"), "rebuilt");
    const { migrateLegacyRenderCache } = await import("../render-cache-maintenance");
    await migrateLegacyRenderCache();
    expect(await readFile(join(mocks.currentRoot, "capture-a", "hash.webp"), "utf8")).toBe("rebuilt");
  });

  test("moves only capture-id directories out of the legacy Chromium cache bucket", async () => {
    mocks.captureRows = [{ id: "capture-a" }];
    await mkdir(join(mocks.legacyRoot, "capture-a"), { recursive: true });
    await mkdir(join(mocks.legacyRoot, "Cache_Data"), { recursive: true });
    await mkdir(join(mocks.legacyRoot, "unknown-dir"), { recursive: true });
    await writeFile(join(mocks.legacyRoot, "capture-a", "hash.webp"), "render");
    await writeFile(join(mocks.legacyRoot, "Cache_Data", "chromium-entry"), "browser");
    await writeFile(join(mocks.legacyRoot, "unknown-dir", "file.webp"), "unknown");

    const { migrateLegacyRenderCache } = await import("../render-cache-maintenance");
    const result = await migrateLegacyRenderCache();

    expect(result).toEqual({ movedDirs: 1, skippedDirs: 2 });
    await expect(readFile(join(mocks.currentRoot, "capture-a", "hash.webp"), "utf8")).resolves.toBe(
      "render"
    );
    await expect(readFile(join(mocks.legacyRoot, "Cache_Data", "chromium-entry"), "utf8")).resolves.toBe(
      "browser"
    );
    await expect(readFile(join(mocks.legacyRoot, "unknown-dir", "file.webp"), "utf8")).resolves.toBe(
      "unknown"
    );
  });
});

describe("render-cache maintenance", () => {
  test("trim keeps only the current rapid grid and reel derivatives", async () => {
    mocks.captureRows = [{ id: "capture-a", width_px: 1920, height_px: 1080 }];
    const keep140 = `treehash-140.webp`;
    const keep400 = `treehash-400.webp`;

    await mkdir(join(mocks.currentRoot, "capture-a", "clipboard", "old-hash"), {
      recursive: true
    });
    await mkdir(join(mocks.currentRoot, "capture-b"), { recursive: true });
    await writeFile(join(mocks.currentRoot, "loose.tmp"), "loose");
    await writeFile(join(mocks.currentRoot, "capture-a", keep140), "keep reel");
    await writeFile(join(mocks.currentRoot, "capture-a", keep400), "keep grid");
    await writeFile(join(mocks.currentRoot, "capture-a", "old-800.webp"), "remove");
    await writeFile(
      join(mocks.currentRoot, "capture-a", "clipboard", "old-hash", "PwrSnap Render.png"),
      "remove"
    );
    await writeFile(join(mocks.currentRoot, "capture-b", "unknown.webp"), "remove");

    const { trimRenderCache } = await import("../render-cache-maintenance");
    await trimRenderCache();

    await expect(readFile(join(mocks.currentRoot, "capture-a", keep140), "utf8")).resolves.toBe(
      "keep reel"
    );
    await expect(readFile(join(mocks.currentRoot, "capture-a", keep400), "utf8")).resolves.toBe(
      "keep grid"
    );
    await expect(readFile(join(mocks.currentRoot, "capture-a", "old-800.webp"))).rejects.toThrow();
    await expect(readFile(join(mocks.currentRoot, "loose.tmp"))).rejects.toThrow();
    await expect(stat(join(mocks.currentRoot, "capture-b"))).rejects.toThrow();
    await expect(stat(join(mocks.currentRoot, "capture-a", "clipboard"))).rejects.toThrow();
  });

  test("clear removes every render derivative and recreates the root", async () => {
    await mkdir(join(mocks.currentRoot, "capture-a"), { recursive: true });
    await writeFile(join(mocks.currentRoot, "capture-a", "hash.webp"), "render");

    const { clearRenderCache } = await import("../render-cache-maintenance");
    await clearRenderCache();

    await expect(readFile(join(mocks.currentRoot, "capture-a", "hash.webp"))).rejects.toThrow();
    const rootStats = await stat(mocks.currentRoot);
    expect(rootStats.isDirectory()).toBe(true);
  });
});
