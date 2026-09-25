// Which Linux display server is this, and can the region selector work on it?
//
// What the selector needs, and what a Wayland session actually gives it —
// MEASURED on Ubuntu 24 / GNOME with the probe named at the bottom of this
// comment, because the obvious guesses were not all right:
//
//   1. The global pointer position — CONFIRMED UNAVAILABLE.
//      `screen.getCursorScreenPoint()` returns 0,0 no matter where the
//      mouse is. `pickRegion` routes off it to choose which display to
//      show the selector on, and hands it to the renderer to place the
//      opening crosshair. Wayland has no protocol to query the pointer
//      outside a client's own surfaces, so this is not a bug anyone can
//      fix here.
//   2. Placing its own toplevel at `display.bounds` — NOT available, and
//      not observable either. On a Wayland session Electron 41 resolves to
//      a NATIVE Wayland client by default, even with DISPLAY (XWayland)
//      set — measured on mutter 46 and sway 1.9 via the resolved
//      `--ozone-platform` switch. A native client cannot place its toplevel,
//      and `getBounds()`, `getContentBounds()` and the renderer's `screenX/Y`
//      all echo the request: on mutter 46 with a 32px top / 67px left strut
//      they read 0,0 for a window whose pixels were at 67,32, because mutter
//      moves a monitor-sized toplevel into the work area. An earlier version
//      of this comment read those echoes as "position honoured exactly".
//   3. Owning the screen at all — a bare always-on-top window does NOT,
//      fullscreen DOES. The Ubuntu probe measured 32 rows and 67 columns of
//      foreign pixels over a bare opaque test field, and 0 / 0 under
//      `setFullScreen(true)` — whether mutter moved the window or chrome
//      covered it, fullscreen fixes both. That gap was the whole Ubuntu
//      misalignment; see `enterMenuBarOverlayMode`, and `createSelectorWindow`
//      for why the Linux selector must also be resizable (X11 mutter drops a
//      fullscreen request from a window that is not).
//
// And the grab itself changes hands. Chromium routes screen capture on a
// Wayland session through xdg-desktop-portal / PipeWire — it decides this
// from the same environment variables read below, so the routing applies
// whether Electron is running on the Wayland ozone backend or as an
// XWayland X11 client. The portal shows the user a permission prompt and
// its own source picker, and hands back whatever they chose; `display_id`
// comes back empty, so PwrSnap is never told which display that was. That
// is what `grab-geometry.ts` exists to catch — though on a single-display
// machine the shape check cannot separate a right answer from a wrong one,
// so it is a backstop here, not the guarantee.
//
// Measured cost of that round trip: ~3 SECONDS per capture, a permission
// prompt and a picker — all before the selector appears, because the
// snapshot is taken first. That is a cost, not a defect, and on a single
// display it is paid: the grab measured pixel-exact against the display.
//
// `capture:fullScreen` and `capture:allScreens` remain usable on Wayland —
// they have no overlay and no rect arithmetic, so the portal's own picker
// IS the source selection and the editor's crop tool is the region
// selection. That is what the refusal points users at — and, from the
// notice's "Capture Full Screen" button, what it actually runs. See
// wayland-refusal-notice.ts.
//
// Anything that is not positively Wayland is left alone: an unrecognised
// environment keeps today's behavior rather than losing region capture to
// a detection miss.
//
// Re-measure before changing any of this:
// `pnpm --filter @pwrsnap/desktop probe:linux-capture`. Neither CI job can
// — the Docker/xvfb harness has no portal and no window manager, and macOS
// never runs this code.

export type LinuxSessionType = "wayland" | "x11" | "unknown";

/** Not-a-Linux-session. Kept distinct from "unknown" so callers on macOS /
 *  Windows read as "question does not apply" rather than "could not tell". */
export type SessionVerdict = LinuxSessionType | "not-linux";

/**
 * Classify the session from the environment, the same signal Chromium
 * itself uses to decide whether to route screen capture through the
 * portal (`base::nix::GetSessionType`). Pure — `env` and `platform` are
 * injected so this is testable from any CI host.
 */
export function linuxSessionType(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): SessionVerdict {
  if (platform !== "linux") return "not-linux";
  const declared = (env.XDG_SESSION_TYPE ?? "").trim().toLowerCase();
  if (declared === "wayland") return "wayland";
  // WAYLAND_DISPLAY is set by the compositor for every client in the
  // session, including XWayland ones, and survives a missing or stale
  // XDG_SESSION_TYPE. Checked second so an explicit "x11" declaration
  // does not lose to a leftover variable — but only when DISPLAY backs
  // that declaration up.
  const waylandDisplay = (env.WAYLAND_DISPLAY ?? "").trim();
  if (declared === "x11") {
    return (env.DISPLAY ?? "").trim() === "" && waylandDisplay !== "" ? "wayland" : "x11";
  }
  if (waylandDisplay !== "") return "wayland";
  if ((env.DISPLAY ?? "").trim() !== "") return "x11";
  return "unknown";
}

/**
 * True only when the region-selector overlay is known not to work here —
 * which is now a MUCH narrower set than this function once returned.
 *
 * It used to refuse every Wayland session, as a stopgap while the Ubuntu
 * misalignment was unexplained. It is explained: the overlay was never
 * entering fullscreen on Linux, so it did not own the screen — the shell's
 * top bar and dock ended up beside the snapshot's copy of them (see
 * `enterMenuBarOverlayMode`). Fullscreen makes placement moot rather than
 * fixing it: the output is the window, so there is nothing left to place,
 * and the fullscreen overlay and the grab were both measured pixel-exact
 * against the display.
 *
 * What is left is the dead pointer, and it is only load-bearing for ONE
 * decision: which display to open the selector on. `getCursorScreenPoint()`
 * returns 0,0 wherever the mouse is, so with more than one display
 * `pickRegion` reliably picks the wrong one. With a single display there is
 * nothing to get wrong — the opening crosshair starts in the corner and
 * corrects on the first mouse move, which is cosmetic.
 *
 * Do not lift this by fixing only the pointer. With more than one display
 * the portal hands back whichever monitor the user picked, with no
 * `display_id`, and two monitors of the same shape pass `grab-geometry.ts`
 * — so a selector opened on the right display could still paint the other
 * one's pixels. That half is reasoned from the portal's documented
 * behavior, not measured: no multi-display Wayland machine has run the
 * probe yet.
 *
 * So: refuse Wayland + multi-display, and nothing else.
 */
export function regionSelectorUnsupported(
  displayCount: number,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): boolean {
  return linuxSessionType(env, platform) === "wayland" && displayCount > 1;
}

/** Error code carried on the refusal, and the text the user is shown. */
export const WAYLAND_SELECTOR_ERROR_CODE = "wayland_selector_unsupported";

// Only measured facts belong in here. Two earlier drafts did not manage it:
// one blamed Wayland for not letting an app place its selection overlay —
// true of a native Wayland client, but not why the selector failed, since
// fullscreen does not need placing — and one refused drag-to-select on
// Wayland outright, which was a symptom of our own missing fullscreen call
// and not of Wayland at all. The Xorg advice at the end holds only because
// the Linux selector is built resizable: without that, mutter as an X11 WM
// drops the fullscreen request and the selector is squeezed into the work
// area there too (see `createSelectorWindow`).
export const WAYLAND_SELECTOR_MESSAGE =
  "Drag-to-select capture is not available on a Wayland session with more than one " +
  "display. Wayland does not let PwrSnap read the pointer position, so it cannot tell " +
  "which display to open the selector on. Use Full Screen capture — the desktop " +
  "portal's own picker lets you choose the display — and crop in the editor, or log in " +
  "to an Xorg (X11) session, where drag-to-select works on every display.";
