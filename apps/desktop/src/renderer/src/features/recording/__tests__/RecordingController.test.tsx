// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { RecordingBackendCapabilities, RecordingState } from "@pwrsnap/shared";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  requestResize: vi.fn(),
  listeners: new Map<string, (payload: unknown) => void>()
}));

vi.mock("../../../lib/pwrsnap", () => ({
  dispatch: (...args: unknown[]) => mocks.dispatch(...args)
}));

import { RecordingController } from "../RecordingController";

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
  controllerExcludedFromCapture: true
};

function recordingState(rect = { x: 10, y: 20, w: 800, h: 600 }): RecordingState {
  return {
    phase: "recording",
    sessionId: "rec-1",
    startedAt: new Date(Date.now() - 65_000).toISOString(),
    rect,
    displayId: 1
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

  test("reveals the owner log and dismisses by failed session", async () => {
    await renderController();
    await click("reveal-logs");
    await click("dismiss");

    expect(mocks.dispatch).toHaveBeenCalledWith("renderer:revealLogFile", {});
    expect(mocks.dispatch).toHaveBeenCalledWith("recording:dismissFailure", {
      sessionId: "failed-session"
    });
  });
});
