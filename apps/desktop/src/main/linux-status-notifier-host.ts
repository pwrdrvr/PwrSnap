// Why "PwrSnap has no tray icon on Linux" is answerable from a log file.
//
// Electron's Linux tray is `StatusIconLinuxDbus`: it registers a
// freedesktop StatusNotifierItem on the session bus and hands the drawing
// to whatever process owns `org.kde.StatusNotifierWatcher`. If nothing owns
// that name there is NO host, PwrSnap's registration goes nowhere, and the
// app is indistinguishable from one whose tray code is broken — no error,
// no event, no callback. Electron surfaces nothing either way.
//
// That is the entire reason this module exists. It does not change what the
// tray does; it makes the failure legible, so the next report arrives
// already diagnosed instead of costing a round trip to a Linux box.
//
// What owns the watcher name in practice:
//   • KDE Plasma — the panel itself. Native, nothing to install.
//   • GNOME Shell — NOTHING by default. GNOME dropped the legacy XEmbed
//     tray in 3.26 and never shipped an SNI host, so an indicator needs the
//     "AppIndicator and KStatusNotifierItem Support" extension. Ubuntu
//     preinstalls and enables it (`ubuntu-appindicators@ubuntu.com`);
//     Debian / Fedora / vanilla GNOME do not.
//   • wlroots tiling setups (sway, Hyprland, Omarchy) — whatever bar is
//     running, and only if its tray module is enabled (waybar's `tray`).
//
// There is deliberately NO libayatana-appindicator3 dependency to check
// for. Electron stopped routing the tray through libappindicator in
// Electron 22 (electron/electron#36333) and speaks SNI over D-Bus itself,
// so the library's presence or absence says nothing about whether the tray
// will work. See docs/linux-tray-support.md.

import { spawn } from "node:child_process";
import { getMainLogger } from "./log";

const log = getMainLogger("pwrsnap:tray");

/** Bus name a StatusNotifierItem host must own for any tray icon to draw. */
const STATUS_NOTIFIER_WATCHER = "org.kde.StatusNotifierWatcher";

/**
 * Long enough for a loaded session bus, short enough that a hung `gdbus`
 * can't keep a child process around for the life of the app. The probe is
 * fire-and-forget, so exceeding this costs a `"unknown"` and nothing else.
 *
 * Not theoretical: `gdbus` with no reachable session bus does not always
 * exit — on a Mac with Homebrew's glib it sits there, which is how this
 * value got measured. Exported so a test can exercise the deadline without
 * waiting out the production one.
 */
export const STATUS_NOTIFIER_PROBE_TIMEOUT_MS = 2_000;

export type StatusNotifierHostState = "present" | "absent" | "unknown";

export type LinuxTrayEnvironment = {
  /** `XDG_CURRENT_DESKTOP`, verbatim, or `null`. Colon-delimited by spec. */
  desktop: string | null;
  /** `XDG_SESSION_TYPE` — `wayland`, `x11`, `tty`, … or `null`. */
  sessionType: string | null;
  /**
   * True when the session looks GNOME-based, which is the one case where a
   * missing host has a specific, actionable remedy (install the extension)
   * rather than "check your panel's tray module".
   */
  gnomeLike: boolean;
};

/**
 * Classify the session from the environment alone — no processes, no D-Bus.
 * Pure so the interesting combinations are testable without a Linux host.
 *
 * `XDG_CURRENT_DESKTOP` is a colon-separated priority list per the
 * freedesktop desktop-entry spec (`ubuntu:GNOME`, `pop:GNOME`,
 * `GNOME-Classic:GNOME`), so match per component rather than on the whole
 * string — and match case-insensitively, because the spec's own examples
 * disagree with what shells actually export.
 */
export function describeLinuxTrayEnvironment(
  env: NodeJS.ProcessEnv
): LinuxTrayEnvironment {
  const desktop = env.XDG_CURRENT_DESKTOP ?? null;
  const components = (desktop ?? "")
    .split(":")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
  return {
    desktop,
    sessionType: env.XDG_SESSION_TYPE ?? null,
    // `GNOME-Flashback` and `GNOME-Classic` are GNOME Shell sessions too,
    // and both need the extension, so prefix-match the component.
    gnomeLike: components.some((part) => part === "gnome" || part.startsWith("gnome-"))
  };
}

/**
 * Interpret a `NameHasOwner` reply. Split out from the spawn so the parsing
 * — which is the only part that can be wrong in an interesting way — is
 * testable.
 *
 * `gdbus` prints a GVariant tuple, so a boolean reply is the literal text
 * `(true,)` or `(false,)`. Anything else (non-zero exit, `gdbus` missing,
 * an unparseable line, a timeout) is `"unknown"`: the probe is a
 * diagnostic, and guessing `"absent"` from a broken probe would print a
 * confident, wrong remedy.
 */
export function interpretNameHasOwnerOutput(
  exitCode: number | null,
  stdout: string
): StatusNotifierHostState {
  if (exitCode !== 0) return "unknown";
  const text = stdout.trim();
  if (text.startsWith("(true")) return "present";
  if (text.startsWith("(false")) return "absent";
  return "unknown";
}

/**
 * Ask the session bus whether anything owns the watcher name.
 *
 * Shelling out to `gdbus` rather than adding a D-Bus client: Electron
 * exposes no D-Bus API, `gdbus` ships with glib2 — which Electron already
 * hard-requires for GTK — and asking the bus about a name needs no
 * subscription, no state, and no cleanup. A missing `gdbus` is `"unknown"`,
 * not an error.
 */
export function probeStatusNotifierHost(
  timeoutMs: number = STATUS_NOTIFIER_PROBE_TIMEOUT_MS
): Promise<StatusNotifierHostState> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (state: StatusNotifierHostState): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(state);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        "gdbus",
        [
          "call",
          "--session",
          "--dest",
          "org.freedesktop.DBus",
          "--object-path",
          "/org/freedesktop/DBus",
          "--method",
          "org.freedesktop.DBus.NameHasOwner",
          STATUS_NOTIFIER_WATCHER
        ],
        { stdio: ["ignore", "pipe", "ignore"] }
      );
    } catch {
      resolve("unknown");
      return;
    }

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish("unknown");
    }, timeoutMs);
    // A probe must never hold the process open past quit.
    timer.unref?.();

    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      // Bounded: a well-behaved reply is ~8 bytes, and this keeps a
      // misbehaving `gdbus` from growing a string without limit.
      if (stdout.length < 256) stdout += chunk;
    });
    // ENOENT (no `gdbus` on PATH) lands here, not in the try/catch above.
    child.on("error", () => {
      finish("unknown");
    });
    child.on("close", (code) => {
      finish(interpretNameHasOwnerOutput(code, stdout));
    });
  });
}

/**
 * The message a user with no tray icon needs, matched to their desktop.
 * Pure, so the wording is pinned by a test rather than eyeballed on a VM.
 *
 * Returns `null` when there is nothing useful to say — a host is present,
 * or the probe could not reach a verdict and a guess would mislead.
 */
export function trayHostRemedy(
  state: StatusNotifierHostState,
  env: LinuxTrayEnvironment
): string | null {
  if (state !== "absent") return null;
  if (env.gnomeLike) {
    return (
      "No StatusNotifierItem host is running, so no application can show a " +
      "tray icon in this GNOME session. GNOME has not had a built-in tray " +
      'since 3.26 — install and enable the "AppIndicator and ' +
      'KStatusNotifierItem Support" GNOME Shell extension ' +
      "(Debian/Ubuntu: gnome-shell-extension-appindicator; Fedora: " +
      "gnome-shell-extension-appindicator), then log out and back in. " +
      "PwrSnap stays reachable meanwhile via its global hotkeys and the " +
      "Library window."
    );
  }
  return (
    "No StatusNotifierItem host is running, so no application can show a " +
    "tray icon in this session. Enable your panel or bar's system-tray " +
    "module (waybar: the \"tray\" module; KDE Plasma has one natively). " +
    "PwrSnap stays reachable meanwhile via its global hotkeys and the " +
    "Library window."
  );
}

/**
 * Run the probe and log the verdict. Called fire-and-forget from
 * `installTray` on Linux; never throws, never gates tray creation.
 *
 * Deliberately not a gate: an SNI host that starts AFTER us is picked up by
 * Chromium's own `NameOwnerChanged` handling, so `"absent"` at boot is a
 * snapshot, not a permanent state. Logging it and moving on is the correct
 * response; refusing to create the Tray would break the user who starts
 * their bar a second later.
 */
export async function logLinuxTrayHostDiagnostics(): Promise<void> {
  try {
    const env = describeLinuxTrayEnvironment(process.env);
    const host = await probeStatusNotifierHost();
    const remedy = trayHostRemedy(host, env);
    const fields = {
      statusNotifierHost: host,
      desktop: env.desktop,
      sessionType: env.sessionType
    };
    if (remedy !== null) {
      log.warn(`tray icon will not appear: ${remedy}`, fields);
      return;
    }
    log.info("linux tray host probe", fields);
  } catch (cause) {
    // A diagnostic that breaks startup is worse than no diagnostic.
    log.debug("linux tray host probe failed", {
      message: cause instanceof Error ? cause.message : String(cause)
    });
  }
}
