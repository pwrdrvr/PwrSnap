import { constants } from "node:fs";
import { access, cp, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { getMainLogger } from "../log";
import { getDb } from "./db";
import { getCacheRoot, getLegacyCacheRoot } from "./paths";

const log = getMainLogger("pwrsnap:render-cache-maintenance");

type CaptureIdRow = {
  id: string;
};

export type LegacyRenderCacheMigrationResult = {
  movedDirs: number;
  skippedDirs: number;
};

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
