// Can this process decide where its own windows land?
//
// On macOS and Windows the answer is always yes, and every popover in the app
// is built on that assumption: the tray popover anchors to `tray.getBounds()`,
// the float-over anchors to the bottom-right of the cursor's display, and the
// float-over's pseudo-hide parks the window 20,000 px off-screen.
//
// Under Wayland the answer is no. `BrowserWindow.setPosition` is documented
// "Not supported on Wayland (Linux)" — a Wayland client cannot place its own
// toplevel, by protocol design; only the compositor can. `getPosition` /
// `getBounds` are documented to return zeros for the same reason.
//
// ⚠️  THE READBACK LIES, so do not write a capability probe out of one.
// Measured on Electron 41.10.7 against a headless weston and against xvfb,
// `setPosition(400, 300)` followed by `getPosition()` returns `[400, 300]` on
// BOTH backends, and `setContentSize` / `setBounds` echo back the same way.
// Those getters read Chromium's own cached widget bounds, which are updated
// whether or not the compositor honoured the request. The two runs were
// byte-identical across every geometry call — which is exactly why this module
// asks the environment instead of asking the window. GNOME's own window manager
// is no kinder: on mutter 46, with pixels read back through its ScreenCast API,
// a window mutter had moved into the work area at 67,32 still read 0,0 from
// `getBounds()`, `getContentBounds()` and the renderer's `screenX/Y` alike.
//
// Measured, same runs, and the reason the answer cannot be "check the session
// type and move on":
//
//   • `setOpacity` is a no-op on ALL Linux (`@platform win32,darwin`) —
//     `getOpacity()` still reports 1 after `setOpacity(0)`, under X11 as well
//     as Wayland. Anything built on an opacity park is broken on Linux
//     regardless of what this module reports. See float-over.ts.
//   • `hide()` / `showInactive()` work on both backends.
//   • `tray.getBounds()` is `{0, 0, 0, 0}` on both backends.
//
// Reference: docs/linux-tray-support.md §"Wayland".

import { app } from "electron";
import { getMainLogger } from "./log";

const log = getMainLogger("pwrsnap:window-placement");

/** Which Ozone backend Chromium is actually driving. */
export type LinuxWindowBackend = "wayland" | "x11";

/**
 * The Chromium command-line switch that records the RESOLVED Ozone backend.
 *
 * Electron writes this switch back into its own command line during startup
 * even when the user passed neither it nor `ELECTRON_OZONE_PLATFORM_HINT`, so
 * reading it is how a running process learns which backend it got. Measured on
 * 41.10.7: a Wayland session with no hint and no switch reports `wayland`, and
 * an X11 session with no hint and no switch reports `x11`.
 */
const OZONE_PLATFORM_SWITCH = "ozone-platform";

/**
 * Decide the backend from the resolved switch, falling back to the
 * environment.
 *
 * Pure so every interesting combination is testable from a macOS CI host.
 *
 * The switch is preferred because it reports what Chromium CHOSE, not what the
 * session offers — and those differ in the case that matters most:
 * `XDG_SESSION_TYPE=wayland` with Electron running as an XWayland client is an
 * X11 process that CAN position its windows. Reading the session type alone
 * would wrongly disable placement for it.
 *
 * ⚠️  Measured on Electron 41.10.7: on a Wayland session that ALSO has an X
 * server available (`DISPLAY` set — i.e. XWayland present, which is the Ubuntu
 * GNOME default), Electron resolves to `wayland`, not to X11. So the common
 * case really is a native Wayland client, and `pnpm dev` on Ubuntu GNOME
 * cannot position its own windows.
 *
 * The env fallback exists only for the day Electron stops recording the
 * switch; it mirrors Chromium's own selection (an explicit hint wins, then
 * "is there a Wayland display to connect to").
 */
export function linuxWindowBackend(
  env: NodeJS.ProcessEnv,
  ozonePlatformSwitch: string | null
): LinuxWindowBackend {
  const resolved = (ozonePlatformSwitch ?? "").trim().toLowerCase();
  if (resolved === "wayland") return "wayland";
  if (resolved === "x11") return "x11";

  const hint = (env.ELECTRON_OZONE_PLATFORM_HINT ?? "").trim().toLowerCase();
  if (hint === "wayland") return "wayland";
  if (hint === "x11") return "x11";

  // `auto` and "unset" both land here: Chromium takes Wayland when there is a
  // Wayland display to take.
  const waylandDisplay = (env.WAYLAND_DISPLAY ?? "").trim();
  if (waylandDisplay.length > 0) return "wayland";
  return (env.XDG_SESSION_TYPE ?? "").trim().toLowerCase() === "wayland"
    ? "wayland"
    : "x11";
}

/**
 * Whether `BrowserWindow.setPosition` / `setBounds` can actually move a window
 * on this platform.
 *
 * Pure, and takes everything it reads, so a test can ask for any platform from
 * any host. `false` ONLY for Linux-on-Wayland; an unknown Unix defaults to the
 * X11 answer, matching `shortcutPlatformFromString`'s "unknown means Linux"
 * fallback and erring toward attempting placement rather than abandoning it.
 */
export function canPositionOwnWindows(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  ozonePlatformSwitch: string | null
): boolean {
  if (platform !== "linux") return true;
  return linuxWindowBackend(env, ozonePlatformSwitch) === "x11";
}

/** Memoized so the "compositor owns placement" line is logged once per run. */
let loggedBackend = false;

/**
 * Production entry point: ask the live process whether it can place its own
 * windows.
 *
 * Reads the resolved Ozone switch off `app.commandLine`. Guarded because
 * `getSwitchValue` is only meaningful once Electron has parsed its command
 * line; before that it returns `""` and the environment fallback answers.
 */
export function windowPlacementIsOurs(): boolean {
  let ozoneSwitch: string | null = null;
  try {
    ozoneSwitch = app.commandLine.getSwitchValue(OZONE_PLATFORM_SWITCH);
  } catch {
    // `app` not ready, or a build without the switch — fall back to the env.
    ozoneSwitch = null;
  }
  const ours = canPositionOwnWindows(process.platform, process.env, ozoneSwitch);
  // Only when placement really is the compositor's: on X11 the line below
  // would claim a limitation the session does not have.
  if (process.platform === "linux" && !ours && !loggedBackend) {
    loggedBackend = true;
    // Says the thing a user report will otherwise be missing. A popover that
    // opens in the middle of the screen looks like a PwrSnap bug; this line is
    // what identifies it as the compositor's call.
    log.info("wayland session: the compositor owns window placement", {
      ozoneSwitch,
      sessionType: process.env.XDG_SESSION_TYPE ?? null,
      waylandDisplay: process.env.WAYLAND_DISPLAY ?? null,
      consequence:
        "setPosition is inert; popovers land where the compositor puts them"
    });
  }
  return ours;
}

/** Test-only: forget that the backend line was already logged. */
export function resetWindowPlacementLogForTests(): void {
  loggedBackend = false;
}
