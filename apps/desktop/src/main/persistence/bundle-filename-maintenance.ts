import { existsSync } from "node:fs";
import { lstat, readdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getMainLogger } from "../log";
import { buildCaptureBundleFilenameStem, bundleStemFromPath } from "./bundle-filename";
import { getDb } from "./db";
import { readBundleManifest } from "./bundle-store";
import { updateCaptureBundlePath } from "./captures-repo";

const log = getMainLogger("pwrsnap:bundle-filename-maintenance");

const MAX_COLLISION_SUFFIX = 99;
const MAX_BOOT_FAILURES = 10;

type FilenameRow = {
  id: string;
  captured_at: string;
  source_app_name: string | null;
  bundle_path: string | null;
  sha256: string;
  suggested_filename_stem: string | null;
  accepted_filename_stem: string | null;
};

export type BundleFilenameMaintenanceResult = {
  attempted: number;
  renamed: number;
  repaired: number;
  skipped: number;
  failed: number;
};

export async function renameBundleToEffectiveFilename(
  captureId: string
): Promise<"renamed" | "repaired" | "skipped"> {
  const row = getFilenameRow(captureId);
  if (row === null) return "skipped";
  return renameBundleRow(row);
}

export async function runBundleFilenameMaintenanceOnBoot(): Promise<BundleFilenameMaintenanceResult> {
  const rows = getDb()
    .prepare(
      `SELECT captures.id, captures.captured_at, captures.source_app_name,
              captures.bundle_path, captures.sha256,
              capture_enrichments.suggested_filename_stem,
              capture_enrichments.accepted_filename_stem
         FROM captures
         LEFT JOIN capture_enrichments
           ON capture_enrichments.capture_id = captures.id
        WHERE captures.kind = 'image'
          AND captures.bundle_path IS NOT NULL
          AND captures.deleted_at IS NULL
        ORDER BY captures.captured_at ASC`
    )
    .all() as FilenameRow[];

  const result: BundleFilenameMaintenanceResult = {
    attempted: rows.length,
    renamed: 0,
    repaired: 0,
    skipped: 0,
    failed: 0
  };

  for (const row of rows) {
    try {
      const outcome = await renameBundleRow(row);
      result[outcome] += 1;
    } catch (error) {
      result.failed += 1;
      log.warn("bundle filename maintenance failed", {
        captureId: row.id,
        message: error instanceof Error ? error.message : String(error)
      });
      if (result.failed >= MAX_BOOT_FAILURES) {
        log.warn("bundle filename maintenance stopped after error budget", {
          failed: result.failed,
          attempted: result.attempted
        });
        break;
      }
    }
  }

  log.info("bundle filename maintenance complete", result);
  return result;
}

function getFilenameRow(captureId: string): FilenameRow | null {
  const row = getDb()
    .prepare(
      `SELECT captures.id, captures.captured_at, captures.source_app_name,
              captures.bundle_path, captures.sha256,
              capture_enrichments.suggested_filename_stem,
              capture_enrichments.accepted_filename_stem
         FROM captures
         LEFT JOIN capture_enrichments
           ON capture_enrichments.capture_id = captures.id
        WHERE captures.id = ?
          AND captures.kind = 'image'
          AND captures.deleted_at IS NULL`
    )
    .get(captureId) as FilenameRow | undefined;
  return row ?? null;
}

async function renameBundleRow(
  row: FilenameRow
): Promise<"renamed" | "repaired" | "skipped"> {
  if (row.bundle_path === null) return "skipped";

  const currentPath = await resolveCurrentBundlePath(row);
  if (currentPath === null) return "skipped";

  const desiredStem = buildCaptureBundleFilenameStem({
    capturedAt: row.captured_at,
    sourceAppName: row.source_app_name,
    effectiveFilenameStem: row.accepted_filename_stem ?? row.suggested_filename_stem,
    sha256: row.sha256
  });
  const desiredPath = await resolveAvailableTargetPath(currentPath, desiredStem, row.id);

  if (currentPath === desiredPath) {
    if (row.bundle_path !== currentPath) {
      updateCaptureBundlePath(row.id, currentPath);
      return "repaired";
    }
    return "skipped";
  }

  await assertBundleBelongsToCapture(currentPath, row.id);
  await rename(currentPath, desiredPath);
  updateCaptureBundlePath(row.id, desiredPath);

  log.info("bundle renamed", {
    captureId: row.id,
    from: currentPath,
    to: desiredPath
  });
  return "renamed";
}

async function resolveCurrentBundlePath(row: FilenameRow): Promise<string | null> {
  if (row.bundle_path === null) return null;
  if (existsSync(row.bundle_path)) {
    await assertBundleBelongsToCapture(row.bundle_path, row.id);
    return row.bundle_path;
  }

  const repaired = await findBundleByManifestCaptureId(dirname(row.bundle_path), row.id);
  if (repaired !== null) {
    updateCaptureBundlePath(row.id, repaired);
    log.info("bundle path repaired from manifest scan", {
      captureId: row.id,
      oldPath: row.bundle_path,
      repairedPath: repaired
    });
    return repaired;
  }
  return null;
}

async function resolveAvailableTargetPath(
  currentPath: string,
  desiredStem: string,
  captureId: string
): Promise<string> {
  const dir = dirname(currentPath);
  for (let suffix = 0; suffix <= MAX_COLLISION_SUFFIX; suffix += 1) {
    const stem = suffix === 0 ? desiredStem : `${desiredStem}-${suffix + 1}`;
    const candidate = join(dir, `${stem}.pwrsnap`);
    if (candidate === currentPath) return candidate;
    if (!existsSync(candidate)) return candidate;
    if ((await bundlePathCaptureId(candidate)) === captureId) {
      throw new Error(`duplicate bundle files exist for ${captureId}`);
    }
  }
  throw new Error(`no available bundle filename for ${captureId}`);
}

async function findBundleByManifestCaptureId(dir: string, captureId: string): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!name.endsWith(".pwrsnap")) continue;
    const candidate = join(dir, name);
    if ((await bundlePathCaptureId(candidate)) === captureId) return candidate;
  }
  return null;
}

async function bundlePathCaptureId(bundlePath: string): Promise<string | null> {
  try {
    const manifest = await readBundleManifest(bundlePath);
    return manifest.capture_id;
  } catch {
    return null;
  }
}

async function assertBundleBelongsToCapture(bundlePath: string, captureId: string): Promise<void> {
  const stat = await lstat(bundlePath);
  if (!stat.isFile()) {
    throw new Error(`bundle path is not a regular file: ${bundlePath}`);
  }
  const manifest = await readBundleManifest(bundlePath);
  if (manifest.capture_id !== captureId) {
    throw new Error(`bundle manifest capture_id mismatch at ${bundlePath}`);
  }
}

export function expectedBundleStemForCapture(captureId: string): string | null {
  const row = getFilenameRow(captureId);
  if (row === null) return null;
  return buildCaptureBundleFilenameStem({
    capturedAt: row.captured_at,
    sourceAppName: row.source_app_name,
    effectiveFilenameStem: row.accepted_filename_stem ?? row.suggested_filename_stem,
    sha256: row.sha256
  });
}

export function bundlePathAlreadyUsesExpectedStem(bundlePath: string, expectedStem: string): boolean {
  return bundleStemFromPath(bundlePath) === expectedStem;
}
