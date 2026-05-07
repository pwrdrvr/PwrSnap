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

import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { nanoid } from "nanoid";
import sharp from "sharp";
import yauzl from "yauzl";
import yazl from "yazl";

import {
  BUNDLE_ENTRY_ALLOWLIST,
  BundleManifestV1,
  BundleOverlaysV1,
  isBundleEntryName,
  type BundleEntryName
} from "@pwrsnap/shared";

import type { CaptureRecord } from "@pwrsnap/shared";

import { writeFile } from "node:fs/promises";

import { findCaptureBySha256, insertOrFindCapture } from "./captures-repo";
import { getCacheSourcePath, getCapturesRoot } from "./paths";
import { getMainLogger } from "../log";

const log = getMainLogger("pwrsnap:bundle-store");

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

// ---------------------------------------------------------------------------
// yazl/yauzl pack + unpack surface.
// ---------------------------------------------------------------------------

export type PackBundleArgs = {
  manifest: BundleManifestV1;
  overlays: BundleOverlaysV1;
  /**
   * Source PNG bytes — written to the ZIP as `source.png` in STORE
   * mode (no DEFLATE recompression; PNG is already DEFLATE'd
   * internally and a second pass costs CPU for negligible size win).
   */
  sourcePng: Buffer;
  /**
   * Composite PNG bytes (the latest render with overlays baked in).
   * Same STORE-mode treatment as `sourcePng`.
   */
  compositePng: Buffer;
};

/**
 * Pack a `.pwrsnap` bundle into an in-memory Buffer. Pure function —
 * does not touch the filesystem. Caller wraps this with
 * `atomicWriteBundle` to land it on disk crash-safely.
 *
 * Manifest + overlays are validated through their zod schemas before
 * serialization. PNG entries use STORE; JSON entries use DEFLATE.
 */
export async function packBundle(args: PackBundleArgs): Promise<Buffer> {
  const validatedManifest = BundleManifestV1.parse(args.manifest);
  const validatedOverlays = BundleOverlaysV1.parse(args.overlays);

  const manifestBuf = Buffer.from(JSON.stringify(validatedManifest));
  const overlaysBuf = Buffer.from(JSON.stringify(validatedOverlays));

  return new Promise<Buffer>((resolve, reject) => {
    const zip = new yazl.ZipFile();
    zip.addBuffer(manifestBuf, "manifest.json");
    zip.addBuffer(overlaysBuf, "overlays.json");
    zip.addBuffer(args.sourcePng, "source.png", { compress: false });
    zip.addBuffer(args.compositePng, "composite.png", { compress: false });

    // Attach listeners BEFORE `zip.end()` — yazl's outputStream
    // transitions to flowing mode as soon as a data listener is
    // present; if `end()` ran first the chunks could be missed.
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);

    zip.end();
  });
}

/**
 * Open a bundle for read, walk the central directory, validate every
 * entry against the allowlist, and hand the caller a `(zipFile,
 * entries)` pair. The caller is responsible for closing the zipFile
 * when done — typically via `closeBundle(zipFile)` in a finally block.
 *
 * This is the chokepoint for the trust-boundary check: every bundle
 * read in the codebase flows through this helper. Zip-Slip / shadow-
 * entry / extra-entry / missing-entry attacks all fail here, before
 * any byte is extracted.
 */
async function openAndValidateBundle(bundlePath: string): Promise<{
  zipFile: yauzl.ZipFile;
  entries: Map<BundleEntryName, yauzl.Entry>;
}> {
  await assertSafeBundleFile(bundlePath);

  return new Promise<{
    zipFile: yauzl.ZipFile;
    entries: Map<BundleEntryName, yauzl.Entry>;
  }>((resolve, reject) => {
    // autoClose: false because we need the file open AFTER walking
    // the central directory — extract calls happen post-'end'.
    // Default autoClose=true closes once readEntry() runs past the
    // last entry, which makes openReadStream throw "closed".
    yauzl.open(bundlePath, { lazyEntries: true, autoClose: false }, (err, zipFile) => {
      if (err !== null) return reject(err);
      if (zipFile === undefined) {
        return reject(new Error("bundle-store: yauzl.open returned no zipFile"));
      }

      const allNames: string[] = [];
      const entries = new Map<BundleEntryName, yauzl.Entry>();

      zipFile.on("entry", (entry: yauzl.Entry) => {
        allNames.push(entry.fileName);
        if (isBundleEntryName(entry.fileName) && !entries.has(entry.fileName)) {
          entries.set(entry.fileName, entry);
        }
        zipFile.readEntry();
      });

      zipFile.on("end", () => {
        const validation = validateBundleZipEntryNames(allNames);
        if (!validation.ok) {
          zipFile.close();
          // Sanitized error message — entry names are attacker-controlled
          // and could carry log-injection / terminal-escape sequences.
          // We log counts (safe) and a sanitized preview to main, but
          // surface only generic info upward.
          return reject(
            new Error(
              `bundle-store: bundle ${bundlePath} failed central-directory validation`
            )
          );
        }
        resolve({ zipFile, entries });
      });

      zipFile.on("error", (zerr: Error) => {
        zipFile.close();
        reject(zerr);
      });

      zipFile.readEntry();
    });
  });
}

function readEntryToBuffer(zipFile: yauzl.ZipFile, entry: yauzl.Entry): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    zipFile.openReadStream(entry, (err, stream) => {
      if (err !== null) return reject(err);
      if (stream === undefined) {
        return reject(new Error("bundle-store: yauzl.openReadStream returned no stream"));
      }
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => resolve(Buffer.concat(chunks)));
      stream.on("error", reject);
    });
  });
}

/**
 * Read and zod-parse the bundle's `manifest.json`. The cheapest hot
 * path for the doctor reconcile — pulls only the central directory +
 * manifest entry, never decompresses source.png / composite.png /
 * overlays.json on this call.
 */
export async function readBundleManifest(bundlePath: string): Promise<BundleManifestV1> {
  const { zipFile, entries } = await openAndValidateBundle(bundlePath);
  try {
    const manifestEntry = entries.get("manifest.json");
    if (manifestEntry === undefined) {
      throw new Error("bundle-store: validated bundle missing manifest.json (impossible)");
    }
    const buf = await readEntryToBuffer(zipFile, manifestEntry);
    const json = JSON.parse(buf.toString("utf8"));
    return BundleManifestV1.parse(json);
  } finally {
    zipFile.close();
  }
}

/**
 * Read and zod-parse the bundle's `overlays.json`. Pulled only when
 * the doctor needs to rebuild a DB row's overlays from disk.
 */
export async function readBundleOverlays(bundlePath: string): Promise<BundleOverlaysV1> {
  const { zipFile, entries } = await openAndValidateBundle(bundlePath);
  try {
    const overlaysEntry = entries.get("overlays.json");
    if (overlaysEntry === undefined) {
      throw new Error("bundle-store: validated bundle missing overlays.json (impossible)");
    }
    const buf = await readEntryToBuffer(zipFile, overlaysEntry);
    const json = JSON.parse(buf.toString("utf8"));
    return BundleOverlaysV1.parse(json);
  } finally {
    zipFile.close();
  }
}

/**
 * Extract one entry from a validated bundle as a Buffer. Used by the
 * `pwrsnap-capture://` resolver to materialize `source.png` into the
 * per-capture cache, and by the legacy migration to read paired-PNG
 * candidates.
 */
export async function readBundleEntry(
  bundlePath: string,
  entryName: BundleEntryName
): Promise<Buffer> {
  const { zipFile, entries } = await openAndValidateBundle(bundlePath);
  try {
    const entry = entries.get(entryName);
    if (entry === undefined) {
      throw new Error(`bundle-store: validated bundle missing ${entryName} (impossible)`);
    }
    return await readEntryToBuffer(zipFile, entry);
  } finally {
    zipFile.close();
  }
}

// ---------------------------------------------------------------------------
// High-level write seam — bundle pair I/O.
// ---------------------------------------------------------------------------

export type WriteBundlePairResult = {
  bundlePath: string;
  flatPngPath: string;
};

/**
 * Pack and atomically write the `<id>.pwrsnap` bundle plus its paired
 * `<id>.png` flat composite into `outputDir`. Bundle goes first (it's
 * the system of record); the paired flat PNG goes second (regenerable
 * derivative). A crash between the two leaves the bundle in place;
 * the doctor reconcile pass regenerates the missing PNG from the
 * bundle's `composite.png` on next boot.
 *
 * Both writes use the atomic-rename pattern (temp file in same dir,
 * fsync before rename, fsync dir after). 0o600 on temp files; no
 * world-readable window.
 *
 * `outputDir` is created if missing — first capture path triggers
 * the macOS TCC prompt for `~/Documents/` access here.
 */
export async function writeBundlePair(args: {
  outputDir: string;
  filenameStem: string;
  manifest: BundleManifestV1;
  overlays: BundleOverlaysV1;
  sourcePng: Buffer;
  compositePng: Buffer;
}): Promise<WriteBundlePairResult> {
  const bundlePath = join(args.outputDir, `${args.filenameStem}.pwrsnap`);
  const flatPngPath = join(args.outputDir, `${args.filenameStem}.png`);

  const bundleBuf = await packBundle({
    manifest: args.manifest,
    overlays: args.overlays,
    sourcePng: args.sourcePng,
    compositePng: args.compositePng
  });

  // Bundle FIRST — system of record. If we crash between the two,
  // the doctor finds the bundle and regenerates the paired PNG.
  await atomicWriteBundle(bundlePath, bundleBuf);
  await atomicWriteBundle(flatPngPath, args.compositePng);

  return { bundlePath, flatPngPath };
}

// ---------------------------------------------------------------------------
// Capture-flow orchestrator — the single seam capture-handlers uses to
// turn a freshly-captured PNG temp file into a bundle pair + DB row.
// ---------------------------------------------------------------------------

export type PersistCaptureFromTempArgs = {
  tempPath: string;
  sourceApp: { bundleId: string | null; appName: string | null } | null;
  /** Defaults to `getCapturesRoot()` (`~/Documents/PwrSnap/`). */
  outputDir?: string;
  /**
   * Captured-display DPR. Defaults to 2 (Retina). The clipboard-paste
   * caller (PR #48) passes 1 because pasted bytes aren't from a
   * physical display. Surfaces in `CaptureRecord.device_pixel_ratio`
   * for thumbnail / preset-rendering math.
   */
  devicePixelRatio?: number;
};

export type PersistCaptureFromTempResult = {
  record: CaptureRecord;
  isDedup: boolean;
};

/**
 * Read a screencapture-CLI temp file, dedup by sha256, and (on cache
 * miss) pack a `.pwrsnap` bundle + paired flat PNG into the output
 * dir, then insert the DB row pointing at both. On dedup hit, the
 * temp file is unlinked and the existing record is returned without
 * writing anything new — two captures of identical pixels produce
 * one bundle, not two.
 *
 * Initial bundle has `composite.png == source.png` byte-identically
 * because there are no overlays applied yet. Subsequent overlay
 * edits trigger a `scheduleRepack` debounce that re-renders the
 * composite and re-packs the bundle.
 */
export async function persistCaptureFromTemp(
  args: PersistCaptureFromTempArgs
): Promise<PersistCaptureFromTempResult> {
  const buf = await readFile(args.tempPath);
  const sha256 = createHash("sha256").update(buf).digest("hex");

  const existing = findCaptureBySha256(sha256);
  if (existing !== null && existing.deleted_at === null) {
    log.info("bundle-store: dedup hit on capture", { id: existing.id, sha256 });
    try {
      await unlink(args.tempPath);
    } catch {
      // best-effort
    }
    return { record: existing, isDedup: true };
  }

  const id = nanoid(16);
  const meta = await sharp(buf).metadata();
  const widthPx = meta.width ?? 0;
  const heightPx = meta.height ?? 0;
  if (widthPx === 0 || heightPx === 0) {
    throw new Error(`bundle-store: failed to read PNG dimensions from ${args.tempPath}`);
  }

  const now = new Date().toISOString();
  const outputDir = args.outputDir ?? getCapturesRoot();
  const filenameStem = id;
  const pairedPngFilename = `${filenameStem}.png`;

  const manifest: BundleManifestV1 = {
    bundle_format_version: 1,
    capture_id: id,
    source_sha256: sha256,
    source_dimensions: { width_px: widthPx, height_px: heightPx },
    paired_png_filename: pairedPngFilename,
    created_at: now,
    bundle_modified_at: now
  };

  const overlays: BundleOverlaysV1 = {
    overlays_format_version: 1,
    overlays_version: 0,
    overlays: [],
    tags: [],
    description: null,
    ai_runs: []
  };

  // Initial composite == source: no overlays applied yet, so the
  // baked render is byte-identical to the source PNG.
  const { bundlePath, flatPngPath } = await writeBundlePair({
    outputDir,
    filenameStem,
    manifest,
    overlays,
    sourcePng: buf,
    compositePng: buf
  });

  // Materialize source.png to the per-capture cache so synchronous
  // callers (compose(), the `pwrsnap-capture://` resolver,
  // `effectiveSrcPathFor`) can hand a real path to sharp without
  // extracting from the ZIP on every read. Cache is regenerable
  // from the bundle; safe to delete.
  const cacheSource = getCacheSourcePath(id);
  await mkdir(dirname(cacheSource), { recursive: true });
  await writeFile(cacheSource, buf);

  // Clean up the screencapture temp file — we have the bytes baked
  // into the bundle now.
  try {
    await unlink(args.tempPath);
  } catch {
    // best-effort; boot-time temp sweep catches strays
  }

  const { record } = insertOrFindCapture({
    id,
    kind: "image",
    captured_at: now,
    source_app_bundle_id: args.sourceApp?.bundleId ?? null,
    source_app_name: args.sourceApp?.appName ?? null,
    legacy_src_path: null,
    bundle_path: bundlePath,
    flat_png_path: flatPngPath,
    bundle_modified_at: now,
    bundle_overlays_version: 0,
    width_px: widthPx,
    height_px: heightPx,
    device_pixel_ratio: args.devicePixelRatio ?? 2,
    byte_size: buf.length,
    sha256
  });

  log.info("bundle-store: persisted new capture", {
    id,
    bundlePath,
    flatPngPath,
    byteSize: buf.length,
    widthPx,
    heightPx
  });

  return { record, isDedup: false };
}
