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
// The window itself was fine — measured on Ubuntu 24 / GNOME at exactly
// 0,0 2560x1440 with the renderer 1:1 and a pixel-exact grab under it — but
// GNOME's top bar and the Ubuntu dock are drawn by the compositor above every
// client window, so ~32px of the overlay's top edge and the whole left dock
// strip sat behind live shell chrome. The frozen snapshot carries its own
// copy of that chrome, so the user saw the shell's top bar beside the
// snapshot's copy of it and reported a duplicated, offset desktop. Nothing
// was offset. Windows had the identical bug ("two taskbars") and already had
// the identical fix.
//
// `fullscreenable` is pinned alongside it because the two are one mechanism:
// `setFullScreen(true)` on a window constructed `fullscreenable: false` does
// nothing, and the failure mode is silent.

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
});
