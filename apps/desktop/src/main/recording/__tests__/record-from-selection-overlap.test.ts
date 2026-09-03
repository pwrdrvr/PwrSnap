// Pins the ONE thing the rect-overlap unit tests cannot: that this
// call site hands `selection.rect` to the GLOBAL overlap entry point.
//
// The double-add defect was never in the helper — the arithmetic there
// was always right. It was a call site passing a global
// `SelectorResult.rect` into a display-local parameter, and it shipped
// that way twice. Both entry points take a bare `Rect`, so swapping
// them back still typechecks and still passes every test in
// app-windows-overlapping-rect.test.ts. Only an assertion at the call
// site catches it.

import { beforeEach, describe, expect, test, vi } from "vitest";

/** A display with a non-zero origin on both axes — the real config the
 *  double-add was measured on. At (0,0) this test cannot fail. */
const SKEWED = { id: 3, bounds: { x: 1496, y: -473, width: 2560, height: 1440 } };

const globalCalls: { x: number; y: number; w: number; h: number }[] = [];
const displayLocalCalls: unknown[] = [];

vi.mock("../../capture/rect-overlap", () => ({
  appWindowsOverlappingGlobalRect: (rect: { x: number; y: number; w: number; h: number }) => {
    globalCalls.push(rect);
    return [];
  },
  appWindowsOverlappingRect: (...args: unknown[]) => {
    displayLocalCalls.push(args);
    return [];
  }
}));

vi.mock("electron", () => ({
  app: { dock: { isVisible: () => true } },
  Notification: Object.assign(function () {}, { isSupported: () => false }),
  screen: { getAllDisplays: () => [SKEWED] }
}));

const dispatch = vi.fn(async (..._args: unknown[]) => ({ ok: true as const, value: undefined }));
vi.mock("../../command-bus", () => ({ bus: { dispatch } }));
vi.mock("../../float-over", () => ({ setFloatOverState: () => undefined }));
vi.mock("../../log", () => ({
  getMainLogger: () => ({ debug: () => undefined, info: () => undefined, warn: () => undefined })
}));
vi.mock("../../capture/region-selector", () => ({
  getLastWindowListSnapshot: () => [],
  hideSelector: () => undefined
}));
vi.mock("../../capture/screen-snapshot", () => ({ releaseSnapshot: () => undefined }));
vi.mock("../../capture/source-app", () => ({
  resolveSelectionSourceApp: () => null,
  // True for every free-hand drag — the common path, and the one the
  // defect sat on.
  shouldConsiderRaisingOurWindows: () => true
}));
vi.mock("../../capture/window-list", () => ({
  activateApp: async () => undefined,
  selfPidSet: () => new Set<number>()
}));
vi.mock("../../window", () => ({
  findMainLibraryWindow: () => null,
  reclaimDockIconIfLibraryAlive: () => undefined,
  scheduleDockReclaim: () => undefined
}));
vi.mock("../recording-state", () => ({ getRecordingState: () => ({ phase: "idle" }) }));

beforeEach(() => {
  globalCalls.length = 0;
  displayLocalCalls.length = 0;
  dispatch.mockClear();
});

describe("startRecordingFromSelection — overlap coordinate space", () => {
  test("passes the selector's global rect to the global entry point, unconverted", async () => {
    const { startRecordingFromSelection } = await import("../record-from-selection");

    // What region-selector.ts resolves for a drag on SKEWED: the
    // renderer's display-local (500, 400) already translated to global.
    const selectorRect = { x: SKEWED.bounds.x + 500, y: SKEWED.bounds.y + 400, w: 600, h: 400 };

    await startRecordingFromSelection(
      {
        ok: true,
        rect: selectorRect,
        displayId: SKEWED.id,
        screenSnapshotId: "snap-1",
        previousAppPid: null
      },
      { includeSystemAudio: false, includeMicrophone: false, videoCaptureCursor: false }
    );

    // The global variant is the one consulted...
    expect(globalCalls).toHaveLength(1);
    // ...with the rect verbatim. Any origin arithmetic on the way in —
    // in either direction — changes these numbers.
    expect(globalCalls[0]).toEqual(selectorRect);
    // ...and the display-local sibling is never reached. Calling it
    // with this rect is exactly the shipped defect.
    expect(displayLocalCalls).toEqual([]);
  });
});
