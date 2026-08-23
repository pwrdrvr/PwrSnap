import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { VideoExportCard } from "../VideoExportCard";
import type { ExportButtonState } from "../useVideoExportPresets";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) {
    act(() => root!.unmount());
    root = null;
  }
  if (container !== null) {
    container.remove();
    container = null;
  }
});

function mountCard(initialState: ExportButtonState = { kind: "idle" }): {
  button: () => HTMLButtonElement;
  file: () => HTMLAnchorElement;
  onCopy: ReturnType<typeof vi.fn>;
  onCopyPath: ReturnType<typeof vi.fn>;
  onDrag: ReturnType<typeof vi.fn>;
  renderState: (state: ExportButtonState) => void;
} {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  const onCopy = vi.fn();
  const onCopyPath = vi.fn();
  const onDrag = vi.fn();

  const renderState = (state: ExportButtonState): void => {
    act(() => {
      root!.render(
        createElement(VideoExportCard, {
          format: "gif",
          preset: "low",
          label: "Low",
          kbd: "⌘1",
          dim: "800 × 450",
          bytes: "~2.0 MB",
          state,
          onCopy,
          onCopyPath,
          onDrag
        })
      );
    });
  };

  renderState(initialState);

  return {
    button: () => {
      const button = container!.querySelector("button");
      if (!(button instanceof HTMLButtonElement)) throw new Error("copy button missing");
      return button;
    },
    file: () => {
      const file = container!.querySelector("a.fo__copy-file");
      if (!(file instanceof HTMLAnchorElement)) throw new Error("file chip missing");
      return file;
    },
    onCopy,
    onCopyPath,
    onDrag,
    renderState
  };
}

describe("VideoExportCard truthful action feedback", () => {
  test("FILE waits for a successful path-copy result before reporting Copied", () => {
    const harness = mountCard();

    act(() => {
      harness.file().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(harness.onCopyPath).toHaveBeenCalledOnce();
    expect(harness.file().classList.contains("is-copied")).toBe(false);
    expect(harness.file().textContent).toBe("File");

    harness.renderState({ kind: "running", action: "path" });
    expect(harness.file().classList.contains("is-copied")).toBe(false);

    harness.renderState({ kind: "done", action: "path", path: "C:\\Exports\\clip.gif" });
    expect(harness.file().classList.contains("is-copied")).toBe(true);
    expect(harness.file().textContent).toBe("Copied");
    expect(harness.button().classList.contains("is-copied")).toBe(false);

    harness.renderState({ kind: "running", action: "path" });
    expect(harness.file().classList.contains("is-copied")).toBe(false);
    expect(harness.file().textContent).toBe("File");
  });

  test("only a successful media-copy action pulses the card body", () => {
    const harness = mountCard();

    act(() => {
      harness.button().click();
    });
    expect(harness.onCopy).toHaveBeenCalledOnce();
    expect(harness.button().classList.contains("is-copied")).toBe(false);

    harness.renderState({ kind: "running", action: "copy" });
    harness.renderState({ kind: "done", action: "copy", path: "C:\\Exports\\clip.gif" });

    expect(harness.button().classList.contains("is-copied")).toBe(true);
    expect(harness.file().classList.contains("is-copied")).toBe(false);

    harness.renderState({ kind: "running", action: "copy" });
    expect(harness.button().classList.contains("is-copied")).toBe(false);
  });

  test("a completed drag never claims clipboard success", () => {
    const harness = mountCard();

    act(() => {
      harness.file().dispatchEvent(new Event("dragstart", { bubbles: true, cancelable: true }));
    });
    expect(harness.onDrag).toHaveBeenCalledOnce();

    harness.renderState({ kind: "running", action: "drag" });
    harness.renderState({ kind: "done", action: "drag", path: "C:\\Exports\\clip.gif" });

    expect(harness.button().classList.contains("is-copied")).toBe(false);
    expect(harness.file().classList.contains("is-copied")).toBe(false);
    expect(harness.file().textContent).toBe("File");
  });

  test("FILE cannot start a second drag while its card is already running", () => {
    const harness = mountCard({ kind: "running", action: "copy" });

    expect(harness.file().draggable).toBe(false);
    expect(harness.file().getAttribute("aria-disabled")).toBe("true");
    act(() => {
      harness.file().dispatchEvent(new Event("dragstart", { bubbles: true, cancelable: true }));
    });

    expect(harness.onDrag).not.toHaveBeenCalled();
  });

  test("path and drag errors stay on the FILE affordance with the useful message", () => {
    const harness = mountCard({ kind: "running", action: "path" });

    harness.renderState({
      kind: "error",
      action: "path",
      message: "agent bridge disconnected"
    });

    expect(harness.file().classList.contains("is-error")).toBe(true);
    expect(harness.file().classList.contains("is-copied")).toBe(false);
    expect(harness.file().textContent).toBe("Failed");
    expect(harness.file().title).toBe("Copy path failed: agent bridge disconnected");
    expect(harness.button().classList.contains("is-error")).toBe(false);
  });

  test("media-copy errors remain retryable on the card body", () => {
    const harness = mountCard({ kind: "running", action: "copy" });

    harness.renderState({
      kind: "error",
      action: "copy",
      message: "Windows clipboard rejected the file"
    });

    expect(harness.button().classList.contains("is-error")).toBe(true);
    expect(harness.button().classList.contains("is-copied")).toBe(false);
    expect(harness.button().title).toBe("Failed: Windows clipboard rejected the file");
    expect(harness.file().textContent).toBe("File");
  });
});
