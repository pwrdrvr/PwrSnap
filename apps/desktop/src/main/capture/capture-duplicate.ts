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
//   video               The recording cloned (APFS clonefile, a Linux
//                       reflink) where the volume can, plus a
//                       video_captures row. With edits keeps the trim and
//                       cuts; without, the full recording. A recording that
//                       cannot be cloned is byte-copied in the BACKGROUND:
//                       the command answers at once with a job, progress
//                       goes out on `events:capture-duplicate:job`, the user
//                       can cancel, and the row appears only once the file
//                       is whole (see "Video" below).
//
// Every copy is `captured_at = now` so it sorts to the top, and joins the
// source's family (see capture-families-repo.ts). Enrichment is copied, not
// re-run.

import { lstat, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

import type { CaptureDuplicateJob, CaptureEditSummary, CaptureRecord } from "@pwrsnap/shared";
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
import {
  deleteCaptureDuplicateIntent,
  insertCaptureDuplicateIntent,
  listCaptureDuplicateIntents
} from "../persistence/capture-duplicate-intents-repo";
import { getCaptureById, insertCapture } from "../persistence/captures-repo";
import { getDb } from "../persistence/db";
import { insertImportedLayerTreeForCapture, listLayerTree } from "../persistence/layers-repo";
import { remapPortableBundleMetadata } from "../persistence/portable-bundle-metadata";
import { renameVideoSourceToEffectiveFilename } from "../persistence/video-filename-maintenance";
import {
  runExclusiveCapturesRootOperation,
  runWithCapturesDirFallback
} from "./capture-storage-gate";
import {
  claimDuplicateSource,
  finishDuplicateJob,
  isDuplicateCopyLive,
  reportDuplicateProgress,
  startDuplicateJob,
  waitForDuplicateJob,
  type StartedDuplicateJob
} from "./duplicate-jobs";
import { cloneFileFast, streamCopyFile } from "./file-copy";

const log = getMainLogger("pwrsnap:capture-duplicate");

const MAX_STEM_PROBES = 100;

/** A duplicate refused for a reason the caller can name. */
export class CaptureDuplicateError extends Error {
  constructor(
    readonly code: "not_found" | "trashed" | "unsupported" | "in_progress",
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

/**
 * What `capture:duplicate` answers: the committed copy, or — for a video
 * that has to be byte-copied — the background job that will commit it.
 */
export type DuplicateOutcome =
  | { record: CaptureRecord; job: null }
  | { record: null; job: CaptureDuplicateJob };

export type DuplicateOptions = {
  withEdits: boolean;
  /**
   * The copy's row has committed: synchronously for images and clones,
   * later for a background copy. The handler broadcasts from here, since
   * a background copy commits long after the command has answered.
   */
  onCommitted?: (record: CaptureRecord) => void;
};

export async function startCaptureDuplicate(
  sourceId: string,
  options: DuplicateOptions
): Promise<DuplicateOutcome> {
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
  const finish = async (newId: string): Promise<CaptureRecord> => {
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
    options.onCommitted?.(record);
    return record;
  };

  if (source.kind === "video") {
    return startVideoDuplicate(source, lineage, capturedAt, options.withEdits, rootSource, finish);
  }
  if (source.bundle_format_version !== 2 || source.bundle_path === null) {
    throw new CaptureDuplicateError("unsupported", "This snap has no bundle to copy.");
  }
  const newId = options.withEdits
    ? await duplicateImageWithEdits(source, lineage, capturedAt, rootSource)
    : await duplicateImageBaseOnly(source, lineage, capturedAt, rootSource);
  return { record: await finish(newId), job: null };
}

/**
 * Duplicate and wait for the copy to commit, however long a background
 * video copy takes. For callers with no UI to report progress to.
 */
export async function duplicateCapture(
  sourceId: string,
  options: DuplicateOptions
): Promise<CaptureRecord> {
  const outcome = await startCaptureDuplicate(sourceId, options);
  if (outcome.record !== null) return outcome.record;
  const end = await waitForDuplicateJob(outcome.job.jobId);
  const record = end?.state === "done" ? getCaptureById(end.captureId) : null;
  if (record === null) {
    throw new Error(end?.error ?? `capture-duplicate: copy ${end?.state ?? "lost"}`);
  }
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
  const { PwrsnapImportError, readAndValidateInstalledPwrsnapBundle } = await import(
    "../import/pwrsnap-import-reader"
  );
  const bundle = await runExclusiveBundleFileOperation(source.id, async () => {
    const current = getCaptureById(source.id);
    if (current === null || current.bundle_path === null) {
      throw new CaptureDuplicateError("not_found", "That snap no longer exists.");
    }
    try {
      return await readAndValidateInstalledPwrsnapBundle(current.bundle_path);
    } catch (cause) {
      // The live view skips a layer it can't parse (one drawn by a newer
      // build); the bundle reader validates strictly and rejects the
      // whole document. Copying around that layer would silently drop an
      // annotation, so refuse, and say which copy still works.
      if (cause instanceof PwrsnapImportError && cause.code === "document_schema_invalid") {
        throw new CaptureDuplicateError(
          "unsupported",
          "This snap has an annotation this version of PwrSnap can't read, so it can't be copied with its edits. Base Image Only still works."
        );
      }
      throw cause;
    }
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

type VideoCopyPaths = {
  captureId: string;
  sourceId: string;
  stagingPath: string;
  destPath: string;
};

/**
 * Every video duplicate follows one protocol, cloned or not:
 *
 *   1. an intent row names the two paths this copy may write
 *      (migration 0036);
 *   2. the bytes land in `<dest>.partial` — a name no capture row points
 *      at, so nothing can list, play or export it;
 *   3. `<dest>.partial` is renamed to `<dest>`, and in the same tick one
 *      transaction inserts the capture row and deletes the intent.
 *
 * Any failure removes both paths and the intent. A crash leaves the
 * intent, and the next start removes the paths it names
 * (`recoverInterruptedVideoDuplicates`) — no directory is ever listed.
 *
 * Steps 1 and 2's clone attempt run under the captures-root lock, like
 * every write into the root; a clone is instant, or abandoned after
 * CLONE_GRACE_MS. A byte copy does NOT: holding the lock for minutes
 * would stall every screenshot taken meanwhile. It streams outside the
 * lock and takes it again only for step 3.
 */
async function startVideoDuplicate(
  source: CaptureRecord,
  lineage: { familyId: string; duplicatedFrom: string },
  capturedAt: string,
  withEdits: boolean,
  rootSource: () => void,
  finish: (newId: string) => Promise<CaptureRecord>
): Promise<DuplicateOutcome> {
  const sourcePath = source.legacy_src_path;
  if (sourcePath === null) {
    throw new CaptureDuplicateError("unsupported", "This recording has no file to copy.");
  }
  const newId = nanoid(16);
  const release = claimDuplicateSource(source.id, newId);
  if (release === null) {
    throw new CaptureDuplicateError(
      "in_progress",
      "PwrSnap is already copying this recording. Wait for it to finish, or cancel it."
    );
  }
  const ext = extname(sourcePath).toLowerCase() || ".mp4";
  const commit = (paths: VideoCopyPaths): void => {
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
        legacy_src_path: paths.destPath,
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
      deleteCaptureDuplicateIntent(newId);
    })();
  };
  let handedOff = false;
  try {
    const started = await runWithCapturesDirFallback(async (capturesRoot) => {
      const destPath = join(capturesRoot, `${newId}${ext}`);
      const attempt: VideoCopyPaths = {
        captureId: newId,
        sourceId: source.id,
        stagingPath: `${destPath}.partial`,
        destPath
      };
      insertCaptureDuplicateIntent(attempt);
      try {
        if (await cloneFileFast(sourcePath, attempt.stagingPath)) {
          await publishVideoCopy(attempt, commit);
          return { cloned: true as const, paths: attempt, totalBytes: 0 };
        }
        const totalBytes = (await stat(sourcePath)).size;
        return { cloned: false as const, paths: attempt, totalBytes };
      } catch (cause) {
        await discardVideoCopy(attempt);
        throw cause;
      }
    });
    if (started.cloned) return { record: await finish(newId), job: null };

    const job = startDuplicateJob({
      sourceId: source.id,
      captureId: newId,
      withEdits,
      totalBytes: started.totalBytes
    });
    handedOff = true;
    void copyVideoInBackground(job, sourcePath, started.paths, commit, finish)
      .catch((cause: unknown) => {
        log.error("video duplicate crashed", {
          captureId: newId,
          message: cause instanceof Error ? cause.message : String(cause)
        });
        finishDuplicateJob(job.jobId, "failed", "PwrSnap could not copy the recording.");
      })
      .finally(release);
    return { record: null, job: job.snapshot };
  } finally {
    if (!handedOff) release();
  }
}

async function copyVideoInBackground(
  job: StartedDuplicateJob,
  sourcePath: string,
  paths: VideoCopyPaths,
  commit: (paths: VideoCopyPaths) => void,
  finish: (newId: string) => Promise<CaptureRecord>
): Promise<void> {
  let committed = false;
  try {
    await streamCopyFile(sourcePath, paths.stagingPath, {
      signal: job.signal,
      onProgress: (copied, total) => reportDuplicateProgress(job.jobId, copied, total)
    });
    await runExclusiveCapturesRootOperation(async () => {
      if (!job.beginCommit()) job.signal.throwIfAborted();
      // The original can be purged while its copy streams. Its
      // video_captures row goes with it, and that is what the copy's is
      // made from.
      if (getCaptureById(paths.sourceId) === null) {
        throw new CaptureDuplicateError(
          "not_found",
          "The original recording was deleted while it was being copied."
        );
      }
      await publishVideoCopy(paths, commit);
      committed = true;
    });
    await finish(paths.captureId);
    finishDuplicateJob(job.jobId, "done");
  } catch (cause) {
    if (committed) {
      // The capture exists; only the follow-up (rename to its effective
      // filename) failed, and boot maintenance retries that.
      log.warn("duplicate committed, follow-up failed", {
        captureId: paths.captureId,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      finishDuplicateJob(job.jobId, "done");
      return;
    }
    await discardVideoCopy(paths);
    if (job.signal.aborted) {
      log.info("video duplicate cancelled", { sourceId: paths.sourceId, captureId: paths.captureId });
      finishDuplicateJob(job.jobId, "cancelled");
      return;
    }
    log.error("video duplicate failed", {
      sourceId: paths.sourceId,
      captureId: paths.captureId,
      message: cause instanceof Error ? cause.message : String(cause)
    });
    finishDuplicateJob(
      job.jobId,
      "failed",
      cause instanceof CaptureDuplicateError ? cause.message : "PwrSnap could not copy the recording."
    );
  }
}

/** Step 3 of the protocol: rename into place, commit in the same tick.
 *  A failed commit takes the file back out. */
async function publishVideoCopy(
  paths: VideoCopyPaths,
  commit: (paths: VideoCopyPaths) => void
): Promise<void> {
  await rename(paths.stagingPath, paths.destPath);
  try {
    commit(paths);
  } catch (cause) {
    await discardVideoCopy(paths);
    throw cause;
  }
}

/** Remove everything an uncommitted copy may have written, then its
 *  intent. The intent goes last: if a removal fails, the next start
 *  tries again. */
async function discardVideoCopy(paths: VideoCopyPaths): Promise<void> {
  const removals = await Promise.allSettled([
    rm(paths.stagingPath, { force: true }),
    rm(paths.destPath, { force: true })
  ]);
  if (removals.some((removal) => removal.status === "rejected")) {
    log.warn("video duplicate cleanup incomplete; retrying at next start", {
      captureId: paths.captureId
    });
    return;
  }
  deleteCaptureDuplicateIntent(paths.captureId);
}

/**
 * Clean up after video duplicates that never committed — the process quit
 * or crashed mid-copy, or between the rename and the insert. Run once at
 * startup by the process that owns `capture:*`. Touches only the two
 * paths each intent names, and skips copies still running here.
 */
export async function recoverInterruptedVideoDuplicates(): Promise<number> {
  let recovered = 0;
  for (const intent of listCaptureDuplicateIntents()) {
    if (isDuplicateCopyLive(intent.captureId)) continue;
    if (getCaptureById(intent.captureId) !== null) {
      // Committed: the intent is deleted in the insert's transaction, so
      // this cannot happen — but if it did, the file is the capture's.
      deleteCaptureDuplicateIntent(intent.captureId);
      await rm(intent.stagingPath, { force: true }).catch(() => undefined);
      continue;
    }
    await discardVideoCopy(intent);
    recovered += 1;
  }
  if (recovered > 0) log.info("removed interrupted video duplicates", { count: recovered });
  return recovered;
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
