// Single-flight coordinator + format-aware dispatch.
//
// Two responsibilities, both centralized here so every caller gets
// the right behavior without having to know about v1 vs v2:
//
//   1. Format-aware routing — for every render request, look up the
//      capture record and dispatch to compose() (v1) or composeV2()
//      (v2) based on `bundle_format_version`. Pre-fix this routing
//      lived ONLY inside `resolveCacheFile`; the wider entry point
//      `renderViaCoordinator` always ran the v1 path. For v2
//      captures the v1 path reads `listLiveOverlays` (empty — v2
//      stores overlays in the layer tree, not the overlays table),
//      composites zero overlays onto the source, and hands the bare
//      source back to the caller. Every clipboard copy, drag icon,
//      and preset render of a v2 capture lost the user's annotations
//      that way. The bug was invisible in the Library (which uses
//      `resolveCacheFile` via the `pwrsnap-cache://` protocol) and
//      brutal everywhere else.
//
//   2. Single-flight coalescing — two parallel renders of the same
//      (captureId, hash, format) collapse into one promise. Saves
//      CPU and prevents concurrent writes to the same cache file.
//      The cache key is the `render_inputs_hash` that compose()
//      computes internally; we compute the same hash here so the
//      in-flight map can coalesce BEFORE diving into compose. v2
//      uses its own internal hashing inside composeV2; we coalesce
//      v2 calls by (captureId, width, format) which is a coarser
//      key but still prevents the duplicate-write race.
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
 * Build the in-flight key. v1 path uses the render_inputs_hash so
 * the dedup matches compose()'s internal cache. v2 path uses a
 * coarser key (no overlay-set hashing at the coordinator layer;
 * composeV2 owns its own caching). Both prefixes are disjoint so a
 * v1 row that later flips to v2 (lazy doctor) can't collide.
 */
function keyForV1(req: RenderRequest, renderHash: string): string {
  return `v1:${req.captureId}:${renderHash}:${req.format}`;
}

function keyForV2(
  captureId: string,
  width: number,
  format: "png" | "webp"
): string {
  return `v2:${captureId}:${width}:${format}`;
}

/**
 * Render one capture at a target width + format. Format-aware: looks
 * up the capture record and dispatches to compose() (v1) or
 * composeV2() (v2). Every render path in the app — Library
 * thumbnails, Copy buttons, drag icons, preset renders, AI
 * enrichment — funnels through here so the v1/v2 branch only has
 * to exist in one place.
 *
 * The result shape is RenderResult (compose()'s shape) for both
 * paths — composeV2's `layerCount` is mapped to `overlayCount` since
 * the semantic ("number of things composited onto the source") is
 * the same. Existing callers that read `result.overlayCount` keep
 * working unchanged.
 *
 * Throws on captures whose record was deleted between the caller's
 * lookup and ours. Callers that want a tolerant "render or null"
 * (e.g. for the Trash view's previews) should pre-check with
 * `getCaptureById` and bail before calling.
 */
export async function renderViaCoordinator(req: RenderRequest): Promise<RenderResult> {
  // Look up the record so we can branch on bundle_format_version.
  // Pre-fix this lookup happened only in `resolveCacheFile`; moving
  // it here is what fixes the broken Copy / drag / preset paths.
  const record = getCaptureById(req.captureId);

  // v2 path. Routes through composeV2 (tree-walking compositor with
  // sample-below contextual effects). We accept the caller's `req`
  // and ignore the v1-shaped srcPath / imageWidthPx / imageHeightPx
  // — composeV2 reads the bundle directly and derives canvas dims
  // from the persisted record / layer tree.
  if (
    record !== null &&
    record.bundle_format_version >= 2 &&
    record.bundle_path !== null
  ) {
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
        // Adapt the result shape: composeV2's `layerCount` maps to
        // the v1 `overlayCount` field. Same semantic ("how many
        // composited things ended up in this output") under both
        // formats so we can pretend the result types are uniform
        // from the caller's perspective.
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

  // v1 path. Pre-existing behavior — the hash is derived from the
  // overlays table so two concurrent calls for the same (captureId,
  // overlay set, width, format) coalesce.
  const overlays = listLiveOverlays(req.captureId);
  const renderHash = computeRenderHash({
    format: req.format,
    width: req.width,
    appliedOverlays: overlays
  });
  const key = keyForV1(req, renderHash);
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
