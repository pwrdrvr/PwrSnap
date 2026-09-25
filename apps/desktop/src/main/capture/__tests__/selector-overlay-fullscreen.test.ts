// The selector overlay must enter native fullscreen on every platform whose
// shell paints chrome above ordinary always-on-top windows — Windows and
// Linux. Source-grep, because nothing else can see this.
//
// Why a grep and not a behavioural test: `enterMenuBarOverlayMode` is private
// to region-selector.ts, and the thing it prevents is a COMPOSITOR decision.
// No unit test can observe whether GNOME painted its top bar over our window,
// the Docker/xvfb E2E harness has no window manager at all, and macOS never
// runs the branch. The only feedback loop is a human looking at a real Ubuntu
// screen — which is exactly how this shipped broken.
//
// What shipped broken: the function returned early for every platform that
// was neither win32 nor darwin, so the Linux selector never went fullscreen.
// A non-fullscreen window does not own the screen under GNOME — mutter moves
// a monitor-sized toplevel into the work area (measured on mutter 46: pixels
// at 67,32 behind a 32px top / 67px left strut, while getBounds() and the
// renderer's screenX/Y still read 0,0), and chrome stacked above it can cover
// it. The user saw the live top bar and dock beside the frozen snapshot's
// copy of them and reported a duplicated, offset desktop. Windows had the
// identical bug ("two taskbars") and already had the identical fix.
//
// `fullscreenable` and, on Linux, `resizable` are pinned alongside it because
// they are one mechanism, and both failure modes are silent:
// `setFullScreen(true)` does nothing on a window constructed
// `fullscreenable: false`, and under X11 mutter ignores it from a window that
// is not resizable — while `isFullScreen()` reports true.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const source = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../region-selector.ts"),
  "utf8"
);

function body(fnName: string): string {
  const start = source.indexOf(`function ${fnName}(`);
  expect(start, `${fnName} not found`).toBeGreaterThan(-1);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

describe("region-selector overlay fullscreen wiring", () => {
  test("Linux enters native fullscreen, on the same branch as Windows", () => {
    const enter = body("enterMenuBarOverlayMode");
    expect(enter).toContain('process.platform === "win32" || process.platform === "linux"');
    expect(enter).toContain("win.setFullScreen(true)");
    // The early return that caused the bug must not sit ahead of that branch
    // again: darwin's guard has to come AFTER the win32/linux arm, or Linux
    // falls out of the function before it can do anything.
    expect(enter.indexOf('process.platform === "win32" || process.platform === "linux"')).toBeLessThan(
      enter.indexOf('if (process.platform !== "darwin") return;')
    );
  });

  test("Linux leaves fullscreen again, or the next capture starts oversized", () => {
    const leave = body("leaveMenuBarOverlayMode");
    expect(leave).toContain('process.platform === "win32" || process.platform === "linux"');
    expect(leave).toContain("win.setFullScreen(false)");
  });

  test("the selector window is constructed fullscreenable off darwin", () => {
    // `fullscreenable: process.platform === "win32"` left Linux false, which
    // would have made the fix above a silent no-op.
    expect(body("createSelectorWindow")).toContain(
      'fullscreenable: process.platform !== "darwin"'
    );
  });

  test("the selector window is constructed resizable on Linux, and only there", () => {
    // Measured on mutter 46, as an Xorg WM and under XWayland: with
    // `resizable: false` the fullscreen request is dropped and the selector
    // stays squeezed into the work area (67,32 1853x1048 behind a 32/67px
    // strut) while isFullScreen() reports true; with `resizable: true` it
    // covers 0,0 1920x1080. Windows keeps false — its path is verified as is.
    expect(body("createSelectorWindow")).toContain('resizable: process.platform === "linux"');
  });

  test("the selector module never applies the Wayland refusal itself", () => {
    // The refusal lives in the `capture:interactive` handler, which shows the
    // user why. Applied in here — a draft skipped pre-warming — it becomes a
    // refusal with no voice: the Record path drives `pickRegion` directly,
    // finds no selector windows, and its button silently does nothing.
    expect(source).not.toContain("regionSelectorUnsupported");
  });
});
