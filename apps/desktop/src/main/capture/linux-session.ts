// Which Linux display server is this, and can the region selector work on it?
//
// The selector is built on three capabilities that X11 grants a client
// and Wayland does not:
//
//   1. Positioning its own toplevel windows. `createSelectorWindow`
//      pre-warms one window per display, constructed at `display.bounds`,
//      and its header states the design depends on "a window-local coord
//      space that matches display logical px 1:1". A Wayland client
//      cannot place a toplevel at all — the compositor decides.
//   2. Reliable always-on-top. `setAlwaysOnTop(true, "screen-saver")` maps
//      to nothing a regular Wayland client can ask for; there is no
//      layer-shell in Chromium's Wayland backend.
//   3. The global pointer position. `pickRegion` calls
//      `screen.getCursorScreenPoint()` to choose which display to show the
//      selector on. Wayland has no protocol to query the pointer outside
//      the client's own surfaces.
//
// And the grab itself changes hands. Chromium routes screen capture on a
// Wayland session through xdg-desktop-portal / PipeWire — it decides this
// from the same environment variables read below, so the routing applies
// whether Electron is running on the Wayland ozone backend or as an
// XWayland X11 client. The portal shows the user a permission prompt and
// its own source picker, and hands back whatever they chose. PwrSnap is
// not told which display that was (`display_id` comes back empty), which
// is what `grab-geometry.ts` exists to catch.
//
// So even a portal grab that happened to depict the right display would
// not give the selector's model: freeze the screen instantly, drag against
// the frozen pixels. It gives a prompt, a picker, and then some pixels.
//
// `capture:fullScreen` and `capture:allScreens` remain usable on Wayland —
// they have no overlay and no rect arithmetic, so the portal's own picker
// IS the source selection and the editor's crop tool is the region
// selection. That is what the refusal points users at.
//
// Anything that is not positively Wayland is left alone: an unrecognised
// environment keeps today's behavior rather than losing region capture to
// a detection miss. A genuine Wayland session that slips through still
// hits the `grab-geometry.ts` check and fails legibly instead of
// producing a misaligned selector.

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

export const WAYLAND_SELECTOR_MESSAGE =
  "Drag-to-select capture is not available on a Wayland session. Wayland does not let " +
  "an app place its own selection overlay on the screen, and screen capture is handled " +
  "by the desktop portal — which asks you to pick a source and does not tell PwrSnap " +
  "which display it gave back. Use Full Screen capture and crop in the editor, or log " +
  "in to an Xorg (X11) session, where drag-to-select works.";
