import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import { APP_NOTICE_DURATION_MS, AppNoticeToast } from "../AppNoticeToast";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;
const handlers = new Map<string, (payload: unknown) => void>();

beforeEach(() => {
  vi.useFakeTimers();
  handlers.clear();
  Object.defineProperty(window, "pwrsnapApi", {
    configurable: true,
    value: {
      on: (channel: string, handler: (payload: unknown) => void) => {
        handlers.set(channel, handler);
        return () => handlers.delete(channel);
      }
    }
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(createElement(AppNoticeToast));
  });
});

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
    handlers.get(EVENT_CHANNELS.appNotice)?.(payload);
  });
}

describe("AppNoticeToast", () => {
  test("shows a notice from main as a polite status, then clears it", () => {
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
    send(null);
    send({ message: "" });
    send({ message: 42 });
    expect(notice()).toBeNull();
  });
});
