import { constants } from "node:fs";
import { access, cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getMainLogger } from "../log";
import { computeRenderHash } from "../render/overlay-hash";
import { BAKE_PIPELINE_VERSION } from "../render/compose-tree";
import { getDb } from "./db";
import { listLiveOverlays } from "./overlays-repo";
import { getCacheRoot, getDataRoot, getLegacyCacheRoot } from "./paths";

const log = getMainLogger("pwrsnap:render-cache-maintenance");
const RAPID_RENDER_WIDTHS = [140, 400] as const;

/** Marker file recording the BAKE_PIPELINE_VERSION that produced the
 *  cached bytes — when the current version differs, every cached file
 *  is stale by construction (renderHash incorporates the version) and
 *  `enforceRenderCacheVersion` wipes the directory.
 *
 *  Lives at `<dataRoot>/.bake-pipeline-version` — DELIBERATELY OUTSIDE
 *  `getCacheRoot()`:
 *
 *    1. The storage-accounting UI measures render-cache directory
 *       size. A marker file inside the cache root would inflate the
 *       reported size by a few bytes — visible in the E2E "library
 *       storage popover refreshes" test which asserts "0 B" for an
 *       empty cache.
 *
 *    2. `clearRenderCache()` (called from the user-facing "Clear
 *       cache" Settings action) wipes everything under `getCacheRoot()`
 *       and re-creates the dir. If the marker lived inside, that
 *       action would wipe it too — fine, but means the NEXT boot
 *       falsely treats a user-cleared cache as a version mismatch
 *       and runs another sweep over an empty dir. Marker outside
 *       skips the no-op work. */
const VERSION_MARKER_FILENAME = ".bake-pipeline-version";

function versionMarkerPath(): string {
  return join(getDataRoot(), VERSION_MARKER_FILENAME);
}

type CaptureIdRow = {
  id: string;
};

export type LegacyRenderCacheMigrationResult = {
  movedDirs: number;
  skippedDirs: number;
};

export async function clearRenderCache(): Promise<void> {
  await rm(getCacheRoot(), { recursive: true, force: true });
  await mkdir(getCacheRoot(), { recursive: true });
}

/**
 * Issue #138 — when `BAKE_PIPELINE_VERSION` bumps (a fix to the bake
 * pipeline that changes output bytes), every cached PNG/WebP is
 * silently stale: `composeV2` produces new filenames keyed on the
 * new renderHash (which incorporates the version) but the old files
 * remain on disk, occupying space and never re-read.
 *
 * On boot, compare the current version to a marker file persisted
 * under the cache root. If they differ, sweep the cache and rewrite
 * the marker. Cost: one synchronous fs.rm at startup PER user PER
 * version bump. Future bakes lazily regenerate at the new version
 * on first access — same as the current behavior, just with the
 * stale files gone instead of orphaned.
 *
 * No-op when the marker already matches (the common case). On the
 * very first launch after this lands, the marker doesn't exist, so
 * the cache is swept once — this is the same one-time cost a user
 * pays after any version bump.
 *
 * Errors are non-fatal: a failed read or write logs a warning and
 * the boot continues. Subsequent bakes still produce correct
 * output (the renderHash is the source of truth); only the
 * orphan-cleanup is delayed.
 */
export async function enforceRenderCacheVersion(): Promise<void> {
  await mkdir(getDataRoot(), { recursive: true });
  const markerPath = versionMarkerPath();
  let lastSeen: string | null = null;
  try {
    lastSeen = (await readFile(markerPath, "utf-8")).trim();
  } catch {
    // Missing marker — first launch after this lands, OR previously-
    // crashed write. Treat as "needs sweep" so we land in a known
    // good state.
  }
  if (lastSeen === BAKE_PIPELINE_VERSION) {
    return;
  }
  try {
    await clearRenderCache();
    // Marker AFTER the wipe so a crash between the rm and the write
    // leaves the marker stale → next boot sweeps again (idempotent).
    // Marker is outside getCacheRoot() so it survives later user-
    // initiated clearRenderCache() calls and doesn't pollute the
    // storage-accounting view of the cache directory.
    await writeFile(markerPath, BAKE_PIPELINE_VERSION, "utf-8");
    log.info("bake pipeline version changed — render cache swept", {
      lastSeen,
      current: BAKE_PIPELINE_VERSION
    });
  } catch (err) {
    // Don't crash the boot for a maintenance task — the bake itself
    // is correct regardless of the orphan cleanup.
    log.warn("enforceRenderCacheVersion failed", {
      lastSeen,
      current: BAKE_PIPELINE_VERSION,
      message: err instanceof Error ? err.message : String(err)
    });
  }
}

/**
 * Keep the derivatives that make Library Grid/Reel scrolling fast and
 * remove copy/tray/float-over/full-size bakes. Any removed file is
 * rebuilt on demand through pwrsnap-cache://.
 */
export async function trimRenderCache(): Promise<void> {
  const root = getCacheRoot();
  await mkdir(root, { recursive: true });
  const keepByCaptureId = buildRapidRenderCacheKeepSet();
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    const entryPath = join(root, entry.name);
    if (!entry.isDirectory()) {
      await rm(entryPath, { force: true });
      continue;
    }

    const keep = keepByCaptureId.get(entry.name) ?? new Set<string>();
    const hasKeptEntry = await pruneRenderCacheDir(entryPath, keep, "");
    if (!hasKeptEntry) {
      await rm(entryPath, { recursive: true, force: true });
    }
  }
}

function buildRapidRenderCacheKeepSet(): Map<string, Set<string>> {
  const rows = getDb().prepare("SELECT id FROM captures").all() as CaptureIdRow[];
  const keepByCaptureId = new Map<string, Set<string>>();
  for (const row of rows) {
    const overlays = listLiveOverlays(row.id);
    const keep = new Set<string>();
    for (const width of RAPID_RENDER_WIDTHS) {
      const hash = computeRenderHash({
        format: "webp",
        width,
        appliedOverlays: overlays
      });
      keep.add(`${hash}.webp`);
    }
    keepByCaptureId.set(row.id, keep);
  }
  return keepByCaptureId;
}

async function pruneRenderCacheDir(
  dir: string,
  keep: ReadonlySet<string>,
  relativePrefix: string
): Promise<boolean> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  let hasKeptEntry = false;

  for (const entry of entries) {
    const childPath = join(dir, entry.name);
    const relativePath = relativePrefix === "" ? entry.name : join(relativePrefix, entry.name);
    if (entry.isDirectory()) {
      const childHasKeptEntry = await pruneRenderCacheDir(childPath, keep, relativePath);
      if (childHasKeptEntry) {
        hasKeptEntry = true;
      } else {
        await rm(childPath, { recursive: true, force: true });
      }
      continue;
    }

    if (keep.has(relativePath)) {
      hasKeptEntry = true;
    } else {
      await rm(childPath, { force: true });
    }
  }

  return hasKeptEntry;
}

/**
 * PwrSnap originally used <userData>/cache for render derivatives. On
 * default macOS volumes that aliases Chromium's <userData>/Cache, so
 * migrate only known capture-id directories to the unambiguous
 * render-cache root and leave Chromium's Cache_Data alone.
 */
export async function migrateLegacyRenderCache(): Promise<LegacyRenderCacheMigrationResult> {
  const legacyRoot = getLegacyCacheRoot();
  const currentRoot = getCacheRoot();
  if (legacyRoot === currentRoot) return { movedDirs: 0, skippedDirs: 0 };

  try {
    await access(legacyRoot, constants.R_OK);
  } catch {
    return { movedDirs: 0, skippedDirs: 0 };
  }

  const rows = getDb().prepare("SELECT id FROM captures").all() as CaptureIdRow[];
  const captureIds = new Set(rows.map((row) => row.id));
  if (captureIds.size === 0) return { movedDirs: 0, skippedDirs: 0 };

  await mkdir(currentRoot, { recursive: true });

  let movedDirs = 0;
  let skippedDirs = 0;
  const entries = await readdir(legacyRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !captureIds.has(entry.name)) {
      skippedDirs += 1;
      continue;
    }

    const from = join(legacyRoot, entry.name);
    const to = join(currentRoot, entry.name);
    try {
      await moveOrMergeDir(from, to);
      movedDirs += 1;
    } catch (err) {
      skippedDirs += 1;
      log.warn("legacy render-cache migration skipped directory", {
        captureId: entry.name,
        from,
        to,
        message: err instanceof Error ? err.message : String(err)
      });
    }
  }

  if (movedDirs > 0) {
    log.info("legacy render-cache migrated", { movedDirs, skippedDirs, from: legacyRoot, to: currentRoot });
  }

  return { movedDirs, skippedDirs };
}

async function moveOrMergeDir(from: string, to: string): Promise<void> {
  if (!(await pathExists(to))) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = err instanceof Error && "code" in err ? (err as NodeJS.ErrnoException).code : undefined;
      if (code !== "EXDEV" && code !== "ENOTEMPTY" && code !== "EEXIST") throw err;
    }
  }

  await mkdir(to, { recursive: true });
  await cp(from, to, {
    recursive: true,
    force: false,
    errorOnExist: false
  });
  await rm(from, { recursive: true, force: true });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
