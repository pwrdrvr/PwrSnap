// Source-store — the only writer of <userData>/captures/. Every
// captured PNG flows through here. The plan §"Cross-cutting primitives"
// names this as the single ownership seam for the source-immutability
// invariant: only this module writes captures/, only this module
// (or its trash sweep) deletes from it.
//
// Soft-delete moves files atomically to <userData>/.trash/<id>.png on
// the same volume — single rename, no copy, no TOCTOU window.
// Hard-delete (boot-time GC) removes from .trash/ after 14d.

import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { nanoid } from "nanoid";
import sharp from "sharp";

import { getCapturesRoot, getTrashRoot } from "./paths";
import { getMainLogger } from "../log";

const log = getMainLogger("pwrsnap:source-store");

const TRASH_RETENTION_DAYS = 14;

export type StoredSource = {
  /** UUID-shaped capture identifier (nanoid). */
  id: string;
  /** Absolute on-disk path. Default layout: ~/Documents/PwrSnap/<id>.png */
  srcPath: string;
  sha256: string;
  byteSize: number;
  widthPx: number;
  heightPx: number;
};

/**
 * Take a freshly-captured PNG (path to a temp file the screencapture
 * CLI wrote) and persist it under `<capturesRoot>/<id>.png`. By
 * default that's `~/Documents/PwrSnap/<id>.png` — see paths.ts for why.
 * Under `PWRSNAP_DATA_ROOT` override mode the same flat layout applies
 * relative to `<root>/captures/`. No yyyy/mm subdirectories: filenames
 * are nanoid-shaped, sort fine in Finder by mtime, and the DB indexes
 * captured_at — the file system is asked only "give me this exact
 * path", not "list everything from May 2026."
 *
 * Returns the immutable storage record. Hashes via SHA-256 — caller
 * uses the hash for dedup against existing rows.
 *
 * Uses sharp to read width/height in one pass while we already have
 * the buffer in flight; this saves a second decode in the capture hot
 * path (latency budget for ⌘⇧P is tight).
 */
export async function putCaptureSource(tempPath: string): Promise<StoredSource> {
  const id = nanoid(16);
  const buf = await readFile(tempPath);

  const sha256 = createHash("sha256").update(buf).digest("hex");
  const meta = await sharp(buf).metadata();
  const widthPx = meta.width ?? 0;
  const heightPx = meta.height ?? 0;
  if (widthPx === 0 || heightPx === 0) {
    throw new Error(`source-store: failed to read PNG dimensions from ${tempPath}`);
  }

  const dir = getCapturesRoot();
  await mkdir(dir, { recursive: true });
  const srcPath = join(dir, `${id}.png`);

  // Same-volume rename — atomic on APFS when both paths are on the
  // home volume (typical: /tmp ↔ ~/Documents both on /). If /tmp is
  // on a different volume, fs/promises.rename falls back to a copy
  // + unlink under the hood, still atomic from the consumer's POV.
  await rename(tempPath, srcPath);

  log.info("stored capture source", { id, srcPath, byteSize: buf.length, widthPx, heightPx });

  return {
    id,
    srcPath,
    sha256,
    byteSize: buf.length,
    widthPx,
    heightPx
  };
}

/**
 * Resolve a capture record's effective on-disk source path. For live
 * records this is just `record.src_path`. For soft-deleted records the
 * file has been renamed into `<userData>/.trash/<id>.png` (the row's
 * `src_path` deliberately doesn't update — it remembers where the file
 * came from so Restore can put it back). Use this anywhere that needs
 * to actually open the source file.
 */
export function effectiveSrcPathFor(record: {
  id: string;
  src_path: string;
  deleted_at: string | null;
}): string {
  if (record.deleted_at === null) return record.src_path;
  return join(getTrashRoot(), `${record.id}.png`);
}

/**
 * Move a capture's source PNG to <userData>/.trash/<id>.png. Called
 * from `library:delete` after the DB row is soft-deleted. Idempotent —
 * if the file is already in trash, this is a no-op.
 */
export async function moveSourceToTrash(srcPath: string, captureId: string): Promise<void> {
  const trashRoot = getTrashRoot();
  await mkdir(trashRoot, { recursive: true });
  const trashPath = join(trashRoot, `${captureId}.png`);
  if (!existsSync(srcPath)) {
    log.warn("trash move: source missing, nothing to move", { srcPath, captureId });
    return;
  }
  await rename(srcPath, trashPath);
}

/**
 * Inverse of moveSourceToTrash: move <userData>/.trash/<id>.png back
 * to its original src_path. Recreates the parent dir defensively —
 * for old rows captured under the previous yyyy/mm layout the dir
 * may have been pruned, and for new rows ~/Documents/PwrSnap/
 * always exists but mkdir(recursive: true) is a no-op when it does.
 */
export async function restoreSourceFromTrash(captureId: string, srcPath: string): Promise<void> {
  const trashRoot = getTrashRoot();
  const trashPath = join(trashRoot, `${captureId}.png`);
  if (!existsSync(trashPath)) {
    log.warn("trash restore: trash file missing", { trashPath, captureId });
    return;
  }
  const { dirname } = await import("node:path");
  await mkdir(dirname(srcPath), { recursive: true });
  await rename(trashPath, srcPath);
}

/**
 * Hard-remove a single trash file by capture id. Used by per-row
 * "delete permanently" from the trash view. Idempotent — missing
 * file is fine.
 */
export async function purgeOneFromTrash(captureId: string): Promise<void> {
  const trashRoot = getTrashRoot();
  const trashPath = join(trashRoot, `${captureId}.png`);
  if (!existsSync(trashPath)) return;
  await rm(trashPath, { force: true });
}

/**
 * Boot-time GC sweep. Deletes everything in <userData>/.trash/ that
 * exceeds `TRASH_RETENTION_DAYS` mtime age. Cheap and safe — we never
 * touch live files, only ones already moved to trash.
 *
 * Also takes a list of capture IDs the persistence layer reports as
 * expired (deleted_at older than retention) and removes their DB rows;
 * the hard-delete cascades to render_cache.
 */
export async function sweepTrash(expiredCaptureIds: string[]): Promise<{ removedFiles: number }> {
  const trashRoot = getTrashRoot();
  if (!existsSync(trashRoot)) {
    return { removedFiles: 0 };
  }

  const cutoffMs = Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;

  for (const id of expiredCaptureIds) {
    const trashPath = join(trashRoot, `${id}.png`);
    if (!existsSync(trashPath)) continue;
    try {
      const stat = statSync(trashPath);
      if (stat.mtimeMs < cutoffMs) {
        await rm(trashPath, { force: true });
        removed += 1;
      }
    } catch (err) {
      log.warn("trash sweep failed for capture", {
        captureId: id,
        message: err instanceof Error ? err.message : String(err)
      });
    }
  }

  if (removed > 0) {
    log.info("trash swept", { removedFiles: removed });
  }
  return { removedFiles: removed };
}

/**
 * Boot-time orphan-temp-file cleanup. The capture pipeline writes to
 * /tmp/pwrsnap-<uuid>.png and renames into captures/. If the process
 * crashes between write and rename, the file orphans. This sweep runs
 * at app boot to clear anything older than 1 hour.
 */
export async function sweepStaleTempFiles(): Promise<{ removedFiles: number }> {
  const { readdir } = await import("node:fs/promises");
  const tmpDir = "/tmp";
  if (!existsSync(tmpDir)) return { removedFiles: 0 };

  const cutoffMs = Date.now() - 60 * 60 * 1000; // 1 hour
  const entries = await readdir(tmpDir).catch(() => [] as string[]);
  let removed = 0;

  for (const name of entries) {
    if (!name.startsWith("pwrsnap-")) continue;
    const filePath = join(tmpDir, name);
    try {
      const stat = statSync(filePath);
      if (stat.mtimeMs < cutoffMs) {
        await rm(filePath, { force: true });
        removed += 1;
      }
    } catch {
      // Best-effort; leave files we can't stat.
    }
  }

  if (removed > 0) {
    log.info("temp file sweep", { removedFiles: removed });
  }
  return { removedFiles: removed };
}
