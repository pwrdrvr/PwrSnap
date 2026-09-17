// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { EVENT_CHANNELS, type RecordingFrameLayout } from "@pwrsnap/shared";

import { RecordingFrame } from "../RecordingFrame";

const listeners = new Map<string, (payload: unknown) => void>();

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  listeners.clear();
  Object.defineProperty(window, "pwrsnapApi", {
    configurable: true,
    value: {
      on: vi.fn((channel: string, listener: (payload: unknown) => void) => {
        listeners.set(channel, listener);
        return () => listeners.delete(channel);
      })
    }
  });
  // The window is created at the plan's bounds, so innerWidth/Height are
  // the rect plus whatever band survived on each side.
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 692 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 452 });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function render(): Promise<void> {
  await act(async () => root.render(createElement(RecordingFrame)));
}

async function push(layout: RecordingFrameLayout): Promise<void> {
  await act(async () => {
    listeners.get(EVENT_CHANNELS.recordingFrame)?.(layout);
  });
}

const CENTERED: RecordingFrameLayout = {
  inset: { left: 26, top: 26, right: 26, bottom: 26 },
  mode: "straddle",
  phase: "recording"
};

function frame(): HTMLElement | null {
  return container.querySelector<HTMLElement>("[data-testid='recording-frame']");
}

describe("RecordingFrame", () => {
  test("renders nothing until main sends a layout", async () => {
    await render();
    expect(frame()).toBeNull();
    expect(container.textContent).toBe("");
  });

  test("positions the box at the insets it was handed", async () => {
    await render();
    await push(CENTERED);

    const el = frame();
    expect(el).not.toBeNull();
    expect(el?.style.getPropertyValue("--psrf-left")).toBe("26px");
    expect(el?.style.getPropertyValue("--psrf-top")).toBe("26px");
    expect(el?.style.getPropertyValue("--psrf-right")).toBe("26px");
    expect(el?.style.getPropertyValue("--psrf-bottom")).toBe("26px");
  });

  test("carries mode and phase as data attributes for the stylesheet", async () => {
    await render();
    await push(CENTERED);
    expect(frame()?.dataset.mode).toBe("straddle");
    expect(frame()?.dataset.phase).toBe("recording");

    await push({ ...CENTERED, mode: "outset", phase: "arming" });
    expect(frame()?.dataset.mode).toBe("outset");
    expect(frame()?.dataset.phase).toBe("arming");
  });

  test("a negative inset overhangs the window instead of being clamped to zero", async () => {
    // A full-display macOS recording: the window covers the work area,
    // so the rect's top edge is under the menu bar and its bottom edge
    // is behind the Dock — places no window may be. Main describes that
    // with negative insets and the box is drawn overhanging, for
    // Chromium to clip. Clamping to 0 here would be the same defect
    // main just stopped committing: the frame would sit on the work
    // area instead of on the recorded rect.
    await render();
    await push({
      inset: { left: 0, top: -30, right: 0, bottom: -89 },
      mode: "straddle",
      phase: "recording"
    });

    const el = frame();
    expect(el?.style.getPropertyValue("--psrf-top")).toBe("-30px");
    expect(el?.style.getPropertyValue("--psrf-bottom")).toBe("-89px");
  });

  test("the overhang counts toward the rect the corner ticks are scaled from", async () => {
    // The sizes here are chosen so the two answers DIFFER. At the
    // window's own 692x452 they do not: rect short side 571 and
    // viewport 452 both floor past `CORNER_MAX_PX`, so an
    // implementation that dropped the overhang would produce 17px
    // either way and an assertion there would prove nothing.
    //
    // 92 wide x 40 tall with 10px of overhang top and bottom:
    //   correct  -> rect short side min(92, 40 + 10 + 10) = 60 -> 15px
    //   dropped  -> rect short side min(92, 40)           = 40 -> 10px
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 92 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 40 });
    await render();
    await push({
      inset: { left: 0, top: -10, right: 0, bottom: -10 },
      mode: "straddle",
      phase: "recording"
    });

    expect(frame()?.style.getPropertyValue("--psrf-corner")).toBe("15px");
  });

  test("an asymmetric layout is not normalized away", async () => {
    // A region flush against the left edge of the display: no band on
    // that side. Averaging or mirroring here would drag the frame off
    // the rect by however much was clipped.
    await render();
    await push({ ...CENTERED, inset: { left: 0, top: 26, right: 26, bottom: 26 } });

    expect(frame()?.style.getPropertyValue("--psrf-left")).toBe("0px");
    expect(frame()?.style.getPropertyValue("--psrf-right")).toBe("26px");
  });

  test("corner ticks are capped so a large region keeps them small", async () => {
    await render();
    await push(CENTERED);
    // 640 × 400 rect — a quarter of the short side is 100, well past the cap.
    expect(frame()?.style.getPropertyValue("--psrf-corner")).toBe("17px");
  });

  test("corner ticks shrink rather than meeting in the middle of a small region", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 92 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 92 });
    await render();
    await push(CENTERED);

    // 40 × 40 rect → a quarter is 10px, so the ticks cover a quarter of
    // each side instead of the whole thing.
    expect(frame()?.style.getPropertyValue("--psrf-corner")).toBe("10px");
  });

  test("is hidden from assistive tech — the HUD owns that announcement", async () => {
    await render();
    await push(CENTERED);
    expect(frame()?.getAttribute("aria-hidden")).toBe("true");
  });

  test("has all four corner ticks", async () => {
    await render();
    await push(CENTERED);
    const corners = container.querySelectorAll("[data-corner]");
    expect([...corners].map((el) => el.getAttribute("data-corner"))).toEqual([
      "tl",
      "tr",
      "bl",
      "br"
    ]);
  });
});
