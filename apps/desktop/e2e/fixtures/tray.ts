// Shared tray-popover harness for E2E specs.
//
// In E2E mode the bootstrap skips `installTray()` (no NSStatusItem in
// headless tests), so specs drive the popover through the
// `__PWRSNAP_TEST__` bridge instead of clicking a menubar icon. The
// bridge wires the same BrowserWindow + resize channel the production
// click handler does — only the icon is bypassed.
//
// Lives here rather than in a spec because more than one spec needs it
// (tray-sizing, tray-instant-dismiss) and the pieces below are exactly
// the ones that break together: the window-lookup marker, the bridge
// call shapes, and the blur-dismiss retry.

import type { LaunchedApp } from "./electron-app";

export type TrayState = {
  exists: boolean;
  visible: boolean;
  /** BrowserWindow opacity (0.0 – 1.0). On macOS the popover is parked
   *  at 0 before `hide()` so AppKit's NSPanel fade-out can't paint the
   *  popover into a screenshot — see `hideTrayWindowNow` in main/tray.ts.
   *  This is the only observable that separates "gone" from "still
   *  fading": `visible` reads false for the whole fade, because AppKit
   *  orders the window out when the fade STARTS. */
  opacity: number | null;
};

/** Read the tray popover's native window state in ONE round-trip.
 *  Reading `visible` and `opacity` together matters — a caller that
 *  takes two trips can have the popover blur-dismiss between them. */
export async function inspectTrayWindow(app: LaunchedApp): Promise<TrayState> {
  return await app.electronApp.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && w.webContents.getURL().includes("stage=tray")
    );
    if (win === undefined) return { exists: false, visible: false, opacity: null };
    return { exists: true, visible: win.isVisible(), opacity: win.getOpacity() };
  });
}

/**
 * Open the tray popover via the E2E bridge — and make sure it STAYS
 * open. The popover auto-dismisses on `blur` (120ms debounce in tray.ts
 * `wireBlurDismiss`) — that's real production behavior, and on a loaded
 * VM the teardown of the PREVIOUS spec's Electron app produces ambient
 * key-window churn that can blur the popover right after
 * `showInactive()`, silently hiding it before the assertions read it
 * (seen as a `visible === false` flake in the Tart-VM runs). Dismissal
 * isn't the subject of any spec that calls this, so re-show a few times
 * until visibility sticks.
 *
 * Returns the state read in the SAME round-trip that confirmed
 * visibility, so callers can assert on it without opening a fresh race.
 */
export async function showTray(app: LaunchedApp): Promise<TrayState> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await app.electronApp.evaluate(async () => {
      (
        globalThis as unknown as { __PWRSNAP_TEST__: { showTrayPopover: () => void } }
      ).__PWRSNAP_TEST__.showTrayPopover();
    });
    // Outwait the blur-dismiss debounce; if the popover survived it,
    // we're stably visible. 120ms debounce + scheduling headroom.
    await new Promise((r) => setTimeout(r, 250));
    const state = await inspectTrayWindow(app);
    if (state.visible) return state;
  }
  throw new Error("tray popover would not stay visible after 4 show attempts");
}

/** Dismiss the popover through the same entry point the capture flow
 *  uses (`hideTrayPopoverIfVisible`). Nothing re-shows it, so callers
 *  can read state afterwards without a retry. */
export async function hideTray(app: LaunchedApp): Promise<void> {
  await app.electronApp.evaluate(async () => {
    (
      globalThis as unknown as { __PWRSNAP_TEST__: { hideTrayPopover: () => void } }
    ).__PWRSNAP_TEST__.hideTrayPopover();
  });
}
