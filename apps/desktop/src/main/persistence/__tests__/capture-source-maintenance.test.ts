import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  unlink as unlinkFile,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { moveFileWithExdevFallback } from "../cross-device-move";

const mocks = vi.hoisted(() => ({
  currentRoot: "",
  legacyRoot: "",
  overridden: false,
  rows: [] as Array<{ id: string; legacy_src_path: string; deleted_at: string | null }>,
  updates: [] as Array<{ path: string; id: string }>,
  selectSql: "",
  selectParams: null as { prefix: string } | null,
  registeredFunctions: [] as string[],
  updateError: null as Error | null
}));

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
          if (mocks.updateError !== null) throw mocks.updateError;
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
  mocks.updateError = null;
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
    expect(existsSync(oldPath)).toBe(false);
    expect(mocks.updates).toEqual([{ path: nextPath, id: "abc" }]);
  });

  test("uses the EXDEV fallback when AppData and Documents are on different volumes", async () => {
    const oldPath = join(mocks.legacyRoot, "2026", "05", "abc.png");
    await mkdir(dirname(oldPath), { recursive: true });
    await writeFile(oldPath, "cross-volume-png");
    mocks.rows = [{ id: "abc", legacy_src_path: oldPath, deleted_at: null }];
    let renameCalls = 0;

    const { migrateLegacyCaptureSources } = await import("../capture-source-maintenance");
    const result = await migrateLegacyCaptureSources({
      moveFile: async (sourcePath, destinationPath) =>
        moveFileWithExdevFallback(sourcePath, destinationPath, {
          rename: async (from, to) => {
            renameCalls += 1;
            if (renameCalls === 1) {
              throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
            }
            await rename(from, to);
          },
          uniqueSuffix: () => "maintenance-success"
        })
    });

    const nextPath = join(mocks.currentRoot, "abc.png");
    expect(result).toEqual({ movedFiles: 1, updatedRows: 1, skippedRows: 0 });
    expect(renameCalls).toBe(2);
    expect(existsSync(oldPath)).toBe(false);
    await expect(readFile(nextPath, "utf8")).resolves.toBe("cross-volume-png");
    await expect(readdir(mocks.currentRoot)).resolves.toEqual(["abc.png"]);
  });

  test("reconciles matching dual copies after a destination directory sync failure", async () => {
    const oldPath = join(mocks.legacyRoot, "2026", "05", "abc.png");
    const nextPath = join(mocks.currentRoot, "abc.png");
    await mkdir(dirname(oldPath), { recursive: true });
    await writeFile(oldPath, "recoverable-png");
    mocks.rows = [{ id: "abc", legacy_src_path: oldPath, deleted_at: null }];
    let renameCalls = 0;

    const { migrateLegacyCaptureSources } = await import("../capture-source-maintenance");
    const interrupted = await migrateLegacyCaptureSources({
      moveFile: async (sourcePath, destinationPath) =>
        moveFileWithExdevFallback(sourcePath, destinationPath, {
          rename: async (from, to) => {
            renameCalls += 1;
            if (renameCalls === 1) {
              throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
            }
            await rename(from, to);
          },
          syncDirectory: async () => {
            throw Object.assign(new Error("directory sync interrupted"), { code: "EIO" });
          },
          uniqueSuffix: () => "directory-sync-retry"
        })
    });

    expect(interrupted).toEqual({ movedFiles: 0, updatedRows: 0, skippedRows: 1 });
    await expect(readFile(oldPath, "utf8")).resolves.toBe("recoverable-png");
    await expect(readFile(nextPath, "utf8")).resolves.toBe("recoverable-png");
    expect(mocks.updates).toEqual([]);

    const retried = await migrateLegacyCaptureSources();

    expect(retried).toEqual({ movedFiles: 1, updatedRows: 1, skippedRows: 0 });
    expect(existsSync(oldPath)).toBe(false);
    await expect(readFile(nextPath, "utf8")).resolves.toBe("recoverable-png");
    expect(mocks.updates).toEqual([{ path: nextPath, id: "abc" }]);
  });

  test("reconciles matching dual copies after a source unlink failure", async () => {
    const oldPath = join(mocks.legacyRoot, "2026", "05", "abc.png");
    const nextPath = join(mocks.currentRoot, "abc.png");
    await mkdir(dirname(oldPath), { recursive: true });
    await writeFile(oldPath, "recoverable-png");
    mocks.rows = [{ id: "abc", legacy_src_path: oldPath, deleted_at: null }];
    let renameCalls = 0;

    const { migrateLegacyCaptureSources } = await import("../capture-source-maintenance");
    const interrupted = await migrateLegacyCaptureSources({
      moveFile: async (sourcePath, destinationPath) =>
        moveFileWithExdevFallback(sourcePath, destinationPath, {
          rename: async (from, to) => {
            renameCalls += 1;
            if (renameCalls === 1) {
              throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
            }
            await rename(from, to);
          },
          unlink: async (path) => {
            if (path === oldPath) {
              throw Object.assign(new Error("source is temporarily busy"), {
                code: "EPERM"
              });
            }
            await unlinkFile(path);
          },
          uniqueSuffix: () => "source-unlink-retry"
        })
    });

    expect(interrupted).toEqual({ movedFiles: 0, updatedRows: 0, skippedRows: 1 });
    await expect(readFile(oldPath, "utf8")).resolves.toBe("recoverable-png");
    await expect(readFile(nextPath, "utf8")).resolves.toBe("recoverable-png");
    expect(mocks.updates).toEqual([]);

    const retried = await migrateLegacyCaptureSources();

    expect(retried).toEqual({ movedFiles: 1, updatedRows: 1, skippedRows: 0 });
    expect(existsSync(oldPath)).toBe(false);
    await expect(readFile(nextPath, "utf8")).resolves.toBe("recoverable-png");
    expect(mocks.updates).toEqual([{ path: nextPath, id: "abc" }]);
  });

  test("never overwrites an existing Documents source and preserves the legacy source", async () => {
    const oldPath = join(mocks.legacyRoot, "2026", "05", "abc.png");
    const nextPath = join(mocks.currentRoot, "abc.png");
    await mkdir(dirname(oldPath), { recursive: true });
    await mkdir(mocks.currentRoot, { recursive: true });
    await writeFile(oldPath, "legacy-png");
    await writeFile(nextPath, "existing-documents-png");
    mocks.rows = [{ id: "abc", legacy_src_path: oldPath, deleted_at: null }];
    const moveFile = vi.fn(async () => undefined);

    const { migrateLegacyCaptureSources } = await import("../capture-source-maintenance");
    const result = await migrateLegacyCaptureSources({ moveFile });

    expect(result).toEqual({ movedFiles: 0, updatedRows: 0, skippedRows: 1 });
    expect(moveFile).not.toHaveBeenCalled();
    await expect(readFile(oldPath, "utf8")).resolves.toBe("legacy-png");
    await expect(readFile(nextPath, "utf8")).resolves.toBe("existing-documents-png");
    expect(mocks.updates).toEqual([]);
  });

  test("cleans failed EXDEV staging and preserves the source without updating the row", async () => {
    const oldPath = join(mocks.legacyRoot, "2026", "05", "abc.png");
    await mkdir(dirname(oldPath), { recursive: true });
    await writeFile(oldPath, "legacy-png");
    mocks.rows = [{ id: "abc", legacy_src_path: oldPath, deleted_at: null }];
    let renameCalls = 0;

    const { migrateLegacyCaptureSources } = await import("../capture-source-maintenance");
    const result = await migrateLegacyCaptureSources({
      moveFile: async (sourcePath, destinationPath) =>
        moveFileWithExdevFallback(sourcePath, destinationPath, {
          rename: async () => {
            renameCalls += 1;
            if (renameCalls === 1) {
              throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
            }
            throw Object.assign(new Error("destination install failed"), { code: "EIO" });
          },
          uniqueSuffix: () => "maintenance-failure"
        })
    });

    expect(result).toEqual({ movedFiles: 0, updatedRows: 0, skippedRows: 1 });
    await expect(readFile(oldPath, "utf8")).resolves.toBe("legacy-png");
    expect(existsSync(join(mocks.currentRoot, "abc.png"))).toBe(false);
    await expect(readdir(mocks.currentRoot)).resolves.toEqual([]);
    expect(mocks.updates).toEqual([]);
  });

  test("rolls the file back when the DB path update fails", async () => {
    const oldPath = join(mocks.legacyRoot, "2026", "05", "abc.png");
    const nextPath = join(mocks.currentRoot, "abc.png");
    await mkdir(dirname(oldPath), { recursive: true });
    await writeFile(oldPath, "legacy-png");
    mocks.rows = [{ id: "abc", legacy_src_path: oldPath, deleted_at: null }];
    mocks.updateError = new Error("database is busy");
    const moves: Array<readonly [string, string]> = [];

    const { migrateLegacyCaptureSources } = await import("../capture-source-maintenance");
    const result = await migrateLegacyCaptureSources({
      moveFile: async (sourcePath, destinationPath) => {
        moves.push([sourcePath, destinationPath]);
        await moveFileWithExdevFallback(sourcePath, destinationPath);
      }
    });

    expect(result).toEqual({ movedFiles: 0, updatedRows: 0, skippedRows: 1 });
    expect(moves).toEqual([
      [oldPath, nextPath],
      [nextPath, oldPath]
    ]);
    await expect(readFile(oldPath, "utf8")).resolves.toBe("legacy-png");
    expect(existsSync(nextPath)).toBe(false);
    expect(mocks.updates).toEqual([]);
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

  test("queries Windows legacy rows across native and historical separators", async () => {
    mocks.legacyRoot = String.raw`C:\Users\Élodie\AppData\Roaming\PwrSnap\captures`;
    mocks.currentRoot = String.raw`D:\Documents\PwrSnap`;
    const { migrateLegacyCaptureSources } = await import("../capture-source-maintenance");

    await expect(migrateLegacyCaptureSources({ platform: "win32" })).resolves.toEqual({
      movedFiles: 0,
      updatedRows: 0,
      skippedRows: 0
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
