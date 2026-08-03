import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { RendererErrorBoundary } from "./RendererErrorBoundary";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

describe("RendererErrorBoundary", () => {
  test("reveals the log owned by the failing renderer process", async () => {
    const calls: string[] = [];
    Object.defineProperty(window, "pwrsnapApi", {
      configurable: true,
      value: {
        dispatch: async (name: string) => {
          calls.push(name);
          return { ok: true, value: undefined };
        },
        on: () => () => undefined
      }
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const Broken = (): never => {
      throw new Error("renderer broke");
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        createElement(
          RendererErrorBoundary,
          { stage: "tray", children: createElement(Broken) }
        )
      );
    });
    const button = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === "Reveal Log File"
    );
    expect(button).toBeDefined();

    await act(async () => button?.click());

    expect(calls).toContain("renderer:reportError");
    expect(calls).toContain("renderer:revealLogFile");
    expect(calls).not.toContain("logs:openWindow");
  });
});
