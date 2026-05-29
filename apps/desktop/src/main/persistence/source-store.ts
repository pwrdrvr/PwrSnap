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
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { nanoid } from "nanoid";
import sharp from "sharp";

import { getCacheRoot, getCacheSourcePath, getCapturesRoot, getTrashRoot } from "./paths";
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

  // debug-level: this fires once per capture, including 100k× under
  // the dev seeder. Production can re-enable via the logger's level
  // override; a single ⌘⇧P capture is logged elsewhere by the
  // capture handlers' "capture persisted" line at info.
  log.debug("stored capture source", { id, srcPath, byteSize: buf.length, widthPx, heightPx });

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
 * Take an existing file (a video container the recorder wrote, a copy
 * of an imported asset, …) and adopt it as a capture source. Image
 * captures keep going through `putCaptureSource` so the sharp-based
 * dim probe stays on the screenshot hot path; this variant is for
 * any source whose dimensions are known upstream (the recorder
 * reports the recording rect; importers read their own metadata).
 *
 * Extension is taken from `tempPath` so the on-disk name reflects
 * the actual container — `<id>.mp4` for video, `<id>.png` for image
 * fallback paths. The trash + render-cache machinery reads
 * `extname(src_path)` to find the right file later; we do NOT
 * hardcode `.png` anywhere downstream.
 */
export async function adoptExistingFileAsSource(tempPath: string): Promise<StoredSource> {
  const id = nanoid(16);
  const buf = await readFile(tempPath);
  const sha256 = createHash("sha256").update(buf).digest("hex");

  // Width/height are video-context-only here. Image dim probing
  // lives in `putCaptureSource`; for adopted files (video, future
  // imports) the caller passes the right values when persisting the
  // metadata row. Returning 0/0 makes any downstream code that
  // requires real dims fail loud.
  const byteSize = buf.length;
  const ext = extname(tempPath).toLowerCase() || ".bin";

  const dir = getCapturesRoot();
  await mkdir(dir, { recursive: true });
  const srcPath = join(dir, `${id}${ext}`);
  await rename(tempPath, srcPath);

  log.debug("adopted source file", { id, srcPath, byteSize, extension: ext });

  return {
    id,
    srcPath,
    sha256,
    byteSize,
    widthPx: 0,
    heightPx: 0
  };
}

/**
 * Probe the size of an existing source file without rehashing it.
 * Used by the recording service when it already streamed-finalized
 * a file in place and just needs the stat.
 */
export async function statSource(srcPath: string): Promise<{ byteSize: number }> {
  const s = await stat(srcPath);
  return { byteSize: s.size };
}

/**
 * Resolve a capture record's effective on-disk source path. Four
 * cases, in priority order:
 *
 *   1. **Soft-deleted** — return `<userData>/.trash/<id><ext>`. The
 *      extension comes from `legacy_src_path` (PR #64: video sources
 *      use `.mp4`, image sources `.png`). The row's path columns
 *      deliberately don't update through trash + restore; they
 *      remember where the file came from so Restore can put it back.
 *   2. **Bundle-backed (`bundle_path` non-null)** — return the
 *      per-capture cache path under `<userData>/cache/<id>/source.png`.
 *      `persistCaptureFromTempV2` writes this eagerly at capture time
 *      so synchronous callers (compose, clipboard render) get a real
 *      filesystem path without round-tripping through yauzl. Safe to
 *      delete; the bundle is the source of truth.
 *   3. **Legacy (`legacy_src_path` non-null)** — return the
 *      pre-bundle-migration path. Legacy captures continue to live at
 *      `~/Documents/PwrSnap/<id>.{png,mp4}` until the legacy migration
 *      wraps them in bundles.
 *
 * Throws when a row has neither bundle nor legacy source — that's a
 * programming error (a row inserted without either path), not a
 * runtime miss.
 */
export function effectiveSrcPathFor(record: {
  id: string;
  legacy_src_path: string | null;
  bundle_path?: string | null;
  deleted_at: string | null;
}): string {
  if (record.deleted_at !== null) {
    // Trash file extension matches the original source — `.mp4` for
    // video, `.png` for image. Fall back to `.png` only when the row
    // has no path column to inspect (bundle-only captures that were
    // soft-deleted before the bundle-flow rewire took over the trash
    // path).
    const ext = record.legacy_src_path !== null
      ? extname(record.legacy_src_path)
      : ".png";
    return join(getTrashRoot(), `${record.id}${ext}`);
  }
  if (record.bundle_path !== null && record.bundle_path !== undefined) {
    return getCacheSourcePath(record.id);
  }
  if (record.legacy_src_path === null) {
    throw new Error(
      `source-store: capture ${record.id} has neither bundle_path nor legacy_src_path`
    );
  }
  return record.legacy_src_path;
}

/**
 * Like {@link effectiveSrcPathFor}, but for bundle-backed live captures
 * also makes sure the per-capture cached `source.png` exists on disk —
 * re-extracting from the bundle if it's been deleted. Use this in any
 * path that's about to hand the returned path to sharp / fs.read* /
 * Codex / clipboard / render-coordinator.
 *
 * Why this exists: the cached source.png lives at
 * `<userData>/render-cache/<id>/source.png` (see {@link getCacheSourcePath}),
 * which is under the same root that Settings → Storage → "Clear" and
 * "Trim" wipe. Without this lazy re-extract, every bundle-backed
 * capture in the library breaks after a wipe — thumbnails 500, copies
 * paste as un-decodable, drag-out fails — until the user reimports.
 * The bundle is the durable source of truth; this cache file is just
 * a sharp-friendly accelerator and is intentionally safe to delete.
 *
 * No-op (returns the path unmodified) for:
 *   • soft-deleted captures — resolved to `<trash>/<id><ext>` outside
 *     render-cache; wipes don't touch them.
 *   • legacy non-bundle captures — resolved to
 *     `~/Documents/PwrSnap/<id>.png` outside render-cache.
 *
 * Re-extract is atomic via tmp + rename so concurrent renders never
 * observe a half-written file. Concurrent re-extracts for the same
 * capture race harmlessly — both write the same bytes.
 */
export async function ensureEffectiveSrcPath(record: {
  id: string;
  legacy_src_path: string | null;
  bundle_path?: string | null;
  bundle_format_version?: number;
  sha256?: string;
  deleted_at: string | null;
}): Promise<string> {
  const path = effectiveSrcPathFor(record);
  if (record.deleted_at !== null) return path;
  if (record.bundle_path === null || record.bundle_path === undefined) return path;
  if (existsSync(path)) return path;

  await rematerializeBundleSource(
    {
      id: record.id,
      bundlePath: record.bundle_path,
      bundleFormatVersion: record.bundle_format_version ?? 1,
      sha256: record.sha256
    },
    path
  );
  return path;
}

// Monotonic counter for tmp-file suffixes. Date.now() alone has
// millisecond resolution and two concurrent re-extracts in the same
// tick would collide on `tmp-<pid>-<ms>`; this counter makes the
// suffix unique within the process regardless of clock granularity.
let tmpCounter = 0;

async function rematerializeBundleSource(
  record: {
    id: string;
    bundlePath: string;
    bundleFormatVersion: number;
    sha256: string | undefined;
  },
  cacheSourcePath: string
): Promise<void> {
  // Lazy import to avoid a top-of-module dependency on bundle-store
  // (and the yauzl/sharp surface it pulls in) just for the cold path.
  const { readBundleEntry, readSourceFromBundle } = await import("./bundle-store");

  let bytes: Buffer;
  if (record.bundleFormatVersion >= 2) {
    // v2 stores sources at `sources/<sha>.png`, keyed by content hash.
    // The original capture's source bytes match `captures.sha256`.
    if (record.sha256 === undefined || record.sha256.length === 0) {
      throw new Error(
        `source-store: cannot re-extract v2 source for ${record.id} — record.sha256 missing`
      );
    }
    bytes = await readSourceFromBundle(record.bundlePath, record.sha256);
  } else {
    bytes = await readBundleEntry(record.bundlePath, "source.png");
  }

  await mkdir(dirname(cacheSourcePath), { recursive: true });
  // Atomic write — concurrent compose() calls reading the same path
  // never see a partial file. PID + monotonic counter in the tmp name
  // lets two re-extracts for the same capture coexist without one
  // stomping the other's tmp file.
  tmpCounter += 1;
  const tmp = `${cacheSourcePath}.tmp-${process.pid}-${tmpCounter}`;
  await writeFile(tmp, bytes);
  await rename(tmp, cacheSourcePath);

  log.info("re-extracted bundle source to cache", {
    captureId: record.id,
    cacheSourcePath,
    bytes: bytes.length,
    bundleFormatVersion: record.bundleFormatVersion
  });
}

/**
 * Move a capture's source file to `<trashRoot>/<id><ext>`. The
 * extension is preserved from the live `srcPath` so the trash dir is
 * a heterogenous mix of `.png` and `.mp4` (and whatever future kinds
 * the source-store supports). Called from `library:delete` after the
 * DB row is soft-deleted. Idempotent — if the file is already in
 * trash, this is a no-op.
 */
export async function moveSourceToTrash(srcPath: string, captureId: string): Promise<void> {
  const trashRoot = getTrashRoot();
  await mkdir(trashRoot, { recursive: true });
  const trashPath = join(trashRoot, `${captureId}${extname(srcPath)}`);
  if (!existsSync(srcPath)) {
    log.warn("trash move: source missing, nothing to move", { srcPath, captureId });
    return;
  }
  await rename(srcPath, trashPath);
}

/**
 * Inverse of moveSourceToTrash: move `<trashRoot>/<id><ext>` back to
 * its original src_path. Recreates the parent dir defensively — for
 * old rows captured under the previous yyyy/mm layout the dir may
 * have been pruned. The extension comes from `srcPath` so PNG and
 * MP4 sources both find the matching trash file.
 */
export async function restoreSourceFromTrash(captureId: string, srcPath: string): Promise<void> {
  const trashRoot = getTrashRoot();
  const trashPath = join(trashRoot, `${captureId}${extname(srcPath)}`);
  if (!existsSync(trashPath)) {
    log.warn("trash restore: trash file missing", { trashPath, captureId });
    return;
  }
  await mkdir(dirname(srcPath), { recursive: true });
  await rename(trashPath, srcPath);
}

/**
 * Hard-remove a single trash file by capture id. Used by per-row
 * "delete permanently" from the trash view. Idempotent — missing
 * file is fine. The caller passes the live `srcPath` (extension
 * source-of-truth); we read its extension to find the trash file.
 */
export async function purgeOneFromTrash(captureId: string, srcPath: string): Promise<void> {
  const trashRoot = getTrashRoot();
  const trashPath = join(trashRoot, `${captureId}${extname(srcPath)}`);
  if (!existsSync(trashPath)) return;
  await rm(trashPath, { force: true });
}

/**
 * Remove every cached derived artifact for a capture. For images
 * the render-cache directory is `<cacheRoot>/<captureId>/...`; for
 * videos the export-cache directory is `<cacheRoot>/video/<captureId>/...`.
 * Best-effort + idempotent — missing dirs are fine. Called from
 * `library:purge` / `library:purgeAll` AFTER `hardDeleteCapture`
 * (which removes the DB rows via cascade).
 *
 * Without this, every GIF/MP4 export ever produced for a soft-
 * deleted-then-purged video stays on disk forever, since the
 * SQL CASCADE only drops the row pointing at the file, not the
 * file itself.
 */
export async function purgeCacheForCapture(captureId: string): Promise<void> {
  const cacheRoot = getCacheRoot();
  const imageDir = join(cacheRoot, captureId);
  const videoDir = join(cacheRoot, "video", captureId);
  await Promise.allSettled([
    rm(imageDir, { recursive: true, force: true }),
    rm(videoDir, { recursive: true, force: true })
  ]);
}

/**
 * Boot-time GC sweep. Deletes everything in <userData>/.trash/ that
 * exceeds `TRASH_RETENTION_DAYS` mtime age. Cheap and safe — we never
 * touch live files, only ones already moved to trash.
 *
 * Also takes a list of capture IDs the persistence layer reports as
 * expired (deleted_at older than retention) and removes their DB rows;
 * the hard-delete cascades to render_cache.
 *
 * Image + video sources share `.trash/`; both `.png` and `.mp4` (and
 * any future container) may exist. We iterate the directory and match
 * by basename so the sweep cleans both kinds without knowing what's
 * what — capture id alone is sufficient.
 */
export async function sweepTrash(expiredCaptureIds: string[]): Promise<{ removedFiles: number }> {
  const trashRoot = getTrashRoot();
  if (!existsSync(trashRoot)) {
    return { removedFiles: 0 };
  }

  const cutoffMs = Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const allFiles = await readdir(trashRoot).catch(() => [] as string[]);
  const expired = new Set(expiredCaptureIds);
  let removed = 0;

  for (const name of allFiles) {
    const id = name.replace(/\.[^.]+$/, "");
    if (!expired.has(id)) continue;
    const trashPath = join(trashRoot, name);
    try {
      const stat = statSync(trashPath);
      if (stat.mtimeMs < cutoffMs) {
        await rm(trashPath, { force: true });
        removed += 1;
      }
    } catch (err) {
      log.warn("trash sweep failed for capture", {
        captureId: id,
        trashPath,
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
