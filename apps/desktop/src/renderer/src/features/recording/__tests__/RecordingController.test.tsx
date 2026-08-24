import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { EVENT_CHANNELS, recordingFailureSummary, type RecordingState } from "@pwrsnap/shared";
import { RecordingController } from "../RecordingController";

let resizeObserverCallbacks: ResizeObserverCallback[] = [];

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver = class ResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      resizeObserverCallbacks.push(callback);
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});

type DispatchResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { kind: string; code: string; message: string } };

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function failedState(
  overrides: Partial<Extract<RecordingState, { phase: "failed" }>> = {}
): Extract<RecordingState, { phase: "failed" }> {
  return {
    phase: "failed",
    sessionId: "failed-session-1",
    code: "recorder_spawn_failed",
    canRetry: true,
    displayId: 1,
    ...overrides
  };
}

function installFakeApi(input: {
  initialState?: RecordingState & Record<string, unknown>;
  results?: Partial<Record<string, DispatchResult>>;
} = {}): {
  dispatch: ReturnType<typeof vi.fn>;
  requestResize: ReturnType<typeof vi.fn>;
  emitRecordingState: (state: RecordingState) => void;
} {
  const listeners = new Map<string, (payload: unknown) => void>();
  const initialState = input.initialState ?? failedState();
  const dispatch = vi.fn(async (name: string): Promise<DispatchResult> => {
    if (name === "recording:state") {
      return { ok: true, value: initialState };
    }
    return input.results?.[name] ?? { ok: true, value: undefined };
  });
  const requestResize = vi.fn();
  Object.defineProperty(window, "pwrsnapApi", {
    configurable: true,
    value: {
      dispatch,
      requestRecordingControllerResize: requestResize,
      on: (channel: string, handler: (payload: unknown) => void) => {
        listeners.set(channel, handler);
        return () => listeners.delete(channel);
      }
    }
  });
  return {
    dispatch,
    requestResize,
    emitRecordingState: (state) => listeners.get(EVENT_CHANNELS.recordingState)?.(state)
  };
}

async function renderController(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(RecordingController));
    await Promise.resolve();
  });
}

function action(name: string): HTMLButtonElement | null {
  return container?.querySelector<HTMLButtonElement>(`[data-recording-action="${name}"]`) ?? null;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  resizeObserverCallbacks = [];
  Reflect.deleteProperty(window, "pwrsnapApi");
  vi.restoreAllMocks();
});

describe("RecordingController failed state", () => {
  test("renders only allowlisted failure copy and never overlaps normal recording controls", async () => {
    const rawDetail = 'spawn "C:\\Users\\Alice\\Secret Project\\recorder.exe" --token hunter2';
    installFakeApi({
      // Deliberately add a legacy/raw detail field. The component must derive
      // its copy from the allowlisted code even if an old or compromised
      // producer appends diagnostic text to the event payload.
      initialState: {
        ...failedState(),
        message: rawDetail
      }
    });

    await renderController();

    expect(container?.querySelector('[data-recording-phase="failed"]')).not.toBeNull();
    expect(container?.textContent).toContain("Recording failed");
    expect(container?.textContent).toContain(recordingFailureSummary("recorder_spawn_failed"));
    expect(container?.textContent).not.toContain(rawDetail);
    expect(action("retry")).not.toBeNull();
    expect(action("retry")?.textContent).toBe("Retry");
    expect(document.activeElement).toBe(action("retry"));
    expect(action("reveal-logs")).not.toBeNull();
    expect(action("dismiss")).not.toBeNull();
    expect(action("stop")).toBeNull();
    expect(action("restart")).toBeNull();
    expect(action("cancel")).toBeNull();
  });

  test("offers a truthful Record Again action after a post-start failure", async () => {
    const api = installFakeApi({
      initialState: failedState({ code: "recorder_exited" })
    });

    await renderController();

    expect(action("retry")?.textContent).toBe("Record Again");
    expect(document.activeElement).toBe(action("retry"));

    await act(async () => {
      action("retry")?.click();
      await Promise.resolve();
    });
    expect(api.dispatch).toHaveBeenCalledWith("recording:retry", {
      sessionId: "failed-session-1"
    });
  });

  test("does not offer a new recording for a non-retryable processing failure", async () => {
    installFakeApi({
      initialState: failedState({ code: "processing_failed", canRetry: false })
    });

    await renderController();

    expect(action("retry")).toBeNull();
    expect(action("reveal-logs")).not.toBeNull();
    expect(document.activeElement).toBe(action("reveal-logs"));
    expect(action("dismiss")).not.toBeNull();
  });

  test("retries the matching failure and follows the next recording-state event", async () => {
    const api = installFakeApi();
    await renderController();

    await act(async () => {
      action("retry")?.click();
      await Promise.resolve();
    });

    expect(api.dispatch).toHaveBeenCalledWith("recording:retry", {
      sessionId: "failed-session-1"
    });

    await act(async () => {
      api.emitRecordingState({
        phase: "recording",
        sessionId: "retry-session-2",
        startedAt: new Date(0).toISOString(),
        rect: { x: 0, y: 0, w: 800, h: 600 },
        displayId: 1
      });
    });

    expect(container?.querySelector('[data-recording-phase="recording"]')).not.toBeNull();
    expect(action("stop")).not.toBeNull();
    expect(action("retry")).toBeNull();
  });

  test("keeps retry available after a failed retry without rendering transport details", async () => {
    const rawDetail = "spawn C:\\Users\\Alice\\private-recorder.exe ENOENT --secret=abc123";
    installFakeApi({
      results: {
        "recording:retry": {
          ok: false,
          error: {
            kind: "capture",
            code: "recording_retry_failed",
            message: rawDetail
          }
        }
      }
    });
    await renderController();

    await act(async () => {
      action("retry")?.click();
      await Promise.resolve();
    });

    expect(container?.querySelector("[data-recording-action-error]")?.textContent).toContain(
      "Reveal the log file for details"
    );
    expect(container?.textContent).not.toContain(rawDetail);
    expect(action("retry")?.disabled).toBe(false);
  });

  test("measures expanded action failure copy instead of clipping the buttons", async () => {
    let measuredHeight = 176;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () =>
        ({
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 480,
          bottom: measuredHeight,
          width: 480,
          height: measuredHeight,
          toJSON: () => ({})
        }) as DOMRect
    );
    const api = installFakeApi({
      results: {
        "recording:retry": {
          ok: false,
          error: { kind: "capture", code: "failed", message: "raw backend detail" }
        }
      }
    });
    await renderController();
    expect(api.requestResize).toHaveBeenCalledWith({ width: 480, height: 176 });

    await act(async () => {
      action("retry")?.click();
      await Promise.resolve();
    });
    measuredHeight = 248;
    await act(async () => {
      for (const callback of resizeObserverCallbacks) {
        callback([], {} as ResizeObserver);
      }
    });

    expect(container?.querySelector("[data-recording-action-error]")).not.toBeNull();
    expect(api.requestResize).toHaveBeenLastCalledWith({ width: 480, height: 248 });
    expect(action("dismiss")).not.toBeNull();
  });

  test("dismisses only the matching failure and clears when idle is broadcast", async () => {
    const api = installFakeApi();
    await renderController();

    await act(async () => {
      action("dismiss")?.click();
      await Promise.resolve();
    });

    expect(api.dispatch).toHaveBeenCalledWith("recording:dismissFailure", {
      sessionId: "failed-session-1"
    });

    await act(async () => api.emitRecordingState({ phase: "idle" }));
    expect(container?.querySelector('[data-recording-phase="idle"]')).not.toBeNull();
    expect(action("dismiss")).toBeNull();
  });

  test("reveals the log owned by the recording HUD process", async () => {
    const api = installFakeApi();
    await renderController();

    await act(async () => {
      action("reveal-logs")?.click();
      await Promise.resolve();
    });

    expect(api.dispatch).toHaveBeenCalledWith("renderer:revealLogFile", {});
    expect(api.dispatch).not.toHaveBeenCalledWith("logs:openWindow", expect.anything());
  });
});
