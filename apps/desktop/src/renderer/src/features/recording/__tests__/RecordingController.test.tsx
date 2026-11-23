// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import type {
  RecordingBackendCapabilities,
  RecordingCapabilities,
  RecordingState
} from "@pwrsnap/shared";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  requestResize: vi.fn(),
  listeners: new Map<string, (payload: unknown) => void>()
}));

vi.mock("../../../lib/pwrsnap", () => ({
  dispatch: (...args: unknown[]) => mocks.dispatch(...args)
}));

import { RecordingController, recordingSourceChips } from "../RecordingController";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  class ResizeObserverStub {
    constructor(_callback: ResizeObserverCallback) {}
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
});

let container: HTMLDivElement;
let root: Root;

const failure: Extract<RecordingState, { phase: "failed" }> = {
  phase: "failed",
  sessionId: "failed-session",
  code: "recorder_spawn_failed",
  canRetry: true,
  displayId: 1
};

const macCapabilities: RecordingBackendCapabilities = {
  backend: "macos-native",
  controls: { stop: true, cancel: true, restart: true, pauseResume: false },
  sources: {
    screen: true,
    systemAudio: true,
    microphone: true,
    webcam: false,
    liveAudioLevels: false,
    liveDisconnectDetection: false,
    midRecordingToggles: false
  },
  outputs: { burst: true },
  controllerExcludedFromCapture: true
};

function recordingState(rect = { x: 10, y: 20, w: 800, h: 600 }): RecordingState {
  return {
    phase: "recording",
    sessionId: "rec-1",
    startedAt: new Date(Date.now() - 65_000).toISOString(),
    rect,
    displayId: 1,
    capabilities: { systemAudio: false, microphone: false }
  };
}

beforeEach(() => {
  mocks.dispatch.mockReset();
  mocks.requestResize.mockReset();
  mocks.listeners.clear();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    right: 480,
    bottom: 190,
    left: 0,
    width: 480,
    height: 190,
    toJSON: () => ({})
  });
  mocks.dispatch.mockImplementation(async (name: string) => {
    if (name === "recording:state") return { ok: true, value: failure };
    if (name === "recording:capabilities") return { ok: true, value: macCapabilities };
    return { ok: true, value: undefined };
  });
  Object.defineProperty(window, "pwrsnapApi", {
    configurable: true,
    value: {
      on: vi.fn((channel: string, listener: (payload: unknown) => void) => {
        mocks.listeners.set(channel, listener);
        return () => mocks.listeners.delete(channel);
      }),
      requestRecordingControllerResize: mocks.requestResize
    }
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderController(): Promise<void> {
  await act(async () => root.render(createElement(RecordingController)));
  await act(async () => Promise.resolve());
}

async function click(action: string): Promise<void> {
  const button = container.querySelector<HTMLButtonElement>(
    `[data-recording-action="${action}"]`
  );
  expect(button).not.toBeNull();
  await act(async () => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

describe("RecordingController normal controls", () => {
  test("renders capability-backed timing/actions and omits unsupported pause", async () => {
    mocks.dispatch.mockImplementation(async (name: string) => {
      if (name === "recording:state") return { ok: true, value: recordingState() };
      if (name === "recording:capabilities") return { ok: true, value: macCapabilities };
      return { ok: true, value: undefined };
    });
    await renderController();

    expect(container.querySelector('[role="timer"]')?.textContent).toMatch(/^01:0[45]$/);
    expect(container.querySelector('[data-recording-action="stop"]')).not.toBeNull();
    expect(container.querySelector('[data-recording-action="restart"]')).not.toBeNull();
    expect(container.querySelector('[data-recording-action="cancel"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Pause");
    expect(container.querySelector("[data-recording-caption]")?.textContent).toContain(
      "not visible"
    );
  });

  test.each(["restart", "cancel"] as const)(
    "requires an in-HUD second click before %s",
    async (name) => {
      mocks.dispatch.mockImplementation(async (command: string) => {
        if (command === "recording:state") return { ok: true, value: recordingState() };
        if (command === "recording:capabilities") {
          return { ok: true, value: macCapabilities };
        }
        return { ok: true, value: undefined };
      });
      await renderController();

      await click(name);
      expect(container.textContent).toContain(
        name === "restart" ? "Restart discards this take" : "Cancel discards this take"
      );
      expect(mocks.dispatch).not.toHaveBeenCalledWith(`recording:${name}`, {});

      await click(name);
      expect(mocks.dispatch).toHaveBeenCalledWith(`recording:${name}`, {});
    }
  );

  test("reposts an unchanged CSS measurement when shared page zoom changes", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 420,
      bottom: 80,
      left: 0,
      width: 420,
      height: 80,
      toJSON: () => ({})
    });
    let dprListener: ((event: MediaQueryListEvent) => void) | null = null;
    const matchMedia = vi.fn(
      () =>
        ({
          matches: true,
          media: `(resolution: ${window.devicePixelRatio}dppx)`,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(
            (_type: string, listener: (event: MediaQueryListEvent) => void) => {
              dprListener = listener;
            }
          ),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(() => true)
        }) as unknown as MediaQueryList
    );
    vi.stubGlobal("matchMedia", matchMedia);
    mocks.dispatch.mockImplementation(async (name: string) => {
      if (name === "recording:state") return { ok: true, value: recordingState() };
      if (name === "recording:capabilities") return { ok: true, value: macCapabilities };
      return { ok: true, value: undefined };
    });
    await renderController();
    const callsBeforeZoom = mocks.requestResize.mock.calls.length;

    await act(async () => dprListener?.({} as MediaQueryListEvent));

    expect(matchMedia).toHaveBeenCalledTimes(2);
    expect(mocks.requestResize).toHaveBeenCalledTimes(callsBeforeZoom + 1);
    expect(mocks.requestResize).toHaveBeenLastCalledWith({ width: 420, height: 80 });
  });

  test("hides every normal control for an unsupported backend", async () => {
    mocks.dispatch.mockImplementation(async (name: string) => {
      if (name === "recording:state") return { ok: true, value: recordingState() };
      if (name === "recording:capabilities") {
        return {
          ok: true,
          value: {
            ...macCapabilities,
            backend: "unsupported",
            controls: { stop: false, cancel: false, restart: false, pauseResume: false }
          }
        };
      }
      return { ok: true, value: undefined };
    });
    await renderController();

    expect(container.querySelector("button")).toBeNull();
  });
});

// The tray cannot confirm a destructive recording control itself: a
// native dialog from main is not content-protected and is centred on
// the display, so it lands in the take. It sends this event instead
// and the HUD — the one window the recorder cannot see on macOS, and
// the one anchored outside the rect on Windows — runs the confirm.
describe("RecordingController tray-armed confirmation", () => {
  async function renderRecording(): Promise<void> {
    mocks.dispatch.mockImplementation(async (command: string) => {
      if (command === "recording:state") return { ok: true, value: recordingState() };
      if (command === "recording:capabilities") return { ok: true, value: macCapabilities };
      return { ok: true, value: undefined };
    });
    await renderController();
  }

  async function arm(payload: unknown): Promise<void> {
    const listener = mocks.listeners.get(EVENT_CHANNELS.recordingControllerArm);
    expect(listener).toBeDefined();
    await act(async () => listener?.(payload));
  }

  test.each(["restart", "cancel"] as const)(
    "a tray-sent %s arms the same in-HUD confirm a click would, and acts on nothing",
    async (action) => {
      await renderRecording();

      await arm({ action });

      expect(container.textContent).toContain(
        action === "restart" ? "Restart discards this take" : "Cancel discards this take"
      );
      expect(mocks.dispatch).not.toHaveBeenCalledWith(`recording:${action}`, {});

      // The user's confirming press is the HUD's own second click.
      await click(action);
      expect(mocks.dispatch).toHaveBeenCalledWith(`recording:${action}`, {});
    }
  );

  test("a control this backend does not offer arms nothing, so no prompt points at a missing button", async () => {
    mocks.dispatch.mockImplementation(async (command: string) => {
      if (command === "recording:state") return { ok: true, value: recordingState() };
      if (command === "recording:capabilities") {
        return {
          ok: true,
          value: {
            ...macCapabilities,
            controls: { stop: true, cancel: false, restart: false, pauseResume: false }
          }
        };
      }
      return { ok: true, value: undefined };
    });
    await renderController();

    await arm({ action: "restart" });
    await arm({ action: "cancel" });

    expect(container.textContent).not.toContain("discards this take");
  });

  test("an unrecognised action is ignored rather than arming something", async () => {
    await renderRecording();

    await arm({ action: "stop" });
    await arm(null);
    await arm({});

    expect(container.textContent).not.toContain("discards this take");
  });

  test("a nudge that lost the race with an action already in flight is ignored", async () => {
    await renderRecording();
    // Stop needs no arming, so one click puts it in flight; the dispatch
    // promise never settles, so `busyAction` stays pinned mid-stop.
    mocks.dispatch.mockImplementation(async (command: string) => {
      if (command === "recording:state") return { ok: true, value: recordingState() };
      if (command === "recording:capabilities") return { ok: true, value: macCapabilities };
      if (command === "recording:stop") return new Promise(() => undefined);
      return { ok: true, value: undefined };
    });
    await click("stop");

    await arm({ action: "cancel" });

    expect(container.textContent).not.toContain("discards this take");
  });

  test("the HUD exposes no key handler, because it can never be the key window", async () => {
    await renderRecording();
    await arm({ action: "restart" });
    expect(container.textContent).toContain("Restart discards this take");

    // `focusable: false` + showInactive() in main is what keeps a click
    // on Stop from deactivating the recorded app — and the recorded app
    // visibly losing focus is inside the rect, so it lands in the file.
    // A keydown listener here would only have been reachable by giving
    // that up. The 5s auto-disarm and the sibling button are the exits.
    const root = container.querySelector<HTMLElement>(".rc-root");
    expect(root).not.toBeNull();
    await act(async () =>
      root?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    );
    expect(container.textContent).toContain("Restart discards this take");
  });
});

describe("RecordingController failed state", () => {
  test("renders fixed safe copy and only failure recovery actions", async () => {
    await renderController();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "The video recorder couldn't start."
    );
    expect(container.querySelector('[data-recording-action="retry"]')).not.toBeNull();
    expect(container.querySelector('[data-recording-action="reveal-logs"]')).not.toBeNull();
    expect(container.querySelector('[data-recording-action="dismiss"]')).not.toBeNull();
    expect(container.querySelector('[data-recording-action="stop"]')).toBeNull();
    expect(container.querySelector('[data-recording-action="restart"]')).toBeNull();
    expect(container.querySelector('[data-recording-action="cancel"]')).toBeNull();
    expect(mocks.requestResize).toHaveBeenCalledWith({ height: 190 });
  });

  test("omits Retry for a non-retryable unavailable packaged recorder", async () => {
    mocks.dispatch.mockImplementation(async (name: string) => {
      if (name === "recording:state") {
        return {
          ok: true,
          value: {
            ...failure,
            code: "recorder_unavailable",
            canRetry: false
          }
        };
      }
      return { ok: true, value: undefined };
    });

    await renderController();

    expect(container.textContent).toContain("PwrSnap couldn't find the video recorder.");
    expect(container.querySelector('[data-recording-action="retry"]')).toBeNull();
    expect(container.querySelector('[data-recording-action="reveal-logs"]')).not.toBeNull();
    expect(container.querySelector('[data-recording-action="dismiss"]')).not.toBeNull();
  });

  test("retry is session-scoped and transport details never render", async () => {
    mocks.dispatch.mockImplementation(async (name: string) => {
      if (name === "recording:state") return { ok: true, value: failure };
      if (name === "recording:retry") {
        return {
          ok: false,
          error: {
            kind: "capture",
            code: "recording_retry_failed",
            message: "C:\\private\\PwrSnapFFmpeg.exe --token hidden"
          }
        };
      }
      return { ok: true, value: undefined };
    });
    await renderController();
    await click("retry");

    expect(mocks.dispatch).toHaveBeenCalledWith("recording:retry", {
      sessionId: "failed-session"
    });
    expect(container.textContent).toContain("That recovery action couldn't be completed.");
    expect(container.textContent).not.toContain("PwrSnapFFmpeg.exe");
    expect(container.textContent).not.toContain("--token");
    expect(container.querySelector('[data-recording-action="retry"]')).not.toBeNull();
  });

  test.each(["result error", "transport rejection"])(
    "a Logs %s stays visible and leaves recovery buttons usable",
    async (failureMode) => {
      mocks.dispatch.mockImplementation(async (name: string) => {
        if (name === "recording:state") return { ok: true, value: failure };
        if (name === "logs:openWindow") {
          if (failureMode === "transport rejection") throw new Error("private transport details");
          return { ok: false, error: { kind: "unknown", code: "unavailable", message: "private details" } };
        }
        return { ok: true, value: undefined };
      });
      await renderController();
      await click("reveal-logs");
      expect(container.textContent).toContain("PwrSnap couldn't open Logs.");
      expect(container.textContent).not.toContain("private");
      expect(container.querySelector<HTMLButtonElement>('[data-recording-action="dismiss"]')?.disabled).toBe(false);
      await click("dismiss");
      expect(mocks.dispatch).toHaveBeenCalledWith("recording:dismissFailure", {
        sessionId: "failed-session"
      });
    }
  );

  test("opens the built-in Logs window and dismisses by failed session", async () => {
    await renderController();
    await click("reveal-logs");
    expect(container.textContent).toContain("Open Logs");
    await click("dismiss");

    expect(mocks.dispatch).toHaveBeenCalledWith("logs:openWindow", {});
    expect(mocks.dispatch).toHaveBeenCalledWith("recording:dismissFailure", {
      sessionId: "failed-session"
    });
  });
});

describe("RecordingController source chips", () => {
  async function renderWithCapabilities(
    capabilities: RecordingCapabilities,
    backend: RecordingBackendCapabilities = macCapabilities
  ): Promise<void> {
    mocks.dispatch.mockImplementation(async (name: string) => {
      if (name === "recording:state") {
        return { ok: true, value: { ...recordingState(), capabilities } };
      }
      if (name === "recording:capabilities") return { ok: true, value: backend };
      return { ok: true, value: undefined };
    });
    await renderController();
  }

  // Screen is intentionally not a chip here: the bar is pinned over the
  // region with a live red dot on it, so "the screen is being recorded"
  // is already unambiguous and a chip would only spend width.
  test("shows no source row when the take is screen-only", async () => {
    await renderWithCapabilities({ systemAudio: false, microphone: false });
    expect(container.querySelector('[data-testid="rc-sources"]')).toBeNull();
  });

  test("shows one chip per requested audio source", async () => {
    await renderWithCapabilities({ systemAudio: true, microphone: true });
    const row = container.querySelector('[data-testid="rc-sources"]');
    expect(row).not.toBeNull();
    expect(row?.getAttribute("aria-label")).toBe("Recording sources");
    expect(container.querySelector('[data-testid="rc-source-microphone"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="rc-source-systemAudio"]')).not.toBeNull();
  });

  test("omits a source the take did not request", async () => {
    await renderWithCapabilities({ systemAudio: false, microphone: true });
    expect(container.querySelector('[data-testid="rc-source-microphone"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="rc-source-systemAudio"]')).toBeNull();
  });

  test("a backend without telemetry keeps the static armed indicator", async () => {
    await renderWithCapabilities({ systemAudio: false, microphone: true });
    const meter = container
      .querySelector('[data-testid="rc-source-microphone"]')
      ?.querySelector(".ps-meter");
    expect(meter?.getAttribute("data-tone")).toBe("recorded");
  });

  test("a sample gap warns and clears on recovery, while written silence shows an empty live meter", async () => {
    const capabilities = { systemAudio: true, microphone: true };
    await renderWithCapabilities(capabilities, {
      ...macCapabilities,
      sources: { ...macCapabilities.sources, liveAudioLevels: true, liveDisconnectDetection: true }
    });
    const chip = (source: string) => container.querySelector(`[data-testid="rc-source-${source}"]`);
    const emit = mocks.listeners.get(EVENT_CHANNELS.recordingState)!;
    expect(chip("microphone")?.querySelector(".ps-meter")?.getAttribute("data-level")).toBe("0");
    await act(async () => emit({
      ...recordingState(), capabilities,
      audioTelemetry: {
        microphone: { state: "no-input", lastSampleAtMs: 12000 },
        systemAudio: { state: "writing", level: 0 }
      }
    }));
    const notice = () => container.querySelector("[data-recording-caption]")?.textContent;
    expect(notice()).toBe("Microphone stopped sending audio at 00:12 · recording continues");
    expect(chip("microphone")?.getAttribute("data-state")).toBe("silent");
    expect(chip("systemAudio")?.getAttribute("data-state")).toBe("live");
    expect(chip("systemAudio")?.querySelector(".ps-meter")?.getAttribute("data-level")).toBe("0");
    await act(async () => emit({
      ...recordingState(), capabilities,
      audioTelemetry: {
        microphone: { state: "writing", level: 4 / 7, recovery: { atMs: 18000, gapMs: 6000 } },
        systemAudio: { state: "no-write", lastSampleAtMs: null }
      }
    }));
    expect(chip("microphone")?.querySelector(".ps-meter")?.getAttribute("data-level")).toBe("4");
    expect(notice()).toBe("System audio has reached the recorder without being written · recording continues");
    await act(async () => emit({
      ...recordingState(), capabilities,
      audioTelemetry: {
        microphone: { state: "writing", level: 4 / 7, recovery: { atMs: 18000, gapMs: 6000 } },
        systemAudio: { state: "writing", level: 0 }
      }
    }));
    expect(notice()).toBe("Microphone back at 00:18 · 6 s missing");
  });

  test("only recorder telemetry changes the visible and accessible mute state", async () => {
    const capabilities = { systemAudio: false, microphone: true };
    const backend = {
      ...macCapabilities,
      sources: { ...macCapabilities.sources, midRecordingToggles: true, liveAudioLevels: true, liveDisconnectDetection: true }
    };
    await renderWithCapabilities(capabilities, backend);
    let settle!: (result: { ok: boolean }) => void;
    mocks.dispatch.mockImplementation(() => new Promise((resolve) => { settle = resolve; }));
    const emit = mocks.listeners.get(EVENT_CHANNELS.recordingState)!;
    const chip = container.querySelector('[data-testid="rc-source-microphone"]')!;
    const button = chip.querySelector("button")!;
    const notice = () => container.querySelector("[data-recording-caption]")?.textContent;
    const publish = (muted: boolean, sessionId = "rec-1") => emit({
      ...recordingState(), capabilities, sessionId,
      audioTelemetry: { microphone: { state: "writing", level: muted ? 0 : 0.5, ...(muted ? { muted } : {}) } }
    });
    await act(async () => publish(false));
    expect(button.getAttribute("aria-label")).toBe("Microphone");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    await act(async () => button.click());
    expect(mocks.dispatch).toHaveBeenCalledWith("recording:muteAudio", { sessionId: "rec-1", source: "microphone", muted: true });
    expect(chip.getAttribute("aria-busy")).toBe("true");
    expect(chip.getAttribute("data-state")).toBe("live");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(chip.querySelector(".ps-chip__mute")).toBeNull();
    expect(notice()).toBe("Muting microphone…");
    await act(async () => button.click());
    expect(mocks.dispatch.mock.calls.filter(([name]) => name === "recording:muteAudio")).toHaveLength(1);
    await act(async () => settle({ ok: true }));
    expect(chip.getAttribute("data-state")).toBe("live");
    await act(async () => publish(true));
    expect(chip.getAttribute("aria-busy")).toBeNull();
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(notice()).toContain("Microphone muted");
    expect(container.querySelector(".sr-only[role=status]")?.textContent).toBe("");
    await act(async () => button.click());
    expect(chip.getAttribute("data-state")).toBe("muted");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(notice()).toBe("Unmuting microphone…");
    await act(async () => settle({ ok: false }));
    expect(notice()).toBe("Couldn’t confirm unmuting microphone");
    expect(container.querySelector(".sr-only[role=status]")?.textContent).toBe(notice());
    await act(async () => publish(false, "replacement"));
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(notice()).toContain("not visible");
  });

  test("the shared gap caption only reports a time that applies to both sources", async () => {
    const capabilities = { systemAudio: true, microphone: true };
    await renderWithCapabilities(capabilities, {
      ...macCapabilities,
      sources: { ...macCapabilities.sources, liveAudioLevels: true, liveDisconnectDetection: true, midRecordingToggles: true }
    });
    const emit = mocks.listeners.get(EVENT_CHANNELS.recordingState)!;
    const notice = () => container.querySelector("[data-recording-caption]")?.textContent;
    const chip = (source: string) => container.querySelector(`[data-testid="rc-source-${source}"]`);
    for (const micTime of [10, 42, 50]) {
      for (const systemTime of [10, 42, 50]) {
        await act(async () => emit({
          ...recordingState(), capabilities,
          audioTelemetry: {
            microphone: { state: "no-input", lastSampleAtMs: micTime * 1000 },
            systemAudio: { state: "no-input", lastSampleAtMs: systemTime * 1000 }
          }
        }));
        expect(chip("microphone")?.getAttribute("title")).toContain(`00:${micTime}`);
        expect(chip("systemAudio")?.getAttribute("title")).toContain(`00:${systemTime}`);
        expect(notice()).toBe(micTime === systemTime ?
          `Microphone and system audio stopped at 00:${micTime} · recording continues` :
          "Microphone and system audio have sample gaps · recording continues");
      }
    }
  });

  test.each([
    [{ systemAudio: false, microphone: false }, []],
    [{ systemAudio: true, microphone: false }, ["systemAudio"]],
    [{ systemAudio: false, microphone: true }, ["microphone"]],
    [{ systemAudio: true, microphone: true }, ["microphone", "systemAudio"]]
  ] as const)("recordingSourceChips(%o) -> %o", (capabilities, expected) => {
    expect(recordingSourceChips(capabilities)).toEqual(expected);
  });
});
