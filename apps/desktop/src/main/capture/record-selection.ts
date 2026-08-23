import { app, Notification, type BrowserWindow } from "electron";
import type { PwrSnapError, RecordingSubject, Result, Settings } from "@pwrsnap/shared";
import { bus } from "../command-bus";
import { setFloatOverState } from "../float-over";
import { getMainLogger } from "../log";
import {
  findMainLibraryWindow,
  reclaimDockIconIfLibraryAlive,
  scheduleDockReclaim
} from "../window";
import { appWindowsOverlappingRect } from "./rect-overlap";
import { ensureCapturesDirReady } from "./capture-storage-gate";
import { withInteractiveSelectionCleanup } from "./interactive-selection-cleanup";
import {
  getLastWindowListSnapshot,
  hideSelector,
  type SelectorResult
} from "./region-selector";
import { releaseSnapshot } from "./screen-snapshot";
import {
  resolveSelectionSourceApp,
  shouldConsiderRaisingOurWindows
} from "./source-app";
import { activateApp, selfPidSet } from "./window-list";

export type CommittedSelectorResult = Extract<SelectorResult, { ok: true }>;

/**
 * Consume an already-committed selector result through the existing recording
 * pipeline. This is deliberately below the hotkey layer: Quick Capture's
 * Record choice must reuse its frozen selection rather than opening a second
 * picker, while the dedicated Video Capture hotkey still owns its explicit
 * picker and hands the result to this same continuation.
 *
 * The continuation owns selector teardown and snapshot cleanup on every path.
 */
export async function startRecordingFromSelection(
  selection: CommittedSelectorResult,
  settings: Settings["recording"]
): Promise<Result<{ sessionId: string }, PwrSnapError>> {
  const log = getMainLogger("pwrsnap:shortcut");
  return withInteractiveSelectionCleanup({
    snapshotId: selection.screenSnapshotId,
    hideSelector,
    releaseSnapshot,
    run: async (selectionCleanup) => {
      // pickRegion pre-shows an idle Float-Over underneath the selector.
      // Park it before lowering the selector on every Record handoff so no
      // empty, hit-testable popover survives success, cancellation, or error.
      setFloatOverState({ kind: "cancel" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      selectionCleanup.hideSelector();
      await selectionCleanup.releaseSnapshot();

      if (process.platform !== "darwin") {
        const storageBlocked = await ensureCapturesDirReady();
        if (storageBlocked !== null) {
          scheduleDockReclaim();
          return storageBlocked;
        }
      }

    const { previousAppPid } = selection;
    const cachedSnapshot = getLastWindowListSnapshot();
    const shouldRaise = shouldConsiderRaisingOurWindows(
      selection.snappedWindowId,
      cachedSnapshot,
      selfPidSet()
    );
    const overlapping = shouldRaise
      ? appWindowsOverlappingRect(selection.rect, selection.displayId)
      : [];

    log.debug("video-record post-commit focus policy", {
      snappedWindowId: selection.snappedWindowId ?? null,
      previousAppPid,
      shouldRaise,
      overlappingCount: overlapping.length,
      overlappingTitles: overlapping.map((window) => window.getTitle()),
      dockVisibleBefore: app.dock?.isVisible() ?? null,
      libraryAlive: findMainLibraryWindow() !== null
    });

    if (overlapping.length > 0) {
      reclaimDockIconIfLibraryAlive();
      await activateApp(process.pid);
      for (const window of overlapping) {
        if (window.isMinimized()) window.restore();
        if (!window.isVisible()) window.show();
        window.moveTop();
      }
      pickFocusTargetForRecording(overlapping).focus();
      log.debug("video-record raised our windows", {
        ownPid: process.pid,
        dockVisibleAfter: app.dock?.isVisible() ?? null
      });
    } else if (previousAppPid !== null) {
      // The selector is non-activating, so leave the previous app frontmost.
      // Reclaim only the Dock activation policy if AppKit demotes us.
      scheduleDockReclaim();
      log.debug("video-record left previous app frontmost", { previousAppPid });
    }

    const sourceApp = resolveSelectionSourceApp(
      selection.rect,
      selection.snappedWindowId,
      cachedSnapshot
    );
    const subject: RecordingSubject =
      selection.snappedWindowId !== undefined
        ? {
            kind: "window",
            windowId: selection.snappedWindowId,
            rect: selection.rect,
            displayId: selection.displayId,
            appName: sourceApp?.appName ?? null,
            appBundleId: sourceApp?.bundleId ?? null
          }
        : {
            kind: "region",
            rect: selection.rect,
            displayId: selection.displayId
          };

    const result = await bus.dispatch(
      "recording:start",
      {
        subject,
        capabilities: {
          systemAudio: settings.includeSystemAudio,
          microphone: settings.includeMicrophone
        },
        captureCursor: selection.captureCursor ?? settings.videoCaptureCursor,
        countdownSeconds: 3
      },
      { principal: "ipc" }
    );

    if (!result.ok && result.error.code !== "cancelled") {
      log.warn("recording:start failed", {
        code: result.error.code,
        message: result.error.message
      });
      try {
        if (Notification.isSupported()) {
          new Notification({
            title: "Recording failed",
            body: result.error.message
          }).show();
        }
      } catch {
        // Notification support is best-effort.
      }
    }
      return result;
    }
  });
}

function pickFocusTargetForRecording(overlapping: BrowserWindow[]): BrowserWindow {
  const library = findMainLibraryWindow();
  if (library !== null && overlapping.includes(library)) {
    return library;
  }
  return overlapping[0]!;
}
