import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { lstat, readdir, rename } from "node:fs/promises";
import { dirname, extname, join } from "node:path";

import type { FilenameTimestampZone } from "@pwrsnap/shared";

import { getMainLogger } from "../log";
import { buildCaptureBundleFilenameStem } from "./bundle-filename";
import { readBundleFilenameTimestampZone } from "./bundle-filename-settings";
import { updateCaptureLegacySourcePath } from "./captures-repo";
import { getDb } from "./db";

const log = getMainLogger("pwrsnap:video-filename-maintenance");

const MAX_COLLISION_SUFFIX = 99;
const MAX_BOOT_FAILURES = 10;
const VIDEO_SOURCE_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm"]);

type VideoFilenameRow = {
  id: string;
  captured_at: string;
  source_app_name: string | null;
  legacy_src_path: string | null;
  sha256: string;
  suggested_filename_stem: string | null;
  accepted_filename_stem: string | null;
};

export type VideoFilenameMaintenanceResult = {
  attempted: number;
  renamed: number;
  repaired: number;
  skipped: number;
  failed: number;
};

export async function renameVideoSourceToEffectiveFilename(
  captureId: string
): Promise<"renamed" | "repaired" | "skipped"> {
  const row = getVideoFilenameRow(captureId);
  if (row === null) return "skipped";
  const timestampZone = await readBundleFilenameTimestampZone();
  return renameVideoSourceRow(row, timestampZone);
}

export async function runVideoFilenameMaintenanceOnBoot(): Promise<VideoFilenameMaintenanceResult> {
  const rows = getDb()
    .prepare(
      `SELECT captures.id, captures.captured_at, captures.source_app_name,
              captures.legacy_src_path, captures.sha256,
              capture_enrichments.suggested_filename_stem,
              capture_enrichments.accepted_filename_stem
         FROM captures
         LEFT JOIN capture_enrichments
           ON capture_enrichments.capture_id = captures.id
        WHERE captures.kind = 'video'
          AND captures.legacy_src_path IS NOT NULL
          AND captures.deleted_at IS NULL
        ORDER BY captures.captured_at ASC`
    )
    .all() as VideoFilenameRow[];

  const result: VideoFilenameMaintenanceResult = {
    attempted: rows.length,
    renamed: 0,
    repaired: 0,
    skipped: 0,
    failed: 0
  };
  const timestampZone = await readBundleFilenameTimestampZone();

  for (const row of rows) {
    try {
      const outcome = await renameVideoSourceRow(row, timestampZone);
      result[outcome] += 1;
    } catch (error) {
      result.failed += 1;
      log.warn("video filename maintenance failed", {
        captureId: row.id,
        message: error instanceof Error ? error.message : String(error)
      });
      if (result.failed >= MAX_BOOT_FAILURES) {
        log.warn("video filename maintenance stopped after error budget", {
          failed: result.failed,
          attempted: result.attempted
        });
        break;
      }
    }
  }

  log.info("video filename maintenance complete", result);
  return result;
}

function getVideoFilenameRow(captureId: string): VideoFilenameRow | null {
  const row = getDb()
    .prepare(
      `SELECT captures.id, captures.captured_at, captures.source_app_name,
              captures.legacy_src_path, captures.sha256,
              capture_enrichments.suggested_filename_stem,
              capture_enrichments.accepted_filename_stem
         FROM captures
         LEFT JOIN capture_enrichments
           ON capture_enrichments.capture_id = captures.id
        WHERE captures.id = ?
          AND captures.kind = 'video'
          AND captures.deleted_at IS NULL`
    )
    .get(captureId) as VideoFilenameRow | undefined;
  return row ?? null;
}

async function renameVideoSourceRow(
  row: VideoFilenameRow,
  timestampZone: FilenameTimestampZone
): Promise<"renamed" | "repaired" | "skipped"> {
  if (row.legacy_src_path === null) return "skipped";

  const currentPath = await resolveCurrentVideoSourcePath(row);
  if (currentPath === null) return "skipped";

  const desiredStem = buildCaptureBundleFilenameStem({
    capturedAt: row.captured_at,
    sourceAppName: row.source_app_name,
    effectiveFilenameStem: row.accepted_filename_stem ?? row.suggested_filename_stem,
    sha256: row.sha256,
    timestampZone
  });
  const desiredPath = await resolveAvailableTargetPath(currentPath, desiredStem, row.sha256);

  if (currentPath === desiredPath) {
    if (row.legacy_src_path !== currentPath) {
      updateCaptureLegacySourcePath(row.id, currentPath);
      return "repaired";
    }
    return "skipped";
  }

  await assertVideoSourceMatchesCapture(currentPath, row.sha256);
  await rename(currentPath, desiredPath);
  updateCaptureLegacySourcePath(row.id, desiredPath);

  log.info("video source renamed", {
    captureId: row.id,
    from: currentPath,
    to: desiredPath
  });
  return "renamed";
}

async function resolveCurrentVideoSourcePath(
  row: VideoFilenameRow
): Promise<string | null> {
  if (row.legacy_src_path === null) return null;
  if (existsSync(row.legacy_src_path)) {
    await assertVideoSourceMatchesCapture(row.legacy_src_path, row.sha256);
    return row.legacy_src_path;
  }

  const repaired = await findVideoSourceBySha256(dirname(row.legacy_src_path), row.sha256);
  if (repaired !== null) {
    updateCaptureLegacySourcePath(row.id, repaired);
    log.info("video source path repaired from sha scan", {
      captureId: row.id,
      oldPath: row.legacy_src_path,
      repairedPath: repaired
    });
    return repaired;
  }
  return null;
}

async function resolveAvailableTargetPath(
  currentPath: string,
  desiredStem: string,
  sha256: string
): Promise<string> {
  const dir = dirname(currentPath);
  const ext = extname(currentPath) || ".mp4";
  for (let suffix = 0; suffix <= MAX_COLLISION_SUFFIX; suffix += 1) {
    const stem = suffix === 0 ? desiredStem : `${desiredStem}-${suffix + 1}`;
    const candidate = join(dir, `${stem}${ext}`);
    if (candidate === currentPath) return candidate;
    if (!existsSync(candidate)) return candidate;
    if ((await fileSha256(candidate)) === sha256) {
      throw new Error(`duplicate video source files exist for ${sha256.slice(0, 8)}`);
    }
  }
  throw new Error(`no available video source filename for ${sha256.slice(0, 8)}`);
}

async function findVideoSourceBySha256(dir: string, sha256: string): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    const ext = extname(name).toLowerCase();
    if (!VIDEO_SOURCE_EXTENSIONS.has(ext)) continue;
    const candidate = join(dir, name);
    try {
      if ((await fileSha256(candidate)) === sha256) return candidate;
    } catch {
      // Ignore unreadable files; this is a repair scan, not a hard
      // validation pass for unrelated source-dir contents.
    }
  }
  return null;
}

async function assertVideoSourceMatchesCapture(path: string, sha256: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isFile()) {
    throw new Error(`video source path is not a regular file: ${path}`);
  }
  const actual = await fileSha256(path);
  if (actual !== sha256) {
    throw new Error(`video source sha256 mismatch at ${path}`);
  }
}

function fileSha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk: Buffer) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
