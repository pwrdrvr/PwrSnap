import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
