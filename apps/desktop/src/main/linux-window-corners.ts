// Every PwrSnap window keeps square corners on Linux.
//
// Electron 43 started rounding frameless windows on Linux
// (electron/electron#51459, backported to 43 as #52111). It is an 8px radius,
// on by default, drawn wherever the session supports client-side decorations,
// and on Linux it clips the window's web contents view itself rather than a
// frame around it. Until then `roundedCorners` was documented
// `@platform darwin,win32`, so every frameless PwrSnap window on Linux was
// square, and everything measured there was measured square:
//
//   • the region selector has to cover its display pixel for pixel (step 6 of
//     linux-capture-probe.mjs counts the foreign pixels), and four clipped
//     corners would show the live desktop beside the frozen snapshot;
//   • the recording frame is a transparent overlay whose corners are corner
//     ticks;
//   • the text bake pool rasterizes through `capturePage`;
//   • the Library family paints its own square edge, the `#root::after`
//     hairline in library.css.
//
// So every window opts out on Linux and keeps the shape it shipped with.
// Rounding the chrome windows is a design change, to be made with a real GNOME
// session to look at, not inherited from a dependency bump. macOS and Windows
// keep Electron's default, which did not change in 42–44.
//
// Pinned by linux-window-corners.test.ts, which fails when a `new
// BrowserWindow(` in main does not spread this.

import type { BrowserWindowConstructorOptions } from "electron";

export function linuxSquareCorners(
  platform: NodeJS.Platform = process.platform
): BrowserWindowConstructorOptions {
  return platform === "linux" ? { roundedCorners: false } : {};
}
