import { BrowserWindow } from "electron";

import { EVENT_CHANNELS } from "@pwrsnap/shared";

/**
 * Notify every live renderer that a capture's layer tree changed so its
 * `useCaptureModel` refetches. Editor windows subscribe to the
 * v2-specific `overlaysChanged`; Library / float-over only know the
 * higher-level capture row, so they get `capturesChanged`. The
 * edits_version bump on the captures row is committed in the same
 * transaction as the layer write, so the cache-buster on
 * `pwrsnap-cache://` URLs is already stale by the time this fires.
 *
 * ANY code that mutates the layer tree must call this — including writers
 * OUTSIDE the `layers:*` handlers (e.g. `clipboard:pasteLayerFragment`).
 * Without it the editor canvas won't refetch until the next unrelated
 * edit happens to fire a broadcast (the "pasted raster stays invisible
 * until you toggle a layer's visibility" bug).
 */
export function broadcastLayersChanged(captureId: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(EVENT_CHANNELS.overlaysChanged, { captureId });
    win.webContents.send(EVENT_CHANNELS.capturesChanged, { changedIds: [captureId] });
  }
}
