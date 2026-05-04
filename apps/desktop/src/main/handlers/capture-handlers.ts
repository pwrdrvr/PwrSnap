// Command-bus handlers for the `capture:*` namespace. The interactive
// path drives the region-selector + screencapture pipeline; the
// headless path is a deterministic command for agents.
//
// Flow on capture:interactive:
//   1. pickRegion() — shows the pre-warmed selector window, awaits
//      user mouse + keyboard input, returns rect + displayId or
//      cancellation.
//   2. captureRegion() — shells out to /usr/sbin/screencapture, writes
//      a temp PNG.
//   3. putCaptureSource() — moves to <userData>/captures/<yyyy>/<mm>,
//      hashes, returns metadata.
//   4. insertOrFindCapture() — INSERT (or dedup-return if sha256 hit).
//   5. webContents.send 'events:captures:changed' — library + float-over
//      refetch.
//
// Phase 1.5 wires the float-over to actually fire after a successful
// capture. Phase 1.6 adds clipboard at this seam.

import { BrowserWindow } from "electron";
import { ok, err, EVENT_CHANNELS } from "@pwrsnap/shared";
import type { CaptureRecord, PwrSnapError, Rect, Result } from "@pwrsnap/shared";
import { bus } from "../command-bus";
import { pickRegion, getLastWindowListSnapshot } from "../capture/region-selector";
import { captureRegion, captureWindow } from "../capture/screencapture";
import { findWindowAt, type WindowInfo } from "../capture/window-list";
import { insertOrFindCapture, getCaptureById } from "../persistence/captures-repo";
import { putCaptureSource } from "../persistence/source-store";
import { getMainLogger } from "../log";

const log = getMainLogger("pwrsnap:capture-handlers");

function broadcastCapturesChanged(changedIds: string[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(EVENT_CHANNELS.capturesChanged, { changedIds });
  }
}

export function registerCaptureHandlers(): void {
  bus.register("capture:region", async (req) => {
    const captureResult = await captureRegion(req.rect, req.displayId);
    if (!captureResult.ok) {
      return err({
        kind: "capture",
        code: captureResult.reason,
        message: captureResult.message
      });
    }
    // Headless capture: best-effort source-app lookup against the
    // most recent window-list snapshot. Agents calling this directly
    // may not have a snapshot yet; that's fine — fields stay null.
    const sourceApp = resolveSourceApp(req.rect, getLastWindowListSnapshot());
    return persistAndBroadcast(captureResult.tempPath, sourceApp);
  });

  bus.register("capture:interactive", async () => {
    const selection = await pickRegion();
    if (!selection.ok) {
      return err({
        kind: "capture",
        code: selection.reason,
        message: `region selector: ${selection.reason}`
      });
    }

    // Two capture paths:
    //   • Full-window mode (user held ⇧ at commit time) →
    //     `screencapture -l <id>`. Asks WindowServer for the
    //     window's full backing buffer — clean rounded corners, no
    //     occlusion artifacts, no drop shadow. Captures content
    //     even where other windows are in front.
    //   • Default (no ⇧) → `screencapture -R <rect>`. Captures the
    //     literal pixels in the rect — overlapping windows are
    //     included, exactly as the user sees them on screen.
    //
    // snappedWindowId comes through in BOTH cases (when the user
    // committed straight from a window snap), but it's only used to
    // route to captureWindow when fullWindow=true. Otherwise it's
    // just a deterministic source-app hint.
    const snapshot = getLastWindowListSnapshot();
    let captureResult;
    let sourceApp;
    if (selection.fullWindow === true && selection.snappedWindowId !== undefined) {
      captureResult = await captureWindow(selection.snappedWindowId);
      sourceApp = findById(snapshot, selection.snappedWindowId);
    } else {
      captureResult = await captureRegion(selection.rect, selection.displayId);
      sourceApp =
        selection.snappedWindowId !== undefined
          ? findById(snapshot, selection.snappedWindowId) ??
            resolveSourceApp(selection.rect, snapshot)
          : resolveSourceApp(selection.rect, snapshot);
    }
    if (!captureResult.ok) {
      return err({
        kind: "capture",
        code: captureResult.reason,
        message: captureResult.message
      });
    }
    return persistAndBroadcast(captureResult.tempPath, sourceApp);
  });

  bus.register("capture:fullScreen", async () => {
    return err({
      kind: "validation",
      code: "not_implemented",
      message: "capture:fullScreen lands in Phase 1.5+"
    });
  });

  bus.register("capture:window", async () => {
    return err({
      kind: "validation",
      code: "not_implemented",
      message: "capture:window lands in Phase 1.5+"
    });
  });

  bus.register("capture:reveal", async (req) => {
    const record = getCaptureById(req.captureId);
    if (record === null) {
      return err({
        kind: "validation",
        code: "not_found",
        message: `capture not found: ${req.captureId}`
      });
    }
    const { shell } = await import("electron");
    shell.showItemInFolder(record.src_path);
    return ok(undefined);
  });

  bus.register("capture:prepareDrag", async () => {
    // Phase 1.6 + Phase 2 — needs the render coordinator to land first.
    return err({
      kind: "validation",
      code: "not_implemented",
      message: "capture:prepareDrag lands with the render pipeline (Phase 1.6+)"
    });
  });
}

/**
 * Find which window owned the captured rect. We hit-test the rect's
 * center rather than its origin — the origin is often on a window
 * border or even outside the window when the user dragged-from-edge.
 * The snapshot is in window-local coords (relative to the selector
 * window for the active display); that matches how `req.rect` is
 * sourced from the renderer.
 */
function resolveSourceApp(rect: Rect, windows: readonly WindowInfo[]): WindowInfo | null {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  return findWindowAt(windows, cx, cy);
}

function findById(
  windows: readonly WindowInfo[],
  windowId: number
): WindowInfo | null {
  return windows.find((w) => w.windowId === windowId) ?? null;
}

async function persistAndBroadcast(
  tempPath: string,
  sourceApp: WindowInfo | null
): Promise<Result<CaptureRecord, PwrSnapError>> {
  const stored = await putCaptureSource(tempPath);
  const { record, isNew } = insertOrFindCapture({
    id: stored.id,
    kind: "image",
    captured_at: new Date().toISOString(),
    source_app_bundle_id: sourceApp?.bundleId ?? null,
    source_app_name: sourceApp?.appName ?? null,
    src_path: stored.srcPath,
    width_px: stored.widthPx,
    height_px: stored.heightPx,
    device_pixel_ratio: 2, // Phase 3+ derives from the active display
    byte_size: stored.byteSize,
    sha256: stored.sha256
  });
  log.info("capture persisted", {
    captureId: record.id,
    isNew,
    sourceAppBundleId: record.source_app_bundle_id,
    sourceAppName: record.source_app_name
  });
  broadcastCapturesChanged([record.id]);
  return ok(record);
}
