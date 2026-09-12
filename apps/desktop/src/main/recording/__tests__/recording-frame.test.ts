// Lifecycle for the recording-frame overlay: it exists for exactly the
// phases that are writing pixels, it is never interactive, and it obeys
// the user's `recording.showRegionFrame` preference once per session.

import { beforeEach, describe, expect, test, vi } from "vitest";
import type { RecordingState } from "@pwrsnap/shared";
import { RECORDING_FRAME_BAND_PX } from "../recording-frame-geometry";

type WindowSpy = {
  id: number;
  isDestroyed: ReturnType<typeof vi.fn>;
  isVisible: ReturnType<typeof vi.fn>;
  showInactive: ReturnType<typeof vi.fn>;
  moveTop: ReturnType<typeof vi.fn>;
  setBounds: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  webContents: {
    on: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
  };
  /** Re-fire `did-finish-load`, the way a renderer crash-and-reload does. */
  reload: () => void;
};

const mocks = vi.hoisted(() => ({
  created: [] as WindowSpy[],
  createdBounds: [] as { x: number; y: number; width: number; height: number }[],
  subscriber: null as ((next: unknown) => void) | null,
  /** Handlers registered on `screen`, by event name. */
  displayListeners: new Map<string, () => void>(),
  /** What `getRecordingState()` answers when the display metrics change. */
  currentState: { phase: "idle" } as unknown,
  displays: [
    { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 } },
    { id: 2, bounds: { x: 1440, y: 0, width: 1920, height: 1080 } }
  ],
  showRegionFrame: true,
  readDomain: vi.fn()
}));

let nextWindowId = 1;

function makeWindowSpy(): WindowSpy {
  let destroyed = false;
  let visible = false;
  const loadListeners: (() => void)[] = [];
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
      on: vi.fn((event: string, listener: () => void) => {
        if (event !== "did-finish-load") return;
        loadListeners.push(listener);
        listener();
      }),
      send: vi.fn()
    },
    reload: () => {
      for (const listener of loadListeners) listener();
    }
  };
  return spy;
}

vi.mock("electron", () => ({
  screen: {
    getAllDisplays: () => mocks.displays,
    on: (event: string, handler: () => void) => {
      mocks.displayListeners.set(event, handler);
    },
    removeListener: (event: string) => {
      mocks.displayListeners.delete(event);
    }
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
  },
  getRecordingState: () => mocks.currentState
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

// Narrowed to the recording arm, not the whole union: the tests below read
// `REGION.rect` and spread it with an override, and neither is expressible
// against a union whose `idle` member has no `rect` and no `displayId`.
const REGION: Extract<RecordingState, { phase: "recording" }> = {
  phase: "recording",
  sessionId: "s1",
  startedAt: new Date().toISOString(),
  rect: { x: 300, y: 200, w: 640, h: 400 },
  displayId: 1,
  // What the take asked for. The frame does not read it; it is part of the
  // recording state so the HUD and the post-capture receipt can agree with
  // each other about what was armed.
  capabilities: { microphone: false, systemAudio: false }
};

let loaded: typeof import("../recording-frame") | null = null;

/** Push a state through the subscriber and let the internal queue drain. */
async function emit(state: RecordingState): Promise<void> {
  mocks.currentState = state;
  mocks.subscriber?.(state);
  // Await the module's own queue rather than counting microtask turns.
  // A fixed number of `await Promise.resolve()` stops covering `apply`
  // the moment it gains another await, and every assertion below that
  // checks for ABSENCE would then pass against a queue that never ran.
  await loaded?.whenRecordingFrameIdle();
}

async function load(): Promise<typeof import("../recording-frame")> {
  vi.resetModules();
  loaded = await import("../recording-frame");
  return loaded;
}

beforeEach(() => {
  mocks.created.length = 0;
  mocks.createdBounds.length = 0;
  mocks.subscriber = null;
  mocks.displayListeners.clear();
  mocks.currentState = { phase: "idle" };
  mocks.displays = [
    { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 } },
    { id: 2, bounds: { x: 1440, y: 0, width: 1920, height: 1080 } }
  ];
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

  test("a plan we refused is not replayed once the rect stops arriving", async () => {
    // The display is unplugged mid-session. `planForRect` refuses, the
    // window goes away — and the stored plan must go with it, or the
    // rect-less `stopping` below brings the frame back at bounds on a
    // display that no longer exists.
    const mod = await load();
    mod.installRecordingFrame();

    await emit({ phase: "preflight", sessionId: "s1", rect: REGION.rect, displayId: 1 });
    expect(mod.getRecordingFrameWindowId()).not.toBeNull();

    mocks.displays = [{ id: 2, bounds: { x: 1440, y: 0, width: 1920, height: 1080 } }];
    await emit(REGION);
    expect(mod.getRecordingFrameWindowId()).toBeNull();

    await emit({ phase: "stopping", sessionId: "s1" });

    expect(mocks.created).toHaveLength(1);
    expect(mod.getRecordingFrameWindowId()).toBeNull();

    mod.disposeRecordingFrame();
  });

  test("a dispose during the settings read does not leave a window behind", async () => {
    // App quit tears every transient window down, and the settings read
    // is a real disk read — so teardown can land inside it. The
    // continuation must not construct an always-on-top panel that
    // nothing is left to destroy.
    let release: (domain: { showRegionFrame: boolean }) => void = () => undefined;
    const pending = new Promise<{ showRegionFrame: boolean }>((resolve) => {
      release = resolve;
    });
    mocks.readDomain.mockImplementation(() => pending);
    const mod = await load();
    mod.installRecordingFrame();

    mocks.subscriber?.(REGION);
    const drained = mod.whenRecordingFrameIdle();
    mod.disposeRecordingFrame();
    release({ showRegionFrame: true });
    await drained;

    expect(mocks.created).toHaveLength(0);
    expect(mod.getRecordingFrameWindowId()).toBeNull();
  });

  test("a renderer reload gets the layout again", async () => {
    // Nothing else would re-send it: recording-state emits only on an
    // explicit transition, and there is none between `starting` and
    // `stopping`. A one-shot load listener left the rest of the take
    // with a transparent window and no frame.
    const mod = await load();
    mod.installRecordingFrame();
    await emit(REGION);

    const win = mocks.created[0];
    const before = win?.webContents.send.mock.calls.length ?? 0;
    win?.reload();

    expect(win?.webContents.send.mock.calls.length).toBe(before + 1);
    expect(win?.webContents.send.mock.calls.at(-1)?.[1]).toMatchObject({ phase: "recording" });

    mod.disposeRecordingFrame();
  });

  test("a display metrics change re-plans without waiting for a transition", async () => {
    const mod = await load();
    mod.installRecordingFrame();
    await emit({ ...REGION, displayId: 2 });
    expect(mocks.created[0]?.setBounds).not.toHaveBeenCalled();

    // The display's origin moved; the recorded rect's global position
    // moved with it, and no recording transition says so.
    mocks.displays = [
      { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 } },
      { id: 2, bounds: { x: 1600, y: 0, width: 1920, height: 1080 } }
    ];
    mocks.displayListeners.get("display-metrics-changed")?.();
    await mod.whenRecordingFrameIdle();

    expect(mocks.created).toHaveLength(1);
    expect(mocks.created[0]?.setBounds).toHaveBeenCalledWith(
      expect.objectContaining({ x: 1600 + REGION.rect.x - RECORDING_FRAME_BAND_PX }),
      false
    );

    mod.disposeRecordingFrame();
  });

  test("dispose tears the window down even mid-session", async () => {
    const mod = await load();
    mod.installRecordingFrame();
    await emit(REGION);

    mod.disposeRecordingFrame();

    expect(mocks.created[0]?.destroy).toHaveBeenCalled();
    expect(mod.getRecordingFrameWindowId()).toBeNull();
    // ...including the screen listener, which would otherwise keep
    // re-planning against a module that is no longer installed.
    expect(mocks.displayListeners.has("display-metrics-changed")).toBe(false);
  });
});
