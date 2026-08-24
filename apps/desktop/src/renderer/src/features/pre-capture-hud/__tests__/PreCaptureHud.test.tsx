// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { EVENT_CHANNELS, type PreCaptureHudState } from "@pwrsnap/shared";
import { PreCaptureHud, preCaptureHudCopy } from "../PreCaptureHud";

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let eventHandler: ((payload: unknown) => void) | null = null;
const notifyReady = vi.fn();
const requestResize = vi.fn();

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver = class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});

beforeEach(() => {
  eventHandler = null;
  notifyReady.mockClear();
  requestResize.mockClear();
  Object.defineProperty(window, "pwrsnapApi", {
    configurable: true,
    value: {
      platform: "win32",
      on: vi.fn((channel: string, handler: (payload: unknown) => void) => {
        if (channel === EVENT_CHANNELS.preCaptureHudState) eventHandler = handler;
        return () => {
          eventHandler = null;
        };
      }),
      notifyPreCaptureHudReady: notifyReady,
      requestPreCaptureHudResize: requestResize
    }
  });
});

async function renderHud(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(createElement(PreCaptureHud)));
}

async function emit(state: PreCaptureHudState): Promise<void> {
  await act(async () => eventHandler?.(state));
}

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

describe("PreCaptureHud", () => {
  test("announces readiness before main shows the window and renders a polite status", async () => {
    await renderHud();
    expect(notifyReady).toHaveBeenCalled();
    expect(container?.textContent).toBe("");

    await emit({ runId: 1, intent: "snap", phase: "storage" });
    const status = container?.querySelector('[role="status"]');
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.textContent).toContain("Checking save location");
    expect(status?.textContent).toContain("capture folder is writable");
    expect(requestResize).toHaveBeenCalled();
  });

  test("renders blocked copy as an assertive alert without controls", async () => {
    await renderHud();
    await emit({
      runId: 2,
      intent: "video",
      phase: "blocked",
      reason: "permission"
    });

    const alert = container?.querySelector('[role="alert"]');
    expect(alert?.getAttribute("aria-live")).toBe("assertive");
    expect(alert?.textContent).toContain("Screen access is needed");
    expect(alert?.textContent).toContain("Windows privacy settings");
    expect(container?.querySelector("button")).toBeNull();
  });

  test("uses platform-truthful permission language and countdown values", () => {
    expect(
      preCaptureHudCopy({ runId: 1, intent: "snap", phase: "permission" }, "darwin").title
    ).toBe("Checking Screen Recording access…");
    expect(
      preCaptureHudCopy({ runId: 1, intent: "snap", phase: "permission" }, "win32").title
    ).toBe("Checking screen capture readiness…");
    expect(
      preCaptureHudCopy(
        { runId: 1, intent: "snap", phase: "countdown", secondsRemaining: 3 },
        "darwin"
      ).title
    ).toBe("Capture in 3…");
  });
});
