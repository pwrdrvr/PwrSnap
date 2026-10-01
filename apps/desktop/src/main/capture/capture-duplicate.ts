// Duplicate a capture into a new, independent one (`capture:duplicate`).
//
// A copy owns everything it points at — its own id, its own `.pwrsnap`
// bundle or video file, its own layer ids and enrichment rows. Nothing is
// shared with the source, because delete and purge are keyed by each row's
// own paths: a shared file would be removed out from under whichever row
// outlived the other.
//
// Three shapes:
//
//   image, with edits   The source bundle, brought current, re-packed under
//                       a new capture id with every layer id remapped
//                       (layers.id is a global primary key). Same path the
//                       .pwrsnap importer takes.
//   image, base only    The base raster alone, through the ordinary capture
//                       persist path — exactly what a fresh capture of the
//                       same pixels would have produced.
//   video               The recording cloned (APFS clonefile where the
//                       volume supports it, a byte copy otherwise), plus a
//                       video_captures row. With edits keeps the trim and
//                       cuts; without, the full recording.
//
// Every copy is `captured_at = now` so it sorts to the top, and joins the
// source's family (see capture-families-repo.ts). Enrichment is copied, not
// re-run.

import { constants as fsConstants } from "node:fs";
import { copyFile, lstat, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

import type { CaptureEditSummary, CaptureRecord } from "@pwrsnap/shared";
import { summarizeImageEdits, summarizeVideoEdits } from "@pwrsnap/shared";
import { nanoid } from "nanoid";

import { getMainLogger } from "../log";
import { buildCaptureBundleFilenameStem } from "../persistence/bundle-filename";
import { renameBundleToEffectiveFilename } from "../persistence/bundle-filename-maintenance";
import { readBundleFilenameTimestampZone } from "../persistence/bundle-filename-settings";
import { writePortableBundleCarrier } from "../persistence/bundle-carrier-repo";
import {
  atomicWriteBundle,
  awaitInFlightRepack,
  manifestLineage,
  packBundleV2,
  persistCaptureFromTempV2,
  readSourceForCapture,
  repackCaptureNow,
  runExclusiveBundleFileOperation,
  scheduleRepack
} from "../persistence/bundle-store";
import {
  copyCaptureEnrichment,
  rootCaptureFamily
} from "../persistence/capture-families-repo";
import { getCaptureById, insertCapture } from "../persistence/captures-repo";
import { getDb } from "../persistence/db";
import { insertImportedLayerTreeForCapture, listLayerTree } from "../persistence/layers-repo";
import { remapPortableBundleMetadata } from "../persistence/portable-bundle-metadata";
import { renameVideoSourceToEffectiveFilename } from "../persistence/video-filename-maintenance";
import { runWithCapturesDirFallback } from "./capture-storage-gate";

const log = getMainLogger("pwrsnap:capture-duplicate");

const MAX_STEM_PROBES = 100;

/** A duplicate refused for a reason the caller can name. */
export class CaptureDuplicateError extends Error {
  constructor(
    readonly code: "not_found" | "trashed" | "unsupported",
    message: string
  ) {
    super(message);
    this.name = "CaptureDuplicateError";
  }
}

/** What a "with edits" copy would carry that a base copy would not. */
export function captureEditSummary(record: CaptureRecord): CaptureEditSummary {
  if (record.kind === "video") {
    return summarizeVideoEdits({
      durationSec: record.video?.durationSec ?? 0,
      segments: record.video?.segments ?? []
    });
  }
  return summarizeImageEdits(listLayerTree(record.id), record);
}

export async function duplicateCapture(
  sourceId: string,
  options: { withEdits: boolean }
): Promise<CaptureRecord> {
  const source = getCaptureById(sourceId);
  if (source === null) {
    throw new CaptureDuplicateError("not_found", "That snap no longer exists.");
  }
  if (source.deleted_at !== null) {
    throw new CaptureDuplicateError("trashed", "Restore the snap from Trash to duplicate it.");
  }

  // A snap outside any family roots a new one at itself. The row is only
  // written when the copy commits (`rootSource`, called in its transaction).
  const lineage = { familyId: source.family_id ?? sourceId, duplicatedFrom: sourceId };
  const capturedAt = new Date().toISOString();
  let sourceRooted = false;
  const rootSource = (): void => {
    if (rootCaptureFamily(sourceId)) sourceRooted = true;
  };

  let newId: string;
  if (source.kind === "video") {
    newId = await duplicateVideo(source, lineage, capturedAt, options.withEdits, rootSource);
  } else if (source.bundle_format_version === 2 && source.bundle_path !== null) {
    newId = options.withEdits
      ? await duplicateImageWithEdits(source, lineage, capturedAt, rootSource)
      : await duplicateImageBaseOnly(source, lineage, capturedAt, rootSource);
  } else {
    throw new CaptureDuplicateError("unsupported", "This snap has no bundle to copy.");
  }

  // The source's bundle manifest mirrors its lineage; it just changed.
  if (sourceRooted) scheduleRepack(sourceId);

  await renameCopyToEffectiveFilename(newId, source.kind);

  const record = getCaptureById(newId);
  if (record === null) throw new Error("capture-duplicate: copy disappeared after insert");
  log.info("capture duplicated", {
    sourceId,
    captureId: newId,
    kind: source.kind,
    withEdits: options.withEdits
  });
  return record;
}

// ---------------------------------------------------------------------------
// Image
// ---------------------------------------------------------------------------

async function duplicateImageWithEdits(
  source: CaptureRecord,
  lineage: { familyId: string; duplicatedFrom: string },
  capturedAt: string,
  rootSource: () => void
): Promise<string> {
  // The bundle is the portable truth, but the DB can be ahead of it for the
  // repack debounce window. Bring it current, then read it under the same
  // per-capture lock that renames and repacks take.
  if (source.edits_version > source.bundle_edits_version) {
    await repackCaptureNow(source.id);
  } else {
    await awaitInFlightRepack(source.id);
  }
  // Lazy: the import modules are only needed when a copy is actually made,
  // so they stay out of capture-handlers' load graph.
  const { remapCollidingLayerIds } = await import("../import/pwrsnap-import-service");
  const { readAndValidateInstalledPwrsnapBundle } = await import(
    "../import/pwrsnap-import-reader"
  );
  const bundle = await runExclusiveBundleFileOperation(source.id, async () => {
    const current = getCaptureById(source.id);
    if (current === null || current.bundle_path === null) {
      throw new CaptureDuplicateError("not_found", "That snap no longer exists.");
    }
    return readAndValidateInstalledPwrsnapBundle(current.bundle_path);
  });

  const newId = nanoid(16);
  // Every source layer id is already in the table, so every one remaps.
  const remapped = remapCollidingLayerIds(bundle.document, bundle.layerBytes, {
    captureId: newId,
    contentDigest: bundle.contentDigest,
    idExists: layerIdExists
  });
  const portableMetadata = remapPortableBundleMetadata(
    bundle.portableMetadata,
    remapped.layerIdMap
  );
  const baseSource = bundle.sourceInfo.get(bundle.baseSourceSha256);
  const timestampZone = await readBundleFilenameTimestampZone();

  return runWithCapturesDirFallback(async (capturesRoot) => {
    const stem = await availableBundleStem(
      capturesRoot,
      buildCaptureBundleFilenameStem({
        capturedAt,
        sourceAppName: source.source_app_name,
        effectiveFilenameStem: null,
        sha256: source.sha256,
        timestampZone
      })
    );
    const bundlePath = join(capturesRoot, `${stem}.pwrsnap`);
    const manifest = {
      ...bundle.manifest,
      capture_id: newId,
      paired_png_filename: `${stem}.png`,
      created_at: capturedAt,
      bundle_modified_at: capturedAt,
      ...manifestLineage({
        family_id: lineage.familyId,
        duplicated_from: lineage.duplicatedFrom
      })
    };
    const bytes = await packBundleV2({
      manifest,
      document: remapped.document,
      portableMetadata,
      sources: bundle.sources,
      layerBytes: remapped.layerBytes,
      thumbnailJpg: bundle.thumbnailJpg
    });
    await atomicWriteBundle(bundlePath, bytes);

    try {
      const db = getDb();
      db.transaction(() => {
        rootSource();
        insertCapture({
          id: newId,
          kind: "image",
          captured_at: capturedAt,
          source_app_bundle_id: source.source_app_bundle_id,
          source_app_name: source.source_app_name,
          source_window_title: source.source_window_title,
          legacy_src_path: null,
          bundle_path: bundlePath,
          flat_png_path: null,
          bundle_modified_at: capturedAt,
          bundle_format_version: 2,
          bundle_edits_version: remapped.document.edits_version,
          width_px: manifest.canvas_dimensions.width_px,
          height_px: manifest.canvas_dimensions.height_px,
          device_pixel_ratio: source.device_pixel_ratio,
          byte_size: baseSource?.bytes.length ?? source.byte_size,
          sha256: bundle.baseSourceSha256,
          has_alpha: source.has_alpha,
          family_id: lineage.familyId,
          duplicated_from: lineage.duplicatedFrom
        });
        insertImportedLayerTreeForCapture(newId, remapped.document.layers);
        writePortableBundleCarrier(newId, remapped.document, portableMetadata);
        db.prepare(
          `UPDATE captures
              SET edits_version = @edits_version,
                  bundle_edits_version = @edits_version
            WHERE id = @id`
        ).run({ id: newId, edits_version: remapped.document.edits_version });
        copyCaptureEnrichment({ fromId: source.id, toId: newId, familyId: lineage.familyId });
      })();
    } catch (cause) {
      await rm(bundlePath, { force: true }).catch(() => undefined);
      throw cause;
    }
    return newId;
  });
}

async function duplicateImageBaseOnly(
  source: CaptureRecord,
  lineage: { familyId: string; duplicatedFrom: string },
  capturedAt: string,
  rootSource: () => void
): Promise<string> {
  const bundlePath = source.bundle_path;
  if (bundlePath === null) {
    throw new CaptureDuplicateError("unsupported", "This snap has no bundle to copy.");
  }
  const baseBytes = await readSourceForCapture(source.id, bundlePath, source.sha256);
  const tempDir = await mkdtemp(join(tmpdir(), "pwrsnap-duplicate-"));
  const tempPath = join(tempDir, "base.png");
  try {
    await writeFile(tempPath, baseBytes);
    const { record } = await runWithCapturesDirFallback((outputDir) =>
      persistCaptureFromTempV2({
        tempPath,
        sourceApp: {
          bundleId: source.source_app_bundle_id,
          appName: source.source_app_name
        },
        sourceWindowTitle: source.source_window_title,
        capturedAt,
        outputDir,
        devicePixelRatio: source.device_pixel_ratio,
        lineage
      })
    );
    // The persist path inserted the copy in its own transaction; the root
    // follows it here, before the copy's enrichment is numbered against
    // the family.
    getDb().transaction(() => {
      rootSource();
      copyCaptureEnrichment({ fromId: source.id, toId: record.id, familyId: lineage.familyId });
    })();
    return record.id;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------

async function duplicateVideo(
  source: CaptureRecord,
  lineage: { familyId: string; duplicatedFrom: string },
  capturedAt: string,
  withEdits: boolean,
  rootSource: () => void
): Promise<string> {
  const sourcePath = source.legacy_src_path;
  if (sourcePath === null) {
    throw new CaptureDuplicateError("unsupported", "This recording has no file to copy.");
  }
  const newId = nanoid(16);
  const ext = extname(sourcePath).toLowerCase() || ".mp4";

  return runWithCapturesDirFallback(async (capturesRoot) => {
    const destPath = join(capturesRoot, `${newId}${ext}`);
    await cloneFile(sourcePath, destPath);
    try {
      const db = getDb();
      db.transaction(() => {
        rootSource();
        insertCapture({
          id: newId,
          kind: "video",
          captured_at: capturedAt,
          source_app_bundle_id: source.source_app_bundle_id,
          source_app_name: source.source_app_name,
          source_window_title: source.source_window_title,
          legacy_src_path: destPath,
          width_px: source.width_px,
          height_px: source.height_px,
          device_pixel_ratio: source.device_pixel_ratio,
          // Identical bytes, so the source's hash and size hold.
          byte_size: source.byte_size,
          sha256: source.sha256,
          family_id: lineage.familyId,
          duplicated_from: lineage.duplicatedFrom
        });
        copyVideoMetadata(source.id, newId, withEdits);
        copyCaptureEnrichment({ fromId: source.id, toId: newId, familyId: lineage.familyId });
      })();
    } catch (cause) {
      await rm(destPath, { force: true }).catch(() => undefined);
      throw cause;
    }
    return newId;
  });
}

/**
 * Copy the source's `video_captures` row. Columns are read from the table
 * rather than listed, so one added by a later migration is carried
 * without anyone remembering this function. Two are reset: the preview
 * proxy (a per-capture file this copy does not have) and, for a base
 * copy, the edit — back to the full recording.
 */
function copyVideoMetadata(fromId: string, toId: string, withEdits: boolean): void {
  const db = getDb();
  const columns = (
    db.prepare("PRAGMA table_info(video_captures)").all() as Array<{ name: string }>
  ).map((column) => column.name);
  const overrides: Record<string, string> = {
    capture_id: "@toId",
    preview_path: "NULL",
    preview_status: "'pending'"
  };
  if (!withEdits) {
    overrides.default_range_start_sec = "0";
    overrides.default_range_end_sec = "duration_sec";
    overrides.segments_json = "NULL";
  }
  const selectList = columns.map((name) => overrides[name] ?? name).join(", ");
  const result = db
    .prepare(
      `INSERT INTO video_captures (${columns.join(", ")})
       SELECT ${selectList} FROM video_captures WHERE capture_id = @fromId`
    )
    .run({ fromId, toId });
  if (result.changes !== 1) {
    throw new CaptureDuplicateError("unsupported", "This recording has no video metadata.");
  }
}

/**
 * Copy `src` to `dest` without ever exposing a partial `dest`: clone (or
 * copy) to a hidden sibling, then rename. `COPYFILE_FICLONE` makes the copy
 * a copy-on-write clone on APFS / Btrfs / ReFS and falls back to a byte
 * copy elsewhere, so a multi-gigabyte recording duplicates instantly on the
 * common case.
 */
async function cloneFile(src: string, dest: string): Promise<void> {
  const staging = `${dest}.partial`;
  try {
    await copyFile(src, staging, fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE);
    await rename(staging, dest);
  } catch (cause) {
    await rm(staging, { force: true }).catch(() => undefined);
    throw cause;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The capture-time stem, or the first `-N` variant not already on disk.
 *  Async on purpose: the captures root is TCC-gated (see AGENTS.md). */
async function availableBundleStem(dir: string, preferred: string): Promise<string> {
  for (let index = 0; index < MAX_STEM_PROBES; index += 1) {
    const stem = index === 0 ? preferred : `${preferred}-${index + 1}`;
    try {
      await lstat(join(dir, `${stem}.pwrsnap`));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return stem;
      throw cause;
    }
  }
  throw new Error("capture-duplicate: no available bundle filename");
}

async function renameCopyToEffectiveFilename(
  captureId: string,
  kind: CaptureRecord["kind"]
): Promise<void> {
  try {
    if (kind === "video") await renameVideoSourceToEffectiveFilename(captureId);
    else await renameBundleToEffectiveFilename(captureId);
  } catch (cause) {
    // The copy is complete under its capture-time name; the boot
    // maintenance pass retries the rename.
    log.warn("duplicate filename rename skipped", {
      captureId,
      message: cause instanceof Error ? cause.message : String(cause)
    });
  }
}

function layerIdExists(id: string): boolean {
  return getDb().prepare<[string]>("SELECT 1 FROM layers WHERE id = ?").get(id) !== undefined;
}
