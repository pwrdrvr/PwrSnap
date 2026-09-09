import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getMainLogger } from "../log";
import {
  moveFileWithExdevFallback,
  syncFileAndContainingDirectory
} from "./cross-device-move";
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
};

type MoveCaptureSourceFile = (
  sourcePath: string,
  destinationPath: string
) => Promise<void>;

export type LegacyCaptureSourceMigrationOptions = {
  /** Deterministic seam for cross-device and rollback failure tests. */
  moveFile?: MoveCaptureSourceFile;
  /** Deterministic seam for Windows path-identity tests. */
  platform?: string;
};

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

async function filesHaveMatchingContents(
  sourcePath: string,
  destinationPath: string
): Promise<boolean> {
  const [sourceStat, destinationStat] = await Promise.all([
    stat(sourcePath),
    stat(destinationPath)
  ]);
  if (!sourceStat.isFile() || !destinationStat.isFile()) return false;
  if (sourceStat.size !== destinationStat.size) return false;
  const [sourceHash, destinationHash] = await Promise.all([
    fileSha256(sourcePath),
    fileSha256(destinationPath)
  ]);
  return sourceHash === destinationHash;
}

/**
 * Early builds stored source captures under Application Support. The
 * current default puts live source PNGs in ~/Documents/PwrSnap so the
 * user can find them and app uninstall does not remove them. Move old
 * live rows into the current source root and update their DB paths.
 */
export async function migrateLegacyCaptureSources(
  options: LegacyCaptureSourceMigrationOptions = {}
): Promise<LegacyCaptureSourceMigrationResult> {
  if (isOverriddenDataRoot()) return { movedFiles: 0, updatedRows: 0, skippedRows: 0 };

  const legacyRoot = getLegacyCapturesRoot();
  const currentRoot = getCapturesRoot();
  if (legacyRoot === currentRoot) return { movedFiles: 0, updatedRows: 0, skippedRows: 0 };

  const db = getDb();
  const platform = options.platform ?? process.platform;
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
  if (rows.length === 0) return { movedFiles: 0, updatedRows: 0, skippedRows: 0 };

  await mkdir(currentRoot, { recursive: true });
  let movedFiles = 0;
  let updatedRows = 0;
  let skippedRows = 0;
  const updatePath = db.prepare("UPDATE captures SET legacy_src_path = ? WHERE id = ?");
  const moveFile = options.moveFile ?? moveFileWithExdevFallback;

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
        if (!(await filesHaveMatchingContents(row.legacy_src_path, nextPath))) {
          skippedRows += 1;
          log.warn("legacy capture migration target differs from source", {
            captureId: row.id,
            srcPath: row.legacy_src_path,
            nextPath
          });
          continue;
        }

        // A late EXDEV failure can intentionally leave the installed target
        // beside its original source. Re-establish destination durability,
        // then finish the same delete-before-DB-update order as a successful
        // move. If unlink is transiently blocked, both copies and the legacy DB
        // path remain for another startup retry. If the DB update fails after
        // unlink, the existing source-missing repair branch completes next run.
        await syncFileAndContainingDirectory(nextPath);
        await unlink(row.legacy_src_path);
        updatePath.run(nextPath, row.id);
        movedFiles += 1;
        updatedRows += 1;
        log.info("legacy capture source migration reconciled duplicate", {
          captureId: row.id,
          srcPath: row.legacy_src_path,
          nextPath
        });
        continue;
      }
      await mkdir(dirname(nextPath), { recursive: true });
      await moveFile(row.legacy_src_path, nextPath);
      try {
        updatePath.run(nextPath, row.id);
      } catch (updateError) {
        // Keep the file and DB row in lockstep. The generic mover deletes its
        // source only after the destination is complete, so the same operation
        // can safely reverse a successful move when SQLite rejects the path
        // update. Never overwrite a file recreated at the legacy path; in that
        // case retain both recoverable copies and let the next maintenance pass
        // reconcile them.
        if (!existsSync(row.legacy_src_path) && existsSync(nextPath)) {
          try {
            await moveFile(nextPath, row.legacy_src_path);
          } catch (rollbackError) {
            log.error("legacy capture source migration rollback failed", {
              captureId: row.id,
              srcPath: row.legacy_src_path,
              nextPath,
              message:
                rollbackError instanceof Error
                  ? rollbackError.message
                  : String(rollbackError)
            });
          }
        }
        throw updateError;
      }
      movedFiles += 1;
      updatedRows += 1;
    } catch (err) {
      skippedRows += 1;
      log.warn("legacy capture source migration skipped row", {
        captureId: row.id,
        srcPath: row.legacy_src_path,
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
