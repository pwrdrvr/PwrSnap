// Focused accessibility coverage for live video-export progress.
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

function renderCard(state: ExportButtonState): {
  button: HTMLButtonElement;
  onCopy: ReturnType<typeof vi.fn>;
} {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const onCopy = vi.fn();

  act(() => {
    root!.render(
      createElement(VideoExportCard, {
        format: "mp4",
        preset: "med",
        label: "Med",
        kbd: "⌘2",
        dim: "1280 × 720",
        bytes: "~4.2 MB",
        state,
        onCopy,
        onCopyPath: vi.fn(),
        onDrag: vi.fn()
      })
    );
  });

  const button = container.querySelector<HTMLButtonElement>(".fo__copy-btn");
  if (button === null) throw new Error("video export button did not render");
  return { button, onCopy };
}

describe("VideoExportCard progress accessibility", () => {
  test("renders a determinate percentage with complete progressbar semantics", () => {
    const { button } = renderCard({
      kind: "running",
      runId: "run_1",
      phase: "encoding",
      ratio: 0.426
    });

    const progress = container!.querySelector<HTMLElement>("[role='progressbar']");
    if (progress === null) throw new Error("determinate progressbar did not render");

    expect(progress.closest("button")).toBeNull();
    expect(button.getAttribute("aria-describedby")).toBe(progress.id);
    expect(progress.getAttribute("aria-valuemin")).toBe("0");
    expect(progress.getAttribute("aria-valuemax")).toBe("100");
    expect(progress.getAttribute("aria-valuenow")).toBe("43");
    expect(progress.getAttribute("aria-valuetext")).toBe("Encoding, 43%");
    expect(progress.getAttribute("aria-busy")).toBe("true");
    const visual = container!.querySelector<HTMLElement>(".fo__export-progress");
    expect(visual?.textContent).toContain("Encoding");
    expect(visual?.textContent).toContain("43%");
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.disabled).toBe(true);
  });

  test("renders a useful indeterminate fallback without aria-valuenow", () => {
    const { button } = renderCard({
      kind: "running",
      runId: "run_2",
      phase: "palette",
      ratio: null
    });

    const progress = container!.querySelector<HTMLElement>("[role='progressbar']");
    if (progress === null) throw new Error("indeterminate progressbar did not render");

    expect(progress.closest("button")).toBeNull();
    expect(button.getAttribute("aria-describedby")).toBe(progress.id);
    expect(progress.getAttribute("aria-valuemin")).toBe("0");
    expect(progress.getAttribute("aria-valuemax")).toBe("100");
    expect(progress.hasAttribute("aria-valuenow")).toBe(false);
    expect(progress.getAttribute("aria-valuetext")).toBe(
      "Building palette, progress unavailable"
    );
    const visual = container!.querySelector<HTMLElement>(".fo__export-progress");
    expect(visual?.textContent).toContain("Building palette");
    expect(visual?.textContent).toContain("…");
    expect(button.getAttribute("aria-busy")).toBe("true");
  });

  test("keeps an error card enabled and retryable", () => {
    const { button, onCopy } = renderCard({
      kind: "error",
      message: "Encoder exited 1"
    });

    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-busy")).toBe("false");
    expect(button.title).toBe("Failed: Encoder exited 1");
    expect(button.textContent).toContain("Failed");
    expect(button.textContent).toContain("retry?");
    expect(container!.querySelector("[role='progressbar']")).toBeNull();

    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onCopy).toHaveBeenCalledTimes(1);
  });
});
