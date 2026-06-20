// Guards the fix for: pinch-to-zoom over the Library grid (or any
// non-editor surface) triggering Chromium's native visual page zoom —
// magnifying the whole window so the sidebar and title bar scroll
// off-screen. The hook preventDefaults the browser's visual-zoom
// triggers (ctrl/meta + wheel, and the macOS gesture* events) at the
// window level, WITHOUT stopping propagation (so the editor's own zoom
// handlers still run) and WITHOUT touching un-modified wheel (so plain
// scroll/pan survive, and Chromium keeps synthesizing the pinch stream).

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { usePreventBrowserZoom } from "../usePreventBrowserZoom";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let host: HTMLDivElement;
let root: Root;

function Harness(): null {
  usePreventBrowserZoom();
  return null;
}

function mount(): void {
  act(() => {
    root.render(createElement(Harness));
  });
}

/** Construct + dispatch a wheel event on window, return it for inspection. */
function fireWheel(init: { ctrlKey?: boolean; metaKey?: boolean }): WheelEvent {
  const event = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    deltaY: 10,
    ...init
  });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

/** Construct + dispatch a (WebKit-style) gesture event on window. */
function fireGesture(type: "gesturestart" | "gesturechange" | "gestureend"): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

describe("usePreventBrowserZoom — blocks native visual zoom", () => {
  test("ctrl+wheel is prevented (trackpad pinch / page-zoom shortcut)", () => {
    mount();
    const event = fireWheel({ ctrlKey: true });
    expect(event.defaultPrevented).toBe(true);
  });

  test("meta+wheel is prevented", () => {
    mount();
    const event = fireWheel({ metaKey: true });
    expect(event.defaultPrevented).toBe(true);
  });

  test.each(["gesturestart", "gesturechange", "gestureend"] as const)(
    "%s (macOS pinch) is prevented",
    (type) => {
      mount();
      const event = fireGesture(type);
      expect(event.defaultPrevented).toBe(true);
    }
  );
});

describe("usePreventBrowserZoom — leaves normal interaction alone", () => {
  test("un-modified wheel is NOT prevented (scroll/pan survives, pinch stream stays alive)", () => {
    mount();
    const event = fireWheel({});
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("usePreventBrowserZoom — editor compatibility", () => {
  test("does not stopPropagation: a downstream window listener still receives ctrl+wheel", () => {
    let received: WheelEvent | null = null;
    const editorLike = (e: Event): void => {
      received = e as WheelEvent;
    };
    // Mirror the editor's listener: window-level, capture phase.
    window.addEventListener("wheel", editorLike, { capture: true });
    try {
      mount();
      const event = fireWheel({ ctrlKey: true });
      // Editor still sees the event (so it can drive its own zoom)...
      expect(received).toBe(event);
      // ...and the browser default is still suppressed.
      expect(event.defaultPrevented).toBe(true);
    } finally {
      window.removeEventListener("wheel", editorLike, { capture: true });
    }
  });

  test("does not stopPropagation: a downstream window listener still receives gesture events", () => {
    let received: Event | null = null;
    const editorLike = (e: Event): void => {
      received = e;
    };
    window.addEventListener("gesturestart", editorLike, { capture: true });
    try {
      mount();
      const event = fireGesture("gesturestart");
      expect(received).toBe(event);
      expect(event.defaultPrevented).toBe(true);
    } finally {
      window.removeEventListener("gesturestart", editorLike, { capture: true });
    }
  });
});

describe("usePreventBrowserZoom — teardown", () => {
  test("after unmount, ctrl+wheel is no longer prevented", () => {
    mount();
    act(() => root.unmount());
    const event = fireWheel({ ctrlKey: true });
    expect(event.defaultPrevented).toBe(false);
    // Re-mount so the shared afterEach unmount is a harmless no-op.
    root = createRoot(host);
  });

  test("after unmount, gesture events are no longer prevented", () => {
    mount();
    act(() => root.unmount());
    const event = fireGesture("gesturestart");
    expect(event.defaultPrevented).toBe(false);
    root = createRoot(host);
  });
});
