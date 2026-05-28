// Per-capture v1 → v2 bundle doctor + boot-time reconcile sweep.
//
// Two surfaces:
//
//   • `migrateBundleV1ToV2(captureId)` — fired lazily on first edit-
//     open of a v1 capture via the `v1ToV2:upgrade` bus verb. Builds
//     a v2 layer tree from the v1 overlays array, writes a new v2
//     bundle atomically, swaps the DB row over, then deletes the
//     v1 overlay rows. Strict ordering so any mid-step crash is
//     recoverable by `reconcileV1ToV2OnBoot`.
//
//   • `reconcileV1ToV2OnBoot()` — boot-time sweep that heals partial
//     mid-crash states from a prior doctor run:
//        – orphan `.pwrsnap.tmp` files (crashed between step 6 and 7)
//        – DB-says-v2 but bundle-on-disk-missing (crashed between 7
//          and 8) → revert DB row to v1
//        – DB-says-v1 but bundle-on-disk-v2 (crashed inside step 7
//          partial commit or between 7 and 8) → reconcile DB to v2
//        – orphan overlays rows for captures now v2 (crashed between
//          8 and 9) → DELETE
//
// Atomic ordering inside migrateBundleV1ToV2 (mirrors the plan §
// "Phase 3 — v1→v2 lazy doctor"):
//
//    1. Read manifest. If already v2 → idempotent success.
//    2. Check retry budget. If parked → return parked.
//    3. Bump v1_to_v2_attempts in a small standalone TX (so a crash
//       in steps 4-10 still counts toward the budget).
//    4. Read v1 overlays, v1 manifest, source dims.
//    5. synthesizeV2DocumentFromV1Overlays — pure mapping.
//    6. atomicWriteBundle(tempPath, v2_bytes) + fsync.
//    7. BEGIN IMMEDIATE
//         insertLayerTreeForCapture(layers)
//         UPDATE captures SET bundle_format_version=2, bundle_path=tempPath
//         COMMIT.
//    8. rename(tempPath → finalBundlePath) + dir-fsync, then UPDATE
//       captures SET bundle_path=finalBundlePath in a small follow-up TX.
//    9. DELETE FROM overlays WHERE capture_id = ? (idempotent;
//       reconcile-safe).
//   10. Clear v1_to_v2_attempts (success).
//   11. emitProgress({ status: "complete", captureId, ... }).
//
// On any failure between steps, emit a `failed` progress event with
// `parked` set if the attempt budget is now exhausted.

import { BrowserWindow } from "electron";
import { rename, unlink, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { nanoid } from "nanoid";

import {
  deriveBlurRadiusPx,
  EVENT_CHANNELS,
  type BundleDocumentV2,
  type BundleLayerNode,
  type BundleManifestV1,
  type BundleManifestV2,
  type BundleOverlaysV1,
  type EffectLayer,
  type GroupLayer,
  type Overlay,
  type RasterLayer,
  type V1ToV2DoctorProgress,
  type VectorLayer,
  type Result,
  type PwrSnapError,
  err,
  ok,
  pwrSnapError
} from "@pwrsnap/shared";

import { getMainLogger } from "../log";
import { getDb } from "./db";
import { readBundleManifest } from "./bundle-store";

const log = getMainLogger("pwrsnap:v1-to-v2-doctor");

/**
 * Per-capture retry budget. After 5 failed attempts the row is
 * "parked" — `v1_to_v2_attempts >= 5` — and the editor renders the
 * capture read-only with a "Couldn't upgrade — read-only view"
 * banner plus a Retry button. The Retry button calls
 * `v1ToV2:retry` which routes to `clearParkedState`.
 */
const MAX_ATTEMPTS = 5;

/**
 * Progress events fire once at start, throttled per N rows during
 * the boot-time reconcile sweep, and once at completion. Per-capture
 * lazy upgrades only emit start + (success | fail).
 */
const RECONCILE_PROGRESS_EVERY_N = 10;

/**
 * Cached snapshot for `v1ToV2:status` — late-mounting renderers
 * call the verb once on mount to pick up the current state, then
 * subscribe to `events:v1-to-v2-doctor:progress` for updates.
 * Identical pattern to `legacy-bundle-migration.ts`'s cached
 * snapshot — `webContents.send` is fire-and-forget, so any
 * progress event broadcast before the renderer's IPC listener
 * attached is dropped without this cache.
 */
let cachedProgress: V1ToV2DoctorProgress | null = null;

/**
 * Returns the most recent progress event emitted by either the
 * boot-time sweep or a per-capture lazy run. Routed to the
 * `v1ToV2:status` bus verb.
 */
export function getLastDoctorProgressSnapshot(): V1ToV2DoctorProgress | null {
  return cachedProgress;
}

function emitProgress(payload: V1ToV2DoctorProgress): void {
  cachedProgress = payload;
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(EVENT_CHANNELS.v1ToV2DoctorProgress, payload);
  }
}

// ────────────────────────────────────────────────────────────────────
// migrateBundleV1ToV2 — per-capture lazy upgrade
// ────────────────────────────────────────────────────────────────────

type DoctorCaptureRow = {
  id: string;
  bundle_path: string | null;
  bundle_format_version: number;
  width_px: number;
  height_px: number;
  sha256: string;
  v1_to_v2_attempts: number;
  captured_at: string;
};

/**
 * Per-capture upgrade. Idempotent — re-runs against an already-v2
 * bundle return `{ migrated: false, reason: "already_v2" }`. Past
 * the retry ceiling, returns `{ migrated: false, reason: "parked" }`.
 * Any other failure returns Result.err(PwrSnapError) which the
 * `v1ToV2:upgrade` handler surfaces to the editor banner.
 */
export async function migrateBundleV1ToV2(
  captureId: string
): Promise<
  Result<{ migrated: boolean; reason?: "already_v2" | "parked" | "no_bundle" }, PwrSnapError>
> {
  log.info("v1-to-v2-doctor: enter", { captureId });
  const db = getDb();
  const row = db
    .prepare<[string], DoctorCaptureRow>(
      `SELECT id, bundle_path, bundle_format_version, width_px, height_px,
              sha256, v1_to_v2_attempts, captured_at
         FROM captures WHERE id = ?`
    )
    .get(captureId);
  if (row === undefined) {
    log.warn("v1-to-v2-doctor: capture not found in DB", { captureId });
    return err(
      pwrSnapError(
        "persistence",
        "capture_not_found",
        `v1-to-v2-doctor: capture ${captureId} not found`
      )
    );
  }
  if (row.bundle_path === null) {
    // Pre-bundle-storage legacy captures: rows that predate migration
    // 0007_bundle_storage have no bundle file on disk. They carry only
    // `legacy_src_path` (a path to a loose PNG/WebP file) and render
    // fine in the editor via the v1 read path. There's nothing for the
    // doctor to upgrade — there's no bundle to repack — so this is a
    // no-op success, NOT an error.
    //
    // Pre-fix this branch returned err("no_bundle_path"). The renderer's
    // useEnsureV2 maps any error → view_only, which locked the toolbar
    // for legacy captures (and for every E2E test fixture that seeds via
    // `seedCapture` without writing a bundle — that's how this bug was
    // caught). The renderer now treats `reason: "no_bundle"` as the same
    // terminal state as `already_v2` / `migrated: true` — ready, toolbar
    // enabled, view unchanged.
    log.info("v1-to-v2-doctor: skip (no bundle on disk; legacy capture)", {
      captureId,
      bundleFormatVersion: row.bundle_format_version
    });
    return ok({ migrated: false, reason: "no_bundle" });
  }

  // Step 1: Read the manifest. Authoritative for "is this v1 or v2?" —
  // the DB row's bundle_format_version is a cached projection and may
  // lag behind reality after a mid-crash gap.
  log.info("v1-to-v2-doctor: step 1 (read manifest)", {
    captureId,
    bundlePath: row.bundle_path
  });
  let manifest: BundleManifestV1 | BundleManifestV2;
  try {
    manifest = await readBundleManifest(row.bundle_path);
  } catch (cause) {
    log.warn("v1-to-v2-doctor: manifest read failed", {
      captureId,
      bundlePath: row.bundle_path,
      message: cause instanceof Error ? cause.message : String(cause)
    });
    return err(
      pwrSnapError(
        "persistence",
        "manifest_read_failed",
        `v1-to-v2-doctor: failed to read manifest for ${captureId}`,
        cause
      )
    );
  }
  if (manifest.bundle_format_version === 2) {
    // Already-v2 case. If the DB row still says v1, the boot-time
    // reconcile will heal it on next boot; we don't touch it here
    // so the doctor's response stays a pure short-circuit.
    log.info("v1-to-v2-doctor: short-circuit (already v2 on disk)", {
      captureId,
      dbVersion: row.bundle_format_version
    });
    return ok({ migrated: false, reason: "already_v2" });
  }

  // Step 2: Retry budget.
  if (row.v1_to_v2_attempts >= MAX_ATTEMPTS) {
    log.warn("v1-to-v2-doctor: parked (retry budget exhausted)", {
      captureId,
      attempts: row.v1_to_v2_attempts,
      maxAttempts: MAX_ATTEMPTS
    });
    return ok({ migrated: false, reason: "parked" });
  }
  log.info("v1-to-v2-doctor: step 2 (within retry budget)", {
    captureId,
    attemptsBefore: row.v1_to_v2_attempts,
    maxAttempts: MAX_ATTEMPTS
  });

  // Step 3: Bump v1_to_v2_attempts in a standalone TX so any
  // crash in steps 4-10 still counts toward the budget.
  db.prepare<[string]>(
    `UPDATE captures
        SET v1_to_v2_attempts = v1_to_v2_attempts + 1,
            v1_to_v2_last_failed_at = datetime('now')
      WHERE id = ?`
  ).run(captureId);

  emitProgress({
    status: "running",
    captureId,
    total: 1,
    done: 0,
    failed: 0
  });

  try {
    // Step 4: Read v1 overlays + source dims.
    log.info("v1-to-v2-doctor: step 4 (read v1 overlays)", { captureId });
    const { readBundleOverlays } = await import("./bundle-store");
    const overlaysJson = await readBundleOverlays(row.bundle_path);
    const sourceDims = { width: row.width_px, height: row.height_px };

    // Step 5: Build the v2 document (pure function).
    log.info("v1-to-v2-doctor: step 5 (synthesize v2 document)", {
      captureId,
      overlayCount: overlaysJson.overlays.length
    });
    const v2Document = synthesizeV2DocumentFromV1Overlays(
      overlaysJson,
      manifest,
      sourceDims
    );

    // Step 6: Pack + write the v2 bundle to a temp path. The temp
    // path is a sibling of the final path (same dir = atomic rename).
    // Suffix `.pwrsnap.tmp` so `reconcileV1ToV2OnBoot` can sweep
    // orphans by glob.
    const finalPath = row.bundle_path;
    const tempPath = `${finalPath}.tmp`;

    const { atomicWriteBundle, readBundleEntry, packBundleV2, buildCompositeThumbnail } =
      await import("./bundle-store");

    // Read source bytes from v1 bundle, build sources Map for v2.
    const sourceBytes = await readBundleEntry(row.bundle_path, "source.png");
    const sourceSha = createHash("sha256").update(sourceBytes).digest("hex");

    // Build the v2 bundle. Patch the manifest so capture_id +
    // canvas_dimensions are populated from the v1 source dims.
    const now = new Date().toISOString();
    const v2Manifest: BundleManifestV2 = {
      bundle_format_version: 2,
      capture_id: captureId,
      canvas_dimensions: { width_px: row.width_px, height_px: row.height_px },
      paired_png_filename: `${captureId}.png`,
      created_at: manifest.created_at,
      bundle_modified_at: now
    };

    // Fix up the raster layer's source_ref.sha256 to match the real
    // source bytes (synthesizeV2 generated a placeholder).
    const documentWithRealSha: BundleDocumentV2 = {
      ...v2Document,
      layers: v2Document.layers.map((node) =>
        node.kind === "raster"
          ? { ...node, source_ref: { kind: "embedded" as const, sha256: sourceSha } }
          : node
      )
    };

    log.info("v1-to-v2-doctor: step 6a (build composite thumbnail)", {
      captureId,
      sourceBytes: sourceBytes.length
    });
    const thumbnailJpg = await buildCompositeThumbnail(sourceBytes);

    log.info("v1-to-v2-doctor: step 6b (pack v2 bundle)", {
      captureId,
      thumbnailBytes: thumbnailJpg?.length ?? 0
    });
    const bundleBytes = await packBundleV2({
      manifest: v2Manifest,
      document: documentWithRealSha,
      sources: new Map([[sourceSha, sourceBytes]]),
      layerBytes: new Map(),
      thumbnailJpg
    });

    log.info("v1-to-v2-doctor: step 6c (atomic write temp bundle)", {
      captureId,
      tempPath,
      bundleBytes: bundleBytes.length
    });
    await atomicWriteBundle(tempPath, bundleBytes);

    // Step 7: BEGIN IMMEDIATE — write the layer tree + flip the
    // captures row over to v2 + point bundle_path at the TEMP path
    // so a crash between step 7 and step 8 leaves a DB row whose
    // bundle_path points at a file that may or may not exist after
    // step 8's rename. The boot-time reconcile sweep heals.
    log.info("v1-to-v2-doctor: step 7 (DB transaction — insert layers + flip version)", {
      captureId,
      layerCount: documentWithRealSha.layers.length
    });
    const { insertLayerTreeForCapture } = await import("./layers-repo");
    const writeTx = db.transaction(() => {
      insertLayerTreeForCapture(captureId, documentWithRealSha.layers);
      db.prepare<[string, string]>(
        `UPDATE captures
            SET bundle_format_version = 2,
                bundle_path = ?
          WHERE id = ?`
      ).run(tempPath, captureId);
    });
    writeTx.exclusive();

    // Step 8: rename temp → final, then UPDATE captures.bundle_path
    // back to final. If the rename fails the DB still points at the
    // temp file; reconcile detects via existsSync and reverts.
    log.info("v1-to-v2-doctor: step 8 (rename temp → final)", {
      captureId,
      tempPath,
      finalPath
    });
    await rename(tempPath, finalPath);
    db.prepare<[string, string]>(
      `UPDATE captures SET bundle_path = ? WHERE id = ?`
    ).run(finalPath, captureId);

    // Step 9: DELETE the now-orphan overlays rows. Idempotent — if
    // we crashed before reaching here, reconcile sweeps on next
    // boot.
    db.prepare<[string]>(`DELETE FROM overlays WHERE capture_id = ?`).run(captureId);

    // Step 10: success — clear the retry budget bookkeeping.
    db.prepare<[string]>(
      `UPDATE captures
          SET v1_to_v2_attempts = 0,
              v1_to_v2_last_failed_at = NULL,
              v1_to_v2_last_error_code = NULL
        WHERE id = ?`
    ).run(captureId);

    // Step 11: success broadcast.
    emitProgress({
      status: "complete",
      captureId,
      total: 1,
      done: 1,
      failed: 0
    });

    // Also broadcast `events:captures:changed` so the editor's
    // `useCaptureModel` hook re-fetches via its existing
    // captures:changed subscription. Without this, the editor's
    // banner would flip to "ready" but the underlying model would
    // still report `bundle_format_version: 1` (the renderer's cached
    // record from before the migration), and the v1 read path would
    // continue serving overlays even after the row flipped to v2 on
    // disk + in the DB. Editor.tsx's useEnsureV2 has no way to
    // invalidate the model directly — the captures:changed broadcast
    // is the existing channel.
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send(EVENT_CHANNELS.capturesChanged, {
        changedIds: [captureId]
      });
    }

    log.info("v1-to-v2-doctor: upgraded capture", {
      captureId,
      bundlePath: finalPath,
      layerCount: documentWithRealSha.layers.length
    });

    return ok({ migrated: true });
  } catch (cause) {
    const errorCode = errorCodeFor(cause);
    const attemptsAfter = row.v1_to_v2_attempts + 1;
    const parked = attemptsAfter >= MAX_ATTEMPTS;

    db.prepare<[string, string]>(
      `UPDATE captures SET v1_to_v2_last_error_code = ? WHERE id = ?`
    ).run(errorCode, captureId);

    log.warn("v1-to-v2-doctor: per-capture upgrade failed", {
      captureId,
      attempts: attemptsAfter,
      parked,
      errorCode,
      message: cause instanceof Error ? cause.message : String(cause)
    });

    emitProgress({
      status: "failed",
      captureId,
      errorCode,
      attempts: attemptsAfter,
      parked
    });

    return err(
      pwrSnapError("persistence", errorCode, `v1-to-v2-doctor: upgrade failed`, cause)
    );
  }
}

function errorCodeFor(cause: unknown): string {
  if (cause instanceof Error) {
    const msg = cause.message;
    if (msg.includes("manifest")) return "manifest_invalid";
    if (msg.includes("overlays")) return "overlays_invalid";
    if (msg.includes("ENOSPC")) return "disk_full";
    if (msg.includes("EACCES")) return "permission_denied";
  }
  return "upgrade_failed";
}

// ────────────────────────────────────────────────────────────────────
// clearParkedState — wired to `v1ToV2:retry`
// ────────────────────────────────────────────────────────────────────

/**
 * Clear a capture's parked-state bookkeeping so the doctor can
 * re-attempt on next user open. Resets attempts to 0 and clears
 * the last-failure columns. Pure DB write; no IO, no events.
 */
export function clearParkedState(
  db: ReturnType<typeof getDb>,
  captureId: string
): void {
  db.prepare<[string]>(
    `UPDATE captures
        SET v1_to_v2_attempts = 0,
            v1_to_v2_last_failed_at = NULL,
            v1_to_v2_last_error_code = NULL
      WHERE id = ?`
  ).run(captureId);
}

// ────────────────────────────────────────────────────────────────────
// synthesizeV2DocumentFromV1Overlays — pure mapping
// ────────────────────────────────────────────────────────────────────

/**
 * Build a v2 BundleDocumentV2 from a v1 overlays array + v1 manifest.
 *
 * Mapping rules (from the plan §"v1 → v2 migration mapping table"):
 *
 *  • Root group layer is always synthesized.
 *  • Raster layer for the source PNG is always synthesized (the
 *    real sha256 is patched in by the migrate caller, since we
 *    don't have the bytes in scope here).
 *  • Crop overlays bake into canvas_dimensions; no layer node
 *    is emitted for them. (v2.0 honors the v1 source dims directly;
 *    canvas-side crop semantics land with the v2 editor itself.)
 *  • Vector overlays (arrow/rect/text/highlight) become vector
 *    layers with the v1 Overlay carried verbatim under `shape`.
 *    Coords stay normalized [0,1] — the v2 vector renderer
 *    multiplies by canvas dims at render time
 *    (see compose-tree-vector.ts).
 *  • Blur overlays become effect layers with `effect: { type:
 *    "blur", radius_px }` and `clip_rect` in ABSOLUTE canvas
 *    pixels (× source dims) — v2 EffectLayer's clip_rect is a
 *    `CanvasRect` with absolute coords.
 *  • Overlays with non-null `ai_run_id` are grouped under a
 *    synthetic parent group keyed by ai_run_id.
 *  • Soft-deleted / superseded fields preserved.
 *  • Step overlays (numbered steps) map to vector layers verbatim
 *    too — same Overlay shape.
 */
export function synthesizeV2DocumentFromV1Overlays(
  overlaysV1: BundleOverlaysV1,
  _manifestV1: BundleManifestV1,
  source: { width: number; height: number }
): BundleDocumentV2 {
  const now = new Date().toISOString();

  // Root group + raster layer for the source. The raster's
  // source_ref.sha256 is a placeholder; migrateBundleV1ToV2 patches
  // it with the real source bytes' sha after this returns. We use
  // a stable all-zero sha so the result is deterministic for unit
  // tests that don't supply bytes.
  const rootGroupId = nanoid(16);
  const rasterLayerId = nanoid(16);
  const PLACEHOLDER_SHA = "0".repeat(64);

  const rootGroup: GroupLayer = {
    id: rootGroupId,
    parent_id: null,
    kind: "group",
    collapsed: false,
    name: "Root",
    visible: true,
    locked: false,
    opacity: 1,
    blend_mode: "normal",
    transform: [1, 0, 0, 1, 0, 0],
    z_index: 0,
    source: "user",
    ai_run_id: null,
    applied_at: now,
    rejected_at: null,
    superseded_by: null,
    created_at: now
  };

  const sourceRaster: RasterLayer = {
    id: rasterLayerId,
    parent_id: rootGroupId,
    kind: "raster",
    source_ref: { kind: "embedded", sha256: PLACEHOLDER_SHA },
    natural_width_px: source.width,
    natural_height_px: source.height,
    name: "Source",
    visible: true,
    locked: false,
    opacity: 1,
    blend_mode: "normal",
    transform: [1, 0, 0, 1, 0, 0],
    z_index: 0,
    source: "user",
    ai_run_id: null,
    applied_at: now,
    rejected_at: null,
    superseded_by: null,
    created_at: now
  };

  const layers: BundleLayerNode[] = [rootGroup, sourceRaster];

  // AI-run grouping: each unique non-null ai_run_id gets a synthetic
  // group layer parented at the root, and the matching vector/effect
  // layers parent under it. Sort to make the output deterministic
  // (test-friendliness — the order of overlays in the v1 file is
  // arbitrary).
  const aiRunGroups = new Map<string, string>(); // ai_run_id -> group.id

  for (const overlay of overlaysV1.overlays) {
    const data: Overlay = overlay.data;
    // Crop bakes into canvas; no layer node.
    if (data.kind === "crop") continue;

    // Resolve the parent for this layer — either the AI-run group
    // (if ai_run_id is non-null) or the root group.
    let parentId: string = rootGroupId;
    if (overlay.ai_run_id !== null) {
      const existing = aiRunGroups.get(overlay.ai_run_id);
      if (existing !== undefined) {
        parentId = existing;
      } else {
        const aiGroupId = nanoid(16);
        aiRunGroups.set(overlay.ai_run_id, aiGroupId);
        const aiGroup: GroupLayer = {
          id: aiGroupId,
          parent_id: rootGroupId,
          kind: "group",
          collapsed: false,
          name: `AI run ${overlay.ai_run_id.slice(0, 8)}`,
          visible: true,
          locked: false,
          opacity: 1,
          blend_mode: "normal",
          transform: [1, 0, 0, 1, 0, 0],
          z_index: 0,
          source: overlay.source,
          ai_run_id: overlay.ai_run_id,
          applied_at: overlay.applied_at,
          rejected_at: null,
          superseded_by: null,
          created_at: overlay.created_at
        };
        layers.push(aiGroup);
        parentId = aiGroupId;
      }
    }

    if (data.kind === "blur") {
      // Convert to v2 EffectLayer with sample-below semantics. The
      // clip_rect uses ABSOLUTE canvas pixels.
      // Single source of truth lives in @pwrsnap/shared; the formula
      // already applies the [1, 200] clamp + 8px floor.
      const radiusPx = deriveBlurRadiusPx(source);
      const effectLayer: EffectLayer = {
        id: ensureNanoIdShape(overlay.id),
        parent_id: parentId,
        kind: "effect",
        effect: { type: "blur", radius_px: radiusPx },
        clip_rect: {
          x: data.rect.x * source.width,
          y: data.rect.y * source.height,
          w: data.rect.w * source.width,
          h: data.rect.h * source.height
        },
        name: "Blur",
        visible: true,
        locked: false,
        opacity: 1,
        blend_mode: "normal",
        transform: [1, 0, 0, 1, 0, 0],
        z_index: overlay.z_index,
        source: overlay.source,
        ai_run_id: overlay.ai_run_id,
        applied_at: overlay.applied_at,
        rejected_at: overlay.rejected_at,
        superseded_by: overlay.superseded_by,
        created_at: overlay.created_at
      };
      layers.push(effectLayer);
      continue;
    }

    // arrow / rect / text / highlight / step — all carry the v1
    // Overlay verbatim under `shape`. Coords stay normalized [0,1];
    // the v2 vector renderer multiplies by canvas dims at render
    // time.
    const vectorLayer: VectorLayer = {
      id: ensureNanoIdShape(overlay.id),
      parent_id: parentId,
      kind: "vector",
      shape: data,
      name: layerNameForVector(data.kind),
      visible: true,
      locked: false,
      opacity: 1,
      blend_mode: "normal",
      transform: [1, 0, 0, 1, 0, 0],
      z_index: overlay.z_index,
      source: overlay.source,
      ai_run_id: overlay.ai_run_id,
      applied_at: overlay.applied_at,
      rejected_at: overlay.rejected_at,
      superseded_by: overlay.superseded_by,
      created_at: overlay.created_at
    };
    layers.push(vectorLayer);
  }

  const document: BundleDocumentV2 = {
    document_format_version: 1,
    edits_version: overlaysV1.overlays_version,
    layers,
    tags: overlaysV1.tags,
    description: overlaysV1.description,
    ai_runs: []
  };
  return document;
}

function layerNameForVector(kind: Overlay["kind"]): string {
  switch (kind) {
    case "arrow":
      return "Arrow";
    case "rect":
      return "Rectangle";
    case "text":
      return "Text";
    case "highlight":
      return "Highlight";
    case "step":
      return "Step";
    case "blur":
      return "Blur";
    case "crop":
      return "Crop";
  }
}

/**
 * v1 overlay ids were free-form strings (any length). v2 layer ids
 * must match the NanoId16 pattern (`^[A-Za-z0-9_-]{16}$`). When a
 * v1 id passes through cleanly we keep it (stable references); when
 * it doesn't, we mint a fresh nanoid.
 *
 * In practice v1 ids ARE 16-char nanoids (per `nanoid(16)` at
 * overlay-insert sites) so this branch should never fire — but a
 * legacy capture from a pre-nanoid build could trip it, and the
 * zod validator would reject the migration without this safety net.
 */
function ensureNanoIdShape(id: string): string {
  if (/^[A-Za-z0-9_-]{16}$/.test(id)) return id;
  return nanoid(16);
}

// ────────────────────────────────────────────────────────────────────
// reconcileV1ToV2OnBoot — heal partial mid-crash states
// ────────────────────────────────────────────────────────────────────

type ReconcileRow = {
  id: string;
  bundle_path: string | null;
  bundle_format_version: number;
};

/**
 * Boot-time read-mostly sweep that heals partial mid-crash states
 * from a prior doctor run. Walks the partial index
 * `idx_captures_v1_to_v2_pending` and a couple of additional shapes.
 *
 * Read-mostly + surgical-write design (per data-integrity-guardian):
 *   • DB-says-v2 but bundle-missing → revert DB to v1
 *   • DB-says-v1 but bundle-says-v2 → reconcile DB to v2
 *   • Orphan overlays rows for v2 captures → DELETE
 *   • Orphan .pwrsnap.tmp files → unlink
 *
 * Sweep runs fire-and-forget from main/index.ts after migrations
 * have applied. Logs progress via `emitProgress`.
 */
export async function reconcileV1ToV2OnBoot(): Promise<void> {
  const db = getDb();

  // Rows that may need a sanity check: anything whose
  // bundle_format_version doesn't match its on-disk reality. We
  // walk every row with a bundle_path (cheap; rows without aren't
  // the doctor's concern).
  const rows = db
    .prepare<[], ReconcileRow>(
      `SELECT id, bundle_path, bundle_format_version
         FROM captures
        WHERE bundle_path IS NOT NULL
          AND deleted_at IS NULL`
    )
    .all();

  // Also walk every capture dir for stray .pwrsnap.tmp files —
  // these are crashes between step 6 and step 7 of migrateBundle...
  const tmpFiles = await findOrphanTempFiles(rows);

  const total = rows.length + tmpFiles.length;

  emitProgress({
    status: "running",
    captureId: null,
    total,
    done: 0,
    failed: 0
  });

  let done = 0;
  let failed = 0;

  // Pass 1: reconcile DB ↔ bundle version drift + orphan overlay
  // rows.
  for (const row of rows) {
    try {
      await reconcileOne(row);
    } catch (cause) {
      failed += 1;
      log.warn("v1-to-v2-reconcile: row reconcile failed", {
        captureId: row.id,
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
    done += 1;
    if (done % RECONCILE_PROGRESS_EVERY_N === 0) {
      emitProgress({
        status: "running",
        captureId: null,
        total,
        done,
        failed
      });
    }
  }

  // Pass 2: orphan .pwrsnap.tmp file cleanup.
  for (const tmpPath of tmpFiles) {
    try {
      await unlink(tmpPath);
      log.info("v1-to-v2-reconcile: removed orphan temp file", { tmpPath });
    } catch (cause) {
      failed += 1;
      log.warn("v1-to-v2-reconcile: failed to remove orphan temp", {
        tmpPath,
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
    done += 1;
    if (done % RECONCILE_PROGRESS_EVERY_N === 0) {
      emitProgress({
        status: "running",
        captureId: null,
        total,
        done,
        failed
      });
    }
  }

  emitProgress({
    status: "complete",
    captureId: null,
    total,
    done,
    failed
  });

  log.info("v1-to-v2-reconcile: done", {
    inspected: rows.length,
    orphanTmpFiles: tmpFiles.length,
    failed
  });
}

async function reconcileOne(row: ReconcileRow): Promise<void> {
  if (row.bundle_path === null) return;

  const db = getDb();

  // Case A: DB says v2 but bundle file missing on disk → revert
  // DB to v1. (Crashed between rename and the follow-up UPDATE in
  // step 8 — the on-disk bundle is still at the .tmp path, which
  // pass 2 will sweep. Reverting frees the row to retry.)
  if (row.bundle_format_version === 2 && !existsSync(row.bundle_path)) {
    log.info("v1-to-v2-reconcile: DB says v2 but bundle missing; reverting", {
      captureId: row.id,
      bundlePath: row.bundle_path
    });
    db.prepare<[string]>(
      `UPDATE captures SET bundle_format_version = 1 WHERE id = ?`
    ).run(row.id);
    return;
  }

  // For every other case we need to read the on-disk manifest to
  // know whether it's v1 or v2.
  let manifest: BundleManifestV1 | BundleManifestV2;
  try {
    manifest = await readBundleManifest(row.bundle_path);
  } catch (cause) {
    // Bundle exists but isn't readable — quarantine via log; no
    // mutation. Doctor's per-capture path will surface a real
    // error on next open.
    log.warn("v1-to-v2-reconcile: bundle unreadable, skipping", {
      captureId: row.id,
      bundlePath: row.bundle_path,
      message: cause instanceof Error ? cause.message : String(cause)
    });
    return;
  }

  // Case B: DB says v1 but bundle is v2 → reconcile DB to v2.
  // (Crashed inside step 7 or between 7 and 8 where the layer-tree
  // write committed but the captures UPDATE didn't, OR between 8a
  // (rename) and 8b (UPDATE captures.bundle_path back to final).)
  if (row.bundle_format_version === 1 && manifest.bundle_format_version === 2) {
    log.info("v1-to-v2-reconcile: DB says v1 but bundle is v2; reconciling", {
      captureId: row.id
    });
    db.prepare<[string]>(
      `UPDATE captures SET bundle_format_version = 2 WHERE id = ?`
    ).run(row.id);
    // Fall through to Case D's overlay sweep — the row is now v2,
    // and any leftover overlays rows are orphans.
  }

  // Case C: DB says v2 and bundle is v2 — happy path, nothing to do
  // for the version columns. Fall through to Case D.

  // Case D: orphan overlays rows for v2 captures. Idempotent
  // DELETE — if there are no rows, the statement is a no-op.
  const effectiveVersion =
    manifest.bundle_format_version === 2 ||
    row.bundle_format_version === 2
      ? 2
      : 1;
  if (effectiveVersion === 2) {
    const result = db
      .prepare<[string]>(`DELETE FROM overlays WHERE capture_id = ?`)
      .run(row.id);
    if (result.changes > 0) {
      log.info("v1-to-v2-reconcile: deleted orphan overlay rows", {
        captureId: row.id,
        deleted: result.changes
      });
    }
  }
}

/**
 * Walk each capture's bundle directory for stray `.pwrsnap.tmp`
 * files left behind by a doctor crash between step 6 and step 7.
 * Returns absolute paths. Deduplicates per directory so a directory
 * with many bundles isn't walked multiple times.
 */
async function findOrphanTempFiles(rows: readonly ReconcileRow[]): Promise<string[]> {
  const seen = new Set<string>();
  const tmpPaths: string[] = [];
  for (const row of rows) {
    if (row.bundle_path === null) continue;
    const dir = dirname(row.bundle_path);
    if (seen.has(dir)) continue;
    seen.add(dir);
    try {
      const entries = await readdir(dir);
      for (const name of entries) {
        if (!name.endsWith(".pwrsnap.tmp")) continue;
        tmpPaths.push(join(dir, name));
      }
    } catch (cause) {
      log.warn("v1-to-v2-reconcile: failed to scan dir for orphans", {
        dir,
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
  }
  return tmpPaths;
}

// bundle-store + layers-repo are referenced via `await import(...)`
// inside migrateBundleV1ToV2 to avoid a top-level cycle (same
// pattern bundle-store itself uses for layers-repo when seeding
// the initial v2 layer tree).
