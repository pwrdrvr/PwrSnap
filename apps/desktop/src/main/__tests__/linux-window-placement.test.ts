// Which Ozone backend are we on, and may we place our own windows?
//
// The answer decides whether the tray popover is cursor-anchored or left where
// the compositor puts it, and whether the float-over's bottom-right corner is
// applied at all. Every case here is a pure function, so a macOS CI host can
// ask for any combination.
//
// The reason this file exists rather than a runtime probe: measured on
// Electron 41.10.7 against a headless weston AND xvfb, `setPosition(400, 300)`
// followed by `getPosition()` returns `[400, 300]` on BOTH backends. The two
// runs were byte-identical across every geometry getter, so there is nothing
// to detect at runtime and the environment is the only honest source.

import { describe, expect, test } from "vitest";
import {
  canPositionOwnWindows,
  linuxWindowBackend
} from "../linux-window-placement";

describe("linuxWindowBackend — the resolved Ozone switch wins", () => {
  test("reads the switch Electron records, whichever way it went", () => {
    expect(linuxWindowBackend({}, "wayland")).toBe("wayland");
    expect(linuxWindowBackend({}, "x11")).toBe("x11");
  });

  test("the switch beats a session type that disagrees with it", () => {
    // THE case this ordering exists for: Electron running as an XWayland
    // client on a Wayland session is an X11 process that CAN position its
    // windows. Reading XDG_SESSION_TYPE alone would wrongly disable placement.
    expect(
      linuxWindowBackend(
        { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" },
        "x11"
      )
    ).toBe("x11");
  });

  test("is case- and whitespace-insensitive about the switch", () => {
    expect(linuxWindowBackend({}, "  Wayland  ")).toBe("wayland");
  });
});

describe("linuxWindowBackend — environment fallback", () => {
  test("an explicit hint answers when no switch was recorded", () => {
    expect(
      linuxWindowBackend({ ELECTRON_OZONE_PLATFORM_HINT: "wayland" }, null)
    ).toBe("wayland");
    expect(
      linuxWindowBackend(
        { ELECTRON_OZONE_PLATFORM_HINT: "x11", WAYLAND_DISPLAY: "wayland-0" },
        null
      )
    ).toBe("x11");
  });

  test("`auto` defers to whether there is a Wayland display to take", () => {
    expect(
      linuxWindowBackend(
        { ELECTRON_OZONE_PLATFORM_HINT: "auto", WAYLAND_DISPLAY: "wayland-0" },
        ""
      )
    ).toBe("wayland");
    expect(
      linuxWindowBackend(
        { ELECTRON_OZONE_PLATFORM_HINT: "auto", DISPLAY: ":0" },
        ""
      )
    ).toBe("x11");
  });

  test("WAYLAND_DISPLAY alone is enough, as it is for Chromium", () => {
    expect(linuxWindowBackend({ WAYLAND_DISPLAY: "wayland-0" }, null)).toBe(
      "wayland"
    );
  });

  test("XDG_SESSION_TYPE answers when there is nothing better", () => {
    expect(linuxWindowBackend({ XDG_SESSION_TYPE: "wayland" }, null)).toBe(
      "wayland"
    );
    expect(linuxWindowBackend({ XDG_SESSION_TYPE: "x11" }, null)).toBe("x11");
  });

  test("an empty environment is X11 — the answer that tries to place", () => {
    // Failing toward "attempt placement" degrades to a mis-placed window;
    // failing the other way abandons placement on a session where it works.
    expect(linuxWindowBackend({}, null)).toBe("x11");
    expect(linuxWindowBackend({ WAYLAND_DISPLAY: "  " }, "")).toBe("x11");
  });
});

describe("canPositionOwnWindows", () => {
  const waylandEnv = { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" };

  test("macOS and Windows always place their own windows", () => {
    // Even handed a Wayland-looking environment — those platforms cannot be
    // on Wayland, and an env var is not a reason to disable a working API.
    expect(canPositionOwnWindows("darwin", waylandEnv, "wayland")).toBe(true);
    expect(canPositionOwnWindows("win32", waylandEnv, "wayland")).toBe(true);
  });

  test("Linux on Wayland cannot", () => {
    expect(canPositionOwnWindows("linux", waylandEnv, "wayland")).toBe(false);
    expect(canPositionOwnWindows("linux", waylandEnv, null)).toBe(false);
  });

  test("Linux on X11 can — including XWayland", () => {
    expect(canPositionOwnWindows("linux", { DISPLAY: ":0" }, "x11")).toBe(true);
    expect(canPositionOwnWindows("linux", waylandEnv, "x11")).toBe(true);
  });

  test("an unknown Unix gets the X11 answer", () => {
    // Matches `shortcutPlatformFromString`'s "unknown means Linux" fallback,
    // and errs toward attempting placement.
    expect(canPositionOwnWindows("freebsd" as NodeJS.Platform, {}, null)).toBe(
      true
    );
  });
});
