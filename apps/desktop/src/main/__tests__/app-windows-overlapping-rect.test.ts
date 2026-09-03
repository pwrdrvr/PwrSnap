// Pins the BrowserWindow-aware wrappers around `rectIntersectsBounds`
// — `appWindowsOverlappingGlobalRect` (global virtual-screen coords,
// used by the post-commit raise gate in main/index.ts) and
// `appWindowsOverlappingRect` (display-local coords, used by the
// per-tick re-raise in recording-controller.ts). Both rely on the
// same filters: destroyed → out, hidden → out, optional
// excludeWindow → out, rect not intersecting → out.
//
// This file also pins the COORDINATE-SPACE boundary between them,
// which is the thing that has actually broken in production: a
// caller holding a `SelectorResult.rect` holds a GLOBAL rect, and
// feeding one to the display-local entry point adds the display
// origin twice. That is a no-op on a primary display at (0,0), so
// the displays below deliberately include one with a non-zero origin
// on BOTH axes — see SKEWED.
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

// One primary display at the virtual-screen origin and a secondary
// to the LEFT of it. `appWindowsOverlappingRect` accepts display-
// local logical px and converts to virtual-screen by adding
// `display.bounds.{x,y}`, so a secondary at negative origin
// exercises the offset arithmetic.
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
// A third display whose origin is non-zero on BOTH axes, with
// opposite signs. These are the real bounds from the desk where the
// double-add was found — a 2560×1440 secondary at {x:1496, y:-473}.
// PRIMARY (0,0) hides every origin bug, and SECONDARY (y=0) still
// hides a dropped or sign-flipped Y term, so an assertion that
// actually constrains the arithmetic has to run against this one.
const SKEWED = {
  id: 3,
  bounds: { x: 1496, y: -473, width: 2560, height: 1440 },
  workArea: { x: 1496, y: -473, width: 2560, height: 1440 }
};

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => visibleWindows
  },
  screen: {
    getAllDisplays: () => [PRIMARY, SECONDARY, SKEWED],
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

describe("appWindowsOverlappingRect on a display with a non-zero origin", () => {
  // PRIMARY sits at (0,0), so every test above passes whether or not
  // the display origin is applied at all. SECONDARY catches a dropped
  // X term. Neither catches a dropped or sign-flipped Y term, because
  // both have `bounds.y === 0`. SKEWED — {x:1496, y:-473}, the real
  // config the production double-add was measured on — catches both.
  test("adds bounds.x AND bounds.y to place a display-local rect", async () => {
    // Library on SKEWED, 200px in and 100px down from that display's
    // own top-left: virtual-screen (1696, -373).
    const library = makeWindow({ x: 1696, y: -373, width: 900, height: 700 });
    visibleWindows.push(library);

    const { appWindowsOverlappingRect } = await import("../capture/rect-overlap");
    // Display-local (300, 200) on SKEWED → virtual-screen
    // (1796, -273), squarely inside the window.
    expect(
      appWindowsOverlappingRect({ x: 300, y: 200, w: 400, h: 300 }, SKEWED.id)
    ).toEqual([library]);
  });

  test("a display-local rect above the window misses on the Y axis", async () => {
    // Same window, but a rect whose display-local Y puts it entirely
    // above the window. Only correct Y arithmetic separates this from
    // the hit above: drop `bounds.y` and BOTH land at y≈200, inside
    // the window's un-offset span, and this assertion flips to a hit.
    const library = makeWindow({ x: 1696, y: -373, width: 900, height: 700 });
    visibleWindows.push(library);

    const { appWindowsOverlappingRect } = await import("../capture/rect-overlap");
    // Display-local (300, 0) on SKEWED → virtual-screen (1796, -473),
    // 100px above the window's top edge, height 100 → bottom edge at
    // -373, which is edge contact, not overlap.
    expect(
      appWindowsOverlappingRect({ x: 300, y: 0, w: 400, h: 100 }, SKEWED.id)
    ).toEqual([]);
  });

  test("the same display-local rect resolves differently per display", async () => {
    // One window per display, all at the same DISPLAY-LOCAL offset.
    // A single display-local rect must select exactly the window on
    // the display it names — the property the offset add exists for.
    const onPrimary = makeWindow({ x: 100, y: 100, width: 600, height: 400 });
    const onSecondary = makeWindow({ x: -1820, y: 100, width: 600, height: 400 });
    const onSkewed = makeWindow({ x: 1596, y: -373, width: 600, height: 400 });
    visibleWindows.push(onPrimary, onSecondary, onSkewed);

    const { appWindowsOverlappingRect } = await import("../capture/rect-overlap");
    const local = { x: 150, y: 150, w: 200, h: 100 };
    expect(appWindowsOverlappingRect(local, PRIMARY.id)).toEqual([onPrimary]);
    expect(appWindowsOverlappingRect(local, SECONDARY.id)).toEqual([onSecondary]);
    expect(appWindowsOverlappingRect(local, SKEWED.id)).toEqual([onSkewed]);
  });
});

describe("appWindowsOverlappingGlobalRect", () => {
  test("hit-tests a global rect directly, with no display offset", async () => {
    // The global variant takes no displayId and does no arithmetic —
    // `getBounds()` is already in this space. Same rect, same window,
    // no display involved.
    const library = makeWindow({ x: 1696, y: -373, width: 900, height: 700 });
    visibleWindows.push(library);

    const { appWindowsOverlappingGlobalRect } = await import("../capture/rect-overlap");
    expect(
      appWindowsOverlappingGlobalRect({ x: 1796, y: -273, w: 400, h: 300 })
    ).toEqual([library]);
    // Somewhere else on the virtual desktop entirely.
    expect(
      appWindowsOverlappingGlobalRect({ x: 0, y: 0, w: 400, h: 300 })
    ).toEqual([]);
  });

  test("applies the same destroyed / hidden / exclude filters", async () => {
    const library = makeWindow({ x: 0, y: 0, width: 1920, height: 1080 });
    const hud = makeWindow({ x: 100, y: 100, width: 400, height: 300 });
    const hidden = makeWindow(
      { x: 100, y: 100, width: 400, height: 300 },
      { isVisible: () => false }
    );
    const destroyed = makeWindow(
      { x: 100, y: 100, width: 400, height: 300 },
      {
        isDestroyed: () => true,
        getBounds: () => {
          throw new Error("getBounds() on destroyed window");
        }
      }
    );
    visibleWindows.push(library, hud, hidden, destroyed);

    const { appWindowsOverlappingGlobalRect } = await import("../capture/rect-overlap");
    const rect = { x: 100, y: 100, w: 400, h: 300 };
    expect(appWindowsOverlappingGlobalRect(rect)).toEqual([library, hud]);
    expect(appWindowsOverlappingGlobalRect(rect, asBrowserWindow(hud))).toEqual([
      library
    ]);
  });
});

describe("global vs display-local entry points", () => {
  // Regression pin for the double-add. `SelectorResult.rect` is
  // GLOBAL — region-selector.ts adds `display.bounds.{x,y}` before
  // resolving — so passing one to `appWindowsOverlappingRect` applies
  // the origin a second time. Two call sites shipped that mistake
  // (main/index.ts's post-commit raise gate, and the record-from-
  // selection path), and neither was visible in test or on a primary
  // display, because at (0,0) the second add is the identity.
  test("a global selector rect must use the global entry point", async () => {
    // The Library on SKEWED, at display-local (400, 300), 1200×800 →
    // global x 1896..3096, y -173..627.
    const library = makeWindow({ x: 1896, y: -173, width: 1200, height: 800 });
    visibleWindows.push(library);

    // What the selector resolves for a drag squarely inside it:
    // display-local (500, 400) 600×400, translated by SKEWED's origin
    // → global x 1996..2596, y -73..327.
    const selectorRect = { x: 1996, y: -73, w: 600, h: 400 };

    const { appWindowsOverlappingRect, appWindowsOverlappingGlobalRect } =
      await import("../capture/rect-overlap");

    // Correct: the global rect goes to the global entry point.
    expect(appWindowsOverlappingGlobalRect(selectorRect)).toEqual([library]);

    // The bug: the same global rect handed to the display-local entry
    // point has SKEWED's origin applied a second time, landing at
    // x 3492..4092, y -546..-146 — clear of the Library on both axes,
    // and in fact off the display it was selected on. It matches
    // nothing, so PwrSnap silently declines to raise itself into its
    // own recording.
    expect(appWindowsOverlappingRect(selectorRect, SKEWED.id)).toEqual([]);
  });

  test("on the primary display the two entry points agree", async () => {
    // Why the bug survived review and shipped twice: with
    // `bounds.{x,y}` at zero the double-add is unobservable, so a
    // single-display dev machine and every PRIMARY-based test above
    // report the mistake as correct.
    const library = makeWindow({ x: 0, y: 0, width: 1920, height: 1080 });
    visibleWindows.push(library);

    const { appWindowsOverlappingRect, appWindowsOverlappingGlobalRect } =
      await import("../capture/rect-overlap");
    const rect = { x: 100, y: 100, w: 400, h: 300 };
    expect(appWindowsOverlappingGlobalRect(rect)).toEqual([library]);
    expect(appWindowsOverlappingRect(rect, PRIMARY.id)).toEqual([library]);
  });
});
