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
//   4. insertCapture() — INSERT.
//   5. webContents.send 'events:captures:changed' — library + float-over
//      refetch.
//
// Phase 1.5 wires the float-over to actually fire after a successful
// capture. Phase 1.6 adds clipboard at this seam.

import { mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { clipboard, screen } from "electron";
import sharp from "sharp";
import { ok, err } from "@pwrsnap/shared";
import type {
  CapturePresetMetric,
  CaptureRecord,
  ExportStrategy,
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
import { captureRegion, captureScreen, captureWindow } from "../capture/screencapture";
import { guardScreenCapture } from "../capture/screen-permission-gate";
import { ensureCapturesDirReady } from "../capture/capture-storage-gate";
import { releaseSnapshot } from "../capture/screen-snapshot";
import { activateApp, type WindowInfo } from "../capture/window-list";
import {
  resolveSelectionSourceApp,
  resolveSourceAppByRect
} from "../capture/source-app";
import {
  clipboardImageBufferFormats,
  ingestImageBufferToTempPng,
  writeFirstDecodableClipboardBufferToPng,
  type RawClipboardDecodeFailure
} from "../clipboard-image-buffer";
import { broadcastCapturesChanged } from "../events";
import { setFloatOverState } from "../float-over";
import { hideTrayPopoverIfVisible, setTrayCountdown } from "../tray";
import { findMainLibraryWindow, reclaimDockIconIfLibraryAlive } from "../window";
import { maybeEnqueueCaptureEnrichment } from "./codex-handlers";
import { getCaptureById, insertCapture } from "../persistence/captures-repo";
import { ensureEffectiveSrcPath, putCaptureSource } from "../persistence/source-store";
import { persistCaptureFromTempV2 } from "../persistence/bundle-store";
import { getMainLogger } from "../log";
import { renderViaCoordinator } from "../render/coordinator";
import { prepareRenderedFileAlias } from "../render/file-alias";
import { buildPresetExportDisplayName } from "../render/export-filename";
import { resolveImagePresetFile, targetWidthForImagePreset } from "../render/image-presets";
import { getActiveExportStrategy } from "./settings-handlers";
import { getCaptureEnrichment } from "../persistence/enrichment-repo";

const log = getMainLogger("pwrsnap:capture-handlers");

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
    // Headless/agent path — still trigger the OS prompt on a first-ever
    // attempt (it registers PwrSnap so captures can ever work), but don't
    // pop our Settings window at a programmatic caller on the denied path.
    const blocked = await guardScreenCapture({ routeToSettings: false });
    if (blocked) return blocked;
    const storageBlocked = await ensureCapturesDirReady();
    if (storageBlocked) return storageBlocked;
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
    const sourceApp = resolveSourceAppByRect(req.rect, getLastWindowListSnapshot());
    return persistAndBroadcast(captureResult.tempPath, sourceApp);
  });

  bus.register("capture:interactive", async (req, ctx) => {
    // Gate BEFORE pickRegion: the selector freezes a screen snapshot on
    // show(), which is all-black on a Mac without Screen Recording. On a
    // first-ever attempt the gate fires the macOS prompt instead; on a
    // subsequent denied attempt it routes to System Settings. Either way
    // we never paint an empty selector at the user.
    const blocked = await guardScreenCapture();
    if (blocked) return blocked;
    // Pre-warm the captures-folder (Documents) TCC grant before the
    // selector goes up — otherwise the "Allow Documents" dialog pops
    // under the screen-saver-level selector at persist time.
    const storageBlocked = await ensureCapturesDirReady();
    if (storageBlocked) return storageBlocked;
    const handlerStartedAt = Date.now();
    const mode = req.mode ?? "auto";
    log.info("capture:interactive handler received", {
      mode,
      principal: ctx.principal
    });

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
      log.info("capture:interactive timed delay starting", {
        durationFromHandlerReceivedMs: Date.now() - handlerStartedAt
      });
      const delay = await runTimedDelay();
      if (!delay.ok) return delay;
      log.info("capture:interactive timed delay completed", {
        durationFromHandlerReceivedMs: Date.now() - handlerStartedAt
      });
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

    const pickRegionStartedAt = Date.now();
    log.info("capture:interactive calling pickRegion", {
      mode,
      selectorMode,
      keepPwrSnapChrome,
      durationFromHandlerReceivedMs: pickRegionStartedAt - handlerStartedAt
    });
    const selection = await pickRegion({ mode: selectorMode, keepPwrSnapChrome });
    log.info("capture:interactive pickRegion returned", {
      mode,
      selectorMode,
      ok: selection.ok,
      reason: selection.ok ? "completed" : selection.reason,
      durationFromPickRegionCallMs: Date.now() - pickRegionStartedAt,
      durationFromHandlerReceivedMs: Date.now() - handlerStartedAt
    });

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
      } else {
        // No previous app to restore — the Library (or another
        // PwrSnap window) was topmost when the capture started.
        // After hideSelector, Cocoa's window-cascade picks the next
        // key-window candidate; the floating-level focus-sink wins
        // because it sits above the Library at level 0. Without an
        // explicit refocus the user is left staring at whatever was
        // behind PwrSnap (the Library is alive but not key/front),
        // which reads as "the Library got hidden on cancel." Bring
        // it back to its pre-capture state.
        const library = findMainLibraryWindow();
        if (library !== null && !library.isDestroyed()) {
          if (library.isMinimized()) library.restore();
          if (!library.isVisible()) library.show();
          library.focus();
        }
      }
      // Always re-assert Regular activation policy after cancel —
      // not just on the activateApp branch. Showing the screen-
      // saver-level selector alongside our persistent floating-
      // level panels (focus-sink, tray, float-over) is enough for
      // AppKit to demote PwrSnap to Accessory as a focus-cascade
      // side-effect on the selector's hide, even when we never
      // explicitly deactivated to another app. Demotion strips the
      // Dock icon and orphans the Library — the user reads it as
      // "Library got closed and the Dock icon disappeared." The
      // reclaim is a no-op when the Library is gone (the dock-icon-
      // tied-to-Library invariant means there's no icon to reclaim)
      // and a no-op when the dock is already visible, so it's safe
      // to call unconditionally.
      reclaimDockIconIfLibraryAlive();
      return err({
        kind: "capture",
        code: selection.reason,
        message: `region selector: ${selection.reason}`
      });
    }

    // COMMIT path. The user has selected AND committed — the selector has
    // done its job. We tear it down COMPLETELY before attempting the file
    // save, so a first-capture macOS Documents TCC prompt (triggered by
    // the persist write) can never appear UNDER the screen-saver-level
    // (1000) selector. Once the selector is gone the only PwrSnap window
    // left is the float-over at floating level (3), which sits BELOW a
    // system consent dialog — so the prompt is reachable.
    //
    // We own the screen snapshot now and MUST release it; the try/finally
    // is a safety net (both teardown + release are idempotent).
    const { screenSnapshotId, screenSnapshotPath, previousAppPid } = selection;
    let teardownDone = false;
    const tearDownSelector = async (): Promise<void> => {
      if (teardownDone) return;
      teardownDone = true;
      // Selector down first; then re-activate the previously-frontmost
      // app. The float-over was pre-shown idle at floating level during
      // pickRegion, so it stays above the re-activated app through the
      // idle→loaded content swap — no post-hoc show race. activateApp is
      // the obvious activation-policy demotion trigger, but the selector
      // hide alone trips the same focus cascade when no previous app
      // exists (Library-was-topmost), so reclaim unconditionally to keep
      // the Library reachable via the Dock. (Full rationale on the cancel
      // branch above.)
      hideSelector();
      if (previousAppPid !== null) {
        await activateApp(previousAppPid);
      }
      reclaimDockIconIfLibraryAlive();
    };
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
      const captureResult =
        selection.fullWindow === true && selection.snappedWindowId !== undefined
          ? await captureWindow(selection.snappedWindowId)
          : await cropScreenSnapshot(
              screenSnapshotPath,
              selection.rect,
              selection.displayId
            );
      // Snapshot pixels are now in `captureResult.tempPath` — release the
      // frozen snapshot immediately (idempotent; finally re-calls as a
      // safety net).
      void releaseSnapshot(screenSnapshotId);
      // Source-app resolution is the same on both capture branches —
      // the choice of pixel-fetch path (full-window vs. cropped
      // snapshot) doesn't change WHO owned the window. Single shared
      // helper keeps the snap-id-first / rect-fallback / null tiering
      // identical to the video-recording entry point.
      const sourceApp = resolveSelectionSourceApp(
        selection.rect,
        selection.snappedWindowId,
        snapshot
      );

      if (!captureResult.ok) {
        // Crop/window grab failed before we even tried to save. Mirror the
        // cancel choreography: park the pre-shown idle toast, flush, then
        // drop the selector — so the empty placeholder never flashes.
        setFloatOverState({ kind: "cancel" });
        await new Promise((resolve) => setTimeout(resolve, 50));
        await tearDownSelector();
        return err({
          kind: "capture",
          code: captureResult.reason,
          message: captureResult.message
        });
      }

      // We have the pixels. Tear the selector down NOW — BEFORE the save —
      // so the file write (and any Documents TCC prompt it triggers) runs
      // on a clean screen, never under the picker.
      await tearDownSelector();

      const persisted = await persistAndBroadcast(captureResult.tempPath, sourceApp);
      if (persisted.ok) {
        // Selector is already gone; this swaps the idle float-over to the
        // loaded preview in place (the window stays at floating level).
        setFloatOverState({
          kind: "show-loaded",
          captureId: persisted.value.id,
          record: persisted.value
        });
      } else {
        // Save failed (e.g. the user denied Documents access at the
        // prompt). Park the idle toast rather than leaving it empty.
        setFloatOverState({ kind: "cancel" });
      }
      return persisted;
    } finally {
      // Safety net for an unexpected throw before the explicit teardown.
      void releaseSnapshot(screenSnapshotId);
      await tearDownSelector();
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
        devicePixelRatio: clipboardPng.devicePixelRatio
      });
      if (persisted.ok) {
        log.info("clipboard image pasted into library", {
          captureId: persisted.value.id,
          widthPx: persisted.value.width_px,
          heightPx: persisted.value.height_px,
          devicePixelRatio: clipboardPng.devicePixelRatio
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

  // Note (Full Screen / All Screens): unlike `capture:interactive` we
  // do NOT call `activateApp(previousAppPid)` + `reclaimDockIconIfLibraryAlive`
  // here. Those exist to recover from the activation cascade the
  // region-selector window triggers (it takes key focus on show,
  // AppKit demotes our activation policy on hide). The no-selector
  // path never steals focus — the tray popover is a non-activating
  // panel — so there's nothing to recover. If a future change makes
  // this path activate PwrSnap (e.g. a confirmation HUD), re-introduce
  // both calls here in lockstep with capture-handlers.ts:254-262.
  bus.register("capture:fullScreen", async (req) => {
    const blocked = await guardScreenCapture();
    if (blocked) return blocked;
    const storageBlocked = await ensureCapturesDirReady();
    if (storageBlocked) return storageBlocked;
    const displayId = resolveFullScreenDisplayId(req.displayId);
    const display = screen.getAllDisplays().find((d) => d.id === displayId);
    if (display === undefined) {
      return err({
        kind: "validation",
        code: "unknown_display",
        message: `unknown display id: ${displayId}`
      });
    }
    await hidePwrSnapChromeAndSettle();
    const captureResult = await captureScreen(displayId);
    if (!captureResult.ok) {
      return err({
        kind: "capture",
        code: captureResult.reason,
        message: captureResult.message
      });
    }
    const persisted = await persistAndBroadcast(captureResult.tempPath, null, {
      devicePixelRatio: display.scaleFactor
    });
    if (persisted.ok) {
      setFloatOverState({
        kind: "show-loaded",
        captureId: persisted.value.id,
        record: persisted.value
      });
    }
    return persisted;
  });

  bus.register("capture:allScreens", async (req) => {
    const blocked = await guardScreenCapture();
    if (blocked) return blocked;
    const storageBlocked = await ensureCapturesDirReady();
    if (storageBlocked) return storageBlocked;
    // Bus-boundary validation. The type system catches in-process
    // callers, but `req` arrives over IPC where unchecked JSON could
    // pass `{}` or `{mode: "bogus"}` and silently fall through to
    // stitched. Reject unknown modes explicitly.
    if (req.mode !== "split" && req.mode !== "stitched") {
      return err({
        kind: "validation",
        code: "invalid_mode",
        message: `capture:allScreens mode must be "split" or "stitched", got: ${String(req.mode)}`
      });
    }
    const displays = screen.getAllDisplays();
    if (displays.length === 0) {
      return err({
        kind: "validation",
        code: "no_displays",
        message: "no displays connected"
      });
    }
    await hidePwrSnapChromeAndSettle();

    if (req.mode === "split") {
      // One capture record per display. We serialize the screencapture
      // invocations — `/usr/sbin/screencapture` doesn't like concurrent
      // calls (they race on the cursor-hide global), and 3 displays at
      // ~70ms each is still under 250ms total.
      //
      // Failure semantics: if any display's capture or persist fails
      // partway through, we roll back the records already inserted
      // so the user isn't left with orphan rows alongside an error.
      // Rollback goes through `library:delete` (soft-delete + move to
      // trash + broadcast) — if they want to recover, they're in
      // trash for 14 days.
      const records: CaptureRecord[] = [];
      const rollback = async (cause: string): Promise<void> => {
        if (records.length === 0) return;
        log.warn("capture:allScreens split: rolling back partial captures", {
          cause,
          rolledBack: records.length
        });
        for (const r of records) {
          await bus.dispatch("library:delete", { id: r.id }, { principal: "ipc" });
        }
      };
      for (const d of displays) {
        const captureResult = await captureScreen(d.id);
        if (!captureResult.ok) {
          await rollback(captureResult.reason);
          return err({
            kind: "capture",
            code: captureResult.reason,
            message: captureResult.message
          });
        }
        const persisted = await persistAndBroadcast(captureResult.tempPath, null, {
          devicePixelRatio: d.scaleFactor
        });
        if (!persisted.ok) {
          await rollback(persisted.error.code);
          return persisted;
        }
        records.push(persisted.value);
      }
      // Only the last capture drives the float-over toast — N toasts
      // for N displays would flash through too fast for the user to
      // see any of them, and the library refresh already reflects all
      // N rows.
      const last = records[records.length - 1];
      if (last !== undefined) {
        setFloatOverState({
          kind: "show-loaded",
          captureId: last.id,
          record: last
        });
      }
      return ok({ records });
    }

    // Stitched: shoot every display, then composite onto the virtual-
    // desktop union rect as one PNG. Single capture record in the
    // library, visually identical to "one screenshot of the whole
    // workspace".
    const parts: Array<{ tempPath: string; display: Electron.Display }> = [];
    for (const d of displays) {
      const captureResult = await captureScreen(d.id);
      if (!captureResult.ok) {
        // Clean up any per-display PNGs already on disk before
        // bailing — the stitched path owns the temps from
        // `captureScreen` (see screencapture.ts header), and a mid-
        // loop failure would otherwise leak them until next boot's
        // `sweepStaleTempFiles()`.
        await unlinkTempPaths(parts.map((p) => p.tempPath));
        return err({
          kind: "capture",
          code: captureResult.reason,
          message: captureResult.message
        });
      }
      parts.push({ tempPath: captureResult.tempPath, display: d });
    }
    let stitched;
    try {
      stitched = await stitchDisplays(parts);
    } finally {
      // The per-display PNGs are consumed by sharp inside
      // `stitchDisplays` — delete them whether the composite
      // succeeded or threw, since either way we're done with them.
      await unlinkTempPaths(parts.map((p) => p.tempPath));
    }
    const persisted = await persistAndBroadcast(stitched.tempPath, null, {
      devicePixelRatio: stitched.scaleFactor
    });
    if (!persisted.ok) return persisted;
    setFloatOverState({
      kind: "show-loaded",
      captureId: persisted.value.id,
      record: persisted.value
    });
    return ok({ records: [persisted.value] });
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
      const strategy = await getActiveExportStrategy();
      const presetFile = await renderPresetFile(record, req.preset, strategy);
      const icon = await renderViaCoordinator({
        captureId: record.id,
        srcPath: await ensureEffectiveSrcPath(record),
        imageWidthPx: record.width_px,
        imageHeightPx: record.height_px,
        width: Math.min(DRAG_ICON_WIDTH, record.width_px),
        format: "png"
      });
      const displayName = buildPresetExportDisplayName({
        record,
        enrichment: getCaptureEnrichment(record.id),
        preset: req.preset,
        ext: "png"
      });
      const dragPath = await prepareRenderedFileAlias(presetFile.path, displayName);
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
      const strategy = await getActiveExportStrategy();
      const rendered = await Promise.all(
        COPY_PRESETS.map((preset) => renderPresetFile(record, preset, strategy))
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
        const { record } = insertCapture({
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
        return ok({ record, isNew: true });
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
  | { ok: true; tempPath: string; devicePixelRatio: number }
  | { ok: false; code: "no_image" | "unsupported_image"; message: string; cause?: unknown }
> {
  const decodeFailures: RawClipboardDecodeFailure[] = [];

  // Prefer the raw image flavors on the pasteboard. A PNG flavor is stored
  // verbatim — no re-encode inflation (the source 612 KB PNG stays 612 KB,
  // not the ~707 KB a round-trip through Chromium's encoder produces) and
  // the `pHYs` density survives so we can recover the Retina scale. TIFF /
  // JPEG are encoded to PNG, but we still read their resolution for the
  // DPR. Only when no raw flavor decodes do we fall back to the decoded
  // bitmap (`readImage().toPNG()`), which inflates and drops DPI.
  const decodedBuffer = await writeFirstDecodableClipboardBufferToPng({
    formats: clipboard.availableFormats(),
    readBuffer: (format) => clipboard.readBuffer(format),
    makeTempPath: makeClipboardTempPngPath
  });
  if (decodedBuffer.ok) {
    return decodedBuffer;
  }
  decodeFailures.push(...decodedBuffer.failures);

  // A file URL on the clipboard (e.g. a PNG copied in Finder) — ingest the
  // file directly so a PNG is preserved verbatim and its density is read.
  const filePath = clipboardImageFilePath();
  if (filePath !== null && looksLikeImageFile(filePath)) {
    try {
      const ingested = await ingestImageBufferToTempPng(
        await readFile(filePath),
        makeClipboardTempPngPath
      );
      return { ok: true, ...ingested };
    } catch (cause) {
      decodeFailures.push({ source: filePath, cause });
    }
  }

  // Last resort: the decoded bitmap. This re-encodes via Chromium and
  // can't recover the source DPI, so the scale defaults to 1×.
  const image = clipboard.readImage();
  if (!image.isEmpty()) {
    const tempPath = await makeClipboardTempPngPath();
    await writeFile(tempPath, image.toPNG());
    return { ok: true, tempPath, devicePixelRatio: 1 };
  }

  if (decodeFailures.length > 0) {
    return unsupportedClipboardImage(decodeFailures);
  }
  return {
    ok: false,
    code: "no_image",
    message: "The clipboard does not currently contain an image or image file URL."
  };
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

async function renderPresetFile(
  record: CaptureRecord,
  preset: RenderPreset,
  strategy: ExportStrategy
): Promise<CapturePresetMetric & { path: string }> {
  const targetWidth = targetWidthForImagePreset(preset, record, strategy);
  const scale = Math.min(1, targetWidth / Math.max(1, record.width_px));
  const result = await resolveImagePresetFile(record, preset, strategy);

  return {
    preset,
    path: result.path,
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
  // New captures land as v2 layer-tree bundles. The read path in
  // coordinator.ts still handles v1 transparently, and the v1→v2
  // doctor (lazy on first edit-open + eager at boot) upgrades any
  // pre-v2 captures left in the library.
  //
  // devicePixelRatio threads through so the clipboard-paste flow can pass
  // the scale it inferred from the pasted image's DPI metadata (pHYs /
  // TIFF resolution; 144 DPI → 2× Retina), falling back to 1 when the
  // source carried no density rather than defaulting to 2.
  const { record } = await persistCaptureFromTempV2({
    tempPath,
    sourceApp:
      sourceApp === null
        ? null
        : { bundleId: sourceApp.bundleId, appName: sourceApp.appName },
    devicePixelRatio: options.devicePixelRatio
  });

  log.info("capture persisted", {
    captureId: record.id,
    bundleFormatVersion: record.bundle_format_version,
    sourceAppBundleId: record.source_app_bundle_id,
    sourceAppName: record.source_app_name
  });
  broadcastCapturesChanged([record.id]);
  // PR #30's Codex enrichment fires once per new capture. Every
  // capture flowing through persistCaptureFromTempV2 is brand new —
  // dedup was removed (migration 0021) so there's no "this is the
  // same row again" branch to skip.
  maybeEnqueueCaptureEnrichment(record.id);
  return ok(record);
}

/**
 * Resolve which display to capture for Full Screen. Omitting `displayId`
 * (or passing `undefined`) means "the display the cursor is on right
 * now" — the renderer doesn't enumerate displays. Any id that resolves
 * to a real display is used as-is; anything else (stale id from a
 * hotplugged setup, or the legacy 0-sentinel from older callers) falls
 * back to the cursor's display so the capture still succeeds.
 *
 * `Display.id === 0` is treated as the legacy sentinel rather than a
 * real id — Electron's documented values are positive integers
 * (`screen.getPrimaryDisplay().id`), and accepting 0 as a real id would
 * also accidentally accept a stale numeric default.
 */
function resolveFullScreenDisplayId(displayId: number | undefined): number {
  const all = screen.getAllDisplays();
  if (
    displayId !== undefined &&
    displayId !== 0 &&
    all.some((d) => d.id === displayId)
  ) {
    return displayId;
  }
  const cursorPoint = screen.getCursorScreenPoint();
  return screen.getDisplayNearestPoint(cursorPoint).id;
}

/**
 * Best-effort unlink of caller-owned screencapture temp files. Used by
 * the stitched All-Screens path which owns N per-display PNGs that
 * sharp consumes during composite — leaving them behind would leak
 * one tmpdir per invocation until the boot-time `sweepStaleTempFiles()`
 * reaps them. Errors are swallowed: a missing file is the success
 * case for cleanup; other errors are out of our control here and the
 * stale-temp sweep is the backstop.
 */
async function unlinkTempPaths(paths: readonly string[]): Promise<void> {
  await Promise.allSettled(paths.map((p) => unlink(p)));
}

/**
 * Drop the tray popover and park the float-over before a no-selector
 * capture (Full Screen / All Screens). Both PwrSnap surfaces would
 * otherwise be in the captured framebuffer. A 50ms compositor flush
 * matches the timing the cancel branch of `capture:interactive` uses
 * for the float-over → selector handoff (line 169) — long enough for
 * the WindowServer to finish the hide, short enough that the user
 * doesn't perceive lag between click and shutter.
 */
async function hidePwrSnapChromeAndSettle(): Promise<void> {
  setFloatOverState({ kind: "cancel" });
  hideTrayPopoverIfVisible();
  await new Promise((resolve) => setTimeout(resolve, 50));
}

/**
 * Composite N display PNGs onto the virtual-desktop union rect. Each
 * display's PNG arrives at PHYSICAL pixels (logical × scaleFactor),
 * but the union rect is in LOGICAL coords because that's the
 * coordinate space displays sit in. We resize each display's PNG to
 * `display.{w,h} × maxScale` (so a mixed 1×/2× setup ends up at
 * uniform 2× DPI in the output) and composite at the offset within
 * the union rect, also in `× maxScale` pixels. Non-contiguous
 * layouts (gaps between displays) get the transparent canvas
 * underneath — matches what macOS itself produces for `Cmd+Shift+3`
 * across non-contiguous displays.
 */
async function stitchDisplays(
  parts: Array<{ tempPath: string; display: Electron.Display }>
): Promise<{ tempPath: string; scaleFactor: number }> {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxScale = 1;
  for (const { display } of parts) {
    minX = Math.min(minX, display.bounds.x);
    minY = Math.min(minY, display.bounds.y);
    maxX = Math.max(maxX, display.bounds.x + display.bounds.width);
    maxY = Math.max(maxY, display.bounds.y + display.bounds.height);
    maxScale = Math.max(maxScale, display.scaleFactor);
  }
  const unionW = Math.round((maxX - minX) * maxScale);
  const unionH = Math.round((maxY - minY) * maxScale);

  const composites: Array<{ input: Buffer; left: number; top: number }> = [];
  for (const { tempPath, display } of parts) {
    const targetW = Math.round(display.bounds.width * maxScale);
    const targetH = Math.round(display.bounds.height * maxScale);
    const buf = await sharp(tempPath).resize(targetW, targetH).png().toBuffer();
    composites.push({
      input: buf,
      left: Math.round((display.bounds.x - minX) * maxScale),
      top: Math.round((display.bounds.y - minY) * maxScale)
    });
  }

  const dir = await mkdtemp(join(tmpdir(), "pwrsnap-stitch-"));
  const tempPath = join(dir, `${Date.now()}.png`);
  await sharp({
    create: {
      width: unionW,
      height: unionH,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
    .composite(composites)
    .png()
    .toFile(tempPath);

  return { tempPath, scaleFactor: maxScale };
}
