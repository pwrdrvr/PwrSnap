// Registry for the per-pickRegion screenshot. The selector freezes
// the screen at show() time, paints the snapshot in the renderer as a
// full-window background, and crops THAT snapshot on commit (rather
// than re-shooting the live screen). This is the SnagIt model:
// architectural immunity to apps starting / stopping / popping in
// during the selection, and the only model where "drag against what
// you see" is literally true.
//
// Snapshots are short-lived — one per pickRegion call, deleted when
// the selector hides. The registry is keyed by a nanoid so each show
// gets a stable URL we can hand to the renderer.

import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { nanoid } from "nanoid";
import { getMainLogger } from "../log";
import { captureScreen } from "./screencapture";

const log = getMainLogger("pwrsnap:screen-snapshot");

type Entry = {
  /** Path to the temp PNG. Physical pixels (logical * scaleFactor). */
  filePath: string;
  /** Display id this snapshot was captured for — needed at commit
   *  time so we can apply the right scale factor when cropping. */
  displayId: number;
};

const registry = new Map<string, Entry>();

export type ScreenSnapshot = {
  /** Stable id; embed in `pwrsnap-screen://r/<id>` for the renderer. */
  id: string;
  /** Absolute filesystem path. Useful when sharp-cropping at commit. */
  filePath: string;
  /** Display the snapshot covers. */
  displayId: number;
};

/**
 * Capture the named display and register the file so the
 * `pwrsnap-screen://` protocol handler can resolve it. Throws on
 * capture failure (TCC revoke, screencapture error, unknown display).
 */
export async function captureAndRegister(displayId: number): Promise<ScreenSnapshot> {
  const result = await captureScreen(displayId);
  if (!result.ok) {
    throw new Error(`screen snapshot failed: ${result.reason}: ${result.message}`);
  }
  const id = nanoid();
  const entry: Entry = { filePath: result.tempPath, displayId };
  registry.set(id, entry);
  log.info("snapshot registered", { id, filePath: result.tempPath, displayId });
  return { id, filePath: result.tempPath, displayId };
}

/**
 * Look up the file path for a registered snapshot. Returns null when
 * the id is unknown — protocol handler maps that to a 404.
 */
export function getSnapshotPath(id: string): string | null {
  return registry.get(id)?.filePath ?? null;
}

/**
 * Look up the full snapshot record (path + displayId) by id. Used by
 * the commit path to know which display's scaleFactor to apply when
 * sharp-cropping.
 */
export function getSnapshot(id: string): ScreenSnapshot | null {
  const entry = registry.get(id);
  if (entry === undefined) return null;
  return { id, filePath: entry.filePath, displayId: entry.displayId };
}

/**
 * Delete the underlying temp file and unregister. Idempotent — calling
 * release twice on the same id is a no-op. Errors deleting are logged
 * but not thrown (the GC sweep at boot picks up leaked tmp files).
 */
export async function releaseSnapshot(id: string): Promise<void> {
  const entry = registry.get(id);
  if (entry === undefined) return;
  registry.delete(id);
  try {
    // The capture writes into a fresh mkdtemp directory; remove the
    // whole directory so we don't leave empty `pwrsnap-screen-*`
    // shells littering /tmp.
    await rm(dirname(entry.filePath), { recursive: true, force: true });
  } catch (err) {
    log.warn("snapshot cleanup failed", {
      id,
      filePath: entry.filePath,
      message: err instanceof Error ? err.message : String(err)
    });
  }
}
