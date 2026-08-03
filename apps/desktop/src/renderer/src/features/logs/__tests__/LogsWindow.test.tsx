import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { AppLogEntry, AppLogSnapshot } from "@pwrsnap/shared";
import { LogsWindow } from "../LogsWindow";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function entry(sequence: number, line: string): AppLogEntry {
  return { sequence, timestamp: sequence, level: "info", line };
}

function installFakeApi(snapshot: AppLogSnapshot): void {
  Object.defineProperty(window, "pwrsnapApi", {
    configurable: true,
    value: {
      dispatch: async (name: string) => {
        if (name === "logs:read") return { ok: true, value: snapshot };
        return { ok: true, value: undefined };
      },
      on: () => () => undefined
    }
  });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.restoreAllMocks();
});

describe("LogsWindow search navigation", () => {
  test("scrolls the first match into view when a new query keeps index zero", async () => {
    installFakeApi({
      entries: [entry(1, "unrelated"), entry(2, "Codex tool failed")],
      readAt: 1,
      truncated: false,
      debugCollectionEnabled: false
    });
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(createElement(LogsWindow));
      await Promise.resolve();
    });
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Search logs"]');
    expect(input).not.toBeNull();

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set;
      valueSetter?.call(input, "Codex");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(container.textContent).toContain("1 / 1");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", inline: "nearest" });
  });
});
