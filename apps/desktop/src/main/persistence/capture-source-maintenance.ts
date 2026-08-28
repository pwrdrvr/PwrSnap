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
import {
  capturePathReferencePredicate,
  capturePathReferencePrefix,
  registerCapturePathReferenceFunctions
} from "./capture-path-references";

const log = getMainLogger("pwrsnap:capture-source-maintenance");

type LegacyCaptureRow = {
  id: string;
  legacy_src_path: string;
  deleted_at: string | null;
};

export type LegacyCaptureSourceMigrationResult = {
  movedFiles: number;
  updatedRows: number;
  skippedRows: number;
  /** Rows that need the separately owned durable cross-volume move helper. */
  deferredCrossVolumeRows: number;
};

/**
 * Early builds stored source captures under Application Support. The
 * current default puts live source PNGs in ~/Documents/PwrSnap so the
 * user can find them and app uninstall does not remove them. Move old
 * live rows into the current source root and update their DB paths.
 */
export async function migrateLegacyCaptureSources(
  platform: string = process.platform
): Promise<LegacyCaptureSourceMigrationResult> {
  if (isOverriddenDataRoot()) {
    return {
      movedFiles: 0,
      updatedRows: 0,
      skippedRows: 0,
      deferredCrossVolumeRows: 0
    };
  }

  const legacyRoot = getLegacyCapturesRoot();
  const currentRoot = getCapturesRoot();
  if (legacyRoot === currentRoot) {
    return {
      movedFiles: 0,
      updatedRows: 0,
      skippedRows: 0,
      deferredCrossVolumeRows: 0
    };
  }

  const db = getDb();
  if (platform === "win32") {
    registerCapturePathReferenceFunctions(db);
  }
  const legacyPathPredicate = capturePathReferencePredicate(
    "legacy_src_path",
    platform
  );
  const rows = db
    .prepare(
      `SELECT id, legacy_src_path, deleted_at
       FROM captures
       WHERE legacy_src_path IS NOT NULL AND ${legacyPathPredicate}`
    )
    .all({
      prefix: capturePathReferencePrefix(legacyRoot, platform)
    }) as LegacyCaptureRow[];
  if (rows.length === 0) {
    return {
      movedFiles: 0,
      updatedRows: 0,
      skippedRows: 0,
      deferredCrossVolumeRows: 0
    };
  }

  await mkdir(currentRoot, { recursive: true });
  let movedFiles = 0;
  let updatedRows = 0;
  let skippedRows = 0;
  let deferredCrossVolumeRows = 0;
  const updatePath = db.prepare("UPDATE captures SET legacy_src_path = ? WHERE id = ?");

  for (const row of rows) {
    const nextPath = join(currentRoot, `${row.id}.png`);

    if (row.deleted_at !== null) {
      updatePath.run(nextPath, row.id);
      updatedRows += 1;
      continue;
    }

    try {
      if (!existsSync(row.legacy_src_path)) {
        if (existsSync(nextPath)) {
          updatePath.run(nextPath, row.id);
          updatedRows += 1;
          log.info("legacy capture source migration repaired row", {
            captureId: row.id,
            srcPath: row.legacy_src_path,
            nextPath
          });
          continue;
        }
        skippedRows += 1;
        log.warn("legacy capture source missing", { captureId: row.id, srcPath: row.legacy_src_path });
        continue;
      }
      if (existsSync(nextPath)) {
        skippedRows += 1;
        log.warn("legacy capture migration target already exists", {
          captureId: row.id,
          srcPath: row.legacy_src_path,
          nextPath
        });
        continue;
      }
      await mkdir(dirname(nextPath), { recursive: true });
      await rename(row.legacy_src_path, nextPath);
      updatePath.run(nextPath, row.id);
      movedFiles += 1;
      updatedRows += 1;
    } catch (err) {
      skippedRows += 1;
      if ((err as NodeJS.ErrnoException | null)?.code === "EXDEV") {
        deferredCrossVolumeRows += 1;
        log.error("legacy capture source migration deferred cross-volume row", {
          captureId: row.id,
          srcPath: row.legacy_src_path,
          nextPath,
          message: err instanceof Error ? err.message : String(err)
        });
        continue;
      }
      log.warn("legacy capture source migration skipped row", {
        captureId: row.id,
        srcPath: row.legacy_src_path,
        nextPath,
        message: err instanceof Error ? err.message : String(err)
      });
    }
  }

  if (movedFiles > 0 || updatedRows > 0 || deferredCrossVolumeRows > 0) {
    log.info("legacy capture sources migrated", {
      movedFiles,
      updatedRows,
      skippedRows,
      deferredCrossVolumeRows,
      from: legacyRoot,
      to: currentRoot
    });
  }

  return { movedFiles, updatedRows, skippedRows, deferredCrossVolumeRows };
}
