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
import { writeFile, mkdir, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
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
import {
  buildCompositeThumbnail,
  readBundleEntry,
  readBundleManifest,
  readBundleOverlays,
  writeBundle
} from "./bundle-store";

const log = getMainLogger("pwrsnap:legacy-bundle-migration");

/**
 * Most recent progress event emitted by the running migration (or
 * the terminal "complete" event of the last one to run). Cached
 * here so a late-mounting renderer can call `migration:status` on
 * mount and pick up the current state — `webContents.send` is
 * fire-and-forget, so any event broadcast before the renderer's
 * IPC listener attached is lost. Reset to `null` between runs (set
 * by `runLegacyBundleMigration` before the first `emitProgress`).
 *
 * Why this is load-bearing for UX:
 *   1. Cold-start ordering — migration kicks off in
 *      `app.whenReady` right after window creation, but the
 *      BrowserWindow's renderer hasn't yet parsed its JS bundle,
 *      mounted React, or run the banner's subscribe-effect. The
 *      first one-to-three progress events are dropped.
 *   2. Small migrations — when only a few rows need processing
 *      the whole loop finishes in under a second, before the
 *      renderer mounts at all. Without the cached snapshot the
 *      user never sees the banner even though the migration ran.
 *
 * The bus verb `migration:status` reads this and returns it; the
 * banner queries it on mount BEFORE event subscription kicks in,
 * so it picks up the current state if a migration is already in-
 * flight or recently completed.
 */
let cachedProgress: LegacyBundleMigrationProgress | null = null;

/**
 * Returns the most recent progress event emitted by the migration
 * loop. Bus exposure (`migration:status`) wraps this — banner
 * subscribes via the events channel for live updates AND queries
 * via this verb on mount to recover from the inevitable race
 * between migration start and renderer ready-state.
 */
export function getLegacyMigrationProgress(): LegacyBundleMigrationProgress | null {
  return cachedProgress;
}

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

type LegacyOrphanRow = {
  id: string;
  bundle_path: string;
  flat_png_path: string;
};

/**
 * Pass C rows: already-bundle'd captures that still carry the
 * pre-PR-90 `composite.png` entry inside their `.pwrsnap`. We
 * rewrite each one in place — drop composite.png, add
 * composite_thumbnail.jpg (1024px JPEG q80) — so the Thumbnail
 * Extension's fastest preferred entry is present and the bundle
 * shrinks back down to source.png + JSON + tiny thumbnail JPEG.
 */
type LegacyCompositeRow = {
  id: string;
  captured_at: string;
  bundle_path: string;
  width_px: number;
  height_px: number;
  legacy_composite_v2_attempts: number;
};

/**
 * Run the legacy-bundle migration. Two passes, both walked in one
 * progress-emitting loop:
 *
 *   Pass A — WRAP. Rows that still have a pre-bundle source PNG and
 *   no bundle (`bundle_path IS NULL AND legacy_src_path IS NOT NULL`).
 *   Reads the PNG, packs a bundle, writes it, deletes the PNG (with
 *   the bundle-size-≥-PNG-size safety check).
 *
 *   Pass B — SWEEP. Rows already wrapped in a prior boot's migration
 *   that still have a paired flat PNG sibling on disk
 *   (`bundle_path IS NOT NULL AND flat_png_path IS NOT NULL`). These
 *   are leftovers from when the bundle-flow used to also write a
 *   `<id>.png` next to the bundle. Same safety check, then unlink +
 *   NULL out flat_png_path.
 *
 * Both passes share the same progress banner because for the user
 * they're the same conceptual "library upgrade" event. No-op when
 * both pass-A and pass-B queries return empty (the steady state).
 */
export async function runLegacyBundleMigration(): Promise<LegacyMigrationResult> {
  const db = getDb();

  // Pass A — rows that need bundle wrapping. Three filters beyond
  // bundle_path/legacy_src_path/deleted_at:
  //   • kind = 'image' — videos can't be wrapped via sharp(); they're
  //     handled by the doctor in a separate pass. Without this filter
  //     every boot would re-attempt and re-fail every video row.
  //   • legacy_bundle_attempts < MAX — exhausted rows are parked.
  //   • last_failed_at older than 1 hour — adds backoff so a quick
  //     relaunch after a failed boot doesn't burn another attempt
  //     count immediately. Successful rows have NULL here.
  const wrapRows = db
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

  // Pass B — rows already wrapped but still carrying a paired flat
  // PNG sibling on disk. No retry backoff here because the only
  // failure modes are "PNG missing" (then we just NULL the column
  // and move on) and "unlink failed" (logged but doesn't block).
  const sweepRows = db
    .prepare(
      `SELECT id, bundle_path, flat_png_path
       FROM captures
       WHERE bundle_path IS NOT NULL
         AND flat_png_path IS NOT NULL
         AND deleted_at IS NULL`
    )
    .all() as LegacyOrphanRow[];

  // Pass C — bundle'd rows that still have the pre-PR-90
  // `composite.png` entry. Same retry/backoff shape as Pass A:
  //   • bundle_path NOT NULL — must already be wrapped (Pass A's
  //     output, or a fresh capture).
  //   • kind = 'image' — videos don't have composites.
  //   • legacy_composite_v2_attempts < MAX — parked rows skipped.
  //   • last_failed_at older than 1 hour — quick relaunch shouldn't
  //     burn another attempt.
  //
  // We over-select here (every bundled image row) and let
  // `rewriteCompositeRow` quickly skip already-migrated bundles
  // by inspecting their entry list. Cheap (a single yauzl-list
  // open per skipped bundle) and means we don't need a separate
  // "already migrated" flag — the predicate "composite.png is
  // present in the ZIP" IS the flag.
  const compositeRows = db
    .prepare(
      `SELECT id, captured_at, bundle_path,
              width_px, height_px,
              legacy_composite_v2_attempts
       FROM captures
       WHERE bundle_path IS NOT NULL
         AND deleted_at IS NULL
         AND kind = 'image'
         AND legacy_composite_v2_attempts < @maxAttempts
         AND (
           legacy_composite_v2_last_failed_at IS NULL
           OR datetime(legacy_composite_v2_last_failed_at) < datetime('now', '-1 hour')
         )`
    )
    .all({ maxAttempts: MAX_ATTEMPTS }) as LegacyCompositeRow[];

  const total = wrapRows.length + sweepRows.length + compositeRows.length;
  if (total === 0) {
    return { attempted: 0, succeeded: 0, failed: 0, failedIds: [] };
  }

  log.info("legacy-bundle migration: starting", {
    wrapCount: wrapRows.length,
    sweepCount: sweepRows.length,
    compositeCount: compositeRows.length
  });

  let done = 0;
  let failed = 0;
  const failedIds: string[] = [];

  const emitProgress = (status: LegacyBundleMigrationProgress["status"]): void => {
    const payload: LegacyBundleMigrationProgress = { status, total, done, failed };
    // Cache the snapshot BEFORE broadcasting — if a renderer mounts
    // and queries `migration:status` while we're mid-broadcast, it
    // sees the new value rather than a stale one.
    cachedProgress = payload;
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send(EVENT_CHANNELS.legacyBundleMigrationProgress, payload);
    }
  };

  // Reset the cache at the start of a fresh run so a renderer that
  // mounts before the first emit sees `null` (no banner) rather
  // than a stale "complete" from the previous run.
  cachedProgress = null;
  emitProgress("running");

  const recordFailure = db.prepare(
    `UPDATE captures
     SET legacy_bundle_attempts = legacy_bundle_attempts + 1,
         legacy_bundle_last_failed_at = datetime('now')
     WHERE id = @id`
  );
  const clearFlatPngPath = db.prepare(
    `UPDATE captures SET flat_png_path = NULL WHERE id = @id`
  );
  const recordCompositeFailure = db.prepare(
    `UPDATE captures
     SET legacy_composite_v2_attempts = legacy_composite_v2_attempts + 1,
         legacy_composite_v2_last_failed_at = datetime('now')
     WHERE id = @id`
  );
  const markCompositeMigrated = db.prepare(
    `UPDATE captures
     SET bundle_modified_at = @bundle_modified_at,
         legacy_composite_v2_attempts = 0,
         legacy_composite_v2_last_failed_at = NULL
     WHERE id = @id`
  );

  // Pass A loop.
  for (const row of wrapRows) {
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

  // Pass B loop — sweep orphan paired PNGs. Same safety check
  // (bundle_size ≥ png_size) before unlinking.
  for (const row of sweepRows) {
    try {
      const pngStat = await stat(row.flat_png_path);
      const bundleStat = await stat(row.bundle_path);
      if (bundleStat.size < pngStat.size) {
        log.warn("legacy-bundle sweep: bundle smaller than paired PNG; skipping", {
          captureId: row.id,
          pngBytes: pngStat.size,
          bundleBytes: bundleStat.size
        });
        // Don't NULL the column — keep the PNG visible so the user /
        // doctor can investigate.
        done += 1;
        continue;
      }
      await unlink(row.flat_png_path);
      clearFlatPngPath.run({ id: row.id });
      done += 1;
    } catch (cause) {
      // Missing PNG → ENOENT here. Clear the column anyway; the file
      // is gone, the row's pointer is stale, NULL is now correct.
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        clearFlatPngPath.run({ id: row.id });
        done += 1;
      } else {
        failed += 1;
        done += 1;
        failedIds.push(row.id);
        log.warn("legacy-bundle sweep: failed to inspect/unlink", {
          captureId: row.id,
          flatPngPath: row.flat_png_path,
          message: cause instanceof Error ? cause.message : String(cause)
        });
      }
    }
    if (done % PROGRESS_EVERY_N === 0) {
      emitProgress("running");
    }
  }

  // Pass C loop — composite.png → composite_thumbnail.jpg rewrite.
  for (const row of compositeRows) {
    try {
      const outcome = await rewriteCompositeRow(row);
      if (outcome.changed) {
        markCompositeMigrated.run({
          id: row.id,
          bundle_modified_at: outcome.bundleModifiedAt
        });
      } else {
        // No composite.png in this bundle — already migrated (e.g.
        // captured post-PR-90). Mark as success so we don't re-scan
        // every boot.
        markCompositeMigrated.run({
          id: row.id,
          bundle_modified_at: row.captured_at
        });
      }
      done += 1;
    } catch (cause) {
      failed += 1;
      done += 1;
      failedIds.push(row.id);
      recordCompositeFailure.run({ id: row.id });
      const nextAttempt = row.legacy_composite_v2_attempts + 1;
      log.warn("legacy-bundle migration (Pass C): row failed", {
        captureId: row.id,
        bundlePath: row.bundle_path,
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
    failed,
    wrapAttempts: wrapRows.length,
    sweepAttempts: sweepRows.length,
    compositeAttempts: compositeRows.length
  });

  return {
    attempted: total,
    succeeded: done - failed,
    failed,
    failedIds
  };
}

async function migrateRow(row: LegacyRow): Promise<void> {
  const legacyPngPath = row.legacy_src_path;

  // Stat the legacy PNG up front for the post-write size safety check.
  // If the bundle ends up smaller than the source PNG, something went
  // sideways (partial write, sharp encode produced empty output, etc.)
  // and we keep the PNG as a fallback rather than delete it blindly.
  const legacyStat = await stat(legacyPngPath);
  const legacyPngBytes = legacyStat.size;

  // Read the existing flat PNG bytes — these become source.png inside
  // the bundle.
  const sourcePng = await sharp(legacyPngPath).toBuffer();

  // Render composite at source resolution. compose() reads live
  // overlays internally; for captures with no overlays the output is
  // byte-equivalent to the source. The composite is consumed by the
  // thumbnail builder only — it's not embedded full-res in the bundle
  // anymore.
  const composeResult = await compose({
    captureId: row.id,
    srcPath: legacyPngPath,
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

  const thumbnailJpg = await buildCompositeThumbnail(compositePng, {
    width_px: row.width_px,
    height_px: row.height_px
  });

  const outputDir = dirname(legacyPngPath);
  const { bundlePath } = await writeBundle({
    outputDir,
    filenameStem,
    manifest,
    overlays,
    sourcePng,
    thumbnailJpg
  });

  // Materialize source.png to per-capture cache so synchronous readers
  // (compose, clipboard render, pwrsnap-capture://) work post-migration.
  const cacheSource = getCacheSourcePath(row.id);
  await mkdir(dirname(cacheSource), { recursive: true });
  await writeFile(cacheSource, sourcePng);

  // Atomically advance the row to bundle-flow state. Clears any
  // failure bookkeeping (legacy_bundle_attempts, last_failed_at) so a
  // row that succeeded after N-1 attempts isn't left with stale
  // failure metadata. `flat_png_path` is set to NULL — the legacy PNG
  // is about to be unlinked below, and bundles no longer write paired
  // sibling files in the bundle-is-system-of-record model.
  getDb()
    .prepare(
      `UPDATE captures
       SET bundle_path = @bundle_path,
           flat_png_path = NULL,
           bundle_modified_at = @bundle_modified_at,
           bundle_edits_version = edits_version,
           legacy_bundle_attempts = 0,
           legacy_bundle_last_failed_at = NULL
       WHERE id = @id`
    )
    .run({
      id: row.id,
      bundle_path: bundlePath,
      bundle_modified_at: now
    });

  // Safety-checked sweep of the legacy PNG. The bundle is the system
  // of record now; the source.png inside it (STORE-mode, same bytes
  // as the legacy PNG) is the durable copy. Before unlinking, verify
  // the bundle is at least as large as the PNG it's replacing — a
  // bundle smaller than its own source.png entry means something
  // went very wrong (partial write that atomicWriteBundle should have
  // prevented, but defense-in-depth). On mismatch we keep the PNG.
  try {
    const bundleStat = await stat(bundlePath);
    if (bundleStat.size < legacyPngBytes) {
      log.warn("legacy-bundle migration: bundle smaller than legacy PNG; keeping PNG", {
        captureId: row.id,
        legacyPngBytes,
        bundleBytes: bundleStat.size
      });
      return;
    }
    await unlink(legacyPngPath);
  } catch (cause) {
    // Failure to delete is non-fatal — the row is already migrated;
    // a future cleanup pass (or this same migration on next boot —
    // bundle_path will be set so the row won't re-enter; we'd need a
    // separate sweep job) can pick up the orphan PNG.
    log.warn("legacy-bundle migration: failed to delete legacy PNG", {
      captureId: row.id,
      legacyPngPath,
      message: cause instanceof Error ? cause.message : String(cause)
    });
  }

  log.info("legacy-bundle migration: row migrated", {
    captureId: row.id,
    bundlePath,
    overlayCount: liveOverlays.length
  });
}

type RewriteCompositeOutcome =
  | { changed: false }
  | { changed: true; bundleModifiedAt: string };

/**
 * Rewrite one legacy bundle that still carries `composite.png` —
 * drop the composite, generate `composite_thumbnail.jpg` from
 * whichever rendered image is freshest (composite.png if it
 * differs from source.png — meaning baked-in overlays — else
 * source.png itself), and atomic-rename the result over the
 * existing bundle.
 *
 * Returns `{ changed: false }` when the bundle is already
 * composite.png-free (a post-PR-90 capture that snuck through
 * the over-selection predicate). Caller still marks the row as
 * migrated in that case so we don't re-scan it.
 *
 * Idempotent: a second call on an already-rewritten bundle is a
 * no-op (composite.png is gone → `changed: false`).
 */
async function rewriteCompositeRow(
  row: LegacyCompositeRow
): Promise<RewriteCompositeOutcome> {
  const manifest = await readBundleManifest(row.bundle_path);
  if (manifest.bundle_format_version !== 1) {
    // v2 bundles have a different on-disk shape; Pass C doesn't
    // touch them. Mark as no-change and move on.
    return { changed: false };
  }

  // Read source.png and try to read composite.png. The read APIs
  // throw for missing entries, so we catch the composite case
  // narrowly — anything else (corrupt zip, missing source.png) is
  // a real failure and surfaces to the caller's retry book-keeping.
  const sourcePng = await readBundleEntry(row.bundle_path, "source.png");
  let compositePng: Buffer | null = null;
  try {
    compositePng = await readBundleEntry(row.bundle_path, "composite.png");
  } catch (cause) {
    // The entry validator throws with a "missing" / "impossible"
    // message when the entry isn't present. We can't pattern-match
    // on the message reliably across releases, so treat ANY read
    // failure here as "composite.png absent" — the bundle is
    // already migrated, mark it done.
    log.debug("Pass C: composite.png absent or unreadable; treating as migrated", {
      captureId: row.id,
      message: cause instanceof Error ? cause.message : String(cause)
    });
    return { changed: false };
  }

  // Decide what to feed buildCompositeThumbnail. If composite ==
  // source byte-for-byte (the common case for captures with no
  // applied overlays at bundle time), feeding either is equivalent
  // and using source skips a redundant decode. If they differ, the
  // composite carries baked-in overlay rendering — use it so the
  // thumbnail still reflects what the user saw in PwrSnap.
  const sourceSha = createHash("sha256").update(sourcePng).digest("hex");
  const compositeSha = createHash("sha256").update(compositePng).digest("hex");
  const thumbnailInput = sourceSha === compositeSha ? sourcePng : compositePng;

  const thumbnailJpg = await buildCompositeThumbnail(thumbnailInput, {
    width_px: row.width_px,
    height_px: row.height_px
  });

  // Preserve every field from the original manifest except
  // bundle_modified_at, which we bump to "now" so the migration is
  // visible in the row's audit trail.
  const now = new Date().toISOString();
  const nextManifest: BundleManifestV1 = {
    ...manifest,
    bundle_modified_at: now
  };

  // Overlays.json is untouched — Pass C only changes which image
  // entries are present, not the editing history.
  const overlays = await readBundleOverlays(row.bundle_path);

  const filenameStem = row.id;
  const outputDir = dirname(row.bundle_path);

  // writeBundle takes (manifest, overlays, sourcePng, thumbnailJpg)
  // — no `compositePng` parameter exists anymore, so the rewritten
  // bundle is composite.png-free by construction.
  await writeBundle({
    outputDir,
    filenameStem,
    manifest: nextManifest,
    overlays,
    sourcePng,
    thumbnailJpg
  });

  log.info("Pass C: rewrote bundle without composite.png", {
    captureId: row.id,
    bundlePath: row.bundle_path,
    compositeEqualSource: sourceSha === compositeSha
  });

  return { changed: true, bundleModifiedAt: now };
}
