// Single-flight coordinator. Two parallel renders of the same
// (captureId, hash, format) collapse into one promise — saves CPU
// and prevents concurrent writes to the same cache file.
//
// The cache key is the `render_inputs_hash` that compose() computes
// internally. We compute the same hash here so the in-flight map
// can coalesce BEFORE diving into compose. Both sides agree on the
// canonical form.
//
// Cancellation: callers don't propagate AbortSignal here in Phase
// 1/2; renders complete and the result is reused even by a
// "cancelled" caller. The savings come from coalescing, not skipping.

import { compose, type RenderRequest, type RenderResult } from "./compose";
import { composeV2 } from "./compose-tree";
import { getCaptureById } from "../persistence/captures-repo";
import { listLiveOverlays } from "../persistence/overlays-repo";
import { ensureEffectiveSrcPath } from "../persistence/source-store";
import { computeRenderHash } from "./overlay-hash";

const inFlight = new Map<string, Promise<RenderResult>>();

/**
 * Build the in-flight key for a render request. We use the
 * render_inputs_hash so two concurrent calls for the same
 * (captureId, overlay set, width, format) coalesce — even if the
 * caller passes width via different paths.
 */
function keyFor(req: RenderRequest, renderHash: string): string {
  return `${req.captureId}:${renderHash}:${req.format}`;
}

export async function renderViaCoordinator(req: RenderRequest): Promise<RenderResult> {
  // Re-derive the hash here so we can coalesce BEFORE compose runs.
  // compose() will compute the same hash and use it as the cache
  // file key — the two computations are guaranteed equivalent
  // because they both pull listLiveOverlays for the same
  // captureId.
  const overlays = listLiveOverlays(req.captureId);
  const renderHash = computeRenderHash({
    format: req.format,
    width: req.width,
    appliedOverlays: overlays
  });

  const key = keyFor(req, renderHash);
  const pending = inFlight.get(key);
  if (pending !== undefined) return pending;

  const promise = (async () => {
    try {
      return await compose(req);
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
 * resolver — wires the protocol to the render pipeline.
 */
export async function resolveCacheFile(req: {
  captureId: string;
  width: number;
  format: "png" | "webp";
}): Promise<string | null> {
  const record = getCaptureById(req.captureId);
  if (record === null) return null;

  // v2 captures route through composeV2 (tree-walking compositor with
  // sample-below contextual effects). v1 captures + legacy-only rows
  // continue through compose() unchanged.
  if (record.bundle_format_version >= 2 && record.bundle_path !== null) {
    const v2Result = await composeV2({
      captureId: req.captureId,
      bundlePath: record.bundle_path,
      canvasWidthPx: record.width_px,
      canvasHeightPx: record.height_px,
      width: req.width,
      format: req.format
    });
    return v2Result.cachePath;
  }

  const result = await renderViaCoordinator({
    captureId: req.captureId,
    srcPath: await ensureEffectiveSrcPath(record),
    imageWidthPx: record.width_px,
    imageHeightPx: record.height_px,
    width: req.width,
    format: req.format
  });
  return result.cachePath;
}
