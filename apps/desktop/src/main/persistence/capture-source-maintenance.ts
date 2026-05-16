import { existsSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getMainLogger } from "../log";
import { getDb } from "./db";
import {
  getCapturesRoot,
  getLegacyCapturesRoot,
  isOverriddenDataRoot
} from "./paths";

const log = getMainLogger("pwrsnap:capture-source-maintenance");

type LegacyCaptureRow = {
  id: string;
  src_path: string;
  deleted_at: string | null;
};

export type LegacyCaptureSourceMigrationResult = {
  movedFiles: number;
  updatedRows: number;
  skippedRows: number;
};

/**
 * Early builds stored source captures under Application Support. The
 * current default puts live source PNGs in ~/Documents/PwrSnap so the
 * user can find them and app uninstall does not remove them. Move old
 * live rows into the current source root and update their DB paths.
 */
export async function migrateLegacyCaptureSources(): Promise<LegacyCaptureSourceMigrationResult> {
  if (isOverriddenDataRoot()) return { movedFiles: 0, updatedRows: 0, skippedRows: 0 };

  const legacyRoot = getLegacyCapturesRoot();
  const currentRoot = getCapturesRoot();
  if (legacyRoot === currentRoot) return { movedFiles: 0, updatedRows: 0, skippedRows: 0 };

  const db = getDb();
  const rows = db
    .prepare("SELECT id, src_path, deleted_at FROM captures WHERE src_path LIKE ?")
    .all(`${legacyRoot}/%`) as LegacyCaptureRow[];
  if (rows.length === 0) return { movedFiles: 0, updatedRows: 0, skippedRows: 0 };

  await mkdir(currentRoot, { recursive: true });
  let movedFiles = 0;
  let updatedRows = 0;
  let skippedRows = 0;
  const updatePath = db.prepare("UPDATE captures SET src_path = ? WHERE id = ?");

  for (const row of rows) {
    const nextPath = join(currentRoot, `${row.id}.png`);

    if (row.deleted_at !== null) {
      updatePath.run(nextPath, row.id);
      updatedRows += 1;
      continue;
    }

    try {
      if (!existsSync(row.src_path)) {
        skippedRows += 1;
        log.warn("legacy capture source missing", { captureId: row.id, srcPath: row.src_path });
        continue;
      }
      if (existsSync(nextPath)) {
        skippedRows += 1;
        log.warn("legacy capture migration target already exists", {
          captureId: row.id,
          srcPath: row.src_path,
          nextPath
        });
        continue;
      }
      await mkdir(dirname(nextPath), { recursive: true });
      await rename(row.src_path, nextPath);
      updatePath.run(nextPath, row.id);
      movedFiles += 1;
      updatedRows += 1;
    } catch (err) {
      skippedRows += 1;
      log.warn("legacy capture source migration skipped row", {
        captureId: row.id,
        srcPath: row.src_path,
        nextPath,
        message: err instanceof Error ? err.message : String(err)
      });
    }
  }

  if (movedFiles > 0 || updatedRows > 0) {
    log.info("legacy capture sources migrated", {
      movedFiles,
      updatedRows,
      skippedRows,
      from: legacyRoot,
      to: currentRoot
    });
  }

  return { movedFiles, updatedRows, skippedRows };
}
