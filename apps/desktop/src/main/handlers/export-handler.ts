// `library:export` — backup the entire library to a target directory.
// Per the plan §"Phase 1": single-user backup story for "I'm migrating
// to a new Mac" or "the DB got corrupted by an iCloud sync".
//
// Strategy:
//   1. VACUUM INTO <dest>/pwrsnap.db — consistent snapshot, doesn't
//      block readers.
//   2. Hardlink (same volume, fast, no copy) or copy (cross-volume)
//      everything under captures/ into <dest>/captures/.
//   3. Hardlink/copy cache/ similarly so the user's renders survive.
//   4. Write a manifest with sha256 of the snapshot DB + capture
//      count for verification.
//
// Refuses to export safeStorage-encrypted secrets (Phase 3) — the
// encryption key is bound to the user's login keychain and isn't
// portable. Document in the manifest.

import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { copyFile, link, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { ok, err } from "@pwrsnap/shared";
import { bus } from "../command-bus";
import { getCacheRoot, getCapturesRoot, getDb, getDbPath } from "../persistence/db";
import { getMainLogger } from "../log";

const log = getMainLogger("pwrsnap:export");

export function registerExportHandler(): void {
  // Re-register `library:export` over the not-implemented stub from
  // library-handlers.ts. The bus throws on duplicate, so we
  // unregister first.
  bus.unregister("library:export");
  bus.register("library:export", async (req) => {
    if (typeof req.destDir !== "string" || req.destDir.length === 0) {
      return err({ kind: "validation", code: "invalid_dest", message: "destDir required" });
    }
    try {
      const result = await exportLibrary(req.destDir);
      return ok(result);
    } catch (cause) {
      log.error("export failed", {
        destDir: req.destDir,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return err({
        kind: "persistence",
        code: "export_failed",
        message: cause instanceof Error ? cause.message : String(cause),
        cause
      });
    }
  });
}

async function exportLibrary(destDir: string): Promise<{ destDir: string; manifestPath: string }> {
  await mkdir(destDir, { recursive: true });

  // 1. VACUUM INTO — consistent snapshot of the DB.
  const dbDest = join(destDir, "pwrsnap.db");
  const db = getDb();
  // VACUUM INTO requires the destination not exist.
  if (existsSync(dbDest)) {
    const { rm } = await import("node:fs/promises");
    await rm(dbDest, { force: true });
  }
  db.exec(`VACUUM INTO '${dbDest.replace(/'/g, "''")}'`);

  // 2 + 3. Hardlink captures/ and cache/ recursively.
  const capturesRoot = getCapturesRoot();
  const cacheRoot = getCacheRoot();
  let captureFileCount = 0;
  let cacheFileCount = 0;
  if (existsSync(capturesRoot)) {
    captureFileCount = await mirrorTree(capturesRoot, join(destDir, "captures"));
  }
  if (existsSync(cacheRoot)) {
    cacheFileCount = await mirrorTree(cacheRoot, join(destDir, "cache"));
  }

  // 4. Manifest with sha256 of the snapshot DB.
  const dbBuf = await readFile(dbDest);
  const dbSha256 = createHash("sha256").update(dbBuf).digest("hex");
  const manifest = {
    schema_version: 1,
    exported_at: new Date().toISOString(),
    source_db_path: getDbPath(),
    db_sha256: dbSha256,
    db_byte_size: dbBuf.length,
    capture_files: captureFileCount,
    cache_files: cacheFileCount,
    notes: [
      "safeStorage-encrypted secrets (OAuth tokens etc.) are not exported — they're bound to the user's login keychain and won't decrypt on another machine. Reconnect destinations after restoring."
    ]
  };
  const manifestPath = join(destDir, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  log.info("library exported", {
    destDir,
    captureFiles: captureFileCount,
    cacheFiles: cacheFileCount
  });
  return { destDir, manifestPath };
}

/**
 * Mirror a directory tree at `src` to `dest` using hardlinks where
 * possible (same volume) and falling back to copies cross-volume.
 * Returns the number of files written.
 */
async function mirrorTree(src: string, dest: string): Promise<number> {
  await mkdir(dest, { recursive: true });
  let count = 0;
  const stack: string[] = [src];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = join(dir, entry.name);
      const relPath = relative(src, srcPath);
      const destPath = join(dest, relPath);
      if (entry.isDirectory()) {
        await mkdir(destPath, { recursive: true });
        stack.push(srcPath);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        await link(srcPath, destPath);
      } catch {
        await copyFile(srcPath, destPath);
      }
      count += 1;
    }
  }
  return count;
}

void statSync; // keep import for future Phase enhancements
