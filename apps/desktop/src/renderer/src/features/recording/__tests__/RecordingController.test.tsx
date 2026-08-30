// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { RecordingState } from "@pwrsnap/shared";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  listeners: new Map<string, (payload: unknown) => void>()
}));

vi.mock("../../../lib/pwrsnap", () => ({
  dispatch: (...args: unknown[]) => mocks.dispatch(...args)
}));

import { RecordingController } from "../RecordingController";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
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

beforeEach(() => {
  mocks.dispatch.mockReset();
  mocks.listeners.clear();
  mocks.dispatch.mockImplementation(async (name: string) => {
    if (name === "recording:state") return { ok: true, value: failure };
    return { ok: true, value: undefined };
  });
  Object.defineProperty(window, "pwrsnapApi", {
    configurable: true,
    value: {
      on: vi.fn((channel: string, listener: (payload: unknown) => void) => {
        mocks.listeners.set(channel, listener);
        return () => mocks.listeners.delete(channel);
      })
    }
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
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
