// Unit tests for the pure pieces of `window-list.ts`. The native
// helper itself is exercised end-to-end via the E2E suite (it shells
// to a binary and enumerates on-screen windows — CGWindowList on
// macOS, EnumWindows on Windows); the hit-test routine `findWindowAt`
// and the cross-platform `parseHelperOutput` are pure and live here.
// `parseHelperOutput` is shared by both producers, so it's covered for
// the macOS envelope, the Windows envelope, and the legacy bare-array.

import { describe, expect, test } from "vitest";
import {
  boundsApproxEqual,
  findWindowAt,
  parseHelperOutput,
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

describe("parseHelperOutput", () => {
  // Three input shapes from the Swift helper that survived from
  // the pre-envelope era + the current envelope + everything else:
  // current envelope, legacy bare-array, anything-malformed.
  // Backwards-compat with the bare array is load-bearing — if a
  // packaged release ever ships new TS code against an old helper
  // binary (e.g. partial-rebuild dev environment) we want it to
  // degrade gracefully, not crash. These tests lock that down.

  test("parses the current envelope shape", () => {
    const stdout = JSON.stringify({
      windows: [
        {
          windowId: 100,
          pid: 1987,
          bundleId: "com.github.Electron",
          appName: "Electron",
          title: "PwrSnap",
          bounds: { x: 0, y: 29, width: 1440, height: 938 },
          layer: 0,
          alpha: 1,
          isFrontmostInApp: true
        }
      ],
      frontmostPid: 1987,
      frontmostBundleId: "com.github.Electron"
    });
    const result = parseHelperOutput(stdout);
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]!.pid).toBe(1987);
    expect(result.frontmostPid).toBe(1987);
    expect(result.frontmostBundleId).toBe("com.github.Electron");
  });

  test("parses the legacy bare-array shape with null frontmost fields", () => {
    // Pre-2026-05-25 helpers emitted a bare array. The TS parser
    // tolerates it for the new-TS-against-old-helper partial-build
    // case — windows survive, frontmost fields collapse to null so
    // the downstream frontmost-vs-z=0 warning stays silent (there's
    // no frontmost data to compare against).
    const stdout = JSON.stringify([
      {
        windowId: 100,
        pid: 1987,
        bundleId: "com.github.Electron",
        appName: "Electron",
        title: "PwrSnap",
        bounds: { x: 0, y: 29, width: 1440, height: 938 },
        layer: 0,
        alpha: 1,
        isFrontmostInApp: true
      },
      {
        windowId: 200,
        pid: 5555,
        bundleId: "com.apple.finder",
        appName: "Finder",
        title: "Applications",
        bounds: { x: 100, y: 100, width: 800, height: 600 },
        layer: 0,
        alpha: 1,
        isFrontmostInApp: true
      }
    ]);
    const result = parseHelperOutput(stdout);
    expect(result.windows).toHaveLength(2);
    expect(result.windows[0]!.appName).toBe("Electron");
    expect(result.windows[1]!.appName).toBe("Finder");
    expect(result.frontmostPid).toBeNull();
    expect(result.frontmostBundleId).toBeNull();
  });

  test("returns an empty snapshot on malformed JSON", () => {
    const result = parseHelperOutput("not-json-at-all{");
    expect(result.windows).toEqual([]);
    expect(result.frontmostPid).toBeNull();
    expect(result.frontmostBundleId).toBeNull();
  });

  test("returns an empty snapshot on JSON null", () => {
    const result = parseHelperOutput("null");
    expect(result.windows).toEqual([]);
    expect(result.frontmostPid).toBeNull();
    expect(result.frontmostBundleId).toBeNull();
  });

  test("returns an empty snapshot when the envelope is missing windows", () => {
    // Defensive: a future helper that omits `windows` for some
    // reason shouldn't crash the picker. Treat as "no candidates"
    // and let the user see a no-snap selector.
    const stdout = JSON.stringify({ frontmostPid: 1234, frontmostBundleId: "com.foo" });
    const result = parseHelperOutput(stdout);
    expect(result.windows).toEqual([]);
    // No `windows` field → not the envelope shape → frontmost
    // fields don't propagate even though they happen to be present.
    expect(result.frontmostPid).toBeNull();
    expect(result.frontmostBundleId).toBeNull();
  });

  test("envelope with non-array `windows` field collapses to empty", () => {
    // Defensive against `windows: null` or `windows: "oops"` from
    // a misbehaving helper build.
    const stdout = JSON.stringify({
      windows: null,
      frontmostPid: 1987,
      frontmostBundleId: "com.github.Electron"
    });
    const result = parseHelperOutput(stdout);
    expect(result.windows).toEqual([]);
    // frontmost fields still come through — they're independent
    // of the windows-array integrity.
    expect(result.frontmostPid).toBe(1987);
    expect(result.frontmostBundleId).toBe("com.github.Electron");
  });

  test("envelope with frontmostPid=null comes back as null (no app frontmost)", () => {
    // macOS reports `NSWorkspace.frontmostApplication == nil` during
    // brief transition states. Helper serializes that as JSON null.
    // The warning in region-selector skips when frontmostPid is
    // null, so this case is the "silent succeed" path.
    const stdout = JSON.stringify({
      windows: [],
      frontmostPid: null,
      frontmostBundleId: null
    });
    const result = parseHelperOutput(stdout);
    expect(result.windows).toEqual([]);
    expect(result.frontmostPid).toBeNull();
    expect(result.frontmostBundleId).toBeNull();
  });

  test("parses the Windows helper envelope (exe-path bundleId, backslashes, HWND windowId)", () => {
    // The Windows C++ helper (native/window-list-win/main.cpp) emits the
    // SAME envelope as the Swift helper, but with Windows-flavored field
    // values: `windowId` is the HWND value, `bundleId` is the owning
    // process's full exe path (Windows has no reverse-DNS bundle id),
    // `appName` is the exe basename without extension. This is the exact
    // byte shape that exe produces — including the doubled backslashes a
    // JSON-encoded Windows path carries — so it locks the cross-platform
    // parse path against the Windows producer.
    const stdout =
      '{"windows":[' +
      '{"windowId":133048,"pid":7421,' +
      '"bundleId":"C:\\\\Program Files\\\\Slack\\\\slack.exe",' +
      '"appName":"slack","title":"general - PwrDrvr",' +
      '"bounds":{"x":100,"y":100,"width":800,"height":600},' +
      '"layer":0,"alpha":1,"isFrontmostInApp":true},' +
      '{"windowId":65932,"pid":9001,' +
      '"bundleId":"C:\\\\Windows\\\\explorer.exe",' +
      '"appName":"explorer","title":null,' +
      '"bounds":{"x":0,"y":0,"width":1920,"height":1040},' +
      '"layer":0,"alpha":0.502,"isFrontmostInApp":true}' +
      '],"frontmostPid":7421,' +
      '"frontmostBundleId":"C:\\\\Program Files\\\\Slack\\\\slack.exe"}';
    const result = parseHelperOutput(stdout);
    expect(result.windows).toHaveLength(2);
    const [slack, explorer] = result.windows;
    // exe path survives the backslash round-trip intact.
    expect(slack!.bundleId).toBe("C:\\Program Files\\Slack\\slack.exe");
    expect(slack!.appName).toBe("slack");
    expect(slack!.windowId).toBe(133048);
    expect(slack!.title).toBe("general - PwrDrvr");
    expect(slack!.bounds).toEqual({ x: 100, y: 100, width: 800, height: 600 });
    expect(slack!.isFrontmostInApp).toBe(true);
    // null title + fractional layered alpha both parse cleanly.
    expect(explorer!.title).toBeNull();
    expect(explorer!.alpha).toBeCloseTo(0.502);
    // frontmost cross-check fields propagate, matching the macOS shape so
    // the region-selector z-order/frontmost diagnostic works identically.
    expect(result.frontmostPid).toBe(7421);
    expect(result.frontmostBundleId).toBe("C:\\Program Files\\Slack\\slack.exe");
  });

  test("envelope rejects non-number/non-string frontmost field types", () => {
    // Defensive type-narrowing — if a future helper accidentally
    // serializes the pid as a string ("1987" vs 1987) we want to
    // treat it as missing, not coerce. Keeps the downstream
    // typeof-pid===number assertion in the warning block honest.
    const stdout = JSON.stringify({
      windows: [],
      frontmostPid: "1987",
      frontmostBundleId: 42
    });
    const result = parseHelperOutput(stdout);
    expect(result.frontmostPid).toBeNull();
    expect(result.frontmostBundleId).toBeNull();
  });
});

