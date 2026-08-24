import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { CopyButton } from "../CopyButton";
import { VideoExportPresetGrid } from "../VideoExportPresetGrid";
import { isPrimaryAccel } from "../keyboard";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

describe("shared shortcut presentation", () => {
  test("shared primary-modifier handlers reject AltGraph", () => {
    const altGraph = new KeyboardEvent("keydown", {
      key: "@",
      code: "KeyQ",
      ctrlKey: true,
      altKey: true
    });
    Object.defineProperty(altGraph, "getModifierState", {
      configurable: true,
      value: (modifier: string): boolean => modifier === "AltGraph"
    });

    expect(isPrimaryAccel(altGraph, "win32")).toBe(false);
    expect(
      isPrimaryAccel(
        new KeyboardEvent("keydown", {
          key: "q",
          code: "KeyQ",
          ctrlKey: true
        }),
        "win32"
      )
    ).toBe(true);
  });

  test("win32 copy and video-export keycaps contain only Windows labels", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const noop = vi.fn();

    await act(async () => {
      root?.render(
        createElement(
          Fragment,
          null,
          createElement(CopyButton, {
            preset: "low",
            label: "Low",
            dim: "800 × 600",
            bytes: "100 KB",
            onCopy: noop,
            shortcutPlatform: "win32"
          }),
          createElement(VideoExportPresetGrid, {
            metrics: {},
            states: {},
            onCopy: noop,
            onCopyPath: noop,
            onDrag: noop,
            shortcutPlatform: "win32"
          })
        )
      );
      await Promise.resolve();
    });

    const text = container.textContent ?? "";
    expect(text).toContain("Ctrl+1");
    expect(text).toContain("Ctrl+6");
    expect(text).not.toMatch(/Cmd|⌘/);
    const videoGrid = container.querySelector(
      '[data-testid="psl-copy-row-video-gif-group"]'
    );
    expect(videoGrid?.querySelector(".fo__copy-kbd")?.textContent).toBe("Ctrl+1");
  });
});
