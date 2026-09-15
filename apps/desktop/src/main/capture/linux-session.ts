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

/** True only when the region-selector overlay is known not to work here. */
export function regionSelectorUnsupported(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): boolean {
  return linuxSessionType(env, platform) === "wayland";
}

/** Error code carried on the refusal, and the text the user is shown. */
export const WAYLAND_SELECTOR_ERROR_CODE = "wayland_selector_unsupported";

// Only measured facts belong in here. An earlier draft told users that
// "Wayland does not let an app place its own selection overlay on the
// screen", which the probe disproved — Electron runs as an XWayland
// client and the overlay lands exactly where it is put. See the header.
export const WAYLAND_SELECTOR_MESSAGE =
  "Drag-to-select capture is not available on a Wayland session. Screen capture there " +
  "goes through the desktop portal, which asks permission and makes you pick a source " +
  "for every capture, and PwrSnap cannot read the pointer position to follow your drag. " +
  "Use Full Screen capture and crop in the editor, or log in to an Xorg (X11) session, " +
  "where drag-to-select works.";
