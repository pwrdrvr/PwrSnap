import { EventEmitter } from "node:events";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import { createEventSubscriber, LATCHED_EVENT_CHANNELS } from "../../../../../preload/latched-events";
import { APP_NOTICE_DURATION_MS, AppNoticeToast } from "../AppNoticeToast";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let ipc: EventEmitter;

beforeEach(() => {
  vi.useFakeTimers();
  ipc = new EventEmitter();
  Object.defineProperty(window, "pwrsnapApi", {
    configurable: true,
    value: {
      on: createEventSubscriber(ipc, LATCHED_EVENT_CHANNELS)
    }
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

function mount(): void {
  act(() => {
    root?.render(createElement(AppNoticeToast));
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  vi.useRealTimers();
});

const notice = (): Element | null => container?.querySelector(".app-notice") ?? null;

function send(payload: unknown): void {
  act(() => {
    ipc.emit(EVENT_CHANNELS.appNotice, {}, payload);
  });
}

describe("AppNoticeToast", () => {
  test("confirms a command received before React subscribes, with a full display lifetime", () => {
    // Production preload wiring, not a test-only latch. Main can finish
    // Copy Diagnostics Info after DOMContentLoaded but before this mount.
    send({ message: "Diagnostics info copied" });
    act(() => vi.advanceTimersByTime(APP_NOTICE_DURATION_MS * 2));
    mount();
    expect(notice()?.textContent).toBe("Diagnostics info copied");
    act(() => vi.advanceTimersByTime(APP_NOTICE_DURATION_MS - 1));
    expect(notice()).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(notice()).toBeNull();
  });

  test("does not replay an already displayed confirmation on remount", () => {
    mount();
    send({ message: "Diagnostics info copied" });
    act(() => root?.render(null));
    mount();
    expect(notice()).toBeNull();
  });

  test("shows a notice from main as a polite status, then clears it", () => {
    mount();
    expect(notice()).toBeNull();
    send({ message: "Diagnostics info copied" });
    expect(notice()?.textContent).toBe("Diagnostics info copied");
    expect(notice()?.getAttribute("role")).toBe("status");
    act(() => {
      vi.advanceTimersByTime(APP_NOTICE_DURATION_MS);
    });
    expect(notice()).toBeNull();
  });

  test("restarts the timer for a repeat notice", () => {
    mount();
    send({ message: "Diagnostics info copied" });
    act(() => {
      vi.advanceTimersByTime(APP_NOTICE_DURATION_MS - 100);
    });
    send({ message: "Diagnostics info copied" });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(notice()).not.toBeNull();
  });

  test("ignores a malformed payload", () => {
    mount();
    send(null);
    send({ message: "" });
    send({ message: 42 });
    expect(notice()).toBeNull();
  });
});
