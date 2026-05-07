// bundle-store — single owner of `.pwrsnap` ZIP bundles in
// ~/Documents/PwrSnap/. Mirrors the source-store invariant
// (source-store.ts:1-9): only this module writes the bundle directory;
// only this module (or its trash sweep) deletes from it. yazl is
// forbidden outside this module.
//
// ~/Documents/PwrSnap/ is UNTRUSTED INPUT. Anything from AirDrop,
// Mail, browser download, or a compromised peer's iCloud can land
// there. Every read path validates: filename allowlist (yauzl does
// NOT auto-validate — Zip-Slip is our problem), lstat + symlink
// rejection, zod schemas on manifest.json AND overlays.json before
// any extraction.
//
// Phase 1 lands the security primitives + atomic-rename helper here.
// The yazl/yauzl integration (pack/unpack), sha256 dedup pre-check,
// and scheduleRepack debounce land in the follow-up commit alongside
// the capture-flow rewire.
//
// See docs/plans/2026-05-07-001-feat-pwrsnap-bundle-storage-plan.md.

import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  BUNDLE_ENTRY_ALLOWLIST,
  isBundleEntryName,
  type BundleEntryName
} from "@pwrsnap/shared";

/**
 * Validate a ZIP central directory against the four-entry allowlist.
 * Pure function — used by the doctor reconcile pass and the bundle
 * reader before extracting any entry. Returns a structured result so
 * the caller can surface specifics ("bundle X has unknown entry Y")
 * without exposing untrusted attacker-controlled strings into log /
 * UI surfaces unfiltered.
 */
export type BundleEntryValidation =
  | { ok: true }
  | {
      ok: false;
      badEntries: readonly string[];
      missingEntries: readonly BundleEntryName[];
      duplicateEntries: readonly string[];
    };

export function validateBundleZipEntryNames(names: readonly string[]): BundleEntryValidation {
  const badEntries: string[] = [];
  const seen = new Set<string>();
  const duplicates: string[] = [];

  for (const name of names) {
    if (!isBundleEntryName(name)) {
      badEntries.push(name);
      continue;
    }
    if (seen.has(name)) {
      duplicates.push(name);
      continue;
    }
    seen.add(name);
  }

  const missing = BUNDLE_ENTRY_ALLOWLIST.filter((entry) => !seen.has(entry));

  if (badEntries.length === 0 && duplicates.length === 0 && missing.length === 0) {
    return { ok: true };
  }
  return {
    ok: false,
    badEntries,
    missingEntries: missing,
    duplicateEntries: duplicates
  };
}

/**
 * Refuse to read or extract a bundle file whose on-disk shape would
 * let an attacker redirect us off-path: a symlink (could point
 * anywhere we have TCC for), a directory (someone built a fake
 * `.pwrsnap/` package directory), or a missing file (race during a
 * doctor walk). Throws — callers catch and quarantine or skip.
 *
 * Distinct from the ZIP entry allowlist (`validateBundleZipEntryNames`):
 * this gate runs against the bundle file ITSELF before yauzl ever
 * opens it.
 */
export async function assertSafeBundleFile(filePath: string): Promise<void> {
  const stat = await lstat(filePath);
  if (stat.isSymbolicLink()) {
    throw new Error(`bundle-store: refusing to follow symlink at ${filePath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`bundle-store: ${filePath} is not a regular file (got ${stat.isDirectory() ? "directory" : "other"})`);
  }
}

/**
 * Atomically write a bundle (or any byte buffer) to `destPath`. The
 * temp file lives in the SAME directory as the destination — never
 * `os.tmpdir()` — so APFS rename is single-volume and atomic. fsync
 * the file body before rename, fsync the containing directory after.
 * Crash semantics: a reader sees either the old file (or no file) or
 * the new file, never partial bytes; a power loss between rename and
 * directory fsync can lose the rename, but the dir-fsync closes that
 * window.
 *
 * 0o600 on the temp file: no world-readable window during the brief
 * span between create and rename. APFS preserves the source mode
 * through rename, so the final file is also 0o600. Multi-user Macs
 * (rare, but they exist — shared family Macs, kiosks) get the same
 * isolation users expect from their Documents folder.
 *
 * Three rules baked in:
 *   1. Temp file in destination directory (no EXDEV fallback to
 *      copy+unlink — that breaks atomicity from a power-loss POV).
 *   2. fsync the file body before rename.
 *   3. fsync the containing directory after rename.
 *
 * See docs/plans/2026-05-07-001-feat-pwrsnap-bundle-storage-plan.md
 * for the iCloud + atomic-rename research.
 */
export async function atomicWriteBundle(destPath: string, contents: Buffer): Promise<void> {
  const dir = dirname(destPath);
  await mkdir(dir, { recursive: true });

  // Hidden temp name (`.<base>.tmp-<pid>-<ts>`) — Finder hides
  // dotfiles, so a crash mid-write doesn't litter the user's
  // Documents view with a visible temp file. nanoid-style
  // suffix gives uniqueness across concurrent writes within the
  // same dir and the same millisecond.
  const base = destPath.slice(dir.length + 1);
  const tmp = join(dir, `.${base}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fh = await open(tmp, "w", 0o600);
    await fh.writeFile(contents);
    await fh.sync();
    await fh.close();
    fh = null;

    await rename(tmp, destPath);
  } catch (err) {
    if (fh !== null) {
      try {
        await fh.close();
      } catch {
        // best-effort
      }
    }
    try {
      await unlink(tmp);
    } catch {
      // best-effort cleanup of the temp file
    }
    throw err;
  }

  // fsync the containing directory so the rename itself is durable
  // across a power loss. On Linux this is required; on macOS it's
  // belt-and-suspenders against APFS quirks. Best-effort — if open()
  // on a directory isn't supported here (rare, and not on macOS) we
  // log and continue rather than failing the whole write.
  try {
    const dirfd = await open(dir, "r");
    await dirfd.sync();
    await dirfd.close();
  } catch {
    // Some filesystems / platforms don't support fsync on dirfds.
    // The single-volume rename above is still atomic at the
    // filesystem-state level; we lose only the post-crash durability
    // guarantee, not consistency.
  }
}
