// Unit tests for the pure pieces of `window-list.ts`. The Swift
// helper itself is exercised end-to-end via the E2E suite (it shells
// to a binary and queries CGWindowListCopyWindowInfo); the hit-test
// routine `findWindowAt` is pure and lives here.

import { describe, expect, test } from "vitest";
import {
  boundsApproxEqual,
  findWindowAt,
  type WindowInfo
} from "../capture/window-list";

function w(
  windowId: number,
  bundleId: string | null,
  bounds: { x: number; y: number; width: number; height: number },
  overrides: Partial<Pick<WindowInfo, "pid" | "isFrontmostInApp">> = {}
): WindowInfo {
  return {
    windowId,
    pid: overrides.pid ?? windowId * 1000,
    bundleId,
    appName: bundleId !== null ? bundleId.split(".").pop()! : null,
    title: null,
    bounds,
    layer: 0,
    alpha: 1,
    isFrontmostInApp: overrides.isFrontmostInApp ?? true
  };
}

describe("findWindowAt", () => {
  test("returns null on an empty list", () => {
    expect(findWindowAt([], 100, 100)).toBeNull();
  });

  test("returns the window containing the point", () => {
    const slack = w(1, "com.tinyspeck.slackmacgap", { x: 0, y: 0, width: 800, height: 600 });
    const result = findWindowAt([slack], 400, 300);
    expect(result?.windowId).toBe(1);
  });

  test("returns null when no window contains the point", () => {
    const slack = w(1, "com.tinyspeck.slackmacgap", { x: 0, y: 0, width: 800, height: 600 });
    expect(findWindowAt([slack], 1000, 1000)).toBeNull();
  });

  test("returns the topmost window (first in list = frontmost)", () => {
    // CGWindowListCopyWindowInfo returns front-most first. Two
    // overlapping windows: scan should pick the front one.
    const front = w(1, "com.tinyspeck.slack", { x: 100, y: 100, width: 400, height: 300 });
    const back = w(2, "com.apple.finder", { x: 0, y: 0, width: 800, height: 600 });
    // (200, 200) is inside both — must return the front one.
    expect(findWindowAt([front, back], 200, 200)?.windowId).toBe(1);
    // (50, 50) is inside back only — returns back.
    expect(findWindowAt([front, back], 50, 50)?.windowId).toBe(2);
  });

  test("inclusive bounds — points exactly on the border count as inside", () => {
    const win = w(1, "com.test", { x: 100, y: 100, width: 200, height: 150 });
    expect(findWindowAt([win], 100, 100)).not.toBeNull(); // top-left corner
    expect(findWindowAt([win], 300, 250)).not.toBeNull(); // bottom-right corner
    expect(findWindowAt([win], 99, 100)).toBeNull(); // 1px outside left
    expect(findWindowAt([win], 100, 251)).toBeNull(); // 1px outside bottom
  });

  test("handles a snapshot with a null bundleId (system processes)", () => {
    const sysWin = w(99, null, { x: 0, y: 0, width: 100, height: 100 });
    expect(findWindowAt([sysWin], 50, 50)?.bundleId).toBeNull();
  });
});

describe("boundsApproxEqual", () => {
  // Used to identify which CGWindow entries belong to OUR user-
  // facing BrowserWindows vs auxiliary same-pid windows like
  // DevTools. Bounds within ±2 px counts as a match (CGWindowList
  // sometimes returns sub-pixel rounded values; BrowserWindow
  // returns CSS-rounded ones).
  const a = { x: 100, y: 200, width: 1440, height: 956 };

  test("equal bounds match", () => {
    expect(boundsApproxEqual(a, { x: 100, y: 200, width: 1440, height: 956 })).toBe(true);
  });

  test("≤2 px difference per edge still matches", () => {
    expect(boundsApproxEqual(a, { x: 102, y: 198, width: 1442, height: 954 })).toBe(true);
  });

  test(">2 px difference does NOT match", () => {
    expect(boundsApproxEqual(a, { x: 105, y: 200, width: 1440, height: 956 })).toBe(false);
    expect(boundsApproxEqual(a, { x: 100, y: 200, width: 1450, height: 956 })).toBe(false);
  });

  test("DevTools-vs-library distinction (the bug we're fixing)", () => {
    // Library default size — the user's library window.
    const library = { x: 240, y: 30, width: 1440, height: 956 };
    // DevTools detached default — same pid, very different bounds.
    const devtools = { x: 113, y: 386, width: 800, height: 600 };
    expect(boundsApproxEqual(library, devtools)).toBe(false);
    // Library identifies itself.
    expect(boundsApproxEqual(library, { x: 240, y: 30, width: 1440, height: 956 })).toBe(true);
  });

  test("custom tolerance", () => {
    expect(boundsApproxEqual(a, { x: 105, y: 200, width: 1440, height: 956 }, 5)).toBe(true);
    expect(boundsApproxEqual(a, { x: 106, y: 200, width: 1440, height: 956 }, 5)).toBe(false);
  });
});

