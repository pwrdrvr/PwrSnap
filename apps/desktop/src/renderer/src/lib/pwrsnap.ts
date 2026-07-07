// Renderer-side helper around `window.pwrsnapApi.dispatch`. Wraps the
// preload-exposed dispatcher with typed Req<C> / Res<C> inference and
// a small `unwrap` helper for callers that prefer a thrown error to a
// Result envelope (e.g. inside React event handlers where awaiting the
// envelope adds noise).

import type {
  CommandName,
  PerfMarkPayload,
  PwrSnapError,
  RenderPreset,
  Req,
  Res,
  Result,
  VideoPreset
} from "@pwrsnap/shared";

/**
 * Dispatch a command-bus command from the renderer. Returns the full
 * Result envelope. Use `dispatchOrThrow` when you'd rather throw on
 * failure than branch on `result.ok` at the call site.
 */
export async function dispatch<C extends CommandName>(
  name: C,
  req: Req<C>
): Promise<Result<Res<C>, PwrSnapError>> {
  if (!window.pwrsnapApi) {
    return {
      ok: false,
      error: {
        kind: "unknown",
        code: "preload_unavailable",
        message: "pwrsnapApi is not exposed; preload failed to load"
      }
    };
  }
  return window.pwrsnapApi.dispatch(name, req);
}

export class PwrSnapDispatchError extends Error {
  constructor(public readonly cause: PwrSnapError) {
    super(`${cause.kind}: ${cause.code}: ${cause.message}`);
    this.name = "PwrSnapDispatchError";
  }
}

export async function dispatchOrThrow<C extends CommandName>(
  name: C,
  req: Req<C>
): Promise<Res<C>> {
  const result = await dispatch(name, req);
  if (!result.ok) {
    throw new PwrSnapDispatchError(result.error);
  }
  return result.value;
}

/**
 * Subscribe to a server-pushed event channel (see `EVENT_CHANNELS` in
 * `@pwrsnap/shared/ipc`). Returns an unsubscribe function. Designed for
 * `useSyncExternalStore` — the hook lands in Phase 1.8.
 */
export function subscribe(
  channel: string,
  handler: (payload: unknown) => void
): () => void {
  if (!window.pwrsnapApi) return () => undefined;
  return window.pwrsnapApi.on(channel, handler);
}

export function startCaptureDrag(captureId: string, preset: RenderPreset = "high"): void {
  window.pwrsnapApi?.startCaptureDrag({ captureId, preset });
}

/**
 * Renderer-side helper for video drag-out. Mirrors `startCaptureDrag`
 * for images. Fire-and-forget — preload sends `IPC_VIDEO_DRAG_START`
 * with the (captureId, format, preset) tuple; main encodes (cache-
 * hit if already done), generates a poster icon, and calls
 * `webContents.startDrag`. The dragged file is a human-friendly
 * alias (e.g. `checkout-flow-med.mp4`), not the raw render-cache path.
 *
 * Caller invokes this from an `onDragStart` handler after calling
 * `event.preventDefault()` — same shape as the image equivalent.
 */
export function startVideoDrag(
  captureId: string,
  format: "gif" | "mp4",
  preset: VideoPreset
): void {
  window.pwrsnapApi?.startVideoDrag({ captureId, format, preset });
}

/**
 * Renderer-side helper for dragging the cart's Zip export out. Mirrors
 * `startCaptureDrag` for images: fire-and-forget — preload sends
 * `IPC_CART_ZIP_DRAG_START` with the cart's captureIds + preset (+ a
 * suggested filename); main renders the images, zips them to a temp file,
 * and calls `webContents.startDrag` with the `.zip`. Caller invokes this
 * from an `onDragStart` handler after `event.preventDefault()`.
 */
export function startCartZipDrag(
  captureIds: string[],
  preset: RenderPreset,
  suggestedName?: string
): void {
  window.pwrsnapApi?.startCartZipDrag({
    captureIds,
    preset,
    ...(suggestedName !== undefined ? { suggestedName } : {})
  });
}

/**
 * URL builders for the custom protocol schemes. The literal "r" host
 * is required because Chromium lowercases the URL authority for any
 * standard scheme (RFC 3986 §3.2.2) — putting the capture id in the
 * host would mangle nanoid's mixed-case alphabet. Path components
 * preserve case. See apps/desktop/src/main/protocols.ts for the
 * matching parser.
 */
/**
 * Send a renderer→main perf mark. Phase 5 of the perf-seeder plan —
 * the seeder reads these to compute first-paint cold-load latency
 * and other render-side metrics. Fire-and-forget; no response.
 */
export function perfMark(payload: PerfMarkPayload): void {
  // `pwrsnapApi.perfMark` was added in Phase 5; preload may be older
  // in dev hot-reload. Soft-fail rather than throwing in renderer
  // code that doesn't expect the call to fail.
  const api = window.pwrsnapApi as
    | (Window["pwrsnapApi"] & { perfMark?: (payload: PerfMarkPayload) => void })
    | undefined;
  api?.perfMark?.(payload);
}

export function captureSrcUrl(captureId: string): string {
  return `pwrsnap-capture://r/${captureId}`;
}

/**
 * URL for a non-base raster layer's source bytes, served by the
 * `pwrsnap-capture://s/<id>/<sha>` protocol handler. The editor's
 * raster LayerView loads each raster layer's `source_ref.sha256`
 * through here so a layer renders its real pixels without re-baking
 * the composite. Content-addressed, so the bytes are immutable — no
 * cache-buster needed.
 */
export function layerSourceUrl(captureId: string, sha256: string): string {
  return `pwrsnap-capture://s/${captureId}/${sha256}`;
}

export function cacheUrl(
  captureId: string,
  width: number,
  format: "png" | "webp" = "webp",
  /**
   * Cache-buster — usually `record.edits_version`. Include it
   * whenever the URL is rendering a capture that may have been
   * edited; without it, Chromium serves the previously-cached
   * response (`Cache-Control: private, max-age=300` on the
   * protocol handler) and the user keeps seeing the stale render.
   * The protocol handler ignores the query string; it's purely a
   * cache key.
   */
  overlaysVersion?: number
): string {
  const base = `pwrsnap-cache://r/${captureId}/${width}w.${format}`;
  return overlaysVersion === undefined ? base : `${base}?v=${overlaysVersion}`;
}

export function sizzleOutputUrl(
  projectId: string,
  lastRenderedAt?: string | null
): string {
  const base = `pwrsnap-sizzle://r/${projectId}`;
  return lastRenderedAt === undefined || lastRenderedAt === null
    ? base
    : `${base}?v=${encodeURIComponent(lastRenderedAt)}`;
}
