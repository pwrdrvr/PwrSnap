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
    expect(regionSelectorUnsupported(env({ XDG_SESSION_TYPE: "wayland" }), "darwin")).toBe(false);
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
    expect(regionSelectorUnsupported(env({}), "linux")).toBe(false);
  });

  test("regionSelectorUnsupported is true for Wayland only", () => {
    expect(regionSelectorUnsupported(env({ XDG_SESSION_TYPE: "wayland" }), "linux")).toBe(true);
    expect(
      regionSelectorUnsupported(env({ XDG_SESSION_TYPE: "x11", DISPLAY: ":0" }), "linux")
    ).toBe(false);
  });
});
