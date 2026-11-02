// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { DEFAULT_HOTKEYS, EVENT_CHANNELS, type RecordingState } from "@pwrsnap/shared";
import { TrayMenu } from "../TrayMenu";

vi.mock("../../../lib/useLibrary", () => ({
  useLibrary: () => ({ rows: [] })
}));

vi.mock("../../shared/useHotkeys", () => ({
  useHotkeys: () => DEFAULT_HOTKEYS
}));

vi.mock("../../shared/usePresetRenderMetrics", () => ({
  usePresetRenderMetrics: () => null
}));

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
    class ResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.restoreAllMocks();
});

function installFakeApi(initialState: RecordingState): {
  dispatch: ReturnType<typeof vi.fn>;
  emitState: (state: RecordingState | { phase: "permission" }) => void;
} {
  const listeners = new Map<string, (payload: unknown) => void>();
  const dispatch = vi.fn(async (name: string) => {
    if (name === "recording:state") return { ok: true, value: initialState };
    if (name === "system:listDisplays") {
      return { ok: true, value: { displays: [{ id: 1 }] } };
    }
    return { ok: true, value: undefined };
  });
  Object.defineProperty(window, "pwrsnapApi", {
    configurable: true,
    value: {
      dispatch,
      on: (channel: string, handler: (payload: unknown) => void) => {
        listeners.set(channel, handler);
        return () => listeners.delete(channel);
      },
      requestTrayResize: vi.fn()
    }
  });
  return {
    dispatch,
    emitState: (state) => listeners.get(EVENT_CHANNELS.recordingState)?.(state)
  };
}

function recordVideoButton(): HTMLButtonElement {
  const button = container?.querySelector<HTMLButtonElement>(".ps-tray__quick--video");
  if (button === null || button === undefined) throw new Error("missing Record Video button");
  return button;
}

describe("TrayMenu recording-attempt admission", () => {
  test("disables Record Video through permission/failure and enables it at ready", async () => {
    const api = installFakeApi({
      phase: "failed",
      sessionId: "failed-1",
      code: "recorder_exited",
      canRetry: true,
      displayId: 1
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => root?.render(createElement(TrayMenu)));
    expect(recordVideoButton().disabled).toBe(true);

    await act(async () => api.emitState({ phase: "permission" }));
    expect(recordVideoButton().disabled).toBe(true);

    await act(async () =>
      api.emitState({ phase: "ready", sessionId: "ready-1", captureId: "capture-1" })
    );
    expect(recordVideoButton().disabled).toBe(false);

    await act(async () => recordVideoButton().click());
    expect(api.dispatch).toHaveBeenCalledWith("capture:videoInteractive", {});
  });
});
