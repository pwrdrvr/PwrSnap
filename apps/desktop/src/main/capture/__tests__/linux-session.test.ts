import { describe, expect, test } from "vitest";
import { linuxSessionType, regionSelectorUnsupported } from "../linux-session";

const env = (over: Record<string, string | undefined>): NodeJS.ProcessEnv => over;

describe("linuxSessionType", () => {
  test("the question does not apply off Linux", () => {
    // macOS captures through `screencapture -R <bounds>` and Windows has no
    // portal; a stray WAYLAND_DISPLAY in the environment must not disable
    // region capture there.
    expect(linuxSessionType(env({ WAYLAND_DISPLAY: "wayland-0" }), "darwin")).toBe("not-linux");
    expect(linuxSessionType(env({ WAYLAND_DISPLAY: "wayland-0" }), "win32")).toBe("not-linux");
    expect(regionSelectorUnsupported(2, env({ XDG_SESSION_TYPE: "wayland" }), "darwin")).toBe(false);
  });

  test("XDG_SESSION_TYPE=wayland is Wayland", () => {
    expect(linuxSessionType(env({ XDG_SESSION_TYPE: "wayland" }), "linux")).toBe("wayland");
    expect(linuxSessionType(env({ XDG_SESSION_TYPE: "Wayland" }), "linux")).toBe("wayland");
    expect(linuxSessionType(env({ XDG_SESSION_TYPE: " wayland " }), "linux")).toBe("wayland");
  });

  test("a Wayland session running Electron under XWayland is still Wayland", () => {
    // DISPLAY is set for the XWayland socket, so an Electron on the x11
    // ozone backend looks like an X11 client — but Chromium routes screen
    // capture through the portal off the same XDG_SESSION_TYPE this reads,
    // so the grab is a portal grab either way.
    expect(
      linuxSessionType(
        env({ XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" }),
        "linux"
      )
    ).toBe("wayland");
  });

  test("WAYLAND_DISPLAY alone is Wayland when nothing else declares a type", () => {
    expect(linuxSessionType(env({ WAYLAND_DISPLAY: "wayland-0" }), "linux")).toBe("wayland");
  });

  test("a declared X11 session backed by DISPLAY is X11", () => {
    expect(linuxSessionType(env({ XDG_SESSION_TYPE: "x11", DISPLAY: ":0" }), "linux")).toBe("x11");
    // A leftover WAYLAND_DISPLAY does not outrank an X11 session that has a
    // working DISPLAY — losing region capture to a stale variable would be
    // worse than the bug this guards.
    expect(
      linuxSessionType(
        env({ XDG_SESSION_TYPE: "x11", DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" }),
        "linux"
      )
    ).toBe("x11");
  });

  test("a declared X11 session with no DISPLAY but a Wayland socket is Wayland", () => {
    expect(
      linuxSessionType(env({ XDG_SESSION_TYPE: "x11", WAYLAND_DISPLAY: "wayland-0" }), "linux")
    ).toBe("wayland");
  });

  test("DISPLAY alone is X11", () => {
    expect(linuxSessionType(env({ DISPLAY: ":0" }), "linux")).toBe("x11");
  });

  test("an unrecognisable environment is unknown, and keeps region capture", () => {
    // Failing open matters: a detection miss on X11 would remove a working
    // feature, while a miss on Wayland still fails legibly at the grab-
    // geometry check rather than painting a misaligned selector.
    expect(linuxSessionType(env({}), "linux")).toBe("unknown");
    expect(linuxSessionType(env({ XDG_SESSION_TYPE: "tty" }), "linux")).toBe("unknown");
    expect(regionSelectorUnsupported(2, env({}), "linux")).toBe(false);
  });

  test("Wayland keeps region capture on a single display", () => {
    // The blanket Wayland refusal is GONE, and this is the test that stops it
    // coming back. It was a stopgap for a misalignment we could not explain,
    // and the explanation turned out to be our own missing setFullScreen(true)
    // on Linux — the overlay was geometrically perfect and simply had GNOME's
    // top bar and dock painted over it. Measured on Ubuntu 24: placement
    // honoured exactly, renderer 1:1, and a pixel-exact grab (all four
    // fiducials +0,+0).
    expect(regionSelectorUnsupported(1, env({ XDG_SESSION_TYPE: "wayland" }), "linux")).toBe(
      false
    );
  });

  test("Wayland with more than one display is refused — the pointer is dead", () => {
    // The one thing the fullscreen fix does not reach. getCursorScreenPoint()
    // returns 0,0 wherever the mouse is, and pickRegion routes off it to
    // choose a display, so with two displays it reliably picks the wrong one.
    // With one there is nothing to get wrong.
    expect(regionSelectorUnsupported(2, env({ XDG_SESSION_TYPE: "wayland" }), "linux")).toBe(true);
    expect(regionSelectorUnsupported(3, env({ XDG_SESSION_TYPE: "wayland" }), "linux")).toBe(true);
  });

  test("X11 is never refused, at any display count", () => {
    for (const count of [1, 2, 3]) {
      expect(
        regionSelectorUnsupported(count, env({ XDG_SESSION_TYPE: "x11", DISPLAY: ":0" }), "linux"),
        `${count} display(s)`
      ).toBe(false);
    }
  });
});
