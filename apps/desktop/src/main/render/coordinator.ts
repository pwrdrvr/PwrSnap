// Single-flight coordinator for v2 renders.
//
// Two responsibilities, both centralized here so every caller gets
// the right behavior:
//
//   1. Render dispatch — for every render request, look up the capture
//      record and render its v2 layer tree via composeV2(). v2 is the
//      only bundle format; a request for a non-v2 record (missing,
//      legacy v1 flag, or v2 without a bundle) is an unrenderable
//      state and throws rather than silently handing back a bare
//      source. (Videos never reach here — they render directly via
//      the `pwrsnap-capture://` protocol, not the compositor.)
//
//   2. Single-flight coalescing — two parallel renders of the same
//      (captureId, width, format) collapse into one promise. Saves
//      CPU and prevents concurrent writes to the same cache file.
//      composeV2 owns its own content hashing internally; we coalesce
//      by (captureId, width, format), a coarser key that still
//      prevents the duplicate-write race.
//
// Cancellation: callers don't propagate AbortSignal here; renders
// complete and the result is reused even by a "cancelled" caller. The
// savings come from coalescing, not skipping.

import { type RenderRequest, type RenderResult } from "./compose";
import { composeV2 } from "./compose-tree";
import { getCaptureById } from "../persistence/captures-repo";
import { ensureEffectiveSrcPath } from "../persistence/source-store";

const inFlight = new Map<string, Promise<RenderResult>>();

/**
 * Build the in-flight coalescing key. composeV2 owns its own content
 * hashing, so the coordinator coalesces by the coarser
 * (captureId, width, format) tuple — enough to collapse duplicate
 * concurrent renders and prevent two writers racing on the same cache
 * file.
 */
function keyForV2(
  captureId: string,
  width: number,
  format: "png" | "webp"
): string {
  return `v2:${captureId}:${width}:${format}`;
}

/**
 * Render one capture at a target width + format via composeV2 (the
 * tree-walking compositor with sample-below contextual effects).
 * Every render path in the app — Library thumbnails, Copy buttons,
 * drag icons, preset renders, AI enrichment — funnels through here.
 *
 * The result is RenderResult; composeV2's `layerCount` is surfaced as
 * `overlayCount` (same semantic: "number of things composited onto
 * the source"), so existing callers reading `result.overlayCount`
 * keep working.
 *
 * Throws when the record is missing or isn't a renderable v2 bundle
 * (legacy v1 flag, or v2 without a bundle on disk). v2 is the only
 * bundle format; there is no v1 fallback. Callers that want a
 * tolerant "render or null" (e.g. the Trash view's previews) should
 * pre-check with `getCaptureById` and bail before calling.
 */
export async function renderViaCoordinator(req: RenderRequest): Promise<RenderResult> {
  const record = getCaptureById(req.captureId);
  if (record === null || record.bundle_format_version < 2 || record.bundle_path === null) {
    throw new Error(
      `renderViaCoordinator: capture ${req.captureId} is not a renderable v2 bundle ` +
        `(record=${
          record === null ? "null" : `v${record.bundle_format_version}`
        }, bundle_path=${record !== null && record.bundle_path !== null ? "set" : "null"})`
    );
  }

  // We ignore the caller's v1-shaped srcPath / imageWidthPx /
  // imageHeightPx — composeV2 reads the bundle directly and derives
  // canvas dims from the persisted record / layer tree.
  const key = keyForV2(req.captureId, req.width, req.format);
  const pending = inFlight.get(key);
  if (pending !== undefined) return pending;

  const bundlePath = record.bundle_path;
  const canvasWidthPx = record.width_px;
  const canvasHeightPx = record.height_px;
  const promise = (async (): Promise<RenderResult> => {
    try {
      const v2Result = await composeV2({
        captureId: req.captureId,
        bundlePath,
        canvasWidthPx,
        canvasHeightPx,
        width: req.width,
        format: req.format
      });
      return {
        cachePath: v2Result.cachePath,
        byteSize: v2Result.byteSize,
        fromCache: v2Result.fromCache,
        renderHash: v2Result.renderHash,
        overlayCount: v2Result.layerCount
      };
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, promise);
  return promise;
}

/**
 * Resolve `(captureId, width, format)` to a cache file path. Looks up
 * the capture's source path, then composes (or hits the cache).
 * Returns null only if the capture row doesn't exist; soft-deleted
 * records still resolve, against the trash file — the Trash view
 * needs working thumbnails + a working Focus image so the user can
 * see what they're about to restore or permanently delete.
 *
 * This is the function `protocols.ts` calls from its `pwrsnap-cache://`
 * resolver — wires the protocol to the render pipeline. Post-fix
 * this is a thin wrapper around `renderViaCoordinator` (which now
 * handles the v1/v2 branch internally). Pre-fix the v1/v2 branch
 * lived HERE, which is why the Library worked but every other
 * render path returned bare source for v2 captures.
 */
export async function resolveCacheFile(req: {
  captureId: string;
  width: number;
  format: "png" | "webp";
}): Promise<string | null> {
  const record = getCaptureById(req.captureId);
  if (record === null) return null;
  const result = await renderViaCoordinator({
    captureId: req.captureId,
    // srcPath + image dims are only consumed by the v1 compose() path;
    // renderViaCoordinator ignores them for v2. Computing srcPath for
    // a v2 row is wasted work but harmless — it triggers the source-
    // store's lazy hash check, which is idempotent.
    srcPath: await ensureEffectiveSrcPath(record),
    imageWidthPx: record.width_px,
    imageHeightPx: record.height_px,
    width: req.width,
    format: req.format
  });
  return result.cachePath;
}
