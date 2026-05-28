// Pins the BrowserWindow-aware wrapper around `rectIntersectsBounds`
// — `appWindowsOverlappingRect`. Two call sites depend on it
// (post-commit raise gate in main/index.ts, per-tick re-raise in
// recording-controller.ts), and both rely on the same filters:
// destroyed → out, hidden → out, optional excludeWindow → out,
// rect not intersecting → out.
//
// The pure geometry primitive `rectIntersectsBounds` is tested
// separately in rect-intersects-bounds.test.ts; this file mocks
// `BrowserWindow.getAllWindows()` + `screen.getAllDisplays()` so we
// can drive the surrounding state.

import type { BrowserWindow } from "electron";
import { beforeEach, describe, expect, test, vi } from "vitest";

type BrowserWindowSpy = {
  isDestroyed: () => boolean;
  isVisible: () => boolean;
  getBounds: () => { x: number; y: number; width: number; height: number };
};

/**
 * Cast a spy to BrowserWindow at the test boundary. The mock only
 * stubs the four methods the helper touches (`isDestroyed`,
 * `isVisible`, `getBounds`, and the `===` identity used by
 * `excludeWindow`); BrowserWindow has 170+ other methods we don't
 * need. The cast keeps the helper's strict `BrowserWindow`
 * parameter type intact in production code.
 */
function asBrowserWindow(spy: BrowserWindowSpy): BrowserWindow {
  return spy as unknown as BrowserWindow;
}

const visibleWindows: BrowserWindowSpy[] = [];

// One primary display at virtual-screen origin and one secondary to
// the LEFT of it. The rect helper accepts display-local logical px
// and converts to virtual-screen by adding `display.bounds.{x,y}`,
// so a secondary at negative origin exercises the offset arithmetic.
const PRIMARY = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1080 }
};
const SECONDARY = {
  id: 2,
  bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
  workArea: { x: -1920, y: 0, width: 1920, height: 1080 }
};

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => visibleWindows
  },
  screen: {
    getAllDisplays: () => [PRIMARY, SECONDARY],
    getPrimaryDisplay: () => PRIMARY
  }
}));

beforeEach(() => {
  visibleWindows.length = 0;
  vi.resetModules();
});

function makeWindow(
  bounds: { x: number; y: number; width: number; height: number },
  overrides: Partial<BrowserWindowSpy> = {}
): BrowserWindowSpy {
  return {
    isDestroyed: () => false,
    isVisible: () => true,
    getBounds: () => bounds,
    ...overrides
  };
}

describe("appWindowsOverlappingRect", () => {
  test("returns visible windows whose bounds intersect the rect", async () => {
    const library = makeWindow({ x: 0, y: 0, width: 960, height: 1080 });
    const settings = makeWindow({ x: 1200, y: 0, width: 400, height: 400 });
    visibleWindows.push(library, settings);

    const { appWindowsOverlappingRect } = await import("../capture/rect-overlap");
    const overlapping = appWindowsOverlappingRect(
      { x: 100, y: 100, w: 400, h: 300 },
      PRIMARY.id
    );
    expect(overlapping).toEqual([library]);
  });

  test("returns empty when no display matches displayId", async () => {
    visibleWindows.push(makeWindow({ x: 0, y: 0, width: 1920, height: 1080 }));

    const { appWindowsOverlappingRect } = await import("../capture/rect-overlap");
    expect(
      appWindowsOverlappingRect({ x: 0, y: 0, w: 100, h: 100 }, /* unknown */ 999)
    ).toEqual([]);
  });

  test("hidden windows are filtered out even if their bounds match", async () => {
    // Minimized Library — bounds still report the un-minimized rect
    // but `isVisible()` returns false. We should NOT raise it: the
    // user can't see it, can't have meant to record it.
    const hidden = makeWindow(
      { x: 0, y: 0, width: 800, height: 600 },
      { isVisible: () => false }
    );
    visibleWindows.push(hidden);

    const { appWindowsOverlappingRect } = await import("../capture/rect-overlap");
    expect(
      appWindowsOverlappingRect({ x: 100, y: 100, w: 200, h: 200 }, PRIMARY.id)
    ).toEqual([]);
  });

  test("destroyed windows are filtered out", async () => {
    // `BrowserWindow.getAllWindows()` may briefly include a window
    // that's mid-teardown (closed-but-not-yet-collected). Calling
    // getBounds() on a destroyed window throws in Electron; the
    // helper has to short-circuit BEFORE the bounds check.
    const destroyed = makeWindow(
      { x: 0, y: 0, width: 800, height: 600 },
      {
        isDestroyed: () => true,
        getBounds: () => {
          throw new Error("getBounds() on destroyed window");
        }
      }
    );
    visibleWindows.push(destroyed);

    const { appWindowsOverlappingRect } = await import("../capture/rect-overlap");
    expect(() =>
      appWindowsOverlappingRect({ x: 100, y: 100, w: 200, h: 200 }, PRIMARY.id)
    ).not.toThrow();
    expect(
      appWindowsOverlappingRect({ x: 100, y: 100, w: 200, h: 200 }, PRIMARY.id)
    ).toEqual([]);
  });

  test("excludeWindow opts a specific window out of the result", async () => {
    const library = makeWindow({ x: 0, y: 0, width: 1920, height: 1080 });
    const hud = makeWindow({ x: 100, y: 100, width: 400, height: 300 });
    visibleWindows.push(library, hud);

    const { appWindowsOverlappingRect } = await import("../capture/rect-overlap");
    // No exclusion: both match.
    expect(
      appWindowsOverlappingRect({ x: 100, y: 100, w: 400, h: 300 }, PRIMARY.id)
    ).toEqual([library, hud]);
    // With exclusion: HUD is filtered out, only the user window
    // remains. This is the recording-controller's per-tick use case —
    // it passes its own HUD here so the re-raise loop doesn't
    // moveTop the HUD against itself.
    expect(
      appWindowsOverlappingRect(
        { x: 100, y: 100, w: 400, h: 300 },
        PRIMARY.id,
        asBrowserWindow(hud)
      )
    ).toEqual([library]);
  });

  test("translates display-local rect coords by display.bounds offset", async () => {
    // Window on the secondary monitor at virtual-screen (-1500, 200).
    // A display-local rect at (200, 100) on the SECONDARY display
    // translates to virtual-screen (-1720, 100). The wrapper has to
    // add display.bounds.{x,y} before hit-testing; getting the sign
    // wrong on the secondary's negative origin is the obvious bug.
    const secondaryWin = makeWindow({ x: -1500, y: 200, width: 800, height: 600 });
    visibleWindows.push(secondaryWin);

    const { appWindowsOverlappingRect } = await import("../capture/rect-overlap");
    // Rect display-local (500, 300) on secondary → virtual-screen
    // (-1420, 300) — squarely inside the window.
    expect(
      appWindowsOverlappingRect({ x: 500, y: 300, w: 100, h: 100 }, SECONDARY.id)
    ).toEqual([secondaryWin]);
    // Rect display-local (500, 300) on PRIMARY → virtual-screen
    // (500, 300) — way off the secondary window.
    expect(
      appWindowsOverlappingRect({ x: 500, y: 300, w: 100, h: 100 }, PRIMARY.id)
    ).toEqual([]);
  });

  test("returns empty when no visible windows are open", async () => {
    const { appWindowsOverlappingRect } = await import("../capture/rect-overlap");
    expect(
      appWindowsOverlappingRect({ x: 100, y: 100, w: 400, h: 300 }, PRIMARY.id)
    ).toEqual([]);
  });
});
