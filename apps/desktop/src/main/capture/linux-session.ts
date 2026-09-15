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
//   2. Placing its own toplevel at `display.bounds` — NOT the blanket
//      failure it looks like. Electron defaults to the X11 ozone backend,
//      so on a Wayland session it usually runs as an XWayland client, and
//      there position and size came back honoured EXACTLY (0,0
//      1496x938 requested and granted, renderer CSS px 1:1 with display
//      logical px). A Wayland-native client could not do this; an XWayland
//      one can. Do not repeat the claim that it cannot without measuring.
//   3. Reliable always-on-top — unmeasured. `setAlwaysOnTop(true,
//      "screen-saver")` maps to nothing a Wayland-native client can ask
//      for (no layer-shell in Chromium's Wayland backend); under XWayland
//      it is an ordinary X11 hint, which gnome-shell honours for normal
//      windows but not above its own panel.
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
// prompt and a picker. Even a portal grab that depicted exactly the right
// display would not give the selector's model — freeze the screen
// instantly, drag against the frozen pixels. It gives a prompt, a picker,
// and then some pixels.
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
 * entering fullscreen on Linux, so GNOME's top bar and dock stayed painted
 * over it (see `enterMenuBarOverlayMode`). Everything else the refusal was
 * justified by has been measured working — placement, size, a 1:1 renderer,
 * and a pixel-exact grab.
 *
 * What is left is the dead pointer, and it is only load-bearing for ONE
 * decision: which display to open the selector on. `getCursorScreenPoint()`
 * returns 0,0 wherever the mouse is, so with more than one display
 * `pickRegion` reliably picks the wrong one. With a single display there is
 * nothing to get wrong — the opening crosshair starts in the corner and
 * corrects on the first mouse move, which is cosmetic.
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
// one told users that "Wayland does not let an app place its own selection
// overlay on the screen" (the probe disproved it — Electron runs as an
// XWayland client and the overlay lands exactly where it is put), and one
// refused drag-to-select on Wayland outright, which was a symptom of our own
// missing fullscreen call and not of Wayland at all.
export const WAYLAND_SELECTOR_MESSAGE =
  "Drag-to-select capture is not available on a Wayland session with more than one " +
  "display. Wayland does not let PwrSnap read the pointer position, so it cannot tell " +
  "which display to open the selector on. Use Full Screen capture — the desktop " +
  "portal's own picker lets you choose the display — and crop in the editor, or log in " +
  "to an Xorg (X11) session, where drag-to-select works on every display.";
