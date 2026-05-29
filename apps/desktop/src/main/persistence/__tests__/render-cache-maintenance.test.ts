import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  currentRoot: "",
  legacyRoot: "",
  captureRows: [] as Array<{ id: string; width_px?: number; height_px?: number }>
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
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("migrateLegacyRenderCache", () => {
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
