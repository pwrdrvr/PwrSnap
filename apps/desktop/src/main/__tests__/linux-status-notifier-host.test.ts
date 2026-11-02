// The probe that turns "PwrSnap has no tray icon on Linux" into a log line.
//
// Electron's Linux tray registers a StatusNotifierItem on the session bus
// and hands the drawing to whoever owns `org.kde.StatusNotifierWatcher`. If
// nothing owns that name there is no host, the registration goes nowhere,
// and nothing — no error, no event, no callback — distinguishes that from a
// broken tray implementation. This module asks the bus directly.
//
// Everything interesting here is the interpretation, not the spawn: a probe
// that guesses "absent" from a failure would print a confident, wrong remedy
// ("install the GNOME extension") to a user whose extension is fine. So the
// parse and the remedy wording are pinned, and both are pure.

import { describe, expect, test } from "vitest";
import {
  describeLinuxTrayEnvironment,
  interpretNameHasOwnerOutput,
  probeStatusNotifierHost,
  STATUS_NOTIFIER_PROBE_TIMEOUT_MS,
  trayHostRemedy
} from "../linux-status-notifier-host";

describe("interpretNameHasOwnerOutput", () => {
  test("reads gdbus's GVariant tuple", () => {
    // `gdbus call` prints a tuple, so a boolean reply is `(true,)`.
    expect(interpretNameHasOwnerOutput(0, "(true,)\n")).toBe("present");
    expect(interpretNameHasOwnerOutput(0, "(false,)\n")).toBe("absent");
  });

  test.each([
    ["a non-zero exit", 1, "(false,)\n"],
    ["a killed probe", null, "(false,)\n"],
    ["an unparseable reply", 0, "yes\n"],
    ["no reply at all", 0, ""]
  ])("%s is unknown, never absent", (_name, code, stdout) => {
    // This is the load-bearing case. "unknown" prints no remedy; "absent"
    // prints a specific instruction. A broken probe must not produce the
    // latter — the user whose tray host is healthy would be sent to install
    // a GNOME extension they already have.
    expect(interpretNameHasOwnerOutput(code, stdout)).toBe("unknown");
  });
});

describe("describeLinuxTrayEnvironment", () => {
  test.each([
    ["GNOME", "GNOME"],
    ["Ubuntu's prefixed list", "ubuntu:GNOME"],
    ["Pop!_OS", "pop:GNOME"],
    ["GNOME Classic", "GNOME-Classic:GNOME"],
    ["GNOME Flashback alone", "GNOME-Flashback"],
    ["lowercase, as some shells export it", "gnome"]
  ])("treats %s as GNOME-like", (_name, desktop) => {
    // XDG_CURRENT_DESKTOP is a colon-separated priority list per the
    // freedesktop spec, and the case it is exported in is not reliable — so
    // match per component, case-insensitively, rather than on the whole
    // string. Every one of these sessions is GNOME Shell and needs the
    // AppIndicator extension.
    expect(describeLinuxTrayEnvironment({ XDG_CURRENT_DESKTOP: desktop }).gnomeLike).toBe(
      true
    );
  });

  test.each([
    ["KDE", "KDE"],
    ["sway", "sway"],
    ["Hyprland", "Hyprland"],
    ["a bare wlroots session", "wlroots"],
    ["nothing exported", undefined]
  ])("does not treat %s as GNOME-like", (_name, desktop) => {
    const env = desktop === undefined ? {} : { XDG_CURRENT_DESKTOP: desktop };
    expect(describeLinuxTrayEnvironment(env).gnomeLike).toBe(false);
  });

  test("does not match a desktop that merely contains 'gnome'", () => {
    // Component equality / prefix, not substring: "not-gnome" is not GNOME.
    expect(
      describeLinuxTrayEnvironment({ XDG_CURRENT_DESKTOP: "not-gnome" }).gnomeLike
    ).toBe(false);
  });

  test("passes the raw desktop and session type through for the log", () => {
    expect(
      describeLinuxTrayEnvironment({
        XDG_CURRENT_DESKTOP: "ubuntu:GNOME",
        XDG_SESSION_TYPE: "wayland"
      })
    ).toEqual({ desktop: "ubuntu:GNOME", sessionType: "wayland", gnomeLike: true });
    // Absent vars are null, not "", so the log distinguishes "not set" from
    // "set to empty".
    expect(describeLinuxTrayEnvironment({})).toEqual({
      desktop: null,
      sessionType: null,
      gnomeLike: false
    });
  });
});

describe("trayHostRemedy", () => {
  const gnome = describeLinuxTrayEnvironment({ XDG_CURRENT_DESKTOP: "ubuntu:GNOME" });
  const sway = describeLinuxTrayEnvironment({ XDG_CURRENT_DESKTOP: "sway" });

  test.each(["present", "unknown"] as const)("says nothing when the host is %s", (state) => {
    // Silence on "unknown" is the point — see interpretNameHasOwnerOutput.
    expect(trayHostRemedy(state, gnome)).toBeNull();
    expect(trayHostRemedy(state, sway)).toBeNull();
  });

  test("names the GNOME extension by its package name", () => {
    const remedy = trayHostRemedy("absent", gnome);
    expect(remedy).not.toBeNull();
    expect(remedy).toContain("AppIndicator and KStatusNotifierItem Support");
    expect(remedy).toContain("gnome-shell-extension-appindicator");
    // "Log out and back in" matters: enabling the extension does not attach
    // it to an already-running shell session on Wayland.
    expect(remedy).toContain("log out and back in");
  });

  test("points a non-GNOME session at its own bar's tray module", () => {
    const remedy = trayHostRemedy("absent", sway);
    expect(remedy).not.toBeNull();
    // Telling a sway user to install a GNOME Shell extension would be worse
    // than saying nothing.
    expect(remedy).not.toContain("GNOME Shell extension");
    expect(remedy).toContain("waybar");
  });

  test("every remedy says PwrSnap is still reachable", () => {
    // The answer to "what does the app do when no indicator host exists" is
    // "keeps working, and says so" — not "degrades silently" and not
    // "refuses to start".
    for (const env of [gnome, sway]) {
      const remedy = trayHostRemedy("absent", env);
      expect(remedy).toContain("global hotkeys");
      expect(remedy).toContain("Library window");
    }
  });
});

describe("probeStatusNotifierHost", () => {
  test("always settles, on any host, without throwing", async () => {
    // Runs for real against whatever host the suite is on, with a short
    // deadline so the test does not wait out the production one. The
    // assertion is deliberately not a specific verdict: the answer depends on
    // whether `gdbus` is installed and whether this session has a tray host,
    // and all three states are legitimate here. What must hold everywhere is
    // that the promise RESOLVES — a probe that rejected would take
    // `installTray` down with it (it is called as a bare `void`), and one
    // that never settled would leak a child process for the life of the app.
    //
    // The deadline is not decorative. `gdbus` with no reachable session bus
    // can hang rather than exit, which is exactly what it does on a macOS
    // dev box with Homebrew glib on PATH — the timeout is the only thing that
    // ends the probe there.
    await expect(probeStatusNotifierHost(250)).resolves.toMatch(
      /^(present|absent|unknown)$/
    );
  });

  test("the production deadline stays bounded", () => {
    // A probe long enough to outlive a user's patience has stopped being a
    // diagnostic and started being a startup cost.
    expect(STATUS_NOTIFIER_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });
});
