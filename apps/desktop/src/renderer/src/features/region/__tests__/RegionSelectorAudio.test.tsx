import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { RecordingCapabilities } from "@pwrsnap/shared";
import { RegionSelector } from "../RegionSelector";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

type SelectorModePayload = {
  mode: "auto" | "region" | "window";
  screenUrl?: string;
  intent?: "snap" | "video";
  recordingCapabilities?: RecordingCapabilities;
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let selectorModeHandler: ((payload: SelectorModePayload) => void) | null = null;

const submitRegion = vi.fn();

beforeEach(() => {
  selectorModeHandler = null;
  submitRegion.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  window.location.hash = "";
  window.pwrsnapApi = {
    platform: "darwin",
    versions: { chrome: "0", electron: "0", node: "0" },
    dispatch: vi.fn(),
    on: vi.fn(() => () => undefined),
    submitRegion,
    onWindowListSnapshot: vi.fn(() => () => undefined),
    onSelectorKey: vi.fn(() => () => undefined),
    onSelectorMode: vi.fn((handler: (payload: SelectorModePayload) => void) => {
      selectorModeHandler = handler;
      return () => undefined;
    }),
    requestTrayResize: vi.fn(),
    requestFloatOverResize: vi.fn(),
    startCaptureDrag: vi.fn(),
    startVideoDrag: vi.fn(),
    reportSelectorDiagnostics: vi.fn(),
    perfMark: vi.fn()
  };
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  delete window.pwrsnapApi;
});

describe("RegionSelector video audio controls", () => {
  test("video commits include the toggled recording capabilities", async () => {
    await act(async () => {
      root = createRoot(container!);
      root.render(createElement(RegionSelector));
    });

    await act(async () => {
      selectorModeHandler?.({
        mode: "auto",
        intent: "video",
        recordingCapabilities: { systemAudio: true, microphone: false }
      });
    });

    const systemAudio = document.querySelector<HTMLButtonElement>(
      ".region-audio-toggle[aria-pressed='true']"
    );
    const microphone = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".region-audio-toggle")
    ).find((button) => button.textContent?.includes("Microphone"));

    expect(systemAudio?.textContent).toContain("System audio");
    expect(microphone).toBeDefined();

    await act(async () => {
      systemAudio?.click();
      microphone?.click();
    });

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    });

    expect(submitRegion).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        recordingCapabilities: {
          systemAudio: false,
          microphone: true
        }
      })
    );
  });
});
