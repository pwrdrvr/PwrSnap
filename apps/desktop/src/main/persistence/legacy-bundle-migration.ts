// One-shot migration: wraps every pre-bundle capture (rows where
// `bundle_path IS NULL AND legacy_src_path IS NOT NULL`) into a
// `.pwrsnap` bundle next to its existing flat PNG. Idempotent — re-runs
// no-op on rows already migrated.
//
// Strategy:
//   • The existing `<id>.png` STAYS in place — that's the paired flat
//     composite the bundle format expects. We just add a sibling
//     `<id>.pwrsnap`.
//   • Source.png inside the bundle = the existing flat PNG bytes.
//     Composite.png = compose() output (which equals source bytes for
//     captures with no overlays).
//   • Per-row try/catch; failures don't block boot or other rows.
//
// See docs/plans/2026-05-07-001-feat-pwrsnap-bundle-storage-plan.md
// §"Legacy-data migration" for the full spec.

import { BrowserWindow } from "electron";
import { writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import sharp from "sharp";

import {
  EVENT_CHANNELS,
  type BundleManifestV1,
  type BundleOverlaysV1,
  type LegacyBundleMigrationProgress
} from "@pwrsnap/shared";

import { getMainLogger } from "../log";
import { compose } from "../render/compose";
import { getDb } from "./db";
import { getCacheSourcePath } from "./paths";
import { listLiveOverlays } from "./overlays-repo";
import { writeBundlePair } from "./bundle-store";

const log = getMainLogger("pwrsnap:legacy-bundle-migration");

/**
 * Rows whose `legacy_bundle_attempts` has hit this ceiling are parked —
 * still visible via `legacy_src_path`, no longer re-attempted on boot.
 * A doctor pass can `UPDATE captures SET legacy_bundle_attempts = 0`
 * to retry after the underlying cause is fixed (e.g. a corrupt PNG
 * was replaced). Five attempts gives a few boots' worth of recovery
 * for transient errors (disk full, antivirus lock) without spamming
 * the log indefinitely on permanently-broken rows.
 */
const MAX_ATTEMPTS = 5;

/**
 * Progress events fire once at start, every PROGRESS_EVERY_N rows
 * thereafter, and once at completion. Throttles IPC churn at the
 * common case (a few-hundred-row migration completes in ~20s) while
 * still feeling responsive — the banner updates roughly every second
 * at typical per-row speed.
 */
const PROGRESS_EVERY_N = 10;

type LegacyRow = {
  id: string;
  captured_at: string;
  source_app_bundle_id: string | null;
  source_app_name: string | null;
  legacy_src_path: string;
  width_px: number;
  height_px: number;
  byte_size: number;
  sha256: string;
  edits_version: number;
  legacy_bundle_attempts: number;
};

export type LegacyMigrationResult = {
  attempted: number;
  succeeded: number;
  failed: number;
  failedIds: string[];
};

/**
 * Run the legacy-bundle migration if any pre-bundle rows exist. No-op
 * when every row already has `bundle_path` populated.
 */
export async function runLegacyBundleMigration(): Promise<LegacyMigrationResult> {
  const db = getDb();

  // Three filters beyond bundle_path/legacy_src_path/deleted_at:
  //   • kind = 'image' — videos can't be wrapped via sharp(); they're
  //     handled by the doctor in a separate pass. Without this filter
  //     every boot would re-attempt and re-fail every video row.
  //   • legacy_bundle_attempts < MAX — exhausted rows are parked.
  //   • last_failed_at older than 1 hour — adds backoff so a quick
  //     relaunch after a failed boot doesn't burn another attempt
  //     count immediately. Successful rows have NULL here.
  const rows = db
    .prepare(
      `SELECT id, captured_at,
              source_app_bundle_id, source_app_name,
              legacy_src_path, width_px, height_px,
              byte_size, sha256, edits_version,
              legacy_bundle_attempts
       FROM captures
       WHERE bundle_path IS NULL
         AND legacy_src_path IS NOT NULL
         AND deleted_at IS NULL
         AND kind = 'image'
         AND legacy_bundle_attempts < @maxAttempts
         AND (
           legacy_bundle_last_failed_at IS NULL
           OR datetime(legacy_bundle_last_failed_at) < datetime('now', '-1 hour')
         )`
    )
    .all({ maxAttempts: MAX_ATTEMPTS }) as LegacyRow[];

  if (rows.length === 0) {
    return { attempted: 0, succeeded: 0, failed: 0, failedIds: [] };
  }

  log.info("legacy-bundle migration: starting", { rowCount: rows.length });

  const total = rows.length;
  let done = 0;
  let failed = 0;
  const failedIds: string[] = [];

  const emitProgress = (status: LegacyBundleMigrationProgress["status"]): void => {
    const payload: LegacyBundleMigrationProgress = { status, total, done, failed };
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send(EVENT_CHANNELS.legacyBundleMigrationProgress, payload);
    }
  };

  emitProgress("running");

  const recordFailure = db.prepare(
    `UPDATE captures
     SET legacy_bundle_attempts = legacy_bundle_attempts + 1,
         legacy_bundle_last_failed_at = datetime('now')
     WHERE id = @id`
  );

  for (const row of rows) {
    try {
      await migrateRow(row);
      done += 1;
    } catch (cause) {
      failed += 1;
      done += 1;
      failedIds.push(row.id);
      recordFailure.run({ id: row.id });
      const nextAttempt = row.legacy_bundle_attempts + 1;
      log.warn("legacy-bundle migration: row failed", {
        captureId: row.id,
        legacy_src_path: row.legacy_src_path,
        attempt: nextAttempt,
        parked: nextAttempt >= MAX_ATTEMPTS,
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
    if (done % PROGRESS_EVERY_N === 0) {
      emitProgress("running");
    }
  }

  emitProgress("complete");

  log.info("legacy-bundle migration: done", {
    attempted: total,
    succeeded: done - failed,
    failed
  });

  return {
    attempted: total,
    succeeded: done - failed,
    failed,
    failedIds
  };
}

async function migrateRow(row: LegacyRow): Promise<void> {
  const flatPngPath = row.legacy_src_path;

  // Read the existing flat PNG bytes — these become source.png inside
  // the bundle. The flat PNG itself stays in place as the paired
  // composite (it IS the composite for captures with no overlays).
  const sourcePng = await sharp(flatPngPath).toBuffer();

  // Render composite at source resolution. compose() reads live
  // overlays internally; for captures with no overlays the output is
  // byte-equivalent to the source. For captures with overlays we get
  // the latest baked composite.
  const composeResult = await compose({
    captureId: row.id,
    srcPath: flatPngPath,
    imageWidthPx: row.width_px,
    imageHeightPx: row.height_px,
    width: row.width_px,
    format: "png"
  });
  const compositePng =
    composeResult.overlayCount === 0
      ? sourcePng
      : await sharp(composeResult.cachePath).toBuffer();

  const liveOverlays = listLiveOverlays(row.id);
  const now = new Date().toISOString();
  const filenameStem = row.id;
  const pairedPngFilename = `${filenameStem}.png`;

  const manifest: BundleManifestV1 = {
    bundle_format_version: 1,
    capture_id: row.id,
    source_sha256: row.sha256,
    source_dimensions: { width_px: row.width_px, height_px: row.height_px },
    paired_png_filename: pairedPngFilename,
    created_at: row.captured_at,
    bundle_modified_at: now
  };

  const overlays: BundleOverlaysV1 = {
    overlays_format_version: 1,
    // Wire-format field name stays `overlays_version` (v1 bundle JSON
    // shape is locked); source is the renamed DB column `edits_version`.
    overlays_version: row.edits_version,
    overlays: liveOverlays.map((o) => ({
      id: o.id,
      data: o.data,
      schema_version: o.schema_version,
      source: o.source,
      z_index: o.z_index,
      created_at: o.created_at,
      applied_at: o.applied_at,
      rejected_at: o.rejected_at,
      superseded_by: o.superseded_by,
      ai_run_id: o.ai_run_id
    })),
    tags: [],
    description: null,
    ai_runs: []
  };

  // The flat PNG already exists at flatPngPath (we just read it).
  // writeBundlePair writes a NEW bundle next to it AND rewrites the
  // flat PNG with the composite bytes — for captures with no
  // overlays that's a no-op-equivalent rewrite (same bytes); for
  // captures WITH overlays it ensures the user-visible flat is the
  // baked composite.
  const outputDir = dirname(flatPngPath);
  const { bundlePath } = await writeBundlePair({
    outputDir,
    filenameStem,
    manifest,
    overlays,
    sourcePng,
    compositePng
  });

  // Materialize source.png to per-capture cache so synchronous readers
  // (compose, clipboard render, pwrsnap-capture://) work post-migration.
  const cacheSource = getCacheSourcePath(row.id);
  await mkdir(dirname(cacheSource), { recursive: true });
  await writeFile(cacheSource, sourcePng);

  // Atomically advance the row to bundle-flow state. Clears any
  // failure bookkeeping (legacy_bundle_attempts, last_failed_at) so a
  // row that succeeded after N-1 attempts isn't left with stale
  // failure metadata. The runner's filter excludes successful rows
  // (bundle_path IS NULL) anyway, but keeping the bookkeeping clean
  // makes the schema honest if a future doctor pass queries by it.
  getDb()
    .prepare(
      `UPDATE captures
       SET bundle_path = @bundle_path,
           flat_png_path = @flat_png_path,
           bundle_modified_at = @bundle_modified_at,
           bundle_edits_version = edits_version,
           legacy_bundle_attempts = 0,
           legacy_bundle_last_failed_at = NULL
       WHERE id = @id`
    )
    .run({
      id: row.id,
      bundle_path: bundlePath,
      flat_png_path: flatPngPath,
      bundle_modified_at: now
    });

  log.info("legacy-bundle migration: row migrated", {
    captureId: row.id,
    bundlePath,
    overlayCount: liveOverlays.length
  });
}
