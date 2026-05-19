import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  currentRoot: "",
  legacyRoot: "",
  overridden: false,
  rows: [] as Array<{ id: string; legacy_src_path: string; deleted_at: string | null }>,
  updates: [] as Array<{ path: string; id: string }>
}));

vi.mock("../db", () => ({
  getDb: () => ({
    prepare: (sql: string) => {
      if (sql.startsWith("SELECT")) {
        return {
          all: () => mocks.rows
        };
      }
      return {
        run: (path: string, id: string) => {
          mocks.updates.push({ path, id });
        }
      };
    }
  })
}));

vi.mock("../paths", () => ({
  getCapturesRoot: () => mocks.currentRoot,
  getLegacyCapturesRoot: () => mocks.legacyRoot,
  isOverriddenDataRoot: () => mocks.overridden
}));

let tempRoot: string;

beforeEach(async () => {
  vi.resetModules();
  tempRoot = await mkdtemp(join(tmpdir(), "pwrsnap-capture-source-maintenance-"));
  mocks.currentRoot = join(tempRoot, "Documents", "PwrSnap");
  mocks.legacyRoot = join(tempRoot, "Application Support", "PwrSnap", "captures");
  mocks.overridden = false;
  mocks.rows = [];
  mocks.updates = [];
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("migrateLegacyCaptureSources", () => {
  test("moves live legacy source files to the current captures root and updates rows", async () => {
    const oldPath = join(mocks.legacyRoot, "2026", "05", "abc.png");
    await mkdir(join(mocks.legacyRoot, "2026", "05"), { recursive: true });
    await writeFile(oldPath, "png");
    mocks.rows = [{ id: "abc", legacy_src_path: oldPath, deleted_at: null }];

    const { migrateLegacyCaptureSources } = await import("../capture-source-maintenance");
    const result = await migrateLegacyCaptureSources();

    const nextPath = join(mocks.currentRoot, "abc.png");
    expect(result).toEqual({ movedFiles: 1, updatedRows: 1, skippedRows: 0 });
    await expect(readFile(nextPath, "utf8")).resolves.toBe("png");
    expect(mocks.updates).toEqual([{ path: nextPath, id: "abc" }]);
  });

  test("does not move files when data root is overridden", async () => {
    mocks.overridden = true;
    const { migrateLegacyCaptureSources } = await import("../capture-source-maintenance");

    await expect(migrateLegacyCaptureSources()).resolves.toEqual({
      movedFiles: 0,
      updatedRows: 0,
      skippedRows: 0
    });
  });

  test("repairs row when a previous run moved the file before updating the DB", async () => {
    const oldPath = join(mocks.legacyRoot, "2026", "05", "abc.png");
    const nextPath = join(mocks.currentRoot, "abc.png");
    await mkdir(mocks.currentRoot, { recursive: true });
    await writeFile(nextPath, "png");
    mocks.rows = [{ id: "abc", legacy_src_path: oldPath, deleted_at: null }];

    const { migrateLegacyCaptureSources } = await import("../capture-source-maintenance");
    const result = await migrateLegacyCaptureSources();

    expect(result).toEqual({ movedFiles: 0, updatedRows: 1, skippedRows: 0 });
    expect(mocks.updates).toEqual([{ path: nextPath, id: "abc" }]);
  });
});
