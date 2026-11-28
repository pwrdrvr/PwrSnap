// Shared plumbing for the cart's export verbs (Zip, Copy all, Contact sheet):
// the in-flight job registry the one cancel verb aborts, the progress
// broadcast, and the temp directory drag-outs and copies write into.

import { app, BrowserWindow } from "electron";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { EVENT_CHANNELS, type CartExportProgressEvent } from "@pwrsnap/shared";

/**
 * In-flight cart export jobs keyed by their renderer-minted `jobId`.
 * `cart:exportZip:cancel` aborts the matching controller whatever the export
 * kind; the export checks `signal.aborted` between renders and bails. Each
 * handler deletes its own entry in a `finally`, so a stale id never
 * accumulates.
 */
export const exportJobs = new Map<string, AbortController>();

export function broadcastCartExportProgress(event: CartExportProgressEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(EVENT_CHANNELS.cartExportProgress, event);
  }
}

// Drag-out and copy temp artifacts (zip, contact sheet, cursor thumbnail)
// live here. Named by a content hash of (capture id + edits_version + the
// export's options), so re-dragging the SAME cart reuses the file (instant,
// no re-render) and two different carts never collide. Pruned by age on each
// prepare so they don't pile up — the OS would eventually sweep $TMPDIR, but
// not promptly.
export function cartDragTempDir(): string {
  return join(app.getPath("temp"), "pwrsnap-cart-export");
}

/** Drag temp entries older than this are deleted on the next prepare. A
 *  drag's drop completes in seconds, so anything this old is finished. */
export const CART_DRAG_TEMP_MAX_AGE_MS = 10 * 60_000;

/** Best-effort prune of drag temp entries (files, and the per-sheet folders
 *  a friendly file name needs) older than `maxAgeMs`. Never throws — a
 *  missing/unreadable dir or a racing delete just means nothing to do. */
export async function pruneCartDragTemp(dir: string, maxAgeMs: number): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return; // dir doesn't exist yet / unreadable
  }
  const now = Date.now();
  await Promise.all(
    entries.map(async (name) => {
      const p = join(dir, name);
      try {
        const s = await stat(p);
        if (now - s.mtimeMs > maxAgeMs) await rm(p, { recursive: true, force: true });
      } catch {
        // racing delete / stat failure — ignore
      }
    })
  );
}
