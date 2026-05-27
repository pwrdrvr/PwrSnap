// Unit tests for the shared source-app resolution helpers. Image
// capture and interactive video recording both call
// `resolveSelectionSourceApp` so the same selection attributes the
// same source app regardless of which entry point kicked it off. The
// pre-fix video path only looked up the app when the user held ⇧
// (fullWindow), so a plain click on Claude attributed "Unknown App".

import { describe, expect, test } from "vitest";
import type { WindowInfo } from "../capture/window-list";
import {
  findWindowById,
  resolveSelectionSourceApp,
  resolveSourceAppByRect,
  shouldConsiderRaisingOurWindows
} from "../capture/source-app";

function win(
  overrides: {
    windowId?: number;
    pid?: number;
    bundleId?: string | null;
    appName?: string | null;
    bounds?: { x: number; y: number; width: number; height: number };
  } = {}
): WindowInfo {
  return {
    windowId: overrides.windowId ?? 100,
    pid: overrides.pid ?? 1234,
    bundleId: overrides.bundleId ?? null,
    appName: overrides.appName ?? null,
    title: null,
    bounds: overrides.bounds ?? { x: 0, y: 0, width: 800, height: 600 },
    layer: 0,
    alpha: 1,
    isFrontmostInApp: true
  };
}

describe("findWindowById", () => {
  test("returns the window with a matching id", () => {
    const claude = win({ windowId: 42, appName: "Claude" });
    const finder = win({ windowId: 99, appName: "Finder" });
    expect(findWindowById([claude, finder], 42)).toBe(claude);
  });

  test("returns null when no id matches", () => {
    expect(findWindowById([win({ windowId: 1 })], 999)).toBeNull();
  });

  test("returns null on an empty snapshot", () => {
    expect(findWindowById([], 1)).toBeNull();
  });
});

describe("resolveSourceAppByRect", () => {
  test("hit-tests the rect center against the snapshot", () => {
    // Claude covers the left half, Finder covers the right half. A
    // rect centered on the left half resolves to Claude.
    const claude = win({
      appName: "Claude",
      bounds: { x: 0, y: 0, width: 500, height: 1000 }
    });
    const finder = win({
      appName: "Finder",
      bounds: { x: 500, y: 0, width: 500, height: 1000 }
    });
    const rect = { x: 100, y: 100, w: 200, h: 200 }; // center = (200, 200)
    expect(resolveSourceAppByRect(rect, [claude, finder])).toBe(claude);
  });

  test("returns null when no window covers the rect center", () => {
    const claude = win({
      appName: "Claude",
      bounds: { x: 0, y: 0, width: 100, height: 100 }
    });
    const rect = { x: 500, y: 500, w: 100, h: 100 }; // center outside claude
    expect(resolveSourceAppByRect(rect, [claude])).toBeNull();
  });
});

describe("resolveSelectionSourceApp", () => {
  const claude = win({
    windowId: 42,
    appName: "Claude",
    bundleId: "com.anthropic.claudefordesktop",
    bounds: { x: 0, y: 0, width: 500, height: 1000 }
  });
  const finder = win({
    windowId: 99,
    appName: "Finder",
    bundleId: "com.apple.finder",
    bounds: { x: 500, y: 0, width: 500, height: 1000 }
  });
  const snapshot = [claude, finder];

  test("snap by window id wins when the window is still in the snapshot", () => {
    // The user snapped to Claude (windowId 42) but the rect happens to
    // be centered on Finder's half. The snap id is the user's intent,
    // so we honor it over the hit-test.
    const rect = { x: 700, y: 100, w: 100, h: 100 }; // centered on Finder
    expect(resolveSelectionSourceApp(rect, 42, snapshot)).toBe(claude);
  });

  test("falls back to rect-center hit test when snapped window vanished", () => {
    // User snapped to a window that closed between selection + commit
    // (snappedWindowId no longer in snapshot). Hit-test the rect
    // center as a best-effort fallback.
    const rect = { x: 100, y: 100, w: 100, h: 100 }; // centered on Claude
    expect(resolveSelectionSourceApp(rect, 12345, snapshot)).toBe(claude);
  });

  test("uses only the rect hit test when no snap was made (free region)", () => {
    const rect = { x: 600, y: 100, w: 100, h: 100 }; // centered on Finder
    expect(resolveSelectionSourceApp(rect, undefined, snapshot)).toBe(finder);
  });

  test("returns null when neither lookup resolves", () => {
    const rect = { x: 10_000, y: 10_000, w: 50, h: 50 }; // outside everything
    expect(resolveSelectionSourceApp(rect, undefined, snapshot)).toBeNull();
    expect(resolveSelectionSourceApp(rect, 12345, snapshot)).toBeNull();
  });

  test("returns null on an empty snapshot regardless of snap id", () => {
    const rect = { x: 100, y: 100, w: 100, h: 100 };
    expect(resolveSelectionSourceApp(rect, undefined, [])).toBeNull();
    expect(resolveSelectionSourceApp(rect, 42, [])).toBeNull();
  });
});

describe("shouldConsiderRaisingOurWindows", () => {
  // PwrSnap = pid 1234; Claude = pid 5678.
  const OUR_PID = 1234;
  const CLAUDE_PID = 5678;
  const ourPids = new Set<number>([OUR_PID]);

  const ourLibrary = win({
    windowId: 10,
    pid: OUR_PID,
    appName: "PwrSnap",
    bundleId: "com.pwrdrvr.pwrsnap"
  });
  const claudeWindow = win({
    windowId: 20,
    pid: CLAUDE_PID,
    appName: "Claude",
    bundleId: "com.anthropic.claudefordesktop"
  });
  const snapshot = [claudeWindow, ourLibrary];

  test("free-region drag (no snap) → consider raising", () => {
    // The user drew a region without snapping. If it happens to
    // overlap one of our windows, we want to honor that — see the
    // outer caller's intersection check.
    expect(shouldConsiderRaisingOurWindows(undefined, snapshot, ourPids)).toBe(true);
  });

  test("snapped to one of our windows → consider raising", () => {
    // User clicked the Library. We explicitly want it on top so the
    // recording captures live PwrSnap pixels.
    expect(shouldConsiderRaisingOurWindows(10, snapshot, ourPids)).toBe(true);
  });

  test("snapped to another app's window → DO NOT raise — the bug fix", () => {
    // User shift-clicked Claude (or just clicked it). Even if the
    // Library is sitting partially behind Claude (overlap-true under
    // the bounds intersection check), we must NOT raise the Library —
    // doing so would obscure the recording subject the user actually
    // picked.
    expect(shouldConsiderRaisingOurWindows(20, snapshot, ourPids)).toBe(false);
  });

  test("snap id not found in snapshot → consider raising (defensive)", () => {
    // The snapped window disappeared between the selector show and
    // the post-commit lookup. We've got no signal about whose window
    // it was; fall back to the overlap-driven raise (which may end
    // up not raising anything either, depending on what intersects).
    expect(shouldConsiderRaisingOurWindows(999, snapshot, ourPids)).toBe(true);
  });

  test("empty snapshot is treated like 'unknown' regardless of snap id", () => {
    expect(shouldConsiderRaisingOurWindows(20, [], ourPids)).toBe(true);
    expect(shouldConsiderRaisingOurWindows(undefined, [], ourPids)).toBe(true);
  });

  test("multiple our-pids — any match treats the snap target as ours", () => {
    // Defensive — `selfPidSet()` is single-pid today but the API
    // signature accepts a set; renderer pids might be added later.
    const multiPid = new Set<number>([OUR_PID, 9999]);
    const claudeFromOurSecondPid = win({
      windowId: 30,
      pid: 9999,
      appName: "PwrSnap (renderer)"
    });
    const richSnapshot = [claudeFromOurSecondPid, ...snapshot];
    expect(shouldConsiderRaisingOurWindows(30, richSnapshot, multiPid)).toBe(true);
  });
});
