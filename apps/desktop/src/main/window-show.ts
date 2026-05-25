// Linux-safe `window.show()` orchestration.
//
// Problem: PwrSnap's window-create pattern is `new BrowserWindow({show: false})`
// → `window.once("ready-to-show", () => window.show())`. That's the
// Electron documentation's recommended shape and it works reliably on
// macOS and Windows. On Linux (Wayland, X11 under GNOME, VMware
// guests, several other WMs) the `ready-to-show` event can fire late
// — or never — for reasons that aren't deterministic from the app
// side: GTK theming async ready, compositor handshake races, the
// renderer's first paint not lining up with what Chromium considers
// "ready", etc. The user-visible failure is brutally simple: the app
// starts, no window appears, the dock-icon never lights up.
//
// PwrAgnt hit the same wall and solved it with a three-layer fallback
// (see `apps/desktop/src/main/auxiliary-window-chrome.ts` in PwrAgnt:
// `showAuxiliaryWindowWhenReady`). This module is the PwrSnap port:
// same algorithm, exposed under a name that reflects what it does
// rather than where it came from.
//
// Layered fallback:
//
//   1. `ready-to-show` — the macOS/Windows happy path. Fires before
//      the first paint; window shows with no flash of unstyled content.
//   2. `did-finish-load` + 100 ms — Linux fallback A. `did-finish-load`
//      is reliable on every platform; the 100 ms buffer lets the
//      first frame paint so the user doesn't see a flash of the
//      backgroundColor.
//   3. 1000 ms timeout from registration — Linux fallback B. The hard
//      backstop for the case where BOTH `ready-to-show` AND
//      `did-finish-load` fire late. If we hit this, the window may
//      flash unstyled briefly, but it's better than never appearing.
//
// Whichever fallback wins fires the show + the optional `onShow`
// callback ONCE. The other timers are cleared. If the window is
// destroyed before any fallback fires, all timers are cleared in the
// `closed` handler and the show is silently skipped.
//
// Per-platform notes:
//   • macOS: `ready-to-show` always wins. Fallbacks never fire.
//   • Windows: same as macOS in practice.
//   • Linux: depends on WM/compositor. Anecdotally `ready-to-show`
//     wins ~70% of the time on GNOME Wayland, ~95% on X11; fallback A
//     covers the rest with `did-finish-load` reliably firing. Fallback
//     B is the never-seen-this-fire-but-good-to-have backstop.

import type { BrowserWindow } from "electron";
import { getMainLogger } from "./log";

const log = getMainLogger("pwrsnap:window-show");

const DID_FINISH_LOAD_DELAY_MS = 100;
const HARD_FALLBACK_DELAY_MS = 1000;

/**
 * Show `window` once any of three signals fires:
 *  1. `ready-to-show` (macOS happy path; usually first)
 *  2. `did-finish-load` + `DID_FINISH_LOAD_DELAY_MS` (Linux fallback A)
 *  3. `HARD_FALLBACK_DELAY_MS` after registration (Linux fallback B)
 *
 * The first signal to fire wins; the others are cleaned up. `onShow`,
 * if provided, runs ONCE on the winning signal — use it for
 * window-specific side effects (e.g. claiming the dock icon, focusing
 * the window, logging) that should land at the same moment the user
 * sees the window appear.
 *
 * Safe to call once per window. Don't double-register; if you need
 * the show to repeat (e.g. you hid the window and want to re-show on
 * the next load), call `window.show()` directly.
 */
export function showWindowWhenReady(
  window: BrowserWindow,
  options: {
    /** Short label for log lines so a developer can tell which window's
     *  fallbacks fired (e.g. "main", "settings", "edit/<captureId>"). */
    label: string;
    /** Optional one-shot callback for show-time side effects. Fires on
     *  whichever fallback wins, never more than once. Receives nothing
     *  — close over the window in the caller if you need it. */
    onShow?: () => void;
  }
): void {
  const { label, onShow } = options;
  let shown = false;
  let didFinishLoadTimer: ReturnType<typeof setTimeout> | undefined;
  let hardFallbackTimer: ReturnType<typeof setTimeout> | undefined;

  const clearTimers = (): void => {
    if (didFinishLoadTimer !== undefined) {
      clearTimeout(didFinishLoadTimer);
      didFinishLoadTimer = undefined;
    }
    if (hardFallbackTimer !== undefined) {
      clearTimeout(hardFallbackTimer);
      hardFallbackTimer = undefined;
    }
  };

  const showOnce = (source: "ready-to-show" | "did-finish-load" | "hard-fallback"): void => {
    if (shown) return;
    shown = true;
    clearTimers();
    if (window.isDestroyed()) {
      log.info("window-show skipped — destroyed before any signal", { label, source });
      return;
    }
    log.info("window-show", { label, source, id: window.id });
    window.show();
    onShow?.();
  };

  window.once("ready-to-show", () => showOnce("ready-to-show"));

  // `did-finish-load` listener has to live on `webContents` (not the
  // BrowserWindow itself). The +100ms buffer lets the first frame
  // paint before show() so the user doesn't see backgroundColor flash.
  window.webContents.once("did-finish-load", () => {
    if (shown) return;
    didFinishLoadTimer = setTimeout(
      () => showOnce("did-finish-load"),
      DID_FINISH_LOAD_DELAY_MS
    );
  });

  hardFallbackTimer = setTimeout(() => showOnce("hard-fallback"), HARD_FALLBACK_DELAY_MS);

  // Clean up if the window closes before any signal fires (rare —
  // implies a load error or programmatic close in the first second of
  // the window's lifetime — but keeps the timer chain honest).
  window.once("closed", clearTimers);
}
