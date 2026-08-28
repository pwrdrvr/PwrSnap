import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  currentRoot: "",
  legacyRoot: "",
  overridden: false,
  rows: [] as Array<{ id: string; legacy_src_path: string; deleted_at: string | null }>,
  updates: [] as Array<{ path: string; id: string }>,
  selectSql: "",
  selectParams: null as { prefix: string } | null,
  registeredFunctions: [] as string[],
  renameError: null as NodeJS.ErrnoException | null
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (oldPath: string, newPath: string): Promise<void> => {
      if (mocks.renameError !== null) throw mocks.renameError;
      await actual.rename(oldPath, newPath);
    }
  };
});

vi.mock("../db", () => ({
  getDb: () => ({
    function: (name: string) => {
      mocks.registeredFunctions.push(name);
    },
    prepare: (sql: string) => {
      if (sql.startsWith("SELECT")) {
        mocks.selectSql = sql;
        return {
          all: (params: { prefix: string }) => {
            mocks.selectParams = params;
            return mocks.rows;
          }
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
  mocks.selectSql = "";
  mocks.selectParams = null;
  mocks.registeredFunctions = [];
  mocks.renameError = null;
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
    expect(result).toEqual({
      movedFiles: 1,
      updatedRows: 1,
      skippedRows: 0,
      deferredCrossVolumeRows: 0
    });
    await expect(readFile(nextPath, "utf8")).resolves.toBe("png");
    expect(mocks.updates).toEqual([{ path: nextPath, id: "abc" }]);
  });

  test("does not move files when data root is overridden", async () => {
    mocks.overridden = true;
    const { migrateLegacyCaptureSources } = await import("../capture-source-maintenance");

    await expect(migrateLegacyCaptureSources()).resolves.toEqual({
      movedFiles: 0,
      updatedRows: 0,
      skippedRows: 0,
      deferredCrossVolumeRows: 0
    });
  });

  test("queries Windows legacy rows across native and historical separators", async () => {
    mocks.legacyRoot = String.raw`C:\Users\Élodie\AppData\Roaming\PwrSnap\captures`;
    mocks.currentRoot = String.raw`D:\Documents\PwrSnap`;
    const { migrateLegacyCaptureSources } = await import("../capture-source-maintenance");

    await expect(migrateLegacyCaptureSources("win32")).resolves.toEqual({
      movedFiles: 0,
      updatedRows: 0,
      skippedRows: 0,
      deferredCrossVolumeRows: 0
    });
    expect(mocks.selectSql).toContain(
      "pwrsnap_capture_path_has_prefix(legacy_src_path, @prefix)"
    );
    expect(mocks.registeredFunctions).toEqual([
      "pwrsnap_capture_path_has_prefix"
    ]);
    expect(mocks.selectParams).toEqual({
      prefix: "c:/users/élodie/appdata/roaming/pwrsnap/captures/"
    });
  });

  test("surfaces EXDEV without updating the row until the shared move helper lands", async () => {
    const oldPath = join(mocks.legacyRoot, "abc.png");
    await mkdir(mocks.legacyRoot, { recursive: true });
    await writeFile(oldPath, "png");
    mocks.rows = [{ id: "abc", legacy_src_path: oldPath, deleted_at: null }];
    const crossVolume: NodeJS.ErrnoException = new Error(
      "cross-device link not permitted"
    );
    crossVolume.code = "EXDEV";
    mocks.renameError = crossVolume;
    const { migrateLegacyCaptureSources } = await import(
      "../capture-source-maintenance"
    );

    await expect(migrateLegacyCaptureSources("win32")).resolves.toEqual({
      movedFiles: 0,
      updatedRows: 0,
      skippedRows: 1,
      deferredCrossVolumeRows: 1
    });
    expect(mocks.updates).toEqual([]);
    await expect(readFile(oldPath, "utf8")).resolves.toBe("png");
  });

  test("repairs row when a previous run moved the file before updating the DB", async () => {
    const oldPath = join(mocks.legacyRoot, "2026", "05", "abc.png");
    const nextPath = join(mocks.currentRoot, "abc.png");
    await mkdir(mocks.currentRoot, { recursive: true });
    await writeFile(nextPath, "png");
    mocks.rows = [{ id: "abc", legacy_src_path: oldPath, deleted_at: null }];

    const { migrateLegacyCaptureSources } = await import("../capture-source-maintenance");
    const result = await migrateLegacyCaptureSources();

    expect(result).toEqual({
      movedFiles: 0,
      updatedRows: 1,
      skippedRows: 0,
      deferredCrossVolumeRows: 0
    });
    expect(mocks.updates).toEqual([{ path: nextPath, id: "abc" }]);
  });
});
