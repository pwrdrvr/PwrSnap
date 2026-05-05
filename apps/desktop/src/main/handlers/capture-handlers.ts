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

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserWindow, screen } from "electron";
import sharp from "sharp";
import { ok, err, EVENT_CHANNELS } from "@pwrsnap/shared";
import type { CaptureRecord, PwrSnapError, Rect, Result } from "@pwrsnap/shared";
import { bus } from "../command-bus";
import {
  pickRegion,
  getLastWindowListSnapshot,
  hideSelector
} from "../capture/region-selector";
import { captureRegion, captureWindow } from "../capture/screencapture";
import { releaseSnapshot } from "../capture/screen-snapshot";
import { activateApp, findWindowAt, type WindowInfo } from "../capture/window-list";
import { setFloatOverState } from "../float-over";
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

  bus.register("capture:interactive", async (req) => {
    const mode = req.mode ?? "auto";

    // Note (2026-05-04): the prior "hide the library, restore at end"
    // dance is gone. The tray popover is now a non-activating
    // NSPanel (`type: 'panel'` in createTrayWindow), so its show
    // doesn't activate PwrSnap and its hide doesn't cascade focus
    // to the Library. The Library can stay exactly where the user
    // left it through the entire capture flow — visible, minimized,
    // hidden, on another Space — and Cocoa won't touch it.

    const selection = await pickRegion({ mode });

    // CANCEL path. The selector window is still up at this point —
    // pickRegion no longer hides itself; the caller owns hideSelector.
    // The float-over was pre-shown UNDER the selector during
    // pickRegion; cancel-hide it FIRST, then drop the selector. The
    // user never sees the empty toast because the selector covered
    // it the whole time, and the selector hide reveals the desktop
    // (not the float-over).
    if (!selection.ok) {
      setFloatOverState({ kind: "cancel" });
      // Compositor flush — the float-over hide must reach the
      // window server before we lower the selector, otherwise
      // there's a one-frame window where the toast is visible
      // before the selector window's compositor pass is complete.
      await new Promise((resolve) => setTimeout(resolve, 50));
      hideSelector();
      if (selection.previousAppPid !== null && selection.previousAppPid !== undefined) {
        await activateApp(selection.previousAppPid);
      }
      return err({
        kind: "capture",
        code: selection.reason,
        message: `region selector: ${selection.reason}`
      });
    }

    // COMMIT path. From here on we own the screen snapshot — we MUST
    // release it before returning. wrap the rest in try/finally so an
    // error doesn't leak the temp file.
    const { screenSnapshotId, screenSnapshotPath, previousAppPid } = selection;
    try {
      // Two capture paths:
      //   • Full-window mode (user held ⇧ at commit time, or `mode`
      //     was 'window') → desktopCapturer / `screencapture -l
      //     <id>`. Asks WindowServer for the window's full backing
      //     buffer — clean rounded corners, no occlusion artifacts,
      //     no drop shadow. Captures content even where other
      //     windows are in front. NOTE: this re-shoots the live
      //     screen rather than using the snapshot, because the
      //     snapshot only contains visible pixels.
      //   • Default (mode='auto' rect or 'region') → CROP the
      //     screen snapshot. The snapshot was taken at show() in
      //     PHYSICAL pixels; the rect is in logical px relative to
      //     display.bounds. Multiply rect by scaleFactor and use
      //     sharp.extract for the crop. Apps starting / popups /
      //     redraws after the user committed don't bleed into the
      //     capture — by definition, the snapshot is frozen-in-
      //     time.
      const snapshot = getLastWindowListSnapshot();
      let captureResult;
      let sourceApp;
      if (selection.fullWindow === true && selection.snappedWindowId !== undefined) {
        captureResult = await captureWindow(selection.snappedWindowId);
        sourceApp = findById(snapshot, selection.snappedWindowId);
      } else {
        captureResult = await cropScreenSnapshot(
          screenSnapshotPath,
          selection.rect,
          selection.displayId
        );
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
      const persisted = await persistAndBroadcast(captureResult.tempPath, sourceApp);
      // ORDER MATTERS: populate the float-over BEFORE hiding the
      // selector. The selector covers the float-over visually; once
      // we hide it, the toast is already painted at floating level
      // and instantly visible. No post-hoc show race.
      if (persisted.ok) {
        setFloatOverState({ kind: "show-loaded", captureId: persisted.value.id });
      }
      return persisted;
    } finally {
      // Selector goes away last. Then activate the previous app —
      // toast is already established at floating level so it stays
      // on top of the previously-frontmost app's windows.
      hideSelector();
      void releaseSnapshot(screenSnapshotId);
      if (previousAppPid !== null) {
        await activateApp(previousAppPid);
      }
    }
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
 * Crop the frozen-screen snapshot at `rect`. The snapshot is in
 * PHYSICAL pixels (logical * display.scaleFactor); `rect` is in
 * display logical pixels in global coords. We translate to snapshot-
 * local coords (subtract display.bounds.x/y), scale into physical,
 * clamp to the snapshot's actual dimensions (sharp's extract is
 * intolerant of off-by-one bleed past the edge), then write out.
 *
 * Returns the same {ok, tempPath, displayId} | error envelope shape
 * as captureRegion so the caller path stays identical.
 */
async function cropScreenSnapshot(
  snapshotPath: string,
  rect: Rect,
  displayId: number
): Promise<
  | { ok: true; tempPath: string; displayId: number }
  | { ok: false; reason: "validation" | "error"; message: string }
> {
  const display = screen.getAllDisplays().find((d) => d.id === displayId);
  if (display === undefined) {
    return { ok: false, reason: "validation", message: `unknown display id: ${displayId}` };
  }
  if (rect.w <= 0 || rect.h <= 0) {
    return { ok: false, reason: "validation", message: "rect.w and rect.h must be positive" };
  }
  const scale = display.scaleFactor;
  // Translate global → snapshot-local logical px. The snapshot
  // covers display.bounds, so subtract bounds.{x,y}.
  const localX = rect.x - display.bounds.x;
  const localY = rect.y - display.bounds.y;
  // Logical → physical px. The snapshot file is at physical
  // resolution (e.g. 3840×2160 for a 1920×1080@2x display).
  const left = Math.max(0, Math.round(localX * scale));
  const top = Math.max(0, Math.round(localY * scale));
  const width = Math.max(1, Math.round(rect.w * scale));
  const height = Math.max(1, Math.round(rect.h * scale));

  try {
    const dir = await mkdtemp(join(tmpdir(), "pwrsnap-crop-"));
    const tempPath = join(dir, `${Date.now()}.png`);
    const img = sharp(snapshotPath);
    const meta = await img.metadata();
    // Clamp the extract rect to the snapshot's actual physical
    // dimensions. Even one pixel of overrun makes sharp throw.
    const maxW = meta.width ?? Number.MAX_SAFE_INTEGER;
    const maxH = meta.height ?? Number.MAX_SAFE_INTEGER;
    const clampedLeft = Math.min(left, maxW - 1);
    const clampedTop = Math.min(top, maxH - 1);
    const clampedW = Math.min(width, maxW - clampedLeft);
    const clampedH = Math.min(height, maxH - clampedTop);
    await sharp(snapshotPath)
      .extract({
        left: clampedLeft,
        top: clampedTop,
        width: clampedW,
        height: clampedH
      })
      .png()
      .toFile(tempPath);
    return { ok: true, tempPath, displayId };
  } catch (cause) {
    log.warn("snapshot crop failed", {
      message: cause instanceof Error ? cause.message : String(cause),
      rect,
      displayId
    });
    return {
      ok: false,
      reason: "error",
      message: cause instanceof Error ? cause.message : String(cause)
    };
  }
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
