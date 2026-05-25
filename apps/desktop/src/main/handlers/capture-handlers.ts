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
//   3. putCaptureSource() — moves to ~/Documents/PwrSnap/<id>.png,
//      hashes, returns metadata.
//   4. insertOrFindCapture() — INSERT (or dedup-return if sha256 hit).
//   5. webContents.send 'events:captures:changed' — library + float-over
//      refetch.
//
// Phase 1.5 wires the float-over to actually fire after a successful
// capture. Phase 1.6 adds clipboard at this seam.

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { clipboard, screen } from "electron";
import sharp from "sharp";
import { ok, err } from "@pwrsnap/shared";
import type {
  CapturePresetMetric,
  CaptureRecord,
  PwrSnapError,
  Rect,
  RenderPreset,
  Result
} from "@pwrsnap/shared";
import { bus } from "../command-bus";
import {
  pickRegion,
  getLastWindowListSnapshot,
  hideSelector
} from "../capture/region-selector";
import { captureRegion, captureWindow } from "../capture/screencapture";
import { releaseSnapshot } from "../capture/screen-snapshot";
import { activateApp, findWindowAt, type WindowInfo } from "../capture/window-list";
import {
  clipboardImageBufferFormats,
  writeFirstDecodableClipboardBufferToPng,
  type RawClipboardDecodeFailure
} from "../clipboard-image-buffer";
import { broadcastCapturesChanged } from "../events";
import { setFloatOverState } from "../float-over";
import { hideTrayPopoverIfVisible, setTrayCountdown } from "../tray";
import { reclaimDockIconIfLibraryAlive } from "../window";
import { maybeEnqueueCaptureEnrichment } from "./codex-handlers";
import { getCaptureById, insertOrFindCapture } from "../persistence/captures-repo";
import { ensureEffectiveSrcPath, putCaptureSource } from "../persistence/source-store";
import { persistCaptureFromTemp, persistCaptureFromTempV2 } from "../persistence/bundle-store";
import { isV2WriteEnabled } from "../feature-flags";
import { getMainLogger } from "../log";
import { renderViaCoordinator } from "../render/coordinator";
import { prepareRenderedPngAlias } from "../render/file-alias";

const log = getMainLogger("pwrsnap:capture-handlers");

const PRESET_WIDTHS = {
  low: 800,
  med: 1440,
  high: 0
} as const;

const DRAG_ICON_WIDTH = 128;
const COPY_PRESETS = ["low", "med", "high"] as const;
const CLIPBOARD_SOURCE = {
  bundleId: "com.pwrsnap.clipboard",
  appName: "Clipboard"
} as const;
const CLIPBOARD_FILE_URL_FORMATS = [
  "public.file-url",
  "public.url",
  "NSURLPboardType"
] as const;
const IMAGE_FILE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".jpeg",
  ".jpg",
  ".png",
  ".tif",
  ".tiff",
  ".webp"
]);

type CaptureSource = Pick<WindowInfo, "bundleId" | "appName"> | null;

export function clipboardHasPasteableImage(): boolean {
  if (!clipboard.readImage().isEmpty()) return true;
  if (clipboardImageBufferFormats(clipboard.availableFormats()).length > 0) return true;
  const filePath = clipboardImageFilePath();
  return filePath !== null && looksLikeImageFile(filePath);
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

    // Timed mode = "delay 5 s, then open the normal auto picker."
    // During the countdown the user is free to stage anything that
    // would otherwise close the moment a selector window stole key
    // focus — a dropdown, a tooltip, the PwrSnap tray menu itself.
    // We don't touch the screen, we don't substitute any other
    // capture path; we just wait, then fall through to the same
    // `pickRegion({ mode: "auto" })` call Quick Capture uses. The
    // selector takes its frozen-screen snapshot at show() time, so
    // whatever is on screen at t=0 (dropdowns and all) is what the
    // user picks against — region / window / ⇧-full-window all work
    // exactly as they do in Quick Capture.
    if (mode === "timed") {
      const delay = await runTimedDelay();
      if (!delay.ok) return delay;
    }
    const selectorMode = mode === "timed" ? "auto" : mode;
    // Timed mode leaves PwrSnap chrome alone — the user may have
    // re-opened the tray menu during the 5 s precisely to capture
    // it. Every other mode keeps the default behavior of hiding our
    // own popovers/toasts before snapshotting.
    const keepPwrSnapChrome = mode === "timed";

    // Note (2026-05-04): the prior "hide the library, restore at end"
    // dance is gone. The tray popover is now a non-activating
    // NSPanel (`type: 'panel'` in createTrayWindow), so its show
    // doesn't activate PwrSnap and its hide doesn't cascade focus
    // to the Library. The Library can stay exactly where the user
    // left it through the entire capture flow — visible, minimized,
    // hidden, on another Space — and Cocoa won't touch it.

    const selection = await pickRegion({ mode: selectorMode, keepPwrSnapChrome });

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
        // activateApp deactivates PwrSnap to return focus to the
        // previous app. With our floating-level panels in the window
        // list, AppKit can demote our activation policy to Accessory
        // as a side-effect, which strips the Dock icon and orphans
        // the Library. Re-assert Regular policy without yanking focus
        // from the previous app (app.dock.show() doesn't activate).
        reclaimDockIconIfLibraryAlive();
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
        setFloatOverState({
          kind: "show-loaded",
          captureId: persisted.value.id,
          record: persisted.value
        });
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
        // See cancel branch above + reclaimDockIconIfLibraryAlive in
        // window.ts. activateApp deactivates PwrSnap; with our
        // floating panels in the window list AppKit demotes us to
        // Accessory and the Dock icon goes away. Re-assert Regular
        // immediately so the Library stays reachable via the Dock.
        reclaimDockIconIfLibraryAlive();
      }
    }
  });

  bus.register("capture:pasteFromClipboard", async () => {
    const clipboardPng = await writeClipboardImageToTempPng();
    if (!clipboardPng.ok) {
      return err({
        kind: "clipboard",
        code: clipboardPng.code,
        message: clipboardPng.message,
        cause: clipboardPng.cause
      });
    }

    try {
      const persisted = await persistAndBroadcast(clipboardPng.tempPath, CLIPBOARD_SOURCE, {
        devicePixelRatio: 1
      });
      if (persisted.ok) {
        log.info("clipboard image pasted into library", {
          captureId: persisted.value.id,
          widthPx: persisted.value.width_px,
          heightPx: persisted.value.height_px
        });
      }
      return persisted;
    } catch (cause) {
      log.error("clipboard paste failed", {
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return err({
        kind: "clipboard",
        code: "paste_failed",
        message: cause instanceof Error ? cause.message : String(cause),
        cause
      });
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
    // Priority order:
    //   1. flat_png_path — the user-shareable paired PNG, written
    //      alongside the bundle pre-PR-#90. Post-PR-#90 this is null
    //      for all new captures (paired PNG was dropped).
    //   2. bundle_path — the .pwrsnap bundle itself. Finder doesn't
    //      know how to open .pwrsnap files but it WILL select the
    //      bundle in its containing folder, which is what "reveal"
    //      means. This is the post-PR-#90 path for new captures.
    //   3. legacy_src_path — pre-bundle-migration captures only.
    const revealPath =
      record.flat_png_path ?? record.bundle_path ?? record.legacy_src_path;
    if (revealPath === null) {
      return err({
        kind: "validation",
        code: "not_found",
        message: `capture ${req.captureId} has no on-disk path to reveal`
      });
    }
    shell.showItemInFolder(revealPath);
    return ok(undefined);
  });

  bus.register("capture:prepareDrag", async (req) => {
    const record = getCaptureById(req.captureId);
    if (record === null || record.deleted_at !== null) {
      return err({
        kind: "validation",
        code: "not_found",
        message: `capture not found: ${req.captureId}`
      });
    }

    try {
      const presetFile = await renderPresetFile(record, req.preset);
      const icon = await renderViaCoordinator({
        captureId: record.id,
        srcPath: await ensureEffectiveSrcPath(record),
        imageWidthPx: record.width_px,
        imageHeightPx: record.height_px,
        width: Math.min(DRAG_ICON_WIDTH, record.width_px),
        format: "png"
      });
      const dragPath = await prepareRenderedPngAlias(presetFile.path);
      return ok({ path: dragPath, iconPath: icon.cachePath });
    } catch (cause) {
      log.error("prepare drag failed", {
        captureId: req.captureId,
        preset: req.preset,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return err({
        kind: "render",
        code: "prepare_drag_failed",
        message: cause instanceof Error ? cause.message : String(cause),
        cause
      });
    }
  });

  bus.register("capture:presetMetrics", async (req) => {
    const record = getCaptureById(req.captureId);
    if (record === null || record.deleted_at !== null) {
      return err({
        kind: "validation",
        code: "not_found",
        message: `capture not found: ${req.captureId}`
      });
    }

    // Video captures don't go through the sharp-based image render
    // pipeline — the Low / Med / High preset model is image-only.
    // Return an empty metrics array so the renderer hooks
    // (`usePresetRenderMetrics`) resolve to a no-op for video rather
    // than logging "Input file contains unsupported image format"
    // every time the float-over loads a clip.
    if (record.kind === "video") {
      return ok({ metrics: [] });
    }

    try {
      const rendered = await Promise.all(
        COPY_PRESETS.map((preset) => renderPresetFile(record, preset))
      );
      return ok({
        metrics: rendered.map(({ path: _path, ...metric }) => metric)
      });
    } catch (cause) {
      log.error("preset metrics failed", {
        captureId: req.captureId,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return err({
        kind: "render",
        code: "preset_metrics_failed",
        message: cause instanceof Error ? cause.message : String(cause),
        cause
      });
    }
  });

  // Synthetic ingest path — DEV only. The dev seeder dispatches this
  // to populate large datasets through the live command-bus chain so
  // DB page packing, index maintenance, and broadcast cost reflect
  // production behavior. Production builds: this branch tree-shakes
  // out (electron-vite statically replaces `import.meta.env.DEV`).
  if (import.meta.env.DEV) {
    bus.register("capture:ingest", async (req) => {
      try {
        const stored = await putCaptureSource(req.tempPngPath);
        const { record, isNew } = insertOrFindCapture({
          id: stored.id,
          kind: "image",
          captured_at: req.capturedAt,
          source_app_bundle_id: req.sourceAppBundleId,
          source_app_name: req.sourceAppName,
          legacy_src_path: stored.srcPath,
          width_px: req.widthPxHint ?? stored.widthPx,
          height_px: req.heightPxHint ?? stored.heightPx,
          device_pixel_ratio: req.devicePixelRatio ?? 2,
          byte_size: stored.byteSize,
          sha256: stored.sha256
        });
        broadcastCapturesChanged([record.id]);
        return ok({ record, isNew });
      } catch (cause) {
        return err({
          kind: "capture",
          code: "ingest_failed",
          message: cause instanceof Error ? cause.message : String(cause),
          cause
        });
      }
    });
  }
}

async function writeClipboardImageToTempPng(): Promise<
  | { ok: true; tempPath: string }
  | { ok: false; code: "no_image" | "unsupported_image"; message: string; cause?: unknown }
> {
  const image = clipboard.readImage();
  if (!image.isEmpty()) {
    const tempPath = await makeClipboardTempPngPath();
    await writeFile(tempPath, image.toPNG());
    return { ok: true, tempPath };
  }

  const decodedBuffer = await writeFirstDecodableClipboardBufferToPng({
    formats: clipboard.availableFormats(),
    readBuffer: (format) => clipboard.readBuffer(format),
    makeTempPath: makeClipboardTempPngPath
  });
  const decodeFailures: RawClipboardDecodeFailure[] = [];
  if (decodedBuffer.ok) {
    return decodedBuffer;
  }
  decodeFailures.push(...decodedBuffer.failures);

  const filePath = clipboardImageFilePath();
  if (filePath === null || !looksLikeImageFile(filePath)) {
    if (decodeFailures.length > 0) {
      return unsupportedClipboardImage(decodeFailures);
    }
    return {
      ok: false,
      code: "no_image",
      message: "The clipboard does not currently contain an image or image file URL."
    };
  }

  try {
    const tempPath = await makeClipboardTempPngPath();
    await sharp(filePath).png().toFile(tempPath);
    return { ok: true, tempPath };
  } catch (cause) {
    decodeFailures.push({ source: filePath, cause });
    return unsupportedClipboardImage(decodeFailures);
  }
}

function unsupportedClipboardImage(failures: RawClipboardDecodeFailure[]): {
  ok: false;
  code: "unsupported_image";
  message: string;
  cause: unknown;
} {
  return {
    ok: false,
    code: "unsupported_image",
    message: `Could not decode clipboard image formats: ${failures
      .map((failure) => failure.source)
      .join(", ")}`,
    cause: failures
  };
}

async function makeClipboardTempPngPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pwrsnap-clipboard-"));
  return join(dir, `${Date.now()}.png`);
}

function clipboardImageFilePath(): string | null {
  const candidates: string[] = [];
  try {
    const bookmark = clipboard.readBookmark();
    if (bookmark.url.length > 0) candidates.push(bookmark.url);
  } catch {
    // readBookmark is unavailable on some platforms; fall through to
    // plain text / raw pasteboard formats.
  }

  for (const format of CLIPBOARD_FILE_URL_FORMATS) {
    try {
      const value = clipboard.readBuffer(format).toString("utf8");
      if (value.length > 0) candidates.push(value);
    } catch {
      // Experimental API, format may be absent.
    }
  }

  const text = clipboard.readText();
  if (text.length > 0) candidates.push(text);

  for (const candidate of candidates) {
    const path = fileUrlCandidateToPath(candidate);
    if (path !== null) return path;
  }
  return null;
}

function fileUrlCandidateToPath(candidate: string): string | null {
  const first = candidate
    .replaceAll("\0", "")
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (first === undefined || !first.toLowerCase().startsWith("file://")) return null;
  try {
    return fileURLToPath(first);
  } catch {
    return null;
  }
}

function looksLikeImageFile(filePath: string): boolean {
  return IMAGE_FILE_EXTENSIONS.has(extname(filePath).toLowerCase());
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

function targetWidthForPreset(preset: RenderPreset, sourceWidthPx: number): number {
  const presetWidth = PRESET_WIDTHS[preset];
  return presetWidth === 0 ? sourceWidthPx : presetWidth;
}

async function renderPresetFile(
  record: CaptureRecord,
  preset: RenderPreset
): Promise<CapturePresetMetric & { path: string }> {
  const targetWidth = targetWidthForPreset(preset, record.width_px);
  const scale = Math.min(1, targetWidth / Math.max(1, record.width_px));
  const result = await renderViaCoordinator({
    captureId: record.id,
    srcPath: await ensureEffectiveSrcPath(record),
    imageWidthPx: record.width_px,
    imageHeightPx: record.height_px,
    width: targetWidth,
    format: "png"
  });

  return {
    preset,
    path: result.cachePath,
    widthPx: Math.round(record.width_px * scale),
    heightPx: Math.round(record.height_px * scale),
    byteSize: result.byteSize,
    fromCache: result.fromCache
  };
}

/** Total countdown length, in seconds. Matches the "Timed (5s)" label
 *  in the tray + hotkeys page. */
const TIMED_CAPTURE_SECONDS = 5;

/** Module-level guard against overlapping timed captures. Clicking the
 *  tray button a second time while a countdown is running returns an
 *  error instead of stacking a parallel timer. */
let timedDelayInFlight = false;

/**
 * Hold for `TIMED_CAPTURE_SECONDS` while ticking the countdown next to
 * the menubar tray icon. Returns `ok(undefined)` once the timer
 * elapses; the caller (`capture:interactive` for `mode === "timed"`)
 * then drops straight into the normal `pickRegion` path so the user
 * gets the same auto picker as Quick Capture — only against a screen
 * that may now have menus / dropdowns / the PwrSnap tray open.
 *
 * No window is shown for the countdown; `tray.setTitle` writes text
 * next to the menubar icon, which doesn't take key focus and so can't
 * collapse the very UI the user is trying to capture.
 */
async function runTimedDelay(): Promise<Result<void, PwrSnapError>> {
  if (timedDelayInFlight) {
    return err({
      kind: "capture",
      code: "timed_in_progress",
      message: "A timed capture is already counting down."
    });
  }
  timedDelayInFlight = true;
  // Dismiss the tray popover immediately on click — mirrors how
  // clicking Region / Window / Quick Capture in the tray naturally
  // dismisses it (the selector that opens steals focus and the tray
  // blur-dismisses). For timed mode no selector is coming for 5 s,
  // so we dismiss explicitly. The user is free to re-open the tray
  // (or any other transient UI) during the countdown — that's the
  // entire point of the timer. `keepPwrSnapChrome` on the eventual
  // pickRegion call preserves whatever they opened.
  hideTrayPopoverIfVisible();
  try {
    for (let remaining = TIMED_CAPTURE_SECONDS; remaining > 0; remaining--) {
      setTrayCountdown(String(remaining));
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    return ok(undefined);
  } finally {
    setTrayCountdown(null);
    timedDelayInFlight = false;
  }
}

async function persistAndBroadcast(
  tempPath: string,
  sourceApp: CaptureSource,
  options: { devicePixelRatio?: number | undefined } = {}
): Promise<Result<CaptureRecord, PwrSnapError>> {
  // New captures land as v2 layer-tree bundles by default; the
  // PWRSNAP_BUNDLE_V2 env var (see feature-flags.ts) is a debug
  // escape hatch — set it to "0" to force the legacy v1 write path.
  // The read path in coordinator.ts handles both formats
  // transparently, so existing v1 captures continue to render and
  // get promoted to v2 by the lazy doctor on first edit-open.
  //
  // devicePixelRatio threads through both write paths so PR #48's
  // clipboard-paste flow (which passes 1, since pasted bytes aren't
  // from a physical display) doesn't get hardcoded to 2.
  const persistArgs = {
    tempPath,
    sourceApp:
      sourceApp === null
        ? null
        : { bundleId: sourceApp.bundleId, appName: sourceApp.appName },
    devicePixelRatio: options.devicePixelRatio
  };

  const { record, isDedup } = isV2WriteEnabled()
    ? await persistCaptureFromTempV2(persistArgs)
    : await persistCaptureFromTemp(persistArgs);


  log.info("capture persisted", {
    captureId: record.id,
    isDedup,
    bundleFormatVersion: record.bundle_format_version,
    sourceAppBundleId: record.source_app_bundle_id,
    sourceAppName: record.source_app_name
  });
  broadcastCapturesChanged([record.id]);
  if (!isDedup) {
    // PR #30's Codex enrichment fires once per new capture. The
    // bundle-flow's `persistCaptureFromTemp` returns isDedup=true
    // when sha256 matches an existing row; `!isDedup` is the
    // bundle-flow equivalent of the old isNew flag.
    maybeEnqueueCaptureEnrichment(record.id);
  }
  return ok(record);
}
