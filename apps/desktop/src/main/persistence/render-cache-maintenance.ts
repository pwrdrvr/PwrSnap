import { constants } from "node:fs";
import { access, cp, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { getMainLogger } from "../log";
import { computeRenderHash } from "../render/overlay-hash";
import { getDb } from "./db";
import { listLiveOverlays } from "./overlays-repo";
import { getCacheRoot, getLegacyCacheRoot } from "./paths";

const log = getMainLogger("pwrsnap:render-cache-maintenance");
const RAPID_RENDER_WIDTHS = [140, 400] as const;

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
