// Pins the per-phase HUD geometry decision in recording-controller.
//
// Pre-fix, the pre-roll phases (preflight / countdown / starting)
// ALWAYS called fillRect — sized the HUD to the recorded rect and
// positioned it on top of the surface about to be captured. The
// translucent orange wedge in the countdown leader then covered the
// Library / edit / Sizzle / Settings window entirely during the 3s
// pre-roll. The image-capture flow doesn't do this; the video flow
// has to match for PwrSnap-window subjects.
//
// New behavior: when the recording rect overlaps a visible PwrSnap
// top-level window (detected via `appWindowsOverlappingRect`), the
// HUD uses anchorTopCenter with a compact size instead, leaving the
// underlying surface visible during the countdown. Non-overlap
// subjects keep the immersive on-surface countdown.

import { beforeEach, describe, expect, test, vi } from "vitest";

type WindowSpy = {
  setIgnoreMouseEvents: ReturnType<typeof vi.fn>;
  setContentSize: ReturnType<typeof vi.fn>;
  setPosition: ReturnType<typeof vi.fn>;
  showInactive: ReturnType<typeof vi.fn>;
  moveTop: ReturnType<typeof vi.fn>;
  isVisible: ReturnType<typeof vi.fn>;
  isDestroyed: ReturnType<typeof vi.fn>;
  getSize: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
};

const hudSpy: { instance: WindowSpy | null } = { instance: null };

function makeHudSpy(): WindowSpy {
  return {
    setIgnoreMouseEvents: vi.fn(),
    setContentSize: vi.fn(),
    setPosition: vi.fn(),
    showInactive: vi.fn(),
    moveTop: vi.fn(),
    isVisible: vi.fn(() => false),
    isDestroyed: vi.fn(() => false),
    getSize: vi.fn(() => [280, 60]),
    hide: vi.fn(),
    destroy: vi.fn(),
    on: vi.fn()
  };
}

// One display at the virtual-screen origin. The recording flow's
// `physicalRect` is display-local, so the controller adds
// display.bounds (0,0 here) to translate back to virtual coords.
const DISPLAY = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1080 }
};

// The "user windows" that may or may not be visible during the test.
// Each spec resets this between runs to model "Library open" vs.
// "no PwrSnap windows on screen."
type BrowserWindowSpy = {
  isDestroyed: () => boolean;
  isVisible: () => boolean;
  getBounds: () => { x: number; y: number; width: number; height: number };
};
const visibleBrowserWindows: BrowserWindowSpy[] = [];

vi.mock("electron", () => ({
  BrowserWindow: {
    // `appWindowsOverlappingRect` iterates this list when deciding
    // HUD shape. The recording-controller's own ensureWindow() goes
    // through `createRecordingControllerWindow` (mocked separately
    // below), so the HUD itself never appears in this array.
    getAllWindows: () => visibleBrowserWindows
  },
  screen: {
    getAllDisplays: () => [DISPLAY],
    getPrimaryDisplay: () => DISPLAY
  }
}));

vi.mock("../../window", () => ({
  createRecordingControllerWindow: () => {
    const spy = makeHudSpy();
    hudSpy.instance = spy;
    return spy;
  }
}));

vi.mock("../recording-state", () => ({
  subscribeToRecordingState: vi.fn()
}));

vi.mock("../../log", () => ({
  getMainLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  })
}));

beforeEach(() => {
  hudSpy.instance = null;
  visibleBrowserWindows.length = 0;
  vi.resetModules();
});

describe("recording-controller HUD shape during pre-roll", () => {
  test("subject overlaps Library → anchor top-center, do NOT fill the rect", async () => {
    // Library covers the left half of the display. Recording rect is
    // a 400×300 region squarely on top of it.
    visibleBrowserWindows.push({
      isDestroyed: () => false,
      isVisible: () => true,
      getBounds: () => ({ x: 0, y: 0, width: 960, height: 1080 })
    });

    const { applyRecordingStateToController } = await import("../recording-controller");
    applyRecordingStateToController({
      phase: "countdown",
      sessionId: "s1",
      secondsRemaining: 3,
      rect: { x: 100, y: 100, w: 400, h: 300 },
      displayId: DISPLAY.id
    });

    const spy = hudSpy.instance;
    expect(spy).not.toBeNull();
    // Compact pre-roll size, top-center anchored. NOT the 400×300
    // rect size — that's the bug we're fixing.
    expect(spy!.setContentSize).toHaveBeenCalledWith(280, 220, false);
    expect(spy!.setPosition).toHaveBeenCalledTimes(1);
    // Top-center anchor: x = (1920 - hudWidth) / 2, y ≈ 16 below the
    // workArea top. The HUD's getSize is mocked to [280, 60] so the
    // exact x lands at (1920 - 280) / 2 = 820, but we just assert
    // the y is near the workArea top to confirm anchorTopCenter ran.
    const [, posY] = spy!.setPosition.mock.calls[0]!;
    expect(posY).toBeLessThan(40);
  });

  test("subject does NOT overlap any of our windows → fillRect as before", async () => {
    // No PwrSnap windows on screen — the user is recording something
    // else entirely. The immersive on-surface countdown should run.
    const { applyRecordingStateToController } = await import("../recording-controller");
    applyRecordingStateToController({
      phase: "countdown",
      sessionId: "s1",
      secondsRemaining: 3,
      rect: { x: 600, y: 400, w: 800, h: 600 },
      displayId: DISPLAY.id
    });

    const spy = hudSpy.instance;
    expect(spy).not.toBeNull();
    // HUD sized to match the recorded rect, NOT the compact 280×220.
    expect(spy!.setContentSize).toHaveBeenCalledWith(800, 600, false);
    // Position is the rect's top-left in virtual-screen coords
    // (display.bounds is 0,0 → rect coords pass through unchanged).
    expect(spy!.setPosition).toHaveBeenCalledWith(600, 400, false);
  });

  test("PwrSnap window present but not overlapping the recording rect → still fillRect", async () => {
    // Library on the left half, but the user is recording the right
    // half. No visual overlap → immersive countdown is fine.
    visibleBrowserWindows.push({
      isDestroyed: () => false,
      isVisible: () => true,
      getBounds: () => ({ x: 0, y: 0, width: 800, height: 1080 })
    });

    const { applyRecordingStateToController } = await import("../recording-controller");
    applyRecordingStateToController({
      phase: "countdown",
      sessionId: "s1",
      secondsRemaining: 3,
      rect: { x: 1000, y: 100, w: 800, h: 600 },
      displayId: DISPLAY.id
    });

    const spy = hudSpy.instance;
    expect(spy!.setContentSize).toHaveBeenCalledWith(800, 600, false);
  });

  test("hidden PwrSnap window doesn't trigger the top-center branch", async () => {
    // Library exists but minimized / hidden. isVisible() === false
    // means the user can't see it; the recording rect intersects
    // its bounds but the user isn't trying to record it.
    visibleBrowserWindows.push({
      isDestroyed: () => false,
      isVisible: () => false,
      getBounds: () => ({ x: 0, y: 0, width: 1920, height: 1080 })
    });

    const { applyRecordingStateToController } = await import("../recording-controller");
    applyRecordingStateToController({
      phase: "countdown",
      sessionId: "s1",
      secondsRemaining: 3,
      rect: { x: 100, y: 100, w: 400, h: 300 },
      displayId: DISPLAY.id
    });

    const spy = hudSpy.instance;
    expect(spy!.setContentSize).toHaveBeenCalledWith(400, 300, false);
  });
});
