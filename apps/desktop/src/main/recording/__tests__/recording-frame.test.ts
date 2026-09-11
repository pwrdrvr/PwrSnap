// Lifecycle for the recording-frame overlay: it exists for exactly the
// phases that are writing pixels, it is never interactive, and it obeys
// the user's `recording.showRegionFrame` preference once per session.

import { beforeEach, describe, expect, test, vi } from "vitest";
import type { RecordingState } from "@pwrsnap/shared";

type WindowSpy = {
  id: number;
  isDestroyed: ReturnType<typeof vi.fn>;
  isVisible: ReturnType<typeof vi.fn>;
  showInactive: ReturnType<typeof vi.fn>;
  moveTop: ReturnType<typeof vi.fn>;
  setBounds: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  webContents: {
    once: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
  };
};

const mocks = vi.hoisted(() => ({
  created: [] as WindowSpy[],
  createdBounds: [] as { x: number; y: number; width: number; height: number }[],
  subscriber: null as ((next: unknown) => void) | null,
  showRegionFrame: true,
  readDomain: vi.fn()
}));

let nextWindowId = 1;

function makeWindowSpy(): WindowSpy {
  let destroyed = false;
  let visible = false;
  const spy: WindowSpy = {
    id: nextWindowId++,
    isDestroyed: vi.fn(() => destroyed),
    isVisible: vi.fn(() => visible),
    showInactive: vi.fn(() => {
      visible = true;
    }),
    moveTop: vi.fn(),
    setBounds: vi.fn(),
    destroy: vi.fn(() => {
      destroyed = true;
    }),
    webContents: {
      // Fire immediately — the production code guards on isDestroyed, so
      // a synchronous load is the strictest ordering we can hand it.
      once: vi.fn((event: string, listener: () => void) => {
        if (event === "did-finish-load") listener();
      }),
      send: vi.fn()
    }
  };
  return spy;
}

vi.mock("electron", () => ({
  screen: {
    getAllDisplays: () => [
      { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 } },
      { id: 2, bounds: { x: 1440, y: 0, width: 1920, height: 1080 } }
    ]
  }
}));

vi.mock("../../window", () => ({
  createRecordingFrameWindow: (bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) => {
    mocks.createdBounds.push(bounds);
    const win = makeWindowSpy();
    mocks.created.push(win);
    return win;
  }
}));

vi.mock("../recording-state", () => ({
  subscribeToRecordingState: (handler: (next: unknown) => void) => {
    mocks.subscriber = handler;
    return () => {
      mocks.subscriber = null;
    };
  }
}));

vi.mock("../../settings/desktop-settings-store", () => ({
  getDesktopSettingsStore: () => ({ readDomain: mocks.readDomain })
}));

vi.mock("../../log", () => ({
  getMainLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  })
}));

const REGION: RecordingState = {
  phase: "recording",
  sessionId: "s1",
  startedAt: new Date().toISOString(),
  rect: { x: 300, y: 200, w: 640, h: 400 },
  displayId: 1
};

/** Push a state through the subscriber and let the internal queue drain. */
async function emit(state: RecordingState): Promise<void> {
  mocks.subscriber?.(state);
  // Two turns: one for the settings read, one for the apply that follows.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function load(): Promise<typeof import("../recording-frame")> {
  vi.resetModules();
  return import("../recording-frame");
}

beforeEach(() => {
  mocks.created.length = 0;
  mocks.createdBounds.length = 0;
  mocks.subscriber = null;
  mocks.showRegionFrame = true;
  mocks.readDomain.mockReset();
  mocks.readDomain.mockImplementation(async () => ({
    showRegionFrame: mocks.showRegionFrame
  }));
});

describe("recording frame lifecycle", () => {
  test("shows for the recording phase and sends the layout it planned", async () => {
    const mod = await load();
    mod.installRecordingFrame();

    await emit(REGION);

    expect(mocks.created).toHaveLength(1);
    expect(mocks.created[0]?.showInactive).toHaveBeenCalled();
    const [channel, payload] = mocks.created[0]?.webContents.send.mock.calls.at(-1) ?? [];
    expect(channel).toBe("events:recording:frame");
    expect(payload).toMatchObject({ mode: expect.any(String), phase: "recording" });

    mod.disposeRecordingFrame();
  });

  test("one window survives the whole session instead of one per transition", async () => {
    const mod = await load();
    mod.installRecordingFrame();

    await emit({ phase: "preflight", sessionId: "s1", rect: REGION.rect, displayId: 1 });
    await emit({
      phase: "countdown",
      sessionId: "s1",
      secondsRemaining: 2,
      rect: REGION.rect,
      displayId: 1
    });
    await emit(REGION);

    expect(mocks.created).toHaveLength(1);
    // The rect never moves inside a session, so the bounds are set once
    // at construction and not re-applied on every tick.
    expect(mocks.created[0]?.setBounds).not.toHaveBeenCalled();
    // ...but the phase does change, and the renderer is told each time.
    const phases = mocks.created[0]?.webContents.send.mock.calls.map(
      (call) => (call[1] as { phase: string }).phase
    );
    expect(phases).toEqual(["arming", "arming", "recording"]);

    mod.disposeRecordingFrame();
  });

  test("survives Stop and fades in place while the encoder exits", async () => {
    // `stopping` and `processing` carry NO rect — by then there is
    // nothing left to describe. Replaying the session's plan is what
    // keeps the frame from blinking out the instant the user clicks
    // Stop, which would read as "already finished" while ffmpeg is still
    // writing the file.
    const mod = await load();
    mod.installRecordingFrame();

    await emit(REGION);
    await emit({ phase: "stopping", sessionId: "s1" });
    await emit({ phase: "processing", sessionId: "s1" });

    expect(mocks.created).toHaveLength(1);
    expect(mocks.created[0]?.destroy).not.toHaveBeenCalled();
    const phases = mocks.created[0]?.webContents.send.mock.calls.map(
      (call) => (call[1] as { phase: string }).phase
    );
    expect(phases).toEqual(["recording", "stopping", "stopping"]);
    // Still hugging the same rect — a fade, not a move.
    expect(mocks.created[0]?.setBounds).not.toHaveBeenCalled();

    mod.disposeRecordingFrame();
  });

  test("a new session never inherits the previous session's geometry", async () => {
    const mod = await load();
    mod.installRecordingFrame();

    await emit(REGION);
    await emit({ phase: "idle" });
    // Second session, stopping first — there is no plan for it, so there
    // is nothing to draw rather than a frame around the OLD rect.
    await emit({ phase: "stopping", sessionId: "s2" });

    expect(mocks.created).toHaveLength(1);
    expect(mod.getRecordingFrameWindowId()).toBeNull();

    mod.disposeRecordingFrame();
  });

  test("is destroyed on every terminal phase, including failure", async () => {
    for (const terminal of ["idle", "ready", "failed"] as const) {
      mocks.created.length = 0;
      const mod = await load();
      mod.installRecordingFrame();
      await emit(REGION);
      expect(mod.getRecordingFrameWindowId()).not.toBeNull();

      await emit(
        terminal === "failed"
          ? {
              phase: "failed",
              sessionId: "s1",
              code: "recorder_exited",
              canRetry: true,
              displayId: 1
            }
          : terminal === "ready"
            ? { phase: "ready", sessionId: "s1", captureId: "c1" }
            : { phase: "idle" }
      );

      expect(mocks.created[0]?.destroy).toHaveBeenCalled();
      expect(mod.getRecordingFrameWindowId()).toBeNull();
      mod.disposeRecordingFrame();
    }
  });

  test("draws nothing when the user turned the frame off", async () => {
    mocks.showRegionFrame = false;
    const mod = await load();
    mod.installRecordingFrame();

    await emit(REGION);

    expect(mocks.created).toHaveLength(0);
    mod.disposeRecordingFrame();
  });

  test("reads the preference once per session, not once per transition", async () => {
    const mod = await load();
    mod.installRecordingFrame();

    await emit({ phase: "preflight", sessionId: "s1", rect: REGION.rect, displayId: 1 });
    await emit(REGION);
    await emit({ phase: "stopping", sessionId: "s1" });

    expect(mocks.readDomain).toHaveBeenCalledTimes(1);
    mod.disposeRecordingFrame();
  });

  test("a settings read that throws still shows the frame", async () => {
    // The frame is the only thing on screen that says a recording is
    // running. Losing it to a transient settings failure is strictly
    // worse than showing it to someone who turned it off.
    mocks.readDomain.mockRejectedValue(new Error("nope"));
    const mod = await load();
    mod.installRecordingFrame();

    await emit(REGION);

    expect(mocks.created).toHaveLength(1);
    mod.disposeRecordingFrame();
  });

  test("draws nothing when the recorded display has gone away", async () => {
    const mod = await load();
    mod.installRecordingFrame();

    await emit({ ...REGION, displayId: 99 });

    expect(mocks.created).toHaveLength(0);
    mod.disposeRecordingFrame();
  });

  test("a region on a secondary display is positioned in global coordinates", async () => {
    const mod = await load();
    mod.installRecordingFrame();

    await emit({ ...REGION, displayId: 2, rect: { x: 100, y: 50, w: 400, h: 300 } });

    expect(mocks.createdBounds[0]?.x).toBeGreaterThan(1440);
    mod.disposeRecordingFrame();
  });

  test("dispose tears the window down even mid-session", async () => {
    const mod = await load();
    mod.installRecordingFrame();
    await emit(REGION);

    mod.disposeRecordingFrame();

    expect(mocks.created[0]?.destroy).toHaveBeenCalled();
    expect(mod.getRecordingFrameWindowId()).toBeNull();
  });
});
