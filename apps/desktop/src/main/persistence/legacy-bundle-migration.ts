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

import { writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import sharp from "sharp";

import { type BundleManifestV1, type BundleOverlaysV1 } from "@pwrsnap/shared";

import { getMainLogger } from "../log";
import { compose } from "../render/compose";
import { getDb, getCacheSourcePath } from "./db";
import { listLiveOverlays } from "./overlays-repo";
import { writeBundlePair } from "./bundle-store";

const log = getMainLogger("pwrsnap:legacy-bundle-migration");

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
  overlays_version: number;
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

  const rows = db
    .prepare(
      `SELECT id, captured_at,
              source_app_bundle_id, source_app_name,
              legacy_src_path, width_px, height_px,
              byte_size, sha256, overlays_version
       FROM captures
       WHERE bundle_path IS NULL
         AND legacy_src_path IS NOT NULL
         AND deleted_at IS NULL`
    )
    .all() as LegacyRow[];

  if (rows.length === 0) {
    return { attempted: 0, succeeded: 0, failed: 0, failedIds: [] };
  }

  log.info("legacy-bundle migration: starting", { rowCount: rows.length });

  const failedIds: string[] = [];
  let succeeded = 0;

  for (const row of rows) {
    try {
      await migrateRow(row);
      succeeded += 1;
    } catch (cause) {
      failedIds.push(row.id);
      log.warn("legacy-bundle migration: row failed", {
        captureId: row.id,
        legacy_src_path: row.legacy_src_path,
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
  }

  log.info("legacy-bundle migration: done", {
    attempted: rows.length,
    succeeded,
    failed: failedIds.length
  });

  return {
    attempted: rows.length,
    succeeded,
    failed: failedIds.length,
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
    overlays_version: row.overlays_version,
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

  // Atomically advance the row to bundle-flow state.
  getDb()
    .prepare(
      `UPDATE captures
       SET bundle_path = @bundle_path,
           flat_png_path = @flat_png_path,
           bundle_modified_at = @bundle_modified_at,
           bundle_overlays_version = overlays_version
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
