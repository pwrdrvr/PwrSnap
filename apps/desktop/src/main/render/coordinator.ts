// Single-flight coordinator. Two parallel renders of the same
// (captureId, width, format) collapse into one promise — saves CPU
// and prevents concurrent writes to the same cache file.
//
// Cancellation: callers don't propagate AbortSignal here in Phase 1;
// renders complete and the result is reused even by a "cancelled"
// caller. The savings come from coalescing, not skipping.

import { compose, type RenderRequest, type RenderResult } from "./compose";
import { getCaptureById } from "../persistence/captures-repo";

const inFlight = new Map<string, Promise<RenderResult>>();

function keyFor(req: RenderRequest): string {
  return `${req.captureId}:${req.width}:${req.format}`;
}

export async function renderViaCoordinator(req: RenderRequest): Promise<RenderResult> {
  const key = keyFor(req);
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
 * Returns null if the capture doesn't exist or is soft-deleted.
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
  if (record === null || record.deleted_at !== null) return null;

  const result = await renderViaCoordinator({
    captureId: req.captureId,
    srcPath: record.src_path,
    width: req.width,
    format: req.format
  });
  return result.cachePath;
}
