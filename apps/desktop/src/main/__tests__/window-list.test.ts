// Unit tests for the pure pieces of `window-list.ts`. The Swift
// helper itself is exercised end-to-end via the E2E suite (it shells
// to a binary and queries CGWindowListCopyWindowInfo); the hit-test
// routine `findWindowAt` is pure and lives here.

import { describe, expect, test } from "vitest";
import {
  filterSnapCandidates,
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

describe("filterSnapCandidates", () => {
  test("drops windows owned by our own pid", () => {
    const ours = w(1, "com.pwrdrvr.pwrsnap", { x: 0, y: 0, width: 100, height: 100 }, {
      pid: 999
    });
    const theirs = w(2, "com.tinyspeck.slack", { x: 0, y: 0, width: 200, height: 200 }, {
      pid: 1234
    });
    const out = filterSnapCandidates([ours, theirs], new Set([999]));
    expect(out).toHaveLength(1);
    expect(out[0]!.windowId).toBe(2);
  });

  test("collapses an app's secondary panels into just the frontmost", () => {
    // Same pid, two windows — main (frontmost) and an inspector
    // panel. Helper marks the first one as isFrontmostInApp; the
    // second (already-seen pid) gets false. Filter drops the second.
    const main = w(1, "com.test.editor", { x: 0, y: 0, width: 800, height: 600 }, {
      pid: 5,
      isFrontmostInApp: true
    });
    const panel = w(2, "com.test.editor", { x: 100, y: 100, width: 200, height: 100 }, {
      pid: 5,
      isFrontmostInApp: false
    });
    const out = filterSnapCandidates([main, panel], new Set());
    expect(out.map((w) => w.windowId)).toEqual([1]);
  });

  test("preserves unrelated apps even when our pids overlap", () => {
    const a = w(1, "com.a", { x: 0, y: 0, width: 100, height: 100 }, { pid: 10 });
    const b = w(2, "com.b", { x: 200, y: 0, width: 100, height: 100 }, { pid: 20 });
    const c = w(3, "com.c", { x: 400, y: 0, width: 100, height: 100 }, { pid: 30 });
    const out = filterSnapCandidates([a, b, c], new Set([20]));
    expect(out.map((w) => w.windowId).sort()).toEqual([1, 3]);
  });
});
