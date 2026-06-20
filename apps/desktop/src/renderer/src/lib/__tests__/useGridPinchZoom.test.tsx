// Verifies the Library-grid pinch handler: both pinch streams (ctrl/meta
// + wheel, and the macOS gesture* events) translate into discrete +/-1
// "snap" steps; plain scroll is ignored; the gesture stream source-locks
// out the wheel stream so a machine that fires both doesn't double-count;
// and the browser's default (visual zoom) is suppressed.

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { act, createElement } from "react";
import type { RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useGridPinchZoom } from "../useGridPinchZoom";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let host: HTMLDivElement;
let root: Root;
let target: HTMLDivElement;
let targetRef: RefObject<HTMLElement | null>;
let steps: Array<1 | -1>;

function Harness(): null {
  useGridPinchZoom(targetRef, (d) => steps.push(d));
  return null;
}

function mount(): void {
  act(() => {
    root.render(createElement(Harness));
  });
}

function fireWheel(init: { ctrlKey?: boolean; metaKey?: boolean; deltaY: number }): WheelEvent {
  const event = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    ...init
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function fireGesture(
  type: "gesturestart" | "gesturechange" | "gestureend",
  scale?: number
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  if (scale !== undefined) {
    (event as Event & { scale?: number }).scale = scale;
  }
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  target = document.createElement("div");
  document.body.appendChild(target);
  targetRef = { current: target };
  steps = [];
  mount();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  target.remove();
  document.body.innerHTML = "";
});

describe("useGridPinchZoom — wheel (ctrl/meta) pinch", () => {
  test("ctrl+wheel zoom-in (negative deltaY) emits +1 once per step threshold", () => {
    fireWheel({ ctrlKey: true, deltaY: -20 }); // exactly one step
    expect(steps).toEqual([1]);
  });

  test("a larger pinch emits multiple steps in one event", () => {
    fireWheel({ ctrlKey: true, deltaY: -40 }); // two steps
    expect(steps).toEqual([1, 1]);
  });

  test("meta+wheel zoom-out (positive deltaY) emits -1", () => {
    fireWheel({ metaKey: true, deltaY: 20 });
    expect(steps).toEqual([-1]);
  });

  test("accumulates across small events until the threshold is crossed", () => {
    fireWheel({ ctrlKey: true, deltaY: -12 }); // 12 < 20 → no step yet
    expect(steps).toEqual([]);
    fireWheel({ ctrlKey: true, deltaY: -12 }); // total 24 → one step
    expect(steps).toEqual([1]);
  });

  test("reversing pinch direction does not drain the opposite accumulation into a step", () => {
    fireWheel({ ctrlKey: true, deltaY: -12 }); // acc +12
    fireWheel({ ctrlKey: true, deltaY: 12 }); // reversal → reset, acc -12, no step
    expect(steps).toEqual([]);
  });

  test("plain wheel (no modifier) is ignored — grid scrolling is untouched", () => {
    const event = fireWheel({ deltaY: -200 });
    expect(steps).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });

  test("ctrl+wheel preventDefaults the browser default (no page zoom)", () => {
    const event = fireWheel({ ctrlKey: true, deltaY: -20 });
    expect(event.defaultPrevented).toBe(true);
  });
});

describe("useGridPinchZoom — gesture pinch", () => {
  test("gesturechange beyond the ratio emits +1 (and multi-steps on a big jump)", () => {
    fireGesture("gesturestart", 1);
    fireGesture("gesturechange", 1.4); // 1.4 → +1 (baseline 1.15) → +1 (baseline 1.3225) → stop
    expect(steps).toEqual([1, 1]);
    fireGesture("gestureend");
  });

  test("pinch-in (scale < 1) emits -1", () => {
    fireGesture("gesturestart", 1);
    fireGesture("gesturechange", 0.8);
    expect(steps).toEqual([-1]);
    fireGesture("gestureend");
  });

  test("gesture events preventDefault the browser default", () => {
    const start = fireGesture("gesturestart", 1);
    const change = fireGesture("gesturechange", 1.2);
    const end = fireGesture("gestureend");
    expect(start.defaultPrevented).toBe(true);
    expect(change.defaultPrevented).toBe(true);
    expect(end.defaultPrevented).toBe(true);
  });
});

describe("useGridPinchZoom — gesture/wheel source-lock (no double-count)", () => {
  test("wheel is ignored while a gesture is active", () => {
    fireGesture("gesturestart", 1);
    const event = fireWheel({ ctrlKey: true, deltaY: -40 });
    expect(steps).toEqual([]); // gesture owns the pinch
    expect(event.defaultPrevented).toBe(true); // still suppress page zoom
    fireGesture("gestureend");
  });

  test("wheel is ignored briefly after a gesture ends (trailing momentum)", () => {
    fireGesture("gesturestart", 1);
    fireGesture("gestureend");
    const event = fireWheel({ ctrlKey: true, deltaY: -40 });
    expect(steps).toEqual([]);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe("useGridPinchZoom — teardown", () => {
  test("after unmount, ctrl+wheel no longer emits steps", () => {
    act(() => root.unmount());
    fireWheel({ ctrlKey: true, deltaY: -40 });
    expect(steps).toEqual([]);
    root = createRoot(host); // so the shared afterEach unmount is a no-op
  });
});
