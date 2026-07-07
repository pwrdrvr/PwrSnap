import { EVENT_CHANNELS } from "@pwrsnap/shared";

import { broadcastCapturesChanged, broadcastRendererEventToLocalWindows } from "../events";

/**
 * Notify every live renderer that a capture's layer tree changed so its
 * `useCaptureModel` refetches. Editor windows subscribe to the
 * v2-specific `overlaysChanged`; Library / float-over only know the
 * higher-level capture row, so they refetch on `capturesChanged`. The
 * edits_version bump on the captures row is committed in the same
 * transaction as the layer write, so the cache-buster on
 * `pwrsnap-cache://` URLs is already stale by the time this fires.
 *
 * Routes through `events.ts` rather than a raw `webContents.send` loop so
 * the captures event also fires the cross-process peer relay AND the
 * dev-seeder debounce sink — a raw loop skips both, which means a layer
 * mutation in split-mode (two-process library) never reaches the peer
 * process's Library window. `overlaysChanged` is editor-local (the editor
 * in the peer process refetches off the relayed `capturesChanged`).
 *
 * ANY code that mutates the layer tree must call this — including writers
 * OUTSIDE the `layers:*` handlers (e.g. `clipboard:pasteLayerFragment`).
 * Without it the editor canvas won't refetch until the next unrelated
 * edit happens to fire a broadcast (the "pasted raster stays invisible
 * until you toggle a layer's visibility" bug).
 */
export function broadcastLayersChanged(captureId: string): void {
  broadcastRendererEventToLocalWindows(EVENT_CHANNELS.overlaysChanged, { captureId });
  broadcastCapturesChanged([captureId]);
}
