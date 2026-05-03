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
import type { CaptureRecord, PwrSnapError, Result } from "@pwrsnap/shared";
import { bus } from "../command-bus";
import { pickRegion } from "../capture/region-selector";
import { captureRegion } from "../capture/screencapture";
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
    return persistAndBroadcast(captureResult.tempPath);
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
    const captureResult = await captureRegion(selection.rect, selection.displayId);
    if (!captureResult.ok) {
      return err({
        kind: "capture",
        code: captureResult.reason,
        message: captureResult.message
      });
    }
    return persistAndBroadcast(captureResult.tempPath);
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

async function persistAndBroadcast(
  tempPath: string
): Promise<Result<CaptureRecord, PwrSnapError>> {
  const stored = await putCaptureSource(tempPath);
  const { record, isNew } = insertOrFindCapture({
    id: stored.id,
    kind: "image",
    captured_at: new Date().toISOString(),
    source_app_bundle_id: null, // Phase 3 fills this
    source_app_name: null,
    src_path: stored.srcPath,
    width_px: stored.widthPx,
    height_px: stored.heightPx,
    device_pixel_ratio: 2, // Phase 3+ derives from the active display
    byte_size: stored.byteSize,
    sha256: stored.sha256
  });
  log.info("capture persisted", { captureId: record.id, isNew });
  broadcastCapturesChanged([record.id]);
  return ok(record);
}
