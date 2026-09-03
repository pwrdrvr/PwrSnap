// The post-commit half of an interactive recording: everything between
// "the user committed a selection" and "the recorder is running".
//
// Extracted from index.ts's `runInteractiveRecord` when the Snap-vs-
// Record chooser (issue #75) gave the flow a SECOND entrance. Quick
// Capture's Record must reuse the selection the user already made —
// re-opening a picker to ask the same question again would be absurd —
// so the dedicated Video Capture hotkey and the chooser now share
// exactly this continuation and differ only in how they got a
// `SelectorResult`.
//
// The module owns selector teardown and snapshot release. Both entry
// points hand ownership over at the call and must not release the
// snapshot themselves.

import { app, Notification, type BrowserWindow } from "electron";
import { RECORDING_MEDIA_DEFAULTS } from "@pwrsnap/shared";
import type { RecordingSubject, Settings } from "@pwrsnap/shared";
import { bus } from "../command-bus";
import { setFloatOverState } from "../float-over";
import { getMainLogger } from "../log";
import { appWindowsOverlappingGlobalRect } from "../capture/rect-overlap";
import {
  getLastWindowListSnapshot,
  hideSelector,
  type SelectorResult,
} from "../capture/region-selector";
import { releaseSnapshot } from "../capture/screen-snapshot";
import {
  resolveSelectionSourceApp,
  shouldConsiderRaisingOurWindows,
} from "../capture/source-app";
import { activateApp, selfPidSet } from "../capture/window-list";
import {
  findMainLibraryWindow,
  reclaimDockIconIfLibraryAlive,
  scheduleDockReclaim,
} from "../window";
import { getRecordingState } from "./recording-state";

/** A selector result the user actually committed. */
export type CommittedSelection = Extract<SelectorResult, { ok: true }>;

/** The slice of Settings a recording handoff needs. Narrower than
 *  `Settings["recording"]` so a caller whose settings read failed can
 *  supply a fallback without inventing seven unrelated fields. */
export type RecordingDefaults = Pick<
  Settings["recording"],
  "includeSystemAudio" | "includeMicrophone" | "videoCaptureCursor"
>;

/** Used only when the settings read failed outright — which is
 *  reachable: `ensureServices()` calls `app.getPath("userData")` before
 *  `read()` is even entered.
 *
 *  This IS `defaultSettings().recording`'s source, not a copy of it —
 *  both read `RECORDING_MEDIA_DEFAULTS` from shared. The hand-written
 *  copy that used to live here claimed to "mirror defaultSettings()"
 *  and nothing made that true; the one test that named this constant
 *  asserted a mocked module against the same literal the mock
 *  installed, so flipping the real `includeMicrophone` to `true` —
 *  silently hot-miking a user whose settings file hiccuped — passed
 *  9/9. Shared is the right home because the settings service imports
 *  `@pwrdrvr/agent-transport`, which has no business in the import
 *  graph of a capture. */
export const FALLBACK_RECORDING_DEFAULTS: RecordingDefaults = RECORDING_MEDIA_DEFAULTS;

/**
 * Choose which of the overlapping PwrSnap windows to give keyboard
 * focus when we raise them for a recording. Prefer the Library (the
 * primary user-facing window in this app); fall back to the first
 * entry in the overlap set. `BrowserWindow.getAllWindows()` ordering
 * isn't documented as z-order, so a stable tie-breaker beats letting
 * implementation order decide.
 *
 * Caller invariant: `overlapping` is the result of
 * `appWindowsOverlappingGlobalRect` BEFORE the recording HUD has been
 * created. The HUD is only constructed when the state machine enters
 * preflight, which happens *after* this call (inside the awaited
 * `bus.dispatch("recording:start", ...)`), so the HUD can't appear
 * here and we don't need to filter it out. If a future caller invokes
 * this from a code path where the HUD is live, pass `excludeWindow`
 * to `appWindowsOverlappingGlobalRect` first.
 */
function pickFocusTargetForRecording(
  overlapping: BrowserWindow[],
): BrowserWindow {
  const library = findMainLibraryWindow();
  if (library !== null && overlapping.includes(library)) {
    return library;
  }
  return overlapping[0]!;
}

/**
 * Tear the selector down and start recording what was committed.
 *
 * `recording` is the caller's already-read `settings.recording` slice —
 * both entry points read settings BEFORE opening the picker (to seed
 * the cursor toggle), so re-reading here would be a second uncached
 * disk parse for nothing.
 */
export async function startRecordingFromSelection(
  selection: CommittedSelection,
  recording: RecordingDefaults,
): Promise<void> {
  const log = getMainLogger("pwrsnap:shortcut");
  const { screenSnapshotId, previousAppPid } = selection;
  // Teardown is unconditional. With two entry points — one of them
  // fire-and-forget — a throw anywhere below must not be able to strand
  // a screen-saver-level overlay on top of the user's desktop with no
  // way back. Both calls are idempotent.
  let tornDown = false;
  const tearDown = (): void => {
    if (tornDown) return;
    tornDown = true;
    hideSelector();
    void releaseSnapshot(screenSnapshotId);
    // Unconditional, matching the snap path's `tearDownSelector`. The
    // two reclaims further down are both branch-local: one needs
    // overlapping windows, the other a previous app to fall back to —
    // so a recording framed away from every PwrSnap window while
    // PwrSnap itself was frontmost (`previousAppPid === null`) reached
    // neither, and nothing re-asserted the Dock icon after AppKit's
    // async Accessory demotion. Guarded internally, so it no-ops once
    // the Dock is back and the later calls stay harmless.
    scheduleDockReclaim();
  };
  try {
    // Park the idle float-over BEFORE the selector comes down.
    //
    // `pickRegion` pre-shows an empty toast UNDERNEATH the selector so a
    // still capture's reveal is instant. A recording never populates it,
    // so without this the selector hide UNCOVERS an empty, hit-testable
    // popover at floating level — which then sits there through the
    // countdown and gets composited into the recording whenever the
    // picked region reaches the bottom-right of the display. The snap
    // path has always parked it on cancel; the record path parked it
    // nowhere.
    setFloatOverState({ kind: "cancel" });
    // Compositor flush — the park must reach the window server before we
    // lower the selector, or there is a one-frame window where the toast
    // is visible. Same 50 ms the cancel paths use.
    await new Promise((resolve) => setTimeout(resolve, 50));
    // CRITICAL: the selector is at screen-saver level and would
    // otherwise be in the captured pixels for the entire countdown +
    // first frames of the recording. Drop it BEFORE `recording:start`
    // (which awaits the 3s countdown before the recorder spawns) so
    // the captured pixels are the user's actual workspace, not our
    // orange selector frame. The countdown HUD lives in its own
    // floating panel at top-center; the in-area overlay (when added)
    // is also outside the selector's lifecycle.
    tearDown();

    // Focus / z-order policy. Three cases:
    //
    //   • Snap to one of OUR windows, OR free-region drag whose rect
    //     overlaps one of ours → raise our window(s). The user clearly
    //     wants PwrSnap visible in the recording.
    //   • Snap to ANOTHER app's window → leave our windows alone and run
    //     activateApp(previousAppPid). Raising the Library here would
    //     obscure the very window the user picked (e.g. Library sitting
    //     partially behind Claude on screen — overlap detection would
    //     match, but the recording subject is Claude, not us).
    //   • Snap to one of ours but the rect doesn't actually intersect
    //     any visible BrowserWindow (e.g. that window just closed) →
    //     fall through to the previous-app activation; nothing to raise.
    const cachedSnapshot = getLastWindowListSnapshot();
    const shouldRaise = shouldConsiderRaisingOurWindows(
      selection.snappedWindowId,
      cachedSnapshot,
      selfPidSet(),
    );
    // `SelectorResult.rect` is GLOBAL — region-selector translates
    // window-local → global on commit, so capture-handlers and the
    // snapshot crop see one consistent space — so this takes the
    // global entry point, which hit-tests against `getBounds()`
    // directly and has no display origin to apply.
    //
    // Its display-local sibling `appWindowsOverlappingRect` re-adds
    // `display.bounds` itself, so handing IT the global rect applies
    // the origin twice: a no-op on the primary display, and a
    // full-origin displacement anywhere else. Measured on a display at
    // {x:1496,y:-473}, a selection squarely inside the Library tested
    // as {x:3192,y:-846} and matched zero windows, so the raise branch
    // below never ran. `shouldConsiderRaisingOurWindows` is true for
    // every free-hand drag, so this is the common path.
    const overlapping = shouldRaise
      ? appWindowsOverlappingGlobalRect(selection.rect)
      : [];
    // Debug-only — useful when triaging "Library hid / dove under"
    // reports. Turn on with `electron-log` debug; default level keeps
    // this out of the dev terminal on every video recording.
    log.debug("video-record post-commit focus policy", {
      snappedWindowId: selection.snappedWindowId ?? null,
      previousAppPid,
      shouldRaise,
      overlappingCount: overlapping.length,
      overlappingTitles: overlapping.map((w) => w.getTitle()),
      dockVisibleBefore: app.dock?.isVisible() ?? null,
      libraryAlive: findMainLibraryWindow() !== null,
    });
    if (overlapping.length > 0) {
      // Two-step "really bring PwrSnap forward" because Electron's
      // app.focus() + window.focus() are unreliable when the app's
      // activation policy has drifted to Accessory (NSUIElement) — a
      // previous activateApp() side-effect.
      //
      //   1. `reclaimDockIconIfLibraryAlive()` → calls
      //      `app.dock.show()` which forcibly re-asserts Regular
      //      activation policy. Without this the next focus() is a
      //      no-op while Accessory.
      //   2. `activateApp(process.pid)` → goes through the same native
      //      NSRunningApplication.activate helper we use to bring
      //      OTHER apps forward, but pointed at our own pid. This
      //      bypasses Electron entirely and uses the macOS API
      //      directly. More reliable than `app.focus({ steal: true })`
      //      which has had spotty behavior with our floating panels
      //      (focus-sink + HUD) in the window list.
      reclaimDockIconIfLibraryAlive();
      await activateApp(process.pid);
      for (const win of overlapping) {
        if (win.isMinimized()) win.restore();
        if (!win.isVisible()) win.show();
        win.moveTop();
      }
      pickFocusTargetForRecording(overlapping).focus();
      log.debug("video-record raised our windows", {
        ownPid: process.pid,
        dockVisibleAfter: app.dock?.isVisible() ?? null,
      });
    } else if (previousAppPid !== null) {
      // No activateApp(previousAppPid): the non-activating selector never
      // deactivated the previously-frontmost app, so it stays frontmost as
      // the selector hides. Dropping the re-activation removes the AppKit
      // Accessory-demotion (Dock flash + Library hide). Mirrors the image
      // commit path; the raise-our-windows branch above is the deliberate
      // exception — there we DO want PwrSnap forward to record our window.
      // Spread reclaim to catch the async demotion (see cancel branch).
      scheduleDockReclaim();
      log.debug("video-record left previous app frontmost", { previousAppPid });
    }
    // Honor the user's persisted audio defaults; the in-context
    // recording dialog (a later enhancement) can override these. The
    // caller read these once, before opening the picker.
    const capabilities = {
      systemAudio: recording.includeSystemAudio,
      microphone: recording.includeMicrophone,
    };
    // Source-app attribution mirrors the image-capture path
    // (capture-handlers.ts) via the shared `resolveSelectionSourceApp`
    // helper: snap-target id first, rect-center hit test as fallback,
    // null if neither resolves. This runs whether the user held ⇧ at
    // commit time or just clicked — both shapes attribute the same app
    // for the same selection. We also reuse the cached window-list
    // snapshot rather than re-running `listWindows()`, so the lookup
    // matches the list the user actually picked against (no drift if
    // a window moved/closed in the ~50ms between hideSelector + here).
    const sourceApp = resolveSelectionSourceApp(
      selection.rect,
      selection.snappedWindowId,
      getLastWindowListSnapshot(),
    );
    // A snapshot windowId in the selection means the user pointed at a
    // specific window (with or without ⇧). Persist that as a `window`
    // subject so the Library row shows the source app even when the
    // user didn't opt into the full-window capture path. Region kind
    // is reserved for free-hand drags where no window was snapped.
    let subject: RecordingSubject;
    if (selection.snappedWindowId !== undefined) {
      subject = {
        kind: "window",
        windowId: selection.snappedWindowId,
        rect: selection.rect,
        displayId: selection.displayId,
        appName: sourceApp?.appName ?? null,
        appBundleId: sourceApp?.bundleId ?? null,
      };
    } else {
      subject = {
        kind: "region",
        rect: selection.rect,
        displayId: selection.displayId,
      };
    }
    const result = await bus.dispatch(
      "recording:start",
      {
        subject,
        capabilities,
        // The selector's `C` toggle wins; fall back to the persisted
        // default if the renderer didn't send a value.
        captureCursor: selection.captureCursor ?? recording.videoCaptureCursor,
        countdownSeconds: 3,
      },
      { principal: "ipc" },
    );
    if (!result.ok && result.error.code !== "cancelled") {
      log.warn("recording:start failed", {
        code: result.error.code,
        message: result.error.message,
      });
      if (getRecordingState().phase === "failed") return;
      try {
        if (Notification.isSupported()) {
          new Notification({
            title: "Recording failed",
            body: result.error.message,
          }).show();
        }
      } catch {
        /* notification support is best-effort */
      }
    }
  } finally {
    tearDown();
  }
}
