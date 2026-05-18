import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  currentRoot: "",
  legacyRoot: "",
  captureRows: [] as Array<{ id: string }>
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

vi.mock("../overlays-repo", () => ({
  listLiveOverlays: () => []
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
    mocks.captureRows = [{ id: "capture-a" }];
    const { computeRenderHash } = await import("../../render/overlay-hash");
    const keep140 = `${computeRenderHash({
      format: "webp",
      width: 140,
      appliedOverlays: []
    })}.webp`;
    const keep400 = `${computeRenderHash({
      format: "webp",
      width: 400,
      appliedOverlays: []
    })}.webp`;

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
