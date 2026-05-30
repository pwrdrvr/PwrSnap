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
import { existsSync, statSync } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, rm, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { nanoid } from "nanoid";
import sharp from "sharp";
import yauzl from "yauzl";
import yazl from "yazl";

import {
  BUNDLE_ENTRY_ALLOWLIST,
  BUNDLE_ENTRY_REQUIRED,
  BundleDocumentV2,
  BundleManifestV1,
  BundleManifestV2,
  BundleOverlaysV1,
  isBundleEntryName,
  validateBundleZipEntryNamesV2,
  type BundleEntryName
} from "@pwrsnap/shared";

import type { CaptureRecord, OverlayRow } from "@pwrsnap/shared";

import { writeFile } from "node:fs/promises";

import { buildCompositeThumbnailInProcess } from "../image/composite-thumbnail";
import {
  isCompositeThumbnailWorkerAvailable,
  runCompositeThumbnailWorker
} from "../workers/composite-thumbnail-worker-client";
import { compose } from "../render/compose";
import {
  findCaptureBySha256,
  getCaptureById,
  insertOrFindCapture,
  updateCaptureBundleAfterRepack
} from "./captures-repo";
import { getCacheSourcePath, getCapturesRoot, getTrashRoot } from "./paths";
import { listLiveOverlays } from "./overlays-repo";
import { getMainLogger } from "../log";
import { buildCaptureBundleFilenameStem, bundleStemFromPath } from "./bundle-filename";

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

  // Only check the REQUIRED subset for missingness. `composite.png` is
  // allowed but optional — bundles with `manifest.composite_is_source`
  // true omit it intentionally (composite would equal source.png byte-
  // for-byte; storing both was pure duplication). The manifest's flag
  // is the source of truth for "is the composite present?"; the
  // central-directory validator just enforces the floor.
  const missing = BUNDLE_ENTRY_REQUIRED.filter((entry) => !seen.has(entry));

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
   * Low-resolution composite thumbnail (max 1024px long edge,
   * JPEG quality 90) written as `composite_thumbnail.jpg`. Generated
   * by `buildCompositeThumbnail(compositePng)`, which now always
   * returns a Buffer (it used to return null for tiny captures but
   * that left v2 bundles with no Finder/Quick-Look thumbnail — see
   * the function's comment for the full why).
   *
   * Optional in the type signature because some migration code paths
   * (legacy bundle rewrites that don't have the composite bytes
   * handy) intentionally omit it. New packers always pass the
   * always-Buffer result of `buildCompositeThumbnail` directly.
   *
   * Replaces the legacy `composite.png` entry, which was always
   * full-resolution and frequently byte-equivalent to `source.png`.
   * Readers that need the composite at full resolution reconstruct it
   * via `compose()` from source + overlays (which is what every
   * renderer in the codebase already does); the in-bundle thumbnail
   * exists strictly to short-circuit the macOS Thumbnail Extension
   * (and Quick Look) without paying compose cost.
   */
  thumbnailJpg?: Buffer | null;
};

// The sharp pipeline + size/quality constants live in the
// dependency-thin `../image/composite-thumbnail` module so the
// worker_thread can import them without dragging in `electron`/`db`.
// Re-exported here because existing callers (and tests) import
// `COMPOSITE_THUMBNAIL_MAX_DIM_PX` from bundle-store.
export { COMPOSITE_THUMBNAIL_MAX_DIM_PX } from "../image/composite-thumbnail";

/**
 * Generate a JPEG thumbnail of the composite for the in-bundle
 * `composite_thumbnail.jpg` entry. Always returns a Buffer — never
 * null.
 *
 * Runs the sharp decode/resize/encode on a shared, reused worker thread
 * when the compiled worker bundle is available (packaged + dev builds),
 * keeping libvips off the Chromium main thread — this is what the boot-
 * time v1→v2 sweep relies on to avoid a native abort while windows are
 * coming up. The worker is spawned once and reused across the batch (one
 * libvips init, not one per capture). Under vitest (no worker bundle
 * built) it falls back to the in-process pipeline, so unit tests need no
 * worker setup. A worker-level failure (e.g. a malformed source that
 * aborts libvips) rejects rather than falling back — that fails the one
 * capture and respawns a clean worker for the rest, instead of re-
 * running the poison image on the main thread.
 *
 * Why a thumbnail at all: the Finder Thumbnail Extension's fallback
 * chain ends in `composite_thumbnail.jpg → composite.png → source.png →
 * throw`. For v2 bundles the v1 `source.png` is absent (sources live at
 * `sources/<sha256>.png`, invisible to the Swift extension) and PR #90
 * stopped writing `composite.png`, so any v2 capture without a
 * thumbnail shows no Finder/Quick Look icon. (The Electron Library
 * reconstructs from sources/* fine, so the gap was Finder/Spacebar-
 * only — easy to miss in dev, very visible in real use.)
 */
export async function buildCompositeThumbnail(
  compositePng: Buffer
): Promise<Buffer> {
  if (isCompositeThumbnailWorkerAvailable()) {
    return await runCompositeThumbnailWorker(compositePng);
  }
  return await buildCompositeThumbnailInProcess(compositePng);
}

/**
 * Pack a `.pwrsnap` bundle into an in-memory Buffer. Pure function —
 * does not touch the filesystem. Caller wraps this with
 * `atomicWriteBundle` to land it on disk crash-safely.
 *
 * Manifest + overlays are validated through their zod schemas before
 * serialization. `source.png` uses STORE; JSON entries use DEFLATE;
 * `composite_thumbnail.jpg` uses STORE (already JPEG-compressed).
 *
 * Legacy `composite.png` is NOT written — readers reconstruct the
 * composite from source + overlays via compose() when they need it
 * full-res, and the Thumbnail Extension reads `composite_thumbnail.jpg`
 * for previews.
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
    if (args.thumbnailJpg !== null && args.thumbnailJpg !== undefined) {
      zip.addBuffer(args.thumbnailJpg, "composite_thumbnail.jpg", {
        compress: false
      });
    }

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

// ---------------------------------------------------------------------------
// v2 pack surface.
// ---------------------------------------------------------------------------

export type PackBundleV2Args = {
  manifest: BundleManifestV2;
  document: BundleDocumentV2;
  /**
   * Map sha256 → bytes. Content-addressable; the writer stores each
   * entry at `sources/<sha>.png` and the reader verifies sha256 on
   * extract.
   */
  sources: Map<string, Buffer>;
  /**
   * Map nanoid → bytes. Used by rasterized effects (effect→raster
   * "freeze") and future raster masks / brush strokes.
   */
  layerBytes: Map<string, Buffer>;
  /**
   * Low-resolution composite thumbnail. Generated via
   * `buildCompositeThumbnail`, which now always returns a Buffer
   * (the previous "skip for small captures" optimization broke
   * Finder + Quick Look for v2 bundles — see the function comment).
   * Optional in the type signature only for legacy migration paths
   * that don't have composite bytes available.
   */
  thumbnailJpg?: Buffer | null;
};

/**
 * Pack a v2 `.pwrsnap` bundle into an in-memory Buffer. Pure function;
 * caller wraps with `atomicWriteBundle` to land on disk crash-safely.
 *
 * Layout written:
 *   manifest.json              — DEFLATE; BundleManifestV2 zod-parsed
 *   document.json              — DEFLATE; BundleDocumentV2 zod-parsed
 *   sources/<sha>.png          — STORE; one entry per unique source sha
 *   layers/<id>.png            — STORE; one entry per raster layer file
 *   composite_thumbnail.jpg    — STORE; written for every capture
 *                                (the Swift Thumbnail / Preview
 *                                extensions can't reconstruct from
 *                                sources/, so the thumbnail is the
 *                                only way they show a v2 bundle's
 *                                content). Optional in the API
 *                                surface for legacy migration paths
 *                                that don't have the composite bytes.
 *
 * yazl validates filenames at write time (`..`, leading `/`, etc.
 * rejected). Source sha entries use `${sha}.png` form which passes
 * the v2 path validator on read.
 *
 * Legacy `composite.png` (full-resolution baked composite) is NOT
 * written — same rationale as v1: the renderer reconstructs the
 * composite from the layer tree via composeV2() at every read, and the
 * Thumbnail Extension reads `composite_thumbnail.jpg` for previews.
 */
export async function packBundleV2(args: PackBundleV2Args): Promise<Buffer> {
  const validatedManifest = BundleManifestV2.parse(args.manifest);
  const validatedDocument = BundleDocumentV2.parse(args.document);

  const manifestBuf = Buffer.from(JSON.stringify(validatedManifest));
  const documentBuf = Buffer.from(JSON.stringify(validatedDocument));

  return new Promise<Buffer>((resolve, reject) => {
    const zip = new yazl.ZipFile();
    zip.addBuffer(manifestBuf, "manifest.json");
    zip.addBuffer(documentBuf, "document.json");
    for (const [sha, bytes] of args.sources) {
      zip.addBuffer(bytes, `sources/${sha}.png`, { compress: false });
    }
    for (const [id, bytes] of args.layerBytes) {
      zip.addBuffer(bytes, `layers/${id}.png`, { compress: false });
    }
    if (args.thumbnailJpg !== null && args.thumbnailJpg !== undefined) {
      zip.addBuffer(args.thumbnailJpg, "composite_thumbnail.jpg", {
        compress: false
      });
    }

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
/**
 * Internal handle discriminated by bundle_format_version. Most callers
 * consume the higher-level `readBundleView` adapter instead — the
 * version discriminant leaks fewer files this way. Only `composeV2` vs
 * `compose` (separate compositors) and the future v1→v2 migration need
 * the discriminant directly.
 */
type BundleReadHandleV1 = {
  version: 1;
  manifest: BundleManifestV1;
  entries: Map<BundleEntryName, yauzl.Entry>;
  zipFile: yauzl.ZipFile;
};
type BundleReadHandleV2 = {
  version: 2;
  manifest: BundleManifestV2;
  entries: Map<string, yauzl.Entry>;
  zipFile: yauzl.ZipFile;
};
type BundleReadHandle = BundleReadHandleV1 | BundleReadHandleV2;

async function openAndValidateBundle(bundlePath: string): Promise<BundleReadHandle> {
  await assertSafeBundleFile(bundlePath);

  return new Promise<BundleReadHandle>((resolve, reject) => {
    // autoClose: false because we need the file open AFTER walking
    // the central directory — extract calls happen post-'end'.
    yauzl.open(bundlePath, { lazyEntries: true, autoClose: false }, (err, zipFile) => {
      if (err !== null) return reject(err);
      if (zipFile === undefined) {
        return reject(new Error("bundle-store: yauzl.open returned no zipFile"));
      }

      // Stage 1: walk the central directory and collect ALL entry
      // names. No allowlist filter yet — that comes after we read
      // manifest.json to learn the bundle's format version.
      const allNames: string[] = [];
      const entriesByName = new Map<string, yauzl.Entry>();
      const duplicateNames: string[] = [];

      zipFile.on("entry", (entry: yauzl.Entry) => {
        allNames.push(entry.fileName);
        if (entriesByName.has(entry.fileName)) {
          duplicateNames.push(entry.fileName);
        } else {
          entriesByName.set(entry.fileName, entry);
        }
        zipFile.readEntry();
      });

      zipFile.on("end", () => {
        // Step 1: manifest.json is the one universal entry across v1
        // and v2. Read it FIRST to learn the format version. If it's
        // missing or duplicated, fail closed.
        const manifestEntry = entriesByName.get("manifest.json");
        const manifestDup = duplicateNames.includes("manifest.json");
        if (manifestEntry === undefined || manifestDup) {
          zipFile.close();
          return reject(
            new Error(`bundle-store: bundle ${bundlePath} failed central-directory validation`)
          );
        }

        // Decompress the manifest entry — cheap, single DEFLATE block.
        readEntryToBuffer(zipFile, manifestEntry).then(
          (manifestBuf) => {
            let parsedManifest: unknown;
            try {
              parsedManifest = JSON.parse(manifestBuf.toString("utf8"));
            } catch {
              zipFile.close();
              return reject(
                new Error(
                  `bundle-store: bundle ${bundlePath} manifest is not valid JSON`
                )
              );
            }

            // Read just the format version (without zod-parsing the
            // full manifest yet — we do that per-version below so the
            // zod errors are version-appropriate).
            const formatVersion =
              parsedManifest !== null &&
              typeof parsedManifest === "object" &&
              "bundle_format_version" in parsedManifest
                ? (parsedManifest as { bundle_format_version: unknown }).bundle_format_version
                : undefined;

            if (formatVersion === 1) {
              const v1Validation = validateBundleZipEntryNames(allNames);
              if (!v1Validation.ok) {
                zipFile.close();
                return reject(
                  new Error(
                    `bundle-store: bundle ${bundlePath} failed v1 central-directory validation`
                  )
                );
              }
              const v1Entries = new Map<BundleEntryName, yauzl.Entry>();
              for (const name of BUNDLE_ENTRY_ALLOWLIST) {
                const entry = entriesByName.get(name);
                if (entry !== undefined) v1Entries.set(name, entry);
              }
              let manifest: BundleManifestV1;
              try {
                manifest = BundleManifestV1.parse(parsedManifest);
              } catch {
                zipFile.close();
                return reject(
                  new Error(
                    `bundle-store: bundle ${bundlePath} v1 manifest failed schema validation`
                  )
                );
              }
              return resolve({ version: 1, manifest, entries: v1Entries, zipFile });
            }

            if (formatVersion === 2) {
              const v2Validation = validateBundleZipEntryNamesV2(allNames);
              if (!v2Validation.ok) {
                zipFile.close();
                return reject(
                  new Error(
                    `bundle-store: bundle ${bundlePath} failed v2 central-directory validation`
                  )
                );
              }
              let manifest: BundleManifestV2;
              try {
                manifest = BundleManifestV2.parse(parsedManifest);
              } catch {
                zipFile.close();
                return reject(
                  new Error(
                    `bundle-store: bundle ${bundlePath} v2 manifest failed schema validation`
                  )
                );
              }
              return resolve({
                version: 2,
                manifest,
                entries: entriesByName,
                zipFile
              });
            }

            zipFile.close();
            reject(
              new Error(
                `bundle-store: bundle ${bundlePath} has unknown bundle_format_version`
              )
            );
          },
          (readErr) => {
            zipFile.close();
            reject(readErr);
          }
        );
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
 * Public adapter that hides the version discriminant from most callers.
 * Used by the library, doctor reconcile, capture-handlers — anything
 * that needs the canvas dims + capture_id + paired filename without
 * caring whether the bundle is v1 or v2.
 *
 * Only `composeV2` vs `compose` (separate compositors) and the future
 * v1→v2 migration touch the version-discriminated read handles
 * directly.
 */
export type BundleView = {
  version: 1 | 2;
  capture_id: string;
  canvas: { width_px: number; height_px: number };
  paired_png_filename: string;
  bundle_modified_at: string;
};

export async function readBundleView(bundlePath: string): Promise<BundleView> {
  const handle = await openAndValidateBundle(bundlePath);
  try {
    if (handle.version === 1) {
      return {
        version: 1,
        capture_id: handle.manifest.capture_id,
        canvas: handle.manifest.source_dimensions,
        paired_png_filename: handle.manifest.paired_png_filename,
        bundle_modified_at: handle.manifest.bundle_modified_at
      };
    }
    return {
      version: 2,
      capture_id: handle.manifest.capture_id,
      canvas: handle.manifest.canvas_dimensions,
      paired_png_filename: handle.manifest.paired_png_filename,
      bundle_modified_at: handle.manifest.bundle_modified_at
    };
  } finally {
    handle.zipFile.close();
  }
}

/**
 * Read and zod-parse the bundle's `manifest.json`. Returns a
 * discriminated union — callers that need version-specific fields
 * branch on `bundle_format_version`. Most callers should use
 * `readBundleView` instead.
 */
export async function readBundleManifest(
  bundlePath: string
): Promise<BundleManifestV1 | BundleManifestV2> {
  const handle = await openAndValidateBundle(bundlePath);
  try {
    return handle.manifest;
  } finally {
    handle.zipFile.close();
  }
}

/**
 * Read and zod-parse the bundle's `overlays.json` (v1 only). Errors
 * cleanly when called on a v2 bundle — callers should use
 * `readBundleDocument` for v2 captures.
 */
export async function readBundleOverlays(bundlePath: string): Promise<BundleOverlaysV1> {
  const handle = await openAndValidateBundle(bundlePath);
  try {
    if (handle.version !== 1) {
      throw new Error(
        `bundle-store: readBundleOverlays called on a v${handle.version} bundle; use readBundleDocument instead`
      );
    }
    const overlaysEntry = handle.entries.get("overlays.json");
    if (overlaysEntry === undefined) {
      throw new Error("bundle-store: validated v1 bundle missing overlays.json (impossible)");
    }
    const buf = await readEntryToBuffer(handle.zipFile, overlaysEntry);
    const json = JSON.parse(buf.toString("utf8"));
    return BundleOverlaysV1.parse(json);
  } finally {
    handle.zipFile.close();
  }
}

/**
 * Read and zod-parse the bundle's `document.json` (v2 only). Errors
 * cleanly when called on a v1 bundle.
 */
export async function readBundleDocument(bundlePath: string): Promise<BundleDocumentV2> {
  const handle = await openAndValidateBundle(bundlePath);
  try {
    if (handle.version !== 2) {
      throw new Error(
        `bundle-store: readBundleDocument called on a v${handle.version} bundle; use readBundleOverlays for v1`
      );
    }
    const documentEntry = handle.entries.get("document.json");
    if (documentEntry === undefined) {
      throw new Error("bundle-store: validated v2 bundle missing document.json (impossible)");
    }
    const buf = await readEntryToBuffer(handle.zipFile, documentEntry);
    const json = JSON.parse(buf.toString("utf8"));
    return BundleDocumentV2.parse(json);
  } finally {
    handle.zipFile.close();
  }
}

/**
 * Extract `sources/<sha>.png` from a v2 bundle with content-integrity
 * verification. Recomputes sha256(zipEntryBytes) and rejects on
 * mismatch with the filename's claimed sha. Without this check, an
 * attacker who ships a v2 bundle (AirDrop, peer iCloud) can put
 * attacker-controlled bytes at `sources/<known-good-sha>.png`,
 * poisoning the dedup invariant and the effect cache.
 *
 * Errors are sanitized — attacker-controlled identifiers (the claimed
 * sha) and bytes never appear in error messages that flow to the
 * renderer via Result.error.cause.
 */
export async function readSourceFromBundle(
  bundlePath: string,
  sha: string
): Promise<Buffer> {
  const handle = await openAndValidateBundle(bundlePath);
  try {
    if (handle.version !== 2) {
      throw new Error(
        `bundle-store: readSourceFromBundle called on a v${handle.version} bundle (sources/ entries are v2-only)`
      );
    }
    const entry = handle.entries.get(`sources/${sha}.png`);
    if (entry === undefined) {
      // Generic message — does not echo the requested sha, which is
      // attacker-controllable when the bundle came from outside.
      throw new Error(
        `bundle-store: v2 bundle does not contain the requested source entry`
      );
    }
    const bytes = await readEntryToBuffer(handle.zipFile, entry);
    const computed = createHash("sha256").update(bytes).digest("hex");
    if (computed !== sha) {
      // Sanitized: log the bundle path (local, known) but NOT the
      // claimed sha (attacker-controlled) and NOT the byte content.
      log.warn("bundle-store: source content-integrity mismatch", { bundlePath });
      throw new Error(
        `bundle-store: source content-hash mismatch in ${bundlePath}`
      );
    }
    return bytes;
  } finally {
    handle.zipFile.close();
  }
}

/**
 * Extract one v1 entry from a validated bundle as a Buffer. v1-only —
 * v2 sources go through `readSourceFromBundle` for content-integrity
 * verification; other v2 entries (layers/*, composite.png) get their
 * own entrypoint when first consumed.
 */
export async function readBundleEntry(
  bundlePath: string,
  entryName: BundleEntryName
): Promise<Buffer> {
  const handle = await openAndValidateBundle(bundlePath);
  try {
    if (handle.version !== 1) {
      throw new Error(
        `bundle-store: readBundleEntry called on a v${handle.version} bundle (v1-only entrypoint)`
      );
    }
    const entry = handle.entries.get(entryName);
    if (entry === undefined) {
      throw new Error(`bundle-store: validated bundle missing ${entryName} (impossible)`);
    }
    return await readEntryToBuffer(handle.zipFile, entry);
  } finally {
    handle.zipFile.close();
  }
}

// ---------------------------------------------------------------------------
// High-level write seam — bundle pair I/O.
// ---------------------------------------------------------------------------

export type WriteBundleResult = {
  bundlePath: string;
};

/**
 * Pack and atomically write the `<id>.pwrsnap` bundle into `outputDir`.
 * The bundle IS the system of record — no paired sibling files written.
 * macOS Finder shows the generic Document icon until the Thumbnail
 * Extension ships; in-app paths read the bundle directly via
 * `effectiveSrcPathFor`/`readSourceFromBundle`.
 *
 * Uses the atomic-rename pattern (temp file in same dir, fsync before
 * rename, fsync dir after). 0o600 on the temp file; no world-readable
 * window.
 *
 * `outputDir` is created if missing — first capture path triggers
 * the macOS TCC prompt for `~/Documents/` access here.
 *
 * Pre-refactor this function (`writeBundlePair`) also wrote a paired
 * `<id>.png` flat composite next to the bundle for Finder visibility.
 * That sibling was never read by any in-app surface — it was pure
 * write-side duplication — and has been removed.
 */
export async function writeBundle(args: {
  outputDir: string;
  filenameStem: string;
  manifest: BundleManifestV1;
  overlays: BundleOverlaysV1;
  sourcePng: Buffer;
  thumbnailJpg: Buffer | null;
}): Promise<WriteBundleResult> {
  const bundlePath = join(args.outputDir, `${args.filenameStem}.pwrsnap`);

  const bundleBuf = await packBundle({
    manifest: args.manifest,
    overlays: args.overlays,
    sourcePng: args.sourcePng,
    thumbnailJpg: args.thumbnailJpg
  });

  await atomicWriteBundle(bundlePath, bundleBuf);

  return { bundlePath };
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
  devicePixelRatio?: number | undefined;
};

export type PersistCaptureFromTempResult = {
  record: CaptureRecord;
  isDedup: boolean;
};

// ---------------------------------------------------------------------------
// Re-pack debounce — replaces the bundle when overlays change.
// ---------------------------------------------------------------------------

const REPACK_DEBOUNCE_MS = 1_000;

// Pending timers keyed by capture id. Setting a new timer for the
// same capture clears the previous — debounce by latest edit, not
// by edit count.
const repackTimers = new Map<string, NodeJS.Timeout>();

// In-flight repack promises so concurrent doctor walks (Phase 2)
// can cooperate via a shared mutex instead of racing on the same
// capture's bundle file.
const repackInFlight = new Map<string, Promise<void>>();

/**
 * Debounced re-pack request. Called after every edit (overlay insert
 * / reject for v1, layer upsert / delete for v2) — the existing
 * `captures.edits_version` bump is the convergence trigger.
 * Multiple rapid edits coalesce into one re-pack run.
 *
 * Debounce window is version-aware: v1 captures use 1s (small bundle,
 * fast re-pack); v2 captures use 5s (larger bundle, ~1.5-3s pack cost
 * for tree-walking compositor, hence longer pause to coalesce). When
 * the bundle lives under iCloud Drive (`~/Library/Mobile Documents`),
 * defer to 30s idle so a 100MB bundle re-uploads on natural pauses
 * rather than every keystroke.
 *
 * The DB stays the live read path during the debounce window. A
 * crash during the window reruns the pack on next boot via the
 * `edits_version > bundle_edits_version` check the doctor applies.
 */
export function scheduleRepack(captureId: string): void {
  const existing = repackTimers.get(captureId);
  if (existing !== undefined) clearTimeout(existing);

  const delay = computeRepackDelayMs(captureId);

  const timer = setTimeout(() => {
    repackTimers.delete(captureId);
    const record = getCaptureById(captureId);
    if (record === null) return;
    const runner = record.bundle_format_version >= 2 ? runRepackV2 : runRepack;
    void runner(captureId).catch((err: unknown) => {
      log.error("bundle-store: repack failed", {
        captureId,
        message: err instanceof Error ? err.message : String(err)
      });
    });
  }, delay);
  repackTimers.set(captureId, timer);
}

const REPACK_DEBOUNCE_MS_V2 = 5_000;
const REPACK_DEBOUNCE_MS_ICLOUD = 30_000;

function computeRepackDelayMs(captureId: string): number {
  const record = getCaptureById(captureId);
  if (record === null) return REPACK_DEBOUNCE_MS;
  // iCloud-aware: a bundle sitting under ~/Library/Mobile Documents/
  // (Apple's iCloud Drive backing dir) triggers a full re-upload on
  // every re-pack. Defer to 30s idle so drawing 10 arrows in
  // succession doesn't saturate uplink with 10 separate uploads.
  if (record.bundle_path !== null && record.bundle_path.includes("/Mobile Documents/")) {
    return REPACK_DEBOUNCE_MS_ICLOUD;
  }
  if (record.bundle_format_version >= 2) return REPACK_DEBOUNCE_MS_V2;
  return REPACK_DEBOUNCE_MS;
}

/**
 * Wait for any in-flight repack on a capture to complete. Used by
 * the Phase 2 doctor reconcile pass so its central-directory walk
 * doesn't race a bundle rewrite on the same capture.
 */
export async function awaitInFlightRepack(captureId: string): Promise<void> {
  const promise = repackInFlight.get(captureId);
  if (promise !== undefined) {
    await promise;
  }
}

async function runRepack(captureId: string): Promise<void> {
  const existing = repackInFlight.get(captureId);
  if (existing !== undefined) {
    // Coalesce: a repack is already running for this capture. Wait
    // for it to finish, then start a fresh one (latest state will
    // be picked up because we re-read the DB inside the run).
    await existing;
  }

  const promise = (async () => {
    const record = getCaptureById(captureId);
    if (record === null) {
      log.warn("bundle-store: repack target missing", { captureId });
      return;
    }
    if (record.bundle_path === null) {
      // Pre-bundle (legacy) capture or row never finished writing.
      // Either case, we can't repack — skip silently. The legacy
      // migration (Phase 1) wraps these into bundles; once that's
      // done, this branch becomes unreachable.
      log.warn("bundle-store: repack skipped; no bundle path on row", { captureId });
      return;
    }

    const sourcePath = getCacheSourcePath(captureId);

    // compose() reads applied overlays via listLiveOverlays internally;
    // it produces the source-width composite as a cache file we can
    // read back. width = source width = no resize.
    const composeResult = await compose({
      captureId,
      srcPath: sourcePath,
      imageWidthPx: record.width_px,
      imageHeightPx: record.height_px,
      width: record.width_px,
      format: "png"
    });

    const compositePng = await readFile(composeResult.cachePath);
    const sourcePng = await readFile(sourcePath);

    const liveOverlays = listLiveOverlays(captureId);
    const overlaysJson = bundleOverlaysFromRows(record, liveOverlays);

    const now = new Date().toISOString();
    const filenameStem = bundleStemFromPath(record.bundle_path);
    const manifest: BundleManifestV1 = {
      bundle_format_version: 1,
      capture_id: captureId,
      source_sha256: record.sha256,
      source_dimensions: { width_px: record.width_px, height_px: record.height_px },
      paired_png_filename: `${filenameStem}.png`,
      created_at: record.captured_at,
      bundle_modified_at: now
    };

    const thumbnailJpg = await buildCompositeThumbnail(compositePng);

    const bundleBuf = await packBundle({
      manifest,
      overlays: overlaysJson,
      sourcePng,
      thumbnailJpg
    });

    // Bundle is the system of record. Atomic-rename pattern handles
    // crash safety; the doctor reconciles `bundle_edits_version`
    // against `edits_version` on next boot if we crash before the
    // DB update below.
    await atomicWriteBundle(record.bundle_path, bundleBuf);

    updateCaptureBundleAfterRepack(captureId, {
      bundle_modified_at: now,
      bundle_edits_version: record.edits_version
    });

    log.info("bundle-store: repacked", {
      captureId,
      overlaysCount: liveOverlays.length,
      bundleBytes: bundleBuf.length
    });
  })();

  repackInFlight.set(captureId, promise);
  try {
    await promise;
  } finally {
    repackInFlight.delete(captureId);
  }
}

function bundleOverlaysFromRows(
  record: CaptureRecord,
  rows: readonly OverlayRow[]
): BundleOverlaysV1 {
  return {
    overlays_format_version: 1,
    // Wire-format JSON field name for v1 bundles stays `overlays_version`
    // — that's the on-disk shape of overlays.json inside .pwrsnap v1.
    // The DB column it mirrors was renamed to `edits_version` in
    // migration 0004.
    overlays_version: record.edits_version,
    overlays: rows.map((row) => ({
      id: row.id,
      // listLiveOverlays returns rows whose `data` is an Overlay
      // (already zod-parsed at the repo boundary). The shared
      // BundleOverlayRecord schema re-validates on pack/unpack so
      // any drift surfaces loudly.
      data: row.data,
      schema_version: row.schema_version,
      source: row.source,
      z_index: row.z_index,
      created_at: row.created_at,
      applied_at: row.applied_at,
      rejected_at: row.rejected_at,
      superseded_by: row.superseded_by,
      ai_run_id: row.ai_run_id
    })),
    tags: [],
    description: null,
    ai_runs: []
  };
}

function basename(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

function uniqueBundleFilenameStem(outputDir: string, preferredStem: string): string {
  for (let index = 0; index < 100; index += 1) {
    const stem = index === 0 ? preferredStem : `${preferredStem}-${index + 1}`;
    if (!existsSync(join(outputDir, `${stem}.pwrsnap`))) return stem;
  }
  throw new Error(`bundle-store: no available filename for ${preferredStem}`);
}

// ---------------------------------------------------------------------------
// v2 capture-flow orchestrator.
// ---------------------------------------------------------------------------

/**
 * Read a screencapture-CLI temp file, dedup by sha256, and (on miss)
 * pack a v2 `.pwrsnap` bundle + paired flat PNG. Inserts the capture
 * row at `bundle_format_version = 2` and seeds the `layers` table
 * with a root group + a raster layer pointing at the single source.
 *
 * Initial v2 document has the canvas == source dimensions and one
 * raster at identity transform — visually indistinguishable from the
 * v1 path, but the bundle/document/DB tree is the v2 shape. The
 * editor can then add overlay / vector / effect layers on top.
 */
export async function persistCaptureFromTempV2(
  args: PersistCaptureFromTempArgs
): Promise<PersistCaptureFromTempResult> {
  // Lazy-import to avoid cycle: layers-repo → captures-repo →
  // bundle-store. layers-repo only used by the v2 orchestrator.
  const { insertLayerTreeForCapture } = await import("./layers-repo");

  const buf = await readFile(args.tempPath);
  const sha256 = createHash("sha256").update(buf).digest("hex");

  const existing = findCaptureBySha256(sha256);
  if (existing !== null && existing.deleted_at === null) {
    log.info("bundle-store v2: dedup hit on capture", { id: existing.id, sha256 });
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
    throw new Error(`bundle-store v2: failed to read PNG dimensions from ${args.tempPath}`);
  }

  const now = new Date().toISOString();
  const outputDir = args.outputDir ?? getCapturesRoot();
  const filenameStem = uniqueBundleFilenameStem(outputDir, buildCaptureBundleFilenameStem({
    capturedAt: now,
    sourceAppName: args.sourceApp?.appName ?? null,
    effectiveFilenameStem: null,
    sha256
  }));
  const pairedPngFilename = `${filenameStem}.png`;

  const rootGroupId = nanoid(16);
  const rasterLayerId = nanoid(16);

  const manifest: BundleManifestV2 = {
    bundle_format_version: 2,
    capture_id: id,
    canvas_dimensions: { width_px: widthPx, height_px: heightPx },
    paired_png_filename: pairedPngFilename,
    created_at: now,
    bundle_modified_at: now
  };

  const initialLayers = [
    {
      id: rootGroupId,
      parent_id: null,
      kind: "group" as const,
      collapsed: false,
      name: "Root",
      visible: true,
      locked: false,
      opacity: 1,
      blend_mode: "normal" as const,
      transform: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
      z_index: 0,
      source: "user" as const,
      ai_run_id: null,
      applied_at: now,
      rejected_at: null,
      superseded_by: null,
      created_at: now
    },
    {
      id: rasterLayerId,
      parent_id: rootGroupId,
      kind: "raster" as const,
      source_ref: { kind: "embedded" as const, sha256 },
      natural_width_px: widthPx,
      natural_height_px: heightPx,
      name: "Source",
      visible: true,
      locked: false,
      opacity: 1,
      blend_mode: "normal" as const,
      transform: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
      z_index: 0,
      source: "user" as const,
      ai_run_id: null,
      applied_at: now,
      rejected_at: null,
      superseded_by: null,
      created_at: now
    }
  ];

  const document: BundleDocumentV2 = {
    document_format_version: 1,
    edits_version: 0,
    layers: initialLayers,
    tags: [],
    description: null,
    ai_runs: []
  };

  // Pack v2 bundle. Single source → single sources/<sha>.png entry;
  // no rasterized layers yet. Initial composite == source bytes, so
  // the thumbnail is built from the source PNG directly.
  const bundlePath = join(outputDir, `${filenameStem}.pwrsnap`);

  const thumbnailJpg = await buildCompositeThumbnail(buf);

  const bundleBuf = await packBundleV2({
    manifest,
    document,
    sources: new Map([[sha256, buf]]),
    layerBytes: new Map(),
    thumbnailJpg
  });

  await atomicWriteBundle(bundlePath, bundleBuf);

  // Materialize source.png to per-capture cache.
  const cacheSource = getCacheSourcePath(id);
  await mkdir(dirname(cacheSource), { recursive: true });
  await writeFile(cacheSource, buf);

  try {
    await unlink(args.tempPath);
  } catch {
    // best-effort
  }

  const { record } = insertOrFindCapture({
    id,
    kind: "image",
    captured_at: now,
    source_app_bundle_id: args.sourceApp?.bundleId ?? null,
    source_app_name: args.sourceApp?.appName ?? null,
    legacy_src_path: null,
    bundle_path: bundlePath,
    flat_png_path: null,
    bundle_modified_at: now,
    bundle_format_version: 2,
    bundle_edits_version: 0,
    width_px: widthPx,
    height_px: heightPx,
    device_pixel_ratio: args.devicePixelRatio ?? 2,
    byte_size: buf.length,
    sha256
  });

  // Seed the layers table so listLayerTree returns the initial tree
  // without re-reading the bundle. The bundle's document.json is the
  // durable record; the layers table is the cached projection.
  insertLayerTreeForCapture(id, initialLayers);

  log.info("bundle-store: persisted new v2 capture", {
    id,
    bundlePath,
    byteSize: buf.length,
    widthPx,
    heightPx
  });

  return { record, isDedup: false };
}

// ---------------------------------------------------------------------------
// v2 repack — re-renders composite from layer tree, re-packs bundle.
// ---------------------------------------------------------------------------

async function runRepackV2(captureId: string): Promise<void> {
  const existing = repackInFlight.get(captureId);
  if (existing !== undefined) {
    await existing;
  }

  const { listLayerTree } = await import("./layers-repo");
  const { composeV2 } = await import("../render/compose-tree");

  const promise = (async () => {
    const record = getCaptureById(captureId);
    if (record === null) {
      log.warn("bundle-store: v2 repack target missing", { captureId });
      return;
    }
    if (record.bundle_path === null) {
      log.warn("bundle-store: v2 repack skipped; no bundle path on row", { captureId });
      return;
    }

    // Walk the layer tree to produce a fresh composite at canvas
    // resolution. composeV2 writes to its own cache dir; we read the
    // resulting bytes back to derive the in-bundle thumbnail.
    const composeResult = await composeV2({
      captureId,
      bundlePath: record.bundle_path,
      canvasWidthPx: record.width_px,
      canvasHeightPx: record.height_px,
      width: record.width_px, // no resize for the bundle's composite
      format: "png"
    });
    const compositePng = await readFile(composeResult.cachePath);

    // Re-collect sources: every raster layer in the live tree
    // references a source by sha. Read each from the cache (we
    // materialized them at capture time / on first read via
    // readSourceFromBundle).
    const layers = listLayerTree(captureId);
    const sources = new Map<string, Buffer>();
    for (const node of layers) {
      if (node.kind === "raster" && !sources.has(node.source_ref.sha256)) {
        try {
          const bytes = await readSourceFromBundle(record.bundle_path, node.source_ref.sha256);
          sources.set(node.source_ref.sha256, bytes);
        } catch (cause) {
          log.warn("bundle-store: v2 repack failed to read source", {
            captureId,
            sha: node.source_ref.sha256.slice(0, 8),
            message: cause instanceof Error ? cause.message : String(cause)
          });
        }
      }
    }

    const now = new Date().toISOString();
    const filenameStem = bundleStemFromPath(record.bundle_path);
    const manifest: BundleManifestV2 = {
      bundle_format_version: 2,
      capture_id: captureId,
      canvas_dimensions: { width_px: record.width_px, height_px: record.height_px },
      paired_png_filename: `${filenameStem}.png`,
      created_at: record.captured_at,
      bundle_modified_at: now
    };
    const document: BundleDocumentV2 = {
      document_format_version: 1,
      edits_version: record.edits_version,
      layers,
      tags: [],
      description: null,
      ai_runs: []
    };

    const thumbnailJpg = await buildCompositeThumbnail(compositePng);

    const bundleBuf = await packBundleV2({
      manifest,
      document,
      sources,
      layerBytes: new Map(), // v2.0: no rasterized effects yet
      thumbnailJpg
    });

    await atomicWriteBundle(record.bundle_path, bundleBuf);

    updateCaptureBundleAfterRepack(captureId, {
      bundle_modified_at: now,
      bundle_edits_version: record.edits_version
    });

    log.info("bundle-store: v2 repacked", {
      captureId,
      layerCount: layers.length,
      bundleBytes: bundleBuf.length
    });
  })();

  repackInFlight.set(captureId, promise);
  try {
    await promise;
  } finally {
    repackInFlight.delete(captureId);
  }
}

// ---------------------------------------------------------------------------
// Trash + GC for bundle pairs.
// ---------------------------------------------------------------------------

const TRASH_RETENTION_DAYS = 14;

/**
 * Move a bundle + paired PNG to `<userData>/.trash/<id>/`. Two
 * atomic renames (paired PNG first, bundle second), reversed on
 * failure so a partial failure never leaves the SoR (the bundle)
 * orphaned in the live folder while the derivative (the paired
 * PNG) sits in trash.
 *
 * Idempotent: missing files are silently skipped (deleted-out-of-band
 * by Finder, already-trashed twice in a row, etc.).
 */
export async function moveBundlePairToTrash(args: {
  captureId: string;
  bundlePath: string | null;
  flatPngPath: string | null;
}): Promise<void> {
  const trashDir = join(getTrashRoot(), args.captureId);
  await mkdir(trashDir, { recursive: true });

  const pngTrashPath =
    args.flatPngPath !== null ? join(trashDir, basename(args.flatPngPath)) : null;
  const bundleTrashPath =
    args.bundlePath !== null ? join(trashDir, basename(args.bundlePath)) : null;

  // Paired PNG FIRST (derivative). On failure here, nothing's
  // moved — return early; the live folder is still consistent.
  if (args.flatPngPath !== null && pngTrashPath !== null && existsSync(args.flatPngPath)) {
    try {
      await rename(args.flatPngPath, pngTrashPath);
    } catch (cause) {
      log.warn("trash move: paired PNG rename failed (bailing before bundle move)", {
        captureId: args.captureId,
        flatPngPath: args.flatPngPath,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return;
    }
  }

  // Bundle SECOND (system of record). On failure, reverse the
  // PNG move so the live folder converges back to its prior state.
  if (args.bundlePath !== null && bundleTrashPath !== null && existsSync(args.bundlePath)) {
    try {
      await rename(args.bundlePath, bundleTrashPath);
    } catch (cause) {
      log.warn("trash move: bundle rename failed; reversing paired-PNG rename", {
        captureId: args.captureId,
        bundlePath: args.bundlePath,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      if (
        args.flatPngPath !== null &&
        pngTrashPath !== null &&
        existsSync(pngTrashPath)
      ) {
        try {
          await rename(pngTrashPath, args.flatPngPath);
        } catch (reverseCause) {
          log.error(
            "trash move: reverse rename also failed; bundle pair is now split — surface to user via doctor",
            {
              captureId: args.captureId,
              message: reverseCause instanceof Error ? reverseCause.message : String(reverseCause)
            }
          );
        }
      }
      throw cause;
    }
  }
}

/**
 * Restore a bundle + paired PNG from `<userData>/.trash/<id>/` to
 * their original locations. Inverse of `moveBundlePairToTrash`.
 * Skips missing files (idempotent).
 */
export async function restoreBundlePairFromTrash(args: {
  captureId: string;
  bundlePath: string | null;
  flatPngPath: string | null;
}): Promise<void> {
  const trashDir = join(getTrashRoot(), args.captureId);

  if (args.flatPngPath !== null) {
    const pngTrashPath = join(trashDir, basename(args.flatPngPath));
    if (existsSync(pngTrashPath)) {
      await mkdir(dirname(args.flatPngPath), { recursive: true });
      await rename(pngTrashPath, args.flatPngPath);
    }
  }
  if (args.bundlePath !== null) {
    const bundleTrashPath = join(trashDir, basename(args.bundlePath));
    if (existsSync(bundleTrashPath)) {
      await mkdir(dirname(args.bundlePath), { recursive: true });
      await rename(bundleTrashPath, args.bundlePath);
    }
  }

  // Best-effort cleanup of the per-id trash directory if it's empty.
  try {
    const remaining = await readdir(trashDir);
    if (remaining.length === 0) {
      await rm(trashDir, { recursive: true, force: true });
    }
  } catch {
    // best-effort
  }
}

/**
 * Hard-remove a single capture's bundle-pair trash directory. Used
 * by `library:purge` and `library:purgeAll`. Idempotent — missing
 * trash dir is a no-op. Does not touch the legacy `<id>.png` flat
 * trash file; callers that need to clean both call
 * `purgeOneFromTrash` (legacy) + this in sequence.
 */
export async function purgeBundlePairFromTrash(captureId: string): Promise<void> {
  const trashDir = join(getTrashRoot(), captureId);
  if (!existsSync(trashDir)) return;
  await rm(trashDir, { recursive: true, force: true });
}

/**
 * Boot-time GC for bundle-pair trash. Walks every per-id directory
 * under `<userData>/.trash/<id>/`, removes those whose mtime
 * exceeds TRASH_RETENTION_DAYS. Pairs cleanly with `sweepTrash`
 * from source-store (which still handles legacy `<id>.png` flat
 * trash files); both are called from `runBootGc()`.
 */
export async function sweepBundleTrash(
  expiredCaptureIds: readonly string[]
): Promise<{ removedDirs: number }> {
  const trashRoot = getTrashRoot();
  if (!existsSync(trashRoot)) {
    return { removedDirs: 0 };
  }

  const cutoffMs = Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;

  for (const id of expiredCaptureIds) {
    const trashDir = join(trashRoot, id);
    if (!existsSync(trashDir)) continue;
    try {
      const stat = statSync(trashDir);
      if (!stat.isDirectory()) continue;
      if (stat.mtimeMs < cutoffMs) {
        await rm(trashDir, { recursive: true, force: true });
        removed += 1;
      }
    } catch (err) {
      log.warn("bundle trash sweep failed for capture", {
        captureId: id,
        message: err instanceof Error ? err.message : String(err)
      });
    }
  }

  if (removed > 0) {
    log.info("bundle trash swept", { removedDirs: removed });
  }
  return { removedDirs: removed };
}
